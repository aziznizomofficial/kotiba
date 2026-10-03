import Foundation
import KotibaCore
import KotibaModels
import KotibaPlatform
import Observation
import SwiftUI

// Everything the user can change, in one place, persisted as one JSON blob.
//
// One blob rather than thirty UserDefaults keys because the settings are read together, written
// together, and — the part that matters — need to survive a version bump without a migration
// per field. Unknown keys decode to defaults; a field removed in a later version is simply
// ignored. The same tolerance `Mode` already applies to its own JSON.
//
// The API key is NOT here. It lives in the Keychain, and this file holds only the account name
// that finds it. Anything written here could end up in a support bundle.

@Observable
public final class AppSettings {

    // MARK: Dictation

    /// The language used when nothing pins one. Not always English: for the people this is
    /// built for, "the language I speak" is usually Uzbek, and making them pick a mode every
    /// time would be the app failing at its one job.
    public var defaultLanguage: Language = .english

    /// A language the user pinned by hand. `nil` means let the acoustic router decide.
    ///
    /// This is the override that did not exist. `KotibaMacApp` justified having no language picker
    /// with "Kotiba works out which language is being spoken — measured at 88% on Uzbek with no
    /// English or Russian ever mistaken for it", and pointed at Settings › Languages as the
    /// fallback for the misses. Neither part held:
    ///
    ///   * Measured here on 745 clips of real Uzbek through the shipping `ggml-base-q5_1`
    ///     detector at the live 0.05 threshold, recall is **83.1%**, not 88% — and **58.4%** on
    ///     clips under two seconds, which is what most dictation is.
    ///   * English is mistaken for it. This user's own diagnostics carry two English utterances at
    ///     Turkic cluster mass 0.230 and 0.119, both routed to the Uzbek engine, against real
    ///     Uzbek at 0.183 and 0.0122. The classes interleave, so no threshold separates them.
    ///   * And `defaultLanguage` was never consulted as a pin at all once a detector was loaded,
    ///     so the advertised fallback did nothing.
    ///
    /// A pin runs at router tier P1: zero milliseconds, absolute, nothing below it executes.
    public var pinnedLanguage: Language?

    /// The dictation languages the user dictates in — any of the five, at least one
    /// (`LanguageSubset`). Uzbek, English and Russian by default; Turkish and Arabic (D-11) are
    /// off until turned on in Settings › Languages or onboarding (on there when the Mac's own
    /// language is one of them). A language that is off is never routed to and costs nothing:
    /// no stream, no preload, no model kept warm, no place in the Home row or the menu.
    ///
    /// Replaces `optionalLanguages` (Turkish/Arabic only), which `Snapshot` migrates: the core
    /// three plus whatever optional ones were on.
    public var enabledLanguages: [Language] = [.english, .russian, .uzbek]

    /// Turkish dictations delivered so far, pinned or recognised — the user's own history, which
    /// `TurkishCheck` reads: until the first, a Turkish candidate needs a `tr` share of 0.995
    /// rather than 0.99 (`TurkishCheck.verifiedFromUnfamiliar`, D-11). Counted, not stored as
    /// text, so it survives "keep history" being off.
    public var turkishDictations: Int = 0

    /// Arabic dictations delivered so far, the same way — `ArabicCheck` reads it: until the
    /// first, an Arabic candidate needs an `ar` share of 0.98 from turbo's head rather than 0.95
    /// (`ArabicCheck.verifiedFromUnfamiliar`, C4 §14.1).
    public var arabicDictations: Int = 0

    /// Uzbek, English and Russian dictations delivered so far, counted the same way: with the
    /// two above, the user's own history the language decision's prior reads (`LanguagePrior`,
    /// P4). Seeded once from History on the first launch of a build that has them
    /// (`languageCountsSeeded`), so an existing user does not start from nothing.
    public var uzbekDictations: Int = 0
    public var englishDictations: Int = 0
    public var russianDictations: Int = 0
    public var languageCountsSeeded: Bool = false

    /// The history as the language decision reads it.
    public var languagePrior: LanguagePrior {
        LanguagePrior(counts: [.uzbek: uzbekDictations, .english: englishDictations,
                               .russian: russianDictations, .turkish: turkishDictations,
                               .arabic: arabicDictations])
    }

    /// One more delivered dictation in `language`.
    public func countDictation(in language: Language) {
        switch language {
        case .uzbek: uzbekDictations += 1
        case .english: englishDictations += 1
        case .russian: russianDictations += 1
        case .turkish: turkishDictations += 1
        case .arabic: arabicDictations += 1
        }
    }

    /// Where whisper's Uzbek model lives. Empty means "not set up yet", and the settings pane
    /// says so rather than the app failing at the first Uzbek dictation.
    public var uzbekModelPath: String = ""

    /// A whisper model for Russian. Optional, and separate from the Uzbek one because the two
    /// are different files: Uzbek needs a fine-tune, Russian is served fine by a stock
    /// multilingual model. Apple's engine does not do Russian at all, so without this Russian
    /// dictation has nowhere to go and the app says so.
    public var russianModelPath: String = ""

    /// Metal for whisper. Off is roughly an order of magnitude slower and exists as an escape
    /// hatch for a machine where the GPU path misbehaves.
    public var whisperUseGPU: Bool = true

