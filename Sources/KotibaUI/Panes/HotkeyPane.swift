import KotibaPlatform
import SwiftUI

#if os(macOS)
import AppKit
#endif

// The Hotkey pane: which key you hold.
//
// Everything it changes goes through `settings.bound`, so it persists on write, and the app shell
// watches `settings.hotkey` and swaps the event tap itself (`AppDelegate.watchHotkeySetting`):
// nothing here reaches into the tap. What happens to the room while the key is held — ducking,
// the Bluetooth microphone — is on the Settings page, next to the other sound settings.

public struct HotkeyPane: View {

    @Bindable private var settings: AppSettings
    private let controller: DictationController

    @State private var recording = false
    @State private var recorder = HotkeyRecorder()
    @State private var message: String?
    #if os(macOS)
    @State private var eventMonitor: Any?
    #endif

    public init(controller: DictationController) {
        self.controller = controller
        self.settings = controller.settings
    }

    public var body: some View {
        Pane(title: L("section.hotkey"), subtitle: L("hotkey.subtitle")) {
            Card {
                VStack(spacing: Theme.Space.l) {
                    HStack(spacing: Theme.Space.m) {
                        if recording {
                            Keycap(label: "…", large: true)
                        } else {
                            ForEach(Names.keycapLabels(settings.hotkey), id: \.self) {
                                Keycap(label: $0, large: true)
                            }
                        }
                    }
                    .animation(Theme.Motion.smooth, value: settings.hotkey)
                    Text(recording ? L("hotkey.pressKey") : L("hotkey.hold", Names.hotkey(settings)))
                        .font(Theme.Typeface.title)
                        .foregroundStyle(Theme.Palette.text)
                    Text(recording ? L("hotkey.recording.detail") : L("hotkey.detail"))
                        .font(Theme.Typeface.callout)
                        .foregroundStyle(Theme.Palette.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(recording ? L("common.cancel") : L("hotkey.record")) {
                        recording ? stopRecording(nil) : startRecording()
                    }
                    .buttonStyle(recording ? .kotiba : .kotibaPrimary)
                    if let message {
                        Footnote(message, tint: Theme.Palette.amber)
                            .multilineTextAlignment(.center)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Space.xl)
            }

            Card(title: L("hotkey.presets"), systemImage: "keyboard") {
                ForEach(Array(HotkeySpec.presets.enumerated()), id: \.element) { index, spec in
                    if index > 0 { Hairline() }
                    Button {
                        choose(spec)
                    } label: {
                        HStack(spacing: Theme.Space.s) {
                            ForEach(Names.keycapLabels(spec), id: \.self) { Keycap(label: $0) }
                            Text(Names.hotkeyName(spec))
                                .font(Theme.Typeface.body)
                                .foregroundStyle(Theme.Palette.text)
                            Spacer()
                            if spec == settings.hotkey {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundStyle(Theme.Palette.accent)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }

            if !settings.hotkey.warnings.isEmpty {
                Card(title: L("hotkey.headsUp"), systemImage: "exclamationmark.triangle.fill") {
                    ForEach(Names.hotkeyWarnings(settings.hotkey), id: \.self) { warning in
                        Footnote(warning, tint: Theme.Palette.amber)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            Card(title: L("hotkey.shortcuts"), systemImage: "command") {
                Footnote(L("hotkey.shortcuts.detail"))
            }
        }
        .animation(Theme.Motion.smooth, value: settings.hotkey.warnings)
        .onDisappear { stopRecording(nil) }
        #if os(macOS)
        // Recording suspends the live hotkey, and the local monitor that ends it only hears keys
        // while Kotiba is frontmost. Clicking into another app mid-recording used to leave the
        // hotkey dead in every app — the pane is still on screen, so `onDisappear` never ran —
        // until the user came back and pressed Escape. Leaving the app cancels the recording.
        .onReceive(NotificationCenter.default.publisher(
            for: NSApplication.didResignActiveNotification)) { _ in
            if recording { stopRecording(nil) }
        }
        #endif
    }

    private func choose(_ spec: HotkeySpec) {
        message = nil
        settings.bound(\.hotkey).wrappedValue = spec
    }

    // MARK: Recording

    private func startRecording() {
        message = nil
        recorder = HotkeyRecorder()
        recording = true
        #if os(macOS)
        // The live hotkey would otherwise start a dictation the moment the user presses the key
        // they are trying to record.
        PushToTalkMonitor.isSuspended = true
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown]) {
            event in
            let result: HotkeyRecorder.Result
            if event.type == .flagsChanged {
                let code = event.keyCode
                result = recorder.modifier(code, isDown: Self.isDown(code, flags: event.modifierFlags))
            } else {
                guard !event.isARepeat else { return nil }
                result = recorder.key(event.keyCode)
            }
            switch result {
            case .recording: break
            case .recorded(let spec): stopRecording(spec)
            case .cancelled: stopRecording(nil)
            case .rejected(let why): message = Names.hotkeyRejection(why)
            }
            return nil                          // nothing typed into the window while recording
        }
        #endif
    }

    private func stopRecording(_ spec: HotkeySpec?) {
        #if os(macOS)
        if let eventMonitor { NSEvent.removeMonitor(eventMonitor) }
        eventMonitor = nil
        PushToTalkMonitor.isSuspended = false
        #endif
        recording = false
        if let spec { choose(spec) }
    }

    #if os(macOS)
    /// Whether the modifier `code` is down after this `flagsChanged`. The event says which key
    /// changed but not in which direction; the family flag answers it (fn has its own).
    static func isDown(_ code: UInt16, flags: NSEvent.ModifierFlags) -> Bool {
        switch code {
        case HotkeySpec.Code.leftCommand, HotkeySpec.Code.rightCommand: return flags.contains(.command)
        case HotkeySpec.Code.leftOption, HotkeySpec.Code.rightOption: return flags.contains(.option)
        case HotkeySpec.Code.leftControl, HotkeySpec.Code.rightControl: return flags.contains(.control)
        case HotkeySpec.Code.leftShift, HotkeySpec.Code.rightShift: return flags.contains(.shift)
        case HotkeySpec.Code.function: return flags.contains(.function)
        default: return false
        }
    }
    #endif
}
