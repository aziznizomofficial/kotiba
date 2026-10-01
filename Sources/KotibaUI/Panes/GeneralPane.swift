import KotibaCore
import KotibaPlatform
import SwiftUI

#if os(macOS)
import AppKit
#endif

// Settings: how Kotiba lives on this Mac. Ported from the old General tab (sounds, the silence
// threshold, the permissions list — also on Home), the History tab's "Keep history", and the
// Diagnostics tab whole (the switch, the summary, Refresh, Reveal folder). New: Always-on, launch
// at login, ducking, history retention, "run setup again".
//
// Always-on, ducking and the Bluetooth microphone preference are *settings* here and *behaviour*
// in the platform slice: this pane writes `AppSettings` and nothing else.

struct GeneralPane: View {
    let controller: DictationController
    @Bindable private var settings: AppSettings
    @State private var summary = ""
    @State private var showDiagnostics = false

    init(controller: DictationController) {
        self.controller = controller
        self.settings = controller.settings
    }

    var body: some View {
        Pane(title: L("section.settings")) {
            // First, because someone who cannot read the rest of the page needs to find it.
            // Each option is written in its own language; a click switches every word at once.
            Card(title: L("settings.appLanguage.title"),
                 subtitle: L("settings.appLanguage.detail"), systemImage: "globe") {
                LanguageList(controller: controller)
            }

            // How the pill moves while you talk — the three the owner kept, each shown moving.
            Card(title: L("settings.pill.title"),
                 subtitle: L("settings.pill.detail"), systemImage: "waveform") {
                PillStylePicker(controller: controller)
            }

            // Behaviour lives in `AppLifecycle` and the app delegate, which register exactly one
            // launch path: the launchd agent for Always on, `SMAppService.mainApp` for Open at
            // login, never both (both would start two copies at login). This card writes the two
            // settings and shows what macOS made of them.
            Card(title: L("settings.alwaysThere"), systemImage: "infinity") {
                ToggleRow(title: L("settings.alwaysOn"),
                          detail: L("settings.alwaysOn.detail"),
                          isOn: settings.bound(\.alwaysOn))
                #if os(macOS)
                registrationNote(lifecycle.alwaysOnRegistration, wanted: settings.alwaysOn)
                #endif
                Hairline()
                SettingRow(title: L("settings.openAtLogin"),
                           detail: settings.alwaysOn ? L("settings.openAtLogin.included")
                               : L("settings.openAtLogin.detail")) {
                    Toggle("", isOn: Binding(
                        get: { settings.alwaysOn || settings.launchAtLogin },
                        set: { settings.bound(\.launchAtLogin).wrappedValue = $0 }))
                        .labelsHidden()
                        .toggleStyle(KotibaSwitchStyle())
                        .disabled(settings.alwaysOn)
                }
                #if os(macOS)
                if !settings.alwaysOn {
                    registrationNote(lifecycle.loginItemRegistration, wanted: settings.launchAtLogin)
                }
                if settings.alwaysOn {
                    Hairline()
                    SettingRow(title: L("settings.quitForReal"),
                               detail: L("settings.quitForReal.detail")) {
                        Button(L("settings.quitForReal.button")) {
                            lifecycle.quitForReal {
                                settings.alwaysOn = false
                                settings.save()
                            }
                        }
                        .buttonStyle(.kotibaDestructive)
                    }
                }
                #endif
            }
            #if os(macOS)
            .onAppear { lifecycle.refresh() }
            #endif

            Card(title: L("settings.sound"), systemImage: "speaker.wave.2.fill") {
                ToggleRow(title: L("settings.sound.feedback"),
                          isOn: settings.bound(\.soundFeedback))
                Hairline()
                ToggleRow(title: L("settings.ducking"),
                          detail: L("settings.ducking.detail"),
                          isOn: settings.bound(\.duckingEnabled))
                if settings.duckingEnabled {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(L("settings.ducking.lowerTo"))
                                .font(Theme.Typeface.callout)
                                .foregroundStyle(Theme.Palette.secondary)
                            Spacer()
                            Text((settings.duckLevel).formatted(.percent.precision(.fractionLength(0))
                                .locale(Localizer.shared.locale)))
                                .font(Theme.Typeface.callout.monospacedDigit())
                                .foregroundStyle(Theme.Palette.accent)
                                .contentTransition(.numericText())
                        }
                        // Rounded in the binding, not with `step:` — a stepped Slider on macOS
                        // draws a tick per step, and sixteen ticks are noise.
                        Slider(value: Binding(get: { settings.duckLevel },
                                              set: {
                                                  settings.duckLevel = ($0 * 20).rounded() / 20
                                                  settings.save()
                                              }),
                               in: 0...0.8)
                            .tint(Theme.Palette.accent)
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
                Hairline()
                ToggleRow(title: L("settings.builtInMic"),
                          detail: L("settings.builtInMic.detail"),
                          isOn: settings.bound(\.preferBuiltInMicWithBluetooth))
            }
            .animation(Theme.Motion.smooth, value: settings.duckingEnabled)

            Card(title: L("permission.microphone"), systemImage: "mic.fill") {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(L("settings.silence"))
                            .font(Theme.Typeface.body)
                            .foregroundStyle(Theme.Palette.text)
                        Spacer()
                        Text(String(format: "%.3f", settings.silenceThreshold))
                            .font(Theme.Typeface.callout.monospacedDigit())
                            .foregroundStyle(Theme.Palette.accent)
                    }
                    Slider(value: Binding(get: { Double(settings.silenceThreshold) },
                                          set: {
                                              settings.silenceThreshold = Float($0)
                                              settings.save()
                                          }),
                           in: 0.001...0.1)
                        .tint(Theme.Palette.accent)
                    Footnote(L("settings.silence.detail"))
                }
            }

