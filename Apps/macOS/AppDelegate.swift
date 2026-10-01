import AppKit
import KotibaAudio
import KotibaCore
import KotibaPlatform
import KotibaUI

// MARK: - The delegate

/// Owns what SwiftUI cannot express: a global event tap, a window that shows without taking
/// focus, the output ducker, and the app's lifecycle — what Quit means, whether there is a Dock
/// icon, and whether launchd brings it back.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    private var monitor: PushToTalkMonitor?
    private var hud: HUDPanel?
    private var controller: DictationController?
    private var hideTask: Task<Void, Never>?
    /// Polls for permissions granted while the app is running. See applicationDidFinishLaunching.
    private var recovery: Timer?
    private var lifecycle: AppLifecycle { AppLifecycle.shared }

    func applicationDidFinishLaunching(_ notification: Notification) {
        lifecycle.watchForPowerOff()

        // Before anything with a side effect. A second copy means two event taps on right-⌘,
        // two microphones opened per press, two writers to one SQLite history and two racing
        // pastes — and it happens easily, because a build left in DerivedData carries the same
        // bundle id and launching a binary directly bypasses LaunchServices' own check.
        if case .duplicate(let existing) = SingleInstance.claim() {
            // The one exception: this is launchd's always-on copy, started because the user
            // just switched always-on on in a copy launchd did not start. launchd only brings
            // back the copy it owns, so that one should be the survivor — ask the older copy to
            // step aside, then carry on. See `AppLifecycle`.
            if lifecycle.isAgentInstance {
                Task {
                    if await lifecycle.takeOverFromOlderCopy() {
                        finishLaunching()
                    } else {
                        quitAsDuplicate(of: existing)
                    }
                }
                return
            }
            quitAsDuplicate(of: existing)
            return
        }
        finishLaunching()
    }

    /// Terminate immediately, and *never* behind a modal. The first attempt at this put up an
    /// NSAlert, which blocks: the duplicate then sat there holding a second menu-bar icon, waiting
    /// for a click that — for a copy launched by accident or by a build script — nobody was ever
    /// going to make. That is worse than the problem.
    ///
    /// Exits 0, which is what keeps two KeepAlive agents from fighting: launchd relaunches only
    /// a copy that died, and a copy that stepped aside did not. The original is brought to the
    /// front so the user sees something happen.
    private func quitAsDuplicate(of existing: String) {
        NSLog("Kotiba: another copy is already running from %@ — quitting this one", existing)
        SingleInstance.activateExisting()
        lifecycle.permitTermination()
        NSApplication.shared.terminate(nil)
    }

    private func finishLaunching() {
        // The controller SwiftUI made is not reachable from here, so the delegate makes its own
        // and hands it over. `AppState.shared` is the seam; see below.
        let controller = AppState.shared.controller
        self.controller = controller

        // Before the first press: a crash or force-quit mid-hold left someone's music ducked,
        // and this is the first moment anything can put it back.
        controller.installDucking(PlaybackDucking(markerDirectory: AppSettings.supportDirectory))

        hud = HUDPanel(controller: controller)
        Task {
            await controller.start()
            controller.resumeRecommendedDownloads()
        }

        // Ask for BOTH before installing anything. The tap silently never fires without
        // Input Monitoring, and a hotkey that does nothing with no explanation is the worst
        // possible first impression — but Accessibility was the one only ever *checked*, so
        // Kotiba never appeared in that list and there was nothing there to switch on.
        controller.requestMissingPermissions()

        startMonitor()
        watchHotkeySetting()
        watchLifecycleSettings()
        // Busy is a dictation *or* a model download: launchd's copy asks for the handover at the
        // end of the onboarding, while its downloads are still running here. See
        // `AppLifecycle.stepAsidePatience`.
        lifecycle.honourHandoverRequests { [weak self] in
            guard let controller = self?.controller else { return false }
            return controller.isRunning || controller.models.running
                || controller.downloading != nil
        }

        // A menu-bar app with no windows may go a long time without becoming active, so the
        // recovery paths cannot hang off that notification alone. This timer is what makes
        // "grant the permission while Kotiba is running" work without a relaunch; it stops as
        // soon as there is nothing left to recover.
        recovery = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] timer in
            Task { @MainActor in
                guard let self else { timer.invalidate(); return }
                self.retryMonitorIfNeeded()
                // Stop on what this timer can actually recover — the two permissions. It used to
                // also require `controller.blockers.isEmpty`, but that list carries configuration
                // facts no amount of polling can change: a default install has no Uzbek model, so
                // the blocker is permanent and `invalidate()` was unreachable. The timer then woke
                // the run loop every 5 seconds for the whole process lifetime, and only ever shut
                // itself off for users whose setup was already complete.
                if self.monitor != nil, Accessibility.isTrusted, PushToTalkMonitor.isPermitted {
                    timer.invalidate()
                    self.recovery = nil
                }
            }
        }

        // Every foreground, not once. A single warm-up at launch is how the predecessor
        // disabled its own microphone for a process lifetime.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in
                // recheck(), not refreshBlockers(): warm-up has to be re-attempted, or a
                // microphone that failed once stays failed for the life of the process.
                await controller.recheck()
                self.retryMonitorIfNeeded()
                // Login Items has no change notification; the user may have just approved it.
                self.lifecycle.refresh()
            }
        }

        // Dock icon while a real window is open, none while it is not.
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didBecomeMainNotification,
                     NSWindow.willCloseNotification, NSWindow.didMiniaturizeNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                // After this turn: a closing window is still visible while it says so.
                DispatchQueue.main.async { MainActor.assumeIsolated { ActivationPolicy.update() } }
            }
        }

        // Hidden at launch — it is a menu-bar app — except on the very first run, when there is
        // an onboarding to go through and nothing else would show the user the app exists.
        if controller.settings.hasCompletedOnboarding {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    ActivationPolicy.closeWindowsAndHide()
                }
            }
        } else {
            // A turn later, so the scene has built its window and its observers by then.
            DispatchQueue.main.async {
                MainActor.assumeIsolated { ActivationPolicy.showMainWindow() }
            }
        }
    }

    // MARK: The hotkey

    private func makeMonitor() -> PushToTalkMonitor? {
        guard let controller else { return nil }
        return PushToTalkMonitor(spec: controller.settings.hotkey) { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
    }

    private func startMonitor() {
        guard let controller, let monitor = makeMonitor() else { return }
        do {
            try monitor.start()
            self.monitor = monitor
            controller.recordHotkeyFailure(nil)
        } catch {
            // Recorded, not just re-read. `refreshBlockers` alone could never surface this: the
            // hotkey blocker asks `isPermitted`, and a refused tap happens with the permission
            // granted — so the app showed a dead hotkey and an empty problem list.
            controller.recordHotkeyFailure("\(error)")
            Task { await controller.refreshBlockers() }
        }
    }

    private func retryMonitorIfNeeded() {
        guard let controller, monitor == nil,
              PushToTalkMonitor.isPermitted(for: controller.settings.hotkey) else { return }
        startMonitor()
    }

    /// A new hotkey from the pane replaces the tap. A dictation held on the old key is ended as
    /// a cancel — its key-up will arrive on a tap that no longer exists.
    private func watchHotkeySetting() {
        guard let controller else { return }
        withObservationTracking {
            _ = controller.settings.hotkey
        } onChange: {
            Task { @MainActor [weak self] in
                guard let self, let controller = self.controller else { return }
                if self.monitor?.spec != controller.settings.hotkey {
                    self.monitor?.stop()
                    self.monitor = nil
                    controller.cancel()
                    self.startMonitor()
                    await controller.refreshBlockers()
                }
                self.watchHotkeySetting()
            }
        }
    }

    private func handle(_ event: HotkeyEvent) {
        guard let controller else { return }
        switch event {
        case .pressed:
            hideTask?.cancel()
            controller.press()
            hud?.show()
        case .released:
            controller.release()
            scheduleHide()
        case .cancelled:
            // Right ⌘ turned out to be ⌘C. Nothing was said, nothing is inserted, and the HUD
            // goes at once rather than lingering over a dictation that never was.
            controller.cancel()
            hideTask?.cancel()
            hud?.hide()
        }
    }

    /// The HUD lingers after a dictation so the result and its timing can be read, then goes.
    /// Cancelled by the next press, so holding the key again never fights a pending hide.
    ///
    /// It waits for the dictation to actually finish first. The hide used to start counting from
    /// the key-up, which made the panel's lifetime a property of how long the user held a key
    /// rather than of the outcome it exists to report — the opposite of what the contract the
    /// outcome travels on says. Anything landing after 2.5 s was written to a panel that was no
    /// longer on screen, so a failed dictation could produce no visible signal at all. That got
    /// worse once a cold model load moved inside the run: the first Uzbek dictation of a session
    /// spends ~7.8 s in `loading`, and the HUD was leaving at 2.5 s every time.
    private func scheduleHide() {
        hideTask?.cancel()
        hideTask = Task { [weak self] in
            while self?.controller?.status.isBusy == true {
                try? await Task.sleep(for: .milliseconds(100))
                if Task.isCancelled { return }
            }
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            self?.hud?.hide()
        }
    }

    // MARK: Always-on and login

    private func watchLifecycleSettings() {
        guard let controller else { return }
        lifecycle.apply(alwaysOn: controller.settings.alwaysOn,
                        launchAtLogin: controller.settings.launchAtLogin)
        withObservationTracking {
            _ = controller.settings.alwaysOn
            _ = controller.settings.launchAtLogin
        } onChange: {
            Task { @MainActor [weak self] in self?.watchLifecycleSettings() }
        }
    }

    /// ⌘Q, the Dock's Quit, Activity Monitor's Quit — all of them arrive here.
    ///
    /// With always-on, every one of them means "close the window": the menu-bar icon and the
    /// hotkey keep working. Three quits are real anyway: the in-app "Turn off always-on & quit"
    /// (`AppLifecycle.quitForReal`), a duplicate or handed-over copy stepping aside, and the
    /// system logging out, restarting or shutting down — refusing that would hold up the logout,
    /// and launchd brings Kotiba back at the next login regardless.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let controller, controller.settings.alwaysOn,
              !lifecycle.allowsTermination, !lifecycle.isSystemQuit else { return .terminateNow }
        ActivationPolicy.closeWindowsAndHide()
        return .terminateCancel
    }

    /// A Dock click, or opening Kotiba again while it runs: show the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { ActivationPolicy.showMainWindow() }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Music first: a quit mid-hold must not leave the output at a quarter volume. No ramp —
        // there is no process left afterwards to finish one.
        controller?.restoreDuckingImmediately()
        // A backstop, not the mechanism: every control persists on write. This catches an edit
        // that was in flight when the user quit.
        controller?.settings.save()
        monitor?.stop()
        lifecycle.willTerminate()
        // Leave without running C++ static destructors. Every Quit from the menu since the idle
        // model release shipped has ended in SIGABRT (`KotibaMac-2026-09-19-154823.ips` and its
        // siblings): `exit()` runs `__cxa_finalize`, which destroys ggml's per-process vector of
        // Metal devices, and `ggml_metal_rsets_free` aborts inside that destructor. Nothing in
        // Swift can reach it — it is a global inside whisper.cpp — and nothing of ours is still
        // pending: settings are written synchronously above, history and diagnostics are written
        // at the end of each dictation, and `UserDefaults` is flushed to cfprefsd on `set`.
        // `_exit` skips the destructors and the crash report, and nothing else. Status 0 is also
        // what tells launchd's `KeepAlive {SuccessfulExit = false}` this quit was meant.
        UserDefaults.standard.synchronize()
        _exit(0)
    }
}
