import KotibaCore
import KotibaPlatform
import SwiftUI

// The app window: a sidebar and seven sections, on pure black. It replaces the old `Settings`
// scene, and every control that scene had lives somewhere in here — see the port map at the top
// of each pane file.
//
// The window is `Window("Kotiba", id: "main")` in the app shell. The platform slice observes that
// window to put the Dock icon up while it is open; nothing here depends on that.

/// Which section is showing. Shared, so the menu bar's "Settings…" can open the window on the
/// right page, and so onboarding can hand over to Home when it finishes.
@Observable
public final class MainWindowNavigation {
    public static let shared = MainWindowNavigation()
    public var section: MainSection = .home
    public init() {}
}

public enum MainSection: String, CaseIterable, Identifiable, Sendable {
    case home, history, statistics, modes, languages, hotkey, settings

    public var id: String { rawValue }

    var title: String {
        switch self {
        case .home: return L("section.home")
        case .history: return L("section.history")
        case .statistics: return L("section.statistics")
        case .modes: return L("section.modes")
        case .languages: return L("section.languages")
        case .hotkey: return L("section.hotkey")
        case .settings: return L("section.settings")
        }
    }

    var icon: String {
        switch self {
        case .home: return "house.fill"
        case .history: return "clock.arrow.trianglehead.counterclockwise.rotate.90"
        case .statistics: return "chart.bar.xaxis"
        case .modes: return "wand.and.sparkles"
        case .languages: return "globe"
        case .hotkey: return "command"
        case .settings: return "gearshape.fill"
        }
    }
}

public struct MainWindowView: View {

    /// The scene id in the app shell: `Window("Kotiba", id: "main")`.
    public static let id = "main"

    private let controller: DictationController
    private let navigation: MainWindowNavigation
    @State private var usage: UsageModel
    /// The user folded the sidebar by hand. The window also folds it by itself when narrow.
    @State private var userFolded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(controller: DictationController,
                navigation: MainWindowNavigation = .shared,
                usage: UsageModel = UsageModel()) {
        self.controller = controller
        self.navigation = navigation
        _usage = State(initialValue: usage)
    }

    public var body: some View {
        GeometryReader { proxy in
            let rail = userFolded || proxy.size.width < Theme.Breakpoint.railBelow
            ZStack {
                HStack(spacing: 0) {
                    Sidebar(controller: controller, navigation: navigation, rail: rail,
                            toggle: { withAnimation(Theme.Motion.morph) { userFolded.toggle() } })
                    Rectangle().fill(Theme.Palette.hairline).frame(width: 1)
                    detail
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .animation(Theme.Motion.morph, value: rail)

                if !controller.settings.hasCompletedOnboarding {
                    OnboardingView(controller: controller) {
                        withAnimation(Theme.Motion.section) {
                            navigation.section = .home
                        }
                    }
                    .transition(.opacity.combined(with: .scale(scale: 1.02)))
                    .zIndex(1)
                }
            }
            .animation(Theme.Motion.smooth, value: controller.settings.hasCompletedOnboarding)
        }
        .frame(minWidth: 720, minHeight: 480)
        // Dates, numbers and charts format in the interface language, not the system's; the
        // words themselves come from `L`, which re-renders on its own when the language changes.
        .environment(\.locale, Localizer.shared.locale)
        .kotibaWindowChrome()
        .ignoresSafeArea(.container, edges: .top)
        .task {
            await usage.reload()
            await controller.reloadHistory()
        }
        .onChange(of: controller.lastRecord) { _, record in usage.include(record) }
        .onChange(of: navigation.section) { old, _ in
            // What the old Settings window did on close, done on leaving a page that edits
            // settings as well: apply whatever changed — a model path, a store switched off —
            // without needing the window closed first. Never mid-dictation: `settingsChanged`
            // reopens the stores and may reload an engine, and the window being open is no reason
            // to touch a pipeline that is running. The window's own disappearance catches the rest.
            guard [.modes, .languages, .settings].contains(old),
                  !controller.status.isBusy else { return }
            Task { await controller.settingsChanged() }
        }
        .onDisappear { Task { await controller.settingsChanged() } }
    }

    @ViewBuilder
    private var detail: some View {
        ZStack {
            page(navigation.section)
                .id(navigation.section)
                .transition(reduceMotion ? .opacity : .asymmetric(
                    insertion: .opacity.combined(with: .offset(y: 10)),
                    removal: .opacity))
        }
        .animation(Theme.Motion.section, value: navigation.section)
    }

    @ViewBuilder
    private func page(_ section: MainSection) -> some View {
        switch section {
        case .home: HomePane(controller: controller, usage: usage, navigation: navigation)
        case .history: HistoryPane(controller: controller, usage: usage)
        case .statistics: StatisticsPane(usage: usage, modes: controller.modes, settings: controller.settings)
        case .modes: ModesPane(controller: controller)
        case .languages: LanguagesPane(controller: controller)
        case .hotkey: HotkeyPane(controller: controller)
        case .settings: GeneralPane(controller: controller)
        }
    }
}

// MARK: - Sidebar

struct Sidebar: View {
    let controller: DictationController
    @Bindable var navigation: MainWindowNavigation
    let rail: Bool
    let toggle: () -> Void
    @Namespace private var selection

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            // Room for the traffic lights: the title bar is hidden and content runs under it.
            HStack {
                Spacer()
                if !rail {
                    Button(action: toggle) {
                        Image(systemName: "sidebar.left")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.Palette.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help(L("sidebar.fold"))
                }
            }
            .frame(height: 28)
            .padding(.top, 10)
            .padding(.trailing, 4)

            brand
                .padding(.bottom, Theme.Space.l)

            ForEach(MainSection.allCases) { section in
                row(section)
            }

            Spacer(minLength: Theme.Space.l)
            footer
        }
        .padding(.horizontal, rail ? 8 : 12)
        .padding(.bottom, 14)
        .frame(width: rail ? 60 : 208)
        .background(Theme.Palette.background)
    }