    /// Beam search width. 1 is greedy.
    ///
    /// Measured on the 344-clip Uzbek set that produced this project's 25.19% WER figure, with the
    /// shipping `navoi-medium-q5_0` and whisper.cpp v1.9.2 on an M4 Pro:
    ///
    ///     greedy   25.19% WER   243 s for 54 min of audio
    ///     beam 5   24.11% WER   341 s          — 1.08 points, 4.3% relative, for 1.40x the time
    ///
    /// Greedy was the default on the grounds that "for push-to-talk dictation latency is the
    /// product", which is true and was still the wrong call for the model that ships: a quarter of
    /// the words being wrong is the thing the user actually complains about. Beam search also does
    /// not cost punctuation the way the vocabulary hint does — 68.6% against greedy's 68.3%.
    ///
    /// **But the win is a property of the model, not of beam search, and it does not survive a
    /// better one.** Measured on `Kotib/uzbek_stt_v1` (decision D-08) on the same set, beam 5 is
    /// worth 0.03 points — 21.65% against 21.68% greedy, which is noise. Per-utterance latency
    /// through this engine, median of four warm passes on an M4 Pro:
    ///
    ///     2.8 s clip   greedy 421 ms   beam 5 510 ms   (+21%)
    ///     8.8 s clip   greedy 530 ms   beam 5 735 ms   (+39%)
    ///
    /// So 5 is right for `navoi-medium` and wrong for its replacement, and whoever changes the
    /// default model has to revisit this line rather than inherit it.
    ///
    /// Lower it to 1 to get the old latency back; the setting is still here for that.
    public var whisperBeamSize: Int = 5

    /// Hold every configured model in memory rather than only the default language's.
    ///
    /// Off by default because the cost is measured and large: both whisper models resident took
    /// this app from 110 MB to 1.47 GB. On it costs that memory permanently; off it costs the
    /// first dictation in a second language a cold load — about 7.8 s from disk, 200 ms once
    /// the file is in the page cache. Someone who switches languages constantly wants it on.
    public var preloadAllLanguages: Bool = false

    /// Minutes without a dictation after which loaded whisper models are released. 0 never does.
    ///
    /// The counterweight to `preloadAllLanguages`. Without it the lazy path is only lazy until
    /// the first dictation in each language: a model loads on demand and then stays for the
    /// process lifetime. A menu-bar app that lives for weeks therefore ends up holding both —
    /// measured at 1618 MB footprint, 1395 MB of it whisper's, after a handful of dictations —
    /// and never gives it back. `WhisperEngine.unload()` was written for exactly this and had
    /// no caller anywhere.
    ///
    /// Releasing gives back about 700 MB per model, not quite all of it: ggml's Metal backend
    /// keeps a per-process device and compiled library that outlive any context, measured at
    /// roughly 140 MB. Idle after a release is therefore a few hundred MB, not the 110 MB of a
    /// process that has never transcribed. That floor is a property of the GPU backend rather
    /// than something this app is holding.
    ///
    /// Five minutes because reloading is nearly free while the file is still in the page cache
    /// — about 200 ms, and it is paid behind the user's speech at key-down, not in front of the
    /// transcript. Dictation comes in bursts: someone mid-burst never sees a reload, and
    /// someone who dictated once this morning is not still paying a gigabyte for it at lunch.
    ///
    /// Applies with `preloadAllLanguages` on as well as off. The two are about different
    /// things: that one decides *when* a model loads — eagerly at launch instead of at the
    /// first dictation in its language — and this one decides how long an unused one is kept.
    /// Reading preload as "and never release it" is precisely how a machine with it switched on
    /// sat at 1618 MB around the clock.
    public var modelIdleUnloadMinutes: Double = 5

    /// The detector. `ggml-base` is 59 MB and answers in 34 ms; `large-v3-turbo` is 574 MB and
    /// answers in 565 ms for 1.7 percentage points more recall. On a path where 117 ms is the
    /// whole English budget, that is not a trade worth making.
    public var detectorModelPath: String = ""

    /// The language-ID model (P4, D-14): `ecapa-voxlingua107-lid-f16.mlmodel`. When it is here
    /// it is the detector, and the language decision reads transcripts after it; whisper base
    /// (`detectorModelPath`) is the fallback until it has downloaded.
    public var languageIDModelPath: String = ""

    /// Turkic cluster mass above which a recording is treated as Uzbek (`ClusterMass`): on 120
    /// clips of the GAP-01 Uzbek set, English and Russian scored 0.000–0.012, Uzbek a median of
    /// 0.325. Raising it trades Uzbek recall for certainty.
    ///
    /// Deliberately not a second literal: this and `ClusterMass.defaultThreshold` used to hold
    /// different numbers, and the one that was measured lived only here.
    public var turkicThreshold: Double = ClusterMass.defaultThreshold

    /// Peak amplitude below which a recording counts as silence.
    public var silenceThreshold: Float = 0.012

    /// Play a sound on start and stop. Off by default: this app is used in meetings.
    public var soundFeedback: Bool = false

    // MARK: Text

    /// Words the engines get wrong. Fed to whisper as an initial prompt and applied as a
    /// post-pass everywhere — "Kotiba" comes back as "cotta" without it.
    public var vocabulary: [String: [String]] = [:]

    /// Literal find-and-replace, applied once, in order, with no chaining.
    public var replacements: [Replacement] = []

    /// Capitalise the first letter and add a closing full stop when the engine did not.
    public var autoCapitalise: Bool = true

    // MARK: Modes

    /// Which mode a fresh dictation starts in when no app-specific mode claims the frontmost
    /// application.
    public var defaultModeKey: String = "super"

