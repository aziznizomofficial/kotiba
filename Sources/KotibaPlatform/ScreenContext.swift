#if os(macOS)
import AppKit
import ApplicationServices
import KotibaCore

// What is actually on screen when someone dictates.
//
// This is the thing that makes a commercial dictation app's best mode good, and it is not a cleverer prompt.
// Read out of its own recording on this Mac, its top mode injects a block like:
//
//     USER INFORMATION:  User's full name: Aziz Nizomov
//     APPLICATION CONTEXT:
//       User is currently using Gemini · Category: Web Browser
//       Focused element: Input field, Title: Enter a prompt for Gemini
//       Found names: Gemini, Gemini in the element
//     Names and Usernames: Andrew, AI, Tate, Ask, Boost, Gemini, Google
//
// The names are harvested from the window, and its prompt then says: use this list for
// SPELLING HELP ONLY — "Slak" becomes "Slack" *if Slack is in the list*, and never substitute a
// valid word for a different one from it. That constraint is what stops a names list becoming a
// corruption engine, and it is why the list must be gathered from the screen rather than
// guessed: a name that is visible is a name the speaker plausibly said.
//
// Kotiba can do this because it already has Accessibility for the paste path. Nothing here asks
// for a permission the app does not have, and everything degrades to nil rather than failing.

public struct ScreenContext: Sendable, Equatable {
    /// The person, so a mode that signs an email can sign it correctly.
    public var userName: String?
    public var appName: String?
    public var appFormat: String
    /// What the caret is sitting in — "Enter a prompt for Gemini", "To:", "Search".
    public var fieldDescription: String?
    /// Proper nouns visible in the frontmost window, for spelling help only.
    public var names: [String]
    /// Whatever the user has selected in the focused field.
    ///
    /// Only ever populated for a mode that sets `contextFromSelection`. `PromptContext` has
    /// carried a `{{selection}}` variable since it was written and nothing ever filled it, so
    /// any mode using it rendered an empty string with no error.
    public var selection: String

    public init(userName: String? = nil, appName: String? = nil, appFormat: String = "plain text",
                fieldDescription: String? = nil, names: [String] = [], selection: String = "") {
        self.userName = userName
        self.appName = appName
        self.appFormat = appFormat
        self.fieldDescription = fieldDescription
        self.names = names
        self.selection = selection
    }

    /// Reads the frontmost application and the focused element. Cheap enough for the critical
    /// path: it walks one element and its siblings, never the whole tree.
    /// How much of a selection is worth carrying into a prompt.
    static let selectionLimit = 2_000

    public static func capture(nameLimit: Int = 24) -> ScreenContext {
        var context = ScreenContext()
        context.userName = Self.fullName
        context.appName = NSWorkspace.shared.frontmostApplication?.localizedName
        let bundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let format = AppKnowledge.format(forBundleID: bundleID)
        context.appFormat = "\(format.rawValue). \(format.guidance)"

        // A credential field contributes nothing — not its title, and certainly not its
        // contents. `resolveMode` already refuses to polish there; this refuses to look.
        guard !AppKnowledge.isSensitive(format), AXIsProcessTrusted() else { return context }

        guard let focused = TextReplacement.focusedElement() else { return context }
        context.fieldDescription = describe(focused)
        context.names = Array(harvestNames(near: focused).prefix(nameLimit))
        // Bounded deliberately. A mode that asks for the selection wants the sentence being
        // rewritten, not a document — and this string is about to be interpolated into a prompt
        // sent to a model, so an unbounded read is both a cost and an exposure.
        context.selection = String((string(focused, kAXSelectedTextAttribute as String) ?? "")
            .prefix(selectionLimit))
        return context
    }

    static var fullName: String? {
        let name = NSFullUserName().trimmingCharacters(in: .whitespaces)
        // The short username is not a name; it is a login. Only use it if it looks like one.
        return name.contains(" ") ? name : nil
    }

    private static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// What the field is for, in the words the app itself uses.
    static func describe(_ element: AXUIElement) -> String? {
        let parts = [
            string(element, kAXTitleAttribute as String),
            string(element, kAXPlaceholderValueAttribute as String),
            string(element, kAXDescriptionAttribute as String),
        ].compactMap { $0 }
        guard !parts.isEmpty else { return nil }
        // Apps often repeat the same string across all three.
        var seen: Set<String> = []
        return parts.filter { seen.insert($0).inserted }.joined(separator: ", ")
    }

    /// Proper nouns visible around the caret.
    ///
    /// Deliberately shallow — the focused element, its siblings and the window title. Walking a
    /// whole accessibility tree costs tens of milliseconds on a big Electron window, and this
    /// sits on the path between speaking and seeing text.
    static func harvestNames(near element: AXUIElement) -> [String] {
        var text: [String] = []
        if let window = NSWorkspace.shared.frontmostApplication?.localizedName { text.append(window) }
        for attribute in [kAXTitleAttribute, kAXPlaceholderValueAttribute,
                          kAXDescriptionAttribute] {
            if let value = string(element, attribute as String) { text.append(value) }
        }
        var parentRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString,
                                         &parentRef) == .success,
           let parent = parentRef, CFGetTypeID(parent) == AXUIElementGetTypeID() {
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(parent as! AXUIElement,
                                             kAXChildrenAttribute as CFString,
                                             &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                for child in children.prefix(40) {
                    for attribute in [kAXTitleAttribute, kAXDescriptionAttribute] {
                        if let value = string(child, attribute as String) { text.append(value) }
                    }
                }
            }
        }
        return properNouns(in: text)
    }

    /// Capitalised words worth offering as spelling help.
    ///
    /// Filtered hard, because a list full of "Ask", "Main" and "Boost" — which is exactly what
    /// a commercial dictation app's own harvest contained — is noise the model may substitute *into* the
    /// transcript. Everything here is a candidate spelling, never a replacement: the prompt
    /// says so in as many words.
    static func properNouns(in strings: [String]) -> [String] {
        var found: [String] = []
        var seen: Set<String> = []
        for line in strings {
            for word in line.split(whereSeparator: { !$0.isLetter && $0 != "." && $0 != "-" }) {
                let candidate = String(word)
                guard candidate.count >= 3, candidate.count <= 24,
                      let first = candidate.first, first.isUppercase,
                      !Self.stopWords.contains(candidate.lowercased()),
                      seen.insert(candidate).inserted else { continue }
                found.append(candidate)
            }
        }
        return found
    }

    /// UI chrome that looks like a name and is not one.
    static let stopWords: Set<String> = [
        "ask", "main", "boost", "upgrade", "help", "search", "menu", "file", "edit", "view",
        "window", "new", "open", "save", "close", "send", "back", "next", "done", "cancel",
        "ok", "yes", "no", "add", "remove", "delete", "settings", "preferences", "untitled",
        "enter", "type", "message", "reply", "forward", "inbox", "draft", "note", "notes",
        "title", "name", "email", "password", "username", "sign", "log", "home", "more",
    ]
}
#endif
