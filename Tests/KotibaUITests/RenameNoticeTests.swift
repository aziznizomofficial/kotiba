import Foundation
import KotibaPlatform
import Testing

@testable import KotibaUI

// The two halves of the rename that live in KotibaUI: the settings blob still read from its old
// key, and the Home note about the permissions macOS does not carry across.

@MainActor
@Suite("Rename notice (Kotib → Kotiba)")
struct RenameNoticeTests {

    private func blocker(_ id: String) -> DictationController.Blocker {
        .init(id: id, title: id, detail: "", settingsURL: nil)
    }

    @Test("settings stored only under the old key are still loaded")
    func legacySettingsKey() {
        let store = UserDefaults(suiteName: UUID().uuidString)!
        store.set(Data(#"{"hasCompletedOnboarding":true,"historyLimit":7}"#.utf8),
                  forKey: AppSettings.legacyStorageKey)
        let settings = AppSettings(store: store, modelBundle: nil)
        #expect(settings.hasCompletedOnboarding)
        #expect(settings.historyLimit == 7)
        #expect(settings.loadFailure == nil)
    }

    @Test("the new key wins over the old one")
    func newKeyWins() {
        let store = UserDefaults(suiteName: UUID().uuidString)!
        store.set(Data(#"{"historyLimit":7}"#.utf8), forKey: AppSettings.legacyStorageKey)
        store.set(Data(#"{"historyLimit":9}"#.utf8), forKey: AppSettings.storageKey)
        #expect(AppSettings(store: store, modelBundle: nil).historyLimit == 9)
    }

    @Test("the re-grant note leads while a permission is missing, and clears once none is")
    func regrantNote() {
        let settings = AppSettings.hermetic()
        settings.awaitingRegrantAfterRename = true

        var found = [blocker("uzbek-model"), blocker("accessibility")]
        RenameNotice.apply(to: &found, settings: settings, legacyAppRunning: false)
        #expect(found.first?.id == "renamed-regrant")
        #expect(settings.awaitingRegrantAfterRename)

        var granted = [blocker("uzbek-model")]
        RenameNotice.apply(to: &granted, settings: settings, legacyAppRunning: false)
        #expect(granted.map(\.id) == ["uzbek-model"])
        #expect(!settings.awaitingRegrantAfterRename, "latched off only by the grants themselves")
    }

    @Test("no note for someone who never had Kotib")
    func noNoteWithoutMigration() {
        let settings = AppSettings.hermetic()
        var found = [blocker("input-monitoring")]
        RenameNotice.apply(to: &found, settings: settings, legacyAppRunning: false)
        #expect(found.map(\.id) == ["input-monitoring"])
    }

    @Test("a deferred migration says the old app is still running")
    func legacyRunningNote() {
        var found: [DictationController.Blocker] = []
        RenameNotice.apply(to: &found, settings: AppSettings.hermetic(), legacyAppRunning: true)
        #expect(found.map(\.id) == ["renamed-legacy-running"])
    }

    @Test("the flag is stored under the migration's key, outside the settings blob")
    func flagKey() {
        let store = UserDefaults(suiteName: UUID().uuidString)!
        let settings = AppSettings.hermetic(store: store)
        settings.awaitingRegrantAfterRename = true
        #expect(store.bool(forKey: RenameMigration.regrantFlagKey))
        settings.awaitingRegrantAfterRename = false
        #expect(store.object(forKey: RenameMigration.regrantFlagKey) == nil)
    }
}
