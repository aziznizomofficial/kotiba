import Foundation
import KotibaCore
import Speech

// Task E-03. Apple's own on-device speech recognition, as a `TranscriptionEngine`.
//
// This exists because it is the only engine that needs no download at all — it is built into
// macOS 26 — and it was measured at 100–120 ms warm on this Mac, matching a commercial dictation app. For
// English it is the fastest route to a working app by a wide margin.
//
// Its limits are hard and were measured, not guessed:
//
//   * **No Uzbek, at all.** `supportedLocale(equivalentTo:)` returns nil for every Uzbek form,
//     and `AssetInventory.reserve(locale: uz-UZ)` throws SFSpeechErrorDomain Code=15. So does
//     every neighbouring language that might have been a cheat — tg, kk, ky, tk, az.
//   * **No Russian on `SpeechTranscriber`.** Russian exists only via `DictationTranscriber`,
//     which returns no punctuation, no capitals, and no final result until end-of-input —
//     10,647 ms on a 10.59 s clip. Not usable for dictation.
//   * **Cold start is unpredictable**, measured at 115/229/350 ms across three passes and
//     daemon-scoped. So no cold number belongs in a latency budget.
//
// The engine therefore declares English only and refuses everything else loudly, rather than
// accepting a language it will transcribe badly. Silent degradation is the failure mode this
// project exists to avoid.

public actor AppleSpeechEngine: TranscriptionEngine {

    public nonisolated let engineID = "apple-speech-transcriber"
    public nonisolated let supportedLanguages: Set<Language> = [.english]

    /// The locale to ask for. `en-US` rather than the user's own, because `supportedLocale`
    /// maps equivalents and a British user still gets an English model.
    private static let preferred = Locale(identifier: "en-US")

    private var ready = false
    private var lastError: String?
    private var resolvedLocale: Locale?

    public init() {}

    public func isReady() async -> Bool { ready }

    /// Whether the engine could ever work here, before any download is attempted.
    public nonisolated static var isAvailable: Bool { SpeechTranscriber.isAvailable }

    /// The last reason `prepare()` failed, for the settings pane to show.
    public func failureReason() -> String? { lastError }

    /// Resolves the locale, downloads the model if the OS does not already have it, and
    /// reserves it.
    ///
    /// Idempotent, and safe to call on every foreground — which is how it is called. A one-shot
    /// warm-up from `init` is exactly how the predecessor disabled its own engine for a whole
    /// process lifetime after a single transient failure.
    public func prepare() async throws {
        guard SpeechTranscriber.isAvailable else {
            try fail("on-device speech recognition is switched off for this system")
        }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Self.preferred)
        else {
            try fail("en-US is not a supported locale on this system")
        }
        resolvedLocale = locale

        let probe = SpeechTranscriber(locale: locale, preset: .transcription)
        do {
            switch await AssetInventory.status(forModules: [probe]) {
            case .unsupported:
                try fail("the system reports en-US as unsupported")
            case .installed:
                break
            case .supported, .downloading:
                // Downloading can take minutes on first run. The caller decides whether to
                // await it; the HUD shows progress from the returned request elsewhere.
                if let request = try await AssetInventory
                    .assetInstallationRequest(supporting: [probe]) {
                    try await request.downloadAndInstall()
                }
            @unknown default:
                // A status this build does not know about. Try anyway rather than refuse:
                // reserve() below is the real gate and it reports honestly.
                break
            }
            // Reserving pins the locale so the OS does not evict the model under disk pressure.
            // There is a system-wide cap; over it, `reserve` throws rather than lying.
            try await AssetInventory.reserve(locale: locale)
            ready = true
            lastError = nil
        } catch {
            try fail("\(error)")
        }
    }

    /// Releases the reservation. Called when the user switches away from this engine, so the
    /// cap is not held by an engine nobody is using.
    public func release() async {
        if let locale = resolvedLocale { _ = await AssetInventory.release(reservedLocale: locale) }
        ready = false
    }

    private func fail(_ why: String) throws -> Never {
        ready = false
        lastError = why
        throw EngineFailure.assetsUnavailable(why)
    }

    public func transcribe(_ audio: KotibaCore.AudioBuffer,
                           language: Language) async throws -> Transcript {
        guard supportedLanguages.contains(language) else {
            // Loud, not silent. Uzbek here means the router sent work to the wrong engine, and
            // that is a bug worth surfacing rather than papering over.
            throw EngineFailure.languageUnsupported(language, engineID: engineID)
        }
        guard ready, let locale = resolvedLocale else {
            throw EngineFailure.notReady(lastError ?? "prepare() has not run")
        }
        guard !audio.samples.isEmpty else {
            // The empty-transcript guard's twin. An engine handed nothing must say so, not
            // return an empty string that reads downstream as a successful silent dictation.
            throw EngineFailure.transcriptionFailed("no audio")
        }

        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)

        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [transcriber]) else {
            throw EngineFailure.assetsUnavailable("no compatible audio format")
        }
        guard let buffer = Self.pcmBuffer(from: audio, format: format) else {
            throw EngineFailure.transcriptionFailed("could not convert audio to \(format)")
        }

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        try await analyzer.start(inputSequence: stream)

        // Collect before finishing: `results` completes only once the analyzer has ended, so
        // draining it after `finalizeAndFinish...` returns would deadlock on an ended stream.
        let collector = Task { () -> String in
            var text = AttributedString()
            for try await result in transcriber.results where result.isFinal {
                text.append(result.text)
            }
            return String(text.characters)
        }

        continuation.yield(AnalyzerInput(buffer: buffer))
        continuation.finish()
        do {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            collector.cancel()
            throw EngineFailure.transcriptionFailed("\(error)")
        }

        let text: String
        do { text = try await collector.value } catch {
            throw EngineFailure.transcriptionFailed("\(error)")
        }

        return Transcript(raw: text.trimmingCharacters(in: .whitespacesAndNewlines),
                          language: language, engineID: engineID)
    }

    /// Kotiba carries 16 kHz mono Float32; the analyzer wants whatever it says it wants.
    public static func pcmBuffer(from audio: KotibaCore.AudioBuffer,
                          format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard
            let source = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                       sampleRate: Double(KotibaCore.AudioBuffer.sampleRate),
                                       channels: 1, interleaved: false),
            let input = AVAudioPCMBuffer(pcmFormat: source,
                                         frameCapacity: AVAudioFrameCount(audio.samples.count))
        else { return nil }
        input.frameLength = AVAudioFrameCount(audio.samples.count)
        audio.samples.withUnsafeBufferPointer { src in
            input.floatChannelData![0].update(from: src.baseAddress!, count: audio.samples.count)
        }
        guard source != format else { return input }

        guard
            let converter = AVAudioConverter(from: source, to: format),
            let output = AVAudioPCMBuffer(
                pcmFormat: format,
                frameCapacity: AVAudioFrameCount(
                    Double(audio.samples.count) * format.sampleRate / source.sampleRate) + 1024)
        else { return nil }

        final class Once: @unchecked Sendable { var done = false }
        let once = Once()
        nonisolated(unsafe) let payload = input
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if once.done { status.pointee = .endOfStream; return nil }
            once.done = true
            status.pointee = .haveData
            return payload
        }
        return error == nil ? output : nil
    }
}

