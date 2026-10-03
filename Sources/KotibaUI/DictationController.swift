import Foundation
import KotibaAudio
import KotibaCore
import KotibaEngines
import KotibaLLM
import KotibaModels
import KotibaPlatform
import KotibaTranscribe
import Observation

#if os(macOS)
import AppKit
#endif

// The object that turns a keypress into text in someone's app.
//
// It owns the engines, the microphone, the router, the modes, the history and the settings, and
// it is the only thing a view ever talks to. Everything it owns is already tested in isolation;
// what lives here is the wiring and the state a HUD can render.
//
// The ordering rule from the architecture is preserved end to end: the raw transcript is
// inserted before polish runs, because polish costs 4–18x the transcription it polishes and
// putting it in front of the insertion is the largest self-inflicted latency error available.
// `DictationSession` enforces it; this class must not undo it by awaiting anything extra.

@Observable
@MainActor
public final class DictationController {

    // MARK: What a HUD renders

    public enum Status: Equatable, Sendable {
        case idle
        case preparing(String)
        case listening
        case working(String)
        case succeeded(String)
        /// Heard the microphone open and no words come out of it. Not an error.
        case heardNothing
        /// The whole sentence, for Home — and, in `pill`, the few words the pill says instead.
        /// The pill is 160 points of glance: "Couldn’t paste", not the reason macOS gave. `nil`
        /// (a model that failed to load, parked in readiness) makes the pill say only that it
        /// did not finish; the sentence is on Home either way.
        case failed(String, pill: String? = nil)

        public var isBusy: Bool {
            switch self {
            case .preparing, .listening, .working: return true
            case .idle, .succeeded, .heardNothing, .failed: return false
            }
        }
    }

    /// What a HUD renders — one value, but two independent facts underneath it.
    ///
    /// `Status` encodes both *app readiness* (`.preparing`, and the `.failed` that
    /// `settleStatus()` parks a model-load failure in) and the *dictation lifecycle*
    /// (`.listening`, `.working`, `.succeeded`, `.heardNothing`). Those change for unrelated
    /// reasons — a model reloading on activation has nothing to do with whether someone is
    /// holding the key — and they were sharing one variable written from six places with no rule
    /// about who wins. `isBusy` then collapsed both into the admission gate for `press()`, so
    /// re-preparing a model made the app refuse dictations with "Still finishing the last one."
    /// when nothing was finishing at all.
    ///
    /// They are separate now. This stays the single thing a view reads, and the dictation wins
    /// whenever there is one, because that is the half the user is currently looking at.
    ///
    /// "Whenever there is one" outlives the run. `status` used to be `isRunning ? dictation :
    /// readiness`, and `release()` clears `runTask` on the line after `settle()` writes
    /// `.succeeded(text)` — so the outcome was true for microseconds and then the projection
    /// snapped back to `.idle`. The HUD lingers 2.5 s reading this, so what it rendered was
    /// "Ready": never the transcript, never "I did not hear anything", never the failure message
    /// — only the failure *sound* survived, because that is played rather than displayed.
    ///
    /// The old stored `status` latched the outcome for free. A computed projection cannot, so
    /// `showsOutcome` puts the latch back explicitly: the outcome stays up until the next
    /// `press()` or `cancel()` clears it, or until readiness genuinely changes underneath it.
    /// The admission gate is deliberately not this — it asks `isRunning`, which no latch can
    /// reach, so a stale outcome on screen can never refuse a dictation again.
    public var status: Status { isRunning || showsOutcome ? dictation : readiness }

    /// Whether `dictation` is holding a finished outcome that has not been superseded.
    ///
    /// Set by `settle()`, cleared by `press()`, `cancel()` and by any real change in `readiness`.
    /// A model that starts loading, or one that fails to, is news the user needs more than a
    /// transcript they have already been given — and it is the only thing besides the next press
    /// that is allowed to take the HUD back.
    private(set) var showsOutcome = false

    /// Whether a dictation is actually in flight — held, or still finishing after key-up.
    ///
    /// The guards in `recheck()` and the HUD's projection ask this. It is *not* the admission gate
    /// any more: a press is admitted whenever the key is not already held (`session == nil`),
    /// however many earlier dictations are still transcribing — see `press()`. Every entry in
    /// `runs` removes itself as the last line of its own task, so this cannot latch.
    public var isRunning: Bool { session != nil || !runs.isEmpty }

    /// Written only by `start`, `prepareEngines`, `settleStatus` and `recheck`.
    ///
    /// Internal rather than private so a test can put the app into "a model is loading" without
    /// a 539 MB model to load. Invisible outside this module either way; the ownership rule
    /// above is the thing that matters, and it is enforced by there being exactly one writer set.
    var readiness: Status = .idle {
        didSet {
            // Only a change. `settleStatus()` re-writes `.idle` over `.idle` on every activation,
            // and treating that as news would wipe the transcript off the HUD for anyone who
            // clicks the menu-bar item after dictating.
            if readiness != oldValue { showsOutcome = false }
        }
    }
    /// Written only by `press`, `release` and `settle`.
    var dictation: Status = .idle
    /// Live microphone level, 0…1, for the HUD's meter. Written while listening.
    public private(set) var level: Float = 0
    public private(set) var lastTranscript: String = ""
    public private(set) var lastRecord: DictationRecord?
    public private(set) var history: [HistoryEntry] = []
    /// Which mode the next dictation will use, resolved from the frontmost app.
    public private(set) var activeModeKey: String = "transcription"

    /// Problems the user can fix — no microphone grant, no Uzbek model, no Accessibility.
    /// Rendered as calm notices on Home and a list in the menu, rather than surfaced one at a time
    /// as failures.
    ///
    /// Only what needs the user. A state that heals itself is never one of these: a microphone
    /// whose device changed is rebuilt on the next press (`refreshBlockers` leaves it out), and a
    /// model that is downloading right now is not "missing" — its row is held back here for as
    /// long as the download runs, and comes back if the download fails. On 2026-09-30 the owner
    /// saw "The microphone is not ready — the input device changed" nearly every time the window
    /// opened, under a banner saying something was stopping Kotiba from working. Nothing was.
    public var blockers: [Blocker] {
        detectedBlockers.filter { !Self.heals($0, models: models) }
    }

    /// Everything `refreshBlockers` found, before the self-healing rows are held back.
    private(set) var detectedBlockers: [Blocker] = []

    /// Whether a blocker is a download that is already fixing it.
    static func heals(_ blocker: Blocker, models: ModelDownloads?) -> Bool {
        let item: ModelDownloads.Item
        switch blocker.id {
        case "uzbek-model": item = .uzbek
        case "no-polisher": item = .modes
        // Russian before Parakeet lands: "getting ready", not "missing".
        case "russian-model": item = .parakeet
        default: return false
        }
        switch models?.state(item) {
        case .queued, .downloading: return true
        default: return false
        }
    }

    /// The last dictation finished with nothing focused to paste into, so its text is on the
    /// clipboard (and in History) instead. Set by `ClipboardFallbackSink`, cleared by the next
    /// press. The pill and Home say so, softly; see KotibaPlatform/ClipboardFallback.swift.
    public private(set) var lastWentToClipboard = false

    /// Set by the app when `RenameMigration` found the old Kotib still running and moved
    /// nothing. Home then says why Kotiba started empty. See `RenameNotice`.
    public var renameMigrationDeferred = false

    // MARK: Quiet microphone

    /// A heard-nothing take that looks like a microphone problem rather than silence: a real hold,
    /// a peak under `QuietMic.peakBelow`, and a device to name. Set by `settle` at most once per
    /// device per hour (`QuietMicLimiter`); cleared by the next dictation that comes out as text,
    /// by the person dismissing it, and never by time alone — the microphone is still quiet.
    public private(set) var quietMic: InputDeviceInfo?
    /// The same device, for the pill of *this* outcome only: nil for every other one.
    public private(set) var quietMicForPill: InputDeviceInfo?
    private var quietMicLimiter = QuietMicLimiter()
    /// Where "Open Sound settings" goes: the Input tab, so the level meter is what is on screen.
    public static let soundInputSettingsURL =
        "x-apple.systempreferences:com.apple.Sound-Settings.extension?input"

    /// The Home notice for `quietMic`: the device by name, what kind of input it is, and the
    /// button. Built on demand so a language switch rewords it.
    public var quietMicNotice: Blocker? {
        guard let device = quietMic else { return nil }
        let detail: String
        switch QuietMic.kind(of: device) {
        case .continuity: detail = L("home.quietMic.detail.continuity")
        case .external: detail = L("home.quietMic.detail.external")
        case .builtIn: detail = L("home.quietMic.detail.builtIn")
        }
        return Blocker(id: "quiet-mic", title: L("home.quietMic.title", device.name),
                       detail: detail, settingsURL: Self.soundInputSettingsURL)
    }

    public func dismissQuietMic() { quietMic = nil }

    /// What `settle` does with a finished take's outcome, factored out so a test can drive it
    /// with a made-up record and never a microphone. Returns whether the hint was raised.
    @discardableResult
    func noteQuietMic(_ record: DictationRecord, ownsHUD: Bool, now: Date = Date()) -> Bool {
        if record.outcome == "done" { quietMic = nil }
        quietMicForPill = nil
        guard let device = QuietMic.suspect(record), quietMicLimiter.admit(device, now: now) else {
            return false
        }
        quietMic = device
        if ownsHUD { quietMicForPill = device }
        return true
    }

    public struct Blocker: Identifiable, Equatable, Sendable {
        public var id: String
        public var title: String
        public var detail: String
        /// A System Settings pane to open, when there is one.
        public var settingsURL: String?
    }

    // MARK: Owned pieces

    public let settings: AppSettings
    public private(set) var modes: ModeRegistry

    /// The hardware a dictation touches: where audio comes from and where text goes. The app
    /// passes `.live`; a test passes a silent microphone and a sink that records, so no test ever
    /// opens the owner's microphone or pastes into whatever window happens to be in front — and
    /// `kotiba-probe e2e` passes a microphone that plays WAVs, so the whole press → paste path can
    /// be timed with known audio.
    public struct Devices: Sendable {
        public var microphone: any DictationMicrophone
        public var sink: @Sendable () -> any TextSink
        /// What happens when a dictation has nowhere to paste. `.never` unless the app says: a
        /// test's sink has no clipboard to leave anything on.
        public var noTextTarget: NoTextTargetFallback

        public init(microphone: any DictationMicrophone,
                    sink: @escaping @Sendable () -> any TextSink,
                    noTextTarget: NoTextTargetFallback = .never) {
            self.microphone = microphone
            self.sink = sink
            self.noTextTarget = noTextTarget
        }

        /// The Mac's microphone and the real paste.
        public static func live() -> Devices {
            #if os(macOS)
            Devices(microphone: MicrophoneSource(), sink: { Insertion.sink() }, noTextTarget: .live)
            #else
            Devices(microphone: MicrophoneSource(), sink: { Insertion.sink() })
            #endif
        }
    }

    private let microphone: any DictationMicrophone
    private let makeSink: @Sendable () -> any TextSink
    private let noTextTarget: NoTextTargetFallback
    private let appleEngine = AppleSpeechEngine()
    /// English and Russian: Parakeet Ultra on the Neural Engine (docs/research/C1). Its 632 MB
    /// are part of the core download (`ModelDownloads.Item.core`), which is the ONE thing that
    /// fetches it: the engine's own first-use fetch is off (`autoDownload: false`), because two
    /// writers on one Core ML directory is a race `ModelStore.ensure(_: ModelBundle)` does not
    /// guard. Until it lands Apple answers English, and Russian waits for it (the
    /// "russian-model" blocker reads as getting ready while the download runs).
    private let parakeetEngine: ParakeetEngine
    /// The one store for the models directory: the engines' own first-use fetches, the download
    /// step and the settings buttons all go through it, so a file is never written twice at once.
    @ObservationIgnored private let modelStore: ModelStore
    /// The recommended models, their state on disk, and the downloads that fetch them.
    @ObservationIgnored public private(set) var models: ModelDownloads!
    private var uzbekEngine: WhisperEngine?
    /// whisper large-v3-turbo: Russian's fallback while Parakeet is missing, Turkish's engine, and
    /// Arabic's fallback (D-11). One context for all three — a second would be another ~800 MB —
    /// built with flash attention off because the Turkish and Arabic streams hand it fitted
    /// windows (`WhisperEngine.Options.flashAttention`), and with a prompt per language.
    private var russianEngine: WhisperEngine?
    /// Cohere Transcribe Arabic, when Arabic is on and its 1.77 GB file is on disk.
    private var cohereEngine: CohereArabicEngine?
    /// The Arabic family's decoder: Cohere with turbo behind it, or turbo alone. Rebuilt when
    /// either changes; shared by every dictation, like the engines inside it.
    private var arabicDecoder: ArabicSegmentDecoder?
    /// The turbo engine `arabicDecoder` was built around, to notice when it is replaced.
    private var arabicDecoderTurbo: WhisperEngine?
    private var detector: WhisperLanguageDetector?
    /// The language-ID model (P4, D-14). When it is loaded it is the router's classifier and the
    /// session decides the language after transcription (`DictationSession.Config.languageID`);
    /// `detector` (whisper base) is the fallback until it has downloaded.
    private var languageID: EcapaLanguageIdentifier?
    private var historyStore: HistoryStore?
    private var diagnostics: DiagnosticsStore?

    /// Why a language's model would not load, kept so it can be shown.
    ///
    /// Every one of these used to be discarded: `prepareEngines` set `.failed`, the next line
    /// set `.idle`, and the on-demand load used `try?`. The user was then told "no engine
    /// ready", which names the wrong cause — and `WhisperEngine.failureReason()` existed for
    /// exactly this and had no caller anywhere.
    private var loadFailures: [Language: String] = [:]
    private var historyOpenError: String?
    private var diagnosticsOpenError: String?
    /// Why the event tap would not start, when it would not. Owned here rather than in the app
    /// shell because `blockers` is the one list the user actually reads.
    private var hotkeyFailure: String?
    /// A store that opened and then stopped accepting writes — a full disk, a file deleted from
    /// under the open handle, a revoked permission. `openStores()` was careful about a store that
    /// will not open and then every write went through `try?`, so the far more likely failure was
    /// the invisible one: history simply stops growing and looks like a quiet week.
    private var historyWriteError: String?
    private var diagnosticsWriteError: String?

