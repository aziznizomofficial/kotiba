import Foundation

// The app was called Kotib until 1.0 and is Kotiba from then on. Everything that carries the name
// changed with it — the bundle id (`uz.kotib.app` → `uz.kotiba.app`), so the defaults domain; the
// support directory (`~/Library/Application Support/Kotib` → `…/Kotiba`); the Keychain service —
// and a user who had the old app would otherwise open the new one to factory settings, an empty
// history, a "No Uzbek model" blocker over 5 GB of models sitting one directory away, and no
// polish key. This runs once, at launch, before anything reads any of those.
//
// What it does, in order:
//
//   1. **The support directory is MOVED, never copied.** The models alone are ~5 GB, the disk is
//      tight, and a rename within one volume is instant and atomic. When `Kotiba/` does not exist
//      yet, the whole directory is renamed in one call. When it does — a launch that had to defer
//      (below), or a `make test` from before the tests were hermetic — the two are merged item by
//      item, recursing into directories that exist on both sides. On a clash between two files
//      the OLD one wins, because until this has completed the new directory can only hold what a
//      few minutes of the new app wrote; the new file is renamed aside (`name.before-rename`),
//      never deleted. SQLite's `-wal`/`-shm`/`-journal` travel with their database both ways: a
//      WAL left beside a different database is replayed into it.
//   2. **The old defaults domain is imported** key by key, without overwriting anything the new
//      domain already has. Keys named `uz.kotib.…` land as `uz.kotiba.…`; `AppSettings.load()`
//      also still reads the old settings key, so a blob that only exists under it is not lost.
//   3. **Keychain items are copied** from the old service to the new one, account by account.
//      The item belongs to the old app's signature, so reading it may ask the user once. The old
//      item is left in place: deleting another app's item is a second prompt for no gain.
//
// What it cannot do: macOS keys Input Monitoring, Accessibility and the microphone on the bundle
// id, and those grants do not move with anything here. `regrantFlagKey` is set when something was
// carried over, and Home says so (see `RenameNotice.swift` in KotibaUI) until all three are back.
//
// The old always-on agent (`uz.kotib.app.agent`) belonged to the old bundle: `SMAppService` only
// manages the calling bundle's own plists, so this app cannot unregister it. It is inert once the
// old app is gone (launchd has no executable to start), and harmless while the old app is still
// installed only if always-on was switched off in it first — see docs/SETUP.md, "Upgrading from
// Kotib".
//
// If the old app is RUNNING, nothing is moved: it holds the SQLite history open, and moving a
// live database out from under its writer is how a WAL ends up beside the wrong file. The launch
// continues on fresh state, `deferredBecauseLegacyAppRunning` is reported, and the next launch
// finishes the job through the merge path.

public struct RenameMigration {

    public static let legacyDirectoryName = "Kotib"
    public static let directoryName = "Kotiba"
    public static let legacyBundleIdentifier = "uz.kotib.app"
    public static let legacyAgentLabel = "uz.kotib.app.agent"
    /// Set, in the new domain, once a launch has run the migration to the end.
    public static let completedKey = "uz.kotiba.renameMigration.completed"
    /// Set when anything was carried over, and cleared by the app once the three permissions
    /// are granted again. Read by `AppSettings.awaitingRegrantAfterRename`.
    public static let regrantFlagKey = "uz.kotiba.renameMigration.regrantPermissions"
    /// Appended to a file of the new directory that an old file of the same name replaced.
    public static let setAsideSuffix = ".before-rename"

    /// Where the secrets live, as far as this migration needs to know. The app passes the real
    /// Keychain; tests pass a dictionary. Nothing here ever touches the real one from a test.
    public protocol SecretStore {
        func accounts(service: String) throws -> [String]
        func read(service: String, account: String) throws -> String?
        func write(_ value: String, service: String, account: String) throws
    }

    public struct Outcome: Equatable, Sendable {
        /// The whole old directory became the new one in a single rename.
        public var renamedDirectory = false
        /// Relative paths moved one by one by the merge.
        public var merged: [String] = []
        /// Relative paths of new-side files renamed aside because an old file replaced them.
        public var setAside: [String] = []
        /// Defaults keys written into the new domain (under their new names).
        public var importedDefaults: [String] = []
        /// Keychain accounts copied to the new service.
        public var copiedSecrets: [String] = []
        /// One sentence per thing that did not work. Nothing here is fatal.
        public var problems: [String] = []
        public var deferredBecauseLegacyAppRunning = false
        /// The migration had already completed on an earlier launch.
        public var alreadyCompleted = false

