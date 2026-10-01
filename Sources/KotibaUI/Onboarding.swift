import KotibaCore
import KotibaModels
import KotibaPlatform
import SwiftUI

#if os(macOS)
import AppKit
import AVFoundation
#endif

// First run, inside the main window: language → welcome → permissions → hotkey → languages →
// Always on → done. There is no models step: the core downloads by itself the moment the
// languages step is left (or setup is skipped) and its one progress card ("Getting Kotiba
// ready") is on the last page and on Home; Turkish and Arabic name their download size under
// their switches and fetch with it. The language comes first because every later page is words: it is picked on
// four cards, applied the moment one is clicked, and the rest of setup reads in it. It covers the
// window until finished or skipped, and `hasCompletedOnboarding` is what keeps it from coming
// back — the app shell also uses that flag to open the window at launch until then.
//
// Permissions are shown live. Each row re-reads its grant once a second while the step is on
// screen, so switching Kotiba on in System Settings flips the row here without a click — which is
// what makes the step feel like it is watching rather than asking.

struct OnboardingView: View {
    let controller: DictationController
    let finished: () -> Void

    enum Step: Int, CaseIterable {
        case appLanguage, welcome, permissions, hotkey, languages, alwaysOn, done
    }

    @State private var step: Step
    @State private var forward = true
    /// Pre-set on and marked recommended, as the brief asks. Written to settings on finish.
    @State private var alwaysOn = true
    @State private var grants = Grants.current
    /// "Which languages do you dictate in?": Uzbek, English and Russian on; Turkish and Arabic
    /// only when the Mac's own language is one of them (`LanguageSubset.preset`) — or, when setup
    /// is run again, what is on now.
    @State private var chosenLanguages: LanguageSubset
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(controller: DictationController, finished: @escaping () -> Void,
         initialStep: Step = .appLanguage) {
        self.controller = controller
        self.finished = finished
        _step = State(initialValue: initialStep)
        let languages = controller.settings.hasCompletedOnboarding
            ? controller.settings.languageSubset
            : LanguageSubset.preset(systemLanguages: Locale.preferredLanguages)
        _chosenLanguages = State(initialValue: languages)
    }

