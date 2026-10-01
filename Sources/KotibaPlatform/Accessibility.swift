#if os(macOS)
import ApplicationServices
import AppKit

// Asking for Accessibility, rather than only checking it.
//
// `AXIsProcessTrusted()` answers the question and does nothing else. An app that only ever
// reads it — which this one did — leaves the user to find System Settings › Privacy & Security
// › Accessibility, press `+`, and navigate to the right bundle by hand. Worse, Kotiba may not
// appear in that list at all until something has asked, so there is nothing to toggle and the
// pane looks like it is missing the app.
//
// `AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt: true])` is the same question
// asked properly: macOS shows its own dialog with an "Open System Settings" button **and
// registers the app in the list**, so the whole job becomes flipping one switch.
//
// It prompts once per app per TCC decision. After a refusal the dialog stops appearing and the
// pane is the only route, which is why `openSettings()` still exists below.

public enum Accessibility {

    /// Whether this process may drive other applications. Reading only; never prompts.
    public static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Ask, showing the system dialog and registering the app in the Accessibility list.
    ///
    /// Returns the answer as it stands *now* — which is almost always false on the first call,
    /// because the user has not clicked anything yet. Treat it as "the ask has been made", not
    /// as a result, and re-read `isTrusted` afterwards.
    @discardableResult
    public static func request() -> Bool {
        // The constant is imported as a `var` and so is not concurrency-safe to reference under
        // Swift 6. Its value is fixed and documented; spelling it out avoids the global.
        return AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }

    /// The pane itself, for the case where the prompt has already been dismissed once and macOS
    /// will not show it again.
    public static func openSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security"
                            + "?Privacy_Accessibility") else { return }
        NSWorkspace.shared.open(url)
    }

    /// Where the app is, so the user can find it with `+` if they have to. Resolved rather than
    /// hard-coded, because a copy running from DerivedData needs its own entry and telling
    /// someone to add `/Applications/Kotiba.app` when that is not the one running is a way to
    /// spend an afternoon.
    public static var bundlePath: String { Bundle.main.bundlePath }
}
#endif