        public var carriedAnything: Bool {
            renamedDirectory || !merged.isEmpty || !importedDefaults.isEmpty
                || !copiedSecrets.isEmpty
        }
    }

    /// `~/Library/Application Support` in the app; a scratch directory in tests.
    let supportParent: URL
    /// The new app's defaults (`.standard` in the app).
    let store: UserDefaults
    /// The old domain's persisted keys, or nil when there is none.
    let legacyDefaults: () -> [String: Any]?
    let secrets: (any SecretStore)?
    let legacySecretService: String
    let secretService: String
    let legacyAppIsRunning: () -> Bool
    let fileManager: FileManager

    public init(supportParent: URL,
                store: UserDefaults,
                legacyDefaults: @escaping () -> [String: Any]?,
                secrets: (any SecretStore)?,
                legacySecretService: String = "uz.kotib.app",
                secretService: String = "uz.kotiba.app",
                legacyAppIsRunning: @escaping () -> Bool,
                fileManager: FileManager = .default) {
        self.supportParent = supportParent
        self.store = store
        self.legacyDefaults = legacyDefaults
        self.secrets = secrets
        self.legacySecretService = legacySecretService
        self.secretService = secretService
        self.legacyAppIsRunning = legacyAppIsRunning
        self.fileManager = fileManager
    }

    /// The app's configuration: the real directories, domain and Keychain.
    public static func live(legacyAppIsRunning: @escaping () -> Bool) -> RenameMigration {
        RenameMigration(
            supportParent: URL.applicationSupportDirectory,
            store: .standard,
            legacyDefaults: { UserDefaults.standard.persistentDomain(forName: legacyBundleIdentifier) },
            secrets: SystemKeychain(),
            legacyAppIsRunning: legacyAppIsRunning)
    }

    var legacyDirectory: URL {
        supportParent.appendingPathComponent(Self.legacyDirectoryName, isDirectory: true)
    }
    var directory: URL {
        supportParent.appendingPathComponent(Self.directoryName, isDirectory: true)
    }

    @discardableResult
    public func run() -> Outcome {
        var outcome = Outcome()
        if store.bool(forKey: Self.completedKey) {
            outcome.alreadyCompleted = true
            return outcome
        }
        let hasLegacyDirectory = fileManager.fileExists(atPath: legacyDirectory.path)
        let legacyDomain = legacyDefaults() ?? [:]
        // Nothing of the old app on this machine: a fresh install. Marked done so a later
        // install of the old app next to this one is never merged in behind the user's back.
        if !hasLegacyDirectory, legacyDomain.isEmpty {
            store.set(true, forKey: Self.completedKey)
            return outcome
        }
        if legacyAppIsRunning() {
            outcome.deferredBecauseLegacyAppRunning = true
            return outcome
        }

        if hasLegacyDirectory { moveSupportDirectory(into: &outcome) }
        importDefaults(legacyDomain, into: &outcome)
        copySecrets(into: &outcome)

        if outcome.carriedAnything { store.set(true, forKey: Self.regrantFlagKey) }
        store.set(true, forKey: Self.completedKey)
        return outcome
    }

    // MARK: 1. The directory

    func moveSupportDirectory(into outcome: inout Outcome) {
        if !fileManager.fileExists(atPath: directory.path) {
            do {
                try fileManager.moveItem(at: legacyDirectory, to: directory)
                outcome.renamedDirectory = true
            } catch {
                outcome.problems.append("could not rename \(legacyDirectory.path) to "
                                        + "\(directory.lastPathComponent): \(error.localizedDescription)")
            }
            return
        }
        merge(from: legacyDirectory, into: directory, relative: "", outcome: &outcome)
        // Only an empty old directory is removed; anything left in it is something the merge
        // reported as a problem, and the user may want it.
        if let left = try? fileManager.contentsOfDirectory(atPath: legacyDirectory.path),
           left.filter({ $0 != ".DS_Store" }).isEmpty {
            try? fileManager.removeItem(at: legacyDirectory)
        }
    }

    /// SQLite's companions, which must stay beside the database they belong to.
    static let sqliteCompanions = ["-wal", "-shm", "-journal"]