    /// The dictation whose key is down right now. At most one.
    private var session: DictationSession?
    /// Its audio, its place in the paste queue, and its arming — kept so `cancel()` can end
    /// exactly this dictation and nothing that is still finishing.
    private var take: (any LiveAudioSource)?
    private var ticket: InsertionTurns.Ticket?
    /// The mode resolved at its key-down. See `press()`.
    private var heldMode: Mode?
    private var armTask: Task<Void, Never>?
    private var levelTask: Task<Void, Never>?
    /// Dictations that have been released and are still transcribing, polishing or pasting,
    /// keyed by the press that started them. More than one when the user presses again before
    /// the last one finished — which is allowed now.
    private var runs: [UInt64: Task<Void, Never>] = [:]
    /// Counts presses. The HUD belongs to the newest one: an older dictation finishing while the
    /// user is speaking the next one must not replace "Listening" with its own transcript.
    private var pressCount: UInt64 = 0
    /// N pastes before N+1, whatever order they finish in. See `InsertionOrder.swift`.
    private let pasteTurns = InsertionTurns()
    /// Lowers what is playing while the key is held. Inert until the app installs the real one
    /// (`installDucking`) — a controller built by a test must never move this Mac's volume.
    private var ducker = PlaybackDucking.inert
    /// The on-demand model load started at key-down. See `press()`.
    private var loadTask: Task<Void, Never>?
    /// The poll that gives the models back. See `armIdleUnload()`.
    private var idleUnloadTimer: Timer?
    /// Releases Parakeet when macOS says memory is short — the one time its ~635 MB of wired
    /// Neural Engine weights are worth more than a warm English/Russian engine. See
    /// `releaseModels()` for why the idle timer does not.
    private var memoryPressure: (any DispatchSourceMemoryPressure)?
    /// When the user last did anything with a model. The countdown is measured from here.
    private var lastActivityAt = Date()

    /// Whether whisper weights are currently resident, for the settings pane and the tests.
    public private(set) var modelsResident: Bool = false

    /// The order the language pickers list in — default, then by the last 30 days' usage.
    public let languageOrder: LanguageOrderModel

    public init(settings: AppSettings = AppSettings(), devices: Devices) {
        self.settings = settings
        self.languageOrder = LanguageOrderModel(
            url: settings.stateDirectory.appendingPathComponent("diagnostics.jsonl"))
        self.microphone = devices.microphone
        self.makeSink = devices.sink
        self.noTextTarget = devices.noTextTarget
        let store = ModelStore(root: settings.modelsDirectory)
        self.modelStore = store
        // A `--with-models` bundle carries Parakeet inside; it is used in place until (unless)
        // the models directory has its own copy.
        let bundledRoot = Self.bundledModels
        let parakeetRoot = bundledRoot.flatMap { root in
            FileManager.default.fileExists(atPath: root.appendingPathComponent(
                ModelCatalogue.parakeetUltra.directory).path) ? root : nil
        }
        self.parakeetEngine = ParakeetEngine(
            variant: .ultra, modelsRoot: settings.modelsDirectory,
            store: parakeetRoot.map { ModelStore(root: $0) } ?? store,
            autoDownload: false,
            speechDetectorURL: SileroSpeechDetector.locate(in: Self.modelDirectories(settings)))
        // BuiltInModes.registry() only throws if a shipped prompt fails validation, which is a
        // programmer error caught by a test, not something a user can cause.
        self.modes = (try? BuiltInModes.registry()) ?? ModeRegistry.emptyFallback
        self.modes.defaultKey = settings.defaultModeKey
        self.activeModeKey = settings.defaultModeKey
        self.models = ModelDownloads(controller: self)
    }

    // MARK: - Startup

    /// Everything that must happen before the first press, done at launch rather than on the
    /// critical path. Loading whisper cold is 7.8 s; paying that at the first Uzbek dictation
    /// would read as the app being broken.
    public func start() async {
        try? FileManager.default.createDirectory(at: settings.stateDirectory,
                                                 withIntermediateDirectories: true)
        openStores()
        await refreshBlockers()
        watchMemoryPressure()
        // The language pickers' first usage sort, so the menu-bar section is right before any
        // window has opened.
        await languageOrder.refresh()

        // The microphone is warmed *alongside* the models, never in front of them.
        //
        // Warm-up ends in a permission dialog on a first run, and a dialog waits for a person.
        // An earlier version awaited it here and every line below never ran: the app sat with
        // 110 MB resident and neither model open until someone clicked Allow — and then paid
        // the 7.8 s cold load on the first Uzbek dictation instead. Loading weights needs no
        // permission, so it has no business queueing behind one.
        // Chosen before the first warm-up, not at the first press: an idle warm graph on a
        // headset microphone holds the headset in its phone-call profile from launch onwards.
        microphone.setPrefersBuiltInMicWithBluetooth(settings.preferBuiltInMicWithBluetooth)
        let warmUp = Task { await self.microphone.warmUp() }
        // The 39k-word English list key-up reads Parakeet's transcript against
        // (`TranscriptCheck`, session step 4a′) is built here, off the main actor, rather than
        // on the first unpinned key-up.
        // …and the other four word lists the language decision reads (P4), ~0.1 s.
        Task.detached(priority: .utility) { Lexicon.warmUp() }

        readiness = .preparing(Self.modelName(of: .english))
        try? await appleEngine.prepare()

        // Only the language the user actually speaks is loaded now. The others are built but
        // left unprepared, and `WhisperEngine.transcribe` loads on first use — because two
        // whisper models resident is 1.47 GB against 110 MB, and most people dictate in one
        // language most days. `preloadAllLanguages` buys the latency back for those who don't.
        await prepareEngines(eagerly: settings.preloadAllLanguages)
        settleStatus()

        await warmUp.value
        await refreshBlockers()
        await reloadHistory()
    }

    private func openStores() {
        let directory = settings.stateDirectory
        // Caught rather than `try?`. A store that will not open is indistinguishable from an
        // empty one to every reader below it, and the diagnostics store is the mechanism this
        // project relies on to make failures visible — so its own failure being invisible is
        // the worst possible instance of the pattern.
        //
        // An open store is kept. This runs on every settings change, and reopening made a
        // second actor over the same file while a dictation settling at that moment still wrote
        // through the first: two SQLite connections, and two JSON-lines writers of which one
        // may be rewriting the file to trim it — dropping the other's line.
        if !settings.keepHistory { historyStore = nil }
        historyOpenError = nil
        if settings.keepHistory, historyStore == nil {
            do {
                historyStore = try HistoryStore(
                    path: directory.appendingPathComponent("history.sqlite").path)
                Task { await seedLanguageCounts() }
            } catch {
                historyOpenError = (error as? HistoryError)?.reason ?? "\(error)"
            }
        }
        if !settings.diagnosticsEnabled { diagnostics = nil }
        diagnosticsOpenError = nil
        if settings.diagnosticsEnabled, diagnostics == nil {
            do {
                diagnostics = try DiagnosticsStore(
                    url: directory.appendingPathComponent("diagnostics.jsonl"),
                    environment: Self.environment)
            } catch {
                diagnosticsOpenError = "\(error)"
            }
        }
    }

    private static var environment: DiagnosticsEnvironment {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return DiagnosticsEnvironment(
            appVersion: (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String)
                ?? "dev",
            osVersion: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            device: "mac",
            locale: Locale.current.identifier)
    }

    /// Builds an engine per configured model, and loads the weights for the ones that are
    /// worth paying for now.
    private func prepareEngines(eagerly: Bool) async {
        // `reuseOrBuild`, and uzbek-accuracy's resolved paths: keep the engine that is already
        // there when its model file has not moved, and resolve the path the way that branch
        // established rather than reading the raw setting.
        uzbekEngine = reuseOrBuild(uzbekEngine, path: settings.resolvedUzbekPath ?? "",
                                   language: .uzbek)
        russianEngine = reuseOrBuild(russianEngine, path: settings.resolvedRussianPath ?? "",
                                     language: .russian)
        refreshOptionalEngines()

        // The detector is small enough to keep resident unconditionally — 59 MB against the
        // 539 MB the transcribing model costs — and it has to be warm, because it sits on the
        // critical path at key-release where a cold load would be seconds.
        // The language-ID model first (P4): ~43 MB on the CPU, resident like the detector.
        if settings.autoDetectReady, let path = settings.resolvedLanguageIDPath {
            if languageID?.modelURL.path != path {
                languageID = EcapaLanguageIdentifier(modelURL: URL(fileURLWithPath: path))
            }
            do {
                try await languageID?.prepare()
            } catch {
                languageID = nil
            }
        } else {
            languageID = nil
        }
        if settings.autoDetectReady, languageID == nil, let path = settings.resolvedDetectorPath {
            if detector?.modelURL.path != path {
                detector = WhisperLanguageDetector(modelURL: URL(fileURLWithPath: path))
            }
            do {
                try await detector?.prepare()
                loadFailures[.english] = nil
            } catch {
                detector = nil
                loadFailures[.english] = L("error.detectionOff", Self.describe(error))
            }
        } else {
            detector = nil
        }

        // Always, whatever the default language: it is the engine for 95 % of dictations. On a
        // machine without the weights this throws "not downloaded yet" at once, which is not a
        // failure to report — the core download is fetching them, Apple covers English
        // meanwhile, and `install(.parakeet)` loads the engine when they land. A real failure
        // stays readable through `unifiedEngineStatus()`.
        // …unless English and Russian are both off: then nothing ever routes to it.
        if settings.languageSubset.families.contains(.unified) {
            try? await parakeetEngine.prepare()
        }
        parakeetInstalled = await parakeetEngine.isDownloaded()

        for language in [Language.uzbek, .russian] + Language.allCases.filter(\.isOptional) {
            guard let engine = engine(for: language) else { continue }
            guard eagerly || language == settings.defaultLanguage else { continue }
            readiness = .preparing(Self.modelName(of: language))
            do {
                try await engine.prepare()
                loadFailures[language] = nil
            } catch {
                loadFailures[language] = Self.describe(error)
            }
        }

        await releaseLanguagesTurnedOff()
        // Anything loaded here starts the clock too. A launch that preloads the default
        // language and is then never dictated into would otherwise hold it forever — which is
        // the majority of this app's day.
        await refreshResidency()
        armIdleUnload()
    }

    /// Cohere and the Arabic decoder, for what the settings say now: built when Arabic is on and
    /// its file is on disk, dropped (and with it ~2 GB) when it is turned off, rebuilt when the
    /// turbo engine behind it was replaced. Cheap: nothing here reads a file.
    private func refreshOptionalEngines() {
        let arabicPath = settings.enabledOptionalLanguages.contains(.arabic)
            ? settings.resolvedArabicPath : nil
        if cohereEngine?.modelURL.path != arabicPath {
            cohereEngine = arabicPath.map { CohereArabicEngine(modelURL: URL(fileURLWithPath: $0)) }
            arabicDecoder = nil
        }
        if arabicDecoder == nil || arabicDecoderTurbo !== russianEngine {
            arabicDecoder = cohereEngine != nil || russianEngine != nil
                ? ArabicSegmentDecoder(cohere: cohereEngine, fallback: russianEngine) : nil
            arabicDecoderTurbo = russianEngine
        }
    }

    /// Whether the configured models differ from the loaded ones.
    ///
    /// Static and separate so the rule can be tested directly. Its side effect — tearing down a
    /// 539 MB context and reloading it — is not observable from a test without a real model, so
    /// a test of the *behaviour* had no teeth and this had to become a testable *rule*.
    ///
    /// The subtlety it exists for: `build()` returns nil for a path that is empty or absent, so
    /// comparing a `String?` engine path against a raw `String` setting makes `nil != ""` true
    /// and the answer unconditionally "changed" for anyone who has not configured both models —
    /// which is the default state, and the permanent state of an Uzbek-only user.
    static func modelsChanged(loadedUzbek: String?, loadedRussian: String?,
                              settings: AppSettings) -> Bool {
        // The *resolved* paths, not the raw settings: a bundled or auto-discovered model is a real
        // model, and comparing a loaded engine against the empty setting that found it would report
        // a change on every settings save and reload 1.1 GB each time.
        return (loadedUzbek ?? "") != (settings.resolvedUzbekPath ?? "")
            || (loadedRussian ?? "") != (settings.resolvedRussianPath ?? "")
    }

    /// Which language to page in at key-down, or nil when it genuinely cannot be known yet.
    ///
    /// Static and separate for the same reason as `modelsChanged`: the effect — a 539 MB load —
    /// is not observable from a test without real weights, so the *rule* is what gets tested.
    ///
    /// This used to be `mode.language ?? settings.defaultLanguage`, which is wrong twice over. No
    /// shipped mode pins a language, so it always resolved to `defaultLanguage`; and that is
    /// English by default, for which `engine(for:)` returns nil. The preload therefore did nothing
    /// at all in the shipped configuration — the case it was written for.
    ///
    /// A pin settles it. With auto-detect off, the default language is the only one the router can
    /// return. With auto-detect on the router does not decide until key-*up*, so this is a guess,
    /// and the only guess worth making is the forced one: if exactly one whisper model is
    /// configured then the router's whole choice is between that language and English, and English
    /// is Apple's engine, which needs no paging in. Two models configured and no pin means no
    /// honest guess exists — leave it to the session, which now loads on demand.
    ///
    /// "Configured" is asked of the *resolved* path, not the raw setting — the same three steps
    /// the engines themselves are built from. A bundled install leaves `uzbekModelPath` empty and
    /// finds its weights inside the app bundle, so reading the raw setting here made `configured`
    /// empty for every user who was handed the .dmg: exactly the audience that never opens
    /// Settings, and the only one for whom this optimisation was ever the difference between a
    /// warm dictation and a 7.8 s cold load.
    ///
    /// Two refinements since Parakeet arrived. Russian's whisper model is only a fallback once
    /// Parakeet is on disk (`russianOnParakeet`), so it is not a candidate at all — which makes
    /// Uzbek the one whisper language again for anyone with both files. And with two genuine
    /// candidates, the language of the last dictation (`lastRouted`) is a better guess than none:
    /// people dictate in runs, and the alternative is the Uzbek model loading at the first pause
    /// of the first Uzbek dictation after an idle release, behind the speaker but not always
    /// ahead of the key.
    static func languageToPreload(pin: Language?, settings: AppSettings,
                                  russianOnParakeet: Bool = false,
                                  lastRouted: Language? = nil) -> Language? {
        if let pin { return pin }
        let on = settings.languageSubset
        if let sole = on.soleRoute(preferring: settings.defaultLanguage) { return sole }
        guard settings.autoDetectReady else { return on.fallback(preferring: settings.defaultLanguage) }
        let configured = [Language.uzbek, .russian].filter(on.contains).filter { language in
            language == .uzbek ? settings.uzbekReady
                : settings.russianReady && !russianOnParakeet
        }
        if configured.count == 1 { return configured[0] }
        if let lastRouted, configured.contains(lastRouted) { return lastRouted }
        return nil
    }

