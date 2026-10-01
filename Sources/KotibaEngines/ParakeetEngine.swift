@preconcurrency import CoreML
import FluidAudio
import Foundation
import KotibaCore
import KotibaModels

// English and Russian, one model, on the Neural Engine.
//
// NVIDIA's Parakeet-TDT-0.6B family — here moondream's post-trained "Ultra" build of v3 — run
// through FluidAudio's Core ML port. It replaced two engines at once: Apple's SpeechTranscriber
// for English and whisper large-v3-turbo for Russian. The measurement that chose it, and every
// number quoted below, is in docs/research/C1-en-ru-engine-selection.md and reproducible with
// `Scripts/measure/en-ru`.
//
// What it is, in the four facts that shaped this file:
//
//   * **One model decides English against Russian itself.** The v3 vocabulary holds both
//     scripts and the decoder picks per token, so the router's en/ru choice is advisory here —
//     which is why `EngineFamily.unified` exists at all.
//   * **Punctuation and capitals come out of the decoder.** Nothing downstream has to invent
//     them, unlike whisper-on-Russian, whose output the Capitaliser was patching.
//   * **It reads audio in fixed 15 s windows.** Anything up to 15 s costs one encoder pass;
//     longer audio costs one per window. That is what `openStream()` is for.
//   * **The weights are a directory of Core ML files, fetched on first use** through
//     `ModelStore` from the upstream Hugging Face repo, pinned to one commit, every file
//     sha256-checked (`ModelCatalogue.parakeetUltra`). FluidAudio's own downloader is never
//     used: `loadLocal` reads a directory and does no network I/O at all.

