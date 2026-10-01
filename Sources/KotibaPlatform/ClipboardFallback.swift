import Foundation
import KotibaCore
import Synchronization

#if os(macOS)
import AppKit
import ApplicationServices
#endif

// When a dictation finishes and nothing that takes text has focus — the desktop, a Finder window,
// a list — ⌘V lands nowhere, the paste restores the user's clipboard 250 ms later, and the words
// exist only in History. The owner's review (2026-09-30) asked for exactly this case to be said,
// softly: the text is on the clipboard, paste it where you meant to.
//
// So the paste still happens exactly as before — this wraps the sink, it does not replace it, and
// nothing is added in front of the ⌘V. *After* the paste, Accessibility is asked whether anything
// editable has focus. Only a certain "no" changes anything: the dictation is then left on the
// clipboard (once the paste has restored whatever was there), a polished version replaces it
// there when polish lands, and the controller is told so the pill and Home can say it.
//
// The asymmetry is deliberate. A wrong "yes" costs a hint that was not shown — the behaviour
// before this file existed. A wrong "no" costs the user's previous clipboard, so every doubt is a
// "yes": no Accessibility grant, an app that does not answer within 100 ms, an element with a role
// that is not on the short list of things that can never take typing. UNVERIFIED ON DEVICE per
// app: Electron and web views report their focus lazily, and whether any of them answers "nothing
// focused" while a text box is focused has not been tested; `nonTextRoles` is kept short for that
// reason.

/// How a sink learns that nothing could receive the text, and where the text then goes.
public struct NoTextTargetFallback: Sendable {
    /// `false` only when it is certain nothing editable has focus.
    public var hasTextTarget: @Sendable () -> Bool
    /// Put this text on the clipboard, after any paste in flight has restored the old contents.
    public var keepOnClipboard: @Sendable (String) async -> Void

    public init(hasTextTarget: @escaping @Sendable () -> Bool,
                keepOnClipboard: @escaping @Sendable (String) async -> Void) {
        self.hasTextTarget = hasTextTarget
        self.keepOnClipboard = keepOnClipboard
    }

    /// Never falls back — tests, the probe, and any platform without a way to ask.
    public static let never = NoTextTargetFallback(hasTextTarget: { true }, keepOnClipboard: { _ in })

    #if os(macOS)
    public static let live = NoTextTargetFallback(
        hasTextTarget: { TextTarget.mayBeFocused() },
        keepOnClipboard: { text in
            // After the paste window closes: the paste's own restore must not overwrite this.
            await PasteboardSink.settled()
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        })
    #endif
}

/// Wraps a dictation's sink; see the top of this file. One per dictation.
public struct ClipboardFallbackSink: TextSink {
    private let base: any TextSink
    private let fallback: NoTextTargetFallback
    private let onFallback: @Sendable () -> Void
    /// The newest text this dictation delivered, once it has fallen back — the raw transcript,
    /// then its polished form. Whatever `keepOnClipboard` runs last writes this, so a polish that
    /// lands before the raw text's keep has run can never be overwritten by the raw text.
    private let kept = KeptText()

    private final class KeptText: Sendable {
        let text = Mutex<String?>(nil)
        func withLock<R>(_ body: (inout String?) -> R) -> R { text.withLock { body(&$0) } }
    }

    public init(_ base: any TextSink, fallback: NoTextTargetFallback,
                onFallback: @escaping @Sendable () -> Void) {
        self.base = base
        self.fallback = fallback
        self.onFallback = onFallback
    }

    public func insert(_ text: String) async throws -> InsertionOutcome {
        let outcome = try await base.insert(text)
        guard outcome == .inserted, !fallback.hasTextTarget() else { return outcome }
        kept.withLock { $0 = text }
        onFallback()
        await keepNewest()
        return outcome
    }

    public func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        let fellBack = kept.withLock { current -> Bool in
            guard current != nil else { return false }
            current = text
            return true
        }
        guard fellBack else { return try await base.replace(previous, with: text) }
        // Nothing to replace in: the clipboard is where this dictation lives, so the polished
        // text goes there and the record says polish landed.
        await keepNewest()
        return .inserted
    }

    private func keepNewest() async {
        let fallback = fallback
        let kept = kept
        // Detached from the dictation: the paste window can be held for its 250 ms restore, and
        // the session must not wait on the clipboard to finish.
        Task.detached {
            await fallback.keepOnClipboard(kept.withLock { $0 } ?? "")
        }
    }
}

#if os(macOS)
/// Whether anything that takes typing has keyboard focus, as far as Accessibility can tell.
public enum TextTarget {

    /// Roles that can never receive a paste. Short on purpose: an unknown role is a "maybe".
    static let nonTextRoles: Set<String> = [
        "AXList", "AXOutline", "AXTable", "AXBrowser", "AXImage", "AXButton",
    ]

    /// `false` only for a certain "nothing editable is focused".
    public static func mayBeFocused() -> Bool {
        guard AXIsProcessTrusted() else { return true }
        let system = AXUIElementCreateSystemWide()
        // Asked after the paste, off the critical path — but an app that hangs must still not
        // hold the dictation's clean-up for AX's default six seconds.
        AXUIElementSetMessagingTimeout(system, 0.1)
        var focused: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString,
                                                  &focused)
        return verdict(error: error, role: error == .success ? role(of: focused) : nil)
    }

    /// The decision, apart from the Accessibility calls, so it can be tested.
    static func verdict(error: AXError, role: String?) -> Bool {
        switch error {
        // The system answered and there is no focused element at all.
        case .noValue: return false
        case .success: return role.map { !nonTextRoles.contains($0) } ?? true
        default: return true
        }
    }

    private static func role(of element: CFTypeRef?) -> String? {
        guard let element, CFGetTypeID(element) == AXUIElementGetTypeID() else { return nil }
        let ax = element as! AXUIElement
        AXUIElementSetMessagingTimeout(ax, 0.1)
        var role: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXRoleAttribute as CFString, &role) == .success
        else { return nil }
        return role as? String
    }
}
#endif
