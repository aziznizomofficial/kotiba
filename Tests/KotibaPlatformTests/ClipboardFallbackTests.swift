import Foundation
import KotibaCore
import Synchronization
import Testing

@testable import KotibaPlatform

// The sink that leaves a dictation on the clipboard when nothing had focus to paste into. No real
// pasteboard and no Accessibility here: the probe and the clipboard are both injected.

private final class Recorder: TextSink, @unchecked Sendable {
    let lock = NSLock()
    var inserted: [String] = []
    var replaced: [String] = []
    func insert(_ text: String) async throws -> InsertionOutcome {
        lock.withLock { inserted.append(text) }
        return .inserted
    }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        lock.withLock { replaced.append(text) }
        return .refused(reason: "no focused element")
    }
}

private final class Clipboard: @unchecked Sendable {
    let lock = NSLock()
    var writes: [String] = []
    func keep(_ text: String) { lock.withLock { writes.append(text) } }
    var last: String? { lock.withLock { writes.last } }
}

@Suite("Nowhere to paste: the words stay on the clipboard")
struct ClipboardFallbackTests {

    @Test("no text field: the paste still happens, then the text is kept and the app told")
    func fallsBack() async throws {
        let base = Recorder(), clipboard = Clipboard()
        let told = Mutex(0)
        let sink = ClipboardFallbackSink(
            base, fallback: NoTextTargetFallback(hasTextTarget: { false },
                                                 keepOnClipboard: { clipboard.keep($0) }),
            onFallback: { told.withLock { $0 += 1 } })

        #expect(try await sink.insert("salom dunyo") == .inserted)
        #expect(base.inserted == ["salom dunyo"], "the ⌘V must not be skipped on a guess")
        #expect(told.withLock { $0 } == 1)
        try await waitFor { clipboard.last == "salom dunyo" }

        // Polish lands: nothing to replace in, so the polished text replaces it on the clipboard.
        #expect(try await sink.replace("salom dunyo", with: "Salom, dunyo.") == .inserted)
        #expect(base.replaced.isEmpty)
        try await waitFor { clipboard.last == "Salom, dunyo." }
    }

    @Test("a text field, or any doubt: nothing changes")
    func passesThrough() async throws {
        let base = Recorder(), clipboard = Clipboard()
        let sink = ClipboardFallbackSink(
            base, fallback: NoTextTargetFallback(hasTextTarget: { true },
                                                 keepOnClipboard: { clipboard.keep($0) }),
            onFallback: { Issue.record("fell back with a text field focused") })
        #expect(try await sink.insert("hello") == .inserted)
        #expect(try await sink.replace("hello", with: "Hello.") == .refused(reason: "no focused element"))
        #expect(base.replaced == ["Hello."])
        try await Task.sleep(for: .milliseconds(50))
        #expect(clipboard.writes.isEmpty)
    }

    @Test("`.never` never falls back")
    func never() {
        #expect(NoTextTargetFallback.never.hasTextTarget())
    }

    #if os(macOS)
    @Test("only a certain 'nothing focused' is a no")
    func verdict() {
        #expect(!TextTarget.verdict(error: .noValue, role: nil))
        #expect(!TextTarget.verdict(error: .success, role: "AXList"))
        #expect(TextTarget.verdict(error: .success, role: "AXTextArea"))
        // An unknown role, an app that did not answer, no permission: all "maybe", so no hint.
        #expect(TextTarget.verdict(error: .success, role: "AXWebArea"))
        #expect(TextTarget.verdict(error: .success, role: nil))
        #expect(TextTarget.verdict(error: .cannotComplete, role: nil))
        #expect(TextTarget.verdict(error: .apiDisabled, role: nil))
    }
    #endif
}

private func waitFor(_ condition: @escaping @Sendable () -> Bool) async throws {
    for _ in 0..<200 where !condition() {
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(condition())
}