            Card(title: L("section.history"), systemImage: "clock.fill") {
                ToggleRow(title: L("settings.keepHistory"),
                          detail: L("settings.keepHistory.detail"),
                          isOn: settings.bound(\.keepHistory))
                Hairline()
                SettingRow(title: L("settings.keep"), detail: L("settings.keep.detail")) {
                    MenuPicker(selection: settings.bound(\.historyLimit),
                               options: [(0, L("settings.keep.everything")),
                                         (100, L("settings.keep.last", Names.count(100))),
                                         (1000, L("settings.keep.last", Names.count(1000))),
                                         (10_000, L("settings.keep.last", Names.count(10_000)))])
                }
                .disabled(!settings.keepHistory)
                .opacity(settings.keepHistory ? 1 : 0.5)
            }

            Card(title: L("settings.permissions"), systemImage: "lock.shield.fill") {
                if controller.blockers.isEmpty {
                    StatusDot(text: L("settings.permissions.allGranted"), tone: .good)
                } else {
                    ForEach(controller.blockers) { blocker in
                        BlockerRow(blocker: blocker) { controller.requestMissingPermissions() }
                    }
                    HStack {
                        Spacer()
                        Button(L("home.blockers.checkAgain")) { Task { await controller.recheck() } }
                            .buttonStyle(.kotiba)
                    }
                }
            }

            Card(title: L("settings.diagnostics"), systemImage: "stethoscope") {
                ToggleRow(title: L("settings.diagnostics.record"),
                          detail: L("settings.diagnostics.record.detail"),
                          isOn: settings.bound(\.diagnosticsEnabled))
                HStack(spacing: Theme.Space.s) {
                    Button(showDiagnostics ? L("settings.diagnostics.hide") : L("settings.diagnostics.show")) {
                        withAnimation(Theme.Motion.smooth) { showDiagnostics.toggle() }
                        if showDiagnostics { Task { await load() } }
                    }
                    .buttonStyle(.kotibaSmall)
                    if showDiagnostics {
                        Button(L("common.refresh")) { Task { await load() } }
                            .buttonStyle(.kotibaSmall)
                    }
                    #if os(macOS)
                    Button(L("settings.diagnostics.reveal")) {
                        NSWorkspace.shared.selectFile(nil,
                            inFileViewerRootedAtPath: AppSettings.supportDirectory.path)
                    }
                    .buttonStyle(.kotibaSmall)
                    #endif
                    Spacer()
                }
                if showDiagnostics {
                    ScrollView {
                        Text(summary.isEmpty ? L("common.loading") : summary)
                            .font(Theme.Typeface.mono)
                            .foregroundStyle(Theme.Palette.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(Theme.Space.m)
                    }
                    .frame(height: 220)
                    .background(Theme.Palette.background,
                                in: RoundedRectangle(cornerRadius: Theme.Radius.control,
                                                     style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                        .strokeBorder(Theme.Palette.hairline, lineWidth: 1))
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }

            Card(title: L("settings.setup"), systemImage: "sparkles") {
                SettingRow(title: L("settings.setup.again"),
                           detail: L("settings.setup.again.detail")) {
                    Button(L("settings.setup.start")) {
                        withAnimation(Theme.Motion.smooth) {
                            settings.hasCompletedOnboarding = false
                        }
                        settings.save()
                    }
                    .buttonStyle(.kotiba)
                }
            }

            AboutCard()
        }
    }

    private func load() async {
        summary = await controller.diagnosticsSummary()
    }

    #if os(macOS)
    private var lifecycle: AppLifecycle { AppLifecycle.shared }

    /// What macOS did with a registration, when it needs the user: approval in Login Items, or a
    /// failure worth reading. Nothing when all is well.
    @ViewBuilder
    private func registrationNote(_ registration: AppLifecycle.Registration,
                                  wanted: Bool) -> some View {
        switch registration {
        case .needsApproval where wanted:
            HStack(alignment: .firstTextBaseline) {
                Footnote(L("settings.loginItems.needsApproval"), tint: Theme.Palette.amber)
                Spacer()
                Button(L("settings.loginItems.open")) { lifecycle.openLoginItemsSettings() }
                    .buttonStyle(.kotibaSmall)
            }
        case .failed(let why) where wanted:
            Footnote(L("settings.loginItems.failed", why), tint: Theme.Palette.danger)
        default:
            EmptyView()
        }
    }
    #endif
}
