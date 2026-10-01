import Foundation
import SQLite3

// Tasks U-02 and U-03.
//
// Three text stages are persisted separately — raw, result, polished — copied from
// a commercial dictation app, which keeps `rawResult` → `result` → `llmResult`. Keeping all three is what
// makes "the polish made it worse" a recoverable situation rather than a lost one.
//
// The tokenizer is `unicode61`, never `porter`, and this is not a preference. Measured here:
//
//     CREATE VIRTUAL TABLE t USING fts5(x, tokenize='porter');
//     INSERT INTO t VALUES('bordies');  SELECT count(*) FROM t WHERE t MATCH 'bordie';  → 1
//
//     …the same with tokenize='unicode61'                                               → 0
//
// Porter strips English suffixes, so it merges two distinct Uzbek word forms into one term.
// Uzbek is agglutinative — the suffixes are the grammar — so English stemming does not merely
// fail to help, it produces false matches. a commercial dictation app's own index uses porter.

public struct HistoryEntry: Sendable, Codable, Equatable, Identifiable {
    public var id: String
    public var startedAt: Date
    public var language: Language
    public var engineID: String
    /// Exactly what the engine emitted.
    public var raw: String
    /// After deterministic normalisation and replacements. This is what was inserted.
    public var result: String
    /// After the optional polish pass, when one ran and survived the guard.
    public var polished: String?
    public var audioSeconds: Double
    /// Relative to the store's audio directory. Nil when the recording was not kept.
    public var audioPath: String?

    public init(id: String = UUID().uuidString, startedAt: Date, language: Language,
                engineID: String, raw: String, result: String, polished: String? = nil,
                audioSeconds: Double = 0, audioPath: String? = nil) {
        self.id = id
        self.startedAt = startedAt
        self.language = language
        self.engineID = engineID
        self.raw = raw
        self.result = result
        self.polished = polished
        self.audioSeconds = audioSeconds
        self.audioPath = audioPath
    }

    /// What the user actually ended up with.
    public var final: String { polished ?? result }
}

public enum HistoryError: Error, Sendable {
    case cannotOpen(String)
    case sql(String)

    public var reason: String {
        switch self {
        case .cannotOpen(let p): return "could not open the history database at \(p)"
        case .sql(let m): return "sqlite: \(m)"
        }
    }
}

