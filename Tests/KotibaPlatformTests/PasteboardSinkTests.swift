import AppKit
import Foundation
import Synchronization
import Testing

@testable import KotibaCore
@testable import KotibaPlatform

#if os(macOS)

// Two pastes back to back, on a private pasteboard — never the user's — with a fake ⌘V that plays
// the target app: like a real one, it reads the pasteboard when it gets round to the event, a
// moment after the event was posted, not at the instant of posting.
//
// Back to back is the ordinary case now. A press is admitted while the previous dictation is still
// transcribing, and `InsertionTurns` holds the later one until the earlier one has pasted — so
// when the earlier paste goes, the later one is usually already finished and goes the moment the
// turn passes, a millisecond behind it.

@Suite("Pasting through the pasteboard", .serialized)
struct PasteboardSinkTests {

    /// Reads the pasteboard `lag` after each ⌘V, the way a target app does.
    private final class TargetApp: Sendable {
        let name: NSPasteboard.Name
        let lag: Duration
        let read = Mutex<[String]>([])
        init(name: NSPasteboard.Name, lag: Duration) { self.name = name; self.lag = lag }
        func paste() -> Bool {
            let name = self.name
            Task.detached { [self] in
                try? await Task.sleep(for: lag)
                let text = NSPasteboard(name: name).string(forType: .string) ?? "<empty>"
                read.withLock { $0.append(text) }
            }
            return true
        }
    }

    @Test("two pastes back to back: each lands its own text, and the clipboard is given back")
    func backToBack() async throws {
        let name = NSPasteboard.Name("uz.kotiba.test.\(UUID().uuidString)")
        let pasteboard = NSPasteboard(name: name)
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setString("what the user had copied", forType: .string)

        let app = TargetApp(name: name, lag: .milliseconds(30))
        let sink = PasteboardSink(restoreDelay: .milliseconds(300), confirm: true,
                                  pasteboardName: name, isTrusted: { true },
                                  postPaste: { app.paste() })
        #expect(try await sink.insert("first sentence.") == .inserted)
        #expect(try await sink.insert("second sentence.") == .inserted)
        await PasteboardSink.settled()
        // The last read is due `lag` after the last ⌘V, well inside the restore delay.
        for _ in 0..<100 where app.read.withLock({ $0.count }) < 2 {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(app.read.withLock { $0 } == ["first sentence.", "second sentence."],
                "a paste read the other dictation's text")
        #expect(pasteboard.string(forType: .string) == "what the user had copied",
                "the user's clipboard was not given back")
    }
}

#endif