    var body: some View {
        ZStack {
            Theme.Palette.background.ignoresSafeArea()
            RadialGradient(colors: [Theme.Palette.accent.opacity(0.10), .clear],
                           center: .top, startRadius: 0, endRadius: 520)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Spacer(minLength: Theme.Space.l)
                ZStack {
                    page(step)
                        .id(step)
                        .transition(reduceMotion ? .opacity : .asymmetric(
                            insertion: .opacity.combined(with: .offset(x: forward ? 40 : -40)),
                            removal: .opacity.combined(with: .offset(x: forward ? -40 : 40))))
                }
                .frame(maxWidth: 540)
                .animation(Theme.Motion.section, value: step)
                Spacer(minLength: Theme.Space.l)
                footer
            }
            .padding(.horizontal, Theme.Space.xxl)
            .padding(.top, 40)
            .padding(.bottom, Theme.Space.xl)
        }
        .task(id: step) {
            guard step == .permissions else { return }
            while !Task.isCancelled {
                let now = Grants.current
                if now != grants { withAnimation(Theme.Motion.snappy) { grants = now } }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    // MARK: Chrome

    private var header: some View {
        ZStack {
            HStack {
                // The app's own icon, so the first thing a new user sees is which app this is.
                HStack(spacing: Theme.Space.s) {
                    BrandMark(size: 26)
                    Text("Kotiba")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Palette.text)
                }
                Spacer()
                if step != .done {
                    Button(L("onboarding.skip")) { finish() }
                        .buttonStyle(.plain)
                        .font(Theme.Typeface.callout)
                        .foregroundStyle(Theme.Palette.tertiary)
                }
            }
            HStack(spacing: 5) {
                ForEach(Step.allCases, id: \.self) { item in
                    Capsule()
                        .fill(item.rawValue <= step.rawValue ? Theme.Palette.accent
                              : Theme.Palette.elevated)
                        .frame(width: item == step ? 22 : 7, height: 7)
                }
            }
            .animation(Theme.Motion.morph, value: step)
        }
    }

    private var footer: some View {
        HStack {
            if step != .appLanguage && step != .done {
                Button(L("common.back")) { go(-1) }
                    .buttonStyle(.kotibaGhost)
                    .transition(.opacity)
            }
            Spacer()
            Button(primaryTitle) {
                if step == .done { finish() } else { go(+1) }
            }
            .buttonStyle(.kotibaPrimary)
            .keyboardShortcut(.defaultAction)
        }
        .frame(maxWidth: 540)
        .animation(Theme.Motion.snappy, value: step)
    }

    private var primaryTitle: String {
        switch step {
        case .welcome: return L("onboarding.welcome.start")
        case .permissions: return grants.all ? L("common.continue") : L("onboarding.continueAnyway")
        case .done: return L("onboarding.done.start")
        default: return L("common.continue")
        }
    }

    private func go(_ delta: Int) {
        forward = delta > 0
        // Leaving the language step forwards is saying yes to the language on screen — the
        // system's, if no card was clicked — so it is written as a choice rather than left to
        // follow the system later.
        if step == .appLanguage, delta > 0 {
            controller.setAppLanguage(Localizer.shared.language)
        }
        // Leaving the languages step forwards: the core for those languages, and everything
        // Turkish or Arabic needs if they are on, start downloading in the background while the
        // rest of setup — and dictation — go ahead. Nothing to choose; the sizes were on screen.
        if step == .languages, delta > 0 {
            controller.setLanguages(chosenLanguages)
            controller.models.download(ModelDownloads.Item.wanted(for: chosenLanguages))
        }
        guard let next = Step(rawValue: step.rawValue + delta) else { return }
        withAnimation(Theme.Motion.section) { step = next }
    }

    private func finish() {
        Self.settle(controller.settings, alwaysOn: alwaysOn)
        finished()
        Task {
            await controller.settingsChanged()
            await controller.recheck()
            // A skip from the first page never reached the languages step: the core starts here
            // instead. Already running, it just carries on (`ModelDownloads.download` queues).
            controller.resumeRecommendedDownloads()
        }
    }

    /// What finishing — or skipping — writes.
    ///
    /// `autoDownloadModels` is always written true. It used to be the models step's consent (a
    /// skip, or an unticked Parakeet, wrote false); since 2026-10-02 the core is what every user
    /// gets with no choice to make (owner decision), so finishing setup in any way is the
    /// moment it starts — and every launch after resumes it (`resumeRecommendedDownloads`).
    static func settle(_ settings: AppSettings, alwaysOn: Bool) {
        settings.alwaysOn = alwaysOn
        settings.hasCompletedOnboarding = true
        settings.autoDownloadModels = true
        settings.save()
    }

    // MARK: Pages

    @ViewBuilder
    private func page(_ step: Step) -> some View {
        switch step {
        case .appLanguage: LanguageStep(controller: controller)
        case .welcome: welcome
        case .permissions: permissions
        case .hotkey: hotkey
        case .languages: languages
        case .alwaysOn: alwaysOnPage
        case .done: done
        }
    }

    private var welcome: some View {
        VStack(spacing: Theme.Space.xl) {
            PillView(state: .listening, level: 0.08, style: controller.settings.pillStyle)
                .scaleEffect(1.5)
                .frame(height: 60)
            VStack(spacing: Theme.Space.s) {
                Text(L("onboarding.welcome.title"))
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(Theme.Palette.text)
                    .multilineTextAlignment(.center)
                Text(L("onboarding.welcome.detail"))
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Palette.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(L("onboarding.welcome.time"))
                .font(Theme.Typeface.callout)
                .foregroundStyle(Theme.Palette.tertiary)
        }
    }

    private var permissions: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            StepTitle(title: L("onboarding.permissions.title"),
                      detail: L("onboarding.permissions.detail"))
            Card(padding: Theme.Space.m) {
                PermissionRow(
                    title: L("permission.microphone"), detail: L("onboarding.permissions.microphone"),
                    icon: "mic.fill",
                    granted: grants.microphone,
                    request: { Grants.requestMicrophone() },
                    settingsURL: "x-apple.systempreferences:com.apple.preference.security"
                        + "?Privacy_Microphone")
                Hairline()
                PermissionRow(
                    title: L("permission.inputMonitoring"),
                    detail: L("onboarding.permissions.inputMonitoring"),
                    icon: "keyboard.fill", granted: grants.inputMonitoring,
                    request: { _ = PushToTalkMonitor.requestPermission() },
                    settingsURL: "x-apple.systempreferences:com.apple.preference.security"
                        + "?Privacy_ListenEvent")
                Hairline()
                PermissionRow(
                    title: L("permission.accessibility"),
                    detail: L("onboarding.permissions.accessibility"),
                    icon: "accessibility", granted: grants.accessibility,
                    request: { _ = Accessibility.request() },
                    settingsURL: "x-apple.systempreferences:com.apple.preference.security"
                        + "?Privacy_Accessibility")
            }
            if grants.all {
                StatusDot(text: L("onboarding.permissions.allSet"), tone: .good)
                    .transition(.opacity.combined(with: .scale(scale: 0.95)))
            } else {
                Footnote(L("onboarding.permissions.reopen"))
            }
        }
    }

