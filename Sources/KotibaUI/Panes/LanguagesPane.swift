import KotibaCore
import KotibaModels
import SwiftUI

#if os(macOS)
import AppKit
#endif

// Languages: which languages the user dictates in (each one on/off), pin one or let Kotiba decide
// among them, the engines and their models, the whisper knobs, and the words Kotiba gets wrong. Ported from the old Languages tab (auto-detect and the detector
// download, the fallback language, every model slot with choose / download / remove, GPU, beam,
// preload, idle release) and the old Text tab (vocabulary, replacements, capitalisation).

struct LanguagesPane: View {
    let controller: DictationController
    @Bindable private var settings: AppSettings
    /// Why the last download did not work. Cleared by the next attempt.
    @State private var downloadError: String?
    /// Parakeet's state, read from the controller while the pane is on screen. It changes on its
    /// own — a first-launch download lands, a load finishes — so it is polled, not bound.
    @State private var unified: (ready: Bool, detail: String) = (false, "")

    init(controller: DictationController) {
        self.controller = controller
        self.settings = controller.settings
    }

    var body: some View {
        Pane(title: L("section.languages"), subtitle: L("languages.subtitle")) {
            LanguageToggles(controller: controller)
            choiceCard

            AdaptiveGrid(minimumColumnWidth: 250) {
                ForEach(controller.languageOrder.order, id: \.self) { language in
                    engineCard(language)
                }
            }
            .animation(Theme.Motion.smooth, value: controller.languageOrder.order)

            if let downloadError {
                Footnote(downloadError, tint: Theme.Palette.danger)
            }

            VStack(alignment: .leading, spacing: Theme.Space.s) {
                HStack(alignment: .firstTextBaseline) {
                    Text(L("languages.models.title"))
                        .font(Theme.Typeface.headline)
                        .foregroundStyle(Theme.Palette.text)
                    Spacer()
                    Text(L("languages.models.onDisk", ModelsCard.size(controller.models.diskBytes)))
                        .font(Theme.Typeface.caption)
                        .foregroundStyle(Theme.Palette.tertiary)
                }
                ModelsCard(downloads: controller.models, languages: settings.languageSubset)
            }

            WhisperCard(controller: controller)
            WordsCard(settings: settings)
        }
        .onDisappear { controller.languageOrder.release() }
        .task { await controller.languageOrder.refreshThenHold() }
        .task {
            while !Task.isCancelled {
                unified = await controller.unifiedEngineStatus()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// One language's engine card. A `switch`, so a language added to `Language` compiles here
    /// only once it has a card — and the list around it follows the picker order.
    @ViewBuilder
    private func engineCard(_ language: Language) -> some View {
        if !settings.languageSubset.contains(language) {
            offCard(language)
        } else {
            onCard(language)
        }
    }

    /// A language that is off: "Off", and — when only it uses them — its model files, removable
    /// here to free the disk (asked in the card, not in an alert).
    private func offCard(_ language: Language) -> some View {
        EngineCard(language: language, engine: engineName(language), fileName: nil, bytes: nil,
                   state: .off, note: L("languages.off.note")) {
            RemoveModelFiles(controller: controller, language: language)
        }
    }

    private func engineName(_ language: Language) -> String {
        switch language {
        case .english: return "Parakeet Ultra"
        case .russian: return "Parakeet Ultra"
        case .uzbek: return "Kotib STT (uzbek_stt_v1)"
        case .turkish: return "whisper large-v3-turbo"
        case .arabic: return "Cohere Transcribe Arabic · transcribe.cpp"
        }
    }

    @ViewBuilder
    private func onCard(_ language: Language) -> some View {
        switch language {
        case .english:
            // English and Russian are one model: Parakeet Ultra (docs/research/C1). Apple's
            // engine is what answers English before it is ready.
            EngineCard(language: .english, engine: "Parakeet Ultra",
                       fileName: nil, bytes: nil, state: unified.ready ? .ready : .missing,
                       note: englishNote)
        case .russian:
            // Parakeet too, from the core download. whisper turbo is no longer Russian's model
            // to offer here: it ships in neither installer and comes only with Turkish or Arabic
            // (2026-10-02); when one of them brought it, it still answers Russian meanwhile.
            EngineCard(language: .russian, engine: "Parakeet Ultra",
                       fileName: nil, bytes: nil, state: unified.ready ? .ready : .missing,
                       note: unified.ready ? unified.detail : L("languages.russian.note"))
        case .uzbek:
            EngineCard(language: .uzbek, engine: "Kotib STT (uzbek_stt_v1)",
                       fileName: fileName(settings.resolvedUzbekPath ?? settings.uzbekModelPath),
                       bytes: Self.size(settings.resolvedUzbekPath),
                       state: state(resolved: settings.resolvedUzbekPath,
                                    explicit: settings.uzbekModelPath),
                       note: L("languages.uzbek.note")) {
                modelButtons(ready: settings.uzbekReady, downloadable: ModelCatalogue.uzbekEngine)
            }
        case .turkish, .arabic:
            optionalCard(language)
        }
    }

    /// Turkish or Arabic, while it is on (D-11), with the download state of everything it needs
    /// as one: Turkish is whisper turbo; Arabic is Cohere, turbo and Gemma 4 E2B, fetched together
    /// the moment the language is switched on (`ModelDownloads.Item.items(for:)`).
    @ViewBuilder
    private func optionalCard(_ language: Language) -> some View {
        let items = Set(ModelDownloads.Item.items(for: language))
        let models = controller.models!
        let failure = models.failure(in: items)
        let downloading = items.contains {
            if case .downloading = models.state($0) { return true }
            return false
        }
        let queued = items.contains { models.state($0) == .queued }
        let ready = settings.ready(language)
        EngineCard(
            language: language,
            engine: engineName(language),
            fileName: language == .arabic
                ? settings.resolvedArabicPath.map { URL(fileURLWithPath: $0).lastPathComponent }
                : settings.resolvedRussianPath.map { URL(fileURLWithPath: $0).lastPathComponent },
            bytes: language == .arabic ? Self.size(settings.resolvedArabicPath)
                                       : Self.size(settings.resolvedRussianPath),
            state: ready ? .ready : failure.map { .problem($0) } ?? .missing,
            note: optionalNote(language)) {
            HStack(spacing: Theme.Space.s) {
                Spacer(minLength: 0)
                if downloading {
                    // One figure for all of the language's files.
                    Text("\(Int(models.fraction(of: items) * 100))%")
                        .font(Theme.Typeface.caption.monospacedDigit())
                        .foregroundStyle(Theme.Palette.secondary)
                } else if queued {
                    StatusDot(text: L("models.waiting"), tone: .neutral)
                } else if !models.allInstalled(items) {
                    // Normally never seen — switching the language on starts this — but a failed
                    // or paused fetch needs a way back.
                    Button(L("languages.model.download",
                             ModelsCard.size(models.pendingBytes(for: language)))) {
                        models.download(Set(items.filter { !models.state($0).isInstalled }))
                    }
                    .buttonStyle(KotibaButtonStyle(kind: .primary, compact: true))
                }
            }
        }
    }

    private func optionalNote(_ language: Language) -> String {
        let base = language == .arabic ? L("languages.arabic.note") : L("languages.turkish.note")
        if language == .arabic, settings.resolvedArabicPath == nil, settings.russianReady {
            return base + " " + L("languages.arabic.meanwhile")
        }
        return base
    }

    /// The engine's own status only knows about the download *it* started on first use. The
    /// models step and the card below fetch Parakeet through `ModelDownloads`, and while they did
    /// this card said "Loads with the next dictation" beside a row at 41% — so the row's state
    /// wins while it is fetching.
    private var englishNote: String {
        guard !unified.ready else { return unified.detail }
        if unified.detail.isEmpty { return L("languages.checking") }
        switch controller.models.state(.parakeet) {
        case .downloading, .queued:
            return L("engine.parakeet.downloading")
        case .failed(let why):
            return L("languages.english.downloadFailed", why)
        default:
            return unified.detail
        }
    }

    // MARK: Pin or detect

    private var choiceCard: some View {
        Card(title: L("languages.which"), systemImage: "globe") {
            SettingRow(title: L("home.pickers.language"),
                       detail: controller.pinnedLanguage == nil
                           ? L("languages.automatic.detail")
                           : L("languages.pinned.detail", Names.language(controller.pinnedLanguage!))) {
                AdaptivePicker(selection: LanguageBinding.make(controller),
                               options: LanguageBinding.options(controller),
                               disabled: LanguageBinding.disabled(controller))
            }
            // Automatic among more than one engine family needs the detector (and, while Uzbek is
            // on, the Uzbek model): say what is missing, and fetch the half Kotiba can.
            if controller.pinnedLanguage == nil, settings.languageSubset.families.count > 1,
               !settings.autoDetectReady {
                HStack(spacing: Theme.Space.s) {
                    // Names only what is actually missing: with the detector installed it used
                    // to ask for it anyway, beside no button to get it.
                    StatusDot(text: settings.resolvedDetectorPath == nil
                                      && settings.resolvedLanguageIDPath == nil
                                  ? (settings.uzbekReady ? L("languages.needs.detector")
                                     : L("languages.needs.both"))
                                  : L("languages.needs.uzbek"),
                              tone: .warning)
                    Spacer()
                    // The detector is the half Kotiba *can* fetch — the language-ID model (P4),
                    // 43 MB, public, and the thing that makes auto-detect work at all.
                    if settings.resolvedDetectorPath == nil, settings.resolvedLanguageIDPath == nil {
                        Button(controller.downloading != nil ? L("common.downloading")
                               : L("languages.detector.download")) {
                            Task { downloadError = await controller.download(ModelCatalogue.languageID) }
                        }
                        .buttonStyle(.kotibaPrimary)
                        .disabled(controller.downloading != nil)
                    }
                }
            }
            Hairline()
            SettingRow(title: L("languages.fallback"), detail: nil) {
                AdaptivePicker(selection: settings.bound(\.defaultLanguage),
                               options: controller.dictationLanguages.map { ($0, Names.language($0)) })
            }
        }
    }

    // MARK: Model slots

    /// The Download button, and only that: a model file is something Kotiba fetches, never
    /// something a user is asked to find on disk (`uzbekModelPath`/`russianModelPath` remain
    /// settings for the CLI and migration, with no control here). Nothing shows while the model
    /// is ready.
    @ViewBuilder
    private func modelButtons(ready: Bool, downloadable: ModelEntry?) -> some View {
        if let downloadable, !ready {
            Button(controller.downloading != nil ? L("common.downloading")
                   : L("languages.model.download",
                       L("unit.mb", Names.count(Int((downloadable.expectedBytes ?? 0) / 1_048_576))))) {
                Task { downloadError = await controller.download(downloadable) }
            }
            .buttonStyle(KotibaButtonStyle(kind: .primary, compact: true))
            .disabled(controller.downloading != nil)
        }
    }

    private func state(resolved: String?, explicit: String) -> EngineState {
        if let resolved, AppSettings.modelExists(resolved) { return .ready }
        if explicit.isEmpty { return .missing }
        // Names what is actually wrong: a half-finished download is far likelier than a
        // missing file, and they want different answers.
        return .problem(AppSettings.modelProblem(explicit) ?? L("languages.model.gone"))
    }

    private func fileName(_ path: String) -> String? {
        path.isEmpty ? nil : URL(fileURLWithPath: path).lastPathComponent
    }

    static func size(_ path: String?) -> Int64? {
        guard let path,
              let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let size = attributes[.size] as? NSNumber else { return nil }
        return size.int64Value
    }
}

// MARK: - One engine

enum EngineState: Equatable {
    case ready, missing
    /// The language is turned off (`AppSettings.enabledLanguages`).
    case off
    case problem(String)
}

struct EngineCard<Actions: View>: View {

    let language: Language
    let engine: String
    let fileName: String?
    let bytes: Int64?
    let state: EngineState
    let note: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            HStack(alignment: .center) {
                Text(Names.languageCode(language))
                    .font(.system(size: 12, weight: .heavy, design: .rounded))
                    .foregroundStyle(Theme.Palette.accentInk)
                    .frame(width: 32, height: 32)
                    .background(state == .ready ? Theme.Palette.accent : Theme.Palette.elevated,
                                in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(Names.language(language))
                        .font(Theme.Typeface.headline)
                        .foregroundStyle(Theme.Palette.text)
                    Text(engine)
                        .font(Theme.Typeface.caption)
                        .foregroundStyle(Theme.Palette.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                switch state {
                case .ready: StatusDot(text: L("status.ready.title"), tone: .good)
                case .missing: StatusDot(text: L("languages.engine.noModel"), tone: .warning)
                case .off: StatusDot(text: L("languages.engine.off"), tone: .neutral)
                case .problem: StatusDot(text: L("languages.engine.problem"), tone: .bad)
                }
            }

            if let fileName {
                HStack(spacing: 6) {
                    Image(systemName: "shippingbox.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.Palette.tertiary)
                    Text(fileName)
                        .font(Theme.Typeface.mono)
                        .foregroundStyle(Theme.Palette.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let bytes {
                        Text(ModelsCard.size(bytes))
                            .font(Theme.Typeface.caption)
                            .foregroundStyle(Theme.Palette.tertiary)
                            .fixedSize()
                    }
                }
            }
            if case .problem(let why) = state {
                Footnote(why, tint: Theme.Palette.danger)
            }
            Footnote(note)
            Spacer(minLength: 0)
            actions
        }
        .padding(Theme.Space.l)
        .frame(maxWidth: .infinity, minHeight: 176, alignment: .topLeading)
        .opacity(state == .off ? 0.72 : 1)
        .background(Theme.Palette.surface,
                    in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 1))
        .animation(Theme.Motion.smooth, value: state)
    }
}

extension EngineCard where Actions == EmptyView {
    init(language: Language, engine: String, fileName: String?, bytes: Int64?, state: EngineState,
         note: String) {
        self.init(language: language, engine: engine, fileName: fileName, bytes: bytes,
                  state: state, note: note) { EmptyView() }
    }
}

// MARK: - Which languages

/// "Your languages": one switch per dictation language. A language that is off is never routed
/// to and costs nothing (`LanguageSubset`); the last one on cannot be turned off.
struct LanguageToggles: View {
    let controller: DictationController
    @Bindable private var settings: AppSettings

    init(controller: DictationController) {
        self.controller = controller
        self.settings = controller.settings
    }

    var body: some View {
        Card(title: L("languages.yours"), systemImage: "checklist") {
            LanguageSwitches(on: settings.languageSubset, order: controller.languageOrder.order,
                             detail: { OptionalLanguageCaption.text(
                                 $0, on: settings.languageSubset, models: controller.models) }) {
                language, on in
                withAnimation(Theme.Motion.smooth) { controller.setLanguage(language, enabled: on) }
            }
            Footnote(L("languages.yours.hint"))
        }
    }
}

/// The five switches, shared by Settings › Languages and onboarding. `set` is asked for every
/// flip; the last one on is disabled, with the reason under it.
struct LanguageSwitches: View {
    let on: LanguageSubset
    let order: [Language]
    /// A caption under a language's name — Turkish's and Arabic's download size before they are
    /// switched on, and their progress after (`OptionalLanguageCaption`).
    var detail: (Language) -> String? = { _ in nil }
    let set: (Language, Bool) -> Void

    var body: some View {
        ForEach(Array(order.enumerated()), id: \.element) { index, language in
            if index > 0 { Hairline() }
            let locked = !on.canTurnOff(language)
            HStack(spacing: Theme.Space.m) {
                Badge(text: Names.languageCode(language))
                VStack(alignment: .leading, spacing: 2) {
                    Text(Names.language(language))
                        .font(Theme.Typeface.body)
                        .foregroundStyle(Theme.Palette.text)
                    if locked {
                        Text(L("languages.lastOne"))
                            .font(Theme.Typeface.caption)
                            .foregroundStyle(Theme.Palette.tertiary)
                    } else if let caption = detail(language) {
                        Text(caption)
                            .font(Theme.Typeface.caption.monospacedDigit())
                            .foregroundStyle(Theme.Palette.tertiary)
                    }
                }
                Spacer(minLength: Theme.Space.s)
                Toggle("", isOn: Binding(get: { on.contains(language) },
                                         set: { set(language, $0) }))
                    .labelsHidden()
                    .toggleStyle(KotibaSwitchStyle())
                    .disabled(locked)
                    .accessibilityLabel(Names.language(language))
            }
            .padding(.vertical, 2)
        }
    }
}

/// What an optional language costs to switch on, said before it is: "Turning it on downloads
/// 2.97 GB" while it is off, "Downloads 574 MB when you continue" in onboarding once on, its
/// progress while it fetches, nothing once everything is here. Core languages have no caption —
/// they are part of the core download, which has its own card.
enum OptionalLanguageCaption {
    @MainActor
    static func text(_ language: Language, on: LanguageSubset, models: ModelDownloads) -> String? {
        guard language.isOptional else { return nil }
        let items = Set(ModelDownloads.Item.items(for: language))
        if models.allInstalled(items) { return nil }
        let fetching = items.contains { item in
            switch models.state(item) {
            case .downloading, .queued: return true
            default: return false
            }
        }
        if fetching {
            return L("languages.optional.downloading",
                     "\(Int(models.fraction(of: items) * 100))%")
        }
        let size = ModelsCard.size(models.pendingBytes(for: language))
        return on.contains(language) ? L("languages.optional.sizeOn", size)
                                     : L("languages.optional.sizeOff", size)
    }
}

/// "Remove model files (1.2 GB)" on a language that is off, confirmed in the card itself. Shows
/// nothing when the language has no files of its own on disk (shared with a language that is on,
/// bundled in the app, or already gone).
private struct RemoveModelFiles: View {
    let controller: DictationController
    let language: Language
    @State private var bytes: Int64 = 0
    @State private var confirming = false
    @State private var working = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            if let failure { Footnote(failure, tint: Theme.Palette.danger) }
            if bytes > 0 {
                if confirming {
                    Text(L("languages.remove.confirm", ModelsCard.size(bytes)))
                        .font(Theme.Typeface.callout)
                        .foregroundStyle(Theme.Palette.text)
                    HStack(spacing: 6) {
                        Button(L("common.remove")) {
                            working = true
                            Task {
                                failure = await controller.removeModelFiles(for: language)
                                working = false
                                confirming = false
                                bytes = await controller.removableModelBytes(for: language)
                            }
                        }
                        .buttonStyle(KotibaButtonStyle(kind: .destructive, compact: true))
                        .disabled(working)
                        Button(L("common.cancel")) { confirming = false }
                            .buttonStyle(KotibaButtonStyle(kind: .ghost, compact: true))
                            .disabled(working)
                    }
                } else {
                    Button(L("languages.remove", ModelsCard.size(bytes))) { confirming = true }
                        .buttonStyle(KotibaButtonStyle(kind: .ghost, compact: true))
                }
            }
        }
        .animation(Theme.Motion.snappy, value: confirming)
        .task(id: controller.settings.enabledLanguages) {
            bytes = await controller.removableModelBytes(for: language)
        }
    }
}

// MARK: - Whisper

private struct WhisperCard: View {
    let controller: DictationController
    @Bindable private var settings: AppSettings

    init(controller: DictationController) {
        self.controller = controller
        self.settings = controller.settings
    }

    var body: some View {
        Card(title: L("languages.whisper.title"), subtitle: L("languages.whisper.subtitle"),
             systemImage: "cpu") {
            ToggleRow(title: L("languages.whisper.gpu"), isOn: settings.bound(\.whisperUseGPU))
            Hairline()
            SettingRow(title: L("languages.whisper.accuracy"),
                       detail: L("languages.whisper.accuracy.detail")) {
                AdaptivePicker(selection: settings.bound(\.whisperBeamSize),
                               options: [(1, L("languages.whisper.fast")),
                                         (5, L("languages.whisper.careful"))])
            }
            Hairline()
            ToggleRow(title: L("languages.whisper.preload"),
                      detail: L("languages.whisper.preload.detail"),
                      isOn: settings.bound(\.preloadAllLanguages))
            Hairline()
            SettingRow(title: L("languages.whisper.release"),
                       detail: L("languages.whisper.release.detail") + " "
                        + (controller.modelsResident ? L("languages.whisper.resident")
                           : L("languages.whisper.notResident"))) {
                MenuPicker(selection: settings.bound(\.modelIdleUnloadMinutes),
                           options: [(1.0, Lp("languages.whisper.minutes", 1)),
                                     (5.0, Lp("languages.whisper.minutes", 5)),
                                     (15.0, Lp("languages.whisper.minutes", 15)),
                                     (60.0, L("languages.whisper.hour")),
                                     (0.0, L("languages.whisper.never"))])
            }
        }
    }
}

// MARK: - Words

private struct WordsCard: View {
    @Bindable var settings: AppSettings
    @State private var newTerm = ""
    @State private var termLanguage: Language = .english
    @State private var findText = ""
    @State private var replaceText = ""

    var body: some View {
        Card(title: L("words.title"), subtitle: L("words.subtitle"),
             systemImage: "character.book.closed.fill") {
            ForEach(Language.allCases, id: \.self) { language in
                let terms = settings.vocabulary[language.rawValue] ?? []
                if !terms.isEmpty {
                    HStack(alignment: .top, spacing: Theme.Space.s) {
                        Badge(text: Names.languageCode(language))
                        FlowTags(terms: terms) { term in remove(term, from: language) }
                    }
                }
            }
            HStack(spacing: Theme.Space.s) {
                MenuPicker(selection: $termLanguage,
                           options: Language.allCases.map { ($0, Names.languageCode($0)) })
                WellField(placeholder: L("words.term.placeholder"), text: $newTerm)
                    .onSubmit(addTerm)
                Button(L("common.add"), action: addTerm)
                    .buttonStyle(.kotibaPrimary)
                    .disabled(newTerm.isEmpty)
            }

            Hairline()
            Text(L("words.replacements"))
                .font(Theme.Typeface.body)
                .foregroundStyle(Theme.Palette.text)
            ForEach(settings.replacements.indices, id: \.self) { index in
                HStack(spacing: Theme.Space.s) {
                    Text(settings.replacements[index].find)
                        .font(Theme.Typeface.mono)
                        .foregroundStyle(Theme.Palette.text)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.Palette.accent)
                    Text(settings.replacements[index].replaceWith)
                        .font(Theme.Typeface.mono)
                        .foregroundStyle(Theme.Palette.text)
                    Spacer()
                    IconButton(systemImage: "minus", help: L("common.remove"),
                               tint: Theme.Palette.danger) {
                        withAnimation(Theme.Motion.smooth) {
                            _ = settings.replacements.remove(at: index)
                        }
                        settings.save()
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Theme.Palette.raised,
                            in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            }
            HStack(spacing: Theme.Space.s) {
                WellField(placeholder: L("words.find"), text: $findText)
                Image(systemName: "arrow.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.Palette.tertiary)
                WellField(placeholder: L("words.replaceWith"), text: $replaceText)
                Button(L("common.add")) {
                    withAnimation(Theme.Motion.smooth) {
                        settings.replacements.append(
                            Replacement(find: findText, replaceWith: replaceText))
                    }
                    findText = ""; replaceText = ""
                    settings.save()
                }
                .buttonStyle(.kotibaPrimary)
                .disabled(findText.isEmpty)
            }
            Footnote(L("words.replacements.footnote"))
            Hairline()
            ToggleRow(title: L("words.capitalise"), isOn: settings.bound(\.autoCapitalise))
        }
    }

    private func addTerm() {
        guard !newTerm.isEmpty else { return }
        var terms = settings.vocabulary[termLanguage.rawValue] ?? []
        guard !terms.contains(newTerm) else { newTerm = ""; return }
        withAnimation(Theme.Motion.smooth) {
            terms.append(newTerm)
            settings.vocabulary[termLanguage.rawValue] = terms
        }
        newTerm = ""
        settings.save()
    }

    private func remove(_ term: String, from language: Language) {
        withAnimation(Theme.Motion.smooth) {
            settings.vocabulary[language.rawValue]?.removeAll { $0 == term }
            if settings.vocabulary[language.rawValue]?.isEmpty == true {
                settings.vocabulary[language.rawValue] = nil
            }
        }
        settings.save()
    }
}

/// Terms as removable tags that wrap onto as many lines as they need.
private struct FlowTags: View {
    let terms: [String]
    let remove: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(terms, id: \.self) { term in
                HStack(spacing: 4) {
                    Text(term)
                        .font(Theme.Typeface.callout)
                        .foregroundStyle(Theme.Palette.text)
                    Button { remove(term) } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(Theme.Palette.tertiary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(Theme.Palette.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.Palette.hairline, lineWidth: 1))
                .transition(.scale.combined(with: .opacity))
            }
        }
    }
}

/// A left-to-right layout that wraps, for tags.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += lineHeight + spacing
                x = 0
                lineHeight = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: min(widest, width), height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews,
                       cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += lineHeight + spacing
                x = bounds.minX
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}
