import Foundation
import KotibaCore

// C2. Uzbek transcribed while the key is still held, so key-release pays only for the tail.
//
// A whole-utterance decode starts at release and costs the full encoder window plus every token
// of the utterance, which is ~430 ms for a 2.8 s phrase and grows with length. This session takes
// the capture stream instead and does three kinds of work behind the speaker:
//
//   * **commit** — `SpeechSegmenter` found a real pause after enough speech. That segment is final
//     and is decoded now, with the text before it carried in as the prompt so a sentence that
//     spans the cut still reads as one.
//   * **speculate** — the speaker went quiet for `speculativePause`. They may be about to let go,
//     so the pending audio is decoded now, provisionally. If they do let go without saying more,
//     that decode *is* the tail and release costs nothing but a join. If they carry on, it is
//     aborted — whisper polls the flag between decoder steps — so it never delays anything.
//   * **tail** — at `finish()`, whatever is left after the last commit, unless a speculation
//     already covers exactly that audio.
//
// It is a `TranscriptionStream` (Contracts.swift), the contract Parakeet's stream already meets,
// so the session pipeline drives both the same way: `StreamingWhisperEngine.openStream()` at
// key-down, `append` from `MicrophoneTake.chunks`, `finish(audio, language:)` at key-up. As that
// contract demands, the finalised recording is authoritative: whatever the stream could not vouch
// for — another language, lost samples, a stream never fed — is decoded in batch instead.
//
// Every decode goes through the owning `WhisperEngine`, which serialises all calls on its one
// context. That is why a speculation is aborted rather than merely ignored: ignored, it would
// still hold the context while the tail waited behind it.
//
// Measured on the 344-clip harness and the replay probe (`kotiba-probe stream`); the numbers and the
// defaults' derivation are in docs/research/C2-uzbek-latency.md.

/// What the session needs from a decoder: one stretch of audio in, text out, abortable.
/// `WhisperEngine` is the production one; tests substitute a fake so the scheduling — order,
/// prompts, adoption, aborts — is checked in Band 1 without a 539 MB model.
public protocol SegmentDecoding: TranscriptionEngine {
    /// False when handing this decoder two different encoder windows would corrupt its cache;
    /// the session then uses the full window for everything rather than risk it.
    func mixesWindowsSafely() async -> Bool
    func decode(_ samples: [Float], language: Language, prompt: String?, beamSize: Int?,
                audioContext: WhisperEngine.AudioContext?,
                abort: WhisperAbort?) async throws -> WhisperEngine.Decode
}

extension WhisperEngine: SegmentDecoding {}

