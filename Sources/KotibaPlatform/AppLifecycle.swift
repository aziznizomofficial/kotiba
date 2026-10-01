#if os(macOS)
import AppKit
import Observation
import ServiceManagement

// Always-on, launch at login, and what "Quit" means.
//
// The owner's words: when always-on is on, quitting just closes the window and hides the Dock
// icon; the menu-bar icon persists and works; it survives logout, crash and reboot; the app only
// truly exits when the toggle is switched off inside the app.
//
// Mechanism, and why:
//
//   * **A launchd agent registered with `SMAppService.agent`**, plist bundled at
//     `Contents/Library/LaunchAgents/uz.kotiba.app.agent.plist`: `RunAtLoad` (login and reboot)
//     plus `KeepAlive {SuccessfulExit = false}` — launchd relaunches after a crash or a Force Quit
//     (both end in a signal) and leaves a deliberate `exit(0)` alone. `KeepAlive = true` would
//     relaunch after the real quit too, and the toggle could never be switched off by quitting.
//   * **Only one registration at a time.** `SMAppService.mainApp` (the plain login item) and an
//     agent with `RunAtLoad` would launch two copies at every login. Always-on implies launch at
//     login, so with it on the login item is unregistered.
//   * **launchd only supervises the copy it started.** Switching always-on on in a copy the user
//     opened from Finder registers the agent, launchd immediately starts its own copy, and that
//     copy asks the older one to hand over (`handoverRequest`) — otherwise the running copy would
//     go unsupervised until the next login, and a crash in that window would not come back.
//   * **Unregistering the agent from inside the agent's own process** is deferred to termination:
//     launchd stops a job whose registration is removed, and switching a toggle off must not kill
//     the app it is displayed in.
//   * **Logout, restart and shutdown always quit.** Refusing the system's quit event would hold
//     up the user's logout; the agent brings Kotiba back at the next login anyway.

/// Posted when something outside the SwiftUI scene wants the main window shown — first run, a
/// Dock click, a second launch. The scene opens `Window(id: "main")` on it.
public extension Notification.Name {
    static let kotibaShowMainWindow = Notification.Name("uz.kotiba.showMainWindow")
}

@MainActor
@Observable
public final class AppLifecycle {

    public static let shared = AppLifecycle()

    /// Must match `Label` in the bundled plist and the plist's file name.
    public static let agentLabel = "uz.kotiba.app.agent"
    static let agentPlist = "uz.kotiba.app.agent.plist"
    /// Asked by an agent-launched copy of the copy it is replacing.
    static let handoverRequest = Notification.Name("uz.kotiba.app.handover")

    /// The state the settings pane shows, in words when something needs the user.
    public enum Registration: Equatable, Sendable {
        case off
        case on
        /// macOS wants the user to allow it: System Settings › General › Login Items.
        case needsApproval
        case failed(String)
    }

    public private(set) var alwaysOnRegistration: Registration = .off
    public private(set) var loginItemRegistration: Registration = .off

    /// Set by the one action that is allowed to really quit while always-on is on, and by the
    /// system's own logout, restart and shutdown.
    public private(set) var allowsTermination = false
    /// This process is the one launchd started for the agent.
    public let isAgentInstance: Bool
    /// Unregister the agent at termination rather than now. See the header.
    private var unregisterAgentOnExit = false

    private var agent: SMAppService { SMAppService.agent(plistName: Self.agentPlist) }

