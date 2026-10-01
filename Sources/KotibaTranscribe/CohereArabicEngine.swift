import Foundation
import KotibaCore
import Synchronization
internal import CTranscribe

// Arabic, by measurement (docs/research/C4-turkish-arabic-engine-selection.md, D-11).
//
// Cohere Transcribe Arabic 07-2026, Q5_K_M GGUF, through transcribe.cpp — 7.0 % WER on FLEURS
// Arabic against whisper turbo's 13.8 %, 38 % on dialects against 61 %, and punctuation F1 73
// against turbo's 5. It is the one engine in the app that is neither whisper.cpp nor Parakeet,
// which is why it lives in its own target:
//
//   * **A second native runtime.** transcribe.cpp carries its own ggml. Its xcframework is a
//     dynamic framework that exports no `ggml_*` symbol (checked with `nm -gU`: 0, against
//     whisper.framework's 1,035), so the two cannot bind to each other's copy — and this target
//     imports only `CTranscribe`, never the whisper module, whose framework also ships a header
//     named `whisper.h`. `internal import` keeps the C surface out of every client.
//   * **A hard 35 s input cap.** Cohere decodes the first window and little else past it: batch
//     WER 47 % at 60 s and 79 % at 180 s, against 8.2 / 6.1 % fed in segments (C4 §3.3). So
//     nothing here ever hands it more than `maximumSegment`; `transcribe` cuts a longer buffer at
//     its quietest moments first.
//   * **A decode loop.** 2 of 200 dialect clips ran into the generation cap and returned nothing
//     (C4 §3.2). That is reported as `.truncated`, never as text, so the caller can decode the
//     span with whisper turbo instead (`ArabicSegmentDecoder`, KotibaEngines).
//
// The model file is 1.77 GB and optional: nothing loads it until Arabic is turned on and the
// file is on disk.

/// A flag transcribe.cpp polls during a run; raising it ends the run early.
///
/// `following` lets a caller's own flag drive it — the streaming session raises a `WhisperAbort`,
/// which this target cannot see (it would mean importing the whisper module).
public final class TranscribeAbort: Sendable {
    private let flag = Atomic<Bool>(false)
    private let following: (@Sendable () -> Bool)?
    public init(following: (@Sendable () -> Bool)? = nil) { self.following = following }
    public func raise() { flag.store(true, ordering: .relaxed) }
    public var isRaised: Bool { flag.load(ordering: .relaxed) || following?() == true }
}

