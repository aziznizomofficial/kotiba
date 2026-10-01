#if os(macOS)
import AppKit
import KotibaCore

// Task I-01. Getting text into whatever app the user was already in.
//
// ⚠️ UNVERIFIED ON DEVICE. Whether a dev-signed, non-notarised binary's synthesised ⌘V
// actually lands in TextEdit, VS Code, Terminal and Slack on macOS 26.5.1 is the one thing no
// test can answer, and the build plan is blunt about the stakes: "if it fails, the whole
// insertion design changes." Everything here is written to be correct; none of it is proven.
//
// The pasteboard is the primary path because the alternative — synthesising a keystroke per
// character — cannot type Uzbek at all: macOS 26.5.1 ships no Uzbek Latin keyboard layout, so
// there is no keycode that produces the okina U+02BB. Keystroke simulation is a fallback for
// apps that refuse paste, and it refuses Uzbek rather than silently mangling it.
//
// Two costs are deliberate:
//
//   * **The pasteboard is saved and restored.** Dictating should not destroy whatever the user
//     had copied. Restoration is delayed slightly because the target app reads the pasteboard
//     asynchronously after receiving ⌘V, and restoring immediately can win the race.
//   * **Insertion is confirmed, not assumed.** a commercial dictation app's own paste confirmation was still
//     breaking per-app at v2.17.0, and its changelog documents paste bugs in Safari, Discord,
//     Obsidian, Slack and Superhuman. The HUD keys off the observed outcome.

public struct PasteboardSink: TextSink {

    /// How long to wait for the target app to read the pasteboard before restoring it.
    /// The OS event path itself costs ~0.5 ms; this is entirely about the receiving app.
    public var restoreDelay: Duration
    /// Whether to verify the pasteboard still holds our text at paste time.
    public var confirm: Bool
    /// Which pasteboard. The general one in the app; a private one in a test, so that no test
    /// ever touches the user's clipboard.
    let pasteboardName: NSPasteboard.Name
    /// The Accessibility check and the ⌘V, replaceable so a test can play the target app.
    let isTrusted: @Sendable () -> Bool
    let postPaste: @Sendable () -> Bool

    public init(restoreDelay: Duration = .milliseconds(250), confirm: Bool = true) {
        self.init(restoreDelay: restoreDelay, confirm: confirm, pasteboardName: .general,
                  isTrusted: { AXIsProcessTrusted() }, postPaste: { Self.sendCommandV() })
    }

    init(restoreDelay: Duration, confirm: Bool, pasteboardName: NSPasteboard.Name,
         isTrusted: @escaping @Sendable () -> Bool, postPaste: @escaping @Sendable () -> Bool) {
        self.restoreDelay = restoreDelay
        self.confirm = confirm
        self.pasteboardName = pasteboardName
        self.isTrusted = isTrusted
        self.postPaste = postPaste
    }

    public func insert(_ text: String) async throws -> InsertionOutcome {
        guard !text.isEmpty else { return .refused(reason: "nothing to insert") }
        guard isTrusted() else {
            return .refused(reason: "Accessibility permission has not been granted")
        }

        // One paste owns the pasteboard from its snapshot until its restore. See `PasteWindow`.
        await PasteWindow.shared.acquire()
        let pasteboard = NSPasteboard(name: pasteboardName)
        let saved = Self.snapshot(pasteboard)

        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            Self.restore(saved, to: pasteboard)
            await PasteWindow.shared.release()
            return .refused(reason: "the pasteboard refused the text")
        }

        if confirm, pasteboard.string(forType: .string) != text {
            Self.restore(saved, to: pasteboard)
            await PasteWindow.shared.release()
            return .refused(reason: "another app overwrote the pasteboard mid-insertion")
        }

        guard postPaste() else {
            Self.restore(saved, to: pasteboard)
            await PasteWindow.shared.release()
            return .refused(reason: "could not post the paste event — check Input Monitoring")
        }

