import KotibaCore
import KotibaModels
import KotibaPlatform
import SwiftUI

// Modes: what each one does, which is the default, and whether the app you are in chooses.
// Ported from the old Modes tab (app-following, the fallback picker — still `setDefaultMode`, never
// `setMode`, see its doc comment — and the per-mode app lists) and from the old AI tab, whole:
// polish on/off and what will run, on-device first, Uzbek rewrites, endpoint, model, the Keychain
// key, and the timeout. Polish lives here because polish is what a mode *is*.

struct ModesPane: View {
    let controller: DictationController
    @Bindable private var settings: AppSettings

    init(controller: DictationController) {
        self.controller = controller
        self.settings = controller.settings
    }

    var body: some View {
        Pane(title: L("section.modes"), subtitle: L("modes.subtitle")) {
            Card {
                ToggleRow(title: L("modes.followApp"),
                          detail: L("modes.followApp.detail"),
                          isOn: settings.bound(\.modeFollowsApp))
                Hairline()
                SettingRow(title: L("modes.rightNow"),
                           detail: controller.userPickedMode == nil
                               ? (settings.modeFollowsApp ? L("modes.rightNow.following")
                                  : L("modes.rightNow.default"))
                               : L("modes.rightNow.picked")) {
                    AdaptivePicker(selection: ModeBinding.make(controller),
                                   options: ModeBinding.options(controller))
                }
            }

            // Four cards: 2 × 2 or 4 across, never three and a lone fourth.
            AdaptiveGrid(minimumColumnWidth: 250, maximumColumns: 4) {
                ForEach(controller.modes.modes, id: \.key) { mode in
                    ModeCard(mode: mode,
                             isDefault: settings.defaultModeKey == mode.key,
                             isActive: controller.activeModeKey == mode.key,
                             followsApp: settings.modeFollowsApp) {
                        // Not `setMode`: this sets the fallback, and pinning here would switch
                        // off app-following behind the toggle above.
                        withAnimation(Theme.Motion.snappy) { controller.setDefaultMode(mode.key) }
                    }
                }
            }

            PolishCard(controller: controller)
        }
    }
}

// MARK: - One mode

private struct ModeCard: View {
    let mode: Mode
    let isDefault: Bool
    let isActive: Bool
    let followsApp: Bool
    let makeDefault: () -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(isDefault ? Theme.Palette.accent : Theme.Palette.raised)
                    Image(systemName: Names.modeSymbol(mode.key))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(isDefault ? Theme.Palette.accentInk : Theme.Palette.accent)
                }
                .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Names.mode(mode))
                        .font(Theme.Typeface.headline)
                        .foregroundStyle(Theme.Palette.text)
                    Text(mode.polishes ? L("modes.card.polishes") : L("modes.card.noModel"))
                        .font(Theme.Typeface.caption)
                        .foregroundStyle(Theme.Palette.tertiary)
                }
                Spacer(minLength: 0)
                if isDefault {
                    Badge(text: (followsApp ? L("modes.badge.fallback") : L("modes.badge.default"))
                            .uppercased(with: Localizer.shared.locale), tint: Theme.Palette.accent)
                        .transition(.scale.combined(with: .opacity))
                }
            }

            Text(Self.summary(mode.key))
                .font(Theme.Typeface.callout)
                .foregroundStyle(Theme.Palette.secondary)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)

            if !mode.activationApps.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "app.badge.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.Palette.tertiary)
                    Text(mode.activationApps.map(AppNames.name).joined(separator: ", "))
                        .font(Theme.Typeface.caption)
                        .foregroundStyle(followsApp ? Theme.Palette.secondary : Theme.Palette.tertiary)
                        .lineLimit(2)
                }
                .help(followsApp ? L("modes.apps.help.on") : L("modes.apps.help.off"))
            }

            Spacer(minLength: 0)
            HStack {
                if let language = mode.language {
                    Badge(text: language.rawValue.uppercased())
                }
                Spacer()
                Button(isDefault ? L("modes.default") : L("modes.makeDefault"), action: makeDefault)
                    .buttonStyle(isDefault ? .kotibaGhost : .kotibaSmall)
                    .disabled(isDefault)
            }
        }
        .padding(Theme.Space.l)
        .frame(maxWidth: .infinity, minHeight: 190, alignment: .topLeading)
        .background(Theme.Palette.surface,
                    in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                .strokeBorder(isDefault ? Theme.Palette.accent.opacity(0.45)
                              : hovering ? Theme.Palette.hairlineStrong : Theme.Palette.hairline,
                              lineWidth: 1))
        .onHover { hovering = $0 }
        .animation(Theme.Motion.snappy, value: hovering)
        .animation(Theme.Motion.snappy, value: isDefault)
    }

    /// What the mode does, in a sentence — read off the shipped prompts in BuiltInModes.swift.
    static func summary(_ key: String) -> String {
        switch key {
        case "super": return L("modes.summary.super")
        case "message": return L("modes.summary.message")
        case "note": return L("modes.summary.note")
        case "transcription": return L("modes.summary.raw")
        default: return L("modes.summary.custom")
        }
    }
}