    /// What this mode's key-down preload should page in, pin and all.
    ///
    /// Internal, and separate from the static rule above, because the *pin* was the half that was
    /// wrong at the call site: it passed `mode.language` alone. No shipped mode pins a language,
    /// so a user who had explicitly chosen one in Settings › Languages — the only way to overrule
    /// the acoustic router, and the thing `pinFromSettings()` puts first at key-*up* — got the
    /// auto-detect guess at key-*down* instead: nothing at all when both models are present,
    /// which is exactly the configuration a pin exists for.
    func languageToPreload(for mode: Mode) -> Language? {
        Self.languageToPreload(pin: [mode.language, settings.pinnedLanguage].compactMap { $0 }
                                   .first(where: settings.languageSubset.contains),
                               settings: settings,
                               russianOnParakeet: parakeetInstalled, lastRouted: lastRouted)
    }

    /// Whether Parakeet's weights are on disk — then Russian never needs its whisper model.
    /// Cached, because the answer is an actor call and the key-down path is synchronous.
    private var parakeetInstalled = false
    /// The language the last finished dictation was routed to. See `languageToPreload`.
    private var lastRouted: Language?

    private func preload(_ engine: (any TranscriptionEngine)?, _ language: Language) async {
        guard let engine else { return }
        do {
            try await engine.prepare()
            loadFailures[language] = nil
        } catch {
            loadFailures[language] = Self.describe(error)
        }
    }

    // MARK: - Giving the memory back

    // Loading on demand is only half a policy. The other half — releasing — was written into
    // `WhisperEngine.unload()` and never called from anywhere, so "lazily loaded" meant "loaded
    // at the first Uzbek dictation and resident until you quit". A menu-bar app is quit roughly
    // never: this one measured 1618 MB of footprint, 1395 MB of it whisper contexts, after
    // sitting through a few dictations.
    //
    // So the models are held only while they are being used, plus a grace period. What survives
    // the release is deliberate: Apple's English engine, which is the system's memory and not
    // ours, and the 59 MB detector, which sits on the critical path at key-*release* where a
    // cold load would be seconds the user watches. The two big models reload behind the user's
    // speech at key-down like they already do on a first dictation.

    /// How long to wait before releasing, or nil for never.
    ///
    /// Static and separate for the same reason `modelsChanged` is: the effect — tearing down a
    /// gigabyte of context — is not observable in a test without a real model on disk, so the
    /// part worth testing is the *rule* about when it happens.
    static func idleUnloadDelay(settings: AppSettings) -> Duration? {
        // `preloadAllLanguages` deliberately does NOT suppress this, though an earlier cut of
        // this change had it do exactly that. The two settings answer different questions:
        // preload is about *when* a model loads — eagerly at launch, rather than at the first
        // dictation in that language — and this is about how long an unused one is kept. Making
        // preload mean "and never give it back" is what produced the report this fixes: a
        // machine with it on sat at 1618 MB permanently, and an idle timer that stood down for
        // it would have changed nothing on the configuration that actually had the problem.
        guard settings.modelIdleUnloadMinutes > 0 else { return nil }
        return .seconds(settings.modelIdleUnloadMinutes * 60)
    }

    /// How often the countdown is checked. The release lands within one of these of the
    /// timeout, so it is a quarter of it — capped at 30 s, because past that the extra
    /// punctuality on a five-minute timeout is worth nothing, and floored at a second so a
    /// deliberately tiny timeout in a test is still observed rather than slept through.
    static func pollInterval(for delay: Duration) -> TimeInterval {
        min(30, max(1, delay.seconds / 4))
    }

    /// Note that a model was just used, so the countdown starts again from now.
    private func noteActivity() { lastActivityAt = Date() }

