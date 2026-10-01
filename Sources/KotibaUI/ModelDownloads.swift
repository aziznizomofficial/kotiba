import Foundation
import KotibaCore
import KotibaModels
import Observation

// The models Kotiba fetches for itself, and the same list in Settings › Languages.
//
// Kotiba works before any of these land — Uzbek from the models inside the app, English on
// Apple's engine, the modes on their deterministic rules alone — but it is not the product until
// the CORE has: English and Russian on Parakeet, Uzbek on Kotib STT, the pause detector the
// streaming engines cut at, the language detector that routes, and the model the modes rewrite
// with (`Item.core`). The owner's rule (2026-10-02): the core is not a choice. There is no
// checklist; once setup is finished (or skipped) whatever of it is not inside the app downloads
// by itself, shown as one "Getting Kotiba ready" card (`CoreReadyCard`), and resumes at every
// launch until it is all here. Turkish and Arabic are the opposite: nothing of theirs ships or
// downloads until the language is switched on, and then everything it needs comes at once
// (`Item.items(for:)`), its size shown under the switch before it starts.
//
// Every file goes through `ModelStore`: sha256-verified, and every transfer resumable (a quit, a
// sleep or a dropped connection continues where it stopped — the partial file survives the
// process). A `make-dmg.sh --with-models` build carries the whole core inside the bundle, and
// then nothing is fetched at all.

@Observable
@MainActor
public final class ModelDownloads {