    private var hotkey: some View {
        VStack(spacing: Theme.Space.xl) {
            StepTitle(title: L("onboarding.hotkey.title"),
                      detail: L("onboarding.hotkey.detail", Names.hotkey(controller.settings)),
                      centred: true)
            HoldDemo(style: controller.settings.pillStyle)
            Footnote(L("onboarding.hotkey.later"))
        }
    }

    private var languages: some View {
        // Scrolls: five switches with their captions are taller than the other steps.
        ScrollView(.vertical, showsIndicators: false) {
            languagesContent
        }
    }

    private var languagesContent: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            StepTitle(title: L("onboarding.languages.title"),
                      detail: L("onboarding.languages.detail"))
            Card {
                LanguageSwitches(on: chosenLanguages, order: controller.languageOrder.order,
                                 detail: { OptionalLanguageCaption.text($0, on: chosenLanguages,
                                                                       models: controller.models) }) {
                    language, on in
                    withAnimation(Theme.Motion.smooth) {
                        chosenLanguages = chosenLanguages.setting(language, on: on)
                    }
                }
            }
            Footnote(L("languages.yours.hint"))
        }
        .task { await controller.models.refresh() }
    }

    private var alwaysOnPage: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            StepTitle(title: L("onboarding.alwaysOn.title"),
                      detail: L("onboarding.alwaysOn.detail"))
            Card {
                HStack(alignment: .top, spacing: Theme.Space.m) {
                    Image(systemName: "infinity")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Theme.Palette.accent)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(L("settings.alwaysOn"))
                                .font(Theme.Typeface.headline)
                                .foregroundStyle(Theme.Palette.text)
                            Badge(text: L("common.recommended").uppercased(with: Localizer.shared.locale),
                                  tint: Theme.Palette.accent, filled: true)
                        }
                        Text(L("onboarding.alwaysOn.card"))
                            .font(Theme.Typeface.callout)
                            .foregroundStyle(Theme.Palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    Toggle("", isOn: $alwaysOn).labelsHidden().toggleStyle(KotibaSwitchStyle())
                }
            }
        }
    }

    private var done: some View {
        VStack(spacing: Theme.Space.xl) {
            CheckMark()
                .frame(width: 64, height: 64)
                .shadow(color: Theme.Palette.accentGlow, radius: 20)
            VStack(spacing: Theme.Space.s) {
                Text(L("onboarding.done.title"))
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(Theme.Palette.text)
                HStack(spacing: 6) {
                    Text(L("home.hero.hold"))
                    Keycap(label: Names.hotkey(controller.settings))
                    Text(L("onboarding.done.detail"))
                }
                .font(.system(size: 14))
                .foregroundStyle(Theme.Palette.secondary)
            }
            // The core, still coming: one calm bar, not a list. Hidden once it is all here.
            CoreReadyCard(controller: controller)
        }
    }
}

