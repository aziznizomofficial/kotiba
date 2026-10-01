import Foundation
import Testing

@testable import KotibaCore

private func tempDir() -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("kotiba-diag-\(UUID().uuidString)")
}

private let env = DiagnosticsEnvironment(
    appVersion: "0.1 (1)", osVersion: "macOS 26.5.1", device: "Mac16,x", locale: "en_UZ")

private func record(outcome: String = "done", engine: String? = "parakeet-v3",
                    errors: [String] = [], peak: Float = 0.4,
                    at offset: TimeInterval = 0) -> DictationRecord {
    var r = DictationRecord(startedAt: Date(timeIntervalSince1970: 1_785_000_000 + offset))
    r.outcome = outcome
    r.engineID = engine
    r.errors = errors
    r.peakAmplitude = peak
    r.audioSeconds = 2.5
    r.stageMillis = ["transcribing": 62.4, "inserting": 33.1]
    r.route = RouteDecision(language: .uzbek, source: .acoustic, turkicMass: 0.81)
    return r
}

@Suite("Diagnostics store — the only channel there is on iOS")
struct DiagnosticsStoreTests {

    @Test("records round-trip through the file")
    func roundTrip() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try DiagnosticsStore(url: dir.appendingPathComponent("diag.jsonl"),
                                         environment: env)
        try await store.append(record())
        try await store.append(record(outcome: "heardNothing", engine: nil, at: 10))

        let got = try await store.records()
        #expect(got.count == 2)
        #expect(got[0].outcome == "done")
        #expect(got[1].outcome == "heardNothing")
        #expect(got[0].route?.turkicMass == 0.81)
    }

    @Test("one corrupt line costs that line, not the file")
    func corruptionIsContained() async throws {
        // Append-only JSON Lines exists for this: a crash mid-write must not orphan everything
        // written before it.
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("diag.jsonl")
        let store = try DiagnosticsStore(url: url, environment: env)
        try await store.append(record())

        var data = try Data(contentsOf: url)
        data.append(contentsOf: Data("{ this is not json\n".utf8))
        try data.write(to: url)
        try await store.append(record(at: 20))

        #expect(try await store.records().count == 2, "the good lines must survive")
    }

    @Test("the file is trimmed rather than growing forever on an unattended device")
    func trimming() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("diag.jsonl")
        let store = try DiagnosticsStore(url: url, environment: env, maxBytes: 4_000)
        for i in 0..<200 { try await store.append(record(at: TimeInterval(i))) }

        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as! Int
        #expect(size <= 8_000, "size was \(size)")
        let remaining = try await store.records()
        #expect(!remaining.isEmpty)
        // The newest must survive; the oldest is what gets discarded.
        // Unwrap and subtract before comparing: an Optional<Double> against an integer-literal
        // expression is a footgun that fails while printing two identical-looking numbers.
        let newestOffset = (remaining.last?.startedAt.timeIntervalSince1970 ?? 0) - 1_785_000_000
        let oldestOffset = (remaining.first?.startedAt.timeIntervalSince1970 ?? 0) - 1_785_000_000
        #expect(newestOffset == 199, "the newest record must survive trimming")
        #expect(oldestOffset > 0, "the oldest records are what get discarded")
    }

    @Test("survives being reopened, so a report spans launches")
    func persistsAcrossInstances() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("diag.jsonl")
        do {
            let store = try DiagnosticsStore(url: url, environment: env)
            try await store.append(record())
        }
        let reopened = try DiagnosticsStore(url: url, environment: env)
        #expect(try await reopened.records().count == 1)
    }

    @Test("the summary is readable prose, not a wall of JSON")
    func summaryIsLegible() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try DiagnosticsStore(url: dir.appendingPathComponent("d.jsonl"),
                                         environment: env)
        try await store.append(record())
        try await store.append(record(outcome: "failed", errors: ["engine whisper-uz not ready"],
                                      at: 30))

        let text = try await store.summary()
        #expect(text.contains("Kotiba diagnostics"))
        #expect(text.contains("macOS 26.5.1"))
        #expect(text.contains("parakeet-v3"), "which engine actually ran is the first question")
        #expect(text.contains("engine whisper-uz not ready"), "errors must survive to the report")
        #expect(text.contains("transcribing"), "stage timings answer 'why was it slow'")
        #expect(text.contains("outcomes:"))
    }

    @Test("the summary contains no transcript text — what they said is theirs")
    func summaryIsPrivate() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try DiagnosticsStore(url: dir.appendingPathComponent("d.jsonl"),
                                         environment: env)
        var r = record()
        r.raw = "my private medical appointment on tuesday"
        r.result = "My private medical appointment on Tuesday"
        r.polished = "Private appointment Tuesday"
        try await store.append(r)

        let text = try await store.summary()
        #expect(!text.contains("medical"))
        #expect(!text.contains("private"))
        #expect(!text.contains("appointment"))
        #expect(text.contains("done"), "the outcome is still reported")
    }

    @Test("notes that quote the speaker are redacted in the summary, and kept in the record")
    func summaryRedactsQuotedSpeech() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try DiagnosticsStore(url: dir.appendingPathComponent("d.jsonl"),
                                         environment: env)
        var r = record()
        // The notes as the guards and the session write them.
        let dropped = SentenceGuard.checkRewrite(
            "Keep only telegram.", against: "Yes, keep only the dentist telegram today.",
            language: .english, prompt: OnDeviceModes.messagePrompt(.english),
            mayDrop: OnDeviceModes.droppable[.english] ?? [])
        let invented = UzbekPolishGuard.check("ertaga keçşurun boraman", against: "ertaga boraman")
        r.errors = [dropped ?? "", invented.reason,
                    "the Uzbek engine's second answer was not usable "
                        + SpokenText.quote("salom dunyo » kelajak") + " — the first stands."]
        try await store.append(r)

        let text = try await store.summary()
        for word in ["dentist", "today", "keçşurun", "salom", "kelajak"] {
            #expect(!text.contains(word), "the summary quotes the speaker: \(word)")
        }
        #expect(text.contains("did not say"), "the note itself still reads")
        #expect(try await store.records().first?.errors.joined().contains("dentist") == true,
                "the record keeps the words")
    }

    @Test("exports to a file a tester can attach without a cable or Xcode")
    func export() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let store = try DiagnosticsStore(url: dir.appendingPathComponent("d.jsonl"),
                                         environment: env)
        try await store.append(record())

        let file = try await store.exportSummary(to: dir)
        #expect(FileManager.default.fileExists(atPath: file.path))
        #expect(file.lastPathComponent.hasPrefix("kotiba-diagnostics-"))
        #expect(file.pathExtension == "txt")
        let text = try String(contentsOf: file, encoding: .utf8)
        #expect(text.contains("Kotiba diagnostics"))
    }

    @Test("clearing empties the file without deleting it")
    func clearing() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("d.jsonl")
        let store = try DiagnosticsStore(url: url, environment: env)
        try await store.append(record())
        try await store.clear()
        #expect(try await store.records().isEmpty)
        #expect(FileManager.default.fileExists(atPath: url.path))
    }

    @Test("an empty store still produces a report rather than throwing at the worst moment")
    func emptySummary() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try DiagnosticsStore(url: dir.appendingPathComponent("d.jsonl"),
                                         environment: env)
        let text = try await store.summary()
        #expect(text.contains("0 dictations recorded"))
    }
}
