import Foundation
import KotibaCore
import Synchronization
import whisper

// Task E-04. whisper.cpp, and the only measured path to Uzbek that exists.
//
// Apple refuses the language outright; Parakeet TDT v3 does not carry it; stock Whisper scores
// 101.73% WER on it, which is worse than emitting nothing. A model fine-tuned on Uzbek, run
// through whisper.cpp with Metal, is what remains. It is slower than the alternatives — ~438 ms
// against Parakeet's 62 ms — and that is a price worth paying for the language the app is for.
//
// Two decisions here are load-bearing:
//
//   * **The context is loaded once and reused.** Loading a 539 MB model per utterance would put
//     seconds on every dictation. It lives in a class, freed exactly once in `deinit`.
//   * **The language is always pinned, never auto-detected.** whisper.cpp's own language ID is
//     the thing that scored `uz 0.00` in the routing research; letting it choose is how Uzbek
//     silently became Turkish. The router decides, and passes the answer down.
//
// Being an actor is NOT what serialises `whisper_full`. The heavy calls go through
// `Task.detached`, which leaves the actor, and the `await` on the result is a suspension point a
// second caller can enter through — so two decodes could share one context, which is heap
// corruption rather than a garbled transcript. `inFlight` chains them explicitly instead.

public actor WhisperEngine: TranscriptionEngine {

    public nonisolated let engineID: String
    public nonisolated let supportedLanguages: Set<Language>

    /// Where the `.bin` lives. Not downloaded here: `ModelStore` owns fetching and verification,
    /// and an engine that also downloaded would have two sources of truth about what is on disk.
    public nonisolated let modelURL: URL

    private var context: WhisperContext?
    private var lastError: String?

    /// The last detached call, so the next one can chain behind it.
    ///
    /// `whisper_full` is not thread-safe against a shared context: it mutates the KV cache,
    /// `state->result_all` and the logits buffers, so two concurrent calls are heap corruption
    /// rather than a garbled transcript. Actor isolation does NOT provide the serialisation —
    /// `Task.detached` leaves the actor by construction, and awaiting it is a suspension point
    /// that lets a second `transcribe` walk straight in and launch another. So the chain is
    /// explicit. Assignment happens before any suspension, so no two callers can read the same
    /// predecessor.
    private var inFlight: Task<Void, Never>?

    /// The in-progress load, for the same reason: two callers must not both map 539 MB.
    private var loading: Task<WhisperContext?, Never>?

    /// Tunables, kept together so a settings pane has one thing to write to.
    public struct Options: Sendable, Equatable {
        /// Metal. Off costs roughly an order of magnitude on this hardware.
        public var useGPU: Bool
        /// 0 means "decide from the machine", which is what `prepare()` does.
        public var threads: Int
        /// Greedy with `bestOf` 1 is the fast path. Beam search buys accuracy for latency, and
        /// for push-to-talk dictation latency is the product.
        public var beamSize: Int
        /// Words the model should expect. Prepended to the decoder's context — this is how
        /// "Kotiba" stops coming out as "cotta".
        public var initialPrompt: String?
        /// The prompt per language, for an engine that serves more than one — whisper turbo is
        /// Russian's fallback, Turkish's engine and Arabic's fallback (D-11), and a Russian
        /// exemplar in front of a Turkish decode biases it toward the wrong language. A language
        /// listed here takes its own; any other takes `initialPrompt`.
        public var languagePrompts: [Language: String] = [:]
        /// Whisper's hallucination floor. Below it the model is guessing at silence.
        public var noSpeechThreshold: Float
        /// How much of the 30-second encoder window to run. See `AudioContext`.
        public var audioContext: AudioContext
        /// whisper.cpp's flash-attention kernels. **Must be false on an engine that decodes with
        /// more than one encoder window** — the streaming Uzbek engine — because v1.9.2's flash
        /// path reads cross-attention keys past the window it wrote (see `AudioContext`). Off
        /// costs ~16 ms on a 2.8 s tail (C2 §6). Changing it reloads the model.
        public var flashAttention: Bool

        public init(useGPU: Bool = true, threads: Int = 0, beamSize: Int = 1,
                    initialPrompt: String? = nil, noSpeechThreshold: Float = 0.6,
                    audioContext: AudioContext = .full, flashAttention: Bool = true) {
            self.flashAttention = flashAttention
            self.useGPU = useGPU
            self.threads = threads
            self.beamSize = beamSize
            self.initialPrompt = initialPrompt
            self.noSpeechThreshold = noSpeechThreshold
            self.audioContext = audioContext
        }
    }

    /// The encoder window, which is where a short utterance's time goes.
    ///
    /// Whisper encodes 30 s — 1500 positions — whatever it is given, so a 2.8 s phrase spent 92% of
    /// its compute encoding silence (Scripts/measure/README.md, "split.sh"). `audio_ctx` truncates
    /// the window. Two things about it were learned the hard way, both in C2 §3:
    ///
    ///   * **Mixing windows on one context needs flash attention off.** whisper.cpp v1.9.2's flash
    ///     path runs the decoder's cross-attention over `GGML_PAD(audio_ctx, 256)` positions with
    ///     no mask, and lays the cache out per layer at a stride of that padded size. A window
    ///     that is not a multiple of 256 — including the model's own 1500 — therefore attends to
    ///     36+ positions the encoder never wrote: zeros in a fresh context, which is what every
    ///     whole-utterance measurement saw, but *another layer's keys* once a call with a
    ///     different window has used the same memory. On a corpus replay that was a 27-second
    ///     temperature-fallback decode ending "k.k.k.k", and a streaming run with full-window
    ///     commits between fitted speculations measured 27.13% against 21.83%. The non-flash path
    ///     reads exactly `audio_ctx` positions, so `Options.flashAttention = false` removes it;
    ///     fitted windows are also rounded to 256 so they carry no pad at all.
    ///   * **The fine-tune needs silence after the speech.** With the padding bug removed the
    ///     margin is what decides whether the decoder finds end-of-text; see `fitted`.
    public enum AudioContext: Sendable, Equatable {
        /// The model's own 1500 positions.
        case full
        /// Enough positions for the audio (50 per second) plus `margin`, rounded up to the next
        /// multiple of 256. Never more than the model's window.
        case fitted(margin: Int)

        /// whisper.cpp pads the cross-attention to this many positions and does not mask the pad.
        public static let quantum = 256

        /// Positions for `sampleCount` samples, or 0 for "the model's default".
        public func positions(for sampleCount: Int, modelWindow: Int = 1500) -> Int {
            switch self {
            case .full:
                return 0
            case .fitted(let margin):
                // 16 kHz → 100 mel frames/s → 50 encoder positions/s: 320 samples a position.
                let needed = (sampleCount + 319) / 320 + max(0, margin)
                let rounded = ((needed + Self.quantum - 1) / Self.quantum) * Self.quantum
                return rounded >= modelWindow ? 0 : rounded
            }
        }
    }

    /// One decode of one stretch of audio, with what it cost. The streaming session reads the
    /// timings into its report; the batch path ignores them.
    public struct Decode: Sendable, Equatable {
        public let text: String
        public let audioContext: Int
        public let milliseconds: Double

        public init(text: String, audioContext: Int, milliseconds: Double) {
            self.text = text
            self.audioContext = audioContext
            self.milliseconds = milliseconds
        }
    }

    public var options: Options

    public init(modelURL: URL,
                supportedLanguages: Set<Language> = [.uzbek],
                engineID: String? = nil,
                options: Options = Options()) {
        self.modelURL = modelURL
        self.supportedLanguages = supportedLanguages
        self.engineID = engineID ?? "whisper-\(modelURL.deletingPathExtension().lastPathComponent)"
        self.options = options
    }

    public func prompt(for language: Language) -> String? { options.prompt(for: language) }

    public func setOptions(_ new: Options) {
        // A change that affects how the context itself was built has to invalidate it.
        if new.useGPU != options.useGPU || new.flashAttention != options.flashAttention {
            context = nil
        }
        options = new
    }

    public func isReady() async -> Bool { context != nil }

    public func failureReason() -> String? { lastError }

    /// Loads the model. Idempotent: a second call with a live context returns immediately, and a
    /// call after a failure retries rather than staying broken for the process lifetime.
    public func prepare() async throws {
        if context != nil { return }
        guard FileManager.default.fileExists(atPath: modelURL.path) else {
            lastError = "no model at \(modelURL.path)"
            throw EngineFailure.modelMissing(path: modelURL.path)
        }
        WhisperContext.silenceLogging()

        var params = whisper_context_default_params()
        params.use_gpu = options.useGPU
        params.flash_attn = options.useGPU && options.flashAttention

        // Loading is seconds of CPU and must not block the actor's executor, which the audio
        // pipeline also needs. Off to a detached task and back — but only one at a time, and
        // re-checked afterwards, because the await below releases the actor.
        let path = modelURL.path
        let task: Task<WhisperContext?, Never>
        if let existing = loading {
            task = existing
        } else {
            task = Task.detached(priority: .userInitiated) { () -> WhisperContext? in
                WhisperContext(path: path, params: params)
            }
            loading = task
        }
        let loaded = await task.value
        loading = nil
        if context != nil { return }   // another caller won the race and installed one

        guard let loaded else {
            lastError = "whisper.cpp could not load \(modelURL.lastPathComponent) — "
                + "the file may be truncated or not a ggml model"
            throw EngineFailure.transcriptionFailed(lastError!)
        }
        context = loaded
        lastError = nil
    }

    /// Drops the model. 539 MB of resident memory is worth releasing when the user switches to
    /// an engine that does not need it.
    public func unload() {
        context = nil
    }

    public func transcribe(_ audio: KotibaCore.AudioBuffer,
                           language: Language) async throws -> Transcript {
        guard supportedLanguages.contains(language) else {
            throw EngineFailure.languageUnsupported(language, engineID: engineID)
        }
        guard !audio.samples.isEmpty else {
            throw EngineFailure.transcriptionFailed("no audio")
        }
        if context == nil { try await prepare() }
        guard let context else { throw EngineFailure.notReady(lastError ?? "no context") }

        // Whisper pads to 30 s internally; below about a second the encoder has almost nothing
        // to condition on and hallucinates confidently. Pad rather than refuse — a short "yes"
        // is a legitimate dictation.
        var samples = audio.samples
        let floor = KotibaCore.AudioBuffer.sampleRate  // 1 s
        if samples.count < floor {
            samples.append(contentsOf: repeatElement(0, count: floor - samples.count))
        }

        var chosen = self.options
        chosen.initialPrompt = chosen.prompt(for: language)
        let options = chosen
        let code = language.rawValue
        let positions = options.audioContext.positions(for: samples.count)
        let input = samples
        let result = await serialised {
            context.run(samples: input, language: code, options: options,
                        audioContext: positions, abort: nil)
        }

        switch result {
        case .success(let text):
            return Transcript(raw: text.trimmingCharacters(in: .whitespacesAndNewlines),
                              language: language, engineID: engineID)
        case .failure(let failure):
            throw failure
        }
    }

    /// Decodes one segment for a streaming session: the engine's own options, except that the
    /// prompt, beam width and encoder window are the caller's. Serialised with every other call
    /// on this context — a streaming session and a batch transcribe share one model.
    ///
    /// `abort` lets the session drop a speculative decode the moment new speech makes it stale,
    /// so the tail at key-release never queues behind work nobody wants.
    public func decode(_ samples: [Float], language: Language, prompt: String?,
                       beamSize: Int? = nil, audioContext: AudioContext? = nil,
                       abort: WhisperAbort? = nil) async throws -> Decode {
        guard supportedLanguages.contains(language) else {
            throw EngineFailure.languageUnsupported(language, engineID: engineID)
        }
        if context == nil { try await prepare() }
        guard let context else { throw EngineFailure.notReady(lastError ?? "no context") }

        var padded = samples
        let floor = KotibaCore.AudioBuffer.sampleRate
        if padded.count < floor {
            padded.append(contentsOf: repeatElement(0, count: floor - padded.count))
        }
        var options = self.options
        options.initialPrompt = prompt
        if let beamSize { options.beamSize = beamSize }
        let positions = (audioContext ?? options.audioContext).positions(for: padded.count)
        let code = language.rawValue
        let input = padded
        let settings = options
        let started = ContinuousClock.now
        let result = await serialised {
            abort?.isRaised == true
                ? .failure(.transcriptionFailed("aborted"))
                : context.run(samples: input, language: code, options: settings,
                              audioContext: positions, abort: abort)
        }
        let elapsed = ContinuousClock.now - started
        switch result {
        case .success(let text):
            return Decode(text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                          audioContext: positions,
                          milliseconds: Double(elapsed.components.seconds) * 1000
                            + Double(elapsed.components.attoseconds) / 1e15)
        case .failure(let failure):
            throw failure
        }
    }

    /// This model's own language posterior over the first 30 s of `samples` — whisper's language
    /// head, on a whisper state of its own (see `WhisperContext.detectLanguageOnOwnState`). For
    /// `TurkishCheck` (D-11): the Turkish engine's turbo tells Turkish from Uzbek where whisper
    /// base cannot. Empty on any failure.
    ///
    /// Chained with other language-head calls, and deliberately NOT with the decodes: it touches
    /// only its own state and the read-only weights, which is how whisper.cpp itself runs several
    /// states on one context at once (`whisper_full_parallel`). Serialised behind them, a 0.56 s
    /// head pass held up the Turkish stream's pause decode, and key-up waited for both (measured
    /// in the first e2e run: 460–900 ms with the tail already speculated).
    ///
    /// `window` is the encoder window the head reads, as for a decode (`AudioContext`): `.full`
    /// is the 30 s it was first measured with, `.fitted` encodes only the audio plus a margin of
    /// silence — see `LanguageHeadWindow` for what that costs and what it changes.
    public func languagePosterior(_ samples: [Float],
                                  window: AudioContext = .full) async -> [String: Double] {
        guard !samples.isEmpty else { return [:] }
        if context == nil { try? await prepare() }
        guard let context else { return [:] }
        var input = Array(samples.prefix(30 * KotibaCore.AudioBuffer.sampleRate))
        let floor = KotibaCore.AudioBuffer.sampleRate
        if input.count < floor { input.append(contentsOf: repeatElement(0, count: floor - input.count)) }
        let pcm = input
        let positions = window.positions(for: pcm.count)
        let flash = options.useGPU && options.flashAttention
        let previous = languageInFlight
        let task = Task.detached(priority: .userInitiated) { () -> [String: Double] in
            await previous?.value
            return context.detectLanguageOnOwnState(samples: pcm, audioContext: positions,
                                                    flashAttention: flash)
        }
        languageInFlight = Task { _ = await task.value }
        return await task.value
    }

    /// The last language-head call, so the next one waits for it: they share `languageState`.
    private var languageInFlight: Task<Void, Never>?

    /// Runs `work` detached, strictly after every call already chained on this context.
    ///
    /// Chained, not merely detached. See `inFlight`. The assignment happens before the first
    /// suspension, so no two callers can read the same predecessor.
    private func serialised<T: Sendable>(
        _ work: @escaping @Sendable () -> T
    ) async -> T {
        let previous = inFlight
        let task = Task.detached(priority: .userInitiated) { () -> T in
            await previous?.value
            return work()
        }
        inFlight = Task { _ = await task.value }
        return await task.value
    }
}

