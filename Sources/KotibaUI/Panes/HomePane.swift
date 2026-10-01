import KotibaCore
import SwiftUI

#if os(macOS)
import AppKit
#endif

// Home: is it working, how do I use it, what did it last do, and — when something is in the
// way — the button that fixes it. Ported here from the old General tab: the permissions list,
// its Grant buttons and "Check again".

struct HomePane: View {
    let controller: DictationController
    let usage: UsageModel
    let navigation: MainWindowNavigation

    var body: some View {
        Pane(title: greeting, subtitle: nil) {
            // First row: the promo (V19 "Globe", owner's pick 2026-10-02), always playing while it
            // can be seen. The hero stays as the second row rather than merging into it: it is the
            // live status (the pill is the meter while listening) and the hotkey hint, and the
            // calm notices below keep their place under it.
            PromoGlobePanel(hotkeyGlyph: controller.settings.hotkey.keycapLabels.last ?? "⌘")

            HeroCard(controller: controller)

            // The core download, while any of it is still coming (hidden otherwise).
            CoreReadyCard(controller: controller)

            ClipboardHint(controller: controller)

            QuietMicNotice(controller: controller)

            if !controller.blockers.isEmpty {
                Notices(controller: controller, navigation: navigation)
                    .transition(.opacity.combined(with: .offset(y: -6)))
            }

            QuickPickersCard(controller: controller)
                .onDisappear { controller.languageOrder.release() }
                .task { await controller.languageOrder.refreshThenHold() }

            if let text = lastText {
                LastTranscriptCard(text: text, record: controller.lastRecord,
                                   modes: controller.modes)
                    .transition(.opacity)
            }

            TodayRow(stats: usage.stats) {
                withAnimation(Theme.Motion.section) { navigation.section = .statistics }
            }
        }
        .animation(Theme.Motion.smooth, value: controller.blockers)
        .animation(Theme.Motion.smooth, value: controller.lastTranscript)
    }

    /// The newest thing dictated: this session's if there is one, otherwise history's.
    private var lastText: String? {
        if !controller.lastTranscript.isEmpty { return controller.lastTranscript }
        return controller.history.first?.final
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 5..<12: return L("home.greeting.morning")
        case 12..<18: return L("home.greeting.afternoon")
        default: return L("home.greeting.evening")
        }
    }
}

// MARK: - Hero

private struct HeroCard: View {
    let controller: DictationController

    var body: some View {
        let status = LiveStatus(controller: controller)
        Card {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: Theme.Space.xl) {
                    words(status)
                    Spacer(minLength: 0)
                    visual(status)
                }
                // Narrow: the keycap is decoration and goes; the pill stays, because while
                // listening it is the live meter.
                VStack(alignment: .leading, spacing: Theme.Space.l) {
                    words(status)
                    if status.busy { visual(status) }
                }
            }
            .padding(.vertical, Theme.Space.xs)
        }
        .overlay(alignment: .topTrailing) {
            // A soft green wash in the corner while listening — the window agreeing with the pill.
            RadialGradient(colors: [status.color.opacity(status.busy ? 0.22 : 0.08), .clear],
                           center: .topTrailing, startRadius: 0, endRadius: 260)
                .allowsHitTesting(false)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                .animation(Theme.Motion.smooth, value: status.busy)
        }
    }

    private func words(_ status: LiveStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            StatusDot(text: status.title, tone: status.tone, pulsing: status.busy)
            Text(status.detail)
                .font(Theme.Typeface.title)
                .foregroundStyle(Theme.Palette.text)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
            HStack(spacing: 6) {
                Text(L("home.hero.hold")).foregroundStyle(Theme.Palette.secondary)
                Keycap(label: Names.hotkey(controller.settings))
                Text(L("home.hero.howTo"))
                    .foregroundStyle(Theme.Palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(Theme.Typeface.callout)
        }
    }

    @ViewBuilder
    private func visual(_ status: LiveStatus) -> some View {
        let state = PillState(status: controller.status, record: controller.lastRecord,
                              copied: controller.lastWentToClipboard,
                              quietMic: controller.quietMicForPill)
        ZStack {
            if status.busy {
                PillView(state: state, level: controller.level, style: controller.settings.pillStyle)
                    .transition(.scale(scale: 0.6, anchor: .bottom).combined(with: .opacity))
            } else {
                Keycap(label: "⌘", large: true)
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
            }
        }
        .frame(width: PillView.width + 10, height: 64)
        .animation(Theme.Motion.pop, value: status.busy)
    }
}

// MARK: - Notices

/// What the user has to do, if anything: one small, calm row each, animated in and out as they
/// appear and clear. Replaced the "Needs your attention" card on the owner's review of
/// 2026-09-30 — it was a panel-sized alarm for what was, most days, a microphone that had already
/// rebuilt itself. `DictationController.blockers` now only holds what needs the user.
struct Notices: View {
    let controller: DictationController
    let navigation: MainWindowNavigation
    @State private var checking = false

