import AppKit
import KotibaCore
import KotibaPlatform
import KotibaUI
import SwiftUI

// The shell. Three things only: the activation gesture, the presentation surface, and the
// menu. Everything else is in a SwiftPM target where it can be tested without signing, without
// a microphone and without a person.

@main
struct KotibaMacApp: App {

    // `AppState.shared`, not a fresh one: the delegate needs the same object, and two
    // controllers would mean two microphones, two loaded models, and a menu that reports on a
    // dictation that never happened.
    private let controller = AppState.shared.controller
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuContent(controller: controller)
        } label: {
            // Kotiba's own nib, not a borrowed SF mic — this is the only place most of the day
            // where the app is visible at all, so it should say which app it is. The icon is
            // also the whole status display, so it carries state: split nib idle, solid while
            // listening, slashed when something is blocking it. Template assets, so macOS
            // tints them for light, dark and a highlighted menu.
            MenuBarLabel(icon: menuIcon)
        }
        .menuBarExtraStyle(.menu)

        // The app window. Its id is a contract: the platform slice observes this window to put a
        // Dock icon up while it is open. It opens by itself at launch only until first-run setup
        // is done; after that Kotiba starts in the menu bar and the window waits to be asked for.
        Window("Kotiba", id: "main") {
            MainWindowView(controller: controller)
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1000, height: 680)
        // Also presented on the launches after the rename from Kotib until the permissions are
        // granted again: onboarding came across as done, and a window that stays shut would
        // leave the one note that explains the re-grant where nobody looks.
        .defaultLaunchBehavior(controller.settings.hasCompletedOnboarding
                               && !controller.settings.awaitingRegrantAfterRename
                               && !controller.renameMigrationDeferred ? .suppressed : .presented)
        .restorationBehavior(.disabled)
        .commands {
            // No "New Window": there is exactly one of these.
            CommandGroup(replacing: .newItem) {}
        }
    }

    private var menuIcon: String {
        switch controller.status {
        // Preparing and working stay solid too: the nib is 18 points wide and a fourth
        // silhouette would be a difference nobody can see. The HUD reports the difference.
        case .listening, .preparing, .working: return "MenuBarNibFilled"
        case .failed: return "MenuBarNibSlash"
        default: return controller.blockers.isEmpty ? "MenuBarNib" : "MenuBarNibSlash"
        }
    }
}

// MARK: - Menu

struct MenuContent: View {
    @Bindable var controller: DictationController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button(L("menu.open")) { openMain(.home) }
        Divider()

        if !controller.lastTranscript.isEmpty {
            Button(L("menu.copyLast", preview)) { copyLast() }
        }

        if !controller.blockers.isEmpty {
            Divider()
            ForEach(controller.blockers) { blocker in
                Button("⚠︎ \(blocker.title)") { open(blocker) }
            }
        }

        Divider()
        // Plain buttons rather than a Picker bound to a setting. The Picker wrote
        // `defaultModeKey` and relied on onChange to call setMode, which made the menu's tick
        // reflect a stored default rather than what will actually run — and a picked mode
        // sticks now, so those are two different things.
        Text(L("home.pickers.mode"))
        // Super, Note, Message — in that order, and nothing else. `transcription` stays in the
        // registry because a credential field is routed to it, but it is not something to
        // choose: dictating raw is what happens anyway when no model is available.
        // The way back out of a hand-picked mode. `userPickedMode` beats `modeFollowsApp` and
        // nothing ever cleared it, so picking any mode here used to turn app-following off for
        // good — the menu offered the trap and no exit.
        if controller.settings.modeFollowsApp {
            Button(controller.userPickedMode == nil ? "✓ " + L("common.automatic")
                   : L("common.automatic")) {
                controller.clearPickedMode()
            }
        }
        ForEach(controller.selectableModes, id: \.key) { mode in
            // With app-following on, the tick marks what the user pinned — "Automatic" holds it
            // when nothing is pinned. With it off, there is no pin to show and the tick marks
            // what will actually run.
            let ticked = controller.settings.modeFollowsApp
                ? controller.userPickedMode == mode.key
                : controller.activeModeKey == mode.key
            let name = Names.mode(mode)
            Button(ticked ? "✓ \(name)" : name) {
                controller.setMode(mode.key)
            }
        }

