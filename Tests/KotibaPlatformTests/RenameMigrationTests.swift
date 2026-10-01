import Foundation
import Testing

@testable import KotibaPlatform

// Kotib → Kotiba, against scratch directories, a scratch defaults suite and a dictionary for the
// Keychain. Nothing here reads or writes the real `~/Library/Application Support`, the real
// `uz.kotib.app` / `uz.kotiba.app` domains or the login keychain.

private final class FakeSecrets: RenameMigration.SecretStore, @unchecked Sendable {
    var items: [String: String] = [:]          // "service|account" → value
    var unreadable: Set<String> = []            // "service|account" that throws, like Deny
    struct Denied: Error {}

    func accounts(service: String) throws -> [String] {
        items.keys.filter { $0.hasPrefix(service + "|") }
            .map { String($0.dropFirst(service.count + 1)) }.sorted()
    }
    func read(service: String, account: String) throws -> String? {
        if unreadable.contains(service + "|" + account) { throw Denied() }
        return items[service + "|" + account]
    }
    func write(_ value: String, service: String, account: String) throws {
        items[service + "|" + account] = value
    }
}

private struct Sandbox {
    let parent: URL
    let store: UserDefaults
    var legacy: URL { parent.appendingPathComponent("Kotib") }
    var current: URL { parent.appendingPathComponent("Kotiba") }

    init() throws {
        parent = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-rename-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        store = UserDefaults(suiteName: "kotiba-rename-\(UUID().uuidString)")!
    }

    func write(_ text: String, _ relative: String, in root: URL) throws {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    func read(_ relative: String, in root: URL) -> String? {
        (try? Data(contentsOf: root.appendingPathComponent(relative)))
            .map { String(decoding: $0, as: UTF8.self) }
    }

    func exists(_ relative: String, in root: URL) -> Bool {
        FileManager.default.fileExists(atPath: root.appendingPathComponent(relative).path)
    }

    func migration(legacyDefaults: [String: Any]? = nil, secrets: FakeSecrets? = nil,
                   running: Bool = false) -> RenameMigration {
        RenameMigration(supportParent: parent, store: store,
                        legacyDefaults: { legacyDefaults }, secrets: secrets,
                        legacyAppIsRunning: { running })
    }

    func tearDown() { try? FileManager.default.removeItem(at: parent) }
}

@Suite("Rename migration (Kotib → Kotiba)")
struct RenameMigrationTests {

    @Test("a fresh install does nothing and never asks for the permissions again")
    func freshInstall() throws {
        let box = try Sandbox(); defer { box.tearDown() }
        let outcome = box.migration().run()
        #expect(!outcome.carriedAnything)
        #expect(!box.exists("Kotiba", in: box.parent))
        #expect(box.store.bool(forKey: RenameMigration.completedKey))
        #expect(!box.store.bool(forKey: RenameMigration.regrantFlagKey))
    }

    @Test("the support directory is renamed in place, not copied")
    func wholeDirectoryIsMoved() throws {
        let box = try Sandbox(); defer { box.tearDown() }
        try box.write("weights", "models/ggml-uzbek-stt-v1-q5_0.bin", in: box.legacy)
        try box.write("db", "history.sqlite", in: box.legacy)
        try box.write("wal", "history.sqlite-wal", in: box.legacy)
        let model = box.legacy.appendingPathComponent("models/ggml-uzbek-stt-v1-q5_0.bin")
        let inodeBefore = try FileManager.default.attributesOfItem(atPath: model.path)[.systemFileNumber]
            as? Int

        let outcome = box.migration().run()

        #expect(outcome.renamedDirectory)
        #expect(!box.exists("Kotib", in: box.parent))
        #expect(box.read("history.sqlite-wal", in: box.current) == "wal")
        let moved = box.current.appendingPathComponent("models/ggml-uzbek-stt-v1-q5_0.bin")
        let inodeAfter = try FileManager.default.attributesOfItem(atPath: moved.path)[.systemFileNumber]
            as? Int
        #expect(inodeBefore != nil && inodeBefore == inodeAfter, "same file, so a move, not a copy")
        #expect(box.store.bool(forKey: RenameMigration.regrantFlagKey))
    }

    @Test("an existing Kotiba directory is merged, and the old files win whole")
    func mergeKeepsTheOldData() throws {
        let box = try Sandbox(); defer { box.tearDown() }
        // What the new app (or a non-hermetic test) left: an empty history, open in WAL mode.
        try box.write("new-empty", "history.sqlite", in: box.current)
        try box.write("new-shm", "history.sqlite-shm", in: box.current)
        try box.write("", "diagnostics.jsonl", in: box.current)
        try box.write("y", "models/y.bin", in: box.current)
        // The user's real data, cleanly closed: no WAL beside it.
        try box.write("old-history", "history.sqlite", in: box.legacy)
        try box.write("old-log", "diagnostics.jsonl", in: box.legacy)
        try box.write("x", "models/x.bin", in: box.legacy)

        let outcome = box.migration().run()

        #expect(box.read("history.sqlite", in: box.current) == "old-history")
        // The new -shm must not be left beside the old database.
        #expect(!box.exists("history.sqlite-shm", in: box.current))
        #expect(box.read("history.sqlite.before-rename", in: box.current) == "new-empty")
        #expect(box.read("history.sqlite-shm.before-rename", in: box.current) == "new-shm")
        #expect(box.read("diagnostics.jsonl", in: box.current) == "old-log")
        #expect(box.exists("models/x.bin", in: box.current))
        #expect(box.exists("models/y.bin", in: box.current))
        #expect(!box.exists("Kotib", in: box.parent), "an emptied old directory is removed")
        #expect(outcome.setAside.contains("history.sqlite"))
        #expect(outcome.merged.contains("models/x.bin"))
        #expect(outcome.problems.isEmpty)
    }