    /// Let the frontmost application pick the mode. a commercial dictation app's best idea.
    public var modeFollowsApp: Bool = false

    // MARK: Polish

    /// On by default now that it can be free. Kotiba still pastes the raw transcript first
    /// and replaces it afterwards, so this never delays the words reaching the screen, and with
    /// no model available it is a no-op rather than a failure.
    public var polishEnabled: Bool = true

    /// Let a language model rewrite Uzbek. Off, and it should stay off.
    ///
    /// Measured: 7 of 14 real polishes of real Uzbek transcripts changed words the speaker did
    /// not say, and the general length-and-script guard caught 1 of the 7. The pull is always
    /// toward Turkish — the same force that makes Uzbek ASR hard. When this is on,
    /// `UzbekPolishGuard` rejects any polish that introduces a word absent from the transcript.
    public var polishUzbek: Bool = false

    /// Prefer Apple's on-device model over the user's own API key.
    ///
    /// On by default because it is free, private and in-process. It declares its own languages
    /// and Kotiba refuses to send it one it does not claim, which is what keeps Uzbek away from
    /// a model that has never seen it.
    public var preferOnDeviceModel: Bool = true

    /// Send dictation to the user's own endpoint when a mode polishes. Off by default: every
    /// built-in mode now runs on-device (docs/research/C3-on-device-modes.md), and a network
    /// round trip was the largest single latency item — 1,615 ms median after key-release.
    /// The key and endpoint settings below only matter once this is on.
    public var cloudPolish: Bool = false
    public var polishBaseURL: String = "https://api.groq.com/openai/v1"
    /// Was `llama-3.3-70b-versatile`, measured at 0.40 s on a 17-word dictation and 0.95 s
    /// median on a 1226-character one, with Russian and Uzbek both intact. Groq retired it —
    /// and the fallback — some time before 2026-08-22, when every polish started ending in
    /// HTTP 404 `model_not_found`. Remeasured 2026-08-23 on the user's own key against the
    /// real dictations from the diagnostics: `openai/gpt-oss-120b` answered a Uzbek Note in
    /// 1.19 s, an English Note in 1.05 s and Russian Super in 0.85–1.30 s, each intact;
    /// `qwen/qwen3.6-27b` needs a non-standard `reasoning_effort` to answer at all and dropped
    /// one connection in five. Polish runs after insertion, so a slow model does not delay the
    /// words — but it does mean the text visibly rewrites itself later.
    public var polishModel: String = "openai/gpt-oss-120b"
    /// Tried when the main model is out of budget for the day, or retired.
    ///
    /// Free tiers meter per model, not per key. A dictation costs roughly 900 tokens — mostly
    /// the mode's own instructions — so two names are about twice the dictations. Without a
    /// second name here, running out means every mode silently degrades to the on-device model
    /// and looks flat again.
    public var polishFallbackModel: String = "openai/gpt-oss-20b"

    /// Model names Groq no longer serves, and what to run instead. Applied on load when the
    /// endpoint is Groq's, because a stored blob keeps a retired name forever otherwise and the
    /// user's only symptom is that every mode quietly produces the raw transcript.
    public static let retiredPolishModels: [String: String] = [
        "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
        "llama-3.1-70b-versatile": "openai/gpt-oss-120b",
        "llama3-70b-8192": "openai/gpt-oss-120b",
        "llama-3.1-8b-instant": "openai/gpt-oss-20b",
        "llama3-8b-8192": "openai/gpt-oss-20b",
        "gemma2-9b-it": "openai/gpt-oss-20b",
        "mixtral-8x7b-32768": "openai/gpt-oss-20b",
    ]

    /// The replacement for a retired model, or the model itself when it is not retired or the
    /// endpoint is not Groq's — Cerebras and OpenRouter serve overlapping names, and a
    /// retirement at Groq says nothing about them.
    static func migratedPolishModel(_ model: String, baseURL: String) -> String {
        guard baseURL.contains("groq.com") else { return model }
        return retiredPolishModels[model] ?? model
    }

    public var polishKeyAccount: String = "polish-default"
    /// Hard ceiling. On expiry the raw transcript stands — it is already in the user's app.
    public var polishTimeoutSeconds: Double = 8

    // MARK: Hotkey and audio around it

    /// The push-to-talk key. Absent from an older blob means right ⌘, which is what every build
    /// before this one used — the migration is the default, not a rewrite.
    public var hotkey: HotkeySpec = .default

    /// Lower whatever is playing while the key is held, and put it back on release.
    public var duckingEnabled: Bool = true

    /// How loud the playing audio stays while ducked, as a fraction of its level: 0.25 is about
    /// −12 dB on the device scalar — clearly out of the way, still audible enough that nobody
    /// wonders whether their music stopped.
    public var duckLevel: Double = 0.25

    /// With a Bluetooth headset as the input, record from the Mac's own microphone instead.
    ///
    /// **Off by default**: Kotiba records from whatever input is selected in System Settings at
    /// the moment of the press. On, it trades the headset's microphone for the laptop's so the
    /// headset is never forced into the hands-free profile — 16 kHz mono, the "phone call"
    /// sound — for everything it plays. Until 1.0 this was on by default, and a user who had
    /// chosen their headset got the laptop microphone from across the room; `Snapshot` moves
    /// every stored value to off once. The choice is Kotiba's alone (its own input unit); the
    /// system default input is never touched.
    public var preferBuiltInMicWithBluetooth: Bool = false

    // MARK: App lifecycle

