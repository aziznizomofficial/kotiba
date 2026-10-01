import Foundation
import Testing

@testable import KotibaCore

private func entry(_ raw: String, result: String? = nil, polished: String? = nil,
                   language: Language = .uzbek, at offset: TimeInterval = 0) -> HistoryEntry {
    HistoryEntry(startedAt: Date(timeIntervalSince1970: 1_785_000_000 + offset),
                 language: language, engineID: "test",
                 raw: raw, result: result ?? raw, polished: polished, audioSeconds: 1.5)
}

@Suite("History store")
struct HistoryStoreTests {

    @Test("all three text stages persist independently")
    func threeStages() async throws {
        let store = try HistoryStore(path: ":memory:")
        try await store.insert(entry("salom dunyo", result: "Salom dunyo",
                                     polished: "Salom, dunyo."))
        let got = try await store.recent().first
        #expect(got?.raw == "salom dunyo")
        #expect(got?.result == "Salom dunyo")
        #expect(got?.polished == "Salom, dunyo.")
        #expect(got?.final == "Salom, dunyo.", "final prefers the polish when there is one")
    }

    @Test("an unpolished entry falls back to the normalised result")
    func finalWithoutPolish() async throws {
        let store = try HistoryStore(path: ":memory:")
        try await store.insert(entry("salom", result: "Salom"))
        #expect(try await store.recent().first?.final == "Salom")
    }

    @Test("a Russian query and an Uzbek query each return their own document")
    func theDefinitionOfDone() async throws {
        let store = try HistoryStore(path: ":memory:")
        try await store.insert(entry("привет как дела", language: .russian, at: 0))
        try await store.insert(entry("salom qalaysiz", language: .uzbek, at: 10))
        try await store.insert(entry("hello how are you", language: .english, at: 20))

        #expect(try await store.search("привет").count == 1)
        #expect(try await store.search("qalaysiz").count == 1)
        #expect(try await store.search("hello").count == 1)
        #expect(try await store.search("привет").first?.language == .russian)
    }

    @Test("the okina survives indexing — it is a letter, not a diacritic to be helpfully removed")
    func okinaIsNotADiacritic() async throws {
        let store = try HistoryStore(path: ":memory:")
        try await store.insert(entry("o\u{02BB}zbekiston go\u{02BB}zal"))
        #expect(try await store.search("o\u{02BB}zbekiston").count == 1)
        // And it must not collapse to the bare vowel, which would merge distinct words.
        #expect(try await store.search("ozbekiston").isEmpty)
    }

    @Test("English suffix stemming does not merge distinct Uzbek forms")
    func noPorterStemming() async throws {
        // The measured porter failure this store exists to avoid: with tokenize='porter',
        // MATCH 'bordie' returns the document 'bordies'. Uzbek is agglutinative, so the
        // suffix is the grammar and stripping it produces a false match.
        let store = try HistoryStore(path: ":memory:")
        try await store.insert(entry("bordies"))
        #expect(try await store.search("bordie").isEmpty,
                "porter-style stemming would wrongly match here")
        #expect(try await store.search("bordies").count == 1)
    }

    @Test("search covers the polished stage, not only the raw one")
    func searchesAllStages() async throws {
        let store = try HistoryStore(path: ":memory:")
        try await store.insert(entry("meeting tuesday", result: "meeting tuesday",
                                     polished: "Meeting on Tuesday at three.", language: .english))
        #expect(try await store.search("three").count == 1, "the polish must be searchable too")
    }

    @Test("results come back newest first")
    func ordering() async throws {
        let store = try HistoryStore(path: ":memory:")
        try await store.insert(entry("first", at: 0))
        try await store.insert(entry("second", at: 100))
        try await store.insert(entry("third", at: 200))
        #expect(try await store.recent().map(\.raw) == ["third", "second", "first"])
    }

    @Test("deleting removes the row and its index entry together")
    func deletion() async throws {
        let store = try HistoryStore(path: ":memory:")
        let e = entry("qidiruv matni")
        try await store.insert(e)
        #expect(try await store.search("qidiruv").count == 1)
        try await store.delete(id: e.id)
        #expect(try await store.count() == 0)
        #expect(try await store.search("qidiruv").isEmpty, "a stale index entry would be a ghost")
    }

    @Test("re-inserting the same id updates rather than duplicating, index included")
    func upsert() async throws {
        let store = try HistoryStore(path: ":memory:")
        var e = entry("original text")
        try await store.insert(e)
        e.raw = "replacement text"
        e.result = "replacement text"
        try await store.insert(e)
        #expect(try await store.count() == 1)
        #expect(try await store.search("replacement").count == 1)
        #expect(try await store.search("original").isEmpty)
    }

    @Test("punctuation a user might type does not become a syntax error")
    func userInputIsNotQuerySyntax() async throws {
        // FTS5 treats -, *, ", OR and NEAR as syntax. A person searching for a hyphenated word
        // should get results, not an exception.
        let store = try HistoryStore(path: ":memory:")
        try await store.insert(entry("oq-qora rangli"))
        for query in ["oq-qora", "\"unbalanced", "a OR b", "star*", "NEAR(x y)", "-minus"] {
            _ = try await store.search(query)   // must not throw
        }
        #expect(try await store.search("oq-qora").count == 1)
    }

    @Test("an empty or whitespace query returns nothing rather than everything")
    func emptyQuery() async throws {
        let store = try HistoryStore(path: ":memory:")
        try await store.insert(entry("something"))
        #expect(try await store.search("").isEmpty)
        #expect(try await store.search("   ").isEmpty)
    }

    @Test("survives being closed and reopened on disk")
    func persistence() async throws {
        let path = NSTemporaryDirectory() + "kotiba-history-\(UUID().uuidString).sqlite"
        defer { try? FileManager.default.removeItem(atPath: path) }
        do {
            let store = try HistoryStore(path: path)
            try await store.insert(entry("saqlangan matn"))
            #expect(try await store.count() == 1)
        }
        let reopened = try HistoryStore(path: path)
        #expect(try await reopened.count() == 1)
        #expect(try await reopened.search("saqlangan").count == 1)
    }

    @Test("two connections to one file wait for each other instead of failing the write")
    func twoConnectionsDoNotFail() async throws {
        // The controller reopens its stores on every settings change, and a dictation settling at
        // that moment still writes through the old one — two connections on one WAL file.
        let path = NSTemporaryDirectory() + "kotiba-history-\(UUID().uuidString).sqlite"
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) } }
        let a = try HistoryStore(path: path)
        let b = try HistoryStore(path: path)
        let failures = await withTaskGroup(of: Int.self) { group -> Int in
            for i in 0..<200 {
                let store = i.isMultiple(of: 2) ? a : b
                group.addTask {
                    do {
                        try await store.insert(entry("entry \(i)", at: Double(i)))
                        try await store.prune(keeping: 150)
                        return 0
                    } catch { return 1 }
                }
            }
            return await group.reduce(0, +)
        }
        #expect(failures == 0, "\(failures) of 200 writes failed")
    }
}