    private init() {
        isAgentInstance = ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] == Self.agentLabel
        refresh()
    }

    // MARK: Registration

    /// Make the registrations match the two settings. Idempotent; call at launch and on change.
    public func apply(alwaysOn: Bool, launchAtLogin: Bool) {
        lastError = nil
        wanted = (alwaysOn, launchAtLogin)
        if alwaysOn {
            register(agent)
            unregister(SMAppService.mainApp)
            unregisterAgentOnExit = false
        } else {
            if agent.status == .enabled || agent.status == .requiresApproval {
                if isAgentInstance { unregisterAgentOnExit = true } else { unregister(agent) }
            }
            if launchAtLogin { register(SMAppService.mainApp) } else { unregister(SMAppService.mainApp) }
        }
        refresh()
    }

    /// Re-read what macOS says. There is no change notification for these, so the app calls this
    /// when it becomes active — the user may have just flipped the switch in Login Items.
    public func refresh() {
        alwaysOnRegistration = Self.describe(agent.status)
        loginItemRegistration = Self.describe(SMAppService.mainApp.status)
        // A registration that was asked for, threw, and left nothing behind is a failure the
        // pane must show — not a quiet "off" under a switch the user just turned on.
        if let lastError {
            if wanted.alwaysOn, alwaysOnRegistration == .off { alwaysOnRegistration = .failed(lastError) }
            if wanted.login, !wanted.alwaysOn, loginItemRegistration == .off {
                loginItemRegistration = .failed(lastError)
            }
        }
    }

    private var wanted: (alwaysOn: Bool, login: Bool) = (false, false)

    public func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    private func register(_ service: SMAppService) {
        guard service.status != .enabled else { return }
        do { try service.register() } catch {
            // `register` throws for "needs approval" too, and the status says which it was.
            if service.status != .requiresApproval {
                lastError = "\(error.localizedDescription)"
            }
        }
    }

    private func unregister(_ service: SMAppService) {
        guard service.status == .enabled || service.status == .requiresApproval else { return }
        try? service.unregister()
    }

    private var lastError: String?

    static func describe(_ status: SMAppService.Status) -> Registration {
        switch status {
        case .enabled: return .on
        case .requiresApproval: return .needsApproval
        case .notRegistered: return .off
        case .notFound:
            return .failed("the launch agent is missing from the app bundle — this build was not "
                           + "made by `make app`")
        @unknown default: return .failed("macOS reported an unknown login-item status")
        }
    }

    // MARK: Quitting

    /// Quit for real, whatever always-on says. The only exit from an always-on Kotiba that the
    /// user can take, and it takes the toggle with it — "Turn off always-on & quit".
    public func quitForReal(turningOffAlwaysOn settingsWrite: () -> Void) {
        settingsWrite()
        // The registration follows the setting here, synchronously. The app's observer of
        // `alwaysOn` re-applies from a `Task`, and `terminate` below never returns to run it: the
        // agent stayed registered, `willTerminate` had nothing deferred to carry out, and launchd
        // started Kotiba again at the next login — after the one action that promises it will not.
        // In launchd's own copy this defers the unregistration to `willTerminate`, as ever.
        //
        // No login item either, whatever `launchAtLogin` says: both places that offer this quit
        // promise that Kotiba "starts again only when you open it". Opening it re-applies the
        // user's own setting.
        apply(alwaysOn: false, launchAtLogin: false)
        allowsTermination = true
        NSApplication.shared.terminate(nil)
    }

    /// For termination paths that are not the user's choice: a duplicate copy stepping aside, a
    /// handover to launchd's copy.
    public func permitTermination() { allowsTermination = true }

    /// Whether the quit event being handled right now is the system logging out, restarting or
    /// shutting down — which always wins.
    public var isSystemQuit: Bool {
        if systemIsPoweringOff { return true }
        guard let event = NSAppleEventManager.shared().currentAppleEvent,
              let reason = event.attributeDescriptor(forKeyword: kAEQuitReason)?.enumCodeValue
        else { return false }
        return [kAELogOut, kAEReallyLogOut, kAEShowRestartDialog, kAEShowShutdownDialog,
                kAERestart, kAEShutDown].map { OSType($0) }.contains(reason)
    }

    private var systemIsPoweringOff = false
    private var steppingAside = false

    /// Watch for logout/restart/shutdown, which must never be refused.
    public func watchForPowerOff() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { AppLifecycle.shared.systemIsPoweringOff = true }
        }
    }

    /// The last thing before `_exit`: carry out a deferred unregistration.
    public func willTerminate() {
        if unregisterAgentOnExit { try? agent.unregister() }
    }

    // MARK: Handover to launchd's copy

    /// In the copy launchd just started: ask the older copy to step aside, and wait for it.
    /// Returns true once this is the only copy; false if the older one would not go.
    public func takeOverFromOlderCopy(timeout: Duration = stepAsidePatience + .seconds(60))
        async -> Bool {
        DistributedNotificationCenter.default().postNotificationName(
            Self.handoverRequest, object: nil, userInfo: nil, deliverImmediately: true)
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if SingleInstance.others.isEmpty { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return SingleInstance.others.isEmpty
    }

    /// How long a copy asked to step aside waits for its work to finish before going anyway.
    ///
    /// Not half a minute, which it was: the handover happens on the first run, the moment the
    /// onboarding's "Start dictating" switches always-on on — and the onboarding has just started
    /// fetching up to ~2.5 GB of models in this copy. Stepping aside at once killed every one of
    /// them, and launchd's copy never restarts a download it did not start, so a new user was
    /// left with no Uzbek model and no modes model. The wait now covers downloads as well as
    /// dictations (`isBusy`), and the new copy waits correspondingly longer; meanwhile this copy
    /// keeps serving the hotkey, so nothing is unavailable while it waits.
    public static let stepAsidePatience: Duration = .seconds(30 * 60)

    /// In a copy that launchd did not start: step aside when launchd's copy asks, once nothing is
    /// in flight — no dictation, no model download. `isBusy` is asked until it says no, for up
    /// to `stepAsidePatience`.
    public func honourHandoverRequests(isBusy: @escaping @MainActor @Sendable () -> Bool) {
        guard !isAgentInstance else { return }
        DistributedNotificationCenter.default().addObserver(
            forName: Self.handoverRequest, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in await AppLifecycle.shared.stepAside(isBusy: isBusy) }
        }
    }

    private func stepAside(isBusy: @MainActor @Sendable () -> Bool) async {
        guard !steppingAside else { return }     // launchd's copy may ask more than once
        steppingAside = true
        let deadline = ContinuousClock.now + Self.stepAsidePatience
        while isBusy(), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(250))
        }
        NSLog("Kotiba: launchd's always-on copy has started — handing over to it")
        permitTermination()
        NSApplication.shared.terminate(nil)
    }
}