/// Friendly names for the bundle IDs in the built-in activation lists.
enum AppNames {
    static let known: [String: String] = [
        "com.tinyspeck.slackmacgap": "Slack", "com.hnc.Discord": "Discord",
        "org.telegram": "Telegram", "ru.keepcoder.Telegram": "Telegram",
        "net.whatsapp.WhatsApp": "WhatsApp", "com.apple.MobileSMS": "Messages",
        "md.obsidian": "Obsidian", "notion.id": "Notion", "net.shinyfrog.bear": "Bear",
        "com.lukilabs.lukiapp": "Craft", "com.apple.Notes": "Notes",
    ]

    static func name(_ bundleID: String) -> String {
        // Apple's own apps are named in the interface language, as macOS names them.
        switch bundleID {
        case "com.apple.MobileSMS": return L("app.messages")
        case "com.apple.Notes": return L("app.notes")
        default: break
        }
        return known[bundleID] ?? bundleID.split(separator: ".").last.map(String.init) ?? bundleID
    }
}

// MARK: - Polish

private struct PolishCard: View {
    let controller: DictationController
    @Bindable private var settings: AppSettings
    @State private var apiKey = ""
    @State private var keyIsSet = false
    @State private var keyError: String?

    init(controller: DictationController) {
        self.controller = controller
        self.settings = controller.settings
    }

