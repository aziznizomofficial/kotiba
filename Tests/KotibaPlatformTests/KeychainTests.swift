import Foundation
import Testing

@testable import KotibaPlatform

#if os(macOS)

// Never the real login keychain: every test runs `Keychain`'s own logic against `InMemorySecItems`,
// which answers the four Security calls the way SecItem does for a generic password — update of
// a missing item is errSecItemNotFound, add of an existing one is errSecDuplicateItem, a match
// returns data or attributes as asked. These used to write `test-<uuid>` items into the user's
// login keychain on every run.

/// A generic-password keychain in memory, keyed by service and account.
final class InMemorySecItems: SecItemCalls, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: [String: Data]] = [:]
    private(set) var calls: [String] = []

    private func key(_ query: [String: Any]) -> (String, String?) {
        (query[kSecAttrService as String] as? String ?? "",
         query[kSecAttrAccount as String] as? String)
    }

    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        lock.withLock {
            calls.append("update")
            let (service, account) = key(query)
            guard let account, items[service]?[account] != nil else { return errSecItemNotFound }
            items[service]?[account] = attributes[kSecValueData as String] as? Data
            return errSecSuccess
        }
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        lock.withLock {
            calls.append("add")
            let (service, account) = key(attributes)
            guard let account else { return errSecParam }
            guard items[service]?[account] == nil else { return errSecDuplicateItem }
            items[service, default: [:]][account] = attributes[kSecValueData as String] as? Data
            return errSecSuccess
        }
    }

    func copyMatching(_ query: [String: Any], _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
        lock.withLock {
            calls.append(query[kSecReturnData as String] != nil ? "copy-data" : "copy")
            let (service, account) = key(query)
            let matches = (items[service] ?? [:]).filter { account == nil || $0.key == account }
            guard !matches.isEmpty else { return errSecItemNotFound }
            if query[kSecReturnData as String] as? Bool == true, let first = matches.first {
                result?.pointee = first.value as CFData
            } else if query[kSecReturnAttributes as String] as? Bool == true {
                result?.pointee = matches.keys.map { [kSecAttrAccount as String: $0] } as CFArray
            }
            return errSecSuccess
        }
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        lock.withLock {
            calls.append("delete")
            let (service, account) = key(query)
            guard let account, items[service]?[account] != nil else { return errSecItemNotFound }
            items[service]?[account] = nil
            return errSecSuccess
        }
    }
}

private let service = "uz.kotiba.tests"

@Suite("Keychain")
struct KeychainTests {

    let store = InMemorySecItems()

    @Test("a key round-trips")
    func roundTrip() throws {
        #expect(try Keychain.get(account: "a", service: service, calls: store) == nil)
        #expect(!Keychain.has(account: "a", service: service, calls: store))

        try Keychain.set("sk-not-a-real-key", account: "a", service: service, calls: store)
        #expect(try Keychain.get(account: "a", service: service, calls: store) == "sk-not-a-real-key")
        #expect(Keychain.has(account: "a", service: service, calls: store))
    }

    @Test("setting twice replaces rather than duplicating")
    func replaces() throws {
        // SecItemAdd on an existing item returns errSecDuplicateItem. If this were add-only,
        // changing a key would silently keep using the old one — or throw.
        try Keychain.set("first", account: "a", service: service, calls: store)
        try Keychain.set("second", account: "a", service: service, calls: store)
        #expect(try Keychain.get(account: "a", service: service, calls: store) == "second")
        #expect(store.calls.filter { $0 == "add" }.count == 1, "\(store.calls)")
    }

    @Test("two accounts do not collide")
    func accountsAreSeparate() throws {
        // One key per endpoint: a user with both an OpenAI and an OpenRouter key must be able
        // to keep both.
        try Keychain.set("key-a", account: "openai", service: service, calls: store)
        try Keychain.set("key-b", account: "openrouter", service: service, calls: store)
        #expect(try Keychain.get(account: "openai", service: service, calls: store) == "key-a")
        #expect(try Keychain.get(account: "openrouter", service: service, calls: store) == "key-b")
        #expect(try Keychain.accounts(service: service, calls: store) == ["openai", "openrouter"])
    }

    @Test("setting an empty string removes the item rather than storing nothing")
    func emptyRemoves() throws {
        // Clearing the field in the settings pane must actually clear the key, not leave an
        // empty one behind that reads as "a key is set".
        try Keychain.set("something", account: "a", service: service, calls: store)
        try Keychain.set("", account: "a", service: service, calls: store)
        #expect(!Keychain.has(account: "a", service: service, calls: store))
        #expect(try Keychain.get(account: "a", service: service, calls: store) == nil)
    }

    @Test("removing something that is not there is not an error")
    func removeIsIdempotent() throws {
        try Keychain.remove(account: "never-set", service: service, calls: store)
    }

    @Test("has() answers without pulling the secret into memory")
    func hasDoesNotReturnData() throws {
        try Keychain.set("secret", account: "a", service: service, calls: store)
        #expect(Keychain.has(account: "a", service: service, calls: store))
        // The one thing a real keychain could not show: the query asked for no data at all.
        #expect(!store.calls.contains("copy-data"), "\(store.calls)")
        try Keychain.remove(account: "a", service: service, calls: store)
        #expect(!Keychain.has(account: "a", service: service, calls: store))
    }

    @Test("a unicode key survives, because an endpoint may hand out anything")
    func unicodeSurvives() throws {
        let key = "kalit-oʻzbekcha-🔑-\u{02BB}"
        try Keychain.set(key, account: "a", service: service, calls: store)
        #expect(try Keychain.get(account: "a", service: service, calls: store) == key)
    }

    @Test("a status the keychain did not expect is thrown with its code")
    func unexpectedStatusThrows() {
        struct Locked: SecItemCalls {
            func update(_ q: [String: Any], _ a: [String: Any]) -> OSStatus { errSecInteractionNotAllowed }
            func add(_ a: [String: Any]) -> OSStatus { errSecInteractionNotAllowed }
            func copyMatching(_ q: [String: Any], _ r: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
                errSecInteractionNotAllowed
            }
            func delete(_ q: [String: Any]) -> OSStatus { errSecInteractionNotAllowed }
        }
        #expect(throws: Keychain.Failure.unexpectedStatus(errSecInteractionNotAllowed)) {
            try Keychain.set("x", account: "a", service: service, calls: Locked())
        }
        #expect(throws: Keychain.Failure.unexpectedStatus(errSecInteractionNotAllowed)) {
            _ = try Keychain.get(account: "a", service: service, calls: Locked())
        }
    }
}

@Suite("Keychain failures explain themselves")
struct KeychainFailureTests {

    @Test("a status code becomes a sentence")
    func reasons() {
        let failure = Keychain.Failure.unexpectedStatus(errSecItemNotFound)
        #expect(failure.reason.contains("\(errSecItemNotFound)"))
        #expect(Keychain.Failure.malformedData.reason.contains("UTF-8"))
    }
}

#endif
