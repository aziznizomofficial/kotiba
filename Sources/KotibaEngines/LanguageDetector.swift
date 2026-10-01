import Foundation
import KotibaCore
import whisper

// Task R-03, by a cheaper route than planned.
//
// The build plan called for ECAPA-TDNN in Core ML emitting a 107-dimension posterior. whisper
// already computes the same kind of thing — `whisper_lang_auto_detect` fills an array with a
// probability per language — and the app is linked against whisper anyway. No conversion, no
// second model format, no 107-class head to maintain.
//
// The model for the job is `ggml-base`, 59 MB. It cannot transcribe Uzbek at all — stock
// Whisper scores 101.73% WER on it — but *identifying* a language and *transcribing* it are
// different problems, and the encoder's language head is fine for the first while hopeless at
// the second. Keeping 59 MB resident is affordable in a way that keeping 574 MB is not.
//
// The output is deliberately handed to `ClusterMass` rather than read as an argmax. Uzbek does
// not place: a multilingual model given clean Uzbek answers `tr 0.63 / az 0.17 / uz 0.00`, so a
// rule that waits for `uz` to win never fires. Summing the mass across the languages Uzbek is
// heard as is the whole trick, and it is already written and tested in KotibaCore.

public actor WhisperLanguageDetector: AcousticClassifier {

    public nonisolated let modelURL: URL

    private var context: WhisperContext?
    private var loading: Task<WhisperContext?, Never>?
    private var inFlight: Task<[String: Double], Never>?

    /// Detection reads the first `window` of audio. Whisper's encoder always consumes a 30 s
    /// frame, padding what it is given, so a longer clip costs no more than a short one — but
    /// trimming keeps the mel computation honest about what it is looking at.
    public nonisolated let window: Duration

    public init(modelURL: URL, window: Duration = .seconds(30)) {
        self.modelURL = modelURL
        self.window = window
    }

    public func isReady() -> Bool { context != nil }

    /// Loads the detector. Same shape as `WhisperEngine.prepare()`, and for the same reasons:
    /// idempotent, deduplicated across concurrent callers, and off the actor's executor.
    public func prepare() async throws {
        if context != nil { return }
        guard FileManager.default.fileExists(atPath: modelURL.path) else {
            throw EngineFailure.modelMissing(path: modelURL.path)
        }
        WhisperContext.silenceLogging()

        var params = whisper_context_default_params()
        params.use_gpu = true
        params.flash_attn = true

        let path = modelURL.path
        let task: Task<WhisperContext?, Never>
        if let existing = loading {
            task = existing
        } else {
            task = Task.detached(priority: .userInitiated) { WhisperContext(path: path,
                                                                           params: params) }
            loading = task
        }
        let loaded = await task.value
        loading = nil
        if context != nil { return }

        guard let loaded else {
            throw EngineFailure.transcriptionFailed(
                "whisper.cpp could not load \(modelURL.lastPathComponent) as a language detector")
        }
        context = loaded
    }

    public func unload() { context = nil }

    /// A language-code → probability map, unnormalised, exactly as `TieredRouter` expects.
    ///
    /// Returns empty on any failure — the router treats that as "no opinion" and falls back,
    /// which is the correct behaviour for a detector: being unsure must never be louder than
    /// being right, and it must never block a dictation.
    public func posterior(for audio: AudioBuffer) async -> [String: Double] {
        if context == nil { try? await prepare() }
        guard let context else { return [:] }
        guard !audio.samples.isEmpty else { return [:] }

        // Whisper's encoder wants at least a moment of signal. Below a second it is reading
        // mostly padding, and the answer is confident nonsense.
        var samples = audio.samples
        let limit = Int(window.components.seconds) * AudioBuffer.sampleRate
        if samples.count > limit { samples = Array(samples.prefix(limit)) }
        let floor = AudioBuffer.sampleRate
        if samples.count < floor {
            samples.append(contentsOf: repeatElement(0, count: floor - samples.count))
        }

        // Chained for the same reason as WhisperEngine: the detached hop leaves the actor, and
        // whisper_pcm_to_mel / whisper_lang_auto_detect both mutate the shared context.
        let previous = inFlight
        let task = Task.detached(priority: .userInitiated) { () -> [String: Double] in
            _ = await previous?.value
            return context.detectLanguage(samples: samples)
        }
        inFlight = task
        return await task.value
    }
}

extension WhisperContext {

    /// Runs the mel front-end and the language head. Off the actor by the caller's chaining.
    func detectLanguage(samples: [Float]) -> [String: Double] {
        let threads = Int32(max(1, min(8, ProcessInfo.processInfo.activeProcessorCount - 2)))

        let melStatus = samples.withUnsafeBufferPointer { buffer -> Int32 in
            whisper_pcm_to_mel(pointer, buffer.baseAddress, Int32(buffer.count), threads)
        }
        guard melStatus == 0 else { return [:] }

        let count = Int(whisper_lang_max_id()) + 1
        var probabilities = [Float](repeating: 0, count: count)
        let top = probabilities.withUnsafeMutableBufferPointer { buffer -> Int32 in
            whisper_lang_auto_detect(pointer, 0, threads, buffer.baseAddress)
        }
        guard top >= 0 else { return [:] }

        var posterior: [String: Double] = [:]
        posterior.reserveCapacity(count)
        for id in 0..<count {
            let probability = Double(probabilities[id])
            // Everything below a thousandth is noise across 99 languages and only makes the
            // diagnostics harder to read.
            guard probability > 0.001, let name = whisper_lang_str(Int32(id)) else { continue }
            posterior[String(cString: name)] = probability
        }
        return posterior
    }
}