public actor ParakeetEngine: StreamingTranscriptionEngine {

    /// Which Parakeet. Only `.ultra` ships; the others exist so the probe can measure against
    /// them, which is how Ultra was chosen and how the next candidate will be.
    public enum Variant: String, Sendable, CaseIterable {
        case ultra
        case v3
        case v2

        public var bundle: ModelBundle {
            switch self {
            case .ultra: return ModelCatalogue.parakeetUltra
            case .v3: return ModelCatalogue.parakeetV3
            case .v2: return ModelCatalogue.parakeetV2
            }
        }

        var version: AsrModelVersion {
            switch self {
            case .ultra: return .ultra
            case .v3: return .v3
            case .v2: return .v2
            }
        }

        /// v2 is English-only; v3 and Ultra carry 25 languages, of which Kotiba uses two.
        public var languages: Set<KotibaCore.Language> {
            self == .v2 ? [.english] : [.english, .russian]
        }
    }

    public nonisolated let engineID: String
    public nonisolated let supportedLanguages: Set<KotibaCore.Language>
    public nonisolated let variant: Variant

    private let store: ModelStore
    /// Whether to pass the routed language to the decoder's script filter. Off: it forces every
    /// token into the routed language's script, so an English word inside Russian speech comes
    /// out transliterated — measured on the code-switch set, see C1 §4.
    private let languageHint: Bool
    private let segmenter: StreamSegmenter
    /// `ggml-silero-v6.2.0.bin`, when installed. See `openStream()`.
    private var speechDetectorURL: URL?

    /// The pause detector arrived (or moved) after the engine was built.
    public func setSpeechDetectorURL(_ url: URL?) { speechDetectorURL = url }

    /// Whether `prepare()` may wait for a first-use download. The app says no: a 632 MB fetch
    /// inside `prepare()` would sit in front of a dictation for minutes, so the app's engine
    /// starts the download in the background, throws "downloading" — which `CompositeEngine`
    /// treats as "try the next member" — and serves from Apple/whisper until it lands. The probe
    /// says yes, because a measurement wants the model, however long it takes.
    private let waitForDownload: Bool
    /// Whether `prepare()` may *start* that background download at all. The app passes false:
    /// its core download (`ModelDownloads`) is the one fetcher of these weights, so a missing
    /// model is reported as missing here and nothing is fetched twice. The probe keeps the
    /// default. `download()` — an explicit request — ignores it.
    private let autoDownload: Bool
    /// How long `prepare()` waits for a load before giving up on *this* call (the load goes on).
    /// Nil waits for as long as it takes, which is what the probe wants.
    private let loadBudget: Duration?

    private var manager: AsrManager?
    /// A load in flight, shared by every caller that arrives while it runs. Without it the
    /// key-down preload and the session's own cold-start `prepare()` would each map the model.
    private var loading: Task<AsrManager, any Error>?
    /// The first-use download, when `waitForDownload` is off.
    private var downloading: Task<Void, Never>?
    /// Bumped by `unload()`, so a load that was already running when the models were given back
    /// does not resurrect them when it lands.
    private var generation = 0
    private var lastError: String?
    /// The tail of the decode queue. See `serialised`.
    private var queueTail: Task<Void, Never>?

    public init(variant: Variant = .ultra, modelsRoot: URL,
                store: ModelStore? = nil,
                downloader: any ModelDownloader = URLSessionDownloader(),
                waitForDownload: Bool = false, autoDownload: Bool = true,
                loadBudget: Duration? = .seconds(1),
                languageHint: Bool = false, segmenter: StreamSegmenter = StreamSegmenter(),
                speechDetectorURL: URL? = nil) {
        self.variant = variant
        self.engineID = "parakeet-\(variant.rawValue)"
        self.supportedLanguages = variant.languages
        // Shared with whoever else fetches into the same directory (the app's download step), so
        // one file is never written by two transfers at once.
        self.store = store ?? ModelStore(root: modelsRoot, downloader: downloader)
        self.waitForDownload = waitForDownload
        self.autoDownload = autoDownload
        self.speechDetectorURL = speechDetectorURL
        self.loadBudget = loadBudget
        self.languageHint = languageHint
        self.segmenter = segmenter
    }

    public func isReady() async -> Bool { manager != nil }

    /// Whether the weights are already on disk, so the settings pane can say "downloading
    /// 632 MB" rather than "loading" before the first dictation.
    public func isDownloaded() async -> Bool { await store.isInstalled(variant.bundle) }

    /// True while the first-use download is running.
    public func isDownloading() -> Bool { downloading != nil }


    /// The last reason `prepare()` failed, for the settings pane to show.
    public func failureReason() -> String? { lastError }


    /// Verify (fetching on first use), load and warm.
    ///
    /// Idempotent and cheap once loaded. A later load finds the verification stamp and goes
    /// straight to Core ML — 160–330 ms on the M4 Pro with the compiled plan cached (C1 §3).
    /// The warm-up decode is part of the load so the first *dictation* never pays the Neural
    /// Engine's plan build.
    public func prepare() async throws {
        if manager != nil { return }
        if loading == nil {
            if !waitForDownload, await !store.isInstalled(variant.bundle) {
                guard autoDownload || downloading != nil else {
                    throw EngineFailure.assetsUnavailable(
                        "\(variant.bundle.name) is not downloaded yet "
                        + "(\(variant.bundle.totalBytes / 1_000_000) MB, fetched once)")
                }
                startDownload()
                let why = lastError.map { "the last attempt failed: \($0)" }
                    ?? "\(variant.bundle.totalBytes / 1_000_000) MB, fetched once"
                throw EngineFailure.assetsUnavailable(
                    "\(variant.bundle.name) is still downloading (\(why))")
            }
            startLoad()
        }
        guard let task = loading else { return }   // installed while we were deciding

        // Waiting is bounded when a budget is set. A reload is 160–330 ms; the *first* load on a
        // machine also compiles the Neural Engine plan, measured at 19.6 s, and a dictation
        // must not stand behind that. Past the budget the load carries on in the background and
        // this throws, so `CompositeEngine` hands the dictation to the next member.
        if let loadBudget {
            // A race, not a task group: a group waits for *every* child before it returns, and
            // a child awaiting `task.value` cannot be cancelled out of it — so the group version
            // waited for the whole load after all. Here the loser simply finishes unobserved.
            let finished: Bool = await withCheckedContinuation { continuation in
                let once = ResumeOnce()
                Task {
                    _ = try? await task.value
                    if once.claim() { continuation.resume(returning: true) }
                }
                Task {
                    try? await Task.sleep(for: loadBudget)
                    if once.claim() { continuation.resume(returning: false) }
                }
            }
            guard finished else {
                throw EngineFailure.notReady(
                    "\(variant.bundle.name) is still loading — the first load on a Mac compiles "
                    + "it for the Neural Engine, which takes a while once")
            }
        }
        do {
            _ = try await task.value
        } catch let failure as EngineFailure {
            throw failure
        } catch {
            throw EngineFailure.assetsUnavailable(
                "\(variant.bundle.name): \((error as? ModelStoreError)?.reason ?? "\(error)")")
        }
    }

    private func startLoad() {
        let store = self.store
        let variant = self.variant
        let started = generation
        loading = Task { () throws -> AsrManager in
            do {
                let directory = try await store.ensure(variant.bundle)
                let models = try AsrModels.loadLocal(from: directory, version: variant.version)
                let manager = AsrManager(config: .default)
                try await manager.loadModels(models)
                var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
                _ = try? await manager.transcribe([Float](repeating: 0, count: 16_000),
                                                  decoderState: &state)
                try await self.install(manager, loadedIn: started)
                return manager
            } catch {
                self.loadFailed(error, loadedIn: started)
                throw error
            }
        }
    }

    /// The end of a load, on the actor. Refuses — and releases what was loaded — when
    /// `unload()` ran in the meantime.
    private func install(_ loaded: AsrManager, loadedIn started: Int) async throws {
        guard generation == started else {
            await loaded.cleanup()
            throw EngineFailure.notReady("the model was unloaded while it was loading")
        }
        loading = nil
        manager = loaded
        lastError = nil
    }

    /// Cleared by the load itself, not by whoever awaited it: with a budget, nobody may be.
    private func loadFailed(_ error: any Error, loadedIn started: Int) {
        guard generation == started else { return }
        loading = nil
        if case EngineFailure.notReady = error { return }
        lastError = (error as? ModelStoreError)?.reason ?? "\(error)"
    }

    /// Fetch the model now and wait for it. For callers that want the download on their own
    /// schedule — a settings button, the probe — rather than as a side effect of `prepare()`.
    public func download() async throws {
        startDownload()
        await downloading?.value
        if let lastError, await !store.isInstalled(variant.bundle) {
            throw EngineFailure.assetsUnavailable("\(variant.bundle.name): \(lastError)")
        }
    }

    private func startDownload() {
        guard downloading == nil else { return }
        let store = self.store
        let bundle = variant.bundle
        downloading = Task {
            do {
                try await store.ensure(bundle)
                self.downloadFinished(nil)
            } catch {
                self.downloadFinished((error as? ModelStoreError)?.reason ?? "\(error)")
            }
        }
    }

    private func downloadFinished(_ failure: String?) {
        downloading = nil
        lastError = failure
        // Load as soon as the weights land, rather than at the next dictation: the first load on
        // a machine also compiles the Neural Engine plan, which is seconds, not milliseconds, and
        // belongs in the background.
        if failure == nil { Task { try? await self.prepare() } }
    }

    /// Give the Core ML state back. Safe at any time: a decode already running holds its own
    /// reference and finishes; the next `prepare()` reloads from the verified directory without
    /// touching the network.
    public func unload() async {
        generation += 1
        loading = nil
        guard let old = manager else { return }
        manager = nil
        await queueTail?.value
        await old.cleanup()
    }

    public func transcribe(_ audio: KotibaCore.AudioBuffer,
                           language: KotibaCore.Language) async throws -> Transcript {
        guard supportedLanguages.contains(language) else {
            throw EngineFailure.languageUnsupported(language, engineID: engineID)
        }
        guard !audio.samples.isEmpty else {
            throw EngineFailure.transcriptionFailed("no audio")
        }
        let text = try await decode(audio.samples, language: language)
        return Transcript(raw: text, language: Self.writtenLanguage(of: text, else: language),
                          engineID: engineID)
    }

    /// Which of its two languages the model actually wrote: whichever script has more letters.
    ///
    /// The routed language is only a guess for this engine — it chooses English or Russian per
    /// token — so the transcript reports what came out, and `DictationSession` takes that over
    /// the acoustic router's en/ru call (a pin still wins there). Majority rather than "any
    /// Cyrillic": Russian speech carrying "deploy" or "pull request" is still Russian. Text with
    /// no letters at all says nothing, and keeps the language it was asked for.
    nonisolated static func writtenLanguage(of text: String,
                                            else requested: KotibaCore.Language)
        -> KotibaCore.Language {
        var latin = 0
        var cyrillic = 0
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x0041...0x005A, 0x0061...0x007A: latin += 1
            case 0x0400...0x04FF: cyrillic += 1
            default: break
            }
        }
        if cyrillic == 0, latin == 0 { return requested }
        return cyrillic > latin ? .russian : .english
    }

    /// A stream per dictation, with its own speech detector: Silero when its model is installed
    /// (the same file the Uzbek stream uses), the energy gate otherwise. Only *when to speculate*
    /// and *whether a speculation may be adopted* depend on it, never what is decoded.
    public func openStream() async -> any TranscriptionStream {
        let classifier: any SpeechFrameClassifier =
            speechDetectorURL.flatMap { SileroSpeechDetector(modelURL: $0) }
            ?? EnergyFrameClassifier()
        return ParakeetStream(engine: self, segmenter: segmenter, classifier: classifier)
    }

    // MARK: Decoding

    /// One decode, serialised behind every other decode on this engine.
    ///
    /// `AsrManager` is an actor, but actors are re-entrant across `await`, and a stream commit
    /// racing the key-up decode would interleave two passes over the same Core ML models and
    /// scratch buffers. Nothing in FluidAudio promises that is safe, so it never happens.
    func decode(_ samples: [Float], language: KotibaCore.Language?) async throws -> String {
        guard let manager else {
            throw EngineFailure.notReady(lastError ?? "prepare() has not run")
        }
        // FluidAudio refuses anything under 0.3 s. A tap of the key is a legitimate dictation
        // of nothing, and silence is what padding adds, so pad rather than throw.
        var input = samples
        if input.count < 16_000 {
            input += [Float](repeating: 0, count: 16_000 - input.count)
        }
        let hint = languageHint ? language.flatMap(Self.hint(for:)) : nil
        let job = input
        return try await serialised {
            var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
            let result = try await manager.transcribe(job, decoderState: &state, language: hint)
            return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    private func serialised<T: Sendable>(
        _ body: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let previous = queueTail
        let job = Task { () async throws -> T in
            await previous?.value
            return try await body()
        }
        queueTail = Task<Void, Never> { _ = try? await job.value }
        do {
            return try await job.value
        } catch {
            throw EngineFailure.transcriptionFailed("\(error)")
        }
    }

    private static func hint(for language: KotibaCore.Language) -> FluidLanguage? {
        switch language {
        case .english: return .english
        case .russian: return .russian
        // Not Parakeet's languages. Parakeet only ever sees them misrouted, and a hint toward
        // one it does not carry would be a hint toward nothing.
        case .uzbek, .turkish, .arabic: return nil
        }
    }
}

// MARK: - Streaming

/// What `ParakeetStream` needs from its engine: one stretch of audio in, text out, on a queue
/// that never runs two decodes at once. `ParakeetEngine` is the production one; Band-1 tests hand
/// the stream a fake so its scheduling — commits, speculations, adoption — is checked without a
/// 632 MB model.
protocol WindowDecoding: Sendable {
    var engineID: String { get }
    func prepare() async throws
    func isReady() async -> Bool
    func decode(_ samples: [Float], language: KotibaCore.Language?) async throws -> String
    func transcribe(_ audio: KotibaCore.AudioBuffer,
                    language: KotibaCore.Language) async throws -> Transcript
}

extension ParakeetEngine: WindowDecoding {}

/// A dictation in progress. Commits whole Parakeet windows while the key is held, so key-up is
/// left with at most one — and decodes what is pending at each pause, so key-up is usually left
/// with nothing at all.
///
/// Every `append` checks whether 14 s have piled up; when they have, `StreamSegmenter` picks the
/// quietest 200 ms between 6 s and 14 s, everything before it is decoded on the engine's queue,
/// and its text is kept. `finish` decodes what is left — from the *finalised* recording, which
/// is authoritative — and joins the pieces.
///
/// **Speculation.** The speaker went quiet for `speculativePause` after saying something new: the
/// pending audio (≤ one window, ~40–60 ms on the Neural Engine) is decoded now. If they let go
/// without saying anything more, `finish` adopts that decode and key-up costs a join; if they
/// carry on, it is kept as the provisional text the session's sentence polish reads
/// (`progress()`), and the next pause replaces it. It never changes *what* is transcribed: it is
/// adopted only when the speech detector heard no speech after it, and the audio it decoded is
/// exactly the pending audio key-up would otherwise decode, minus trailing silence.
///
/// The stream is an optimisation that must never change which audio was transcribed. So
/// `finish` throws the committed text away and decodes the whole recording in batch whenever
/// the two could disagree: a commit failed, the recording lost samples, or it is shorter than
/// what the stream already committed.
actor ParakeetStream: TranscriptionStream {
    private let engine: any WindowDecoding
    private let segmenter: StreamSegmenter
    private var classifier: any SpeechFrameClassifier
    /// Silence after new speech that is worth a speculative decode — the Uzbek stream's 0.2 s.
    /// A Parakeet window decode cannot be aborted, so one started on a breath inside a sentence
    /// still holds the queue for its ~50 ms; at 0.3 s, though, the decode had not landed by a
    /// release 300 ms after the last word in 7 of 16 English dictations (`kotiba-probe e2e`), and
    /// key-up decoded the tail again.
    private let speculativePause: Double
    /// Less speech than this since the last speculation is not worth another.
    private let minimumNewSpeech: Double

    /// Samples not yet committed, starting at `committedSamples` into the recording.
    private var pending: [Float] = []
    private var committedSamples = 0
    private var committedText: [String] = []
    private var inFlight: Task<Void, Never>?
    private var broken = false
    private var cancelled = false
    /// Set first thing in `finish`. From then on nothing starts a window of its own: the commit
    /// that lands while key-up waits used to start the next one (`committed` → `commitIfDue`),
    /// advance `committedSamples` past it and leave `finish` holding a copy of the text without
    /// it — up to 14 s of speech missing from the paste, and nothing said. A speculation landing
    /// during `finish`'s own awaits could do the same.
    private var finishing = false
    /// After the engine could not be prepared, the next commit waits for this many samples to
    /// have been fed. Asking at every 20 ms chunk — which is what an absent engine (not
    /// downloaded, declined, failed) meant — cut the whole backlog out and spliced it back each
    /// time: two copies of the recording per chunk, 2,301 prepares and 42 s of work for a 60 s
    /// hold in the test, which outruns the microphone within minutes and makes key-up wait for
    /// the pump. Once a second still catches an engine that arrives mid-hold.
    private var retryAt = 0

    // Speech tracking, in absolute sample indices.
    private var fed = 0
    private var unclassified: [Float] = []
    private var classifiedUpTo = 0
    private var inSpeech = false
    /// Where the last speech frame ended; 0 before any speech.
    private var lastSpeechEnd = 0
    private var speechSinceSpeculation = 0

    private struct Speculation {
        let start: Int
        let end: Int
        /// `lastSpeechEnd` when it was taken: adopted only if no speech came after.
        let lastSpeech: Int
        let task: Task<String?, Never>
    }
    private var speculation: Speculation?
    /// The newest finished speculation: (start, end, text).
    private var provisional: (start: Int, end: Int, lastSpeech: Int, text: String)?
    private var tail = "none"

    init(engine: any WindowDecoding, segmenter: StreamSegmenter,
         classifier: any SpeechFrameClassifier = EnergyFrameClassifier(),
         speculativePause: Double = 0.2, minimumNewSpeech: Double = 0.3) {
        self.engine = engine
        self.segmenter = segmenter
        var classifier = classifier
        classifier.reset()
        self.classifier = classifier
        self.speculativePause = speculativePause
        self.minimumNewSpeech = minimumNewSpeech
    }

    func append(_ samples: [Float]) async {
        guard !cancelled, !samples.isEmpty else { return }
        pending += samples
        fed += samples.count
        classify(samples)
        commitIfDue()
        speculateIfDue()
    }

    // MARK: Speech frames

    private func classify(_ samples: [Float]) {
        unclassified += samples
        let frame = classifier.frameSamples
        let whole = (unclassified.count / frame) * frame
        guard whole > 0 else { return }
        let probabilities = classifier.probabilities(unclassified[0..<whole])
        unclassified.removeFirst(whole)
        for probability in probabilities {
            // Silero's own hysteresis, as `SpeechSegmenter` uses it.
            let speech = probability >= (inSpeech ? 0.35 : 0.5)
            inSpeech = speech
            classifiedUpTo += frame
            if speech {
                lastSpeechEnd = classifiedUpTo
                speechSinceSpeculation += frame
            }
        }
    }

    private var silence: Int { classifiedUpTo - lastSpeechEnd }

    private func speculateIfDue() {
        let rate = Double(segmenter.sampleRate)
        guard speculation == nil, inFlight == nil, !broken, !cancelled, !finishing,
              lastSpeechEnd > 0,
              Double(speechSinceSpeculation) >= minimumNewSpeech * rate,
              Double(silence) >= speculativePause * rate, !pending.isEmpty else { return }
        speechSinceSpeculation = 0
        let start = committedSamples
        let end = committedSamples + pending.count
        let lastSpeech = lastSpeechEnd
        let piece = pending
        let engine = self.engine
        let task = Task { () -> String? in
            // Never the thing that loads a cold engine, or that waits for one: a speculation is
            // worth having only while it is cheap.
            guard await engine.isReady() else { return nil }
            return try? await engine.decode(piece, language: nil)
        }
        speculation = Speculation(start: start, end: end, lastSpeech: lastSpeech, task: task)
        Task { await self.speculated(start: start, end: end, lastSpeech: lastSpeech, task: task) }
    }

    private func speculated(start: Int, end: Int, lastSpeech: Int, task: Task<String?, Never>) async {
        let text = await task.value
        if speculation?.task == task { speculation = nil }
        if let text, start == committedSamples, (provisional?.end ?? 0) < end {
            provisional = (start, end, lastSpeech, text)
        }
        commitIfDue()
    }

    // MARK: Commits

    private func commitIfDue() {
        guard inFlight == nil, !broken, !cancelled, !finishing, fed >= retryAt,
              let cut = segmenter.cut(pending) else { return }
        let piece = Array(pending[..<cut])
        pending.removeFirst(cut)
        committedSamples += cut
        provisional = nil
        let engine = self.engine
        inFlight = Task {
            // The first commit of a cold engine loads it here — behind the user's speech, which
            // is the cheapest place a load can happen. Not loaded *yet* (downloading, or the
            // first Neural Engine compile) is not a failure: the piece goes back and the next
            // append asks again.
            do {
                try await engine.prepare()
            } catch {
                self.requeue(piece)
                return
            }
            do {
                let text = try await engine.decode(piece, language: nil)
                self.committed(text)
            } catch {
                self.fail()
            }
        }
    }

    private func requeue(_ piece: [Float]) {
        pending = piece + pending
        committedSamples -= piece.count
        inFlight = nil
        retryAt = fed + segmenter.sampleRate
    }

    private func committed(_ text: String) {
        if !text.isEmpty { committedText.append(text) }
        inFlight = nil
        commitIfDue()
    }

    private func fail() {
        broken = true
        inFlight = nil
    }

    // MARK: TranscriptionStream

    func progress() async -> StreamProgress? {
        let committed = committedText.joined(separator: " ")
        let tentative = provisional.flatMap { $0.start == committedSamples ? $0.text : nil } ?? ""
        let text = [committed, tentative].filter { !$0.isEmpty }.joined(separator: " ")
        return StreamProgress(
            committed: committed, provisional: tentative,
            language: text.isEmpty ? nil
                : ParakeetEngine.writtenLanguage(of: text, else: .english),
            speechEnd: provisional.flatMap { $0.start == committedSamples ? $0.lastSpeech : nil }
                ?? 0)
    }

    func settlement() async -> String? { tail }
    func lastSpeechEnd() async -> Int? { lastSpeechEnd }

    func finish(_ audio: KotibaCore.AudioBuffer,
                language: KotibaCore.Language) async throws -> Transcript {
        finishing = true
        // A loop, not one await: a commit that was requeued or is being retried leaves another
        // in its place until `finishing` is seen.
        while let running = inFlight { await running.value }
        // Cancelled — the route went to Uzbek while this was the speculative finish. Batch was
        // the answer to that too (`usable` below is false), which decoded the whole recording on
        // the Neural Engine for nobody and queued the next English dictation's windows behind it.
        if cancelled || Task.isCancelled { throw CancellationError() }
        // Whatever the pump did not get to — the recording is authoritative — is classified too,
        // so "no speech after the speculation" is asked of everything the user said.
        if !cancelled, fed < audio.samples.count, audio.droppedSamples == 0 {
            let rest = Array(audio.samples[fed...])
            pending += rest
            fed += rest.count
            classify(rest)
        }
        try await engine.prepare()
        let usable = !broken && !cancelled && audio.droppedSamples == 0
            && committedSamples <= audio.samples.count && fed == audio.samples.count
        guard usable else {
            tail = "batch"
            return try await engine.transcribe(audio, language: language)
        }
        var parts = committedText

        // A speculation over exactly the pending audio, with no speech after it: that decode is
        // the tail. One still running is waited for — it is the same decode key-up would start.
        var adopted: String?
        if let running = speculation, running.start == committedSamples,
           running.lastSpeech == lastSpeechEnd {
            adopted = await running.task.value
        } else if let done = provisional, done.start == committedSamples,
                  done.lastSpeech == lastSpeechEnd {
            adopted = done.text
        }
        if let adopted {
            tail = "speculation"
            if !adopted.isEmpty { parts.append(adopted) }
        } else if committedSamples == 0 {
            // Nothing committed and nothing to adopt: exactly the batch decode.
            _ = await speculation?.task.value
            tail = "decoded"
            let transcript = try await engine.transcribe(audio, language: language)
            return transcript
        } else {
            _ = await speculation?.task.value
            let rest = audio.samples[committedSamples...]
            // Under 0.3 s of tail is a breath or the key's own click, not speech.
            if rest.count >= segmenter.sampleRate * 3 / 10 {
                tail = "decoded"
                let text = try await engine.decode(Array(rest), language: language)
                if !text.isEmpty { parts.append(text) }
            } else {
                tail = "none"
            }
        }
        let text = parts.joined(separator: " ")
        return Transcript(raw: text,
                          language: ParakeetEngine.writtenLanguage(of: text, else: language),
                          engineID: engine.engineID)
    }

    func cancel() async {
        cancelled = true
        pending.removeAll()
    }
}

/// True for exactly one caller. The two racers in `ParakeetEngine.prepare` resume one
/// continuation, and resuming it twice is a crash.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    func claim() -> Bool {
        lock.withLock {
            defer { claimed = true }
            return !claimed
        }
    }
}