    /// Start polling for the moment the models can go back.
    ///
    /// A repeating timer checking wall-clock elapsed time, and deliberately NOT a single
    /// `Task.sleep(for: .seconds(300))` — which is what the first version of this did, passed
    /// every test, and then never fired once installed.
    ///
    /// The reason is App Nap. Kotiba is an `LSUIElement` app with no windows, so once it has sat
    /// idle for a while macOS decides it is doing nothing and defers its timers indefinitely.
    /// Measured on this machine: a 60 s countdown fired on the nose, because the app had only
    /// just launched and was not yet napped, while a 300 s one had still not fired eight
    /// minutes later. A test process is in the foreground and never napped, so the bug was
    /// invisible to every unit test — including the one written for this feature.
    ///
    /// Polling against `lastActivityAt` is robust to exactly that: a deferred fire still sees
    /// the true elapsed time and releases. Late is a fine outcome here; never is not.
    private func armIdleUnload() {
        noteActivity()
        guard let delay = Self.idleUnloadDelay(settings: settings) else {
            cancelIdleUnload()
            return
        }
        guard idleUnloadTimer == nil else { return }   // already polling; the note above re-set it
        let interval = Self.pollInterval(for: delay)
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.idleTick() }
        }
        // Generous, because the exact second is worth nothing and the wake-ups are not free.
        timer.tolerance = interval / 2
        RunLoop.main.add(timer, forMode: .common)
        idleUnloadTimer = timer
    }

    private func idleTick() async {
        guard let delay = Self.idleUnloadDelay(settings: settings) else {
            cancelIdleUnload()
            return
        }
        guard !status.isBusy else { return }
        guard Date().timeIntervalSince(lastActivityAt) >= delay.seconds else { return }
        await releaseModels()
        // Nothing left to release until something loads again, and that path arms a new timer.
        cancelIdleUnload()
    }

    private func cancelIdleUnload() {
        idleUnloadTimer?.invalidate()
        idleUnloadTimer = nil
    }

    /// Drop the whisper weights now. Safe at any time; the next press reloads what it needs.
    ///
    /// Unloading under a decode would be a use-after-free if the context were freed out from
    /// under `whisper_full` — it is not. `WhisperEngine.transcribe` captures the context as a
    /// strong local before it enters `Task.detached`, so clearing the actor's reference only
    /// drops *an* owner; the running decode keeps the object alive to its own end. The busy
    /// check below is therefore about not making the user wait for a reload they did not ask
    /// for, not about safety.
    public func releaseModels() async {
        guard !status.isBusy else { return }   // mid-dictation; the poll will come back round
        await uzbekEngine?.unload()
        await russianEngine?.unload()
        // Cohere is ~2 GB resident on Metal (C4 §5): the largest thing the app can hold.
        await cohereEngine?.unload()
        // The modes' model on the same clock. `LlamaEngine` has a timer of its own, but it is a
        // single `Task.sleep` — exactly the shape App Nap defers indefinitely in this app (see
        // `armIdleUnload`) — so this poll is what actually gives its 1.28 GB back.
        await llamaPolisher?.unload()
        // Arabic's modes model (3.1 GB, C4 §14.5) on the same clock.
        await arabicModesPolisher?.unload()
        // Parakeet is deliberately not released here. It is the engine for ~95 % of dictations,
        // and a reload is 0.15 s only while its compiled Neural Engine plan survives in
        // ~/Library/Caches — which macOS purges under disk pressure: measured on this Mac at
        // < 7 GB free, every reload recompiled for 13–24 s, and every dictation in that window
        // fell back to Apple/whisper. Its cost is ~635 MB wired while loaded (C1 §6); the
        // whisper models this releases are the 1.4 GB that motivated the timer.
        // `ParakeetEngine.unload()` is safe at any time if that trade is ever reversed.
        await refreshResidency()
    }

    /// Under memory pressure everything that can reload goes, Parakeet included. The next press
    /// pages it back in (`press()`); if the compiled plan was purged too, that dictation is
    /// answered by Apple or whisper while it recompiles, which is the right order of priorities
    /// on a machine that is out of memory.
    private func watchMemoryPressure() {
        guard memoryPressure == nil else { return }
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical],
                                                             queue: .main)
        source.setEventHandler { [weak self] in
            Task { @MainActor in
                guard let self, !self.status.isBusy else { return }
                await self.releaseModels()
                await self.parakeetEngine.unload()
                await self.detector?.unload()
                await self.languageID?.unload()
            }
        }
        source.resume()
        memoryPressure = source
    }

    /// Give back what only languages that are off were holding: the Uzbek model, turbo (Russian's
    /// fallback, Turkish's engine, Arabic's head and fallback — kept while any of the three is
    /// on), Arabic's modes model, and Parakeet once English and Russian are both off. Cohere
    /// already goes with Arabic (`refreshOptionalEngines`). Nothing is deleted; the files stay
    /// until the user removes them in Languages.
    private func releaseLanguagesTurnedOff() async {
        let on = settings.languageSubset
        if !on.contains(.uzbek) { await uzbekEngine?.unload() }
        if on.languages.isDisjoint(with: [.russian, .turkish, .arabic]) {
            await russianEngine?.unload()
        }
        if !on.contains(.arabic) { await arabicModesPolisher?.unload() }
        if !on.families.contains(.unified) { await parakeetEngine.unload() }
    }

    private func refreshResidency() async {
        var resident = false
        for engine in [uzbekEngine, russianEngine] {
            guard let engine else { continue }
            if await engine.isReady() { resident = true }
        }
        if await cohereEngine?.isReady() == true { resident = true }
        modelsResident = resident
    }

    /// Back to idle — unless something actually broke, in which case saying "idle" would erase
    /// the only diagnosis there is.
    private func settleStatus() {
        if let failure = loadFailures.values.first {
            readiness = .failed(failure)
        } else {
            readiness = .idle
        }
    }

    /// Constructing an engine reads nothing from disk; only `prepare()` does. That split is
    /// what lets a language be configured-but-not-resident.
    private func build(path: String, language: Language) -> WhisperEngine? {
        guard AppSettings.modelExists(path) else { return nil }
        return WhisperEngine(
            modelURL: URL(fileURLWithPath: path),
            supportedLanguages: Self.languagesServed(by: language),
            options: whisperOptions(for: language))
    }

    /// The languages one whisper file serves: turbo (the "Russian" slot) is Turkish's engine and
    /// Arabic's fallback too (D-11).
    static func languagesServed(by slot: Language) -> Set<Language> {
        slot == .russian ? [.russian, .turkish, .arabic] : [slot]
    }

    /// Keep the engine that is already there when it still points at the same file.
    ///
    /// Building a replacement drops the old one, and with it a resident 539 MB context that then
    /// costs ~7.8 s to read back off disk. `prepareEngines` runs on every foreground via
    /// `recheck()`, so an unguarded rebuild made clicking the menu-bar icon pay for a model that
    /// had not moved — repeatedly, and on the MainActor path. The detector below has always been
    /// reused this way; the transcribing engines were not, and they are the expensive ones.
    private func reuseOrBuild(_ existing: WhisperEngine?, path: String,
                              language: Language) -> WhisperEngine? {
        let wanted: String? = AppSettings.modelExists(path) ? path : nil
        if let existing, existing.modelURL.path == wanted { return existing }
        return build(path: path, language: language)
    }

    func recordLoadResult(_ language: Language, failure: String?) {
        loadFailures[language] = failure
    }

    /// Told by the app shell whether the hotkey tap is actually running. Nil clears it.
    public func recordHotkeyFailure(_ reason: String?) {
        hotkeyFailure = reason
    }

    // MARK: - Getting a model

    /// Where downloaded models go. The same directory the manual picker and `make bootstrap`
    /// already use, so a model fetched either way is found by the other — and, through the
    /// settings, a temporary one in a test.
    private var modelsRoot: URL { settings.modelsDirectory }

    /// Where a model may be found: the models directory, then the app bundle's own copy (a
    /// `make-dmg.sh --with-models` build carries its weights inside).
    static func modelDirectories(_ settings: AppSettings) -> [URL] {
        [settings.modelsDirectory] + (bundledModels.map { [$0] } ?? [])
    }

    /// `Contents/Resources/models` of a `make-dmg.sh --with-models` build, when there is one.
    static var bundledModels: URL? {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("models"),
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    /// Fetch, in the background, whatever of the core is not on disk yet — and the files of any
    /// optional language that is on — resuming a part-finished transfer where it stopped.
    ///
    /// The core is not a choice (owner, 2026-10-02): no checklist, no consent step. It starts
    /// when setup is finished or skipped (`OnboardingView.finish`) and again at every launch
    /// until all of it is here, so a quit, a sleep or a dropped connection costs nothing. An
    /// upgrader from 0.2.x, who never sees onboarding, gets it the same way.
    ///
    /// Called by the app after `start()`, never from `start()` itself: a test or the probe that
    /// starts a controller must not begin fetching gigabytes.
    public func resumeRecommendedDownloads() {
        guard Self.mayDownload(settings), let models = self.models else { return }
        let wanted = ModelDownloads.Item.wanted(for: settings.languageSubset)
        Task {
            await models.refresh()
            models.download(wanted)
        }
    }

    /// Whether background downloads may start: once setup is behind the user. The flag stays
    /// for the hermetic tests and the probe (which set it false); onboarding always writes it
    /// true, since the core is no longer something a user opts into.
    static func mayDownload(_ settings: AppSettings) -> Bool {
        settings.autoDownloadModels && settings.hasCompletedOnboarding
    }

    /// True while `download(_:)` is running, so the settings pane can show it and refuse a second.
    public private(set) var downloading: ModelEntry?
    /// What the last download did, in the store's own words. Includes its refusals.
    public private(set) var downloadNotes: [String] = []

    /// Fetch a model Kotiba knows about, verify it, and configure it.
    ///
    /// `ModelStore` has been able to do this since it was written and had no callers: the app's
    /// only acquisition path was an `NSOpenPanel` (since removed), so the blocker a new Uzbek user
    /// met on first launch — "Choose one in Settings › Languages" — led nowhere. The store does the download,
    /// the sha256 check and the atomic install; this decides which setting the result belongs in.
    @discardableResult
    public func download(_ entry: ModelEntry) async -> String? {
        guard downloading == nil else { return L("error.downloadRunning") }
        downloading = entry
        readiness = .preparing(entry.name)
        defer { downloading = nil }

        let store = modelStore
        do {
            let url = try await store.ensure(entry)
            downloadNotes = await store.notes
            switch ModelCatalogue.settingKey(for: entry) {
            case .russianModel: settings.russianModelPath = url.path
            case .detectorModel: settings.detectorModelPath = url.path
            case .languageIDModel: settings.languageIDModelPath = url.path
            case .uzbekModel: settings.uzbekModelPath = url.path
            // Found by its file name in the models directory; see `polishModelPath` and
            // `AppSettings.resolvedArabicPath`.
            case .polishModel, .arabicModel, .arabicModesModel: break
            case nil: break
            }
            await settingsChanged()
            return nil
        } catch {
            downloadNotes = await store.notes
            settleStatus()
            await refreshBlockers()
            // The store's errors already name the endpoint, the path and the digest that did not
            // match; flattening them here would undo the work they exist to do.
            return (error as? ModelStoreError)?.reason ?? "\(error)"
        }
    }

    /// Bytes under the models directory.
    func modelsOnDisk() async -> Int64 { Int64(await modelStore.installedBytes()) }

    /// Where one of `LanguageModelFile`'s files lives in Kotiba's own models directory, when it is
    /// there. A file the user chose elsewhere, or one inside the app bundle, is never deleted.
    private func storedLocation(of file: LanguageModelFile) async -> URL? {
        let store = modelStore
        switch file {
        case .parakeet:
            return await store.isInstalled(ModelCatalogue.parakeetUltra)
                ? await store.location(of: ModelCatalogue.parakeetUltra) : nil
        case .uzbek: return await stored(ModelCatalogue.uzbekEngine)
        case .turbo: return await stored(ModelCatalogue.russianEngine)
        case .cohere: return await stored(ModelCatalogue.arabicEngine)
        case .arabicModes: return await stored(ModelCatalogue.arabicModesModel)
        }
    }

    private func stored(_ entry: ModelEntry) async -> URL? {
        let url = await modelStore.location(of: entry)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// What removing `language`'s model files would free, in bytes: the files only it uses, while
    /// it is off (`LanguageModelFile.removable`), that are in Kotiba's models directory. 0 while
    /// it is on, or when there is nothing of its own to remove.
    public func removableModelBytes(for language: Language) async -> Int64 {
        var total: Int64 = 0
        for file in LanguageModelFile.removable(for: language, on: settings.languageSubset) {
            guard let url = await storedLocation(of: file) else { continue }
            total += Self.bytes(at: url)
        }
        return total
    }

    /// Delete the model files only `language` (off) uses, to free the disk. The Languages pane
    /// asks first, in the page. Engines holding them are dropped first; turning the language back
    /// on offers the download again. Returns why it failed, or nil.
    public func removeModelFiles(for language: Language) async -> String? {
        let files = LanguageModelFile.removable(for: language, on: settings.languageSubset)
        guard !files.isEmpty, !status.isBusy else { return nil }
        for file in files {
            guard let url = await storedLocation(of: file) else { continue }
            switch file {
            case .parakeet: await parakeetEngine.unload()
            case .uzbek:
                await uzbekEngine?.unload()
                uzbekEngine = nil
                if settings.uzbekModelPath == url.path { settings.uzbekModelPath = "" }
            case .turbo:
                await russianEngine?.unload()
                russianEngine = nil
                if settings.russianModelPath == url.path { settings.russianModelPath = "" }
            case .cohere:
                await cohereEngine?.unload()
                cohereEngine = nil
            case .arabicModes:
                await arabicModesPolisher?.unload()
                arabicModesPolisher = nil
            }
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                return "\(error.localizedDescription)"
            }
        }
        parakeetInstalled = await parakeetEngine.isDownloaded()
        await settingsChanged()
        await models?.refresh()
        return nil
    }

    /// A file's size, or a directory's (Parakeet is a directory of Core ML models).
    static func bytes(at url: URL) -> Int64 {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            return 0
        }
        guard isDirectory.boolValue else {
            return ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size]
                    as? NSNumber)?.int64Value ?? 0
        }
        var total: Int64 = 0
        let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey])
        while let item = walker?.nextObject() as? URL {
            total += Int64((try? item.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
        }
        return total
    }

    /// Whether one of the recommended models is on disk — for `ModelDownloads`.
    func installedState(of item: ModelDownloads.Item) async -> ModelDownloads.State {
        switch item {
        case .parakeet:
            return await parakeetEngine.isDownloaded() ? .installed : .missing
        case .uzbek:
            if settings.uzbekReady { return .installed }
            return ModelCatalogue.uzbekEngineIsPublic
                ? .missing : .unavailable(L("models.uzbek.private"))
        case .speechDetector:
            return SileroSpeechDetector.locate(in: Self.modelDirectories(settings)) != nil
                ? .installed : .missing
        case .languageDetector:
            return settings.resolvedLanguageIDPath != nil ? .installed : .missing
        case .modes:
            return polishModelInstalled ? .installed : .missing
        case .turkish:
            return settings.russianReady ? .installed : .missing
        case .arabic:
            // Both files (`ModelDownloads.Item.arabic`): Cohere, and turbo for the language head.
            return settings.resolvedArabicPath != nil && settings.russianReady
                ? .installed : .missing
        case .arabicModes:
            return arabicModesPath != nil ? .installed : .missing
        }
    }

    /// Fetch one recommended model through the shared store (sha256-verified, resumable), and
    /// put it to work: the setting it belongs in, or the engine that was waiting for it.
    func install(_ item: ModelDownloads.Item, progress: @escaping DownloadProgress) async throws {
        let store = modelStore
        switch item {
        case .parakeet:
            try await store.ensure(ModelCatalogue.parakeetUltra, progress: progress)
            parakeetInstalled = true
            // Loads (and, the first time on a Mac, compiles for the Neural Engine) in the
            // background; Apple answers English until it is ready.
            let parakeet = parakeetEngine
            Task { try? await parakeet.prepare() }
        case .uzbek:
            let url = try await store.ensure(ModelCatalogue.uzbekEngine, progress: progress)
            settings.uzbekModelPath = url.path
            await settingsChanged()
        case .speechDetector:
            try await store.ensure(ModelCatalogue.speechDetector, progress: progress)
            await parakeetEngine.setSpeechDetectorURL(
                SileroSpeechDetector.locate(in: Self.modelDirectories(settings)))
        case .languageDetector:
            let url = try await store.ensure(ModelCatalogue.languageID, progress: progress)
            settings.languageIDModelPath = url.path
            await settingsChanged()
        case .modes:
            try await store.ensure(ModelCatalogue.polishModel, progress: progress)
            await refreshBlockers()
        case .turkish:
            // The same file as Russian's fallback: on disk already for most, fetched otherwise.
            let url = try await store.ensure(ModelCatalogue.russianEngine, progress: progress)
            settings.russianModelPath = url.path
            await settingsChanged()
        case .arabic:
            // turbo first (574 MB; usually absent on a Mac with Parakeet): the language head that
            // settles an Arabic candidate (`ArabicCheck`) and the loop fallback behind Cohere.
            // Progress runs over both files; turbo already on disk counts as done.
            let turbo = Int64(ModelCatalogue.russianEngine.expectedBytes ?? 0)
            if !settings.russianReady {
                let url = try await store.ensure(ModelCatalogue.russianEngine, progress: progress)
                settings.russianModelPath = url.path
                await settingsChanged()
            }
            try await store.ensure(ModelCatalogue.arabicEngine,
                                   progress: { progress(turbo + $0) })
            await settingsChanged()
        case .arabicModes:
            try await store.ensure(ModelCatalogue.arabicModesModel, progress: progress)
            arabicModesPolisher = nil
            await refreshBlockers()
        }
    }

    /// Which engine serves a language, for the on-demand load. English is Apple's and needs
    /// nothing; Uzbek and Turkish are whisper; Arabic is Cohere, or turbo until it is on disk.
    /// An optional language that is off has none: nothing is paged in for it.
    private func engine(for language: Language) -> (any TranscriptionEngine)? {
        // A language that is off is never paged in (`AppSettings.enabledLanguages`).
        guard settings.languageSubset.contains(language) else { return nil }
        switch language {
        case .uzbek: return uzbekEngine
        // Parakeet does Russian; its whisper model answers only while Parakeet cannot, and then
        // `CompositeEngine` loads it on demand. Paging 574 MB in for a fallback is waste.
        case .russian: return parakeetInstalled ? nil : russianEngine
        case .english: return nil
        case .turkish:
            return settings.enabledOptionalLanguages.contains(.turkish) ? russianEngine : nil
        case .arabic:
            guard settings.enabledOptionalLanguages.contains(.arabic) else { return nil }
            return arabicDecoder
        }
    }

    /// What the English/Russian engine is doing, for the Languages pane: whether it is loaded,
    /// and in words, downloading or why it is neither.
    public func unifiedEngineStatus() async -> (ready: Bool, detail: String) {
        if await parakeetEngine.isReady() {
            return (true, L("engine.parakeet.ready"))
        }
        if await parakeetEngine.isDownloading() {
            return (false, L("engine.parakeet.downloading"))
        }
        if let why = await parakeetEngine.failureReason() {
            return (false, L("engine.parakeet.failed", why))
        }
        return (false, L("engine.parakeet.pending"))
    }

    /// The language's name in the interface language — "Uzbek", "узбекский", "oʻzbek tili".
    public static func name(of language: Language) -> String {
        switch language {
        case .english: return L("speech.english")
        case .russian: return L("speech.russian")
        case .uzbek: return L("speech.uzbek")
        case .turkish: return L("speech.turkish")
        case .arabic: return L("speech.arabic")
        }
    }

    /// "Uzbek model", as the subject of "Getting the … ready" and of a load failure.
    public static func modelName(of language: Language) -> String {
        switch language {
        case .english: return L("model.named.english")
        case .russian: return L("model.named.russian")
        case .uzbek: return L("model.named.uzbek")
        case .turkish: return L("model.named.turkish")
        case .arabic: return L("model.named.arabic")
        }
    }

    /// Apple Intelligence's state in the interface language. `OnDeviceModel.Availability.reason`
    /// says the same in English, from KotibaPlatform, which has no catalog to read.
    static func availabilityText(_ availability: OnDeviceModel.Availability) -> String {
        switch availability {
        case .available: return L("appleIntelligence.available")
        case .deviceNotEligible: return L("appleIntelligence.deviceNotEligible")
        case .notEnabled: return L("appleIntelligence.notEnabled")
        case .modelNotReady: return L("appleIntelligence.modelNotReady")
        case .unsupported: return L("appleIntelligence.unsupported")
        }
    }

    /// The interface language: written to settings and applied to every word on screen at once,
    /// with no restart. The blockers are sentences built when they were found, so they are built
    /// again in the new language.
    public func setAppLanguage(_ language: AppLanguage) {
        if settings.appLanguage != language.rawValue {
            settings.appLanguage = language.rawValue
            settings.save()
        }
        // What macOS draws for the app — the permission prompt's reason, the standard menus, the
        // open panel — follows the app's own `AppleLanguages`, read once at launch. Writing it here
        // brings those into line on the next start; Kotiba's own words have switched already.
        // Through the settings' store, so a test's scratch defaults take the write, not the
        // machine's.
        settings.store.set([language.rawValue], forKey: "AppleLanguages")
        Localizer.shared.apply(language)
        Task { await refreshBlockers() }
    }

    private func whisperOptions(for language: Language) -> WhisperEngine.Options {
        var options = WhisperEngine.Options(
            useGPU: settings.whisperUseGPU,
            beamSize: settings.whisperBeamSize,
            // The vocabulary reaches whisper as decoder context, which is the only way to fix a
            // word before it is mis-emitted rather than after.
            initialPrompt: settings.vocabularyValue.hint(for: language),
            // Off for the streaming engines, which mix encoder windows (C2 §3): Uzbek always,
            // and turbo now that Turkish and Arabic stream through it (D-11). Off costs turbo's
            // batch Russian fallback ~16 ms; on, the Turkish stream would decode every tail with
            // the full window.
            flashAttention: language != .uzbek && language != .russian)
        if language == .russian {
            for served in Self.languagesServed(by: .russian) {
                options.languagePrompts[served] = settings.vocabularyValue.hint(for: served)
            }
        }
        return options
    }

    /// Called after settings change. Reloads only what the change actually invalidated.
    public func settingsChanged() async {
        settings.save()
        modes.defaultKey = settings.defaultModeKey
        openStores()

        let modelsMoved = Self.modelsChanged(
            loadedUzbek: uzbekEngine?.modelURL.path,
            loadedRussian: russianEngine?.modelURL.path,
            settings: settings)
        if modelsMoved {
            await prepareEngines(eagerly: settings.preloadAllLanguages)
        } else {
            // Same files, different knobs. `setOptions` invalidates the loaded context itself
            // when the change is one that was baked in at load time.
            await uzbekEngine?.setOptions(whisperOptions(for: .uzbek))
            await russianEngine?.setOptions(whisperOptions(for: .russian))
            // Turning Turkish or Arabic on or off moves no whisper file, but Cohere follows it.
            refreshOptionalEngines()
            if settings.preloadAllLanguages {
                await preload(engine(for: .uzbek), .uzbek)
                await preload(engine(for: .russian), .russian)
            }
            await releaseLanguagesTurnedOff()
        }
        settleStatus()
        // Both branches above can change the answer: a new timeout, or `preloadAllLanguages`
        // being switched on, which this must stop honouring the timer for.
        await refreshResidency()
        armIdleUnload()
        await refreshBlockers()
    }

    // MARK: - Permissions and readiness

    /// Re-attempt the things that can fail, then re-read. `refreshBlockers()` alone only ever
    /// re-read `microphone.isWarm`, a flag nothing but `warmUp()` can set — so once warm-up had
    /// failed, no button in the UI could ever make it succeed again.
    /// Ask macOS for whatever is still missing, then re-read.
    ///
    /// Asking is what registers the app in the Accessibility and Input Monitoring lists — an
    /// app that only ever *checks* may not appear in them at all, leaving the user with a pane
    /// that looks like it is missing Kotiba entirely.
    public func requestMissingPermissions() {
        #if os(macOS)
        if !Accessibility.isTrusted { Accessibility.request() }
        if !PushToTalkMonitor.isPermitted { PushToTalkMonitor.requestPermission() }
        #endif
    }

    public func recheck() async {
        // Re-tested after every suspension, not once at the top. This used to check `isBusy`
        // and then perform two awaits — `warmUp()` and `prepareEngines()` — during which a press
        // could land: a check-then-act across a suspension point on the one variable both paths
        // wrote. Now it asks whether a dictation is in flight, and asks again each time it comes
        // back, so a press that arrives mid-recheck is never trampled.
        guard !isRunning else { await refreshBlockers(); return }
        microphone.setPrefersBuiltInMicWithBluetooth(settings.preferBuiltInMicWithBluetooth)
        await microphone.warmUp()

        guard !isRunning else { await refreshBlockers(); return }
        await prepareEngines(eagerly: settings.preloadAllLanguages)

        guard !isRunning else { await refreshBlockers(); return }
        settleStatus()
        await refreshBlockers()
    }

    public func refreshBlockers() async {
        var found: [Blocker] = []

        #if os(macOS)
        // A tap refused despite the permission being granted. Nothing used to record this: the
        // only hotkey blocker asks `isPermitted`, which is true in exactly this case, so
        // `StartFailure.tapRefused` had nowhere to live — the hotkey was dead and the blocker
        // list was empty, which reads to the user as the app believing everything is fine.
        if let hotkeyFailure {
            found.append(Blocker(
                id: "hotkey-tap",
                title: L("blocker.hotkeyTap.title"),
                detail: L("blocker.hotkeyTap.detail", hotkeyFailure),
                settingsURL: nil))
        }
        if !PushToTalkMonitor.isPermitted {
            found.append(Blocker(
                id: "input-monitoring",
                title: L("blocker.inputMonitoring.title"),
                detail: L("blocker.inputMonitoring.detail"),
                settingsURL: "x-apple.systempreferences:com.apple.preference.security"
                    + "?Privacy_ListenEvent"))
        }
        if !Accessibility.isTrusted {
            found.append(Blocker(
                id: "accessibility",
                title: L("blocker.accessibility.title"),
                // Naming the bundle matters: the grant is per copy, and a stale entry for a
                // different Kotiba is exactly the trap that makes toggling one do nothing.
                detail: L("blocker.accessibility.detail", Accessibility.bundlePath),
                settingsURL: "x-apple.systempreferences:com.apple.preference.security"
                    + "?Privacy_Accessibility"))
        }
        #endif

        // Only when the user can do something about it: the grant, or no input device at all.
        // Every other cold microphone — a device that changed, a take that delivered nothing, a
        // graph that would not start — is rebuilt by the next press and by every foreground's
        // warm-up, and a dictation it still breaks says so in the pill. Listing those here put a
        // "not ready" banner up on nearly every window open for a state that fixes itself.
        if await !microphone.isWarm, await microphone.warmUpNeedsTheUser {
            found.append(Blocker(
                id: "microphone",
                title: L("blocker.microphone.title"),
                detail: await microphone.lastWarmUpError ?? L("blocker.microphone.detail"),
                settingsURL: "x-apple.systempreferences:com.apple.preference.security"
                    + "?Privacy_Microphone"))
        }

        for (language, why) in loadFailures.sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
            found.append(Blocker(
                id: "load-\(language.rawValue)",
                title: L("blocker.load.title", Self.modelName(of: language)),
                detail: why,
                settingsURL: nil))
        }
        if let historyOpenError {
            found.append(Blocker(
                id: "history-store",
                title: L("blocker.historyOpen.title"),
                detail: L("blocker.historyOpen.detail", historyOpenError),
                settingsURL: nil))
        }
        if let diagnosticsOpenError {
            found.append(Blocker(
                id: "diagnostics-store",
                title: L("blocker.diagnosticsOpen.title"),
                detail: L("blocker.diagnosticsOpen.detail", diagnosticsOpenError),
                settingsURL: nil))
        }
        // Settings that could not be read as they were written. Without this the user sees a
        // factory-fresh app and a "No Uzbek model" blocker, which points at the wrong cause.
        if settings.loadFailure != nil {
            let what = settings.droppedKeys.isEmpty
                ? L("settings.unreadable.all")
                : L("settings.unreadable.some", settings.droppedKeys.joined(separator: ", "))
            found.append(Blocker(
                id: "settings-unreadable",
                title: L("blocker.settingsUnreadable.title"),
                detail: L("blocker.settingsUnreadable.detail", what),
                settingsURL: nil))
        }
        // A store that opened and then stopped taking writes. Distinct from the two above,
        // because "it never opened" and "it opened and is now losing your dictations" want
        // different answers from the user.
        if let historyWriteError {
            found.append(Blocker(
                id: "history-write",
                title: L("blocker.historyWrite.title"),
                detail: L("blocker.historyWrite.detail", historyWriteError),
                settingsURL: nil))
        }
        if let diagnosticsWriteError {
            found.append(Blocker(
                id: "diagnostics-write",
                title: L("blocker.diagnosticsWrite.title"),
                detail: L("blocker.diagnosticsWrite.detail", diagnosticsWriteError),
                settingsURL: nil))
        }
        // Polish asked for, and nothing able to do it. Silent no-op is the failure this
        // project exists to avoid, and "my modes do nothing" is exactly that failure.
        // Ask what will actually run, not whether Apple's model exists on this Mac. The old
        // check missed the commonest way to end up with nothing: switching off "use the
        // on-device model" without an API key saved. `AppleIntelligencePolisher() == nil` is
        // false there — the model is present, it is simply not going to be used — so polish was
        // silently dead for every mode with no blocker and a settings pane calling it ready.
        if settings.polishEnabled, polishChain(for: modes.defaultMode).isEmpty {
            found.append(Blocker(
                id: "no-polisher",
                title: L("blocker.noPolisher.title"),
                detail: (settings.preferOnDeviceModel
                         ? L("blocker.noPolisher.notDownloaded")
                            + " " + Self.availabilityText(OnDeviceModel.availability)
                         : L("blocker.noPolisher.switchedOff"))
                    + " " + L("blocker.noPolisher.meanwhile"),
                settingsURL: nil))
        }
        if !settings.uzbekReady {
            found.append(Blocker(
                id: "uzbek-model",
                title: L("blocker.uzbekModel.title"),
                // Say what is actually wrong with the file when there is one. A configured path
                // that fails inspection used to be indistinguishable from no path at all, so a
                // truncated download read as "you never chose a model" and the user chose it
                // again.
                detail: AppSettings.modelProblem(settings.resolvedUzbekPath
                                                 ?? settings.uzbekModelPath).map {
                    L("blocker.uzbekModel.unusable", $0)
                } ?? L("blocker.uzbekModel.missing"),
                settingsURL: nil))
        }
        // Only worth mentioning when the user has actually asked for Russian; nagging someone
        // who never dictates Russian about a missing Russian model is noise.
        // Parakeet does Russian; turbo, when Turkish or Arabic brought it, still answers.
        if !settings.russianReady, !parakeetInstalled, settings.defaultLanguage == .russian {
            found.append(Blocker(
                id: "russian-model",
                title: L("blocker.russianModel.title"),
                detail: L("blocker.russianModel.detail"),
                settingsURL: nil))
        }
        RenameNotice.apply(to: &found, settings: settings,
                           legacyAppRunning: renameMigrationDeferred)
        detectedBlockers = found
    }

    // MARK: - The gesture

    /// Key down. Returns immediately; capture continues until `release()`.
    ///
    /// Admitted whenever the key is not already down — including while earlier dictations are
    /// still transcribing, polishing or pasting. That used to be refused with "Still finishing
    /// the last one.", which is the opposite of what someone dictating in bursts wants: they have
    /// already moved on to the next sentence. Three things make the overlap safe, and they are
    /// the whole of the admission design:
    ///
    ///   * **Audio.** Each press gets its own `MicrophoneTake`. A take opening while the previous
    ///     one has not yet been stopped seals the previous one at that sample, on the same running
    ///     engine — nothing restarts, nothing is lost at the seam, nothing is shared.
    ///   * **Paste order.** Each press takes a ticket in `pasteTurns`, and its sink waits for its
    ///     turn before inserting. N pastes before N+1 whichever finishes first.
    ///   * **The HUD.** `pressCount` names the newest dictation; only it may write `dictation`.
    ///
    /// Pipeline seam: everything from `makeSession` down is per-dictation and knows nothing about
    /// the others, so a restructured pipeline only has to keep taking a take and an ordered sink.
    public func press() {
        // A second key-down with the key already down is a stuck modifier or a lost key-up, not a
        // new dictation — and never a reason to show an error over the one being recorded.
        guard session == nil else { return }
        // The user is speaking; nothing is idle. The poll stays running and simply sees recent
        // activity — and `idleTick` refuses to release while `status.isBusy` regardless, so a
        // release cannot land between key-down and the transcript.
        noteActivity()
        pressCount += 1
        let press = pressCount
        microphone.setPrefersBuiltInMicWithBluetooth(settings.preferBuiltInMicWithBluetooth)
        let take = microphone.liveTake(onLimit: { [weak self] in
            Task { @MainActor in self?.captureLimitReached(press: press) }
        })
        let ticket = pasteTurns.issue()
        // Resolved once, here, and held to key-up. The session's clean-up and live polish, the
        // HUD's announcement, the model paged in, and — at key-up — the polisher and the record
        // were five separate `resolveMode()` calls, so a mode picked or an app switched while the
        // key was held ran the key-down mode's live polish under the key-up mode's polisher and
        // recorded the second.
        let mode = resolveMode()
        let session = makeSession(audio: take, turn: PasteTurn(turns: pasteTurns, ticket: ticket),
                                  mode: mode, press: press)
        self.session = session
        self.take = take
        self.ticket = ticket
        self.heldMode = mode
        if settings.duckingEnabled { ducker.duck(to: settings.duckLevel) }
        // The last dictation's result stops being what the HUD shows the moment a new one starts.
        showsOutcome = false
        lastWentToClipboard = false
        dictation = .listening
        level = 0
        activeModeKey = mode.key
        Feedback.play(.start, enabled: settings.soundFeedback)

        // Parakeet is paged in on every press unless the mode pins Uzbek: English and Russian
        // are both its, and `prepare()` is a no-op when it is already resident.
        if effectivePin(for: mode) != .uzbek, settings.languageSubset.families.contains(.unified) {
            let parakeet = parakeetEngine
            Task { try? await parakeet.prepare() }
        }

        // Page the model in behind the user's speech.
        //
        // This is the whole reason a lazily-loaded language costs nothing in practice: someone
        // holding the key is going to hold it for a second or two, and a warm whisper load is
        // ~200 ms. It is now an optimisation and nothing more — `DictationSession` loads a cold
        // engine itself rather than refusing it — so failing to guess the language here costs a
        // slow first dictation, never a failed one.
        if let language = languageToPreload(for: mode) {
            loadTask = Task { [weak self] in
                guard let self, let engine = self.engine(for: language) else { return }
                do {
                    try await engine.prepare()
                    self.recordLoadResult(language, failure: nil)
                } catch {
                    self.recordLoadResult(language, failure: Self.describe(error))
                }
            }
        } else {
            loadTask = nil
        }

        // And the modes' model, with this mode's prompts prefilled, for the same reason. Loading
        // it cold costs ~0.3 s of mmap plus ~2.8 s of Metal shader compilation on first use in a
        // process; after that a prefill is tens of milliseconds.
        if settings.polishEnabled, settings.preferOnDeviceModel,
           let behaviour = ModeBehaviour(mode: mode), behaviour != .raw,
           let llama = onDeviceModel() {
            let language = languageToPreload(for: mode) ?? settings.defaultLanguage
            Task.detached {
                await IncrementalPolish(behaviour: behaviour, language: language, engine: llama)
                    .prepare()
            }
        }

        armTask = Task {
            await session.arm()
            if case .failed(let failure) = await session.state, press == self.pressCount {
                self.dictation = .failed(Self.describe(failure), pill: Self.pillHeadline(failure))
            }
        }
        startLevelMeter()
    }

    /// Key up. Drives the rest of the pipeline and updates `status` as it goes.
    public func release() {
        // Taken out of the property here, not in settle(). Leaving it in place for the whole
        // transcription meant a second key-up could call finish() on a session already being
        // finished, and settle() would run twice on one record.
        guard let session = self.session, let ticket = self.ticket else { return }
        self.session = nil
        self.take = nil
        self.ticket = nil
        self.armTask = nil
        let mode = heldMode ?? resolveMode()
        heldMode = nil
        let press = pressCount                  // the held dictation is always the newest
        let releasedAt = Date()
        stopLevelMeter()
        ducker.restore()
        Feedback.play(.stop, enabled: settings.soundFeedback)
        dictation = .working(L("status.working.detail"))

        runs[press] = Task {
            // The key-down preload is deliberately *not* awaited here. It pages in the language
            // the press guessed, and waiting on it put an Uzbek model's load in front of an
            // English dictation whenever the guess was wrong; the session loads the routed engine
            // itself, joining a load already in flight rather than starting a second.
            // The polisher is *passed*, not consulted. An earlier version built it here and
            // used it only as a boolean while the session's own polisher stayed nil, so the
            // whole polish subsystem was unreachable and every setting behind it looked live.
            let polisher = await self.makePolisher(for: mode)
            let modeKey = mode.key
            var instructionsLater: (@Sendable () async -> PolishInstructions?)?
            if polisher != nil {
                instructionsLater = { @MainActor [weak self] () -> PolishInstructions? in
                    self?.polishInstructions(for: mode)
                }
            }
            var record = await session.finish(
                pin: self.effectivePin(for: mode),
                polisher: polisher,
                // Rendered once the transcript is in, not here: a user-authored mode may read
                // the screen, and here is before the microphone has even stopped.
                polishInstructionsAfterTranscription: instructionsLater,
                // A mode whose job is to restructure legitimately grows: an email gains a
                // greeting, paragraph breaks and a sign-off, and a short dictation doubles. The
                // 2.0 ceiling is right for a correction pass and would reject every Email and
                // Note, showing the raw transcript instead — the exact "all modes do the same
                // thing" symptom.
                // A restructuring mode legitimately compresses: a rambling dictation becomes
                // three checkboxes. Measured in the wild at 0.23 and 0.30 — both rejected by
                // the 0.5 floor, which is why Note appeared to do nothing. The floor for these
                // modes is about "did it return anything at all", not "is it the same length".
                polishGuard: mode.restructures ? .restructuring : PolishGuard(),
                // A mode that reshapes waits and inserts once. Replacing text after the fact
                // fails in any app that does not expose its field over Accessibility, and when
                // it fails the user is left looking at the raw transcript.
                //
                // Built-in modes now insert once as well. Their polish is on-device and runs
                // sentence by sentence — the deterministic part is instant and a model sentence is
                // ~100 ms — while replace-after-paste was the commonest failure on record
                // (`polish replace refused`, 94 times).
                insertAfterPolish: mode.restructures || ModeBehaviour(mode: mode) != nil,
                releasedAt: releasedAt)
            // Its paste has happened, or will not: the next dictation in line may go. Idempotent
            // — the ordered sink already passed the turn if it inserted — and it must run on
            // every path, or every later dictation waits out `InsertionTurns.patience`.
            await self.pasteTurns.finish(ticket)
            record.modeKey = modeKey
            record.polishID = polisher?.polishID
            await self.settle(record, session: session, press: press)
            // The run is over, so stop saying it is not.
            //
            // `runTask` was once assigned here and cleared only in `cancel()`, which had no caller
            // in the shipping app — so it stayed non-nil for the rest of the process and every
            // press after the first was refused. Each run removes exactly its own entry, as the
            // last line of its own task; that is what keeps `isRunning` self-clearing.
            self.runs[press] = nil
        }
    }

    /// Discard the dictation whose key is down — a hotkey that turned out to be the start of a
    /// shortcut (right ⌘ then C), or Escape while holding. Dictations already released carry on:
    /// the user has finished with those.
    public func cancel() {
        guard let session = self.session else { return }
        loadTask?.cancel()
        loadTask = nil
        stopLevelMeter()
        ducker.restore()
        Feedback.play(.cancel, enabled: settings.soundFeedback)
        let take = self.take
        let ticket = self.ticket
        let arming = armTask
        self.session = nil
        self.take = nil
        self.ticket = nil
        self.armTask = nil
        self.heldMode = nil
        // Nothing was inserted, so there is no outcome to keep on screen.
        showsOutcome = false
        dictation = .idle
        Task {
            // After arming, never before: a stop that overtakes the start finds no take to end,
            // and the start then opens one nobody will ever close — the engine left running.
            await arming?.value
            _ = try? await take?.stop()
            if let ticket { await self.pasteTurns.finish(ticket) }
            // And what the hold started behind the audio — the streams' decodes, the primed
            // polish — which would otherwise run on and put the next dictation behind them.
            await session.abandon()
        }
        // Key-down already started a load, so an abandoned dictation still costs the memory.
        // Without this the timer stays cancelled from `press()` and nothing ever releases it.
        armIdleUnload()
    }

    /// The held dictation reached `MicrophoneSource`'s ceiling (30 minutes). Finish it as though
    /// the key had come up, and say why — the alternative is audio silently not being kept.
    func captureLimitReached(press: UInt64) {
        guard press == pressCount, session != nil else { return }
        release()
        dictation = .working(L("status.working.limit"))
    }

    /// Hand the controller the real ducker, and put back anything a crashed or force-quit run
    /// left ducked. The app calls this once at launch; its marker lives beside the history.
    public func installDucking(_ ducking: PlaybackDucking) {
        ducker = ducking
        ducking.recoverFromCrash()
    }

    /// Restore the output now, without a ramp. The terminate path.
    public func restoreDuckingImmediately() { ducker.restoreImmediately() }

    /// Once per install: the per-language counts the language decision's prior reads start
    /// from the user's History, where there is one (P4). Turkish's and Arabic's counts existed
    /// already and are kept when larger.
    private func seedLanguageCounts() async {
        guard !settings.languageCountsSeeded, let historyStore else { return }
        if let counts = try? await historyStore.countsByLanguage() {
            settings.uzbekDictations = max(settings.uzbekDictations, counts[.uzbek] ?? 0)
            settings.englishDictations = max(settings.englishDictations, counts[.english] ?? 0)
            settings.russianDictations = max(settings.russianDictations, counts[.russian] ?? 0)
            settings.turkishDictations = max(settings.turkishDictations, counts[.turkish] ?? 0)
            settings.arabicDictations = max(settings.arabicDictations, counts[.arabic] ?? 0)
        }
        settings.languageCountsSeeded = true
        settings.save()
    }

    /// A pin only when the user asked for one.
    ///
    /// `nil` is what lets the router actually decide. Returning `settings.defaultLanguage`
    /// unconditionally — which this did while nothing implemented `AcousticClassifier` — pins
    /// every dictation at tier P1 and the classifier below it never runs at all.
    ///
    /// `pinnedLanguage` comes first, and it is the whole point: it is the only way a user can
    /// overrule the acoustic router, and until it existed there was none. `pinFromSettings`
    /// returned nil whenever a detector was loaded, so the "fallback for the cases it misses"
    /// that the menu-bar comment pointed at — Settings › Languages — was not a fallback at all.
    ///
    /// Measured on 745 clips of real Uzbek, with the shipping `ggml-base-q5_1` detector at the
    /// live 0.05 threshold: recall **83.1%**, and **58.4%** on clips under two seconds. So one
    /// Uzbek dictation in six never reached the Uzbek model, and among the short ones — which is
    /// most dictation — two in five did not. Of those misroutes only 16% went to the Russian
    /// engine, where the script check can catch them and rerun; the other 84% went to Apple's
    /// English engine, which answers Uzbek with plausible Latin nonsense that no script check can
    /// distinguish from a real transcript.
    ///
    /// The acoustic pass cannot be fixed by moving the threshold, because the classes overlap:
    /// this user's own diagnostics have English at cluster mass 0.230 and 0.119 and real Uzbek at
    /// 0.183 and 0.0122. A pin costs 0 ms and is always right.
    /// Internal rather than private so a test can assert the precedence without a microphone.
    func pinFromSettings() -> Language? {
        let on = settings.languageSubset
        if let pinned = settings.pinnedLanguage, on.contains(pinned) { return pinned }
        // One language on (or English and Russian alone): nothing to detect, and the session
        // routes there for free (`LanguageSubset.soleRoute`) — not as a pin, so Parakeet's own
        // English/Russian label still stands.
        if on.soleRoute() != nil { return nil }
        return detector == nil && languageID == nil
            ? on.fallback(preferring: settings.defaultLanguage) : nil
    }

    /// The pin for a dictation in `mode`: the mode's own language when it is on — a mode pinned to
    /// a language the user turned off does not route there — else `pinFromSettings`.
    func effectivePin(for mode: Mode) -> Language? {
        if let pinned = mode.language, settings.languageSubset.contains(pinned) { return pinned }
        return pinFromSettings()
    }

    private func settle(_ record: DictationRecord, session: DictationSession, press: UInt64) async {
        lastRecord = record
        // The menu-bar Language section re-sorts on a finished dictation (a no-op while a
        // picker page is on screen). The diagnostics line is written further down, so this
        // reads the log as of the previous dictation — one behind, which a 30-day window and a
        // 3-dictation margin do not notice.
        Task { await languageOrder.refresh() }
        // The HUD is the newest dictation's. An older one finishing while the next is being
        // spoken is recorded, persisted and pasted, but it does not take the HUD back from
        // "Listening".
        let ownsHUD = press == pressCount && self.session == nil
        // Everything below writes a finished outcome, and `release()` removes the run on the
        // next line — so without this the result is unreadable by the time anything renders it.
        if ownsHUD { showsOutcome = true }

        if let routed = record.route?.language, record.outcome == "done" { lastRouted = routed }
        noteQuietMic(record, ownsHUD: ownsHUD)
        // Counted for `TurkishCheck`'s threshold — a delivered Turkish dictation, pinned or not.
        // …and `ArabicCheck`'s (C4 §14.1), and every language's for the language decision's
        // prior (`LanguagePrior`, P4).
        if let language = record.route?.language, record.outcome == "done" {
            settings.countDictation(in: language)
            settings.save()
        }
        switch await session.state {
        case .done:
            let text = record.polished ?? record.result ?? ""
            lastTranscript = text
            if ownsHUD { dictation = .succeeded(text) }
            await persist(record)
        case .heardNothing:
            if ownsHUD { dictation = .heardNothing }
            await persist(record)
        case .failed(let failure):
            if ownsHUD { dictation = .failed(Self.describe(failure), pill: Self.pillHeadline(failure)) }
            Feedback.play(.failure, enabled: settings.soundFeedback)
            await persist(record)
        default:
            if ownsHUD { dictation = .failed(L("error.endedIn", "\(await session.state)")) }
        }
        await reloadHistory()

        // Whatever the outcome, a model was loaded to reach it. Start the clock.
        await refreshResidency()
        armIdleUnload()
    }

    private func persist(_ record: DictationRecord) async {
        if settings.diagnosticsEnabled, let diagnostics {
            do {
                try await diagnostics.append(record)
                diagnosticsWriteError = nil
            } catch {
                diagnosticsWriteError = "\(error)"
            }
        }
        guard settings.keepHistory, let historyStore,
              let result = record.result, !result.isEmpty else { return }
        let entry = HistoryEntry(
            startedAt: record.startedAt,
            language: record.route?.language ?? settings.defaultLanguage,
            engineID: record.engineID ?? "unknown",
            raw: record.raw ?? result,
            result: result,
            polished: record.polished,
            audioSeconds: record.audioSeconds)
        do {
            try await historyStore.insert(entry)
            // Enforce the retention the user asked for, here rather than never. 0 keeps
            // everything, which is the shipped default and what the setting documents.
            try await historyStore.prune(keeping: settings.historyLimit)
            historyWriteError = nil
        } catch {
            historyWriteError = (error as? HistoryError)?.reason ?? "\(error)"
        }
    }

    public func reloadHistory() async {
        guard let historyStore else { history = []; return }
        history = (try? await historyStore.recent(limit: 100)) ?? []
    }

    public func deleteHistory(id: String) async {
        try? await historyStore?.delete(id: id)
        await reloadHistory()
    }

    /// What the diagnostics pane shows. Timings and outcomes; `summary()` carries no transcript
    /// text by construction, so this is safe to paste into a bug report.
    public func diagnosticsSummary() async -> String {
        guard let diagnostics else {
            if let diagnosticsOpenError {
                return L("diagnostics.openFailed", diagnosticsOpenError)
            }
            return L("diagnostics.off")
        }
        // A read failure and an empty log are different things, and reporting the first as the
        // second is how a broken diagnostics store looks exactly like a quiet one.
        do {
            return try await diagnostics.summary()
        } catch {
            return L("diagnostics.readFailed", "\(error)")
        }
    }

    public func searchHistory(_ text: String) async -> [HistoryEntry] {
        guard let historyStore, !text.isEmpty else { return history }
        return (try? await historyStore.search(text, limit: 100)) ?? []
    }

    // MARK: - Assembly

    /// A session built by a test, in place of the one this controller would build.
    ///
    /// The real one wants a microphone, an Accessibility grant and 539 MB of weights, so the
    /// whole key-down → `settle()` path — the path that decides what the HUD shows once a
    /// dictation ends — was unreachable from a test, and the outcome vanishing off the HUD
    /// shipped. Nil in the app: there is exactly one writer and it is a test.
    ///
    /// It is handed the dictation's place in the paste queue, so a test that builds its own sink
    /// can still be held to paste order: `turn.ordered(sink)`.
    var sessionOverride: (@MainActor (PasteTurn) -> DictationSession)?

    /// Adjusts each dictation's `DictationSession.Config` after the controller has built it. For
    /// `kotiba-probe e2e`, which measures the pipeline's own alternatives (early routing on or off,
    /// the route taken at key-up or during the hold) through the real controller. Nil in the app.
    public var sessionTuning: (@Sendable (inout DictationSession.Config) -> Void)?
    /// The same for turbo's streaming configuration (Turkish, Arabic's fallback) — the commit
    /// length C4 §13 measured through the controller. Nil in the app.
    public var turboStreamingTuning: (@Sendable (inout StreamingWhisperSession.Configuration) -> Void)?
    /// The same for Arabic's stream (Cohere, turbo behind it) — the commit length C4 §14.4
    /// measured. Nil in the app.
    public var arabicStreamingTuning: (@Sendable (inout StreamingWhisperSession.Configuration) -> Void)?

    /// One dictation's place in `pasteTurns`.
    struct PasteTurn {
        let turns: InsertionTurns
        let ticket: InsertionTurns.Ticket
        func ordered(_ sink: any TextSink) -> any TextSink {
            OrderedTextSink(sink, turns: turns, ticket: ticket)
        }
    }

    private func makeSession(audio: any AudioSource, turn: PasteTurn,
                             mode: Mode, press: UInt64) -> DictationSession {
        if let sessionOverride { return sessionOverride(turn) }
        // `.unified` was drawn around Parakeet, which decides English against Russian inside
        // its own decoder — see CompositeEngine.
        // Parakeet first for both languages; Apple and whisper stay behind it for the window
        // before its first download lands, and for a machine where it cannot load at all.
        var unified: [any TranscriptionEngine] = [parakeetEngine, appleEngine]
        if let russianEngine { unified.append(russianEngine) }

        // Only the families of the languages that are on (`LanguageSubset`): a language that is
        // off has no engine here, so no stream, no second opinion and no recovery can reach it.
        let languages = settings.languageSubset
        var engines: [EngineFamily: any TranscriptionEngine] = [:]
        if languages.families.contains(.unified) {
            engines[.unified] = CompositeEngine(engineID: "unified", unified)
        }
        // Uzbek streams too (docs/research/C2): Silero finds the pauses, each pause is decoded
        // provisionally with a fitted encoder window, and key-up adopts the last one or decodes
        // only what came after it. The engine is built with flash attention off — whisper.cpp
        // v1.9.2's flash path reads cross-attention keys past a window it did not write, which
        // is only safe while every call uses one window (C2 §3).
        let speechDetectorURL = SileroSpeechDetector.locate(in: Self.modelDirectories(settings))
        if let uzbekEngine, languages.contains(.uzbek) {
            var streaming = StreamingWhisperSession.Configuration()
            // Greedy for the pause decodes as well as the tail: that is the configuration C2
            // measured (21.95 % WER at a 300 ms release, +0.40 on the app's beam-5 batch), and a
            // beam-5 pause decode costs up to 73 % more, which is time a release can wait on.
            streaming.backgroundBeamSize = 1
            engines[.uzbek] = StreamingWhisperEngine(
                whisper: uzbekEngine, configuration: streaming,
                speechDetectorURL: speechDetectorURL)
        }
        // The optional languages (D-11), only when on — then they stream too, stood down until a
        // detection points at them (`DictationSession.openLiveStreams`).
        let optional = settings.enabledOptionalLanguages
        // turbo's language head settles a Turkish candidate (`TurkishCheck`) and an Arabic one
        // (`ArabicCheck`, C4 §14.1) — one head for both, on turbo's own context.
        var languageHead: (any AcousticClassifier)?
        // Not with the language-ID model (P4): Turkish and Arabic are classes of its own there,
        // decided with the transcripts, and turbo's head is not asked.
        if !optional.isEmpty, languageID == nil, let turbo = russianEngine {
            languageHead = WhisperLanguageHead(engine: turbo)
        }
        if optional.contains(.turkish), let turbo = russianEngine {
            engines[.turkish] = StreamingWhisperEngine(
                whisper: turbo, language: .turkish, configuration: tunedTurboStreaming(),
                speechDetectorURL: speechDetectorURL)
        }
        if optional.contains(.arabic), let decoder = arabicDecoder {
            var streaming = Self.arabicStreaming()
            arabicStreamingTuning?(&streaming)
            // Reaches turbo only (Cohere takes no prompt): the punctuated Arabic exemplar.
            streaming.hint = settings.vocabularyValue.hint(for: .arabic)
            engines[.arabic] = StreamingArabicEngine(decoder: decoder, configuration: streaming,
                                                     speechDetectorURL: speechDetectorURL)
        }

        var config = DictationSession.Config()
        config.silenceThreshold = settings.silenceThreshold
        config.polishDeadline = .seconds(max(1, settings.polishTimeoutSeconds))
        config.defaultLanguage = settings.defaultLanguage
        config.languages = languages
        // The user's own history (D-11): a first Turkish dictation needs stronger evidence.
        config.turkishFamiliar = settings.turkishDictations > 0
        config.arabicFamiliar = settings.arabicDictations > 0
        // The language decision (P4, D-14), over the languages that have an engine here.
        let routable = LanguageSubset(languages.languages.filter {
            !$0.isOptional || engines[EngineFamily(for: $0)] != nil })
        let policy = LanguagePolicy(prior: settings.languagePrior, enabled: routable.languages)
        if languageID != nil { config.languageID = policy }
        sessionTuning?(&config)

        // Captured by value so the closure stays Sendable and cannot reach back into the
        // controller from whatever thread the session happens to be on.
        let replacements = settings.replacementSet
        // The mode gets a say. `Mode.autocapitalizeInsert` is declared, encoded, decoded and was
        // read by nothing — so Super, which ships it `false` and whose prompt says "Do not
        // capitalise", had every sentence-initial letter capitalised anyway by the layer beneath
        // it. The preserve-tier mode's defining guarantee was broken and no mode, built-in or
        // user-authored, could opt out.
        let capitalise = settings.autoCapitalise && mode.autocapitalizeInsert
        let cleansUp = ModeBehaviour(mode: mode) != .raw
        // Seeded with the user's own vocabulary: the words they told us about are exactly the
        // ones that should keep their capitals.
        let capitaliser = Capitaliser(
            alwaysCapitalised: Set(settings.vocabulary.values.flatMap { $0 }))

        return DictationSession(
            audio: audio,
            router: languageID.map { lid -> any LanguageRouter in
                LanguageIDRouter(classifier: lid, policy: config.languageID ?? policy,
                                 fallback: settings.defaultLanguage)
            } ?? TieredRouter(classifier: detector,
                              clusterMass: ClusterMass(threshold: settings.turkicThreshold),
                              fallback: settings.defaultLanguage,
                              optional: OptionalLanguageRules(
                                enabled: Set(optional.filter { engines[EngineFamily(for: $0)] != nil })),
                              languages: languages),
            engines: engines,
            sink: turn.ordered(ClipboardFallbackSink(
                makeSink(), fallback: noTextTarget,
                onFallback: { [weak self] in
                    Task { @MainActor in self?.noteWentToClipboard(press: press) }
                })),
            polisher: nil,
            normalise: { text, language in
                var out = text
                // `forDelivery`, NOT `clean`. `clean` is the leaderboard's normaliser: it
                // lowercases and turns every `.`, `,` and `?` into a space, which is what makes
                // Kotiba's WER comparable to published Uzbek numbers and what made its output
                // read like a telegram. It also silently disabled `Capitaliser`, which finds
                // sentence starts by looking for the punctuation `clean` had just removed.
                // Uzbek's apostrophes; Arabic's marks, digits and case endings (D-11, C4 §14.3).
                out = Orthography.forDelivery(out, language: language)
                // Fillers, stutters, the transcriber's mid-sentence stops, spoken punctuation,
                // spacing — deterministic, well under a millisecond, and never a new word. Raw
                // is exactly what was said, so it skips this.
                if cleansUp { out = DictationCleanup(language: language).apply(out) }
                out = replacements.apply(to: out)
                // Language-aware: Turkish capitalises `i` as `İ`, and Arabic has no case, so the
                // capitaliser leaves it alone (D-11).
                if capitalise { out = capitaliser.restore(out, language: language) }
                return out
            },
            config: config,
            expectedPin: effectivePin(for: mode),
            livePolish: livePolishPlan(for: mode),
            languageHead: languageHead)
    }

    /// The streaming session for whisper turbo — Turkish, and Arabic's fallback behind Cohere.
    ///
    /// Greedy background decodes, as for Uzbek. The encoder margin is NOT Uzbek's: turbo handed
    /// the fine-tune's fitted(256) window loops — it repeats the sentence inside one decode.
    /// Measured on the 200 FLEURS Turkish clips through `kotiba-probe stream --language tr`
    /// (C4 §12): fitted(256) 12.7 % WER, CER 7.5; fitted(512) 7.3 / 2.6; fitted(768) 7.3 / 2.6;
    /// batch full window 7.2 / 2.6. So 512 — 10 s of encoded silence, the smallest that matched.
    /// Cohere ignores the window.
    private func tunedTurboStreaming() -> StreamingWhisperSession.Configuration {
        var streaming = Self.turboStreaming()
        turboStreamingTuning?(&streaming)
        return streaming
    }

    static func turboStreaming() -> StreamingWhisperSession.Configuration {
        var streaming = StreamingWhisperSession.Configuration()
        streaming.backgroundBeamSize = 1
        streaming.audioContext = .fitted(margin: turboMargin)
        return streaming
    }

    /// Encoder positions of silence after the audio for turbo's fitted window (50 a second).
    static let turboMargin = 512

    /// Arabic's stream: turbo's (fitted 512 for the fallback), with Cohere's own commit length.
    ///
    /// Cohere takes no prompt, so a commit costs it nothing a carried prompt would have saved —
    /// only the acoustic context across the cut — while every second left uncommitted is a
    /// second the pause decode at the release has to read again (its cost grows with the audio:
    /// C4 §4, 150 ms at 3 s, 284 ms at 10 s). So Arabic commits far sooner than whisper does.
    /// Measured (C4 §14.4, `kotiba-probe stream --cohere`, 200 FLEURS MSA + 200 Casablanca
    /// clips): see `arabicSegment`.
    static func arabicStreaming() -> StreamingWhisperSession.Configuration {
        var streaming = turboStreaming()
        streaming.segmenter.minimumSegment = arabicSegment
        streaming.segmenter.maximumSegment = arabicSegment + 4
        streaming.segmenter.relaxAfter = arabicSegment + 2
        return streaming
    }

    static let arabicSegment: Double = 20

    /// A dictation's text had nowhere to go and is on the clipboard. Only the newest press may say
    /// so: an earlier dictation finishing under a newer one must not put its hint over the pill of
    /// the one being spoken now.
    func noteWentToClipboard(press: UInt64) {
        guard press == pressCount else { return }
        lastWentToClipboard = true
    }

    /// The mode's sentence-by-sentence polish, run during the hold — for the built-in modes that
    /// polish at all. The same members, in the same order, as `makePolisher` puts behind the
    /// whole-transcript path; the session falls back to that path at key-up whenever the live one
    /// does not describe the final transcript.
    func livePolishPlan(for mode: Mode) -> DictationSession.LivePolish? {
        guard settings.polishEnabled, let behaviour = ModeBehaviour(mode: mode), behaviour != .raw,
              !AppKnowledge.isSensitive(AppKnowledge.format(forBundleID: Focus.frontmostBundleID))
        else { return nil }
        let members = polishChain(for: mode)
        let chain: (any PolishEngine)? = members.isEmpty ? nil
            : members.count == 1 ? members[0] : CompositePolisher(members)
        return DictationSession.LivePolish(behaviour: behaviour, engine: chain)
    }

    /// The polisher for this dictation, or nil when the mode does not ask for one.
    ///
    /// On-device first: it costs nothing, sends nothing anywhere, and answers in-process, which
    /// is the only way per-dictation clean-up is affordable — a network round trip against a
    /// reasoning model was measured at a 14.4 s median. The user's own key is the fallback, and
    /// which one ran is recorded in the diagnostics as `polishID`.
    ///
    /// The key is read from the Keychain per dictation rather than held: a secret in memory for
    /// the whole process lifetime is a larger target than one read when it is needed.
    private func makePolisher(for mode: Mode) async -> (any PolishEngine)? {
        guard settings.polishEnabled else { return nil }
        // Second gate on the same rule. `resolveMode` already returns the raw mode for a
        // credential field, but that depends on the mode having no prompt; this depends on
        // nothing, and the thing being protected is a password.
        guard !AppKnowledge.isSensitive(
            AppKnowledge.format(forBundleID: Focus.frontmostBundleID)) else { return nil }
        let members = polishChain(for: mode)
        // Ordered, not exclusive: the on-device llama model claims all three languages, Apple's
        // only English, and each falls through to the next on failure.
        let chain: (any PolishEngine)? = members.isEmpty ? nil
            : members.count == 1 ? members[0] : CompositePolisher(members)
        // A built-in mode runs sentence by sentence with its own on-device prompts and
        // per-sentence fallback (docs/research/C3-on-device-modes.md), and still does its
        // deterministic half with no model at all. A user-authored mode keeps its own prompt.
        if let behaviour = ModeBehaviour(mode: mode) {
            return behaviour == .raw ? nil : ModePolisher(behaviour: behaviour, engine: chain)
        }
        guard mode.prompt != nil else { return nil }
        return chain
    }

    /// Whether the modes' on-device model is in the models directory.
    public var polishModelInstalled: Bool { polishModelPath != nil }

    /// The modes' GGUF: the models directory first, then a `--with-models` bundle's copy.
    private var polishModelPath: String? {
        Self.modelDirectories(settings)
            .map { $0.appendingPathComponent(ModelCatalogue.polishModel.destination).path }
            .first { FileManager.default.fileExists(atPath: $0) }
    }

    /// Arabic's own modes model (C4 §14.5), when Arabic is on and its GGUF is on disk.
    var arabicModesPath: String? {
        Self.modelDirectories(settings)
            .map { $0.appendingPathComponent(ModelCatalogue.arabicModesModel.destination).path }
            .first { FileManager.default.fileExists(atPath: $0) }
    }

    /// Gemma 4 E2B for Arabic dictations only, shared across them like `llamaPolisher`. Nil
    /// while Arabic is off or the file is not here — then Arabic's modes run on `llamaPolisher`.
    private var arabicModesPolisher: LlamaPolisher?

    func arabicModesModel() -> LlamaPolisher? {
        guard settings.enabledOptionalLanguages.contains(.arabic), let path = arabicModesPath else {
            arabicModesPolisher = nil
            return nil
        }
        if arabicModesPolisher == nil {
            let idle = Self.idleUnloadDelay(settings: settings) ?? .seconds(365 * 24 * 3600)
            arabicModesPolisher = LlamaPolisher(modelPath: path, id: "gemma-4-e2b-ar",
                                                languages: [.arabic],
                                                idleUnload: max(idle, .seconds(60)))
        }
        return arabicModesPolisher
    }

    /// The on-device model for the modes, shared across dictations so its weights and cached
    /// prompts survive from one to the next. Nil until its GGUF is in the models directory —
    /// `download(ModelCatalogue.polishModel)` puts it there.
    private var llamaPolisher: LlamaPolisher?

    func onDeviceModel() -> LlamaPolisher? {
        guard let path = polishModelPath else {
            llamaPolisher = nil
            return nil
        }
        if llamaPolisher == nil {
            // Its own backstop timer matches the whisper models'; the controller's poll is what
            // normally releases it (`releaseModels`).
            let idle = Self.idleUnloadDelay(settings: settings) ?? .seconds(365 * 24 * 3600)
            llamaPolisher = LlamaPolisher(modelPath: path, idleUnload: max(idle, .seconds(60)))
        }
        return llamaPolisher
    }

    /// Exactly what will polish, in the order it will be tried. One list, three readers.
    ///
    /// `preferOnDeviceModel` used to be interpreted differently in each place that consulted it:
    /// `makePolisher` treated it as a hard gate, `polishStatus` as "this is what will run", and
    /// the blocker did not read it at all — it asked whether Apple's model exists *on the machine*.
    /// So turning the toggle off with no API key saved left `members` empty, polish silently dead
    /// for every mode, no blocker, and a settings pane still reporting "Apple's on-device model is
    /// ready". Deriving all three from this one function is what keeps them from disagreeing.
    func polishChain(for mode: Mode) -> [any PolishEngine] {
        guard settings.polishEnabled else { return [] }
        var members: [any PolishEngine] = []
        if settings.preferOnDeviceModel {
            // llama.cpp first: all three languages, the same behaviour on every Mac and on
            // Windows, and measured faster per sentence than Apple's model (~70–160 ms against
            // ~430 ms p50). Apple's is the English backstop for a Mac that has not downloaded it.
            // Arabic's own model first, for Arabic only (C4 §14.5); it claims nothing else, so
            // every other language falls through to Qwen exactly as before.
            if let arabic = arabicModesModel() { members.append(arabic) }
            if let llama = onDeviceModel() { members.append(llama) }
            if let apple = AppleIntelligencePolisher() { members.append(apple) }
        }
        // The network is opt-in now, and last. Every mode works on-device; a user who wants a
        // bigger model for a restructuring mode can still bring a key and switch this on.
        if settings.cloudPolish,
           let key = try? Keychain.get(account: settings.polishKeyAccount), !key.isEmpty {
            // Uzbek is excluded unless the user has explicitly opted in. Measured: 7 of 14 real
            // model rewrites of real Uzbek changed words the speaker did not say. `DictationSession`
            // skips a polisher that does not claim the language, so this needs no new control flow.
            var languages = Set(Language.allCases)
            if !settings.polishUzbek { languages.remove(.uzbek) }
            for model in [settings.polishModel, settings.polishFallbackModel]
            where !model.isEmpty {
                members.append(PolishClient(
                    configuration: PolishConfiguration(baseURL: settings.polishBaseURL,
                                                       model: model),
                    apiKey: key,
                    supportedLanguages: languages))
            }
        }
        return members
    }

    /// What is actually available to clean text up with, for the settings pane to state plainly
    /// rather than leave the user guessing why a mode did nothing.
    public var polishStatus: String {
        guard settings.polishEnabled else {
            return L("polish.status.off")
        }
        // Describe what will actually run, not what settings imply. These used to be derived
        // separately and could contradict each other.
        let chain = polishChain(for: modes.defaultMode)
        guard let first = chain.first else {
            return settings.preferOnDeviceModel
                ? L("polish.status.nothing.unavailable",
                    Self.availabilityText(OnDeviceModel.availability))
                : L("polish.status.nothing.switchedOff")
        }
        if first is LlamaPolisher {
            return L("polish.status.llama")
        }
        if first.polishID == "apple-on-device" {
            let languages = OnDeviceModel.supportedLanguages
                .map(Self.name(of:)).sorted().joined(separator: ", ")
            let apple = L("polish.status.apple", languages)
            return chain.count > 1 ? apple + " " + L("polish.status.apple.backstop") : apple
        }
        return L("polish.status.endpoint", settings.polishBaseURL, first.polishID)
    }

    /// One rendered prompt per language, because the route is not known yet.
    ///
    /// This returned a single string for `mode.language ?? settings.defaultLanguage` — always
    /// English, since no built-in mode pins a language — rendered at key-up before the acoustic
    /// pass had run. Every Russian and Uzbek dictation therefore reached the model under "The
    /// text is in en. Keep it in en. Never translate.", plus the English vocabulary list. The
    /// session now resolves the set by the language it actually routed to.
    ///
    /// A pinned mode still renders only its own language: the pin is absolute, so the other two
    /// can never be asked for.
    private func polishInstructions(for mode: Mode) -> PolishInstructions? {
        guard mode.prompt != nil else { return nil }
        let languages = mode.language.map { [$0] } ?? Language.allCases
        // The screen is read once, not three times. `polishInstructions(for:language:)` takes
        // the capture rather than making it.
        let screen = Self.readsScreen(mode) ? ScreenContext.capture() : nil
        let now = Date()
        var byLanguage: [Language: String] = [:]
        for language in languages {
            byLanguage[language] = polishInstructions(for: mode, language: language,
                                                      screen: screen, now: now)
        }
        return .perLanguage(byLanguage)
    }

    private func polishInstructions(for mode: Mode, language: Language,
                                    screen: ScreenContext?, now: Date) -> String? {
        guard let prompt = mode.prompt else { return nil }
        // What is actually on screen. This is the difference between a prompt that knows the
        // speaker is writing to Mark in Mail, and one that knows only a bundle id — and it is
        // most of what makes a commercial dictation app's best mode good. Read here, after transcription,
        // because the app the text lands in is the app that matters.
        // The mode decides what it is allowed to see. `contextFromActiveApplication`,
        // `contextFromSelection` and `contextFromClipboard` are declared on `Mode`, encoded,
        // decoded, and were read by nothing — so a mode that asked for none of it got all of it,
        // and a user-authored mode using {{selection}} or {{clipboard}} got empty strings with no
        // error. Reading the screen is also the least private thing Kotiba does, so a mode that
        // does not ask should not pay for it.
        return prompt.render(Self.promptContext(
            mode: mode,
            screen: screen,
            bundleID: mode.contextFromActiveApplication ? Focus.frontmostBundleID : nil,
            language: language,
            vocabulary: settings.vocabularyValue.terms(for: language),
            clipboard: mode.contextFromClipboard ? Self.clipboardText() : "",
            now: now))
    }

    /// Whether this mode needs the screen read at all.
    ///
    /// `ScreenContext.capture()` is one call that answers two separate questions — what app am I
    /// in, and what is selected — and the gate used to be `contextFromActiveApplication` alone.
    /// So a mode that asked for the selection and *not* the application never captured anything,
    /// and `{{selection}}` rendered empty: the exact silent-empty-variable failure that filling
    /// `ScreenContext.selection` was written to end. The two grants are independent, and either
    /// one is a reason to look.
    ///
    /// Never for a built-in mode. Its polish runs sentence by sentence on its own on-device
    /// prompts (`ModePolisher`, `IncrementalPolish`), and the whole-dictation template rendered
    /// here reaches no model — only `PolishGuard`'s echo check. Yet all four ship with
    /// `contextFromActiveApplication`, so every Super, Message and Note key-up walked the focused
    /// element, its parent and up to 40 siblings over Accessibility — ~90 synchronous round trips
    /// into the frontmost app, on the main actor, *before* `finish` began — and read the
    /// selection, for nothing. Unmeasured by `kotiba-probe e2e`, which is not trusted for
    /// Accessibility and so returns from `capture()` at once.
    static func readsScreen(_ mode: Mode) -> Bool {
        ModeBehaviour(mode: mode) == nil
            && (mode.contextFromActiveApplication || mode.contextFromSelection)
    }

    /// What a mode is allowed to see, given what was on screen.
    ///
    /// Static and separate because the capture needs Accessibility and a frontmost application,
    /// so the *gating* — the part with the bug in it — could not be tested at all while it was
    /// tangled up with the read. Everything derived from the application is gated on
    /// `contextFromActiveApplication`; only the selection is gated on `contextFromSelection`.
    static func promptContext(mode: Mode, screen: ScreenContext?, bundleID: String?,
                              language: Language, vocabulary: [String],
                              clipboard: String, now: Date) -> PromptContext {
        // A mode that asked only for the selection gets only the selection: the app name, the
        // field, the user's name and the visible names are the other grant, and reading the
        // screen for one of them must not hand over the other.
        let app = mode.contextFromActiveApplication ? screen : nil
        return PromptContext.forApp(
            bundleID: bundleID,
            transcript: "",
            language: language,
            selection: mode.contextFromSelection ? (screen?.selection ?? "") : "",
            clipboard: clipboard,
            datetime: Self.timestamp.string(from: now),
            locale: Locale.current.identifier,
            user: app?.userName ?? "the speaker",
            field: app?.fieldDescription ?? "",
            // The user's own vocabulary first — those are the words they told us they say —
            // then whatever is visible around the caret.
            names: vocabulary + (app?.names ?? []),
            appName: app?.appName)
    }

    /// The clipboard, for a mode that asked for it. Read at polish time and never stored.
    private static func clipboardText() -> String {
        #if os(macOS)
        return NSPasteboard.general.string(forType: .string) ?? ""
        #else
        return ""
        #endif
    }

    private static let timestamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter
    }()

    /// Which mode this dictation runs in. The frontmost app decides unless the user turned that
    /// off — a terminal wants a command, Mail wants an email, and having to choose by hand
    /// every time is the friction that makes people stop using dictation.
    public func resolveMode() -> Mode {
        let bundleID = Focus.frontmostBundleID

        // A credential field never reaches a model. `AppKnowledge.isSensitive` existed for
        // exactly this and had no caller anywhere in Sources — so dictating into 1Password
        // resolved to the default mode, which has a prompt, which built a polisher, which sent
        // the secret to whatever endpoint was configured. A password leaving the machine is
        // worse than any formatting defect, and this check comes before everything else so
        // nothing below can override it.
        if AppKnowledge.isSensitive(AppKnowledge.format(forBundleID: bundleID)) {
            return modes.mode(for: "transcription") ?? modes.defaultMode
        }

        // An explicit choice beats the app. Without this, `setMode` was a no-op in any app with
        // an activation rule — and that is an Uzbek bug, not an annoyance: Telegram is in
        // `message`'s activation list, so picking Oʻzbekcha and dictating into Telegram
        // silently dropped the pin.
        if let picked = userPickedMode, let mode = modes.mode(for: picked) {
            return mode
        }
        guard settings.modeFollowsApp else {
            return modes.mode(for: settings.defaultModeKey) ?? modes.defaultMode
        }
        return modes.mode(forBundleID: bundleID)
    }

    /// A mode the user chose by hand. Sticks until they choose another, or Automatic.
    ///
    /// It used to expire when the frontmost application changed, which meant it never applied
    /// at all: choosing from the menu bar makes *Kotiba* frontmost, so the very next dictation —
    /// in any other window, which is every dictation — saw a different app and threw the choice
    /// away. Every mode behaved like the default, which is exactly what was reported.
    public private(set) var userPickedMode: String?

    /// What the user may choose, in the order they asked for.
    ///
    /// `transcription` is deliberately absent. It stays in the registry because `resolveMode`
    /// routes a credential field to it, but offering "raw" as a choice is offering the state
    /// the app falls into by itself whenever no model is available.
    public var selectableModes: [Mode] {
        ["super", "note", "message"].compactMap { modes.mode(for: $0) }
    }

    /// The user picked this mode by hand, for now. Overrides `modeFollowsApp` until cleared.
    public func setMode(_ key: String) {
        userPickedMode = key
        settings.defaultModeKey = key
        modes.defaultKey = key
        activeModeKey = key
        settings.save()
    }

    /// The language the user pinned by hand, or nil for automatic. Mirrors `settings` so the menu
    /// can render a checkmark without reaching into storage.
    public var pinnedLanguage: Language? { settings.pinnedLanguage }

    /// Which languages may be pinned right now — no point offering one whose model is missing.
    public var pinnableLanguages: [Language] {
        languageOrder.order.filter { settings.availableLanguages.contains($0) }
    }

    /// The dictation languages a picker lists, in the pickers' order: the three core ones always
    /// (greyed when their model is missing), an optional one only once it is on (D-11).
    public var dictationLanguages: [Language] {
        languageOrder.order.filter(settings.languageSubset.contains)
    }

    /// Turn a dictation language on or off (`AppSettings.enabledLanguages`). The last one on
    /// cannot be turned off (the toggle is disabled; this refuses too). On, its model row is
    /// queued if it is not on disk. Off, a pin on it is released, the default moves to one that
    /// is on, and what only it was holding in memory is given back (`settingsChanged`).
    public func setLanguage(_ language: Language, enabled: Bool) {
        let now = settings.languageSubset
        let next = now.setting(language, on: enabled)
        guard next != now else { return }
        settings.enabledLanguages = next.ordered
        if !enabled, settings.pinnedLanguage == language { settings.pinnedLanguage = nil }
        settings.defaultLanguage = next.fallback(preferring: settings.defaultLanguage)
        // Everything the language needs, at once (Arabic: Cohere, turbo and its modes model) —
        // the switch's own caption named the size before it was flipped.
        if enabled, let models {
            models.download(Set(ModelDownloads.Item.items(for: language)
                .filter { !models.state($0).isInstalled }))
        }
        Task { await settingsChanged() }
    }

    /// Set every dictation language at once — onboarding's "Which languages do you dictate in?".
    /// The same rules as `setLanguage`, without queuing downloads (onboarding starts them when
    /// it leaves the step, core and optional languages together).
    public func setLanguages(_ on: LanguageSubset) {
        guard on != settings.languageSubset else { return }
        settings.enabledLanguages = on.ordered
        if let pin = settings.pinnedLanguage, !on.contains(pin) { settings.pinnedLanguage = nil }
        settings.defaultLanguage = on.fallback(preferring: settings.defaultLanguage)
        Task { await settingsChanged() }
    }

    public func setPinnedLanguage(_ language: Language?) {
        settings.pinnedLanguage = language
        settings.save()
    }


    /// Change which mode is used when nothing else decides — without pinning it.
    ///
    /// The Settings picker is labelled "Fallback mode" precisely when `modeFollowsApp` is on, and
    /// it used to call `setMode`. That latched `userPickedMode`, and since `resolveMode()` checks
    /// the pin before it checks `modeFollowsApp`, changing the *fallback* silently turned
    /// app-following off — with its toggle still showing on, and permanently, because nothing
    /// anywhere ever wrote nil back. Setting a default and pinning a mode are different intents
    /// and now have different methods.
    public func setDefaultMode(_ key: String) {
        settings.defaultModeKey = key
        modes.defaultKey = key
        activeModeKey = resolveMode().key
        settings.save()
    }

    /// Back to letting the app decide. The transition `userPickedMode`'s own documentation
    /// promised — "sticks until they choose another, or Automatic" — and which had no
    /// implementation, so there was no way out of a pin once it was set.
    public func clearPickedMode() {
        userPickedMode = nil
        activeModeKey = resolveMode().key
    }

    // MARK: - The level meter

    private func startLevelMeter() {
        levelTask?.cancel()
        levelTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.level = self.microphone.currentPeak()
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
    }

    private func stopLevelMeter() {
        levelTask?.cancel()
        levelTask = nil
        level = 0
    }

    // MARK: - Messages

    static func describe(_ failure: SessionFailure) -> String {
        switch failure {
        case .armingFailed(let why): return L("error.arming", why)
        case .captureFailed(let why): return L("error.capture", why)
        case .noEngineReady(_, let language):
            // Named by language, not by family. `.unified` covers English and Russian, so keying
            // off the family alone reported a missing Russian model as an English problem and
            // pointed the user at the one thing that was working.
            switch language {
            case .english:
                return L("error.englishNotReady")
            case .russian, .uzbek, .turkish, .arabic:
                return L("error.noModel", Self.modelName(of: language))
            }
        case .transcriptionFailed(let why): return L("error.transcription", why)
        case .insertionRefused(let why): return L("error.insertion", why)
        case .insertionTimedOut: return L("error.insertionTimedOut")
        }
    }

    /// The same failure in the few words the pill has room for — what went wrong, never why.
    /// The why is in `describe(_:)`, which Home shows.
    static func pillHeadline(_ failure: SessionFailure) -> String {
        switch failure {
        case .armingFailed: return L("pill.failed.microphone")
        case .captureFailed: return L("pill.failed.recording")
        case .noEngineReady(_, let language):
            switch language {
            case .english: return L("pill.failed.englishNotReady")
            case .russian: return L("pill.failed.noRussianModel")
            case .uzbek: return L("pill.failed.noUzbekModel")
            case .turkish, .arabic: return L("pill.failed.noModel")
            }
        case .transcriptionFailed: return L("pill.failed.transcription")
        case .insertionRefused: return L("pill.failed.paste")
        case .insertionTimedOut: return L("pill.failed.pasteTimedOut")
        }
    }

    static func describe(_ error: any Error) -> String {
        (error as? EngineFailure)?.reason ?? "\(error)"
    }
}

// MARK: - Small conveniences

extension ModeRegistry {
    /// Only reachable if a built-in prompt fails its own validation, which a test prevents.
    /// Still better than a crash on launch.
    static var emptyFallback: ModeRegistry {
        // `try!` is safe here: this literal registry is valid by construction.
        // swiftlint:disable:next force_try
        try! ModeRegistry(modes: [Mode(key: "transcription", name: "Transcription")],
                          defaultKey: "transcription")
    }
}

/// `Duration` in seconds, for comparing against a `Date` interval.
///
/// `idleUnloadDelay` returns a `Duration` because that is what reads well in a test, and the
/// idle poll needs the same quantity as a `TimeInterval`. Both halves of the components matter:
/// a sub-second timeout is legitimate in a test and would otherwise truncate to zero.
extension Duration {
    var seconds: Double {
        Double(components.seconds) + Double(components.attoseconds) * 1e-18
    }
}
