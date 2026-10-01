import Foundation

// The state machine, and the record it leaves behind. Tasks C-06 and C-07.
//
// Two rules are structural here rather than conventional, because the previous build broke
// both and the breakage was invisible for weeks:
//
//   1. The raw transcript is inserted BEFORE polish runs. Polish then replaces it in place.
//      Polish is 4–18x the cost of the transcription it polishes; putting it in front of the
//      insertion is the single largest self-inflicted latency error available.
//   2. Nothing fails silently. Every terminal state is either .done, .heardNothing or
//      .failed(_) — there is no path that produces an empty string and calls it success.

// MARK: - States

public enum SessionState: Sendable, Equatable {
    case idle
    case arming
    case capturing
    case finalising
    case routing
    case transcribing
    case inserting
    /// The text is already in the user's app by now. This stage cannot fail the session.
    case polishing
    case done
    /// Not a failure and not a success: the microphone was open and nothing was said.
    case heardNothing
    case failed(SessionFailure)
}

public enum SessionFailure: Sendable, Equatable, Codable {
    case armingFailed(String)
    case captureFailed(String)
    /// Routing chose a language whose engine could not be made ready.
    ///
    /// Carries the language as well as the family because the family cannot identify the problem:
    /// `.unified` covers both English and Russian, so a failure carrying only the family left the
    /// UI to guess, and it guessed English every time — a missing Russian model was reported as
    /// "The English engine is not ready yet."
    case noEngineReady(EngineFamily, Language)
    case transcriptionFailed(String)
    case insertionRefused(String)
    case insertionTimedOut
}

// MARK: - The record

/// One record per dictation, appended to `diagnostics.json`. On iOS this is the only channel:
/// `log stream` has no device option, and `devicectl` will not attach to a process's stdout.
public struct DictationRecord: Sendable, Codable, Equatable {
    public var startedAt: Date
    public var audioSeconds: Double = 0
    public var peakAmplitude: Float = 0

    /// Wall-clock per stage. Every stage that ran appears here; a missing stage means it did
    /// not run, which is itself the answer to most "why was that slow" questions.
    public var stageMillis: [String: Double] = [:]

    public var route: RouteDecision?
    public var engineID: String?

    /// The three persisted text stages, exactly as a commercial dictation app persists them.
    public var raw: String?
    public var result: String?
    public var polished: String?

    /// Which mode ran, and which polisher. Absent from the first version of this record, and
    /// their absence turned "all my modes do the same thing" into a forensic exercise: the
    /// polish stage was plainly running and plainly being discarded, and nothing said by whom.
    public var modeKey: String?
    public var polishID: String?

    public var outcome: String = "incomplete"
    public var errors: [String] = []

    /// Key-up to the insertion returning, wall clock. The stages above are waited on one after
    /// another and sum to nearly this, but not exactly — the release-time language detection
    /// runs *beside* the stream's finish — and nothing in `stageMillis` covers the controller's
    /// own work between key-up and `finish`. This is the number the owner's ≤ 200 ms target is
    /// about. Absent from records written before it existed.
    public var releaseToInsertMillis: Double?
    /// How the streaming transcriber settled key-up — `speculation`, `prefix`, `decoded`,
    /// `none`, `fallback` or `batch` (`TranscriptionStream.settlement()`). Nil when no stream
    /// answered. Which of these a real dictation hits is the owner's release habit, measured
    /// rather than assumed (C2 §12.4).
    public var tail: String?
    /// Sentences the mode polished while the key was still held; the rest were the tail. Nil
    /// when the mode was not polished that way.
    public var liveSentences: Int?
    /// Language detections made during the hold, and what the last one said.
    public var earlyRoute: RouteDecision?
    public var earlyRouteSeconds: Double?
    /// Parakeet's transcript doubted its route (`TranscriptCheck.Doubt`), whatever came of it —
    /// written even when the Uzbek engine's answer read as English and Parakeet's stood, so the
    /// rule's real firing rate is in the owner's diagnostics rather than assumed. Nil when the
    /// check did not run or found nothing.
    public var unifiedDoubt: String?
    /// Milliseconds key-up spent waiting for `TurkishCheck` — nil when it did not wait (no
    /// Turkish candidate, or the check had already heard everything during the hold).
    public var turkishCheckWaitMillis: Double?
    /// The microphone this take was recorded from: name, transport, hardware rate, and whether
    /// Kotiba overrode the system default (the Bluetooth rule). Optional — absent from records
    /// written before it existed and from sources that do not know (a WAV file) — and ignored by
    /// every reader that does not want it. The name never reaches the plain-text summary.
    public var inputDevice: InputDeviceInfo?

    public init(startedAt: Date) { self.startedAt = startedAt }
}

// MARK: - Session