    private var brand: some View {
        HStack(spacing: 10) {
            BrandMark(size: 30)
            .onTapGesture { if rail { toggle() } }
            .help(rail ? L("sidebar.unfold") : "")
            if !rail {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Kotiba")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Palette.text)
                    Text(L("sidebar.tagline"))
                        .font(Theme.Typeface.caption)
                        .foregroundStyle(Theme.Palette.tertiary)
                }
                .transition(.opacity)
            }
        }
        .padding(.horizontal, rail ? 7 : 6)
    }

    private func row(_ section: MainSection) -> some View {
        let selected = navigation.section == section
        return Button {
            withAnimation(Theme.Motion.section) { navigation.section = section }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: section.icon)
                    .font(.system(size: 13, weight: .medium))
                    .frame(width: 18)
                    .foregroundStyle(selected ? Theme.Palette.accent : Theme.Palette.secondary)
                if !rail {
                    Text(section.title)
                        .font(.system(size: 13, weight: selected ? .semibold : .regular))
                        .foregroundStyle(selected ? Theme.Palette.text : Theme.Palette.secondary)
                        .lineLimit(1)
                        .transition(.opacity)
                    Spacer(minLength: 0)
                    // A small dot, not a count in an orange capsule: there is something on Home
                    // for you to do, and Home says what. `blockers` holds only what needs the
                    // user, so a state that heals itself never lights this.
                    if section == .home, !controller.blockers.isEmpty {
                        Circle()
                            .fill(Theme.Palette.amber.opacity(0.85))
                            .frame(width: 6, height: 6)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
            }
            .padding(.horizontal, rail ? 0 : 10)
            .frame(maxWidth: .infinity, alignment: rail ? .center : .leading)
            .frame(height: 32)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Theme.Palette.raised)
                        .overlay(
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .strokeBorder(Theme.Palette.hairline, lineWidth: 1))
                        .matchedGeometryEffect(id: "selection", in: selection)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(SidebarRowStyle())
        .help(rail ? section.title : "")
    }

    private var footer: some View {
        let status = LiveStatus(controller: controller)
        return HStack(spacing: 8) {
            Circle()
                .fill(status.color)
                .frame(width: 7, height: 7)
                .shadow(color: status.color.opacity(0.6), radius: 4)
            if !rail {
                VStack(alignment: .leading, spacing: 1) {
                    Text(status.title)
                        .font(Theme.Typeface.callout.weight(.medium))
                        .foregroundStyle(Theme.Palette.text)
                        .lineLimit(1)
                    Text(L("sidebar.holdToDictate", Names.hotkey(controller.settings)))
                        .font(Theme.Typeface.caption)
                        .foregroundStyle(Theme.Palette.tertiary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .transition(.opacity)
            }
        }
        .padding(.horizontal, rail ? 0 : 8)
        .frame(maxWidth: .infinity, alignment: rail ? .center : .leading)
        .animation(Theme.Motion.smooth, value: status.title)
    }
}

private struct SidebarRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
            .animation(Theme.Motion.snappy, value: configuration.isPressed)
    }
}

// MARK: - Status, in words

/// The controller's status as a title, a colour and a sentence — shared by the sidebar footer and
/// the Home hero.
struct LiveStatus {
    let title: String
    let detail: String
    let color: Color
    let tone: StatusDot.Tone
    let busy: Bool