    var body: some View {
        VStack(alignment: .trailing, spacing: Theme.Space.s) {
            ForEach(controller.blockers) { blocker in
                NoticeRow(blocker: blocker,
                          onGrant: { controller.requestMissingPermissions() },
                          open: section(for: blocker).map { section in
                              { withAnimation(Theme.Motion.section) { navigation.section = section } }
                          })
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(y: -6)),
                        removal: .opacity.combined(with: .scale(scale: 0.97))))
            }
            // recheck(), not refreshBlockers(): the latter only re-reads `microphone.isWarm`,
            // which nothing but warmUp() can ever set to true.
            Button(checking ? L("home.blockers.checking") : L("home.blockers.checkAgain")) {
                checking = true
                Task {
                    await controller.recheck()
                    checking = false
                }
            }
            .buttonStyle(.plain)
            .font(Theme.Typeface.caption)
            .foregroundStyle(Theme.Palette.tertiary)
            .disabled(checking)
        }
        .animation(Theme.Motion.smooth, value: controller.blockers)
    }

    private func section(for blocker: DictationController.Blocker) -> MainSection? {
        switch blocker.id {
        case "uzbek-model", "russian-model": return .languages
        default: return nil
        }
    }
}

// MARK: - A microphone that hears almost nothing

/// Said once per device per hour (`QuietMicLimiter`), after a take that was held and barely
/// registered: which microphone it was, what kind of input that is, and the button that opens the
/// Sound pane on its Input tab. Goes by itself when a later dictation comes out as text.
private struct QuietMicNotice: View {
    let controller: DictationController

    var body: some View {
        Group {
            if let notice = controller.quietMicNotice {
                NoticeRow(blocker: notice, actionTitle: L("home.quietMic.open"),
                          dismiss: { controller.dismissQuietMic() })
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(y: -6)),
                        removal: .opacity.combined(with: .scale(scale: 0.97))))
            }
        }
        .animation(Theme.Motion.smooth, value: controller.quietMicNotice)
    }
}

// MARK: - Nowhere to paste

/// The last dictation had no text field to go into, so it is on the clipboard. Said once, softly,
/// for a few seconds — the pill has already said it at the moment it happened; this is for someone
/// who looks at the window afterwards and wonders where their words went.
private struct ClipboardHint: View {
    let controller: DictationController
    @State private var shown = false

    var body: some View {
        Group {
            if shown {
                HStack(spacing: Theme.Space.s) {
                    Image(systemName: "doc.on.clipboard")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.Palette.accent)
                    Text(L("home.clipboardHint"))
                        .font(Theme.Typeface.callout)
                        .foregroundStyle(Theme.Palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, Theme.Space.m)
                .padding(.vertical, Theme.Space.s)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.Palette.accentSoft.opacity(0.5),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .task(id: controller.lastWentToClipboard) {
            guard controller.lastWentToClipboard else {
                withAnimation(Theme.Motion.smooth) { shown = false }
                return
            }
            withAnimation(Theme.Motion.smooth) { shown = true }
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            withAnimation(Theme.Motion.smooth) { shown = false }
        }
    }
}

struct BlockerRow: View {
    let blocker: DictationController.Blocker
    var onGrant: () -> Void = {}

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.m) {
            Circle()
                .fill(Theme.Palette.amber)
                .frame(width: 7, height: 7)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 3) {
                Text(blocker.title)
                    .font(Theme.Typeface.body.weight(.medium))
                    .foregroundStyle(Theme.Palette.text)
                Text(blocker.detail)
                    .font(Theme.Typeface.caption)
                    .foregroundStyle(Theme.Palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            #if os(macOS)
            if let urlString = blocker.settingsURL, let url = URL(string: urlString) {
                Button(L("home.blockers.fix")) {
                    // Ask first. The system dialog registers Kotiba in the list, so the pane
                    // that opens behind it has a switch to flip rather than nothing at all.
                    onGrant()
                    NSWorkspace.shared.open(url)
                }
                .buttonStyle(.kotibaPrimary)
            }
            #endif
        }
    }
}

// MARK: - Quick pickers

/// Mode and language, the two things someone changes between dictations. Same semantics as the
/// menu-bar menu, which is the reference: "Automatic" for mode exists only while the app decides,
/// and a language can only be pinned when its model is there.
struct QuickPickersCard: View {
    let controller: DictationController