// MARK: - Activation policy

/// Dock icon and ⌘-Tab while the main window is open; menu bar only while it is not.
///
/// The app is `LSUIElement` so it launches without a Dock icon. A menu-bar app whose settings
/// window has no Dock icon cannot be ⌘-Tabbed to and keeps losing its window behind others;
/// one with a permanent Dock icon is not a menu-bar app. So the policy follows the window.
@MainActor
public enum ActivationPolicy {

    /// Whether any real window is on screen — not the HUD panel, not the menu-bar extra's.
    public static var hasVisibleMainWindow: Bool {
        NSApplication.shared.windows.contains(where: isMainWindow)
    }

    static func isMainWindow(_ window: NSWindow) -> Bool {
        window.isVisible && !(window is NSPanel) && window.styleMask.contains(.titled)
            && window.canBecomeMain
    }

    /// Bring the policy in line with the windows. Called whenever a window opens or closes.
    public static func update() {
        let wanted: NSApplication.ActivationPolicy = hasVisibleMainWindow ? .regular : .accessory
        guard NSApplication.shared.activationPolicy() != wanted else { return }
        NSApplication.shared.setActivationPolicy(wanted)
        if wanted == .regular { NSApplication.shared.activate() }
    }

    /// Close every real window and drop back to the menu bar — what Quit means when always-on.
    public static func closeWindowsAndHide() {
        for window in NSApplication.shared.windows where isMainWindow(window) {
            window.close()
        }
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    /// Ask the scene to show the main window, and make sure it can come to the front.
    public static func showMainWindow() {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate()
        NotificationCenter.default.post(name: .kotibaShowMainWindow, object: nil)
    }
}
#endif