    init(controller: DictationController) {
        let blocked = !controller.blockers.isEmpty
        switch controller.status {
        case .listening:
            title = L("status.listening.title"); detail = L("status.listening.detail")
            color = Theme.Palette.accent; tone = .good; busy = true
        // Loading is not a problem and is not coloured like one: it finishes by itself.
        case .preparing(let what):
            title = L("status.loading.title"); detail = L("status.loading.detail", what)
            color = Theme.Palette.secondary; tone = .neutral; busy = true
        case .working(let stage):
            title = L("status.working.title"); detail = stage
            color = Theme.Palette.accent; tone = .good; busy = true
        case .failed(let message, _):
            title = L("status.failed.title"); detail = message
            color = Theme.Palette.amber; tone = .warning; busy = false
        case .idle, .succeeded, .heardNothing:
            // Calm, not an alarm: the notices under the hero say what to do, one line each.
            if blocked {
                title = L("status.almostReady.title")
                detail = L("status.ready.detail", Names.hotkey(controller.settings))
                color = Theme.Palette.secondary; tone = .neutral
            } else {
                title = L("status.ready.title")
                detail = L("status.ready.detail", Names.hotkey(controller.settings))
                color = Theme.Palette.accent; tone = .good
            }
            busy = false
        }
    }
}

// MARK: - Names

public enum Names {
    static func language(_ language: Language) -> String {
        switch language {
        case .english: return L("speech.english")
        case .russian: return L("speech.russian")
        case .uzbek: return L("speech.uzbek")
        case .turkish: return L("speech.turkish")
        case .arabic: return L("speech.arabic")
        }
    }

    /// The two-letter code a badge shows. (The pill carried it until 2026-09-30.)
    static func languageCode(_ language: Language) -> String {
        switch language {
        case .english: return "EN"
        case .russian: return "RU"
        case .uzbek: return "UZ"
        case .turkish: return "TR"
        case .arabic: return "AR"
        }
    }

    /// A mode's glyph, for the Modes page's cards. (The pill carried it until 2026-09-30.)
    static func modeSymbol(_ key: String) -> String {
        switch key {
        case "super": return "sparkles"
        case "message": return "bubble.left.fill"
        case "note": return "list.bullet.rectangle.fill"
        default: return "text.cursor"
        }
    }

    static func language(code: String) -> String {
        Language(rawValue: code).map(language) ?? L("speech.unknown")
    }

    /// A mode's name. The four built-in modes are named in the interface language; a mode the user
    /// made keeps the name they gave it.
    static func mode(_ key: String, in modes: ModeRegistry) -> String {
        if key == "unknown" { return L("mode.unrecorded") }
        guard let mode = modes.mode(for: key) else { return key.capitalized }
        return builtInModeName(key, fallback: mode.name)
    }

    public static func mode(_ mode: Mode) -> String { builtInModeName(mode.key, fallback: mode.name) }

    /// The built-in names, only while the user has not renamed them: a mode renamed by hand is the
    /// user's word, not ours.
    static func builtInModeName(_ key: String, fallback: String) -> String {
        switch (key, fallback) {
        case ("super", "Super"): return L("mode.super")
        case ("message", "Message"): return L("mode.message")
        case ("note", "Note"): return L("mode.note")
        case ("transcription", "Raw"), ("transcription", "Transcription"): return L("mode.raw")
        default: return fallback
        }
    }

    static func millis(_ value: Double?) -> String {
        guard let value else { return "—" }
        if value >= 10_000 { return L("unit.seconds", number(value / 1000, digits: 0)) }
        if value >= 1000 { return L("unit.seconds", number(value / 1000, digits: 1)) }
        return L("unit.millis", number(value, digits: 0))
    }

    static func duration(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        if total < 60 { return L("unit.seconds", number(Double(total), digits: 0)) }
        let minutes = total / 60
        if minutes < 60 { return L("unit.minutes", number(Double(minutes), digits: 0)) }
        let hours = Double(minutes) / 60
        return L("unit.hours", number(hours, digits: hours < 10 ? 1 : 0))
    }

    /// A decimal in the interface language — "1.4" in English, "1,4" in Russian and Uzbek.
    static func number(_ value: Double, digits: Int) -> String {
        value.formatted(.number.precision(.fractionLength(digits)).grouping(.automatic)
            .locale(Localizer.shared.locale))
    }

    /// The hotkey, in words. One place, so the configurable hotkey changes every sentence in the
    /// window at once — "right ⌘", "F13", "fn / 🌐".
    static func hotkey(_ settings: AppSettings) -> String {
        hotkeyInline(settings.hotkey)
    }

    /// `HotkeySpec`'s names are English ("Right ⌘", "Space"); the symbols are universal and the
    /// words are not. The side is translated here, in the one place every sentence reads it from.
    static func hotkeyName(_ spec: HotkeySpec) -> String {
        hotkeyName(code: spec.keyCode)
    }