    private func merge(from source: URL, into destination: URL, relative: String,
                       outcome: inout Outcome) {
        guard let names = try? fileManager.contentsOfDirectory(atPath: source.path) else {
            outcome.problems.append("could not list \(source.path)")
            return
        }
        // Companions move with their database, not on their own.
        let databases = Set(names.filter { name in
            Self.sqliteCompanions.contains { names.contains(name + $0) }
                || name.hasSuffix(".sqlite") || name.hasSuffix(".db")
        })
        let companions = Set(databases.flatMap { db in Self.sqliteCompanions.map { db + $0 } })
        for name in names.sorted() where name != ".DS_Store" && !companions.contains(name) {
            let from = source.appendingPathComponent(name)
            let to = destination.appendingPathComponent(name)
            let path = relative.isEmpty ? name : relative + "/" + name
            let family = databases.contains(name) ? [name] + Self.sqliteCompanions.map { name + $0 }
                                                   : [name]
            var isDirectory: ObjCBool = false
            let exists = fileManager.fileExists(atPath: to.path, isDirectory: &isDirectory)
            var fromIsDirectory: ObjCBool = false
            fileManager.fileExists(atPath: from.path, isDirectory: &fromIsDirectory)

            if exists, isDirectory.boolValue, fromIsDirectory.boolValue {
                merge(from: from, into: to, relative: path, outcome: &outcome)
                if let left = try? fileManager.contentsOfDirectory(atPath: from.path),
                   left.filter({ $0 != ".DS_Store" }).isEmpty {
                    try? fileManager.removeItem(at: from)
                }
                continue
            }
            if exists || family.dropFirst().contains(where: {
                fileManager.fileExists(atPath: destination.appendingPathComponent($0).path)
            }) {
                // The old one wins; the new one — and its companions — step aside, whole.
                for member in family {
                    let clash = destination.appendingPathComponent(member)
                    guard fileManager.fileExists(atPath: clash.path) else { continue }
                    let aside = destination.appendingPathComponent(member + Self.setAsideSuffix)
                    try? fileManager.removeItem(at: aside)
                    do {
                        try fileManager.moveItem(at: clash, to: aside)
                        outcome.setAside.append(relative.isEmpty ? member : relative + "/" + member)
                    } catch {
                        outcome.problems.append("could not set aside \(clash.path): "
                                                + error.localizedDescription)
                    }
                }
            }
            for member in family {
                let memberFrom = source.appendingPathComponent(member)
                guard fileManager.fileExists(atPath: memberFrom.path) else { continue }
                let memberPath = relative.isEmpty ? member : relative + "/" + member
                do {
                    try fileManager.moveItem(at: memberFrom,
                                             to: destination.appendingPathComponent(member))
                    outcome.merged.append(memberPath)
                } catch {
                    outcome.problems.append("could not move \(memberFrom.path): "
                                            + error.localizedDescription)
                }
            }
        }
    }

    // MARK: 2. Defaults

    /// `uz.kotib.settings.v1` → `uz.kotiba.settings.v1`, and so on. Other keys keep their name.
    static func renamedKey(_ key: String) -> String {
        key.hasPrefix("uz.kotib.") ? "uz.kotiba." + key.dropFirst("uz.kotib.".count) : key
    }

    func importDefaults(_ legacy: [String: Any], into outcome: inout Outcome) {
        for (key, value) in legacy.sorted(by: { $0.key < $1.key }) {
            let newKey = Self.renamedKey(key)
            guard store.object(forKey: newKey) == nil else { continue }
            store.set(value, forKey: newKey)
            outcome.importedDefaults.append(newKey)
        }
    }

    // MARK: 3. Keychain

    func copySecrets(into outcome: inout Outcome) {
        guard let secrets else { return }
        let accounts: [String]
        do {
            accounts = try secrets.accounts(service: legacySecretService)
        } catch {
            outcome.problems.append("could not list the old Keychain items: \(error)")
            return
        }
        for account in accounts {
            do {
                // Never over a key the user has already set in the new app.
                if try secrets.read(service: secretService, account: account) != nil { continue }
                guard let value = try secrets.read(service: legacySecretService, account: account),
                      !value.isEmpty else { continue }
                try secrets.write(value, service: secretService, account: account)
                outcome.copiedSecrets.append(account)
            } catch {
                // Typically the user choosing Deny at the Keychain prompt. The key can be
                // entered again in Settings › Modes; the old item is untouched.
                outcome.problems.append("could not copy the Keychain item \(account): \(error)")
            }
        }
    }
}

/// The real Keychain, behind the migration's protocol.
struct SystemKeychain: RenameMigration.SecretStore {
    func accounts(service: String) throws -> [String] { try Keychain.accounts(service: service) }
    func read(service: String, account: String) throws -> String? {
        try Keychain.get(account: account, service: service)
    }
    func write(_ value: String, service: String, account: String) throws {
        try Keychain.set(value, account: account, service: service)
    }
}
