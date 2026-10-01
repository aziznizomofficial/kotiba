import Foundation

// Tasks C-07 (persistence) and S-07 (export).
//
// On iOS this file is the ONLY inspection channel there is: `log stream` has no device option
// on current macOS, `devicectl` will not attach to a process's stdout, and libimobiledevice is
// not installed. That was true when the person holding the failing device was the person who
// wrote the code. Now Kotiba ships to other people, so the report has to be something a tester
// can hand over without a cable, Xcode, or any idea what a provisioning profile is.
//
// Append-only JSON Lines rather than one JSON document: a crash mid-write costs the last line
// instead of the whole file, and appending does not require reading what is already there.

public struct DiagnosticsEnvironment: Sendable, Codable, Equatable {
    public var appVersion: String
    public var osVersion: String
    public var device: String
    public var locale: String

    public init(appVersion: String, osVersion: String, device: String, locale: String) {
        self.appVersion = appVersion
        self.osVersion = osVersion
        self.device = device
        self.locale = locale
    }
}

public actor DiagnosticsStore {

    private let url: URL
    private let environment: DiagnosticsEnvironment
    private let maxBytes: Int
    private let encoder: JSONEncoder

    /// `maxBytes` keeps an unattended device from filling its disk. When exceeded, the oldest
    /// half is discarded — recent failures are what anyone debugging actually wants.
    public init(url: URL, environment: DiagnosticsEnvironment, maxBytes: Int = 2_000_000) throws {
        self.url = url
        self.environment = environment
        self.maxBytes = maxBytes
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]

        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
    }

    private struct Line: Codable {
        var environment: DiagnosticsEnvironment
        var record: DictationRecord
    }

    public func append(_ record: DictationRecord) throws {
        let line = try encoder.encode(Line(environment: environment, record: record))
        var data = line
        data.append(0x0A)

        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try trimIfNeeded()
    }

    private func trimIfNeeded() throws {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        guard let size = attributes?[.size] as? Int, size > maxBytes else { return }
        let contents = try Data(contentsOf: url)
        let lines = contents.split(separator: 0x0A, omittingEmptySubsequences: true)
        let keep = lines.suffix(max(1, lines.count / 2))
        var rebuilt = Data()
        for line in keep {
            rebuilt.append(contentsOf: line)
            rebuilt.append(0x0A)
        }
        try rebuilt.write(to: url, options: .atomic)
    }

    public func records() throws -> [DictationRecord] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try Data(contentsOf: url)
            .split(separator: 0x0A, omittingEmptySubsequences: true)
            .compactMap { try? decoder.decode(Line.self, from: Data($0)).record }
    }

    public func clear() throws {
        try Data().write(to: url, options: .atomic)
    }

    // MARK: S-07 — the thing a tester can actually send

    /// A plain-text summary. Not JSON, because the person pasting this into a message should be
    /// able to read it, and because a wall of JSON discourages them from sending anything.
    ///
    /// Contains no transcript text. What someone dictated is theirs; what the app did with it
    /// is the bug report.
    public func summary(limit: Int = 40) throws -> String {
        let all = try records()
        let recent = Array(all.suffix(limit))
        var out = """
            Kotiba diagnostics
            app \(environment.appVersion) · \(environment.osVersion) · \(environment.device) \
            · \(environment.locale)
            \(all.count) dictations recorded, showing the last \(recent.count)

            """

        let byOutcome = Dictionary(grouping: all, by: \.outcome).mapValues(\.count)
        out += "outcomes: " + byOutcome.sorted { $0.key < $1.key }
            .map { "\($0.key) \($0.value)" }.joined(separator: ", ") + "\n"

        let engines = Set(all.compactMap(\.engineID)).sorted()
        out += "engines seen: " + (engines.isEmpty ? "none" : engines.joined(separator: ", ")) + "\n\n"

        for r in recent.reversed() {
            let stages = r.stageMillis.sorted { $0.key < $1.key }
                .map { "\($0.key) \(Int($0.value))ms" }.joined(separator: " ")
            out += "\(ISO8601DateFormatter().string(from: r.startedAt))  \(r.outcome)\n"
            out += "  \(String(format: "%.1f", r.audioSeconds))s audio, peak "
                + "\(String(format: "%.4f", r.peakAmplitude))"
            if let engine = r.engineID { out += ", engine \(engine)" }
            // What kind of microphone, never which one: its name can be the owner's ("Aziz’s
            // iPhone Microphone") and this text is pasted into bug reports.
            if let device = r.inputDevice { out += ", input \(device.redactedDescription)" }
            if let route = r.route {
                out += ", route \(route.language.rawValue) via \(route.source.rawValue)"
            }
            out += "\n"
            if !stages.isEmpty { out += "  \(stages)\n" }
            // Key-up → insert as measured, how the stream settled key-up, and what was polished
            // before it — the three numbers that say where a slow release went.
            var release: [String] = []
            if let millis = r.releaseToInsertMillis {
                release.append("key-up→insert \(Int(millis))ms")
            }
            if let tail = r.tail { release.append("tail \(tail)") }
            if let live = r.liveSentences {
                release.append("\(live) sentence(s) polished while held")
            }
            if !release.isEmpty { out += "  " + release.joined(separator: ", ") + "\n" }
            // Redacted, because the record's notes may quote the speaker — which words a guard
            // refused, what a second engine answered — and this is the text the Settings pane
            // offers for pasting into a bug report. The JSON lines keep them; this never does.
            for error in r.errors { out += "  ! \(SpokenText.redact(error))\n" }
        }
        return out
    }

    /// Writes the summary somewhere a share sheet or Finder can reach it, and returns the URL.
    public func exportSummary(to directory: URL) throws -> URL {
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let destination = directory.appendingPathComponent("kotiba-diagnostics-\(stamp).txt")
        try summary().write(to: destination, atomically: true, encoding: .utf8)
        return destination
    }
}

/// Words the speaker said, quoted inside a diagnostic note.
///
/// The record's notes are allowed to name them — the JSON lines already hold the whole transcript,
/// and "the polish invented «keçşurun»" is the note that makes a guard's refusal checkable — but
/// the plain-text summary promises "no transcript text", and the notes are part of it. Before
/// this, a Message sentence whose rewrite lost two words printed those two words into the summary
/// the Settings pane hands out for bug reports. Every note that quotes speech goes through
/// `quote`, and `DiagnosticsStore.summary` puts every note through `redact`.
public enum SpokenText {
    static let open: Character = "\u{AB}"    // «
    static let close: Character = "\u{BB}"   // »

    /// `text` between guillemets, with any guillemet inside it made harmless so the quote ends
    /// where it should.
    public static func quote<S: StringProtocol>(_ text: S) -> String {
        let inner = String(text).replacingOccurrences(of: String(close), with: "\u{203A}")
            .replacingOccurrences(of: String(open), with: "\u{2039}")
        return "\(open)\(inner)\(close)"
    }

    /// `line` with every quoted stretch replaced by its length in words.
    public static func redact(_ line: String) -> String {
        var out = ""
        var quoted: String?
        for character in line {
            if quoted == nil, character == open {
                quoted = ""
            } else if let inner = quoted, character == close {
                let words = inner.split(whereSeparator: { $0 == " " || $0 == "," }).count
                out += "\(open)\(words) word\(words == 1 ? "" : "s")\(close)"
                quoted = nil
            } else if quoted != nil {
                quoted!.append(character)
            } else {
                out.append(character)
            }
        }
        // An unterminated quote is still speech.
        if quoted != nil { out += "\(open)…" }
        return out
    }
}