    static func hotkeyName(code: UInt16) -> String {
        let name = HotkeySpec.name(of: code)
        if name.hasPrefix("Right ") { return L("key.right", String(name.dropFirst(6))) }
        if name.hasPrefix("Left ") { return L("key.left", String(name.dropFirst(5))) }
        switch name {
        case "Space": return L("key.space")
        case "Return": return L("key.return")
        case "Delete": return L("key.delete")
        case "Escape": return L("key.escape")
        case "Forward Delete": return L("key.forwardDelete")
        case "Page Up": return L("key.pageUp")
        case "Page Down": return L("key.pageDown")
        case "Help": return L("key.help")
        case "Clear": return L("key.clear")
        default:
            if name.hasPrefix("Key "), let code = UInt16(name.dropFirst(4)) {
                return L("key.code", Int(code))
            }
            return name
        }
    }

    /// `HotkeySpec.advice`, worded in the interface language.
    static func hotkeyWarnings(_ spec: HotkeySpec) -> [String] {
        spec.advice.map { advice in
            switch advice {
            case .leftHandShortcuts(let symbol): return L("hotkey.advice.leftHand", symbol)
            case .globeKey: return L("hotkey.advice.globe")
            case .rightOptionAccents: return L("hotkey.advice.rightOption")
            case .shiftCapitals: return L("hotkey.advice.shift")
            case .needsAccessibility: return L("hotkey.advice.accessibility")
            case .mediaKeys: return L("hotkey.advice.mediaKeys")
            }
        }
    }

    static func hotkeyRejection(_ rejection: HotkeyRecorder.Rejection) -> String {
        switch rejection {
        case .combination: return L("hotkey.reject.combination")
        case .typingKey(let code): return L("hotkey.reject.typingKey", hotkeyName(code: code))
        }
    }

    /// The name inside a sentence: "right ⌘" in English, where the side is lower-case mid-sentence.
    static func hotkeyInline(_ spec: HotkeySpec) -> String {
        let name = hotkeyName(spec)
        let side = HotkeySpec.name(of: spec.keyCode)
        guard side.hasPrefix("Right ") || side.hasPrefix("Left ") else { return name }
        return name.prefix(1).lowercased() + name.dropFirst()
    }

    /// One label per key cap: the side as a word, then the symbol — or one cap for anything else.
    static func keycapLabels(_ spec: HotkeySpec) -> [String] {
        let english = spec.keycapLabels
        guard english.count == 2 else {
            return spec.keyCode == HotkeySpec.Code.function ? english : [hotkeyName(spec)]
        }
        let side = english[0] == "right" ? L("key.side.right") : L("key.side.left")
        return [side, english[1]]
    }

    /// A pipeline stage from the diagnostics log, named for the Statistics chart.
    static func stage(_ key: String) -> String {
        switch key {
        case "arming": return L("stage.arming")
        case "finalising": return L("stage.finalising")
        case "loading": return L("stage.loading")
        case "routing": return L("stage.routing")
        case "transcribing": return L("stage.transcribing")
        case "rerouting": return L("stage.rerouting")
        case "polishing": return L("stage.polishing")
        case "inserting": return L("stage.inserting")
        default: return key.capitalized
        }
    }

    static func count(_ value: Int) -> String {
        value.formatted(.number.grouping(.automatic).locale(Localizer.shared.locale))
    }

    // A count-up passes through every value between 0 and the final one, and must stay in the
    // final one's unit the whole way: "850 ms" turning into "1.0 s", or minutes into hours, halfway
    // through the animation reads as a glitch. These pick the unit from the final value.

    static func countFormat() -> (Double) -> String {
        { count(Int($0.rounded())) }
    }

    // The formats read the interface language when they run, not when they are made, so a count-up
    // that is on screen while the language changes finishes in the new one.

    static func millisFormat(toward final: Double) -> (Double) -> String {
        if final >= 10_000 { return { L("unit.seconds", number($0 / 1000, digits: 0)) } }
        if final >= 1000 { return { L("unit.seconds", number($0 / 1000, digits: 1)) } }
        return { L("unit.millis", number($0, digits: 0)) }
    }

    static func durationFormat(toward final: Double) -> (Double) -> String {
        let total = Int(final.rounded())
        if total < 60 { return { L("unit.seconds", number($0, digits: 0)) } }
        if total / 60 < 60 { return { L("unit.minutes", number(($0 / 60).rounded(.down), digits: 0)) } }
        let hours = Double(total / 60) / 60
        return hours < 10 ? { L("unit.hours", number(($0 / 60).rounded(.down) / 60, digits: 1)) }
            : { L("unit.hours", number((($0 / 60).rounded(.down) / 60).rounded(), digits: 0)) }
    }
}