    /// Keep Kotiba running no matter what: ⌘Q and the Dock's Quit close the window and leave the
    /// menu-bar icon and the hotkey working, a crash or force-quit is relaunched by launchd, and
    /// it starts at login. Only switching this off, inside the app, lets it really quit.
    public var alwaysOn: Bool = false

    /// Start at login without the rest of always-on. Implied by `alwaysOn`, which starts at
    /// login itself; the two are never registered together, which would launch two copies.
    public var launchAtLogin: Bool = false

    /// The first-run walkthrough in the main window has been finished (or skipped) once. Until it
    /// has, the window opens at launch and shows it; afterwards Kotiba starts in the menu bar only.
    ///
    /// A blob written before this existed belongs to someone who has been using the app, so an
    /// absent key reads as done — only a truly fresh install (no blob at all) sees onboarding.
    /// Without that, the upgrade would greet the owner with a first-run tour of their own app.
    public var hasCompletedOnboarding: Bool = false

    /// Fetch missing recommended models in the background — Parakeet on first use, and whatever
    /// the onboarding's "Download models" step queued. On for anyone who has been using the app
    /// (an absent key keeps the default), and for a fresh install once onboarding has asked; off
    /// in a test's hermetic settings, which must never start a 632 MB download on a runner.
    public var autoDownloadModels: Bool = true

    // MARK: Interface

    /// The language of the app's own words — `en`, `ru`, `uz-Latn` or `uz-Cyrl` (`AppLanguage`).
    /// Empty means follow the system: the first of its preferred languages that is one of the four,
    /// else English. Chosen on the first page of onboarding and in Settings, and applied live.
    /// Nothing to do with the languages Kotiba hears — that is `defaultLanguage` and the router.
    public var appLanguage: String = ""

    /// How the pill moves while you talk: one of the three styles the owner kept
    /// (`PillAnimationStyle`), picked in Settings with a live preview of each. Read live by every
    /// pill, so a change shows on the next frame. Absent from an older blob means Siri lobes —
    /// the one style every build before the choice drew — so the migration is the default, not a
    /// rewrite. Stored by raw value, and an id a newer build wrote reads as the default rather
    /// than as an unreadable setting (see `Snapshot.apply`).
    public var pillStyle: PillAnimationStyle = .sirilobes

    /// The period the Statistics page last showed — `today`, `week`, `month` or `all`
    /// (`StatsPeriod`) — so it opens where the user left it. A string, like `appLanguage`: a
    /// period a newer build added reads as the default week rather than as unreadable.
    public var statsPeriod: String = "week"

    // MARK: History

    public var keepHistory: Bool = true
    /// 0 means keep everything.
    public var historyLimit: Int = 0

    // MARK: Diagnostics

    public var diagnosticsEnabled: Bool = true


    // MARK: - Persistence

    /// Separate from the app's own defaults domain so a `defaults delete` of one does not take
    /// the other with it.
    static let storageKey = "uz.kotiba.settings.v1"
    /// The key the same blob had before the app was renamed from Kotib. `RenameMigration`
    /// imports the old defaults domain under the new key, but a blob that only exists under the
    /// old one — a `defaults import` by hand, a migration that stopped half way — is still the
    /// user's settings, so `load()` falls back to it. The next `save()` writes the new key.
    static let legacyStorageKey = "uz.kotib.settings.v1"

    /// Internal rather than private so the rename notice (`RenameNotice.swift`) can keep its
    /// flag in the same domain without becoming a field of the blob — and of the Windows
    /// golden fixture parsed from this file's `public var`s.
    let store: UserDefaults
    /// Suppresses writes while `load()` is populating, so decoding does not trigger 20 saves.
    private var loading = false

    /// Where auto-discovery looks for models, and the app bundle it will fall back to.
    ///
    /// Injected rather than read from a global, because the alternative is not hermetic: a test
    /// with a scratch `UserDefaults` would still find whatever models happen to be installed on
    /// the machine running it, and "an unconfigured Uzbek is not ready" would pass or fail
    /// depending on whose laptop it ran on. It defaults to the real directory, so the app gets the
    /// behaviour and tests get to choose.
    private let modelDirectory: URL

    /// Where Kotiba's own downloads live and auto-discovery looks first. The controller builds
    /// every engine against this rather than the global support directory, so a test's hermetic
    /// settings also keep its engines away from whatever models the machine happens to hold.
    public var modelsDirectory: URL { modelDirectory }
    /// The bundle whose `Resources/models` is searched last, or nil to skip that step. Injectable
    /// for the same reason as `modelDirectory`, and specifically so the shipped-bundle case — the
    /// one a .dmg depends on — can be tested against a real directory rather than trusted.
    private let modelBundle: Bundle?

    /// Where history and diagnostics are opened. `supportDirectory` in the app; a test's
    /// hermetic settings pass a scratch directory. It used to be read from the global by the
    /// controller, so every test that reached `start()` opened the real history database and
    /// diagnostics log of whoever ran `make test` — and, after the rename, created an empty
    /// `~/Library/Application Support/Kotiba` that `RenameMigration` then had to merge around.
    public let stateDirectory: URL

    public init(store: UserDefaults = .standard,
                modelDirectory: URL? = nil,
                modelBundle: Bundle? = .main,
                stateDirectory: URL? = nil) {
        self.store = store
        self.modelDirectory = modelDirectory
            ?? Self.supportDirectory.appendingPathComponent("models")
        self.modelBundle = modelBundle
        self.stateDirectory = stateDirectory ?? Self.supportDirectory
        load()
    }