public actor StreamingWhisperSession: TranscriptionStream {

    public struct Configuration: Sendable, Equatable {
        public var segmenter = SpeechSegmenter.Configuration()
        /// The vocabulary hint / style exemplar — `Vocabulary.hint(for:)`, the same string the
        /// batch path sends as `initialPrompt`.
        public var hint: String?
        /// Characters of already-transcribed text carried into each segment's prompt. 0 turns
        /// continuity off, which is the loop-recovery fallback.
        public var carryCharacters = 200
        /// Beam width for commits and speculations, which run while the speaker is still talking
        /// and so cost no felt latency. nil = the engine's own setting.
        public var backgroundBeamSize: Int?
        /// Beam width for a tail decoded after release, which is felt. nil = the engine's own.
        public var tailBeamSize: Int? = 1
        /// Encoder window for the tail and for speculations — the decodes that sit between the
        /// speaker stopping and the text arriving. Fitted is what makes a short tail cheap. The
        /// margin is not negotiable downwards: this fine-tune needs ~5 s of encoded silence after
        /// the speech to find end-of-text, and at margin 0 the harness went from 21.83% to 30.70%
        /// (C2 §3). 256 positions is 5.1 s.
        public var audioContext: WhisperEngine.AudioContext = .fitted(margin: 256)
        /// Encoder window for commits, which run while the speaker is still talking and so cost
        /// no felt latency: the model's full window, the setting it was measured best at.
        public var commitAudioContext: WhisperEngine.AudioContext = .full
        /// Whether to decode provisionally at short pauses.
        public var speculate = true
        /// At release, keep the last finished speculation and decode only what came after it,
        /// rather than the whole uncommitted region. See `prefix`.
        public var cutAtLastPause = true
        /// Release cuts only at a pause at least this long, however soon the pause was decoded.
        /// A pause decode starts at `segmenter.speculativePause` (0.1 s); one that short is often
        /// the closure inside a word, and cutting there cost 0.26 WER points at release on the
        /// last syllable (22.41 % against 22.15, P2 §3), where adopting the same decode whole cost
        /// nothing. With this at 0.2 the cut is where it always was: 22.20 %.
        public var cutPause: Double = 0.2
        /// With no speech detected anywhere, audio peaking at least this loud is decoded whole
        /// anyway rather than returned empty. 0.02 is well under any real dictation on record
        /// (the quietest peaked at 0.05) and well over room tone.
        public var fallbackPeak: Float = 0.02

        public init() {}
    }

    /// What one utterance cost, for diagnostics and the probe.
    public struct Report: Sendable, Equatable {
        public enum Kind: String, Sendable { case commit, speculation, tail }
        public struct Entry: Sendable, Equatable {
            public let kind: Kind
            public let seconds: Double
            public let audioContext: Int
            public let milliseconds: Double
            public let adopted: Bool
            public let retriedWithoutCarry: Bool
            /// Where the decoded audio sits in the utterance, and what it became.
            public var start: Double = 0
            public var text: String = ""
        }
        public var entries: [Entry] = []
        /// Seconds of speech decoded after release. 0 when a speculation covered it or the tail
        /// held no speech.
        public var tailSeconds: Double = 0
        /// How the tail was settled: `none` (no speech), `speculation` (decoded at the pause
        /// before release), `prefix` (a pause decode plus the rest), `decoded` (all of it after
        /// release), `fallback` (no speech detected, decoded whole anyway), or `batch` (the
        /// stream could not vouch for the recording, which was decoded whole instead).
        public var tail: String = "none"
        /// Wall time inside `finish()`.
        public var finishMilliseconds: Double = 0
        public var aborted = 0

        public init() {}

        public func count(_ kind: Kind) -> Int { entries.filter { $0.kind == kind }.count }
        public var adopted: Int { entries.filter(\.adopted).count }
        public var retries: Int { entries.filter(\.retriedWithoutCarry).count }
        /// Decode time spent while the key was still held.
        public var backgroundMilliseconds: Double {
            entries.filter { $0.kind != .tail }.reduce(0) { $0 + $1.milliseconds }
        }
    }

    public nonisolated let language: Language
    private let engine: any SegmentDecoding
    private let configuration: Configuration
    /// Silero in production (`SileroSpeechDetector`), energy when its model is absent. Owned by
    /// this session alone: its state is per-utterance, and dictations can overlap.
    private let detector: any SpeechFrameClassifier

    private var segmenter: SpeechSegmenter
    /// Captured audio from `base` on. Everything before the last commit has already been copied
    /// into a decode job, so it is dropped as the session goes; a ten-minute hold keeps seconds.
    private var samples: [Float] = []
    private var base = 0
    private var texts: [String] = []
    /// The last queued commit job. Commits decode strictly in order, each after the one before,
    /// because each one's prompt is the text of the ones before it.
    private var chain: Task<Void, Never>?
    private var failure: EngineFailure?
    private var speculation: Speculation?
    /// The latest *finished* speculation over the uncommitted region, and what it said. At
    /// release, if the speaker said more after it, the region is cut at that pause: the prefix
    /// text is kept and only the rest is decoded. One cut, at a real pause, only when it pays.
    private var prefix: (span: SpeechSegmenter.Span, text: String)?
    /// Where speech ended before a pause that lasted `cutPause` (the `speech.upperBound` of the
    /// span a pause decode was made of). Only a pause decode ending at one of these is a cut.
    private var cutPoints: Set<Int> = []
    /// Every finished pause decode of the uncommitted region, oldest first. `prefix` is the last
    /// of them; release cuts at the newest one that ends at a cut point, which need not be the
    /// newest — a 0.1 s pause decode after it is shown as progress but is no place to cut.
    private var finishedPauses: [(span: SpeechSegmenter.Span, text: String)] = []
    private var sessionAbort = WhisperAbort()
    /// One stream per dictation: live from `init` until `finish` or `cancel`.
    private var running = true
    /// Whether fitted windows may be used; see `SegmentDecoding.mixesWindowsSafely`. Asked of the
    /// engine at the first decode, not at `init`, so opening a stream never waits on anything.
    private var fittedAllowed: Bool?
    /// Bumped by every `start()` and `cancel()`. A job from an abandoned utterance checks it
    /// before writing, so a cancelled segment can never land in the next dictation.
    private var generation = 0
    public private(set) var report = Report()
    /// Whether routing currently expects Uzbek. While it does not, the session stops paying for
    /// speculation and defers its commits — the audio of each is kept, and decoded the moment the
    /// route comes back or at `finish` if it does. See `setLikely(_:)`.
    private var likely = true
    private var deferred: [(span: SpeechSegmenter.Span, audio: [Float])] = []

    private struct Speculation {
        let span: SpeechSegmenter.Span
        let task: Task<String?, Never>
        let abort: WhisperAbort
    }

    /// One session per dictation. Overlapping dictations each get their own; what they share is
    /// the engine, whose single whisper context serialises every decode through `inFlight`.
    public init(engine: any SegmentDecoding, language: Language = .uzbek,
                configuration: Configuration = Configuration(),
                speechDetector: any SpeechFrameClassifier = EnergyFrameClassifier()) {
        self.engine = engine
        self.language = language
        self.configuration = configuration
        self.detector = speechDetector
        self.segmenter = SpeechSegmenter(configuration: configuration.segmenter,
                                         classifier: speechDetector)
    }

    // MARK: TranscriptionStream

    /// Cheap: segmentation only. The first decode it triggers loads the model if it is cold —
    /// behind the speaker, the cheapest place a load can happen.
    public func append(_ chunk: [Float]) async {
        guard running, !chunk.isEmpty else { return }
        samples.append(contentsOf: chunk)
        for event in segmenter.append(chunk) {
            switch event {
            case .commit(let span): enqueueCommit(span)
            case .pause(let span): speculate(span)
            }
        }
        if let speculation, segmenter.lastSpeechEnd <= speculation.span.speech.upperBound,
           segmenter.sampleCount - segmenter.lastSpeechEnd
               >= Int(configuration.cutPause * Double(AudioBuffer.sampleRate)) {
            cutPoints.insert(speculation.span.speech.upperBound)
        }
        // A speculation is *not* aborted when the speaker carries on. It is still a correct decode
        // of everything up to that pause, and once it finishes it becomes `prefix`: at release
        // only the audio after it needs decoding. Only a newer pause supersedes it (`speculate`).
        dropCommittedAudio()
    }

    /// Key-up. `audio` is the finalised recording and is authoritative.
    ///
    /// The stream is used only when it saw a prefix of exactly this recording in the language it
    /// was opened for; anything it has not seen yet is appended first. Otherwise — routed to
    /// another language, samples dropped, never fed, or fed more than the recording holds — the
    /// work is discarded and `audio` is decoded in batch, so the stream can change *when* the text
    /// arrives but never *which audio* it describes. A segment that failed to decode also falls
    /// back to batch rather than pasting a transcript with a hole in it.
    public func finish(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        guard running else { throw EngineFailure.transcriptionFailed("stream already finished") }
        let fed = segmenter.sampleCount
        guard language == self.language, audio.droppedSamples == 0, fed > 0,
              fed <= audio.samples.count else {
            discard()
            report.tail = "batch"
            return try await engine.transcribe(audio, language: language)
        }
        if fed < audio.samples.count {
            await append(Array(audio.samples[fed...]))
        }
        running = false
        let clock = ContinuousClock.now
        defer { report.finishMilliseconds = Self.ms(ContinuousClock.now - clock) }
        // The route came back to Uzbek after the session had stood down: whatever it deferred
        // is decoded now, in order, ahead of the tail.
        flushDeferred()

        if let tail = segmenter.tail() {
            report.tailSeconds = Double(tail.speech.count) / Double(AudioBuffer.sampleRate)
            if let speculation, speculation.span.speech == tail.speech {
                // The speaker stopped, waited, and let go: the tail was decoded while they waited.
                self.speculation = nil
                await chain?.value
                if let text = await speculation.task.value {
                    report.tail = "speculation"
                    texts.append(text)
                    report.tailSeconds = 0
                } else {
                    // The pause decode failed (nothing aborts the current one but a newer pause,
                    // a commit or standing down, and each of those clears it first). `?? ""` here
                    // pasted the commits with the last sentence missing, or reported a spoken
                    // dictation as heard-nothing: the tail is decoded after all.
                    report.tail = "decoded"
                    texts.append(await decodeTail(tail.speech) ?? "")
                }
            } else {
                if let speculation {
                    speculation.abort.raise()
                    report.aborted += 1
                }
                speculation = nil
                await chain?.value
                let cutAnywhere = configuration.cutPause <= configuration.segmenter.speculativePause
                if configuration.cutAtLastPause,
                   let prefix = finishedPauses.last(where: {
                       cutAnywhere || cutPoints.contains($0.span.speech.upperBound)
                   }),
                   prefix.span.region.lowerBound == tail.region.lowerBound,
                   prefix.span.speech.lowerBound == tail.speech.lowerBound,
                   tail.speech.upperBound - prefix.span.speech.upperBound
                       >= AudioBuffer.sampleRate / 4 {
                    // A pause of `cutPause`, and at least a quarter-second more after it, or the
                    // "rest" is a sliver of silence that whisper answers by repeating its prompt —
                    // measured: 22% → 39% WER on the harness before this guard.
                    // The speaker paused, the pause was decoded, then they said more and let go
                    // without pausing again. Keep what the pause decode said; decode the rest.
                    report.tail = "prefix"
                    texts.append(prefix.text)
                    let rest = prefix.span.speech.upperBound..<tail.speech.upperBound
                    report.tailSeconds = Double(rest.count) / Double(AudioBuffer.sampleRate)
                    texts.append(await decodeTail(rest) ?? "")
                } else {
                    report.tail = "decoded"
                    texts.append(await decodeTail(tail.speech) ?? "")
                }
            }
        } else {
            speculation?.abort.raise()
            speculation = nil
            await chain?.value
            // The detector heard no speech anywhere, yet something audible was recorded. Silero
            // says "not speech" to singing and to speech under loud music — measured on the
            // harness, one clip came back empty where the whole-utterance decode had words. An
            // empty paste after the user spoke is the "it forgot what I said" bug, so the audio
            // goes to the model whole and whisper's own no-speech gate has the last word.
            if SegmentText.join(texts).isEmpty, samples.count >= AudioBuffer.sampleRate / 2,
               samples.reduce(Float(0), { max($0, abs($1)) }) >= configuration.fallbackPeak {
                report.tail = "fallback"
                report.tailSeconds = Double(samples.count) / Double(AudioBuffer.sampleRate)
                texts.append(await decodeTail(base..<(base + samples.count)) ?? "")
            }
        }

        if failure != nil {
            discard()
            report.tail = "batch"
            return try await engine.transcribe(audio, language: language)
        }
        return Transcript(raw: SegmentText.join(texts), language: language,
                          engineID: engine.engineID)
    }

    /// Samples appended so far.
    public var samplesReceived: Int { segmenter.sampleCount }

    /// Committed segments, and the newest finished pause decode of what came after them.
    public func progress() async -> StreamProgress? {
        StreamProgress(committed: SegmentText.join(texts), provisional: prefix?.text ?? "",
                       language: language, speechEnd: prefix?.span.speech.upperBound ?? 0)
    }

    /// Stand down (or back up). Standing down aborts a running speculation and defers commits;
    /// standing up decodes what was deferred, and the next pause speculates as usual.
    public func setLikely(_ likely: Bool) async {
        guard running, likely != self.likely else { return }
        self.likely = likely
        if likely {
            flushDeferred()
        } else if let speculation {
            speculation.abort.raise()
            report.aborted += 1
            self.speculation = nil
        }
    }

    public func settlement() async -> String? { report.tail }
    public func lastSpeechEnd() async -> Int? { segmenter.lastSpeechEnd }

    private func flushDeferred() {
        let pending = deferred
        deferred.removeAll()
        for (span, audio) in pending { enqueueCommit(span, audio: audio) }
    }

    public func cancel() async {
        discard()
    }

    /// Waits until no commit or speculation is decoding. For the replay probe's accelerated mode,
    /// which models "the machine kept up with the speaker" by letting background work finish
    /// before the next chunk arrives; the pipeline never needs it.
    public func settled() async {
        await chain?.value
        _ = await speculation?.task.value
    }

    // MARK: Work behind the speaker

    private func enqueueCommit(_ span: SpeechSegmenter.Span) {
        let audio = slice(span.speech)
        guard likely else {
            // Routing says this is not Uzbek right now. A 20 s commit is ~1 s of GPU the
            // English dictation beside it would wait on, so it waits instead — with its audio
            // copied, because `dropCommittedAudio` is about to let go of it.
            speculation?.abort.raise()
            speculation = nil
            prefix = nil
            finishedPauses = []
            deferred.append((span, audio))
            return
        }
        enqueueCommit(span, audio: audio)
    }

    private func enqueueCommit(_ span: SpeechSegmenter.Span, audio: [Float]) {
        // A speculation over exactly this audio is this commit's decode, already done or under way.
        var adopted: Task<String?, Never>?
        if let speculation {
            if speculation.span.speech == span.speech {
                adopted = speculation.task
            } else {
                speculation.abort.raise()
                report.aborted += 1
            }
            self.speculation = nil
        }
        prefix = nil   // the region it described has just been committed
        finishedPauses = []
        let previous = chain
        let abort = sessionAbort
        let seconds = Double(audio.count) / Double(AudioBuffer.sampleRate)
        let start = Self.seconds(span.speech.lowerBound)
        let generation = self.generation
        chain = Task {
            await previous?.value
            if let adopted, let text = await adopted.value {
                guard self.generation == generation else { return }
                self.texts.append(text)
                self.report.entries.append(.init(kind: .commit, seconds: seconds, audioContext: 0,
                                                 milliseconds: 0, adopted: true,
                                                 retriedWithoutCarry: false))
                return
            }
            guard !abort.isRaised else { return }
            var text = await self.decodeGuarded(audio, kind: .commit,
                                                beam: self.configuration.backgroundBeamSize,
                                                abort: abort, start: start)
            // One retry for a real failure, never for an abort: a lost segment is the "it forgot
            // what I said" bug, and it is worse than a slow one.
            if text == nil, !abort.isRaised {
                text = await self.decodeGuarded(audio, kind: .commit,
                                                beam: self.configuration.backgroundBeamSize,
                                                abort: abort, start: start)
                if text == nil, self.generation == generation {
                    self.failure = .transcriptionFailed(
                        "a \(String(format: "%.1f", seconds)) s segment failed to decode twice")
                }
            }
            guard self.generation == generation else { return }
            self.texts.append(text ?? "")
        }
    }

    private func speculate(_ span: SpeechSegmenter.Span) {
        guard configuration.speculate, likely else { return }
        if let speculation {
            if speculation.span.speech == span.speech { return }
            speculation.abort.raise()
            report.aborted += 1
        }
        let audio = slice(span.speech)
        let start = Self.seconds(span.speech.lowerBound)
        let abort = WhisperAbort()
        let previous = chain
        let generation = self.generation
        let task = Task { () -> String? in
            await previous?.value
            guard !abort.isRaised else { return nil }
            let text = await self.decodeGuarded(audio, kind: .speculation,
                                                beam: self.configuration.backgroundBeamSize,
                                                abort: abort, start: start)
            // Finished and still about the uncommitted region: it is the newest prefix.
            if let text, !abort.isRaised, self.generation == generation,
               span.region.lowerBound == self.segmenter.committedUpTo,
               (self.prefix?.span.speech.upperBound ?? 0) < span.speech.upperBound {
                self.prefix = (span, text)
                self.finishedPauses.append((span, text))
            }
            return text
        }
        speculation = Speculation(span: span, task: task, abort: abort)
    }

    /// The tail, after release: one retry, as a commit gets, and then `failure`, so `finish`
    /// sends the recording to batch. Every tail path used to paste `text ?? ""` — the contract
    /// above ("a segment that failed to decode also falls back to batch rather than pasting a
    /// transcript with a hole in it") held for commits and not for the one segment every
    /// dictation has.
    private func decodeTail(_ range: Range<Int>) async -> String? {
        let audio = slice(range)
        for _ in 0..<2 {
            if let text = await decodeGuarded(audio, kind: .tail, beam: configuration.tailBeamSize,
                                              abort: nil, start: Self.seconds(range.lowerBound)) {
                return text
            }
        }
        let seconds = String(format: "%.1f", Self.seconds(range.count))
        failure = .transcriptionFailed("the last \(seconds) s failed to decode twice")
        return nil
    }

    /// One decode with the running text as prompt, re-run without it if the result looks like
    /// the decoder looping on its own prompt. nil means it failed or was aborted.
    private func decodeGuarded(_ audio: [Float], kind: Report.Kind, beam: Int?,
                               abort: WhisperAbort?, start: Double = 0) async -> String? {
        let previous = SegmentText.join(texts)
        let prompt = SegmentText.prompt(hint: configuration.hint, previous: previous,
                                        carry: configuration.carryCharacters)
        let seconds = Double(audio.count) / Double(AudioBuffer.sampleRate)
        if fittedAllowed == nil { fittedAllowed = await engine.mixesWindowsSafely() }
        do {
            let window = fittedAllowed != true ? .full
                : kind == .commit ? configuration.commitAudioContext : configuration.audioContext
            var decode = try await engine.decode(audio, language: language, prompt: prompt,
                                                 beamSize: beam, audioContext: window,
                                                 abort: abort)
            var retried = false
            if !previous.isEmpty, SegmentText.looksLikeALoop(decode.text, previous: previous) {
                let bare = SegmentText.prompt(hint: configuration.hint, previous: "", carry: 0)
                let again = try await engine.decode(audio, language: language, prompt: bare,
                                                    beamSize: beam, audioContext: window,
                                                    abort: abort)
                decode = WhisperEngine.Decode(text: again.text, audioContext: again.audioContext,
                                              milliseconds: decode.milliseconds
                                                + again.milliseconds)
                retried = true
            }
            report.entries.append(.init(kind: kind, seconds: seconds,
                                        audioContext: decode.audioContext,
                                        milliseconds: decode.milliseconds, adopted: false,
                                        retriedWithoutCarry: retried, start: start,
                                        text: decode.text))
            return decode.text
        } catch {
            return nil
        }
    }

    // MARK: Buffer

    private func slice(_ range: Range<Int>) -> [Float] {
        let lower = max(range.lowerBound - base, 0)
        let upper = min(range.upperBound - base, samples.count)
        guard lower < upper else { return [] }
        return Array(samples[lower..<upper])
    }

    private func dropCommittedAudio() {
        // Keep everything a pending speculation might still need; it copied its audio, but a
        // later commit adopting it is matched by span, not by samples, so this is only memory.
        let keepFrom = segmenter.committedUpTo
        let drop = keepFrom - base
        guard drop > AudioBuffer.sampleRate * 5 else { return }   // amortise the copy
        samples.removeFirst(drop)
        base = keepFrom
    }

    private func discard() {
        generation += 1
        sessionAbort.raise()
        speculation?.abort.raise()
        speculation = nil
        prefix = nil
        finishedPauses = []
        sessionAbort = WhisperAbort()
        chain = nil
        failure = nil
        texts = []
        samples = []
        base = 0
        segmenter = SpeechSegmenter(configuration: configuration.segmenter, classifier: detector)
        report = Report()
        deferred = []
        cutPoints = []
        likely = true
        running = false
    }

    private static func seconds(_ sample: Int) -> Double {
        Double(sample) / Double(AudioBuffer.sampleRate)
    }

    private static func ms(_ duration: Duration) -> Double {
        Double(duration.components.seconds) * 1000
            + Double(duration.components.attoseconds) / 1e15
    }
}

