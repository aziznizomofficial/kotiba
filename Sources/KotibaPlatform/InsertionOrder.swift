import Foundation
import KotibaCore
import Synchronization

// N pastes before N+1.
//
// The second key-down no longer waits for the first dictation to finish — that was "Still
// finishing the last one", refused on every press that came in under the previous transcription.
// But two dictations in flight finish in whatever order their engines return: a 40-second Uzbek
// hold on whisper can easily land after a two-word English one on Apple's engine that was pressed
// a second later. Pasting in finishing order would put the user's sentences in the wrong order in
// their document, which is worse than being slow.
//
// So every dictation takes a ticket at key-down, and its sink waits for its turn before the first
// insert. The turn passes when the dictation has inserted — or when it has ended without
// inserting anything (silence, a failure, a cancel), which is why `finish` must be called on
// every path, and is idempotent so calling it twice is harmless.
//
// Only the *first* insert waits. A later `replace` (the polish pass rewriting what was pasted)
// is in place, verified against the text it replaces, and does not move the insertion point, so
// holding the next dictation's paste behind a 1.6 s cloud polish would buy nothing.

/// The queue of dictations waiting to paste. One per controller.
public actor InsertionTurns {

    public typealias Ticket = UInt64

    /// Issued synchronously, so a key-down on the main actor takes its place in line without
    /// waiting for this actor — the order of tickets is the order of presses, by construction.
    private nonisolated let issued = Atomic<Ticket>(0)
    /// The ticket whose insert may go now. Everything below it has finished.
    private var serving: Ticket = 1
    private var finished: Set<Ticket> = []
    private var waiters: [Ticket: [CheckedContinuation<Void, Never>]] = [:]
    /// How long a dictation may hold everyone behind it. Past it the queue moves on, out of order.
    ///
    /// Five minutes, because capture has no length limit any more and transcription time grows
    /// with it: whisper-medium runs at roughly 16× real time here (530 ms for an 8.8 s clip), so a
    /// ten-minute Uzbek hold is ~40 s of transcription before polish, and a thirty-minute one
    /// about two minutes. A shorter patience would let the next short dictation overtake exactly
    /// the long one the user cares most about. The session's own stages carry deadlines (polish
    /// 8 s, reroute 10 s), so a run that is still going after five minutes is wedged.
    private let patience: Duration

    public private(set) var overtakes = 0

    public init(patience: Duration = .seconds(300)) {
        self.patience = patience
    }

    /// Take a place in line. Call at key-down, in press order.
    public nonisolated func issue() -> Ticket {
        issued.wrappingAdd(1, ordering: .relaxed).newValue
    }

    /// Wait until every earlier ticket has inserted or ended.
    public func waitForTurn(_ ticket: Ticket) async {
        if ticket <= serving { return }
        let deadline = Task { [patience] in
            try? await Task.sleep(for: patience)
            if !Task.isCancelled { self.giveUp(before: ticket) }
        }
        await withCheckedContinuation { waiters[ticket, default: []].append($0) }
        deadline.cancel()
    }

    /// This ticket has inserted, or will not. Advances the line past every finished ticket.
    public func finish(_ ticket: Ticket) {
        guard ticket >= serving else { return }
        finished.insert(ticket)
        while finished.contains(serving) {
            finished.remove(serving)
            serving += 1
        }
        wake()
    }

    private func giveUp(before ticket: Ticket) {
        guard ticket > serving else { return }
        overtakes += 1
        // Everything ahead of `ticket` is treated as done. If one of them does paste later it
        // pastes out of order — the price of not wedging every later dictation behind it.
        for t in serving..<ticket { finished.insert(t) }
        finish(serving)
    }

    private func wake() {
        for ticket in waiters.keys where ticket <= serving {
            for waiter in waiters.removeValue(forKey: ticket) ?? [] { waiter.resume() }
        }
    }
}

/// A sink whose first insert waits for its dictation's turn.
public struct OrderedTextSink: TextSink {
    private let base: any TextSink
    private let turns: InsertionTurns
    private let ticket: InsertionTurns.Ticket

    public init(_ base: any TextSink, turns: InsertionTurns, ticket: InsertionTurns.Ticket) {
        self.base = base
        self.turns = turns
        self.ticket = ticket
    }

    public func insert(_ text: String) async throws -> InsertionOutcome {
        await turns.waitForTurn(ticket)
        do {
            let outcome = try await base.insert(text)
            await turns.finish(ticket)
            return outcome
        } catch {
            await turns.finish(ticket)
            throw error
        }
    }

    public func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        try await base.replace(previous, with: text)
    }
}