public actor CohereArabicEngine {

    /// What one decode came to. A truncated decode's partial text is kept for the record and
    /// never pasted: it is exactly the output a loop leaves behind.
    public enum Outcome: Sendable, Equatable {
        case text(String)
        case truncated(partial: String)
        case aborted
        case failed(String)
    }

    public nonisolated let modelURL: URL
    public nonisolated let engineID = "cohere-transcribe-arabic"

    /// transcribe.cpp's per-run knobs that reach Cohere: punctuation (PNC), inverse text
    /// normalisation (ITN — numbers as digits) and the n-gram speculative draft length. `nil`
    /// is the family default, which is what C4 measured.
    public struct Options: Sendable, Equatable {
        public var punctuation: Bool?
        public var inverseNormalisation: Bool?
        public var speculativeDrafts: Int?
        public init(punctuation: Bool? = nil, inverseNormalisation: Bool? = nil,
                    speculativeDrafts: Int? = nil) {
            self.punctuation = punctuation
            self.inverseNormalisation = inverseNormalisation
            self.speculativeDrafts = speculativeDrafts
        }
    }
    public nonisolated let options: Options

    /// No segment reaches the model longer than this. The model's own ceiling is 35 s; the
    /// streaming session commits at 20–24 s (`SpeechSegmenter`), so this only ever cuts a batch
    /// decode of a long recording.
    public static let maximumSegment: Double = 28

    private var context: CohereContext?
    private var loading: Task<Result<CohereContext, CohereLoadError>, Never>?
    /// The last run, so the next one chains behind it: transcribe.cpp 0.2.4 allows one run in
    /// flight per model ("concurrent COMPUTE is not yet supported", transcribe.h), and a session
    /// is single-threaded. Same shape, and the same reason, as `WhisperEngine.inFlight`.
    private var inFlight: Task<Void, Never>?
    private var lastError: String?

    public init(modelURL: URL, options: Options = Options()) {
        self.modelURL = modelURL
        self.options = options
    }

    public func isReady() -> Bool { context != nil }
    public func failureReason() -> String? { lastError }

    /// Loads the GGUF. Idempotent, deduplicated across concurrent callers, off the actor.
    public func prepare() async throws {
        if context != nil { return }
        guard FileManager.default.fileExists(atPath: modelURL.path) else {
            lastError = "no model at \(modelURL.path)"
            throw CohereLoadError(reason: lastError!)
        }
        let path = modelURL.path
        let task: Task<Result<CohereContext, CohereLoadError>, Never>
        if let loading {
            task = loading
        } else {
            task = Task.detached(priority: .userInitiated) { CohereContext.load(path: path) }
            loading = task
        }
        let result = await task.value
        loading = nil
        if context != nil { return }
        switch result {
        case .success(let loaded):
            context = loaded
            lastError = nil
        case .failure(let error):
            lastError = error.reason
            throw error
        }
    }

    /// Drops the model (~2 GB resident on Metal, C4 §5). A run in progress keeps its own
    /// reference to the context and finishes first.
    public func unload() { context = nil }

    /// One segment, at most `maximumSegment` long.
    public func decode(_ samples: [Float], abort: TranscribeAbort? = nil) async -> Outcome {
        guard !samples.isEmpty else { return .text("") }
        if context == nil {
            do { try await prepare() } catch {
                return .failed((error as? CohereLoadError)?.reason ?? "\(error)")
            }
        }
        guard let context else { return .failed(lastError ?? "no context") }
        // Cohere has no floor of its own, but a quarter second of speech is the shortest thing a
        // dictation delivers, and padding to a second matches what whisper is given.
        var input = samples
        if input.count < AudioBuffer.sampleRate {
            input.append(contentsOf: repeatElement(0, count: AudioBuffer.sampleRate - input.count))
        }
        let pcm = input
        let previous = inFlight
        let options = options
        let task = Task.detached(priority: .userInitiated) { () -> Outcome in
            await previous?.value
            if abort?.isRaised == true { return .aborted }
            return context.run(pcm, abort: abort, options: options)
        }
        inFlight = Task { _ = await task.value }
        return await task.value
    }

    /// A whole recording: cut into segments no longer than `maximumSegment` at the quietest
    /// 200 ms near each limit, decoded in order, joined. A segment that loops fails the whole
    /// call as `.truncated`, so the caller's fallback decodes the recording rather than pasting
    /// one with a hole in it.
    public func transcribe(_ samples: [Float]) async -> Outcome {
        var parts: [String] = []
        for range in Self.segments(of: samples) {
            switch await decode(Array(samples[range])) {
            case .text(let text): parts.append(text)
            case .truncated(let partial): return .truncated(partial: partial)
            case .aborted: return .aborted
            case .failed(let why): return .failed(why)
            }
        }
        return .text(parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }.joined(separator: " "))
    }

    /// Where a long recording is cut: every segment at most `maximumSegment`, each cut in the
    /// quietest 200 ms window of the last 8 s before the limit. Pure, for the tests.
    public static func segments(of samples: [Float], maximum: Double = maximumSegment)
        -> [Range<Int>] {
        let rate = AudioBuffer.sampleRate
        let limit = Int(maximum * Double(rate))
        guard samples.count > limit else { return samples.isEmpty ? [] : [0..<samples.count] }
        let window = rate / 5                      // 200 ms
        let search = 8 * rate
        var ranges: [Range<Int>] = []
        var start = 0
        while samples.count - start > limit {
            let hi = start + limit
            let lo = max(start + rate, hi - search)
            var best = hi
            var bestEnergy = Float.greatestFiniteMagnitude
            var position = lo
            while position + window <= hi {
                var energy: Float = 0
                for i in position..<(position + window) { energy += samples[i] * samples[i] }
                if energy < bestEnergy {
                    bestEnergy = energy
                    best = position + window / 2
                }
                position += window / 2
            }
            ranges.append(start..<best)
            start = best
        }
        ranges.append(start..<samples.count)
        return ranges
    }
}