extension WhisperEngine.Options {
    /// The prompt a decode in `language` is sent: its own, or the engine-wide one.
    public func prompt(for language: Language) -> String? {
        languagePrompts[language] ?? initialPrompt
    }
}

extension WhisperEngine {
    /// Whether this engine may be handed different encoder windows call to call. False with
    /// flash attention on the GPU; see `Options.flashAttention`.
    public func mixesWindowsSafely() -> Bool {
        !(options.useGPU && options.flashAttention)
    }
}

/// A whisper model's language head as an `AcousticClassifier` — the Turkish engine's turbo,
/// asked by `TurkishCheck` whether a Turkish candidate is Turkish or Uzbek (D-11).
public struct WhisperLanguageHead: AcousticClassifier {
    public let engine: WhisperEngine
    /// The encoder window the head reads. See `TurkishCheck.headMargin` for the measurement.
    public let window: WhisperEngine.AudioContext
    public init(engine: WhisperEngine,
                window: WhisperEngine.AudioContext = .fitted(margin: TurkishCheck.headMargin)) {
        self.engine = engine
        self.window = window
    }
    public func posterior(for audio: KotibaCore.AudioBuffer) async -> [String: Double] {
        await engine.languagePosterior(audio.samples, window: window)
    }
}

/// A flag whisper.cpp polls between decoder steps; raising it ends the decode early.
///
/// A class so the C callback can be handed a stable pointer to it, and atomic because the flag is
/// raised on the session's actor while whisper reads it on the decode thread.
public final class WhisperAbort: Sendable {
    private let flag = Atomic<Bool>(false)
    public init() {}
    public func raise() { flag.store(true, ordering: .relaxed) }
    public var isRaised: Bool { flag.load(ordering: .relaxed) }
}