public enum EngineFailure: Error, Sendable, Equatable {
    case notReady(String)
    case languageUnsupported(Language, engineID: String)
    /// Nothing in a family slot claims this language — which for a composite means no model for
    /// it has been configured, not that Kotiba cannot do it.
    ///
    /// Without this case the only thing that fit was `languageUnsupported`, whose reason ends
    /// "the router misrouted" — so a user who had simply never chosen a Russian model was told
    /// the router had a bug, and pointed at nothing they could act on.
    case noEngineInstalled(Language)
    case localeUnsupported(String)
    case assetsUnavailable(String)
    case modelMissing(path: String)
    case transcriptionFailed(String)

    public var reason: String {
        switch self {
        case .notReady(let why): return "the engine is not ready: \(why)"
        case .languageUnsupported(let language, let engine):
            return "\(engine) does not support \(language.rawValue) — the router misrouted"
        case .noEngineInstalled(let language):
            return "no \(language.rawValue) model is installed — choose one in "
                + "Settings › Languages"
        case .localeUnsupported(let locale): return "\(locale) is not available on this system"
        case .assetsUnavailable(let why): return "speech assets unavailable: \(why)"
        case .modelMissing(let path): return "no model at \(path)"
        case .transcriptionFailed(let why): return "transcription failed: \(why)"
        }
    }
}

// `"\(error)"` is this codebase's interchange format at the module boundaries — 23 sites convert
// that way — and for an `Error` enum without `CustomStringConvertible` it reflects the case name
// instead of the diagnosis. A denied microphone reached the user as
// `engineFailedToStart("permissionDenied")`, which appears verbatim in real diagnostics. Each of
// these types already writes the actionable sentence in `reason`; this is what makes the
// interchange format use it, with no call-site changes.

extension EngineFailure: CustomStringConvertible {
    public var description: String { reason }
}
