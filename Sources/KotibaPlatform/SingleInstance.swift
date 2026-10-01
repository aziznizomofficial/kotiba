#if os(macOS)
import AppKit

// Exactly one Kotiba at a time.
//
// This is not tidiness. A second copy is actively harmful, and it happens easily: a Debug build
// left in DerivedData, or a Release copy in a build directory, has the same bundle id as the
// one in /Applications, and launching a binary directly bypasses the LaunchServices check that
// would normally refuse it.
//
// Two instances mean two menu-bar icons, two event taps on right-⌘, two microphones opened on
// the same key press, two writers to one SQLite history, and two racing pastes into whatever
// app has focus. Observed on 2026-08-08 with two icons in the menu bar and no obvious cause.
//
// Detection is by bundle identifier through NSRunningApplication rather than a lock file: a
// lock file survives a crash and then blocks the next honest launch, which trades a rare
// annoyance for a permanent one.

public enum SingleInstance {

    /// Other running copies of this same app, newest first. Empty is the normal case.
    public static var others: [NSRunningApplication] {
        guard let id = Bundle.main.bundleIdentifier else { return [] }
        let me = ProcessInfo.processInfo.processIdentifier
        return NSRunningApplication.runningApplications(withBundleIdentifier: id)
            .filter { $0.processIdentifier != me }
    }

    public enum Outcome: Sendable, Equatable {
        case soleInstance
        /// Another copy is running and this one should stop. Carries its path, because "Kotiba is
        /// already running" is useless when the other one is a build directory you forgot about.
        case duplicate(existing: String)
    }

    /// Call before doing anything with a side effect — before the event tap, before the
    /// microphone, before opening the history database.
    ///
    /// Yields to the *older* copy rather than replacing it, so an accidental double-launch never
    /// interrupts a dictation already in progress.
    public static func claim() -> Outcome {
        guard let existing = others.min(by: { ($0.launchDate ?? .distantFuture)
                                              < ($1.launchDate ?? .distantFuture) }) else {
            return .soleInstance
        }
        return .duplicate(existing: existing.bundleURL?.path ?? "an unknown location")
    }

    /// Bring the copy that is already running to the front, so the user sees something happen
    /// rather than a launch that silently does nothing.
    public static func activateExisting() {
        others.first?.activate()
    }
}
#endif