public actor HistoryStore {

    private let handle: Handle
    private var db: OpaquePointer { handle.db }

    /// `:memory:` for tests; a real path in the app's Application Support directory otherwise.
    public init(path: String) throws {
        var pointer: OpaquePointer?
        guard sqlite3_open(path, &pointer) == SQLITE_OK, let pointer else {
            // sqlite hands back a handle even when the open fails, and it must still be closed.
            sqlite3_close(pointer)
            throw HistoryError.cannotOpen(path)
        }
        // Wait for another connection's write rather than failing this one. There can be two:
        // the controller reopens its stores when settings change while a dictation settling at
        // that moment still writes through the old actor — and `make backup-local` checkpoints
        // the file from outside. Without it 183 of 200 interleaved writes from two connections
        // failed with SQLITE_BUSY, each one a dictation missing from history.
        sqlite3_busy_timeout(pointer, 5_000)
        handle = Handle(pointer)
        try Self.migrate(pointer)
    }

    /// Owns the sqlite3 handle and closes it exactly once, on the last reference.
    ///
    /// This used to be an `isolated deinit` (SE-0371) on the actor itself, which reads better
    /// and does not work: it makes the whole-module optimiser cycle. `swift build -c release`
    /// failed with a bare "circular reference" and no source location, while debug builds and
    /// xcodebuild's Release both accepted it — so the failure appeared in exactly one of the
    /// three ways this project is built. `-Xfrontend -debug-cycles` named it:
    /// `ActorIsolationRequest(HistoryStore.deinit)`.
    ///
    /// Wrapping the pointer instead gives a plain nonisolated deinit that touches nothing but
    /// the pointer, which is the same shape `WhisperContext` already uses for whisper's.
    private final class Handle: @unchecked Sendable {
        let db: OpaquePointer
        init(_ db: OpaquePointer) { self.db = db }
        deinit { sqlite3_close(db) }
    }

    private static func exec(_ db: OpaquePointer, _ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(error)
            throw HistoryError.sql(message)
        }
    }

    private static func migrate(_ db: OpaquePointer) throws {
        try exec(db, "PRAGMA journal_mode=WAL;")
        try exec(db, """
            CREATE TABLE IF NOT EXISTS entries (
                id            TEXT PRIMARY KEY,
                startedAt     REAL NOT NULL,
                language      TEXT NOT NULL,
                engineID      TEXT NOT NULL,
                raw           TEXT NOT NULL,
                result        TEXT NOT NULL,
                polished      TEXT,
                audioSeconds  REAL NOT NULL DEFAULT 0,
                audioPath     TEXT
            );
            """)
        try exec(db, "CREATE INDEX IF NOT EXISTS entries_time ON entries(startedAt DESC);")

        // unicode61 with remove_diacritics 0: the Uzbek okina is not a diacritic to be helpfully
        // discarded, it is a letter. Stripping it merges oʻ with o and gʻ with g.
        try exec(db, """
            CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
                raw, result, polished,
                content='entries', content_rowid='rowid',
                tokenize="unicode61 remove_diacritics 0"
            );
            """)
        for trigger in [
            """
            CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
              INSERT INTO entries_fts(rowid, raw, result, polished)
              VALUES (new.rowid, new.raw, new.result, new.polished);
            END;
            """,
            """
            CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
              INSERT INTO entries_fts(entries_fts, rowid, raw, result, polished)
              VALUES ('delete', old.rowid, old.raw, old.result, old.polished);
            END;
            """,
            """
            CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
              INSERT INTO entries_fts(entries_fts, rowid, raw, result, polished)
              VALUES ('delete', old.rowid, old.raw, old.result, old.polished);
              INSERT INTO entries_fts(rowid, raw, result, polished)
              VALUES (new.rowid, new.raw, new.result, new.polished);
            END;
            """,
        ] { try exec(db, trigger) }
    }

    // MARK: Writing

    public func insert(_ entry: HistoryEntry) throws {
        let sql = """
            INSERT OR REPLACE INTO entries
              (id, startedAt, language, engineID, raw, result, polished, audioSeconds, audioPath)
            VALUES (?,?,?,?,?,?,?,?,?);
            """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw lastError() }
        defer { sqlite3_finalize(stmt) }

        bind(stmt, 1, entry.id)
        sqlite3_bind_double(stmt, 2, entry.startedAt.timeIntervalSince1970)
        bind(stmt, 3, entry.language.rawValue)
        bind(stmt, 4, entry.engineID)
        bind(stmt, 5, entry.raw)
        bind(stmt, 6, entry.result)
        bind(stmt, 7, entry.polished)
        sqlite3_bind_double(stmt, 8, entry.audioSeconds)
        bind(stmt, 9, entry.audioPath)

        guard sqlite3_step(stmt) == SQLITE_DONE else { throw lastError() }
    }

    public func delete(id: String) throws {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "DELETE FROM entries WHERE id = ?;", -1, &stmt, nil)
            == SQLITE_OK else { throw lastError() }
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, id)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw lastError() }
    }

    /// Drop everything past the newest `limit` entries.
    ///
    /// `historyLimit` was persisted, round-tripped and tested, and nothing ever read it — there
    /// was no prune to read it *with*, so the only retention behaviour the app had was "keep
    /// everything, forever", behind a switch whose options are all or nothing. Every transcript
    /// the user has ever dictated accumulated here with an FTS index over the text.
    ///
    /// `limit <= 0` keeps everything, which is what the setting's own documentation says 0 means.
    public func prune(keeping limit: Int) throws {
        guard limit > 0 else { return }
        var stmt: OpaquePointer?
        // Newest by start time; `id` breaks ties so the set is deterministic when two dictations
        // share a timestamp, which the second-resolution clock makes possible.
        guard sqlite3_prepare_v2(db, """
            DELETE FROM entries WHERE id NOT IN (
              SELECT id FROM entries ORDER BY startedAt DESC, id DESC LIMIT ?
            );
            """, -1, &stmt, nil) == SQLITE_OK else { throw lastError() }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, Int64(limit))
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw lastError() }
    }

    // MARK: Reading

    public func count() throws -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT count(*) FROM entries;", -1, &stmt, nil) == SQLITE_OK
        else { throw lastError() }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int64(stmt, 0))
    }

    public func recent(limit: Int = 50) throws -> [HistoryEntry] {
        try query("""
            SELECT id, startedAt, language, engineID, raw, result, polished, audioSeconds, audioPath
            FROM entries ORDER BY startedAt DESC LIMIT \(max(0, limit));
            """, bindText: nil)
    }

    /// Full-text search across all three stages, newest first.
    public func search(_ text: String, limit: Int = 50) throws -> [HistoryEntry] {
        let term = Self.escapeForFTS5(text)
        guard !term.isEmpty else { return [] }
        return try query("""
            SELECT e.id, e.startedAt, e.language, e.engineID, e.raw, e.result, e.polished,
                   e.audioSeconds, e.audioPath
            FROM entries_fts f JOIN entries e ON e.rowid = f.rowid
            WHERE entries_fts MATCH ?
            ORDER BY e.startedAt DESC LIMIT \(max(0, limit));
            """, bindText: term)
    }

    /// User input is not FTS5 syntax. Quoting it as a phrase means a query containing `-`, `*`,
    /// `OR` or an unbalanced quote searches for those characters instead of throwing a syntax
    /// error at someone who typed a hyphen.
    static func escapeForFTS5(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return "\"" + trimmed.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }

    private func query(_ sql: String, bindText: String?) throws -> [HistoryEntry] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw lastError() }
        defer { sqlite3_finalize(stmt) }
        if let bindText { bind(stmt, 1, bindText) }

        var out: [HistoryEntry] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            out.append(HistoryEntry(
                id: text(stmt, 0) ?? "",
                startedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 1)),
                language: Language(rawValue: text(stmt, 2) ?? "en") ?? .english,
                engineID: text(stmt, 3) ?? "",
                raw: text(stmt, 4) ?? "",
                result: text(stmt, 5) ?? "",
                polished: text(stmt, 6),
                audioSeconds: sqlite3_column_double(stmt, 7),
                audioPath: text(stmt, 8)))
        }
        return out
    }

    // MARK: Plumbing

    private func lastError() -> HistoryError {
        .sql(String(cString: sqlite3_errmsg(db)))
    }

    private func bind(_ stmt: OpaquePointer?, _ index: Int32, _ value: String?) {
        // SQLITE_TRANSIENT: sqlite must copy, because the Swift string may not outlive the call.
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        if let value {
            sqlite3_bind_text(stmt, index, value, -1, transient)
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }

    private func text(_ stmt: OpaquePointer?, _ index: Int32) -> String? {
        guard let c = sqlite3_column_text(stmt, index) else { return nil }
        return String(cString: c)
    }
}

// `"\(error)"` is this codebase's interchange format at the module boundaries — 23 sites convert
// that way — and for an `Error` enum without `CustomStringConvertible` it reflects the case name
// instead of the diagnosis. A denied microphone reached the user as
// `engineFailedToStart("permissionDenied")`, which appears verbatim in real diagnostics. Each of
// these types already writes the actionable sentence in `reason`; this is what makes the
// interchange format use it, with no call-site changes.

extension HistoryError: CustomStringConvertible {
    public var description: String { reason }
}