        // There IS a language picker now, and it is here because the reason there wasn't one did
        // not survive measurement. The claim was "Kotiba works out which language is being spoken —
        // measured at 88% on Uzbek with no English or Russian ever mistaken for it", with
        // Settings › Languages as the fallback for the misses. Measured on 745 clips of real
        // Uzbek through the shipping detector at the live threshold: recall is 83.1%, and 58.4%
        // under two seconds. English is mistaken for it — this user's own diagnostics have
        // English at cluster mass 0.230 and 0.119 against real Uzbek at 0.183 and 0.0122, so the
        // classes interleave and no threshold separates them. And the advertised fallback was
        // never consulted as a pin once a detector had loaded.
        //
        // A pin is router tier P1: zero milliseconds, absolute. Someone about to speak Uzbek
        // already knows they are, and this is them saying so once instead of correcting the
        // transcript every time.
        Divider()
        Text(L("home.pickers.language"))
        Button(controller.pinnedLanguage == nil ? "✓ " + L("common.automatic")
               : L("common.automatic")) {
            controller.setPinnedLanguage(nil)
        }
        ForEach(controller.pinnableLanguages, id: \.rawValue) { language in
            let name = DictationController.name(of: language)
            Button(controller.pinnedLanguage == language ? "✓ \(name)" : name) {
                controller.setPinnedLanguage(language)
            }
        }

        Divider()
        Button(L("menu.settings")) { openMain(.settings) }
            .keyboardShortcut(",", modifiers: .command)
        // With Always on, Quit would only close the window (see `AppDelegate`), so the menu offers
        // the one quit that is real instead of a Quit that does not quit.
        if controller.settings.alwaysOn {
            Button(L("menu.quitForReal")) {
                AppLifecycle.shared.quitForReal {
                    controller.settings.alwaysOn = false
                    controller.settings.save()
                }
            }
        } else {
            Button(L("settings.quitForReal.button")) { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q", modifiers: .command)
        }
    }

    /// Open the window — or bring it forward if it is already open — on a given section. An
    /// accessory app's window does not come to the front by itself, so activate explicitly.
    private func openMain(_ section: MainSection) {
        MainWindowNavigation.shared.section = section
        openWindow(id: "main")
        NSApplication.shared.activate()
    }

    private var preview: String {
        let text = controller.lastTranscript
        return text.count > 40 ? String(text.prefix(40)) + "…" : text
    }

    private func copyLast() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(controller.lastTranscript, forType: .string)
    }

    private func open(_ blocker: DictationController.Blocker) {
        guard let string = blocker.settingsURL, let url = URL(string: string) else { return }
        NSWorkspace.shared.open(url)
    }
}

/// One controller, reachable from both the SwiftUI scene and the delegate. A global is the
/// honest shape here: there is exactly one of these per process by definition, and threading it
/// through `@NSApplicationDelegateAdaptor` is not possible — SwiftUI constructs the delegate.
@MainActor
final class AppState {
    static let shared = AppState()
    let controller: DictationController

    private init() {
        // Before the controller, because its settings read the defaults domain and the support
        // directory the moment they exist. Kotib → Kotiba: see `RenameMigration`.
        let migration = RenameMigration.live(legacyAppIsRunning: {
            !NSRunningApplication.runningApplications(
                withBundleIdentifier: RenameMigration.legacyBundleIdentifier).isEmpty
        }).run()
        if !migration.alreadyCompleted,
           migration.carriedAnything || migration.deferredBecauseLegacyAppRunning
            || !migration.problems.isEmpty {
            NSLog("Kotiba: rename migration — renamed %@, merged %ld, set aside %ld, "
                  + "defaults %ld, keychain %ld, deferred %@, problems: %@",
                  migration.renamedDirectory ? "yes" : "no", migration.merged.count,
                  migration.setAside.count, migration.importedDefaults.count,
                  migration.copiedSecrets.count,
                  migration.deferredBecauseLegacyAppRunning ? "yes" : "no",
                  migration.problems.joined(separator: "; "))
        }
        controller = DictationController(devices: .live())
        controller.renameMigrationDeferred = migration.deferredBecauseLegacyAppRunning
        // The interface language, before any window or menu reads a word: the stored choice, or
        // the system's when there is none. Here and not in the controller, so tests — which build
        // controllers without this shell — read English on any machine.
        Localizer.shared.apply(AppLanguage.resolve(controller.settings.appLanguage))
    }
}

// The HUD's window, `HUDPanel`, lives in KotibaUI/HUD.swift beside the pill it carries.

// MARK: - The menu-bar label

/// The menu-bar icon, and the one view that exists for the app's whole life — which makes it the
/// place to hear "show the main window" from outside SwiftUI: first run, a Dock click, Kotiba
/// opened again while it runs (`ActivationPolicy.showMainWindow`, `.kotibaShowMainWindow`).
struct MenuBarLabel: View {
    let icon: String
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Image(icon)
            .onReceive(NotificationCenter.default.publisher(for: .kotibaShowMainWindow)) { _ in
                openWindow(id: "main")
                NSApplication.shared.activate()
            }
    }
}