    /// Set when the stored settings could not be read as they were written. Nil is the normal
    /// state. The raw bytes are kept under `\(storageKey).unreadable` whenever this is set.
    public private(set) var loadFailure: String?
    /// The keys behind a partial `loadFailure`, so the window can say the same in the interface
    /// language. Empty when the whole blob was unreadable (or nothing failed).
    public private(set) var droppedKeys: [String] = []

    public func load() {
        guard let data = store.data(forKey: Self.storageKey)
                ?? store.data(forKey: Self.legacyStorageKey) else { return }
        loadFailure = nil
        droppedKeys = []

        guard let (snapshot, dropped) = Self.decodeSalvaging(data) else {
            // Nothing readable at all. Defaults are usable, but the old blob is NOT overwritten
            // silently the way it used to be: `save()` fires on the next keystroke in Settings,
            // and the model paths in here are the hardest state in the app to reconstruct.
            store.set(data, forKey: Self.storageKey + ".unreadable")
            loadFailure = "the saved settings could not be read; a copy has been kept"
            return
        }
        if !dropped.isEmpty {
            droppedKeys = dropped.sorted()
            store.set(data, forKey: Self.storageKey + ".unreadable")
            loadFailure = "these settings could not be read and were left at their defaults: "
                + dropped.sorted().joined(separator: ", ")
        }
        loading = true
        snapshot.apply(to: self)
        loading = false
    }