public actor DictationSession {
    public struct Config: Sendable {
        /// Peak amplitude below this is treated as silence. The previous build used the same
        /// value but delivered an empty transcript instead of saying so.
        public var silenceThreshold: Float = 0.012
        /// Hard ceiling on polish. On expiry the raw transcript stands, untouched.
        public var polishDeadline: Duration = .seconds(8)
        /// Hard ceiling on step 4b's second transcription. Generous next to the measured Uzbek
        /// pass — 437–828 ms on the eval clips, and a minute-long dictation costs more — but it is
        /// a ceiling rather than nothing, and the first transcript stands when it is hit.
        public var rerouteDeadline: Duration = .seconds(10)
        /// …or this much per second of audio, whichever is longer. A fixed ceiling is right
        /// for a phrase and wrong for a minute: a second pass over a long recording cannot finish
        /// in 10 s, so the misroute it exists to undo stood every time — and the pass itself was
        /// not stopped (`transcribe` has no abort), so it went on holding the engine's one
        /// context for the dictations after it. 0.5 s per second is ~3x whisper-medium's
        /// measured rate on this Mac (C2: 437–828 ms for the few-second eval clips).
        public var rerouteDeadlinePerSecond: Double = 0.5
        public var defaultLanguage: Language = .english
        /// The dictation languages that are on (`LanguageSubset`). Nothing outside it is routed
        /// to — not by the router (the controller gives it the same set), and not by any
        /// recovery after transcription (4a, 4a″, 4a′, 4b, 4c ask `permits`). With one language
        /// on, or English and Russian alone, the hold detects nothing and key-up routes there
        /// for free (`fixedRoute`), like a pin that recoveries may still move within the set.
        public var languages: LanguageSubset = .all
        /// Language detection while the key is held; nil turns it off (then both families'
        /// streams run for the whole hold and nothing is polished before key-up).
        public var earlyRouting: EarlyRouting? = EarlyRouting()
        /// How long key-up waits for the sentence still being polished when the rest was
        /// polished during the hold. `IncrementalPolish` delivers anything later as spoken.
        public var liveTailDeadline: Duration = .milliseconds(1500)
        /// Prime the sentence still being spoken as well as the finished ones, at every pause.
        /// Most pauses before a release are the end of that sentence; the rest cost GPU time
        /// during the hold, where it is free on English and Russian (Parakeet is on the Neural
        /// Engine) and competes with the Uzbek pause decodes on Uzbek.
        public var primeLastSentence = true
        /// While the hold is being spent on Uzbek: detect at the pause, and prime the polish.
        /// Both put work on the GPU beside the Uzbek pause decode that key-up waits for.
        public var detectAtPauseOnUzbek = true
        public var primeOnUzbek = true
        /// Prime the unfinished last sentence on Arabic too, though Cohere decodes on the GPU.
        /// Measured end to end (C4 §14.4, 20 FLEURS clips, Gemma 4 E2B): no gain — Super 544
        /// against 519 ms p50 without, Message 561 against 541 — because the release comes before
        /// Cohere's pause decode has even landed, so there is nothing yet to prime. Off.
        public var primeLastOnArabic = false
        /// A `TurkishCheck` verdict of "Turkish" made during the hold is trusted at key-up once
        /// it has heard this much, whatever came after — the way `EarlyRouting.trustUzbekAfter`
        /// trusts an early Uzbek. A verdict of "Uzbek", or a shorter one, is asked again at key-up
        /// unless it heard every word.
        ///
        /// Measured with the fitted head window (C4 §13, `kotiba-probe head`, fit:0) over the
        /// 200 FLEURS Turkish clips and the 83 Uzbek clips whisper base hears as ≥ 0.8 Turkish:
        ///
        ///     first     Turkish ≥ 0.99   highest Uzbek of ≥ 5 s
        ///     5 s       189/198          0.985
        ///     6 s       189/198          0.894
        ///     7 s       197/198          0.846
        ///     8 s       195/198          0.909
        ///
        /// 5 s is too close to 0.99 to trust; from 6 s no Uzbek clip comes within 0.09 of it.
        /// (Over the full 30 s window the same Uzbek clip scored 0.991 at 5 s, which is why this
        /// was 8.) At 6 s the first check the session asks is already trusted, so a 7–10 s Turkish
        /// dictation let go on its last syllable no longer waits for one over the whole recording.
        public var trustTurkishCheckAfter: Double = 6
        /// Another Turkish check during the hold once this much more audio has arrived.
        public var turkishCheckEvery: Double = 2
        /// Whether this user has dictated Turkish before (`AppSettings.turkishDictations` > 0):
        /// `TurkishCheck` asks more of the first one (`TurkishCheck.verifiedFromUnfamiliar`).
        public var turkishFamiliar = false
        /// Key-up's own check reads up to this long after the stream's last speech, not the
        /// whole recording (`turkishPosterior`).
        public var turkishCheckAfterSpeech: Double = 0.3
        /// Whether this user has dictated Arabic before (`AppSettings.arabicDictations` > 0):
        /// `ArabicCheck` asks more of the first one (`ArabicCheck.verifiedFromUnfamiliar`).
        public var arabicFamiliar = false
        /// While Turkish is on, an early "Uzbek" with a `tr` share at least this is not trusted as
        /// the route of a recording at least `turkishMinimumSeconds` long (the router's floor) —
        /// see `detectionThatHeardEverything`. A prefix is a poor witness of the whole clip's
        /// share: over FLEURS Turkish at 5 s (whisper base, mass ≥ 0.3) the lowest was 0.325, the
        /// 10th percentile 0.88, while the whole clip was a candidate (≥ 0.9). Under 0.3 no
        /// Turkish clip was left on Uzbek; 80 % of Uzbek prefixes are above it and are detected
        /// again at key-up — only when Turkish is on, and only past 5 s.
        public var turkishDoubtShare: Double = 0.3
        public var turkishMinimumSeconds: Double = OptionalLanguageRules.defaultTurkishMinimumSeconds
        public init() {}
    }

    /// When to ask the language detector during the hold, and what to do with the answer.
    ///
    /// Measured with `kotiba-probe detect --prefixes` (whisper base q5_1, cluster mass ≥ 0.05) over
    /// the 344-clip Uzbek harness and 200 + 200 FLEURS en/ru clips, 2026-09-30:
    ///
    ///     audio seen   Uzbek recall   en / ru called Uzbek   agrees with the whole clip (uz)
    ///     1 s          52.3 %         1.5 / 6.0 %            59.6 %
    ///     2 s          73.5 %         0.0 / 4.0 %            83.1 %
    ///     3 s          77.3 %         0.5 / 1.5 %            87.5 %
    ///     5 s          77.3 %         0.0 / 0.0 %            92.7 %
    ///     8 s          82.8 %         0.0 / 0.0 %            97.1 %
    ///     whole clip   84.0 %         0.0 / 0.0 %            —
    ///
    /// So an early answer is good enough to decide *where to spend work* during the hold, and
    /// not good enough to decide the route: the route is still taken from the whole recording
    /// at key-up (`detectAtRelease`), which is today's accuracy exactly, and that detection
    /// (~35 ms) runs beside the likely stream's finish rather than in front of it.
    public struct EarlyRouting: Sendable, Equatable {
        /// First detection once this much audio has been captured.
        public var first: Double = 3
        /// …or at a pause, once this much has. A short dictation (half of the Uzbek harness is
        /// under 3 s) is otherwise detected only at key-up, on the GPU beside its own tail decode;
        /// detected at the pause before a release it has heard every word, and key-up asks
        /// nothing (`detectionThatHeardEverything`).
        public var firstAtPause: Double = 1
        /// Silence after speech that counts as a pause for detection. Under the 0.3 s most
        /// releases come after, over the gaps inside a word.
        public var pauseForDetection: Double = 0.15
        /// An early "Uzbek" this confident, over at least `trustUzbekAfter` seconds, is the route:
        /// key-up does not detect again. Measured over the harness (`kotiba-probe detect
        /// --prefixes`): at 4 s and a Turkic mass ≥ 0.3, 0 of 400 English and Russian clips and
        /// 1 of 89 Uzbek ones changed their answer with the rest of the audio — and that one was
        /// an Uzbek clip the whole-clip detection would have *mis*-routed. Worth ~140 ms on
        /// Uzbek, where the release-time detection shares the GPU with the Uzbek tail decode.
        public var trustUzbekMass: Double = 0.3
        public var trustUzbekAfter: Double = 4
        /// Then again every this much more, so the latest answer covers most of the hold.
        public var every: Double = 3
        /// The detector reads 30 s; nothing after that is news to it.
        public var through: Double = 30
        /// The Uzbek stream stops its speculative work only when the Turkic mass is this far
        /// under the routing threshold. At 3 s, < 0.01 stood down 98 % of English and 92 % of
        /// Russian clips and 2.4 % of the Uzbek ones (which the next detection stands back up).
        public var standDownBelow: Double = 0.01
        /// Take the route from the whole recording at key-up. Off, the last detection during
        /// the hold decides — 82.6 % Uzbek recall against 84.0 % on the harness, for ~35 ms.
        public var detectAtRelease = true
        public init() {}
    }

    /// A built-in mode's sentence-by-sentence polish, run while the key is held.
    public struct LivePolish: Sendable {
        public var behaviour: ModeBehaviour
        public var engine: (any PolishEngine)?
        public init(behaviour: ModeBehaviour, engine: (any PolishEngine)?) {
            self.behaviour = behaviour
            self.engine = engine
        }
    }

    /// Full scale. A peak at or above it means the signal reached the rail — but see
    /// `flatteningFraction` for whether that actually cost anything.
    static let clippingThreshold: Float = 0.99

    /// The share of samples sitting at the rail above which flattening measurably hurts.
    ///
    /// Derived from measurement rather than chosen. On the 344-clip Uzbek set, flattening costs
    /// nothing up to about 1% of samples (25.20% against a 25.19% baseline), 1.58 points at 8.3%
    /// and 8.35 points at 28.6% — so the curve is flat and then steep, and 2% sits just above the
    /// highest measured no-op and well below the lowest measured harm.
    static let flatteningFraction = 0.02

    /// Whether step 4b's second transcript is worth putting in front of the first.
    ///
    /// "Not empty" is not the bar. An Uzbek-only fine-tune handed Russian audio is the most likely
    /// source of a repetition loop or a bare marker token there is, and `WhisperEngine` builds its
    /// result by concatenating segment text with no marker filtering — so `[BLANK_AUDIO]` reaches
    /// here as literal text. Pasting that over a correct Russian transcript is worse than the
    /// mis-route this is trying to undo, so the replacement has to earn its place.
    public static func isUsableRerun(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        // whisper's own bracketed markers, in either bracket style. A transcript that is nothing
        // but markers carries no words.
        let withoutMarkers = trimmed
            .replacingOccurrences(of: "\\[[^\\]]*\\]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\([^)]*\\)", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !withoutMarkers.isEmpty else { return false }

        // The Uzbek engine's vocabulary holds zero Cyrillic tokens, so Cyrillic out of it is not a
        // second opinion — it is a broken one, and certainly not evidence against the first.
        guard ScriptCheck.script(of: withoutMarkers) != .cyrillic else { return false }

        // A repetition loop. Six of the same word in a row is not a sentence in any of the three
        // languages, and it is what a mismatched model does when it has nothing to say.
        let words = withoutMarkers.lowercased()
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "\u{02BB}" })
        var run = 1
        for (previous, current) in zip(words, words.dropFirst()) {
            run = previous == current ? run + 1 : 1
            if run >= 6 { return false }
        }
        return true
    }

    public private(set) var state: SessionState = .idle
    /// Every transition, in order. Tests assert on this; the HUD renders the last element.
    public private(set) var transitions: [SessionState] = []

    private let audio: AudioSource
    private let router: any LanguageRouter
    private let engines: [EngineFamily: any TranscriptionEngine]
    private let sink: any TextSink
    private let polisher: (any PolishEngine)?
    private let normalise: @Sendable (String, Language) -> String
    private let config: Config
    private let now: @Sendable () -> Date

    private var record: DictationRecord?
    private var armedAt: Date?

    /// Each engine family's stream for this dictation, fed from the microphone while the key is
    /// held. See `openLiveStreams()`. Empty when nothing can stream — then key-up is batch,
    /// exactly as before.
    private var liveStreams: [EngineFamily: any TranscriptionStream] = [:]
    private var livePump: Task<Void, Never>?

    /// The pin as the controller knew it at key-down. `finish(pin:)` is still authoritative.
    private let expectedPin: Language?
    /// The route known at key-down: the pin, or the one route the enabled languages leave
    /// (`LanguageSubset.soleRoute`). Either way only that family streams and nothing is detected.
    private let fixedRoute: Language?
    /// `fixedRoute` when it names the language, not only the family (English + Russian name
    /// only Parakeet: the language is Parakeet's to say).
    private let fixedLanguage: Language?
    private let livePolishPlan: LivePolish?
    /// turbo's language head, for a Turkish or Arabic candidate (`TurkishCheck`, `ArabicCheck`,
    /// D-11). Nil unless Turkish or Arabic is on and turbo is on disk.
    private let languageHead: (any AcousticClassifier)?
    /// The head's check started during the hold, and what it is hearing; then its verdict. One
    /// posterior answers either candidate — the rule applied to it is the candidate's.
    private var turkishCheck: (task: Task<[String: Double], Never>, coverage: Int)?
    private var turkishVerdict: (posterior: [String: Double], coverage: Int)?

    // Early routing, during the hold.
    private var heard: [Float] = []
    private var heardCount = 0
    private var nextDetection = 0
    private var detecting = false
    private var earlyDecision: RouteDecision?
    /// Samples the latest detection heard, and the one in flight (if any) is hearing.
    private var earlyCoverage = 0
    private var detection: Task<Void, Never>?
    private var detectionCoverage = 0
    private var lastProgressFamily: EngineFamily?
    /// The family the hold is being spent on: the pin's, else the last detection's.
    private var likelyFamily: EngineFamily?
    /// Parakeet's pause decodes currently read as not English (`TranscriptCheck`): the Uzbek
    /// stream is kept speculating whatever the detector says, so that if key-up ends up routing
    /// to Uzbek on that evidence its tail is already decoded. Recomputed at every change of the
    /// text, so it clears itself when the next pause decode reads as English again.
    private var unifiedTextDoubt = false
    private var lastUnifiedText: String?

    // The live polish.
    private var livePolish: IncrementalPolish?
    private var liveFamily: EngineFamily?
    private var lastProgress: StreamProgress?

    public init(
        audio: any AudioSource,
        router: any LanguageRouter,
        engines: [EngineFamily: any TranscriptionEngine],
        sink: any TextSink,
        polisher: (any PolishEngine)? = nil,
        normalise: @escaping @Sendable (String, Language) -> String = { text, _ in text },
        config: Config = Config(),
        expectedPin: Language? = nil,
        livePolish: LivePolish? = nil,
        languageHead: (any AcousticClassifier)? = nil,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.expectedPin = expectedPin
        let sole = config.languages.soleRoute(preferring: config.defaultLanguage)
        self.fixedRoute = expectedPin ?? sole
        self.fixedLanguage = expectedPin ?? (config.languages.languages.count == 1 ? sole : nil)
        self.livePolishPlan = livePolish
        self.languageHead = languageHead
        self.audio = audio
        self.router = router
        self.engines = engines
        self.sink = sink
        self.polisher = polisher
        self.normalise = normalise
        self.config = config
        self.now = now
    }

    private func transition(_ next: SessionState) {
        state = next
        transitions.append(next)
    }

    private func measure<T>(_ stage: String, _ body: () async throws -> T) async rethrows -> T {
        let t0 = now()
        defer { record?.stageMillis[stage] = now().timeIntervalSince(t0) * 1000 }
        return try await body()
    }

    // MARK: Key down

    /// True while `arm()` is suspended inside `audio.start()`. A key-up arriving in that
    /// window must wait rather than be dropped — see `awaitArmingIfNeeded()`.
    private var armingWaiters: [CheckedContinuation<Void, Never>] = []

    /// Begin capturing. The model is paged in behind the user's speech.
    ///
    /// The session is reusable: arming again after a terminal state starts a fresh dictation.
    /// Arming while one is already in flight is ignored, because a second key-down before the
    /// first key-up is a stuck modifier, not a new utterance.
    public func arm() async {
        switch state {
        case .idle, .done, .heardNothing, .failed:
            break
        case .arming, .capturing, .finalising, .routing, .transcribing, .inserting, .polishing:
            return
        }
        transitions.removeAll()
        record = DictationRecord(startedAt: now())
        armedAt = now()
        transition(.arming)
        do {
            try await measure("arming") { try await audio.start() }
            transition(.capturing)
            await openLiveStreams()
        } catch {
            fail(.armingFailed("\(error)"), "\(error)")
        }
        releaseArmingWaiters()
    }

    private func releaseArmingWaiters() {
        let waiting = armingWaiters
        armingWaiters.removeAll()
        for w in waiting { w.resume() }
    }

    /// Start decoding while the user is still speaking, when both ends can.
    ///
    /// Every family whose engine can stream gets a stream — pinned, only the pin's — opened
    /// *speculatively*: the route is not known until key-up, and a dictation that turns out to
    /// be another language simply never finishes the other stream. Everything a stream commits
    /// is decoded behind the user's speech, so key-up is left with one window at most however
    /// long the hold was, and usually with nothing: each stream decodes at pauses too.
    ///
    /// Two streams would double the work, so the language detector is asked during the hold
    /// (`EarlyRouting`) and the unlikely stream stands down: Parakeet's is nearly free (the
    /// Neural Engine, one window per 14 s), the Uzbek one is the GPU, so it is the Uzbek one that
    /// stops speculating while the audio does not sound Uzbek.
    ///
    /// The pump drains the take's own chunk stream, which the capture finishes when the take
    /// ends — so the pump cannot outlive its recording, whichever path ends it (key-up, Escape,
    /// a newer press sealing this take). State is per session, and a session is per dictation,
    /// so overlapping dictations each stream their own audio.
    ///
    /// Turkish and Arabic (D-11) stream too when they are on — their engines are in `engines`
    /// only then — but they open *stood down*: their audio is kept and nothing is decoded until a
    /// detection points at them (`detected`). So a dictation in one of the three core languages
    /// costs them a copy of its audio and a speech detector, never a GPU decode.
    private func openLiveStreams() async {
        guard let live = audio as? any LiveAudioSource else { return }
        let families: [EngineFamily] = fixedRoute.map { [EngineFamily(for: $0)] }
            ?? [.unified, .uzbek, .turkish, .arabic].filter(config.languages.families.contains)
        for family in families {
            guard let streaming = engines[family] as? any StreamingTranscriptionEngine else {
                continue
            }
            let stream = await streaming.openStream()
            if fixedRoute == nil, family == .turkish || family == .arabic {
                await stream.setLikely(false)
            }
            liveStreams[family] = stream
        }
        guard !liveStreams.isEmpty else { return }
        likelyFamily = fixedRoute.map { EngineFamily(for: $0) }
        if fixedRoute == nil, let early = config.earlyRouting {
            nextDetection = Int(early.first * Double(AudioBuffer.sampleRate))
        }
        let chunks = live.chunks
        let streams = liveStreams
        livePump = Task {
            for await chunk in chunks {
                for stream in streams.values { await stream.append(chunk) }
                self.detectIfDue(chunk)
                await self.pollProgress()
                await self.readUnifiedText()
            }
        }
    }

    /// Every captured chunk, for the detector: the first `through` seconds are kept, and a
    /// detection is started each time another `every` seconds have arrived.
    private func detectIfDue(_ chunk: [Float]) {
        guard let early = config.earlyRouting, fixedRoute == nil else { return }
        let limit = Int(early.through * Double(AudioBuffer.sampleRate))
        if heard.count < limit { heard += chunk.prefix(limit - heard.count) }
        heardCount += chunk.count
        // While the recording is a Turkish candidate, the spaced checks follow the audio, not
        // only the detections (every 3 s): a 6 s verdict that was not yet sure is asked again
        // at 8 s, whether or not a detection lands then.
        if headWanted, state == .capturing {
            startTurkishCheck(atPause: false)
        }
        guard nextDetection > 0, heardCount >= nextDetection else { return }
        startDetection(atPause: false)
    }

    /// One detection over everything heard so far (up to the detector's 30 s), in the background.
    /// `atPause`: started because the speaker went quiet (`detectAtPause`), so it has heard every
    /// word spoken so far — which is when a Turkish check is worth starting whatever the spacing.
    private func startDetection(atPause: Bool) {
        guard let early = config.earlyRouting, !detecting, heard.count > earlyCoverage else {
            return
        }
        let limit = Int(early.through * Double(AudioBuffer.sampleRate))
        detecting = true
        nextDetection = heard.count >= limit ? 0
            : heardCount + Int(early.every * Double(AudioBuffer.sampleRate))
        let sample = AudioBuffer(samples: heard)
        let router = self.router
        detectionCoverage = sample.samples.count
        detection = Task {
            let decision = await router.route(sample, pin: nil)
            await self.detected(decision, covering: sample.samples.count, atPause: atPause)
        }
    }

    private func detected(_ decision: RouteDecision, covering samples: Int,
                          atPause: Bool) async {
        detecting = false
        detection = nil
        // Recorded whatever the state: a detection that lands just after key-up is exactly the
        // one `detectionThatHeardEverything` may be waiting for.
        earlyDecision = decision
        earlyCoverage = samples
        let seconds = Double(samples) / Double(AudioBuffer.sampleRate)
        note {
            $0.earlyRoute = decision
            $0.earlyRouteSeconds = seconds
        }
        guard state == .capturing, let early = config.earlyRouting else { return }
        // Once the hold has a trusted "Turkish" (`turkishChecked`) the Turkish stream is the one
        // the hold is spent on, whatever the base detector keeps calling the audio.
        if let candidate = decision.candidate, settled(for: candidate) {
            // Settled for this candidate by the head: the candidate's stream is the one the hold
            // is spent on (`turkishChecked`), whatever the base detector keeps calling the audio.
            likelyFamily = EngineFamily(for: candidate)
            return
        }
        let family = decision.family
        if family == .uzbek {
            await liveStreams[.uzbek]?.setLikely(true)
            // A cold Uzbek model starts loading now, not at the stream's next pause.
            if let engine = engines[.uzbek], await engine.isReady() == false {
                Task { try? await engine.prepare() }
            }
        } else if (decision.turkicMass ?? 0) < early.standDownBelow, !unifiedTextDoubt {
            await liveStreams[.uzbek]?.setLikely(false)
        }
        // The optional streams work only while a detection points at them: Arabic when the route
        // is Arabic, Turkish while an Uzbek route is a Turkish candidate — then the Uzbek stream
        // keeps working too, because Uzbek is where an unsure candidate goes.
        // An Arabic candidate (C4 §14.1) works the Arabic stream too, beside Parakeet's (on the
        // Neural Engine), so a "yes" from the head finds Cohere's pause decodes already done —
        // but not beside the Uzbek stream: both on the GPU slowed the Uzbek tail of the Uzbek
        // dictations that are candidates (C4 §14.4: 178 → 381 ms p50), and those are most of
        // them. An Arabic "yes" over an Uzbek base pays Cohere's decode at key-up instead.
        for optional in [EngineFamily.turkish, .arabic] {
            guard let stream = liveStreams[optional] else { continue }
            let wanted = optional == .arabic
                ? family == .arabic || (decision.candidate == .arabic && family != .uzbek)
                : decision.candidate == .turkish
            await stream.setLikely(wanted)
            if wanted, let engine = engines[optional], await engine.isReady() == false {
                Task { try? await engine.prepare() }
            }
        }
        if headWanted { startTurkishCheck(atPause: atPause) }
        likelyFamily = liveStreams[family] != nil ? family : likelyFamily
    }

    /// Ask turbo's language head about everything heard so far, in the background — once a
    /// detection has called the recording a Turkish candidate, and again only when
    /// `turkishCheckEvery` more audio has arrived (each is ~0.1–0.3 s on the Turkish engine's
    /// context with the fitted head window, beside the streams). Once a trusted "Turkish" is in,
    /// never again.
    ///
    /// **At a pause** the spacing does not apply: a detection started there has heard every word
    /// so far, and if it calls the recording a candidate the check is asked about everything too,
    /// even beside a check still running over less. Most releases come 0.2–0.4 s after a pause
    /// like that, so key-up finds the answer it needs already made — or nearly — instead of
    /// asking over the whole recording itself (C4 §13: that wait was 0.9–1.0 s on every 7–10 s
    /// Turkish dictation, whose last spaced check had not heard the end). The head's calls run
    /// one after another on their own state, so an older check finishes first and cannot
    /// overwrite a newer verdict (`turkishChecked` keeps the widest).
    private func startTurkishCheck(atPause: Bool) {
        guard let verifier = languageHead, !heard.isEmpty, !turkishSettled else { return }
        let covered = max(turkishVerdict?.coverage ?? 0, turkishCheck?.coverage ?? 0)
        guard heard.count > covered else { return }
        if !atPause {
            let every = Int(config.turkishCheckEvery * Double(AudioBuffer.sampleRate))
            guard turkishCheck == nil, covered == 0 || heard.count >= covered + every else { return }
        }
        let sample = AudioBuffer(samples: heard)
        let task = Task { await verifier.posterior(for: sample) }
        turkishCheck = (task, sample.samples.count)
        Task {
            let posterior = await task.value
            await self.turkishChecked(posterior, covering: sample.samples.count)
        }
    }

    private func turkishChecked(_ posterior: [String: Double], covering samples: Int) async {
        if turkishCheck?.coverage == samples { turkishCheck = nil }
        guard !posterior.isEmpty, samples > (turkishVerdict?.coverage ?? 0) else { return }
        let wasSettled = turkishSettled
        turkishVerdict = (posterior, samples)
        guard state == .capturing, let candidate = earlyDecision?.candidate,
              liveStreams[EngineFamily(for: candidate)] != nil else { return }
        // A trusted verdict settles the hold: the Uzbek stream stops spending the GPU the
        // candidate's now needs, and the hold's progress and polish follow the candidate's
        // stream. (Key-up still routes through the check; the base stream can still finish.)
        // Not latched: a wider verdict that no longer says so stands the base stream back up
        // at once, rather than at the next detection.
        let base = earlyDecision?.family ?? .uzbek
        if turkishSettled {
            await liveStreams[.uzbek]?.setLikely(false)
            likelyFamily = EngineFamily(for: candidate)
        } else if wasSettled {
            if base == .uzbek { await liveStreams[.uzbek]?.setLikely(true) }
            likelyFamily = liveStreams[base] != nil ? base : likelyFamily
        }
    }

    /// Key-up's answer for a Turkish candidate: a verdict from the hold when it heard every word
    /// (or confidently said Turkish over `trustTurkishCheckAfter`), the running one when that
    /// will have, else one over the whole recording now. Nil when there is no verifier or it
    /// could not answer — then the route stays Uzbek.
    /// Whether the hold has a "Turkish" verdict trusted by `trustTurkishCheckAfter`.
    /// Whether the hold should ask the head: the recording is a candidate. (Asking it earlier,
    /// for any recording already at the candidate's `ar` share before 3.5 s, was measured:
    /// Uzbek candidates 340 → 327 ms p50 — noise — for more GPU work in every such hold.)
    private var headWanted: Bool {
        earlyDecision?.candidate != nil
    }

    private var turkishSettled: Bool {
        guard let candidate = earlyDecision?.candidate else { return false }
        return settled(for: candidate)
    }

    /// Whether the hold's verdict, trusted for `candidate` (`trust(for:)`), says `candidate`.
    private func settled(for candidate: Language) -> Bool {
        guard let verdict = turkishVerdict else { return false }
        return verdict.coverage >= trust(for: candidate)
            && LanguageCheck.verifies(candidate, verdict.posterior,
                                      familiar: familiar(with: candidate))
    }

    /// Samples a "yes" from the head must have heard to be trusted whatever came after it.
    /// Turkish: `trustTurkishCheckAfter`. Arabic: never short of every word — its rule is
    /// measured on whole recordings only (C4 §14.1), so a verdict is used at key-up when it
    /// heard the speech to its end (the check at the pause before the release does).
    private func trust(for candidate: Language) -> Int {
        candidate == .turkish
            ? Int(config.trustTurkishCheckAfter * Double(AudioBuffer.sampleRate)) : Int.max
    }

    private func familiar(with candidate: Language) -> Bool {
        candidate == .arabic ? config.arabicFamiliar : config.turkishFamiliar
    }

    /// The verdict from the hold, when key-up may use it as it is.
    private func readyTurkishVerdict(for buffer: AudioBuffer, speechEnd: Int?,
                                     candidate: Language) -> [String: Double]? {
        guard let verdict = turkishVerdict else { return nil }
        let needed = min(speechEnd ?? buffer.samples.count, 30 * AudioBuffer.sampleRate)
        if verdict.coverage >= needed { return verdict.posterior }
        if verdict.coverage >= trust(for: candidate),
           LanguageCheck.verifies(candidate, verdict.posterior,
                                  familiar: familiar(with: candidate)) {
            return verdict.posterior
        }
        return nil
    }

    private func turkishPosterior(for buffer: AudioBuffer, speechEnd: Int?,
                                  candidate: Language) async -> [String: Double]? {
        guard let verifier = languageHead else { return nil }
        let needed = min(speechEnd ?? buffer.samples.count, 30 * AudioBuffer.sampleRate)
        if let ready = readyTurkishVerdict(for: buffer, speechEnd: speechEnd,
                                           candidate: candidate) { return ready }
        let waited = now()
        defer { note { $0.turkishCheckWaitMillis = self.now().timeIntervalSince(waited) * 1000 } }
        // A check still running is waited for when it will be the answer: it heard every word,
        // or it heard enough for a "Turkish" to be trusted (and says so). A new check would only
        // queue behind it on the head's state.
        if let running = turkishCheck, running.coverage >= min(needed, trust(for: candidate)) {
            let posterior = await running.task.value
            await turkishChecked(posterior, covering: running.coverage)
            if !posterior.isEmpty,
               running.coverage >= needed
                || LanguageCheck.verifies(candidate, posterior,
                                          familiar: familiar(with: candidate)) {
                return posterior
            }
        }
        // Over the speech and a little after it, not whatever the key was held for after the
        // last word: the fitted head window is measured on exactly that (C4 §13 — trimmed, with
        // 0–300 ms after the speech, every FLEURS Turkish clip ≥ 0.9956), and a long silence at
        // the end is the one input that pulled a Turkish clip under 0.99 (0.912, 2.4 s of it).
        let heardTo = speechEnd.map { min(buffer.samples.count,
                                          $0 + Int(config.turkishCheckAfterSpeech
                                                   * Double(AudioBuffer.sampleRate))) }
        let spoken = heardTo.map { AudioBuffer(samples: Array(buffer.samples.prefix($0))) }
            ?? buffer
        let posterior = await verifier.posterior(for: spoken)
        return posterior.isEmpty ? nil : posterior
    }

    /// Read the likely stream's text, and act on a change: a pause decode just landed.
    ///
    /// Two things follow a pause. The detector is asked again (if a second of new audio has come
    /// in since it last was), so its latest answer has heard every word up to the pause — and if
    /// the speaker lets go without saying more, that answer *is* the whole-recording answer, and
    /// key-up need not ask again (see `finish`, step 3). And the mode's polish is primed.
    private func pollProgress() async {
        guard state == .capturing,
              let family = likelyFamily ?? (liveStreams[.unified] != nil ? .unified : nil),
              let stream = liveStreams[family] else { return }
        await detectAtPause(stream)
        guard let progress = await stream.progress(), progress != lastProgress else { return }
        lastProgress = progress
        lastProgressFamily = family
        await primeLivePolish(progress, family: family)
    }

    /// Parakeet's text so far, read the way key-up will read it (`TranscriptCheck.doubt`). Only
    /// unpinned, and only while both families stream: it decides whether the Uzbek stream keeps
    /// speculating when the detector would stand it down. An empty text is not doubt here — every
    /// hold starts empty; only a text that is there and is not English is.
    private func readUnifiedText() async {
        guard state == .capturing, fixedRoute == nil, config.earlyRouting != nil,
              let unified = liveStreams[.unified], let uzbek = liveStreams[.uzbek],
              let text = await unified.progress()?.text, text != lastUnifiedText else { return }
        lastUnifiedText = text
        let doubt = !text.isEmpty && TranscriptCheck.doubt(text) == .notEnglish
        guard doubt != unifiedTextDoubt else { return }
        unifiedTextDoubt = doubt
        if doubt { await uzbek.setLikely(true) }
    }

    /// A detection the moment the speaker goes quiet — at `pauseForDetection` of silence by the
    /// likely stream's own speech detector, not when that stream's pause decode lands. The decode
    /// of a long Uzbek region takes longer than a release habit of 0.3 s leaves, and a detection
    /// that waited for it was still running at key-up; started at the pause it has usually
    /// finished, heard every word, and key-up asks nothing.
    private func detectAtPause(_ stream: any TranscriptionStream) async {
        guard fixedRoute == nil, let early = config.earlyRouting, !detecting,
              config.detectAtPauseOnUzbek || likelyFamily != .uzbek,
              heardCount >= Int(early.firstAtPause * Double(AudioBuffer.sampleRate)),
              let spoken = await stream.lastSpeechEnd(), spoken > earlyCoverage,
              heardCount - spoken >= Int(early.pauseForDetection * Double(AudioBuffer.sampleRate))
        else { return }
        // Already a candidate: the head is asked at once, beside the detection rather than after
        // it — the ~40 ms the detection takes is the part of the head's wait key-up can save
        // (C4 §14.4: an Arabic candidate's key-up waited ~210 ms p50 for the pause's check).
        if headWanted { startTurkishCheck(atPause: true) }
        startDetection(atPause: true)
    }

    /// Polish the likely stream's text while it is still being spoken.
    ///
    /// Every time the stream's text changes — a commit, or a decode at a pause — the whole of it
    /// is normalised exactly as the final transcript will be and handed to the mode's
    /// `IncrementalPolish.prime`, which polishes each sentence it has not seen, the unfinished
    /// last one included (the speaker may be about to let go). At key-up the final transcript is
    /// polished by the same object, and every sentence that came out unchanged is already done;
    /// one the transcriber revised is polished then. So a stream that changes its mind costs
    /// time, never correctness.
    private func primeLivePolish(_ progress: StreamProgress, family: EngineFamily) async {
        // Uzbek, Turkish and Arabic all decode on the GPU, which the primes share (D-11 treats the
        // two whisper-family optional languages the way C3 measured Uzbek).
        let onGPU = family != .unified
        guard let plan = livePolishPlan, config.primeOnUzbek || !onGPU else { return }
        let text = progress.text
        guard !text.isEmpty else { return }
        let language = fixedLanguage ?? (family == .unified
            ? progress.language ?? earlyDecision?.language.unifiedOrEnglish
                ?? config.defaultLanguage.unifiedOrEnglish
            : progress.language ?? (family == .uzbek ? .uzbek : family == .turkish ? .turkish
                                                                                    : .arabic))
        if livePolish == nil || liveFamily != family || livePolish?.language != language {
            // A new language (or a first sentence): what was primed for another is worthless.
            await livePolish?.cancel()
            let polish = IncrementalPolish(behaviour: plan.behaviour, language: language,
                                           engine: plan.engine)
            livePolish = polish
            liveFamily = family
            guard await polish.wantsModel else { return }
            // Beside the pump, never in it. This runs on the pump's own task, and a cold modes
            // model (the first dictation after the idle release, or after launch: ~0.3 s of mmap
            // and up to ~2.8 s of Metal compilation) held every chunk back from the streams for
            // that long — no pause decodes, and key-up (`closeLiveStreams` waits on the pump)
            // waiting out the load. The primes below queue behind the load on the engine anyway.
            Task { await polish.prepare() }
        }
        // Not the unfinished sentence on Uzbek: there the GPU is also decoding the pause, and a
        // model generation beside it slowed the very decode key-up was about to wait for.
        let primesLast = config.primeLastSentence
            && (!onGPU || (family == .arabic && config.primeLastOnArabic))
        await livePolish?.prime(normalise(text, language), includingLast: primesLast)
    }

    /// Cancels every stream not in `kept` and returns the rest: whatever finishes a dictation,
    /// nothing else is decoded behind it.
    private func cancel(_ streams: [EngineFamily: any TranscriptionStream],
                        except kept: Set<EngineFamily> = []) async
        -> [EngineFamily: any TranscriptionStream] {
        for (family, stream) in streams where !kept.contains(family) { await stream.cancel() }
        return streams.filter { kept.contains($0.key) }
    }

    /// Hand the streams over, exactly once, after the last chunk has reached them. Called right
    /// after `audio.stop()`, which finishes the chunk stream, so this waits only for chunks
    /// already delivered to be appended — every sample the streams will ever see.
    private func closeLiveStreams() async -> [EngineFamily: any TranscriptionStream] {
        await livePump?.value
        livePump = nil
        defer { liveStreams = [:] }
        return liveStreams
    }

    /// The key-down was discarded — Escape while holding, or a hotkey that turned out to start a
    /// shortcut. The caller stops the audio; this stops everything the hold started behind it.
    ///
    /// Without it a cancelled dictation was simply dropped by the controller, and nothing that
    /// runs on its own ended: the Uzbek stream's queued commits and its pause decode went on
    /// decoding on the one whisper context, the mode's primed sentences went on generating on the
    /// one llama context, and the next dictation — pressed straight after Escape, which is what
    /// Escape is for — queued its own decodes and its polish behind them.
    public func abandon() async {
        await awaitArmingIfNeeded()
        guard state == .capturing else { return }
        livePump?.cancel()
        detection?.cancel()
        turkishCheck?.task.cancel()
        for stream in await closeLiveStreams().values { await stream.cancel() }
        await abandonLivePolish()
        note { $0.outcome = "cancelled" }
        transition(.idle)
    }

    /// `AudioSource.start()` is a nonisolated async call, so `arm()` releases the actor while
    /// it runs — measured at 103 ms on this Mac and 302 ms on the iPhone, which is a wide
    /// window. A hold-to-talk hotkey fires key-down and key-up as two unstructured Tasks with
    /// no ordering guarantee, so a short press genuinely lands `finish()` in `.arming`.
    ///
    /// Returning early there would drop the key-up, leave the tap open, and — worse — hand the
    /// abandoned audio to the *next* dictation, which would then insert the wrong text. So the
    /// key-up waits for arming to settle instead.
    private func awaitArmingIfNeeded() async {
        guard state == .arming else { return }
        await withCheckedContinuation { armingWaiters.append($0) }
    }

    /// The reroute ceiling for this recording. See `Config.rerouteDeadlinePerSecond`.
    private func rerouteDeadline(for buffer: AudioBuffer) -> Duration {
        let scaled = Duration.milliseconds(Int(buffer.duration * config.rerouteDeadlinePerSecond
                                               * 1000))
        return max(config.rerouteDeadline, scaled)
    }

    /// `record` is the single source of truth. An earlier version of this file kept a local
    /// `var rec` copy and assigned it back at the end, which silently discarded every stage
    /// timing `measure` had written in the meantime — four of five stages vanished, and the
    /// only reason anyone noticed is that a test asserted on their presence.
    private func note(_ mutate: (inout DictationRecord) -> Void) {
        guard var r = record else { return }
        mutate(&r)
        record = r
    }

    private func fail(_ reason: SessionFailure, _ message: String) {
        note {
            $0.errors.append(message)
            $0.outcome = "failed"
        }
        transition(.failed(reason))
    }

    // MARK: Key up

    /// Stop capturing and drive the rest of the pipeline. Returns the record whatever happens;
    /// the caller never has to guess what went on.
    /// `polisher` overrides the one given at init.
    ///
    /// The session is built at key-down, because it owns the microphone. A polisher can only be
    /// built at key-up: it needs the resolved mode, and it reads the API key from the Keychain,
    /// which is async and not worth doing until it is known to be needed. Passing it here is
    /// what lets both be true. The app got this wrong first — it built a polisher at key-up,
    /// used it as a boolean, and threw it away, so the whole polish subsystem was unreachable
    /// while every setting behind it appeared to work.
    ///
    /// `polishInstructionsAfterTranscription`, when given, is asked for the instructions at step
    /// 6 instead — after the microphone has stopped and the transcript is in. Rendering them can
    /// mean reading the screen over Accessibility, and done at the call site that ran on the main
    /// actor before `finish` began: the take kept recording past key-up for as long as the
    /// frontmost app took to answer, and the transcript waited behind it.
    @discardableResult
    public func finish(pin: Language? = nil,
                       polisher: (any PolishEngine)? = nil,
                       polishInstructions: PolishInstructions? = nil,
                       polishInstructionsAfterTranscription:
                           (@Sendable () async -> PolishInstructions?)? = nil,
                       polishGuard: PolishGuard = PolishGuard(),
                       insertAfterPolish: Bool = false,
                       releasedAt: Date? = nil) async -> DictationRecord {
        let keyUp = releasedAt ?? now()
        defer { stampRelease(keyUp) }
        await awaitArmingIfNeeded()
        guard state == .capturing, record != nil else {
            return record ?? DictationRecord(startedAt: now())
        }

        // 1. Finalise the buffer.
        transition(.finalising)
        let buffer: AudioBuffer
        var streams: [EngineFamily: any TranscriptionStream]
        do {
            buffer = try await measure("finalising") { try await audio.stop() }
            streams = await closeLiveStreams()
        } catch {
            // A stop that threw may not have finished the take's chunk stream; do not wait on it.
            livePump?.cancel()
            for stream in await closeLiveStreams().values { await stream.cancel() }
            await abandonLivePolish()
            fail(.captureFailed("\(error)"), "\(error)")
            return record!
        }
        note {
            $0.audioSeconds = buffer.duration
            $0.peakAmplitude = buffer.peakAmplitude
            $0.inputDevice = buffer.device
        }

        // Lost audio, said out loud. The recording is genuinely short here — the user spoke words
        // this buffer does not contain — and reporting `.done` over the top of that is the exact
        // silent-truncation failure the project exists to not repeat. Distinct from the
        // saturation measurement below: that one is about a waveform that arrived damaged, this
        // one is about a waveform that did not arrive at all.
        if buffer.droppedSamples > 0 {
            note {
                $0.errors.append(
                    "capture dropped \(buffer.droppedSamples) samples ("
                    + "\(String(format: "%.1f", buffer.droppedSeconds))s) — the recording is "
                    + "shorter than what was said, because nothing drained the buffer in time")
            }
        }

        // Clipping, recorded but never fatal — and now told apart from merely loud, because the
        // two cost different amounts and only one of them is worth acting on.
        //
        // The peak alone cannot distinguish them. A peak above 1.0 means the float signal exceeded
        // full scale, which happens both when the waveform was genuinely flattened at the ADC and
        // when it was simply gained hot and left intact; the resampler contributes up to +1.15 dB
        // of overshoot of its own. What separates them is how many samples are *sitting* at the
        // rail. Measured on the 344-clip Uzbek set, flattening a known share of every sample:
        //
        //     0 % flattened   25.19 % WER   (baseline)
        //     1.1 %           25.20 %       — indistinguishable from baseline
        //     8.3 %           26.77 %       — 1.58 points, and Russian code-switching 17.3 -> 21.2
        //    28.6 %           33.54 %       — 8.35 points
        //
        // Sharply non-linear: nothing at all up to about 1%, then it accelerates hard.
        //
        // So the old warning was firing on a condition that measurably costs nothing, including on
        // cases created by this app's own resampler. `saturatedFraction` is the number that
        // actually predicts damage, and it belongs in the record either way: it is the one figure
        // that settles hot-gain-versus-flattening for good.
        let saturated = buffer.samples.reduce(into: 0) { count, sample in
            if abs(sample) >= 0.999 { count += 1 }
        }
        let saturatedFraction = buffer.samples.isEmpty
            ? 0 : Double(saturated) / Double(buffer.samples.count)
        if buffer.peakAmplitude >= Self.clippingThreshold {
            let peak = String(format: "%.2f", buffer.peakAmplitude)
            let percent = String(format: "%.1f", saturatedFraction * 100)
            note {
                if saturatedFraction >= Self.flatteningFraction {
                    $0.errors.append(
                        "input is clipping — peak \(peak), and \(percent)% of samples are flat "
                        + "against the rail. Measured cost at this much flattening is about 1.5 "
                        + "points of word error. Lower the input volume in "
                        + "System Settings › Sound › Input.")
                } else {
                    $0.errors.append(
                        "input is hot — peak \(peak) above full scale, but only \(percent)% of "
                        + "samples are flat, and that much was measured to cost nothing. Recorded "
                        + "rather than warned about.")
                }
            }
        }

        // 1b. No audio at all is a broken microphone, not a quiet room.
        //
        // The silence gate below compares peak amplitude, and an empty buffer has a peak of zero,
        // so the two used to be indistinguishable — which meant a capture that delivered literally
        // nothing was reported to the user as "I heard nothing", i.e. as their fault. Measured, in
        // one session on 2026-08-11: seven of these, arming succeeding in 20–59 ms each, four of
        // them inside forty seconds while someone pressed the key again and again. The cause was
        // upstream (AVAudioEngine dropped its connections on a device change and the graph was
        // never rebuilt) but the *reporting* was this line, and this project's own rule is that
        // nothing may fail silently.
        guard !buffer.samples.isEmpty else {
            streams = await cancel(streams)
            await abandonLivePolish()
            let why = "the microphone delivered no audio at all — not a quiet room, nothing "
                + "arrived. If it repeats, the input device changed and Kotiba rebuilds its audio "
                + "graph on the next press."
            fail(.captureFailed(why), why)
            return record!
        }

        // 2. Say so when nothing was said. This is a terminal state, not an empty success.
        guard buffer.peakAmplitude >= config.silenceThreshold else {
            streams = await cancel(streams)
            await abandonLivePolish()
            note { $0.outcome = "heardNothing" }
            transition(.heardNothing)
            return record!
        }

        // 3. Route. A pin costs nothing and beats everything.
        transition(.routing)
        // `routed` is mutable only until step 4b settles it, because the output script is the one
        // piece of evidence about the route that cannot arrive until after the route was taken.
        // Everything downstream reads the immutable `decision`.
        //
        // Unpinned and not already settled during the hold (`detectionThatHeardEverything`), the
        // whole recording is detected (~35 ms) — beside Parakeet's finish when the hold was spent
        // on English/Russian, so the detection is on the critical path only for as long as that
        // finish is shorter than it. When the route agrees — nearly always — that finish is the
        // transcript; when it does not, it is abandoned and the routed family's stream finishes.
        var speculativeFinishes: [EngineFamily: Task<Transcript, any Error>] = [:]
        if pin == nil {
            // Only ever Parakeet's: it runs on the Neural Engine, so it costs the detection
            // nothing. The Uzbek stream's tail runs on the GPU like the detector, and side by
            // side each slowed the other past the sum of the two run in turn (measured on Uzbek
            // clips released on the last syllable: detection 144 ms instead of ~40, and the tail
            // ~350 ms after key-up instead of ~200). So on Uzbek the detection goes first.
            let candidates: [EngineFamily] = (likelyFamily ?? .unified) == .unified
                && streams[.unified] != nil ? [.unified] : []
            for family in candidates {
                guard let stream = streams[family], let engine = engines[family],
                      await engine.isReady() else { continue }
                let language: Language = family == .uzbek ? .uzbek
                    : (earlyDecision.map { $0.family == .unified ? $0.language : nil } ?? nil)
                        ?? config.defaultLanguage.unifiedOrEnglish
                speculativeFinishes[family] = Task { try await stream.finish(buffer,
                                                                             language: language) }
            }
        }
        var routed: RouteDecision
        if let pin {
            routed = RouteDecision(language: pin, source: .pin)
        } else if let sole = config.languages.soleRoute(preferring: config.defaultLanguage) {
            // Nothing to detect: one language on, or English and Russian alone (free, ~0 ms).
            routed = RouteDecision(language: sole, source: .only)
        } else if config.earlyRouting?.detectAtRelease == false, let earlyDecision {
            routed = earlyDecision
        } else if let heardAll = await detectionThatHeardEverything(streams) {
            // The detector already heard every word (it ran at the pause before key-up): its
            // answer is the whole-recording answer, and asking again would only put ~40 ms of
            // GPU on the critical path.
            routed = heardAll
        } else {
            routed = await measure("routing") { await router.route(buffer, pin: pin) }
        }
        // 3b. A Turkish candidate is settled by turbo's language head (`TurkishCheck`, D-11):
        //     Turkish only on its word, Uzbek otherwise — including when it cannot answer.
        //     Both streams finish while the check runs (the Uzbek one on its own context, the
        //     Turkish one on turbo's default state beside the head's own), so key-up waits for
        //     the longest of the three rather than their sum; the loser is cancelled below.
        //     An Arabic candidate (C4 §14.1) the same way, on any base route: Arabic only on the
        //     head's word (`ArabicCheck`), the base route otherwise.
        if let candidate = routed.candidate, pin == nil {
            let base = routed
            let candidateFamily = EngineFamily(for: candidate)
            let checkStarted = now()
            defer { record?.stageMillis["checking"] = now().timeIntervalSince(checkStarted) * 1000 }
            // Where the speech ended, by the stream that has been listening: the candidate's —
            // except an Arabic candidate over Uzbek, whose Arabic stream stood down (`detected`).
            let listening = candidate == .arabic && base.family == .uzbek
                ? streams[base.family] : streams[candidateFamily] ?? streams[base.family]
            let speechEnd = await listening?.lastSpeechEnd()
            // With the hold's verdict already usable there is nothing to wait for, and only the
            // stream it names finishes; otherwise both do, beside the check.
            let ready = readyTurkishVerdict(for: buffer, speechEnd: speechEnd,
                                            candidate: candidate)
            // An Arabic candidate over an Uzbek base finishes only the Uzbek stream beside the
            // check: two GPU tails at once slowed the Uzbek one (see `detected`).
            let both: [(EngineFamily, Language)] = candidate == .arabic && base.family == .uzbek
                ? [(base.family, base.language)]
                : [(candidateFamily, candidate), (base.family, base.language)]
            let finishing: [(EngineFamily, Language)] = ready.map {
                LanguageCheck.verifies(candidate, $0, familiar: familiar(with: candidate))
                    ? [(candidateFamily, candidate)] : [(base.family, base.language)]
            } ?? both
            for (family, language) in finishing where speculativeFinishes[family] == nil {
                guard let stream = streams[family] else { continue }
                speculativeFinishes[family] = Task { try await stream.finish(buffer,
                                                                             language: language) }
            }
            if let posterior = await turkishPosterior(for: buffer, speechEnd: speechEnd,
                                                      candidate: candidate) {
                let tr = candidate == .turkish ? OptionalLanguageRules.share("tr", of: posterior)
                    : nil
                let ar = candidate == .arabic ? OptionalLanguageRules.share("ar", of: posterior)
                    : nil
                routed = LanguageCheck.verifies(candidate, posterior,
                                                familiar: familiar(with: candidate))
                    ? base.rerouted(to: candidate, by: LanguageCheck.source(for: candidate),
                                    turkishVerified: tr, arabicVerified: ar)
                    : base.rerouted(to: base.language, by: base.source, turkishVerified: tr,
                                    arabicVerified: ar)
            } else {
                routed = base.rerouted(to: base.language, by: base.source)
                note { $0.errors.append("the \(candidate == .arabic ? "Arabic" : "Turkish") "
                                        + "check could not answer; routed to "
                                        + "\(base.language.promptName).") }
            }
        }
        turkishCheck?.task.cancel()
        note { $0.route = routed }
        for (family, task) in speculativeFinishes where family != routed.family {
            task.cancel()
            await streams[family]?.cancel()
            streams[family] = nil
        }
        let speculativeFinish = speculativeFinishes[routed.family]

        // 4. Transcribe. An engine that is not ready is a loud failure, never a silent
        //    substitution — the previous build fell back to a 30x slower engine in silence.
        //    Unpinned on Parakeet, the Uzbek stream is kept until step 4a′ has read Parakeet's
        //    transcript: it is the second opinion that step asks for.
        let keepsUzbekForCheck = pin == nil && routed.family == .unified
            && config.languages.permits(.uzbek)
        streams = await cancel(streams, except: keepsUzbekForCheck ? [routed.family, .uzbek]
                                                                   : [routed.family])
        let stream = streams[routed.family]
        guard let engine = engines[routed.family] else {
            streams = await cancel(streams)
            await abandonLivePolish()
            fail(.noEngineReady(routed.family, routed.language),
                 "no engine registered for \(routed.family.rawValue)")
            return record!
        }
        // "Not loaded yet" and "cannot load" are different answers, and the engines that matter
        // are lazy: whisper reports false until its 539 MB context is mapped in, and it maps it in
        // on demand. Refusing a cold engine here made Uzbek — the language this app exists for —
        // fail on every default install, because nothing else ever loaded it: `prepareEngines`
        // skips any language that is not the default, and the key-down preload pages in the
        // *pinned* language, which no built-in mode sets. `preloadAllLanguages` was the only thing
        // hiding it, and it is off by default.
        //
        // So a cold engine now gets exactly one chance to load, timed so a slow first dictation is
        // explainable. Only a load that actually fails is terminal, and it fails with the reason
        // the engine gave — a missing file, a bad checksum and a revoked permission must not all
        // read as "not ready".
        if await engine.isReady() == false {
            do {
                try await measure("loading") { try await engine.prepare() }
            } catch {
                streams = await cancel(streams)
                await abandonLivePolish()
                fail(.noEngineReady(routed.family, routed.language),
                     "engine \(engine.engineID) could not load: \(error)")
                return record!
            }
            guard await engine.isReady() else {
                streams = await cancel(streams)
                await abandonLivePolish()
                fail(.noEngineReady(routed.family, routed.language),
                     "engine \(engine.engineID) is not ready even after loading, and gave no reason")
                return record!
            }
        }

        transition(.transcribing)
        var transcribed: Transcript
        do {
            let language = routed.language
            if let speculativeFinish {
                transcribed = try await measure("transcribing") { try await speculativeFinish.value }
            } else if let stream {
                transcribed = try await measure("transcribing") {
                    try await stream.finish(buffer, language: language)
                }
            } else {
                transcribed = try await measure("transcribing") {
                    try await engine.transcribe(buffer, language: language)
                }
            }
            if let stream, let settled = await stream.settlement() {
                note { $0.tail = settled }
            }
        } catch {
            streams = await cancel(streams)
            await abandonLivePolish()
            fail(.transcriptionFailed("\(error)"), "\(error)")
            return record!
        }

        // 4b. Recover from the one mis-route that is silent *and* total.
        //
        // `RouteSource.scriptCheck` and `RouteDecision.verify` were both written for this and
        // neither was ever called, so nothing in the app checked whether the route had been
        // right. Measured cost, from this app's own diagnostics on 2026-08-11: Uzbek speech
        // scored a Turkic cluster mass of 0.012 — below the 0.05 threshold — went to the Russian
        // model, and came back as `хоп масалан қаранғалады … яқшы тынық чотке қылып ез болады`.
        // Uzbek, spelled phonetically in Cyrillic, delivered without a word of complaint.
        //
        // Four constraints, and each one is here because dropping it makes this worse than the
        // bug it fixes:
        //
        //   * **A pin is never overruled.** `Routing.swift` documents P1 as absolute, and it has
        //     to stay absolute: a pin is the one signal the user actually authored. When a pinned
        //     route trips the check the record says so and the transcript stands.
        //   * **It only ever moves toward Uzbek**, so a retry cannot itself be re-routed.
        //   * **The replacement has to be plausible**, not merely non-empty. Handing Russian audio
        //     to an Uzbek-only fine-tune is the best way there is to get a repetition loop or a
        //     bare `[BLANK_AUDIO]`, and pasting either over a correct Russian transcript is a
        //     worse outcome than the mis-route.
        //   * **It is bounded.** Everything else after transcription has a deadline; an unbounded
        //     second pass sitting in front of the user's text does not belong in this pipeline.
        //
        // The rule itself lives in `RouteDecision.verify`, not here, so there is one definition
        // with one set of tests rather than an inline copy that drifts from it.
        // 4a. The unified engine names the language itself.
        //
        // Parakeet decides English against Russian inside its decoder — its vocabulary holds
        // both scripts — so the transcript it returns carries the language it actually wrote,
        // and that beats the acoustic router's en/ru guess, which `TieredRouter` itself calls
        // advisory. Taking it matters beyond the label: Latin text on a Russian route is what
        // `verify` reads as a mis-route toward Uzbek, and the step below would then hand good
        // English to the Uzbek engine. A pin still wins, as it does everywhere.
        if routed.family == .unified, routed.source != .pin,
           transcribed.language != routed.language, transcribed.language != .uzbek,
           config.languages.permits(transcribed.language) {
            routed = routed.rerouted(to: transcribed.language, by: .scriptCheck)
            note { $0.route = routed }
        }

        // 4a″. Arabic script from a route that was not Arabic (D-11). Only Arabic is written in
        //      it, so this is the one unambiguous script signal — when an engine writes it at all,
        //      which on Arabic audio mostly means turbo (the Russian fallback). Before 4a′: Arabic
        //      script from Parakeet reads to `TranscriptCheck` as "not English" and would otherwise
        //      be handed to the Uzbek engine. Same constraints as 4b: never a pin, a usable
        //      answer, the reroute deadline; and only when Arabic is on (its engine is present).
        var settledByScript = false
        if pin == nil, routed.source != .pin, routed.language != .arabic,
           ScriptCheck.script(of: transcribed.raw) == .arabic, config.languages.permits(.arabic),
           let arabic = engines[.arabic] {
            let was = routed
            note { $0.errors.append("route said \(was.language.rawValue) and "
                                    + "\(transcribed.engineID) answered in Arabic script.") }
            let rerun = await measure("rerouting") {
                await withDeadline(rerouteDeadline(for: buffer)) {
                    try await arabic.transcribe(buffer, language: .arabic)
                }
            }
            if case .value(let second) = rerun,
               !second.raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                transcribed = second
                routed = was.rerouted(to: .arabic, by: .scriptCheck)
                settledByScript = true
                note {
                    $0.route = routed
                    $0.errors.append("Transcribed again on the Arabic engine.")
                }
            } else {
                note { $0.errors.append("the Arabic engine's second answer was not usable "
                                        + "— the first transcript stands.") }
            }
        }

        // 4a′. Uzbek that the acoustic pass sent to Parakeet — the common mis-route, and until
        //      this step a silent one: 40 of 256 Uzbek dictations in the pipeline's own run (P1).
        //
        // Parakeet's transcript is already here, and on Uzbek audio it is not English — it is
        // pseudo-Hungarian or -Polish, or nothing (`TranscriptCheck`). When it doubts its route,
        // the Uzbek engine is asked for the same audio (its stream, kept for exactly this, has
        // usually decoded the tail already — the hold kept it speculating on the same evidence),
        // and its answer replaces Parakeet's unless it reads as English, which is what the Uzbek
        // fine-tune does with English audio. Constraints as in 4b: never a pin; toward Uzbek
        // only (4c does not undo it); a usable answer; the reroute deadline.
        if keepsUzbekForCheck, routed.family == .unified, routed.source != .pin, !settledByScript {
            let uzbekStream = streams.removeValue(forKey: .uzbek)
            // "No words" counts only when a speech detector heard speech: an empty transcript of
            // a cough is the heard-nothing path (5b), not Uzbek.
            let detector = uzbekStream ?? stream
            let spoken = await detector?.lastSpeechEnd()
            let heardSpeech = spoken.map { $0 > 0 } ?? true   // nil: nothing tracks speech
            var doubt = TranscriptCheck.doubt(transcribed.raw)
            if doubt == .noWords, !heardSpeech { doubt = nil }
            if let doubt {
                note { $0.unifiedDoubt = doubt.rawValue }
            }
            if let doubt, let uzbek = engines[.uzbek], await uzbek.isReady() {
                let was = routed
                let unifiedID = transcribed.engineID
                let second = await measure("rerouting") {
                    await withDeadline(rerouteDeadline(for: buffer)) {
                        if let uzbekStream {
                            return try await uzbekStream.finish(buffer, language: .uzbek)
                        }
                        return try await uzbek.transcribe(buffer, language: .uzbek)
                    }
                }
                switch second {
                case .value(let answer) where Self.isUsableRerun(answer.raw)
                        && !TranscriptCheck.readsAsEnglish(answer.raw):
                    transcribed = answer
                    routed = was.rerouted(to: .uzbek, by: .transcriptCheck)
                    let settled = await uzbekStream?.settlement()
                    note {
                        $0.route = routed
                        if let settled { $0.tail = settled }
                        $0.errors.append("route said \(was.language.rawValue), but \(unifiedID)'s "
                            + "transcript was not English (\(doubt.rawValue)); the Uzbek engine's "
                            + "answer stands.")
                    }
                case .value(let answer):
                    note { $0.errors.append(
                        "\(unifiedID)'s transcript was not English (\(doubt.rawValue)), but the "
                        + "Uzbek engine's answer read as English or was unusable "
                        + SpokenText.quote(answer.raw.prefix(40).trimmingCharacters(in: .whitespaces))
                        + " — the first transcript stands.") }
                case .timedOut:
                    await uzbekStream?.cancel()
                    note { $0.errors.append(
                        "the Uzbek engine did not answer within "
                        + "\(self.rerouteDeadline(for: buffer)) "
                        + "— the first transcript stands.") }
                case .failed(let message):
                    note { $0.errors.append(
                        "the Uzbek engine refused the second opinion: \(message) "
                        + "— the first transcript stands.") }
                }
            } else {
                await uzbekStream?.cancel()
            }
        }

        if settledByScript { await streams.removeValue(forKey: .uzbek)?.cancel() }

        let verdict = routed.verify(transcribed.raw)
        if case .suspect(_, let suggests) = verdict, suggests == .uzbek, routed.language != .uzbek,
           config.languages.permits(.uzbek) {
            let letters = ScriptCheck.nonRussianCyrillicCount(transcribed.raw)
            let was = routed
            let engineID = transcribed.engineID

            // Said unconditionally, before anything is attempted. The previous version reported
            // only on success, so the case where the Uzbek model was configured but not yet
            // resident — the default, since `preloadAllLanguages` is off — looked exactly like a
            // route nobody had ever doubted.
            note {
                $0.errors.append(
                    "route said \(was.language.rawValue) and \(engineID) answered in Cyrillic "
                    + "that is not Russian — \(letters) such letters, which reads as Uzbek.")
            }

            if was.source == .pin {
                note { $0.errors.append(
                    "the language was pinned, so the transcript stands as the Uzbek engine was "
                    + "not asked. Unpin it, or pin Uzbek, if this was wrong.") }
            } else if let uzbek = engines[.uzbek], await uzbek.isReady() {
                let rerun = await measure("rerouting") {
                    await withDeadline(rerouteDeadline(for: buffer)) {
                        try await uzbek.transcribe(buffer, language: .uzbek)
                    }
                }
                switch rerun {
                case .value(let second) where Self.isUsableRerun(second.raw):
                    transcribed = second
                    routed = was.rerouted(to: .uzbek, by: .scriptCheck)
                    note {
                        $0.route = routed
                        $0.errors.append("Transcribed again on the Uzbek engine.")
                    }
                case .value(let second):
                    note { $0.errors.append(
                        "the Uzbek engine's second answer was not usable "
                        + SpokenText.quote(second.raw.prefix(40).trimmingCharacters(in: .whitespaces))
                        + " — the first transcript stands.") }
                case .timedOut:
                    note { $0.errors.append(
                        "the Uzbek engine did not answer within "
                        + "\(self.rerouteDeadline(for: buffer)) "
                        + "— the first transcript stands.") }
                case .failed(let message):
                    note { $0.errors.append(
                        "the Uzbek engine refused the second pass: \(message) "
                        + "— the first transcript stands.") }
                }
            } else {
                note { $0.errors.append(
                    "the Uzbek engine is not loaded, so there was nothing to try instead. Turn on "
                    + "\"Keep every language loaded\", or pin Uzbek, to make this recoverable.") }
            }
        }

        // 4c. Recover the mis-route in the other direction, which is the common one.
        //
        // Measured from this app's diagnostics, 2026-08-22/23: of 32 dictations the acoustic pass
        // sent to the Uzbek engine, 11 were English, at Turkic cluster masses from 0.058 to 0.457
        // — squarely inside the range of this speaker's real Uzbek. The fine-tune still speaks
        // English, so each came back as lowercase Latin English with nothing wrong but the
        // engine, the casing and the speed. `LexicalCheck` is the only signal, and the same four
        // constraints as 4b apply: a pin is never overruled, the move is one-directional (Uzbek
        // route → English, never the reverse, so it cannot chain with 4b), the replacement has to
        // be usable, and it is bounded by the same deadline.
        //
        // An Arabic route that came back in Latin is the same case from the other side (D-11):
        // Cohere writes Arabic script for Arabic speech, so Latin out of it is speech that was not
        // Arabic, and English is where it is re-transcribed.
        if case .suspect(_, let suggests) = verdict, suggests == .english,
           routed.language == .uzbek || routed.language == .arabic,
           routed.source != .transcriptCheck, config.languages.permits(.english) {
            let was = routed
            let engineID = transcribed.engineID
            let english = LexicalCheck.englishEvidence(transcribed.raw)
            note {
                $0.errors.append(was.language == .arabic
                    ? "route said ar and \(engineID) answered in Latin script."
                    : "route said uz and \(engineID) answered in Latin that reads as English — "
                    + "\(english) distinct English function words and "
                    + "\(LexicalCheck.uzbekEvidence(transcribed.raw)) of Uzbek.")
            }

            if was.source == .pin {
                note { $0.errors.append(
                    "the language was pinned, so the transcript stands as the English engine was "
                    + "not asked. Unpin it, or pin English, if this was wrong.") }
            } else if let unified = engines[.unified],
                      unified.supportedLanguages.contains(.english), await unified.isReady() {
                let rerun = await measure("rerouting") {
                    await withDeadline(rerouteDeadline(for: buffer)) {
                        try await unified.transcribe(buffer, language: .english)
                    }
                }
                switch rerun {
                case .value(let second) where Self.isUsableRerun(second.raw):
                    transcribed = second
                    routed = was.rerouted(to: .english, by: .lexicalCheck)
                    note {
                        $0.route = routed
                        $0.errors.append("Transcribed again on the English engine.")
                    }
                case .value(let second):
                    note { $0.errors.append(
                        "the English engine's second answer was not usable "
                        + SpokenText.quote(second.raw.prefix(40).trimmingCharacters(in: .whitespaces))
                        + " — the first transcript stands.") }
                case .timedOut:
                    note { $0.errors.append(
                        "the English engine did not answer within "
                        + "\(self.rerouteDeadline(for: buffer)) "
                        + "— the first transcript stands.") }
                case .failed(let message):
                    note { $0.errors.append(
                        "the English engine refused the second pass: \(message) "
                        + "— the first transcript stands.") }
                }
            } else {
                note { $0.errors.append(
                    "the English engine is not loaded, so there was nothing to try instead.") }
            }
        }

        let decision = routed
        let transcript = transcribed

        // 5. Deterministic normalisation. Never a model — orthography is a lookup, not a guess.
        let cleaned = normalise(transcript.raw, decision.language)
        note {
            $0.engineID = transcript.engineID
            $0.raw = transcript.raw
            $0.result = cleaned
        }

        // 5b. An engine that heard audio and produced no words is the single most expensive
        //     defect this project has had, and the amplitude gate above cannot catch it: a fan,
        //     a door slam or mic hum clears 0.012 while containing no speech, and whisper.cpp
        //     answers those with "", " " or "[BLANK_AUDIO]". Normalisation is a third source —
        //     a raw string of punctuation can reduce to nothing. Pasting an empty string and
        //     reporting success is exactly what the previous build did.
        guard !cleaned.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            note {
                $0.errors.append(
                    "engine \(transcript.engineID) returned no words for "
                    + "\(String(format: "%.2f", buffer.duration))s of audio at peak "
                    + "\(String(format: "%.4f", buffer.peakAmplitude))")
                $0.outcome = "heardNothing"
            }
            transition(.heardNothing)
            return record!
        }

        // 6. Insert.
        //
        // Normally the raw transcript goes in immediately and the polish replaces it, because
        // polish costs multiples of the transcription and the words should not wait for it.
        //
        // `insertAfterPolish` inverts that for modes whose output is a different SHAPE — a
        // note, a message split across lines. Two reasons, and the second is the one that
        // forced it: showing a paragraph and then swapping it for a checklist is jarring, and
        // replacement is not reliable. Measured in real use, `polish replace refused; raw
        // transcript stands` on four dictations out of eight — many apps do not expose their
        // text field over Accessibility, so the polished text was computed correctly and then
        // could not be written back. The user saw the raw transcript every time and concluded
        // the modes were identical. They were not; the result was being thrown away at the
        // last inch.
        // Resolved here and not at the call site, because this is the first line that knows
        // which language the audio turned out to be in.
        var instructionSet = polishInstructions
        if instructionSet == nil, let later = polishInstructionsAfterTranscription {
            instructionSet = await later()
        }
        let instructions = instructionSet?.resolved(for: decision.language)

        // 6a. The live polish: the sentences of this transcript that were already polished during
        //     the hold are reused as they are, so key-up waits only for what changed or came
        //     last, and inserts once. Only for the family and language it was primed for;
        //     otherwise it is thrown away and 6b polishes the whole transcript after release.
        if insertAfterPolish, let session = livePolish, liveFamily == decision.family,
           session.language == decision.language {
            livePolish = nil
            transition(.polishing)
            let deadline = config.liveTailDeadline
            let outcome = await measure("polishing") {
                await session.finish(tail: cleaned, deadline: deadline)
            }
            note {
                $0.liveSentences = outcome.primed
                $0.errors += outcome.notes
            }
            if let engine = livePolishPlan?.engine {
                for remark in await engine.drainNotes() { note { $0.errors.append(remark) } }
            }
            var toInsert = cleaned
            if decision.language == .uzbek,
               case .inventedWords = UzbekPolishGuard.check(outcome.text, against: cleaned) {
                note { $0.errors.append(
                    UzbekPolishGuard.check(outcome.text, against: cleaned).reason) }
            } else if let rejection = polishGuard.check(outcome.text, against: cleaned,
                                                        instructions: instructions) {
                note { $0.errors.append("\(rejection.reason); raw transcript stands") }
            } else {
                toInsert = outcome.text
                note { $0.polished = outcome.text }
            }
            return await insertOnce(toInsert)
        }
        if let abandoned = livePolish, insertAfterPolish {
            let why = liveFamily != decision.family ? "the route changed at key-up"
                : "the language changed at key-up"
            note {
                $0.errors.append("live polish abandoned (\(why), \(abandoned.language.rawValue) → "
                                 + "\(decision.language.rawValue)); polished after release")
            }
        }
        await abandonLivePolish()

        // 6b. The whole transcript, after release.
        if insertAfterPolish, let polisher = polisher ?? self.polisher,
           let instructions,
           polisher.supportedLanguages.contains(decision.language) {
            transition(.polishing)
            let outcome = await measure("polishing") {
                await withDeadline(config.polishDeadline) {
                    try await polisher.polish(cleaned, language: decision.language,
                                              instructions: instructions)
                }
            }
            // Whatever the polisher wants on the record beyond the text — which member actually
            // ran when a composite fell back, and what failed on the way there. Drained whether
            // the outcome was a value, a failure or a timeout, because a fallback that then timed
            // out is exactly the case worth seeing.
            for remark in await polisher.drainNotes() {
                note { $0.errors.append(remark) }
            }
            var toInsert = cleaned
            switch outcome {
            case .timedOut:
                note { $0.errors.append(
                    "polish exceeded \(self.config.polishDeadline); raw transcript stands") }
            case .failed(let message):
                note { $0.errors.append(
                    "polish \(polisher.polishID) failed: \(message); raw transcript stands") }
            case .value(let polished):
                if decision.language == .uzbek,
                   case .inventedWords = UzbekPolishGuard.check(polished, against: cleaned) {
                    note { $0.errors.append(
                        UzbekPolishGuard.check(polished, against: cleaned).reason) }
                } else if let rejection = polishGuard.check(polished, against: cleaned,
                                                            instructions: instructions) {
                    note { $0.errors.append("\(rejection.reason); raw transcript stands") }
                } else {
                    toInsert = polished
                    note { $0.polished = polished }
                }
            }
            return await insertOnce(toInsert)
        }
        transition(.inserting)
        do {
            let outcome = try await measure("inserting") { try await sink.insert(cleaned) }
            switch outcome {
            case .inserted:
                stampRelease(keyUp)
            case .refused(let reason):
                fail(.insertionRefused(reason), "insertion refused: \(reason)")
                return record!
            case .timedOut:
                fail(.insertionTimedOut, "insertion timed out")
                return record!
            }
        } catch {
            fail(.insertionRefused("\(error)"), "\(error)")
            return record!
        }

        // 7. Polish, if asked. Everything past this point is a bonus: the text the user wanted
        //    is already in their app, so no failure here can fail the session.
        if let polisher = polisher ?? self.polisher, let instructions,
           polisher.supportedLanguages.contains(decision.language) {
            transition(.polishing)
            let outcome = await measure("polishing") {
                await withDeadline(config.polishDeadline) {
                    try await polisher.polish(cleaned, language: decision.language,
                                              instructions: instructions)
                }
            }
            // Whatever the polisher wants on the record beyond the text — which member actually
            // ran when a composite fell back, and what failed on the way there. Drained whether
            // the outcome was a value, a failure or a timeout, because a fallback that then timed
            // out is exactly the case worth seeing.
            for remark in await polisher.drainNotes() {
                note { $0.errors.append(remark) }
            }
            switch outcome {
            case .timedOut:
                note {
                    $0.errors.append(
                        "polish exceeded \(self.config.polishDeadline); raw transcript stands")
                }
            case .failed(let message):
                note {
                    $0.errors.append(
                        "polish \(polisher.polishID) failed: \(message); raw transcript stands")
                }
            case .value(let polished):
                // Uzbek gets a second, stricter check before the general one. Length ratio and
                // script cannot see an invented Uzbek word — it is the same length and the same
                // alphabet as the real one — and that is the measured failure: 7 of 14 real
                // polishes changed words the speaker never said, of which PolishGuard caught 1.
                if decision.language == .uzbek,
                   case .inventedWords = UzbekPolishGuard.check(polished, against: cleaned) {
                    let verdict = UzbekPolishGuard.check(polished, against: cleaned)
                    note { $0.errors.append(verdict.reason) }
                } else if let rejection = polishGuard.check(polished, against: cleaned,
                                                            instructions: instructions) {
                    note { $0.errors.append("\(rejection.reason); raw transcript stands") }
                } else if polished == cleaned {
                    // A no-op polish is not an error.
                } else if let replaced = try? await sink.replace(cleaned, with: polished),
                          replaced == .inserted {
                    note { $0.polished = polished }
                } else {
                    note { $0.errors.append("polish replace refused; raw transcript stands") }
                }
            }
        }

        note { $0.outcome = "done" }
        transition(.done)
        return record!
    }

    /// The last detection of the hold, when it heard at least as far as the likely stream's
    /// speech detector says anyone spoke — or nil, and key-up detects over the whole recording.
    ///
    /// A detection still running is waited for when *it* covers everything: it started at the
    /// last pause, so it finishes sooner than a new one would. The detector reads 30 s at most,
    /// so past that any detection that has read its full window is the final answer anyway.
    private func detectionThatHeardEverything(
        _ streams: [EngineFamily: any TranscriptionStream]
    ) async -> RouteDecision? {
        guard let early = config.earlyRouting,
              let family = likelyFamily ?? (streams[.unified] != nil ? .unified : nil),
              let stream = streams[family], let spoken = await stream.lastSpeechEnd() else {
            return nil
        }
        // Not when Turkish is on and the early "Uzbek" sounded Turkish enough to be a candidate
        // had it been long enough: the recording now may be (the 5 s floor is the whole
        // recording's), and only a detection over it can say — a Turkish dictation let go at
        // 5–6 s was otherwise settled as Uzbek by its 3 s detection.
        // (Turkish is on exactly when its engine is here — the controller adds it only then.)
        let mayBeTurkish = languageHead != nil && engines[.turkish] != nil
            && earlyDecision?.candidate == nil
            && Double(heardCount) >= config.turkishMinimumSeconds
                * Double(AudioBuffer.sampleRate)
            && (earlyDecision?.turkishShare ?? 0) >= config.turkishDoubtShare
        if let earlyDecision, earlyDecision.family == .uzbek, !mayBeTurkish,
           (earlyDecision.turkicMass ?? 0) >= early.trustUzbekMass,
           earlyCoverage >= Int(early.trustUzbekAfter * Double(AudioBuffer.sampleRate)) {
            return earlyDecision
        }
        let window = Int(early.through * Double(AudioBuffer.sampleRate))
        let needed = min(spoken, window)
        if detecting, let running = detection, detectionCoverage >= needed {
            await running.value
        }
        guard let earlyDecision, earlyCoverage >= needed else { return nil }
        return earlyDecision
    }

    /// Insert once — the path every mode that polishes before inserting ends on.
    private func insertOnce(_ text: String) async -> DictationRecord {
        transition(.inserting)
        do {
            let result = try await measure("inserting") { try await sink.insert(text) }
            switch result {
            case .inserted:
                note { $0.outcome = "done" }
                transition(.done)
                return record!
            case .refused(let reason):
                fail(.insertionRefused(reason), "insertion refused: \(reason)")
                return record!
            case .timedOut:
                fail(.insertionTimedOut, "insertion timed out")
                return record!
            }
        } catch {
            fail(.insertionRefused("\(error)"), "\(error)")
            return record!
        }
    }

    /// Key-up to the insertion's return, once, when the text went in.
    private func stampRelease(_ keyUp: Date) {
        guard record?.releaseToInsertMillis == nil, record?.outcome != "failed",
              record?.outcome != "heardNothing", record?.stageMillis["inserting"] != nil else {
            return
        }
        let millis = now().timeIntervalSince(keyUp) * 1000
        note { $0.releaseToInsertMillis = millis }
    }

    private func abandonLivePolish() async {
        await livePolish?.cancel()
        livePolish = nil
    }

    /// Delegated to `PolishGuard` (T-05), which checks length *and* script. Length alone
    /// cannot catch the measured case where a small model turned English into Russian and
    /// changed "Tuesday" to "Monday" — a translation is roughly the same length as its input.
    static func plausible(_ polished: String, given original: String) -> Bool {
        PolishGuard().check(polished, against: original) == nil
    }

    /// Distinguishes the three ways a deadlined call can end. An earlier version returned
    /// `T?` and used `try?`, which mapped a thrown error onto the same `nil` as a timeout —
    /// so a polisher that failed in 40 ms with a bad API key was recorded as "polish exceeded
    /// 8 seconds", and the real error was destroyed. On iOS `diagnostics.json` is the only
    /// inspection channel there is, so losing the error text loses it everywhere.
    enum DeadlineOutcome<T: Sendable>: Sendable {
        case value(T)
        case failed(String)
        case timedOut
    }

    /// Runs `body`, giving up on it after `duration` — and *returning* after `duration`, which is
    /// the part that was not true before.
    ///
    /// This used to be a `withTaskGroup` that took the first result and called `cancelAll()`. That
    /// bounds nothing: a task group implicitly awaits every child before it returns, and
    /// `cancelAll()` only sets a cooperative flag. A body that never checks `Task.isCancelled`
    /// therefore held the group — and the whole dictation — open for as long as it liked, while
    /// the record cheerfully claimed the deadline had been enforced.
    ///
    /// The polish path has exactly such a body: `AppleIntelligencePolisher` awaits
    /// `LanguageModelSession.respond`, and `FoundationModels` publishes no cancellation contract at
    /// all. In the `insertAfterPolish` modes the insertion sits *behind* the polish, so an
    /// unbounded wait holds finished text hostage and leaves the controller stuck reporting
    /// "still finishing the last one" at every subsequent press.
    ///
    /// Racing two unstructured tasks through one continuation does bound it. The loser is
    /// abandoned rather than awaited; `Gate` makes the handover exactly-once, so the continuation
    /// is resumed precisely one time whichever way the race falls.
    private func withDeadline<T: Sendable>(
        _ duration: Duration,
        _ body: @escaping @Sendable () async throws -> T
    ) async -> DeadlineOutcome<T> {
        let gate = Gate()
        return await withCheckedContinuation { (continuation: CheckedContinuation<DeadlineOutcome<T>, Never>) in
            let work = Task {
                let outcome: DeadlineOutcome<T>
                do { outcome = .value(try await body()) } catch { outcome = .failed("\(error)") }
                if await gate.claim() { continuation.resume(returning: outcome) }
            }
            Task {
                try? await Task.sleep(for: duration)
                guard await gate.claim() else { return }
                // Best effort, and deliberately after the claim: a cooperative body stops here, an
                // uncooperative one runs on to no one. Either way this function has already left.
                work.cancel()
                continuation.resume(returning: .timedOut)
            }
        }
    }
}

extension Language {
    /// The language to hand the unified family when nothing better is known: itself when it is
    /// one of the family's (English or Russian), English otherwise (the family decides en/ru
    /// itself anyway, and speaks none of Uzbek, Turkish or Arabic).
    var unifiedOrEnglish: Language { self == .russian ? .russian : .english }
}

/// One-shot handover between two racing tasks. An actor rather than a lock so that KotibaCore keeps
/// its zero `@unchecked Sendable` count — the audio ring buffer is where those exemptions belong.
private actor Gate {
    private var claimed = false

    /// True for exactly one caller, ever.
    func claim() -> Bool {
        if claimed { return false }
        claimed = true
        return true
    }
}