// MARK: - The C boundary

/// Owns a `whisper_context` pointer and frees it exactly once.
///
/// A class, not a struct, because the free must happen on the last reference and nowhere else —
/// a struct copy would give two owners of one pointer and a double free.
///
/// `@unchecked Sendable` is sound because `WhisperEngine` chains every call through `inFlight`,
/// so at most one `run` touches a given context at a time. It is NOT sound by virtue of actor
/// isolation, which is what an earlier version of this comment claimed: the calls go through
/// `Task.detached`, which leaves the actor, and the `await` that follows is a suspension point
/// another caller can enter through. The chain is the guarantee; the actor is not.
final class WhisperContext: @unchecked Sendable {

    /// Visible to the language detector in this module, which runs its own mel + language head
    /// against the same context type. Still private to the module.
    let pointer: OpaquePointer

    /// A second whisper state on the same weights, for the language head alone. Made on first use.
    ///
    /// Not the context's default state, because `whisper_lang_auto_detect` encodes with the window
    /// of whatever `whisper_full` ran on that state last (v1.9.2 src/whisper.cpp:6836 detects
    /// before :6972 sets `exp_n_audio_ctx`), and the streaming engine leaves a fitted window there
    /// — so the answer would depend on the previous decode. A fresh state always encodes the full
    /// 30 s, which is what `TurkishCheck` was measured with. It holds a KV cache and compute
    /// buffers, not a second copy of the weights.
    private var languageState: OpaquePointer?