    var body: some View {
        Card {
            SettingRow(title: L("home.pickers.mode"),
                       detail: controller.settings.modeFollowsApp
                           ? L("home.pickers.mode.automatic")
                           : L("home.pickers.mode.detail")) {
                AdaptivePicker(selection: ModeBinding.make(controller),
                               options: ModeBinding.options(controller))
            }
            Hairline()
            SettingRow(title: L("home.pickers.language"),
                       detail: L("home.pickers.language.detail")) {
                AdaptivePicker(selection: LanguageBinding.make(controller),
                               options: LanguageBinding.options(controller),
                               disabled: LanguageBinding.disabled(controller))
            }
        }
    }
}

/// The mode choice as one binding, shared by Home and Modes.
enum ModeBinding {
    static let automatic = "__automatic"

    static func options(_ controller: DictationController) -> [(value: String, label: String)] {
        var options: [(value: String, label: String)] = []
        if controller.settings.modeFollowsApp { options.append((automatic, L("common.automatic"))) }
        options += controller.selectableModes.map { ($0.key, Names.mode($0)) }
        return options
    }

    static func make(_ controller: DictationController) -> Binding<String> {
        Binding(
            get: {
                if controller.settings.modeFollowsApp {
                    return controller.userPickedMode ?? automatic
                }
                return controller.userPickedMode ?? controller.settings.defaultModeKey
            },
            set: { key in
                if key == automatic { controller.clearPickedMode() } else { controller.setMode(key) }
            })
    }
}

enum LanguageBinding {
    static let automatic = "__automatic"

    /// Computed, not stored: the labels are words in the interface language. Automatic first,
    /// then every language in the controller's order (default, then by recent use) — an optional
    /// one (Turkish, Arabic) only once the user has turned it on (D-11).
    static func options(_ controller: DictationController) -> [(value: String, label: String)] {
        [(automatic, L("common.automatic"))]
            + controller.dictationLanguages.map { ($0.rawValue, Names.language($0)) }
    }

    static func disabled(_ controller: DictationController) -> Set<String> {
        let pinnable = Set(controller.pinnableLanguages.map(\.rawValue))
        return Set(Language.allCases.map(\.rawValue).filter { !pinnable.contains($0) })
    }

    static func make(_ controller: DictationController) -> Binding<String> {
        Binding(
            get: { controller.pinnedLanguage?.rawValue ?? automatic },
            set: { value in controller.setPinnedLanguage(Language(rawValue: value)) })
    }
}

// MARK: - Last transcript

private struct LastTranscriptCard: View {
    let text: String
    let record: DictationRecord?
    let modes: ModeRegistry
    @State private var copied = false

    var body: some View {
        Card(title: L("home.last.title"), systemImage: "text.quote") {
            Text(text)
                .font(Theme.Typeface.body)
                .foregroundStyle(Theme.Palette.text)
                .lineSpacing(3)
                .lineLimit(6)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .transcriptDirection(text)
            HStack(spacing: 6) {
                if let language = record?.route?.language {
                    Badge(text: Names.language(language).uppercased())
                }
                if let mode = record?.modeKey {
                    Badge(text: Names.mode(mode, in: modes).uppercased())
                }
                if let millis = record?.releaseToPasteMillis {
                    Badge(text: Names.millis(millis), tint: Theme.Palette.accent)
                }
                Spacer()
                Button {
                    Clipboard.copy(text)
                    withAnimation(Theme.Motion.snappy) { copied = true }
                    Task {
                        try? await Task.sleep(for: .seconds(1.4))
                        withAnimation(Theme.Motion.snappy) { copied = false }
                    }
                } label: {
                    Label(copied ? L("common.copied") : L("common.copy"), systemImage: copied ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.kotibaSmall)
            }
        }
    }
}

// MARK: - Today

private struct TodayRow: View {
    let stats: UsageStats
    let openStatistics: () -> Void

    var body: some View {
        AdaptiveGrid(minimumColumnWidth: 138, maximumColumns: 4) {
            StatTile(title: L("home.today.title"), value: Names.count(stats.todayDictations),
                     caption: Lnoun("noun.dictation", stats.todayDictations),
                     systemImage: "mic.fill",
                     counting: .init(number: Double(stats.todayDictations), format: Names.countFormat()),
                     order: 0)
            StatTile(title: L("home.today.words"), value: Names.count(stats.todayWords),
                     caption: L("home.today.words.caption"), systemImage: "text.word.spacing",
                     counting: .init(number: Double(stats.todayWords), format: Names.countFormat()),
                     order: 1)
            StatTile(title: L("home.today.latency"), value: Names.millis(stats.latencyMedianMillis),
                     caption: L("common.median"), systemImage: "bolt.fill",
                     counting: stats.latencyMedianMillis.map {
                         .init(number: $0, format: Names.millisFormat(toward: $0))
                     },
                     order: 2)
            StatTile(title: L("home.today.streak"), value: Names.count(stats.streakDays),
                     caption: Lnoun("noun.day", stats.streakDays), systemImage: "flame.fill",
                     counting: .init(number: Double(stats.streakDays), format: Names.countFormat()),
                     order: 3)
        }
        .onTapGesture(perform: openStatistics)
        .help(L("home.today.open"))
    }
}