// MARK: - The engine the pipeline holds

/// A `WhisperEngine`, able to stream: the Uzbek family's slot, and Turkish's (turbo, D-11).
///
/// A wrapper rather than a conformance on `WhisperEngine` itself, because `CompositeEngine` and
/// `DictationSession` pick "the first member that can stream" — and the same `WhisperEngine` type
/// also serves Russian, where nothing here was measured. Batch calls pass straight through, so
/// the slot behaves exactly as before for every caller that does not stream.
public struct StreamingWhisperEngine: StreamingTranscriptionEngine {
    public let whisper: WhisperEngine
    public let language: Language
    public let configuration: StreamingWhisperSession.Configuration
    /// `ggml-silero-v6.2.0.bin`, if installed. Absent, each stream uses the energy gate.
    public let speechDetectorURL: URL?

    public var engineID: String { whisper.engineID }
    public var supportedLanguages: Set<Language> { whisper.supportedLanguages }

    /// `whisper` should be built with `flashAttention: false`; with it on, every stream decodes
    /// with the full window (correct, but the tail loses its ~3× encoder saving — C2 §3).
    public init(whisper: WhisperEngine, language: Language = .uzbek,
                configuration: StreamingWhisperSession.Configuration = .init(),
                speechDetectorURL: URL?) {
        self.whisper = whisper
        self.language = language
        self.configuration = configuration
        self.speechDetectorURL = speechDetectorURL
    }

    public func isReady() async -> Bool { await whisper.isReady() }
    public func prepare() async throws { try await whisper.prepare() }
    public func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        try await whisper.transcribe(audio, language: language)
    }

    /// A fresh session per dictation, with its own Silero state. Never blocks on the model: the
    /// first decode loads it if it is cold. The hint defaults to the engine's own `initialPrompt`,
    /// which is where the pipeline already puts `Vocabulary.hint(for:)`.
    public func openStream() async -> any TranscriptionStream {
        var configuration = self.configuration
        if configuration.hint == nil { configuration.hint = await whisper.prompt(for: language) }
        let detector: any SpeechFrameClassifier =
            speechDetectorURL.flatMap { SileroSpeechDetector(modelURL: $0) }
            ?? EnergyFrameClassifier()
        return StreamingWhisperSession(engine: whisper, language: language,
                                       configuration: configuration, speechDetector: detector)
    }
}