    init?(path: String, params: whisper_context_params) {
        guard let pointer = whisper_init_from_file_with_params(path, params) else { return nil }
        self.pointer = pointer
    }

    deinit {
        if let languageState { whisper_free_state(languageState) }
        whisper_free(pointer)
    }

    /// The language posterior, on `languageState`, over an encoder window of `audioContext`
    /// positions (0 = the model's 1500). Called only through `WhisperEngine`'s language chain,
    /// so never beside another language call on this context.
    ///
    /// whisper.cpp v1.9.2 has no setter for a state's encoder window: `whisper_lang_auto_detect`
    /// encodes with `exp_n_audio_ctx`, which only `whisper_full` writes (src/whisper.cpp:6972).
    /// So the mel and the window are set by a `whisper_full_with_state` whose encoder-begin
    /// callback refuses to start — it computes the mel, writes the window, reaches the main
    /// loop and stops before the encoder — and the head then encodes exactly once, with
    /// that window. Written every call, `.full` included, so no answer depends on the last one.
    /// The windows mix on this state, which is safe only with flash attention off (the engine's
    /// streaming configuration; `mixesWindowsSafely`). With it on, `.full` is used whatever
    /// was asked.
    func detectLanguageOnOwnState(samples: [Float], audioContext: Int,
                                  flashAttention: Bool = false) -> [String: Double] {
        if languageState == nil { languageState = whisper_init_state(pointer) }
        guard let state = languageState else { return [:] }
        let threads = Int32(max(1, min(8, ProcessInfo.processInfo.activeProcessorCount - 2)))
        var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        params.n_threads = threads
        params.print_progress = false
        params.print_realtime = false
        params.print_timestamps = false
        params.no_timestamps = true
        params.detect_language = false
        params.audio_ctx = flashAttention ? 0 : Int32(audioContext)
        params.encoder_begin_callback = { _, _, _ in false }
        let melStatus = "en".withCString { code -> Int32 in
            params.language = code
            return samples.withUnsafeBufferPointer { buffer -> Int32 in
                whisper_full_with_state(pointer, state, params, buffer.baseAddress,
                                        Int32(buffer.count))
            }
        }
        guard melStatus == 0 else { return [:] }
        let count = Int(whisper_lang_max_id()) + 1
        var probabilities = [Float](repeating: 0, count: count)
        let top = probabilities.withUnsafeMutableBufferPointer { buffer -> Int32 in
            whisper_lang_auto_detect_with_state(pointer, state, 0, threads, buffer.baseAddress)
        }
        guard top >= 0 else { return [:] }
        var posterior: [String: Double] = [:]
        for id in 0..<count {
            let probability = Double(probabilities[id])
            guard probability > 0.001, let name = whisper_lang_str(Int32(id)) else { continue }
            posterior[String(cString: name)] = probability
        }
        return posterior
    }

