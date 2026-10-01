import Foundation
import Testing

@testable import KotibaCore

// `historyLimit` was persisted, round-tripped and asserted on in tests, and nothing read it —
// there was no prune to read it with. The only retention behaviour the app had was "keep
// everything, forever", behind a switch whose options are all or nothing.

@Suite("History retention is enforced, not just stored")
struct HistoryPruneTests {

    private func makeStore() async throws -> HistoryStore {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-prune-\(UUID().uuidString).sqlite")
        return try HistoryStore(path: url.path)
    }

    private func entry(_ n: Int) -> HistoryEntry {
        HistoryEntry(
            startedAt: Date(timeIntervalSince1970: 1_700_000_000 + Double(n)),
            language: .english,
            engineID: "test",
            raw: "raw \(n)",
            result: "result \(n)",
            polished: nil,
            audioSeconds: 1)
    }

    @Test("pruning keeps the newest entries and drops the rest")
    func keepsNewest() async throws {
        let store = try await makeStore()
        for n in 1...10 { try await store.insert(entry(n)) }

        try await store.prune(keeping: 3)

        #expect(try await store.count() == 3)
        let kept = try await store.recent(limit: 50).map(\.result)
        #expect(kept == ["result 10", "result 9", "result 8"])
    }

    // 0 is the shipped default and the setting's documented "keep everything".
    @Test("a limit of zero keeps everything, which is what the setting documents")
    func zeroKeepsEverything() async throws {
        let store = try await makeStore()
        for n in 1...5 { try await store.insert(entry(n)) }
        try await store.prune(keeping: 0)
        #expect(try await store.count() == 5)
    }

    @Test("a negative limit is not a licence to delete everything")
    func negativeIsSafe() async throws {
        let store = try await makeStore()
        for n in 1...5 { try await store.insert(entry(n)) }
        try await store.prune(keeping: -1)
        #expect(try await store.count() == 5)
    }

    @Test("pruning below the limit changes nothing")
    func underLimitIsNoOp() async throws {
        let store = try await makeStore()
        for n in 1...3 { try await store.insert(entry(n)) }
        try await store.prune(keeping: 100)
        #expect(try await store.count() == 3)
    }

    // The full-text index is a separate table kept in step by triggers. A prune that dropped rows
    // without maintaining it would leave search returning entries that no longer exist.
    @Test("pruned entries stop appearing in search")
    func searchIndexFollows() async throws {
        let store = try await makeStore()
        for n in 1...10 { try await store.insert(entry(n)) }
        try await store.prune(keeping: 2)
        let hits = try await store.search("result", limit: 50)
        #expect(hits.count == 2, "the FTS index must not outlive the rows it points at")
    }
}