// MARK: - The C boundary

/// Why the model would not load, in words — KotibaEngines maps it onto `EngineFailure`.
public struct CohereLoadError: Error, Sendable, Equatable {
    public let reason: String
}

/// Owns a `transcribe_model` and one session on it, and frees both exactly once — the session
/// first, as transcribe.h requires.
///
/// `@unchecked Sendable` is sound for the reason `WhisperContext`'s is: `CohereArabicEngine`
/// chains every run through `inFlight`, so at most one thread touches the session at a time,
/// which is the whole of transcribe.cpp's threading contract for a session.
final class CohereContext: @unchecked Sendable {
    private let model: OpaquePointer
    private let session: OpaquePointer

    private init(model: OpaquePointer, session: OpaquePointer) {
        self.model = model
        self.session = session
    }

    deinit {
        transcribe_session_free(session)
        transcribe_model_free(model)
    }

    /// transcribe.cpp writes model-load chatter to stderr by default. Silenced once, before the
    /// first load — the only time transcribe.h allows the callback to be installed.
    private static let silenced: Void = {
        transcribe_log_set({ _, _, _ in }, nil)
        _ = transcribe_init_backends_default()
    }()

    static func load(path: String) -> Result<CohereContext, CohereLoadError> {
        _ = silenced
        var model: OpaquePointer?
        let status = transcribe_model_load_file(path, nil, &model)
        guard status == TRANSCRIBE_OK, let model else {
            return .failure(CohereLoadError(reason: "transcribe.cpp could not load "
                + "\(URL(fileURLWithPath: path).lastPathComponent): "
                + String(cString: transcribe_status_string(Int32(status.rawValue)))))
        }
        var session: OpaquePointer?
        let opened = transcribe_session_init(model, nil, &session)
        guard opened == TRANSCRIBE_OK, let session else {
            transcribe_model_free(model)
            return .failure(CohereLoadError(reason: "transcribe.cpp could not open a session: "
                + String(cString: transcribe_status_string(Int32(opened.rawValue)))))
        }
        return .success(CohereContext(model: model, session: session))
    }

    func run(_ pcm: [Float], abort: TranscribeAbort?,
             options: CohereArabicEngine.Options = .init()) -> CohereArabicEngine.Outcome {
        var params = transcribe_run_params()
        transcribe_run_params_init(&params)
        if let on = options.punctuation {
            params.pnc = on ? TRANSCRIBE_PNC_MODE_ON : TRANSCRIBE_PNC_MODE_OFF
        }
        if let on = options.inverseNormalisation {
            params.itn = on ? TRANSCRIBE_ITN_MODE_ON : TRANSCRIBE_ITN_MODE_OFF
        }
        if let k = options.speculativeDrafts { params.spec_k_drafts = Int32(k) }
        if let abort {
            transcribe_set_abort_callback(session, { userData in
                guard let userData else { return false }
                return Unmanaged<TranscribeAbort>.fromOpaque(userData).takeUnretainedValue()
                    .isRaised
            }, Unmanaged.passUnretained(abort).toOpaque())
        } else {
            transcribe_set_abort_callback(session, nil, nil)
        }
        // The language code must outlive the call; transcribe.cpp copies it before returning.
        let status = "ar".withCString { code -> transcribe_status in
            params.language = code
            return pcm.withUnsafeBufferPointer { buffer in
                transcribe_run(session, buffer.baseAddress, Int32(buffer.count), &params)
            }
        }
        let text = transcribe_full_text(session).map { String(cString: $0) } ?? ""
        return withExtendedLifetime(abort) {
            switch status {
            case TRANSCRIBE_OK:
                return .text(text.trimmingCharacters(in: .whitespacesAndNewlines))
            case TRANSCRIBE_ERR_OUTPUT_TRUNCATED:
                return .truncated(partial: text)
            case TRANSCRIBE_ERR_ABORTED:
                return .aborted
            default:
                return .failed("transcribe_run returned "
                    + String(cString: transcribe_status_string(Int32(status.rawValue))))
            }
        }
    }
}
