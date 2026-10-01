import Foundation
import KotibaCore
import KotibaTranscribe

// The Arabic family (D-11): Cohere Transcribe Arabic, streamed through the same session the
// Uzbek and Turkish engines use, with whisper turbo behind it.
//
// C4 §8 asked for exactly this: Cohere has no native streaming, so it takes "the whisper
// session's policy with a different decoder" — commits at 20–24 s pauses (well inside its 35 s
// cap), a speculative decode at every pause, and the release cut at the last 0.2 s pause, so
// key-up decodes only the stretch after it. `StreamingWhisperSession` is written against
// `SegmentDecoding`, so the decoder below is the whole integration.
//
// Turbo stands behind Cohere in two places, both measured in C4:
//
//   * **Before Cohere is on disk** (it is 1.77 GB and optional): turbo with the punctuated
//     Arabic exemplar — 14.0 % MSA WER, a stop at the end of 99 % of utterances (§3.2) — is the
//     Arabic engine outright, the way Apple and whisper answer English while Parakeet downloads.
//   * **A segment Cohere loops on** (`OutputTruncated`, 2 of 200 dialect clips, §3.2) is decoded
//     again by turbo rather than pasted empty. So is one it fails outright.

public actor ArabicSegmentDecoder: SegmentDecoding {

    public nonisolated let supportedLanguages: Set<Language> = [.arabic]
    public nonisolated var engineID: String {
        cohere != nil ? "cohere-transcribe-arabic" : (fallback?.engineID ?? "arabic-unavailable")
    }

    /// Nil until the GGUF is on disk — the controller rebuilds the engine when it lands.
    private let cohere: CohereArabicEngine?
    /// whisper turbo, built with flash attention off (it is handed fitted windows) and told the
    /// Arabic exemplar through `WhisperEngine.Options.languagePrompts`.
    private let fallback: WhisperEngine?

    /// Segments decoded by turbo because Cohere looped or failed, since this decoder was built.
    /// For the diagnostics a stream reports.
    public private(set) var fallbacks = 0

    public init(cohere: CohereArabicEngine?, fallback: WhisperEngine?) {
        self.cohere = cohere
        self.fallback = fallback
    }

    public func isReady() async -> Bool {
        if let cohere { return await cohere.isReady() }
        return await fallback?.isReady() ?? false
    }

    /// Loads Cohere, or turbo when Cohere is not there. Turbo behind Cohere loads on demand, on
    /// the first loop — which is rare enough (2 of 200 dialect clips) not to hold 800 MB for it.
    public func prepare() async throws {
        if let cohere {
            do {
                try await cohere.prepare()
                return
            } catch {
                // A file that will not load is not Arabic that cannot be dictated: turbo still can.
                guard let fallback else {
                    throw EngineFailure.transcriptionFailed(
                        (error as? CohereLoadError)?.reason ?? "\(error)")
                }
                try await fallback.prepare()
                return
            }
        }
        guard let fallback else { throw EngineFailure.noEngineInstalled(.arabic) }
        try await fallback.prepare()
    }

    public func unload() async {
        await cohere?.unload()
    }

    /// Cohere reads no encoder window; turbo behind it needs flash attention off to be handed
    /// fitted ones, like any whisper engine.
    public func mixesWindowsSafely() async -> Bool {
        await fallback?.mixesWindowsSafely() ?? true
    }

    public func decode(_ samples: [Float], language: Language, prompt: String?, beamSize: Int?,
                       audioContext: WhisperEngine.AudioContext?,
                       abort: WhisperAbort?) async throws -> WhisperEngine.Decode {
        guard language == .arabic else {
            throw EngineFailure.languageUnsupported(language, engineID: engineID)
        }
        let started = ContinuousClock.now
        if let cohere {
            var follow: (@Sendable () -> Bool)?
            if let abort { follow = { abort.isRaised } }
            let flag = TranscribeAbort(following: follow)
            switch await cohere.decode(samples, abort: flag) {
            case .text(let text):
                return WhisperEngine.Decode(text: text, audioContext: 0,
                                            milliseconds: Self.ms(since: started))
            case .aborted:
                throw EngineFailure.transcriptionFailed("aborted")
            case .truncated, .failed:
                fallbacks += 1
            }
        }
        guard let fallback else { throw EngineFailure.noEngineInstalled(.arabic) }
        // The session's prompt carries the text so far after the hint; turbo gets it, and the
        // hint there is the Arabic exemplar (the stream's configuration asks the turbo engine).
        return try await fallback.decode(samples, language: .arabic, prompt: prompt,
                                         beamSize: beamSize, audioContext: audioContext,
                                         abort: abort)
    }

    /// A whole recording — the session's batch path, and the reroute steps'. Cohere cuts it into
    /// segments of at most 28 s itself; a loop anywhere sends the recording to turbo.
    public func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        guard language == .arabic else {
            throw EngineFailure.languageUnsupported(language, engineID: engineID)
        }
        if let cohere {
            switch await cohere.transcribe(audio.samples) {
            case .text(let text):
                return Transcript(raw: text, language: .arabic, engineID: cohere.engineID)
            case .aborted:
                throw EngineFailure.transcriptionFailed("aborted")
            case .truncated, .failed:
                fallbacks += 1
            }
        }
        guard let fallback else { throw EngineFailure.noEngineInstalled(.arabic) }
        return try await fallback.transcribe(audio, language: .arabic)
    }

    private static func ms(since start: ContinuousClock.Instant) -> Double {
        let elapsed = ContinuousClock.now - start
        return Double(elapsed.components.seconds) * 1000
            + Double(elapsed.components.attoseconds) / 1e15
    }
}

/// What goes in the Arabic family slot: the decoder above, able to stream.
public struct StreamingArabicEngine: StreamingTranscriptionEngine {
    public let decoder: ArabicSegmentDecoder
    public let configuration: StreamingWhisperSession.Configuration
    public let speechDetectorURL: URL?

    public var engineID: String { decoder.engineID }
    public var supportedLanguages: Set<Language> { [.arabic] }

    /// `configuration.hint` should be `Vocabulary.hint(for: .arabic)` — it reaches only turbo.
    public init(decoder: ArabicSegmentDecoder,
                configuration: StreamingWhisperSession.Configuration = .init(),
                speechDetectorURL: URL?) {
        self.decoder = decoder
        self.configuration = configuration
        self.speechDetectorURL = speechDetectorURL
    }

    public func isReady() async -> Bool { await decoder.isReady() }
    public func prepare() async throws { try await decoder.prepare() }
    public func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        try await decoder.transcribe(audio, language: language)
    }

    public func openStream() async -> any TranscriptionStream {
        let detector: any SpeechFrameClassifier =
            speechDetectorURL.flatMap { SileroSpeechDetector(modelURL: $0) }
            ?? EnergyFrameClassifier()
        return StreamingWhisperSession(engine: decoder, language: .arabic,
                                       configuration: configuration, speechDetector: detector)
    }
}