        // Restore after the target has had a chance to read. Not on the critical path: the
        // user's text is already delivered by the time this runs. The window is handed on only
        // after the restore, so the next paste snapshots the user's clipboard, not this text.
        let delay = restoreDelay
        let name = pasteboardName
        Task.detached {
            try? await Task.sleep(for: delay)
            Self.restore(saved, to: NSPasteboard(name: name))
            await PasteWindow.shared.release()
        }
        return .inserted
    }

    /// Returns once no paste holds the pasteboard — every restore that was pending has run.
    static func settled() async {
        await PasteWindow.shared.acquire()
        await PasteWindow.shared.release()
    }

    /// Replacing previously inserted text — the polish pass.
    ///
    /// This used to refuse unconditionally, and the reasoning was sound at the time: there was
    /// no reliable way to know the user had not typed since, and selecting backwards by
    /// character count eats whatever they wrote in between. But the consequence was that every
    /// polish ever computed was discarded after being paid for, so the entire mode system did
    /// nothing while appearing to work.
    ///
    /// Accessibility supplies the missing check. `TextReplacement` reads the focused element's
    /// value and caret, confirms the characters immediately before the caret are *exactly* what
    /// we inserted, and refuses otherwise — so the dangerous case is detected rather than
    /// assumed away. A refusal still leaves the raw transcript standing, which is the outcome
    /// the old code produced every single time.
    public func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        guard !previous.isEmpty else { return .refused(reason: "nothing to replace") }
        switch TextReplacement.replace(previous, with: text) {
        case .replaced:
            return .inserted
        case .notWhereWeLeftIt:
            return .refused(reason: "the text moved or was edited after Kotiba typed it")
        case .notEditable:
            return .refused(reason: "this app does not expose its text field to Kotiba")
        case .noPermission:
            return .refused(reason: "Accessibility permission has not been granted")
        }
    }

    // MARK: Event synthesis

    static func sendCommandV() -> Bool {
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return false }
        // Suppress our own synthesised events from re-entering any tap we installed.
        source.setLocalEventsFilterDuringSuppressionState(
            [.permitLocalMouseEvents, .permitSystemDefinedEvents], state: .eventSuppressionStateSuppressionInterval)

        let v: CGKeyCode = 0x09          // kVK_ANSI_V
        guard
            let down = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: true),
            let up = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: false)
        else { return false }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cgAnnotatedSessionEventTap)
        up.post(tap: .cgAnnotatedSessionEventTap)
        return true
    }

    // MARK: Pasteboard preservation

    struct Snapshot: Sendable {
        var items: [[String: Data]]
    }

    static func snapshot(_ pasteboard: NSPasteboard) -> Snapshot {
        var items: [[String: Data]] = []
        for item in pasteboard.pasteboardItems ?? [] {
            var stored: [String: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { stored[type.rawValue] = data }
            }
            items.append(stored)
        }
        return Snapshot(items: items)
    }

    static func restore(_ snapshot: Snapshot, to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        guard !snapshot.items.isEmpty else { return }
        let restored = snapshot.items.map { stored -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in stored {
                item.setData(data, forType: NSPasteboard.PasteboardType(type))
            }
            return item
        }
        pasteboard.writeObjects(restored)
    }
}

/// One paste at a time, from its snapshot until its restore, across every sink in the process.
///
/// ⌘V is posted, not performed: the target app reads the pasteboard when it gets round to the
/// event, some milliseconds later — which is what `restoreDelay` already waits out. Until
/// overlapping dictations, nothing could paste inside that window. Now the next dictation in
/// `InsertionTurns` is released the moment this one's `insert` returns, and it is usually already
/// finished, so it overwrote the pasteboard before the target had read it: the first dictation's
/// text was lost and the second one pasted twice. Its snapshot was also this paste's text, so the
/// restores then left the user's clipboard holding a dictation. `PasteboardSinkTests` replays it.
///
/// The cost is only ever paid back to back: the later paste waits out the earlier one's
/// `restoreDelay` (250 ms). A lone dictation is not delayed at all.
actor PasteWindow {
    static let shared = PasteWindow()

    private var held = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        guard held else { held = true; return }
        await withCheckedContinuation { waiting.append($0) }
    }

    /// Hands the window to the longest waiter, in the order they asked — which is press order,
    /// because `InsertionTurns` releases them one at a time.
    func release() {
        if waiting.isEmpty { held = false } else { waiting.removeFirst().resume() }
    }
}

#endif
