import Foundation
import Testing

@testable import KotibaPlatform
@testable import KotibaUI

// The settings the platform slice added, and the one migration that matters: an owner upgrading
// from a build that never stored a hotkey keeps right ⌘ and skips the first-run window.

@Suite("Hotkey, ducking and lifecycle settings")
@MainActor
struct PlatformSettingsTests {

    private func store(with json: String?) -> UserDefaults {
        let store = UserDefaults(suiteName: UUID().uuidString)!
        if let json { store.set(json.data(using: .utf8)!, forKey: AppSettings.storageKey) }
        return store
    }

    @Test("a blob from before the hotkey setting existed means right ⌘")
    func absentHotkeyIsRightCommand() {
        let settings = AppSettings(store: store(with: #"{"polishEnabled":true}"#), modelBundle: nil)
        #expect(settings.hotkey == .rightCommand)
        #expect(settings.duckingEnabled && settings.duckLevel == 0.25)
        #expect(settings.preferBuiltInMicWithBluetooth)
        #expect(!settings.alwaysOn && !settings.launchAtLogin)
    }

    @Test("an existing user is not sent through onboarding; a fresh install is")
    func onboardingMigration() {
        #expect(AppSettings(store: store(with: #"{"polishEnabled":true}"#), modelBundle: nil)
                    .hasCompletedOnboarding)
        #expect(!AppSettings(store: store(with: nil), modelBundle: nil).hasCompletedOnboarding)
    }

    @Test("a chosen hotkey and the rest survive a save and a reload")
    func roundTrip() {
        let defaults = store(with: nil)
        let settings = AppSettings(store: defaults, modelBundle: nil)
        settings.hotkey = .key(HotkeySpec.Code.f18)
        settings.duckLevel = 0.4
        settings.alwaysOn = true
        settings.hasCompletedOnboarding = true
        settings.save()
        let reloaded = AppSettings(store: defaults, modelBundle: nil)
        #expect(reloaded.hotkey == .key(HotkeySpec.Code.f18))
        #expect(reloaded.duckLevel == 0.4)
        #expect(reloaded.alwaysOn)
        #expect(reloaded.hasCompletedOnboarding)
    }

    @Test("an unreadable hotkey falls back to right ⌘ and is named, not fatal")
    func unreadableHotkey() {
        let settings = AppSettings(
            store: store(with: #"{"hotkey":{"kind":"chord","keyCode":1},"polishEnabled":false}"#),
            modelBundle: nil)
        #expect(settings.hotkey == .rightCommand)
        #expect(settings.polishEnabled == false, "one bad key must not cost the others")
        #expect(settings.loadFailure?.contains("hotkey") == true)
    }
}