    var body: some View {
        Card(title: L("polish.title"), subtitle: L("polish.subtitle"), systemImage: "sparkles") {
            ToggleRow(title: L("polish.enabled"),
                      detail: L("polish.enabled.detail"),
                      isOn: settings.bound(\.polishEnabled))
            // What will actually run, stated rather than left to be discovered by a dictation
            // that quietly does nothing.
            HStack(spacing: 8) {
                StatusDot(text: controller.polishStatus,
                          tone: settings.polishEnabled ? .good : .neutral)
            }
            Hairline()
            ToggleRow(title: L("polish.onDevice"),
                      detail: L("polish.onDevice.detail"),
                      isOn: settings.bound(\.preferOnDeviceModel))
            if !controller.polishModelInstalled {
                // The same download the onboarding and Languages show, with its progress, and
                // resumable: an interrupted 1.28 GB fetch continues where it stopped.
                let state = controller.models.state(.modes)
                HStack(spacing: Theme.Space.s) {
                    switch state {
                    case .downloading(let bytes):
                        StatusDot(text: L("polish.model.downloading"), tone: .neutral)
                        ProgressView(value: Double(bytes),
                                     total: Double(ModelDownloads.Item.modes.bytes))
                            .tint(Theme.Palette.accent)
                    case .queued:
                        StatusDot(text: L("polish.model.queued"), tone: .neutral)
                        Spacer()
                    default:
                        StatusDot(text: L("polish.model.missing"), tone: .warning)
                        Spacer()
                        Button(L("polish.model.download",
                                 ModelsCard.size(ModelDownloads.Item.modes.bytes))) {
                            controller.models.download([.modes])
                        }
                            .buttonStyle(.kotibaPrimary)
                    }
                }
                if case .failed(let why) = state {
                    Footnote(why, tint: Theme.Palette.danger)
                }
            }
            Hairline()
            ToggleRow(title: L("polish.uzbekCloud"),
                      detail: L("polish.uzbekCloud.detail"),
                      isOn: settings.bound(\.polishUzbek))
            Hairline()

            VStack(alignment: .leading, spacing: Theme.Space.s) {
                ToggleRow(title: L("polish.endpoint"),
                          detail: L("polish.endpoint.detail"),
                          isOn: settings.bound(\.cloudPolish))
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Theme.Space.s) { endpointField; modelField }
                    VStack(spacing: Theme.Space.s) { endpointField; modelField }
                }
                HStack(spacing: Theme.Space.s) {
                    WellField(placeholder: keyIsSet ? L("polish.key.saved") : L("polish.key.placeholder"),
                              text: $apiKey, secure: true)
                    Button(keyIsSet ? L("polish.key.replace") : L("polish.key.save")) { saveKey() }
                        .buttonStyle(.kotibaPrimary)
                        .disabled(apiKey.isEmpty)
                    if keyIsSet {
                        Button(L("common.remove")) { removeKey() }
                            .buttonStyle(.kotibaDestructive)
                    }
                }
                if let keyError {
                    Footnote(keyError, tint: Theme.Palette.danger)
                }
                Footnote(L("polish.key.footnote"))
            }
            Hairline()

            VStack(alignment: .leading, spacing: Theme.Space.s) {
                SettingRow(title: L("polish.timeout"), detail: L("polish.timeout.detail")) {
                    Text(L("unit.seconds", Names.number(settings.polishTimeoutSeconds, digits: 0)))
                        .font(Theme.Typeface.body.monospacedDigit())
                        .foregroundStyle(Theme.Palette.accent)
                        .contentTransition(.numericText())
                }
                Slider(value: Binding(get: { settings.polishTimeoutSeconds },
                                      set: {
                                          settings.polishTimeoutSeconds = $0.rounded()
                                          settings.save()
                                      }),
                       in: 2...30)
                    .tint(Theme.Palette.accent)
            }
        }
        .onAppear { keyIsSet = Keychain.has(account: settings.polishKeyAccount) }
    }

    private var endpointField: some View {
        LabeledWell(label: L("polish.endpoint.label"), text: settings.bound(\.polishBaseURL))
    }

    private var modelField: some View {
        LabeledWell(label: L("polish.model.label"), text: settings.bound(\.polishModel))
    }

    private func saveKey() {
        do {
            try Keychain.set(apiKey, account: settings.polishKeyAccount)
            apiKey = ""
            keyIsSet = true
            keyError = nil
        } catch {
            keyError = (error as? Keychain.Failure)?.reason ?? "\(error)"
        }
        Task { await controller.refreshBlockers() }
    }

    private func removeKey() {
        // Only flip the UI when the delete actually happened. `try?` here once told the user the
        // key was gone while `Keychain.get` still returned it — so `makePolisher` kept building a
        // client and kept shipping transcripts to the endpoint. This is the one path where being
        // wrong leaks data rather than merely failing.
        do {
            try Keychain.remove(account: settings.polishKeyAccount)
            keyIsSet = false
            apiKey = ""
            keyError = nil
        } catch {
            keyError = (error as? Keychain.Failure)?.reason ?? "\(error)"
            keyIsSet = Keychain.has(account: settings.polishKeyAccount)
        }
        Task { await controller.refreshBlockers() }
    }
}

private struct LabeledWell: View {
    let label: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased(with: Localizer.shared.locale))
                .font(Theme.Typeface.micro)
                .tracking(0.5)
                .foregroundStyle(Theme.Palette.tertiary)
            WellField(placeholder: label, text: $text, monospaced: true)
        }
    }
}