    @Test("an old database's WAL travels with it")
    func walTravelsWithDatabase() throws {
        let box = try Sandbox(); defer { box.tearDown() }
        try box.write("new", "history.sqlite", in: box.current)
        try box.write("old", "history.sqlite", in: box.legacy)
        try box.write("old-wal", "history.sqlite-wal", in: box.legacy)

        box.migration().run()

        #expect(box.read("history.sqlite", in: box.current) == "old")
        #expect(box.read("history.sqlite-wal", in: box.current) == "old-wal")
    }

    @Test("nothing moves while the old app is running, and the next launch finishes")
    func deferredWhileLegacyRuns() throws {
        let box = try Sandbox(); defer { box.tearDown() }
        try box.write("old-history", "history.sqlite", in: box.legacy)
        let legacy: [String: Any] = ["uz.kotib.settings.v1": Data("{}".utf8)]

        let first = box.migration(legacyDefaults: legacy, running: true).run()
        #expect(first.deferredBecauseLegacyAppRunning)
        #expect(box.exists("history.sqlite", in: box.legacy))
        #expect(box.store.object(forKey: "uz.kotiba.settings.v1") == nil)
        #expect(!box.store.bool(forKey: RenameMigration.completedKey))

        let second = box.migration(legacyDefaults: legacy).run()
        #expect(second.renamedDirectory)
        #expect(box.read("history.sqlite", in: box.current) == "old-history")
    }

    @Test("a completed migration never runs again")
    func runsOnce() throws {
        let box = try Sandbox(); defer { box.tearDown() }
        try box.write("a", "history.sqlite", in: box.legacy)
        box.migration().run()
        try box.write("b", "late.txt", in: box.legacy)

        let again = box.migration().run()
        #expect(again.alreadyCompleted)
        #expect(box.exists("late.txt", in: box.legacy), "an old install next to this one is left alone")
    }

    @Test("the old defaults domain is imported under the new key names, never over new values")
    func defaultsImport() throws {
        let box = try Sandbox(); defer { box.tearDown() }
        let blob = Data(#"{"hasCompletedOnboarding":true}"#.utf8)
        box.store.set("already here", forKey: "shared")
        let outcome = box.migration(legacyDefaults: [
            "uz.kotib.settings.v1": blob,
            "NSStatusItem Preferred Position Item-0": 1234.0,
            "shared": "from the old app",
        ]).run()

        #expect(box.store.data(forKey: "uz.kotiba.settings.v1") == blob)
        #expect(box.store.object(forKey: "uz.kotib.settings.v1") == nil)
        #expect(box.store.double(forKey: "NSStatusItem Preferred Position Item-0") == 1234)
        #expect(box.store.string(forKey: "shared") == "already here")
        #expect(!outcome.importedDefaults.contains("shared"))
        #expect(box.store.bool(forKey: RenameMigration.regrantFlagKey))
    }

    @Test("Keychain items are copied to the new service; a key already set there is kept")
    func secretsCopied() throws {
        let box = try Sandbox(); defer { box.tearDown() }
        let secrets = FakeSecrets()
        secrets.items = [
            "uz.kotib.app|polish-default": "sk-old",
            "uz.kotib.app|openrouter": "or-old",
            "uz.kotiba.app|openrouter": "or-new",
            "uz.kotib.app|denied": "x",
        ]
        secrets.unreadable = ["uz.kotib.app|denied"]

        let outcome = box.migration(legacyDefaults: ["k": 1], secrets: secrets).run()

        #expect(secrets.items["uz.kotiba.app|polish-default"] == "sk-old")
        #expect(secrets.items["uz.kotiba.app|openrouter"] == "or-new")
        #expect(secrets.items["uz.kotib.app|polish-default"] == "sk-old", "the old item is left")
        #expect(outcome.copiedSecrets == ["polish-default"])
        #expect(outcome.problems.count == 1, "a Deny is reported, not fatal")
    }

    @Test("renamed defaults keys")
    func keyNames() {
        #expect(RenameMigration.renamedKey("uz.kotib.settings.v1") == "uz.kotiba.settings.v1")
        #expect(RenameMigration.renamedKey("uz.kotiba.settings.v1") == "uz.kotiba.settings.v1")
        #expect(RenameMigration.renamedKey("AppleLanguages") == "AppleLanguages")
    }
}