    /// Decode what can be decoded, and report what could not.
    ///
    /// `Snapshot` is decoded atomically, so one unreadable value used to cost all 27 settings —
    /// `Language` is a bare raw-value enum with no unknown case, and `[Replacement]` is a
    /// synthesised Codable, so a language added in a later version or a renamed replacement field
    /// threw and took the model paths, the vocabulary and everything else with it. The user saw a
    /// factory-fresh app and a "No Uzbek model" blocker pointing at the wrong cause.
    ///
    /// Every field of `Snapshot` is optional, which makes a one-key object a valid `Snapshot` —
    /// and therefore a precise per-key validity test. Keys that cannot be read alone are dropped
    /// and named; everything else survives. Unknown keys from a newer version decode fine on
    /// their own and are simply ignored, which is the compatibility the doc comment claims.
    static func decodeSalvaging(_ data: Data) -> (snapshot: Snapshot, dropped: [String])? {
        if let clean = try? JSONDecoder().decode(Snapshot.self, from: data) { return (clean, []) }
        guard var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        var dropped: [String] = []
        for (key, value) in object {
            let readable = (try? JSONSerialization.data(withJSONObject: [key: value]))
                .flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) } != nil
            if !readable {
                dropped.append(key)
                object.removeValue(forKey: key)
            }
        }
        guard let salvaged = (try? JSONSerialization.data(withJSONObject: object))
            .flatMap({ try? JSONDecoder().decode(Snapshot.self, from: $0) }) else { return nil }
        return (salvaged, dropped)
    }

    public func save() {
        guard !loading else { return }
        guard let data = try? JSONEncoder().encode(Snapshot(self)) else { return }
        store.set(data, forKey: Self.storageKey)
    }

    /// The on-disk shape. Every field is optional on decode, so a blob written by any version —
    /// older or newer — loads, and anything missing keeps its default.
    struct Snapshot: Codable {
        var defaultLanguage: Language?
        /// Already optional in the settings themselves, and nil is a real value here — it is what
        /// "Automatic" means — so `apply` assigns it straight through rather than `if let`.
        var pinnedLanguage: Language?
        /// Codes rather than `Language`, so a language a newer build added is dropped on its own
        /// instead of making the whole field unreadable.
        var enabledLanguages: [String]?
        /// Read, never written: the Turkish/Arabic list `enabledLanguages` replaced. A blob that
        /// has only this migrates to the core three plus these.
        var optionalLanguages: [String]?
        var turkishDictations: Int?
        var arabicDictations: Int?
        var uzbekDictations: Int?
        var englishDictations: Int?
        var russianDictations: Int?
        var languageCountsSeeded: Bool?
        var uzbekModelPath: String?
        var russianModelPath: String?
        var whisperUseGPU: Bool?
        var whisperBeamSize: Int?
        var preloadAllLanguages: Bool?
        var modelIdleUnloadMinutes: Double?
        /// Read, never written: the "work out which language I am speaking" switch, removed — the
        /// per-language toggles and Automatic say it now. A blob with it off migrates to a pin on
        /// its default language, which is what off meant.
        var autoDetectLanguage: Bool?
        var detectorModelPath: String?
        var languageIDModelPath: String?
        var turkicThreshold: Double?
        var silenceThreshold: Float?
        var soundFeedback: Bool?
        var vocabulary: [String: [String]]?
        var replacements: [Replacement]?
        var autoCapitalise: Bool?
        var defaultModeKey: String?
        var modeFollowsApp: Bool?
        var polishEnabled: Bool?
        var preferOnDeviceModel: Bool?
        var polishUzbek: Bool?
        var cloudPolish: Bool?
        var polishBaseURL: String?
        var polishModel: String?
        var polishFallbackModel: String?
        var polishKeyAccount: String?
        var polishTimeoutSeconds: Double?
        var keepHistory: Bool?
        var historyLimit: Int?
        var diagnosticsEnabled: Bool?
        var hotkey: HotkeySpec?
        var duckingEnabled: Bool?
        var duckLevel: Double?
        /// Read, never written: the on-by-default value from before 1.0. Nobody chose it — the
        /// default chose it for them, and it made Kotiba ignore the microphone they had picked —
        /// so it is dropped, and every user starts from off once. A value stored under the new
        /// key below is a choice made in the opt-in toggle, and is kept from then on.
        var preferBuiltInMicWithBluetooth: Bool?
        var builtInMicWithBluetoothOptIn: Bool?
        var alwaysOn: Bool?
        var launchAtLogin: Bool?
        var hasCompletedOnboarding: Bool?
        var autoDownloadModels: Bool?
        var appLanguage: String?
        /// A string rather than `PillAnimationStyle`, so a style a newer build added decodes
        /// here and falls back to the default instead of being named as unreadable.
        var pillStyle: String?
        var statsPeriod: String?

        init(_ settings: AppSettings) {
            defaultLanguage = settings.defaultLanguage
            pinnedLanguage = settings.pinnedLanguage
            enabledLanguages = settings.enabledLanguages.map(\.rawValue)
            turkishDictations = settings.turkishDictations
            arabicDictations = settings.arabicDictations
            uzbekDictations = settings.uzbekDictations
            englishDictations = settings.englishDictations
            russianDictations = settings.russianDictations
            languageCountsSeeded = settings.languageCountsSeeded
            uzbekModelPath = settings.uzbekModelPath
            russianModelPath = settings.russianModelPath
            whisperUseGPU = settings.whisperUseGPU
            whisperBeamSize = settings.whisperBeamSize
            preloadAllLanguages = settings.preloadAllLanguages
            modelIdleUnloadMinutes = settings.modelIdleUnloadMinutes
            detectorModelPath = settings.detectorModelPath
            languageIDModelPath = settings.languageIDModelPath
            turkicThreshold = settings.turkicThreshold
            silenceThreshold = settings.silenceThreshold
            soundFeedback = settings.soundFeedback
            vocabulary = settings.vocabulary
            replacements = settings.replacements
            autoCapitalise = settings.autoCapitalise
            defaultModeKey = settings.defaultModeKey
            modeFollowsApp = settings.modeFollowsApp
            polishEnabled = settings.polishEnabled
            preferOnDeviceModel = settings.preferOnDeviceModel
            polishUzbek = settings.polishUzbek
            cloudPolish = settings.cloudPolish
            polishBaseURL = settings.polishBaseURL
            polishModel = settings.polishModel
            polishFallbackModel = settings.polishFallbackModel
            polishKeyAccount = settings.polishKeyAccount
            polishTimeoutSeconds = settings.polishTimeoutSeconds
            keepHistory = settings.keepHistory
            historyLimit = settings.historyLimit
            diagnosticsEnabled = settings.diagnosticsEnabled
            hotkey = settings.hotkey
            duckingEnabled = settings.duckingEnabled
            duckLevel = settings.duckLevel
            builtInMicWithBluetoothOptIn = settings.preferBuiltInMicWithBluetooth
            alwaysOn = settings.alwaysOn
            launchAtLogin = settings.launchAtLogin
            hasCompletedOnboarding = settings.hasCompletedOnboarding
            autoDownloadModels = settings.autoDownloadModels
            appLanguage = settings.appLanguage
            pillStyle = settings.pillStyle.rawValue
            statsPeriod = settings.statsPeriod
        }

        func apply(to settings: AppSettings) {
            if let v = defaultLanguage { settings.defaultLanguage = v }
            settings.pinnedLanguage = pinnedLanguage
            if let v = enabledLanguages {
                settings.enabledLanguages = LanguageSubset(v.compactMap(Language.init(rawValue:)))
                    .ordered
            } else if let v = optionalLanguages {
                settings.enabledLanguages = LanguageSubset(
                    Language.core.union(v.compactMap(Language.init(rawValue:)).filter(\.isOptional)))
                    .ordered
            }
            if let v = turkishDictations { settings.turkishDictations = max(0, v) }
            if let v = arabicDictations { settings.arabicDictations = max(0, v) }
            if let v = uzbekDictations { settings.uzbekDictations = max(0, v) }
            if let v = englishDictations { settings.englishDictations = max(0, v) }
            if let v = russianDictations { settings.russianDictations = max(0, v) }
            if let v = languageCountsSeeded { settings.languageCountsSeeded = v }
            if let v = uzbekModelPath { settings.uzbekModelPath = v }
            if let v = russianModelPath { settings.russianModelPath = v }
            if let v = whisperUseGPU { settings.whisperUseGPU = v }
            if let v = whisperBeamSize { settings.whisperBeamSize = v }
            if let v = preloadAllLanguages { settings.preloadAllLanguages = v }
            if let v = modelIdleUnloadMinutes { settings.modelIdleUnloadMinutes = v }
            if autoDetectLanguage == false, settings.pinnedLanguage == nil {
                settings.pinnedLanguage = settings.defaultLanguage
            }
            // A pin or a default on a language that is off would route to it; neither may.
            let on = settings.languageSubset
            if let pin = settings.pinnedLanguage, !on.contains(pin) { settings.pinnedLanguage = nil }
            settings.defaultLanguage = on.fallback(preferring: settings.defaultLanguage)
            if let v = detectorModelPath { settings.detectorModelPath = v }
            if let v = languageIDModelPath { settings.languageIDModelPath = v }
            if let v = turkicThreshold { settings.turkicThreshold = v }
            if let v = silenceThreshold { settings.silenceThreshold = v }
            if let v = soundFeedback { settings.soundFeedback = v }
            if let v = vocabulary { settings.vocabulary = v }
            if let v = replacements { settings.replacements = v }
            if let v = autoCapitalise { settings.autoCapitalise = v }
            if let v = defaultModeKey { settings.defaultModeKey = v }
            if let v = modeFollowsApp { settings.modeFollowsApp = v }
            if let v = polishEnabled { settings.polishEnabled = v }
            if let v = preferOnDeviceModel { settings.preferOnDeviceModel = v }
            if let v = polishUzbek { settings.polishUzbek = v }
            if let v = cloudPolish { settings.cloudPolish = v }
            if let v = polishBaseURL { settings.polishBaseURL = v }
            if let v = polishModel {
                settings.polishModel = migratedPolishModel(v, baseURL: settings.polishBaseURL)
            }
            if let v = polishFallbackModel {
                settings.polishFallbackModel = migratedPolishModel(v, baseURL: settings.polishBaseURL)
            }
            if let v = polishKeyAccount { settings.polishKeyAccount = v }
            if let v = polishTimeoutSeconds { settings.polishTimeoutSeconds = v }
            if let v = keepHistory { settings.keepHistory = v }
            if let v = historyLimit { settings.historyLimit = v }
            if let v = diagnosticsEnabled { settings.diagnosticsEnabled = v }
            if let v = hotkey { settings.hotkey = v }
            if let v = duckingEnabled { settings.duckingEnabled = v }
            if let v = duckLevel { settings.duckLevel = min(1, max(0, v)) }
            // `preferBuiltInMicWithBluetooth` (the old key) is deliberately not applied.
            if let v = builtInMicWithBluetoothOptIn { settings.preferBuiltInMicWithBluetooth = v }
            if let v = alwaysOn { settings.alwaysOn = v }
            if let v = launchAtLogin { settings.launchAtLogin = v }
            // Any stored blob predates or completed onboarding; see `hasCompletedOnboarding`.
            settings.hasCompletedOnboarding = hasCompletedOnboarding ?? true
            if let v = autoDownloadModels { settings.autoDownloadModels = v }
            if let v = appLanguage { settings.appLanguage = v }
            if let v = pillStyle, let style = PillAnimationStyle(rawValue: v) { settings.pillStyle = style }
            if let v = statsPeriod { settings.statsPeriod = v }
        }
    }

    /// A binding that persists on write.
    ///
    /// Every control in the settings window used to mutate `@Bindable settings` directly, and
    /// the only `save()` on that path hung off `TabView.onDisappear` — so thirteen of the
    /// twenty-one settings were lost if the user changed one and quit without closing the
    /// window first. Persistence must not depend on a view's lifecycle.
    public func bound<T>(_ keyPath: ReferenceWritableKeyPath<AppSettings, T>) -> Binding<T> {
        Binding(
            get: { self[keyPath: keyPath] },
            set: { newValue in
                self[keyPath: keyPath] = newValue
                self.save()
            })
    }

    // MARK: - Derived

    /// The vocabulary as the pipeline wants it.
    public var vocabularyValue: Vocabulary {
        var byLanguage: [Language: [String]] = [:]
        for (code, terms) in vocabulary {
            if let language = Language(rawValue: code) { byLanguage[language] = terms }
        }
        return Vocabulary(byLanguage)
    }

    public var replacementSet: ReplacementSet { ReplacementSet(replacements) }

    /// Whether Uzbek can actually be transcribed right now. The settings pane and the HUD both
    /// need to say "no model" rather than letting the first Uzbek dictation fail.
    public var uzbekReady: Bool { resolvedUzbekPath != nil }

    /// Whether Russian can be transcribed. Apple's engine cannot, so this is the only route.
    public var russianReady: Bool { resolvedRussianPath != nil }

    // MARK: Finding the models without being told where they are
    //
    // Every one of these resolvers takes the same three steps, and the reason they exist is
    // distribution. Until they did, `uzbekModelPath` defaulted to the empty string and the app
    // reported "no model" until someone opened Settings and pasted a file path — which is fine for
    // the machine that built it and impossible for anyone who is handed a .dmg. The detector
    // already worked this way and the other two did not, which is why English worked out of the
    // box and the language this app exists for did not.
    //
    //   1. the explicit setting, if it points at a file that is there
    //   2. a known filename in `~/Library/Application Support/Kotiba/models`
    //   3. the same filename inside the app bundle's own Resources
    //
    // Step 3 is what makes a single drag to /Applications enough: the shipped bundle carries its
    // weights, so there is nothing to download and nothing to configure. Step 2 still comes first
    // so a newer model dropped into the support directory wins over the bundled one without
    // needing a new build.

    /// Candidate filenames per language, best first. A name that is not present is simply skipped.
    static let knownUzbekModels = ["ggml-uzbek-stt-v1-q5_0.bin", "ggml-navoi-medium-q5_0.bin"]
    static let knownRussianModels = ["ggml-large-v3-turbo-q5_0.bin"]
    static let knownDetectorModels = ["ggml-base-q5_1.bin"]
    static let knownLanguageIDModels = ["ecapa-voxlingua107-lid-f16.mlmodel"]

    /// Where a model with one of `names` actually is, or nil if none of them are anywhere.
    func locate(_ explicit: String, _ names: [String]) -> String? {
        if Self.modelExists(explicit) { return explicit }
        for name in names {
            let candidate = modelDirectory.appendingPathComponent(name).path
            if Self.modelExists(candidate) { return candidate }
        }
        guard let modelBundle else { return nil }
        for name in names {
            if let bundled = modelBundle.path(forResource: name, ofType: nil,
                                              inDirectory: "models"),
               Self.modelExists(bundled) {
                return bundled
            }
        }
        return nil
    }

    public var resolvedUzbekPath: String? { locate(uzbekModelPath, Self.knownUzbekModels) }
    public var resolvedRussianPath: String? { locate(russianModelPath, Self.knownRussianModels) }
    public var resolvedDetectorPath: String? {
        locate(detectorModelPath, Self.knownDetectorModels)
    }

    /// The language-ID model, when it is anywhere — by size, not by the ggml magic
    /// `modelExists` asks for (it is a Core ML file).
    public var resolvedLanguageIDPath: String? {
        let fm = FileManager.default
        func usable(_ path: String) -> Bool {
            // Through a symlink to the file itself: a models directory of links (the probe's,
            // a developer's) is a directory of 60-byte files otherwise.
            let resolved = (path as NSString).resolvingSymlinksInPath
            guard !path.isEmpty, let size = (try? fm.attributesOfItem(atPath: resolved))?[.size]
                    as? Int else { return false }
            return size >= 40_000_000
        }
        if usable(languageIDModelPath) { return languageIDModelPath }
        for name in Self.knownLanguageIDModels {
            let candidate = modelDirectory.appendingPathComponent(name).path
            if usable(candidate) { return candidate }
            if let bundled = modelBundle?.path(forResource: name, ofType: nil, inDirectory: "models"),
               usable(bundled) { return bundled }
        }
        return nil
    }

    /// Detection needs a detector model, more than one engine family to choose between, and —
    /// while Uzbek is on — somewhere for Uzbek to go once it is detected.
    public var autoDetectReady: Bool {
        (resolvedLanguageIDPath != nil || resolvedDetectorPath != nil)
            && languageSubset.families.count > 1
            && (uzbekReady || !languageSubset.contains(.uzbek))
    }

    /// Whether a configured path points at something Kotiba can actually load.
    ///
    /// This used to be `FileManager.fileExists`, and every readiness question in the app was
    /// built on it. A half-finished 200 MB download of a 539 MB model — or the wrong `.bin`
    /// entirely — passed: `uzbekReady` went true, the "No Uzbek model" blocker disappeared, and
    /// the settings row showed a tick for a file nothing had ever looked inside. The only
    /// feedback was whisper.cpp's own guess, 7.8 s into a load attempt, once per launch, forever.
    ///
    /// `ModelFile.inspect` reads four bytes and a size. Kotiba has always had a module that owns
    /// model integrity; this is the app finally asking it.
    static func modelExists(_ path: String) -> Bool {
        ModelFile.inspect(path).isUsable
    }

    /// Why a configured model is not usable, when it is not. Nil when it is fine or unset.
    static func modelProblem(_ path: String) -> String? {
        guard !path.isEmpty else { return nil }
        return ModelFile.inspect(path).reason
    }

    /// Which languages the app can actually serve right now, for the menu and the HUD. An
    /// optional language only once it is on and has an engine: Turkish is whisper turbo (the
    /// Russian fallback's file), Arabic is Cohere or — until it is downloaded — turbo (D-11).
    public var availableLanguages: Set<Language> {
        languageSubset.languages.filter(ready)
    }

    /// The dictation languages that are on (`enabledLanguages`), as the router reads them.
    public var languageSubset: LanguageSubset { LanguageSubset(enabledLanguages) }

    /// The optional languages that are on (Turkish, Arabic).
    public var enabledOptionalLanguages: Set<Language> { languageSubset.optional }

    /// Whether an optional language has what it needs to dictate: turbo for Turkish; Cohere or
    /// turbo for Arabic.
    public func ready(_ language: Language) -> Bool {
        switch language {
        case .turkish: return russianReady
        case .arabic: return resolvedArabicPath != nil || russianReady
        case .english: return true
        case .russian: return russianReady
        case .uzbek: return uzbekReady
        }
    }

    /// Cohere Transcribe Arabic, found by its file name: the models directory, then the bundle.
    /// Not a setting — it is only ever the one file (`ModelCatalogue.arabicEngine`), and GGUF is
    /// not what `modelExists` inspects for, so presence is the test; the store writes the file
    /// under its final name only after its sha256 matched.
    public var resolvedArabicPath: String? {
        let name = ModelCatalogue.arabicEngine.destination
        let local = modelDirectory.appendingPathComponent(name).path
        if FileManager.default.fileExists(atPath: local) { return local }
        if let bundled = modelBundle?.path(forResource: name, ofType: nil, inDirectory: "models"),
           FileManager.default.fileExists(atPath: bundled) { return bundled }
        return nil
    }

    /// Where per-user state lives. On macOS this is `~/Library/Application Support`, not a
    /// sandbox container, because the app is deliberately unsandboxed — Accessibility and Input
    /// Monitoring do not survive the sandbox. On iOS the same API returns the container, which
    /// is correct there.
    ///
    /// `URL.applicationSupportDirectory` rather than `FileManager.urls(for:in:)` with a
    /// hand-built fallback: the fallback used `homeDirectoryForCurrentUser`, which does not
    /// exist on iOS and broke that target. A non-optional API removes the need for one.
    public static var supportDirectory: URL {
        URL.applicationSupportDirectory.appendingPathComponent("Kotiba", isDirectory: true)
    }
}
