import Foundation
import Security

// Task D-07. Where the user's own API key lives.
//
// The Keychain, not UserDefaults and not a file. The key is the user's money: a plist in
// ~/Library/Preferences is world-readable by anything running as them, and this machine has
// already had a root-malware window once. `kSecAttrAccessibleAfterFirstUnlock` rather than
// `WhenUnlocked` because a polish request can be triggered by a hotkey while the screen is
// locked, and failing then with "no key" would be a mystery to debug.
//
// Bring-your-own-key is the whole model. Kotiba ships no key, proxies nothing, and the request
// goes from this machine to the endpoint the user named. The only thing stored is the string.

/// The four Security framework calls `Keychain` makes, and nothing else — so its logic (update or
/// add, empty means remove, missing is not an error, attributes without the secret) can run
/// against a keychain that is not the user's. `SystemSecItems` is the login keychain; the tests
/// hand in an in-memory one. They used to write `test-<uuid>` items into the real login keychain
/// on every `swift test`, which the brief forbids and which a crash mid-test would have left
/// behind.
protocol SecItemCalls: Sendable {
    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus
    func add(_ attributes: [String: Any]) -> OSStatus
    func copyMatching(_ query: [String: Any], _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

/// The login keychain.
struct SystemSecItems: SecItemCalls {
    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }
    func add(_ attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }
    func copyMatching(_ query: [String: Any], _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
        SecItemCopyMatching(query as CFDictionary, result)
    }
    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

public enum Keychain {

    public enum Failure: Error, Sendable, Equatable {
        case unexpectedStatus(OSStatus)
        case malformedData

        public var reason: String {
            switch self {
            case .unexpectedStatus(let status):
                let message = SecCopyErrorMessageString(status, nil) as String?
                return "Keychain error \(status)\(message.map { " — \($0)" } ?? "")"
            case .malformedData:
                return "the stored value is not valid UTF-8"
            }
        }
    }

    /// One service, several accounts — one per endpoint, so a user can keep an OpenAI key and
    /// an OpenRouter key at once without either overwriting the other.
    static let service = "uz.kotiba.app"
    /// The service the same items were filed under before the rename from Kotib. Read once, by
    /// `RenameMigration`, and never written.
    static let legacyService = "uz.kotib.app"

    public static func set(_ value: String, account: String) throws {
        try set(value, account: account, service: service)
    }

    static func set(_ value: String, account: String, service: String,
                    calls: any SecItemCalls = SystemSecItems()) throws {
        guard !value.isEmpty else {
            try remove(account: account, service: service, calls: calls)
            return
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        let status = calls.update(query, attributes)
        switch status {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var insert = query
            insert.merge(attributes) { current, _ in current }
            let added = calls.add(insert)
            guard added == errSecSuccess else { throw Failure.unexpectedStatus(added) }
        default:
            throw Failure.unexpectedStatus(status)
        }
    }

    /// nil when there is no key, which is a normal state — polish is optional and the app is
    /// fully usable without one.
    public static func get(account: String) throws -> String? {
        try get(account: account, service: service)
    }

    static func get(account: String, service: String,
                    calls: any SecItemCalls = SystemSecItems()) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = calls.copyMatching(query, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { throw Failure.malformedData }
            guard let string = String(data: data, encoding: .utf8) else {
                throw Failure.malformedData
            }
            return string
        case errSecItemNotFound:
            return nil
        default:
            throw Failure.unexpectedStatus(status)
        }
    }

    public static func remove(account: String) throws {
        try remove(account: account, service: service)
    }

    static func remove(account: String, service: String,
                       calls: any SecItemCalls = SystemSecItems()) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = calls.delete(query)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw Failure.unexpectedStatus(status)
        }
    }

    /// Every account filed under `service`, from the items' attributes only. Asking for
    /// attributes and not data is what keeps this silent: an item another app created (the old
    /// Kotib, for `legacyService`) prompts for its *secret*, not for its existence.
    static func accounts(service: String,
                         calls: any SecItemCalls = SystemSecItems()) throws -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var items: CFTypeRef?
        let status = calls.copyMatching(query, &items)
        switch status {
        case errSecSuccess:
            let rows = items as? [[String: Any]] ?? []
            return rows.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
        case errSecItemNotFound:
            return []
        default:
            throw Failure.unexpectedStatus(status)
        }
    }

    /// Whether a key exists, without reading it. The settings pane shows "key set" from this,
    /// so displaying the state never pulls the secret into memory.
    public static func has(account: String) -> Bool {
        has(account: account, service: service)
    }

    static func has(account: String, service: String,
                    calls: any SecItemCalls = SystemSecItems()) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        return calls.copyMatching(query, nil) == errSecSuccess
    }
}

// `"\(error)"` is this codebase's interchange format at the module boundaries — 23 sites convert
// that way — and for an `Error` enum without `CustomStringConvertible` it reflects the case name
// instead of the diagnosis. A denied microphone reached the user as
// `engineFailedToStart("permissionDenied")`, which appears verbatim in real diagnostics. Each of
// these types already writes the actionable sentence in `reason`; this is what makes the
// interchange format use it, with no call-site changes.

extension Keychain.Failure: CustomStringConvertible {
    public var description: String { reason }
}
