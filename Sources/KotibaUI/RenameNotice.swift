import Foundation
import KotibaPlatform

// What Home says after the rename from Kotib. `RenameMigration` (KotibaPlatform) carries the
// settings, history, models and API key across; macOS does not carry the permissions, because
// Input Monitoring, Accessibility and the microphone are granted to a bundle id and the bundle id
// changed. Without this the user sees three ordinary permission blockers and no reason why an app
// they set up months ago is asking again — and System Settings still shows a switched-on "Kotib"
// that looks as if it should count.

extension AppSettings {
    /// True from a launch that carried anything over until the three permissions are back.
    /// Kept in the same defaults domain as the blob but outside it, so it is neither a setting
    /// the user sees nor a field the Windows golden fixture has to mirror.
    public var awaitingRegrantAfterRename: Bool {
        get { store.bool(forKey: RenameMigration.regrantFlagKey) }
        set {
            if newValue { store.set(true, forKey: RenameMigration.regrantFlagKey) }
            else { store.removeObject(forKey: RenameMigration.regrantFlagKey) }
        }
    }
}

enum RenameNotice {

    /// The blockers a missing grant produces. The notice stays while any of them is listed.
    static let permissionBlockerIDs: Set<String> = ["input-monitoring", "accessibility", "microphone"]

    // Computed, not stored: the words follow the interface language.
    static var regrant: DictationController.Blocker { DictationController.Blocker(
        id: "renamed-regrant",
        title: L("rename.regrant.title"),
        detail: L("rename.regrant.detail"),
        settingsURL: "x-apple.systempreferences:com.apple.preference.security"
            + "?Privacy_ListenEvent") }

    static var legacyRunning: DictationController.Blocker { DictationController.Blocker(
        id: "renamed-legacy-running",
        title: L("rename.legacy.title"),
        detail: L("rename.legacy.detail"),
        settingsURL: nil) }

    /// Puts the notices in front of `found` and clears the flag once no permission is missing.
    /// Called last in `refreshBlockers`, when the permission rows are already known.
    @MainActor
    static func apply(to found: inout [DictationController.Blocker], settings: AppSettings,
                      legacyAppRunning: Bool) {
        if settings.awaitingRegrantAfterRename {
            if found.contains(where: { permissionBlockerIDs.contains($0.id) }) {
                found.insert(regrant, at: 0)
            } else {
                settings.awaitingRegrantAfterRename = false
            }
        }
        if legacyAppRunning { found.insert(legacyRunning, at: 0) }
    }
}
