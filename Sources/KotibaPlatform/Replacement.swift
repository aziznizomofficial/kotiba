#if os(macOS)
import AppKit
import ApplicationServices
import KotibaCore

// Putting the polished text where the raw text already is.
//
// Without this, the whole mode system is theatre: `DictationSession` inserts the raw transcript,
// asks the polisher for a better one, and then calls `sink.replace(...)` — which refused
// unconditionally, so every polish ever computed was discarded after it was paid for. Modes
// appeared to do nothing because they *did* nothing.
//
// Replacement is genuinely dangerous in a way insertion is not. Insertion adds; replacement
// destroys whatever it selects. If the user typed a word between the paste and the polish
// landing, a naive "select the last N characters and overwrite" eats it. The original refusal
// was the right call in the absence of a way to check.
//
// Accessibility gives us that check. The focused element's value and caret position can both be
// read, so we can confirm that the characters immediately before the caret are *exactly* the
// ones we inserted, and refuse otherwise. That turns a guess into a verified edit.

public enum TextReplacement {

    /// What the focused element currently holds, and where the caret is.
    struct Focused {
        var element: AXUIElement
        var value: String
        var caret: Int
    }

    static func focusedElement() -> AXUIElement? {
        let system = AXUIElementCreateSystemWide()
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
            let element = focused else { return nil }
        // `as!` would be a crash on an unexpected type; the CFTypeID check is the safe form.
        guard CFGetTypeID(element) == AXUIElementGetTypeID() else { return nil }
        return (element as! AXUIElement)
    }

    static func read(_ element: AXUIElement) -> Focused? {
        var valueRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, kAXValueAttribute as CFString, &valueRef) == .success,
            let text = valueRef as? String else { return nil }

        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
            let rangeValue = rangeRef, CFGetTypeID(rangeValue) == AXValueGetTypeID()
        else { return nil }

        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(rangeValue as! AXValue, .cfRange, &range) else { return nil }
        return Focused(element: element, value: text, caret: range.location + range.length)
    }

    public enum Outcome: Equatable, Sendable {
        case replaced
        /// The text we inserted is no longer immediately before the caret. Something else has
        /// happened — the user typed, clicked away, or the app rewrote its own field — and
        /// overwriting now would destroy their work.
        case notWhereWeLeftIt
        /// The focused control does not expose an editable value over Accessibility. Terminals
        /// and some Electron apps are like this.
        case notEditable
        case noPermission
    }

    /// Replace `previous` with `polished`, but only where `previous` is verifiably still the
    /// text immediately before the caret.
    public static func replace(_ previous: String, with polished: String) -> Outcome {
        guard AXIsProcessTrusted() else { return .noPermission }
        guard let element = focusedElement(), let focused = read(element) else {
            return .notEditable
        }

        // Compare in UTF-16, because that is the unit AXSelectedTextRange counts in. Doing this
        // in Characters silently misaligns the moment an emoji or an okina is involved, and the
        // okina is in every second Uzbek word.
        let units = Array(focused.value.utf16)
        let target = Array(previous.utf16)
        let caret = focused.caret
        guard caret >= target.count, caret <= units.count else { return .notWhereWeLeftIt }
        guard Array(units[(caret - target.count)..<caret]) == target else {
            return .notWhereWeLeftIt
        }

        // Select exactly what we inserted, then write over the selection. Setting the selection
        // rather than the whole value keeps the app's own undo stack intact and leaves anything
        // else in the field untouched.
        var range = CFRange(location: caret - target.count, length: target.count)
        guard let selection = AXValueCreate(.cfRange, &range) else { return .notWhereWeLeftIt }
        guard AXUIElementSetAttributeValue(
            element, kAXSelectedTextRangeAttribute as CFString, selection) == .success else {
            return .notEditable
        }
        guard AXUIElementSetAttributeValue(
            element, kAXSelectedTextAttribute as CFString, polished as CFString) == .success
        else {
            // The selection is now sitting over the raw text. Put the caret back at the end so
            // a failed replace does not leave the user's own next keystroke overwriting it.
            var restore = CFRange(location: caret, length: 0)
            if let collapsed = AXValueCreate(.cfRange, &restore) {
                AXUIElementSetAttributeValue(
                    element, kAXSelectedTextRangeAttribute as CFString, collapsed)
            }
            return .notEditable
        }
        return .replaced
    }
}
#endif