    public enum Item: String, CaseIterable, Identifiable, Sendable {
        case parakeet, uzbek, speechDetector, languageDetector, modes
        /// The optional languages' engines (D-11). Turkish is whisper turbo — no longer inside
        /// either installer — and Arabic is Cohere with turbo. Fetched when the language is
        /// switched on, never before, and listed in Settings only while it is on.
        case turkish, arabic
        /// Arabic's own modes model (C4 §14.5), fetched with Arabic, used only for Arabic
        /// dictations; until it lands Arabic's modes run on `modes`.
        case arabicModes
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .parakeet: return L("models.item.parakeet")
            case .uzbek: return L("speech.uzbek")
            case .speechDetector: return L("models.item.speechDetector")
            case .languageDetector: return L("models.item.languageDetector")
            case .modes: return L("section.modes")
            case .turkish: return L("speech.turkish")
            case .arabic: return L("speech.arabic")
            case .arabicModes: return L("models.item.arabicModes")
            }
        }

        /// Whether this row is wanted while `on` are the languages dictated in: the helpers
        /// always, a language's model while any language it serves is on.
        public func isWanted(by on: LanguageSubset) -> Bool {
            languages.isEmpty || languages.contains(where: on.contains)
        }

        /// The core: what every user gets, with no question asked — the three core languages'
        /// engines, both detectors and the modes model. Turkish and Arabic are never part of it.
        public static let core: [Item] = [.parakeet, .uzbek, .speechDetector, .languageDetector, .modes]

        /// The core rows still worth having while `on` are the languages dictated in: Parakeet
        /// only while English or Russian is on, the Uzbek model only while Uzbek is — a light
        /// app does not fetch 632 MB for languages its user switched off. The helpers always.
        public static func core(for on: LanguageSubset) -> Set<Item> {
            Set(core.filter { $0.isWanted(by: on) })
        }

        /// Everything `language` needs, fetched together when it is switched on: Turkish is
        /// whisper turbo; Arabic is Cohere with turbo (its language head and loop fallback) and
        /// Gemma 4 E2B, its own modes model — the whole experience, not a half of it.
        public static func items(for language: Language) -> [Item] {
            allCases.filter { $0.languages.contains(language) }
        }

        /// What should be on disk while `on` are the languages: the core for them, and every
        /// item of each optional language that is on. What a launch resumes.
        public static func wanted(for on: LanguageSubset) -> Set<Item> {
            core(for: on).union(on.optional.flatMap(items(for:)))
        }

        /// The dictation languages this model is for; none for the helpers (detectors, modes).
        /// A new language's model lists it here and the models card places the row by
        /// `LanguageOrder` with no other change.
        public var languages: [Language] {
            switch self {
            case .parakeet: return [.english, .russian]
            case .uzbek: return [.uzbek]
            case .speechDetector, .languageDetector, .modes: return []
            case .turkish: return [.turkish]
            case .arabic, .arabicModes: return [.arabic]
            }
        }

        /// Every item in the order the onboarding step and Settings › Languages list them: the
        /// language models in the default language order (Uzbek, English/Russian, …), then the
        /// helpers as declared.
        public static var displayOrder: [Item] {
            let all = Array(allCases)
            func rank(_ item: Item) -> Int? {
                item.languages.map { LanguageOrder.defaultRank($0) }.min()
            }
            let models = all.filter { rank($0) != nil }.sorted { rank($0)! < rank($1)! }
            return models + all.filter { rank($0) == nil }
        }

        public var model: String {
            switch self {
            case .parakeet: return "Parakeet Ultra (Neural Engine)"
            case .uzbek: return "Kotib STT · uzbek_stt_v1"
            case .speechDetector: return "Silero VAD v6.2"
            case .languageDetector: return "whisper base"
            case .modes: return "Qwen3 1.7B"
            case .turkish: return "whisper large-v3-turbo"
            case .arabic: return "Cohere Transcribe Arabic + whisper turbo"
            case .arabicModes: return "Gemma 4 E2B"
            }
        }

        public var bytes: Int64 {
            switch self {
            case .parakeet: return Int64(ModelCatalogue.parakeetUltra.totalBytes)
            case .uzbek: return Int64(ModelCatalogue.uzbekEngine.expectedBytes ?? 0)
            case .speechDetector: return Int64(ModelCatalogue.speechDetector.expectedBytes ?? 0)
            case .languageDetector: return Int64(ModelCatalogue.detector.expectedBytes ?? 0)
            case .modes: return Int64(ModelCatalogue.polishModel.expectedBytes ?? 0)
            case .turkish: return Int64(ModelCatalogue.russianEngine.expectedBytes ?? 0)
            // Cohere, and turbo with it (C4 §14.1): turbo's language head is what finds the
            // Arabic whisper base half-hears, and turbo decodes a span Cohere loops on. Most Macs
            // have no turbo (Parakeet does Russian), so it comes with Arabic, as on Windows.
            case .arabic: return Int64(ModelCatalogue.arabicEngine.expectedBytes ?? 0)
                + Int64(ModelCatalogue.russianEngine.expectedBytes ?? 0)
            case .arabicModes: return Int64(ModelCatalogue.arabicModesModel.expectedBytes ?? 0)
            }
        }

        /// What the app does without it, for the row's subtitle.
        public var without: String {
            switch self {
            case .parakeet: return L("models.without.parakeet")
            case .uzbek: return L("models.without.uzbek")
            case .speechDetector: return L("models.without.speechDetector")
            case .languageDetector: return L("models.without.languageDetector")
            case .modes: return L("models.without.modes")
            case .turkish: return L("models.without.turkish")
            case .arabic: return L("models.without.arabic")
            case .arabicModes: return L("models.without.arabicModes")
            }
        }
    }

    public enum State: Equatable, Sendable {
        case missing
        case queued
        /// Bytes on disk so far, of `Item.bytes`.
        case downloading(Int64)
        case installed
        case failed(String)
        /// Cannot be fetched from here, and why.
        case unavailable(String)

        public var isInstalled: Bool { self == .installed }
    }

    /// `internal(set)` so a test can put a row in a state no hermetic run can reach (a failure
    /// needs a network); everything in the app goes through `download` and `refresh`.
    public internal(set) var states: [Item: State] = [:]
    public internal(set) var running = false
    /// Whether `refresh` has run once — before it every row reads `.missing`, which is not news.
    public private(set) var checked = false
    /// What the models directory holds on disk, all of it — for the Languages pane.
    public private(set) var diskBytes: Int64 = 0
    private var task: Task<Void, Never>?
    private unowned let controller: DictationController

    init(controller: DictationController) {
        self.controller = controller
    }

    public func state(_ item: Item) -> State { states[item] ?? .missing }

    /// The bytes a progress bar over `items` runs to: the same rows `fraction(of:)` counts —
    /// what is missing, plus what this run has already fetched — so "Getting Kotiba ready —
    /// 1.9 GB" names the bar's own total and does not shrink as rows land.
    public func total(of items: Set<Item>) -> Int64 {
        counted(items).reduce(0) { $0 + $1.bytes }
    }

    /// Whether everything in `items` is on disk (a row that cannot be fetched from here counts
    /// as done: nothing more will happen to it).
    public func allInstalled(_ items: Set<Item>) -> Bool {
        items.allSatisfy { state($0).isInstalled || isUnavailable($0) }
    }

    /// The first failure among `items`, for the card that has one bar for all of them.
    public func failure(in items: Set<Item>) -> String? {
        for item in Item.allCases where items.contains(item) {
            if case .failed(let why) = state(item) { return why }
        }
        return nil
    }

    private func counted(_ items: Set<Item>) -> Set<Item> {
        items.filter { !isUnavailable($0) && (state($0) != .installed || runItems.contains($0)) }
    }

    /// What switching `language` on would fetch: everything it needs that is not on disk. Arabic's
    /// row counts turbo, which Turkish may have brought already.
    public func pendingBytes(for language: Language) -> Int64 {
        var bytes = pendingBytes(Set(Item.items(for: language)))
        if language == .arabic, !state(.arabic).isInstalled, state(.turkish).isInstalled {
            bytes -= Int64(ModelCatalogue.russianEngine.expectedBytes ?? 0)
        }
        return max(0, bytes)
    }

    /// Everything not yet on disk, in bytes — for the button's label.
    public func pendingBytes(_ items: Set<Item>) -> Int64 {
        items.filter { !state($0).isInstalled && !isUnavailable($0) }.reduce(0) { $0 + $1.bytes }
    }

    /// Overall progress of a download run, 0…1, over the items that were not already installed.
    ///
    /// A row that cannot be fetched from here (the Uzbek model while it is private) is never part
    /// of the total: the core card passes every core item, Uzbek included, and counting its
    /// 539 MB as "not done yet" held the bar at ~78% for the whole run.
    public func fraction(of items: Set<Item>) -> Double {
        let wanted = counted(items)
        let total = wanted.reduce(Int64(0)) { $0 + $1.bytes }
        guard total > 0 else { return 1 }
        let done = wanted.reduce(Int64(0)) { sum, item in
            switch state(item) {
            case .installed: return sum + item.bytes
            case .downloading(let bytes): return sum + bytes
            default: return sum
            }
        }
        return min(1, Double(done) / Double(total))
    }
    /// What the current (or last) run was asked for. Reset when a new run starts, so a second
    /// run's bar does not start at the first run's finished bytes.
    var runItems: Set<Item> = []

    /// The progress of whatever is downloading now — for a card that has no selection of its
    /// own (Settings › Languages passes none, and `fraction(of: [])` is a full bar).
    public var runFraction: Double { fraction(of: runItems) }

    /// Re-read what is on disk. Cheap: stats and a stamp, no hashing.
    ///
    /// A failure is kept until the file turns up or the user retries. This used to overwrite it
    /// with what the disk says — `.missing` — and it ran at the end of every download run and
    /// every 2 s while a card was on screen, so a failed fetch (a checksum mismatch, no network)
    /// showed its reason for no frames at all: the row just went back to "Download".
    public func refresh() async {
        for item in Item.allCases {
            if case .downloading = state(item), running { continue }
            if state(item) == .queued, running { continue }
            let onDisk = await controller.installedState(of: item)
            if case .failed = state(item), onDisk == .missing { continue }
            states[item] = onDisk
        }
        diskBytes = await controller.modelsOnDisk()
        checked = true
    }

    /// Fetch `items`, one after another, in the background. Safe to call again while running:
    /// the new ones join the queue.
    public func download(_ items: Set<Item>) {
        let wanted = Item.allCases.filter {
            items.contains($0) && !state($0).isInstalled && !isUnavailable($0)
        }
        for item in wanted { states[item] = .queued }
        if running { runItems.formUnion(wanted) } else { runItems = Set(wanted) }
        guard !running else { return }
        running = true
        task = Task { [weak self] in
            guard let self else { return }
            while let next = Item.allCases.first(where: { self.state($0) == .queued }) {
                await self.fetch(next)
                if Task.isCancelled { break }
            }
            self.running = false
            await self.refresh()
        }
    }

    /// Stop after the current chunk. What was fetched is kept, and resumes next time.
    public func cancel() {
        task?.cancel()
        for item in Item.allCases where state(item) == .queued { states[item] = .missing }
    }

    private func isUnavailable(_ item: Item) -> Bool {
        if case .unavailable = state(item) { return true }
        return false
    }

    private func fetch(_ item: Item) async {
        states[item] = .downloading(0)
        let report: DownloadProgress = { [weak self] bytes in
            Task { @MainActor in
                guard let self, case .downloading = self.state(item) else { return }
                self.states[item] = .downloading(bytes)
            }
        }
        do {
            try await controller.install(item, progress: report)
            states[item] = .installed
        } catch is CancellationError {
            states[item] = .missing
        } catch {
            states[item] = .failed((error as? ModelStoreError)?.reason ?? "\(error)")
        }
    }
}

/// A model file on disk, by the dictation languages it serves — for "remove the model files" on a
/// language that is off (Settings › Languages). Several languages share files: Parakeet is English
/// and Russian; whisper turbo is Turkish's engine and Arabic's head and fallback (it is no longer
/// Russian's: Parakeet is core, and turbo stopped shipping in either installer on 2026-10-02, so
/// a Russian user never holds it on Russian's account). A file is offered for removal only when
/// no language that is on still uses it.
public enum LanguageModelFile: String, CaseIterable, Sendable {
    case parakeet, uzbek, turbo, cohere, arabicModes

    public var languages: Set<Language> {
        switch self {
        case .parakeet: return [.english, .russian]
        case .uzbek: return [.uzbek]
        case .turbo: return [.turkish, .arabic]
        case .cohere, .arabicModes: return [.arabic]
        }
    }

    /// The files `language` is off and alone in using, while `on` are the languages that are on.
    /// Empty while `language` itself is on.
    public static func removable(for language: Language, on: LanguageSubset) -> [LanguageModelFile] {
        guard !on.contains(language) else { return [] }
        return allCases.filter {
            $0.languages.contains(language) && $0.languages.isDisjoint(with: on.languages)
        }
    }
}