// MARK: - Pieces

private struct StepTitle: View {
    let title: String
    let detail: String
    var centred = false

    var body: some View {
        VStack(alignment: centred ? .center : .leading, spacing: Theme.Space.s) {
            Text(title)
                .font(.system(size: 26, weight: .bold))
                .foregroundStyle(Theme.Palette.text)
            Text(detail)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Palette.secondary)
                .multilineTextAlignment(centred ? .center : .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: centred ? .center : .leading)
    }
}

private struct PermissionRow: View {
    let title: String
    let detail: String
    let icon: String
    let granted: Bool
    let request: () -> Void
    let settingsURL: String

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(granted ? Theme.Palette.accentInk : Theme.Palette.accent)
                .frame(width: 32, height: 32)
                .background(granted ? Theme.Palette.accent : Theme.Palette.accentSoft,
                            in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Theme.Typeface.body.weight(.semibold))
                    .foregroundStyle(Theme.Palette.text)
                Text(detail)
                    .font(Theme.Typeface.caption)
                    .foregroundStyle(Theme.Palette.secondary)
            }
            Spacer(minLength: Theme.Space.s)
            if granted {
                StatusDot(text: L("onboarding.permissions.allowed"), tone: .good)
                    .transition(.scale.combined(with: .opacity))
            } else {
                Button(L("onboarding.permissions.allow")) {
                    request()
                    #if os(macOS)
                    if let url = URL(string: settingsURL) { NSWorkspace.shared.open(url) }
                    #endif
                }
                .buttonStyle(.kotibaPrimary)
                .help(L("onboarding.permissions.allow.help"))
                .transition(.scale.combined(with: .opacity))
            }
        }
        .padding(.vertical, 2)
        .animation(Theme.Motion.pop, value: granted)
    }
}

/// The key going down, the pill listening, the key coming up, the check — on a loop.
private struct HoldDemo: View {
    let style: PillAnimationStyle

    var body: some View {
        PhaseAnimator([0, 1, 2, 3]) { phase in
            HStack(spacing: Theme.Space.xl) {
                Keycap(label: "⌘", large: true)
                    .scaleEffect(phase == 1 ? 0.92 : 1)
                    .offset(y: phase == 1 ? 3 : 0)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Theme.Palette.accent.opacity(phase == 1 ? 0.8 : 0),
                                          lineWidth: 1.5))
                Image(systemName: "arrow.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Palette.tertiary)
                PillView(state: phase == 1 ? .listening
                         : phase == 2 ? .processing
                         : phase == 3 ? .success(millis: 180) : .hidden,
                         level: phase == 1 ? 0.12 : 0,
                         style: style,
                         visible: phase != 0)
                    .frame(width: PillView.width, height: 50)
            }
        } animation: { phase in
            switch phase {
            case 1: return Theme.Motion.pop.delay(0.5)
            case 2: return Theme.Motion.morph.delay(1.8)
            case 3: return Theme.Motion.morph.delay(0.7)
            default: return Theme.Motion.smooth.delay(1.2)
            }
        }
        .frame(height: 80)
    }
}

// MARK: - Live grants

struct Grants: Equatable {
    var microphone: Bool
    var inputMonitoring: Bool
    var accessibility: Bool

    var all: Bool { microphone && inputMonitoring && accessibility }

    static var current: Grants {
        #if os(macOS)
        Grants(microphone: AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
               inputMonitoring: PushToTalkMonitor.isPermitted,
               accessibility: Accessibility.isTrusted)
        #else
        Grants(microphone: true, inputMonitoring: true, accessibility: true)
        #endif
    }

    static func requestMicrophone() {
        #if os(macOS)
        AVCaptureDevice.requestAccess(for: .audio) { _ in }
        #endif
    }
}
