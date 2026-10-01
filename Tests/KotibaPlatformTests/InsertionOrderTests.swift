import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaPlatform

private actor Log {
    private(set) var lines: [String] = []
    func add(_ s: String) { lines.append(s) }
}

private struct LoggingSink: TextSink {
    let log: Log
    func insert(_ text: String) async throws -> InsertionOutcome {
        await log.add(text)
        return .inserted
    }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        await log.add("replace \(previous)→\(text)")
        return .inserted
    }
}

@Suite("N pastes before N+1")
struct InsertionOrderTests {

    @Test("a later dictation that finishes first waits for the earlier one")
    func laterWaits() async {
        let turns = InsertionTurns()
        let log = Log()
        let first = OrderedTextSink(LoggingSink(log: log), turns: turns, ticket: turns.issue())
        let second = OrderedTextSink(LoggingSink(log: log), turns: turns, ticket: turns.issue())

        let late = Task { _ = try? await second.insert("second") }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(await log.lines.isEmpty, "the second pasted before the first")
        _ = try? await first.insert("first")
        await late.value
        #expect(await log.lines == ["first", "second"])
    }

    @Test("a dictation that never pastes still passes the turn")
    func silencePassesTurn() async {
        let turns = InsertionTurns()
        let log = Log()
        let silent = turns.issue()
        let next = OrderedTextSink(LoggingSink(log: log), turns: turns, ticket: turns.issue())
        let waiting = Task { _ = try? await next.insert("next") }
        try? await Task.sleep(for: .milliseconds(20))
        await turns.finish(silent)
        await waiting.value
        #expect(await log.lines == ["next"])
    }

    @Test("finishing twice, or out of order, is harmless")
    func idempotent() async {
        let turns = InsertionTurns()
        let a = turns.issue(), b = turns.issue(), c = turns.issue()
        await turns.finish(c)
        await turns.finish(b)
        await turns.finish(b)
        await turns.finish(a)
        await turns.finish(a)
        let log = Log()
        let d = OrderedTextSink(LoggingSink(log: log), turns: turns, ticket: turns.issue())
        _ = try? await d.insert("d")
        #expect(await log.lines == ["d"])
    }

    @Test("a wedged dictation cannot hold the queue forever")
    func patience() async {
        let turns = InsertionTurns(patience: .milliseconds(80))
        let log = Log()
        _ = turns.issue()                                   // never finishes
        let next = OrderedTextSink(LoggingSink(log: log), turns: turns, ticket: turns.issue())
        _ = try? await next.insert("next")
        #expect(await log.lines == ["next"])
        #expect(await turns.overtakes == 1)
    }

    @Test("a replace after insert does not wait for anyone")
    func replaceDoesNotWait() async {
        let turns = InsertionTurns()
        let log = Log()
        _ = turns.issue()                                   // an earlier one, still busy
        let later = OrderedTextSink(LoggingSink(log: log), turns: turns, ticket: turns.issue())
        _ = try? await later.replace("a", with: "b")
        #expect(await log.lines == ["replace a→b"])
    }
}