    /// whisper.cpp writes progress and tensor chatter to stderr by default, which in a menu-bar
    /// app goes to the system log and in tests drowns the output. Silenced once per process.
    static func silenceLogging() {
        whisper_log_set({ _, _, _ in }, nil)
    }

    func run(samples: [Float], language: String, options: WhisperEngine.Options,
             audioContext: Int, abort: WhisperAbort?) -> Result<String, EngineFailure> {
        var params = whisper_full_default_params(
            options.beamSize > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY)

        params.print_realtime = false
        params.print_progress = false
        params.print_timestamps = false
        params.print_special = false
        params.no_timestamps = true
        params.translate = false           // never. "Never translate" is a rule the app enforces
                                           // at the prompt layer too, for the same reason.
        params.single_segment = false
        params.suppress_blank = true
        params.no_speech_thold = options.noSpeechThreshold
        params.n_threads = Int32(options.threads > 0
            ? options.threads
            : max(1, min(8, ProcessInfo.processInfo.activeProcessorCount - 2)))
        if options.beamSize > 1 {
            params.beam_search.beam_size = Int32(options.beamSize)
        }
        // `greedy.best_of` is set in BOTH branches, and it is not the greedy-path knob its name
        // suggests. Read from the v1.9.2 source this app links:
        //
        //   * At temperature 0 it does nothing measurable — greedy decoding is deterministic, and
        //     `app-noprompt` reproduced the control to two decimals with best_of 1 against 5.
        //   * Above temperature 0 it *is* the fallback's sample count: `n_decoders_cur =
        //     params.greedy.best_of` (src/whisper.cpp:7062-7068), and the decoder switches from
        //     argmax to a single draw from `std::discrete_distribution` (:7234-7239 → :6511-6517).
        //     So `best_of = 1` makes every fallback rung one unranked random sample.
        //   * That path is reached often, and it does not stop early: raising the temperature
        //     divides the logits before `avg_logprobs` is recorded (:6201-6204), so the recorded
        //     confidence *falls* as the ladder climbs, and the last rung at t = 1.0 is accepted
        //     unconditionally (:7571-7581). A 25% aggregate WER can hide a tail of clips that came
        //     back as temperature-1.0 noise, and that tail is what "awful" feels like in use.
        //   * The beam branch never touched it at all, so it kept the struct-literal default of
        //     `-1` (:5981) — `whisper_full_default_params` fills only `beam_search` for the beam
        //     strategy — and `max(1, -1)` is 1. Beam 5 degenerated to a single sample on fallback
        //     exactly like greedy did.
        //
        // Five candidates ranked, in both branches, is strictly better than one unranked in either.
        params.greedy.best_of = 5

        // 0 is whisper's "use the model's window". See `WhisperEngine.AudioContext`.
        params.audio_ctx = Int32(audioContext)

        if let abort {
            params.abort_callback = { userData in
                guard let userData else { return false }
                return Unmanaged<WhisperAbort>.fromOpaque(userData).takeUnretainedValue().isRaised
            }
            // Unretained is safe: `abort` is held by this frame until `whisper_full` returns.
            params.abort_callback_user_data = Unmanaged.passUnretained(abort).toOpaque()
        }

        // The language string and the prompt must outlive `whisper_full`, so they are held in
        // scope here rather than passed as temporaries — a C API taking `const char *` does not
        // copy, and a dangling pointer here reads as a garbage language code.
        return language.withCString { languageC -> Result<String, EngineFailure> in
            params.language = languageC
            params.detect_language = false     // never. The router already decided.

            let outcome: Result<String, EngineFailure>
            if let prompt = options.initialPrompt, !prompt.isEmpty {
                outcome = prompt.withCString { promptC in
                    params.initial_prompt = promptC
                    return execute(samples: samples, params: params)
                }
            } else {
                outcome = execute(samples: samples, params: params)
            }
            return withExtendedLifetime(abort) { outcome }
        }
    }

    private func execute(samples: [Float],
                         params: whisper_full_params) -> Result<String, EngineFailure> {
        let status = samples.withUnsafeBufferPointer { buffer -> Int32 in
            whisper_full(pointer, params, buffer.baseAddress, Int32(buffer.count))
        }
        guard status == 0 else {
            return .failure(.transcriptionFailed("whisper_full returned \(status)"))
        }

        var text = ""
        for index in 0..<whisper_full_n_segments(pointer) {
            guard let segment = whisper_full_get_segment_text(pointer, index) else { continue }
            text += String(cString: segment)
        }
        return .success(text)
    }
}
