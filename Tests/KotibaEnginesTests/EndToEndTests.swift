import Foundation
import KotibaAudio
import KotibaCore
import Testing

@testable import KotibaEngines

private typealias AudioBuffer = KotibaCore.AudioBuffer

// The whole pipeline, on real speech, minus the two things a test cannot have: a hotkey and
// another application to paste into.
//
// Everything else is the real thing — the real session state machine, the real router, the real
// engine, the real normaliser, the real empty-transcript guard. What it proves is that the
// pieces fit, which unit tests by construction cannot.

/// Stands in for the pasteboard. Records rather than inserts.
private actor CollectingSink: TextSink {
    private(set) var inserted: [String] = []
    private(set) var replaced: [(String, String)] = []
    private let outcome: InsertionOutcome

    init(outcome: InsertionOutcome = .inserted) { self.outcome = outcome }

    func insert(_ text: String) async throws -> InsertionOutcome {
        inserted.append(text)
        return outcome
    }

    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        replaced.append((previous, text))
        return outcome
    }
}

@Suite("End to end", .enabled(if: ProcessInfo.liveEnginesEnabled))
struct EndToEndTests {

    private func session(sink: any TextSink,
                         file: URL,
                         engines: [EngineFamily: any TranscriptionEngine]) throws
        -> DictationSession {
        DictationSession(
            audio: try WAVFileSource(contentsOf: file),
            router: TieredRouter(fallback: .english),
            engines: engines,
            sink: sink,
            normalise: { text, language in
                language == .uzbek ? UzbekNormaliser.clean(text) : text
            })
    }

    @Test("speech in, text out, and every stage timed")
    func fullPipeline() async throws {
        let engine = AppleSpeechEngine()
        try await engine.prepare()

        let sink = CollectingSink()
        let session = try session(sink: sink, file: try TestAudio.spokenEnglishFile(),
                                  engines: [.unified: engine])

        await session.arm()
        let record = await session.finish(pin: .english)

        #expect(await session.state == .done)
        #expect(record.outcome == "done")
        #expect(await sink.inserted.count == 1)
        #expect(await sink.inserted.first?.lowercased().contains("hello") == true)

        // Every stage that ran has a timing. A missing stage is itself the answer to most
        // "why was that slow" questions, so their presence is part of the contract.
        for stage in ["arming", "finalising", "routing", "transcribing", "inserting"] {
            #expect(record.stageMillis[stage] != nil, "no timing recorded for \(stage)")
        }
        #expect(record.engineID == "apple-speech-transcriber")
        #expect(record.raw?.isEmpty == false)
        #expect(record.route?.source == .pin)
    }

    @Test("silence is reported as silence, and nothing is pasted")
    func silenceInsertsNothing() async throws {
        // The defect that justifies the whole project: v1 pasted an empty string here and
        // called it success, on roughly a third of its dictations.
        let engine = AppleSpeechEngine()
        try await engine.prepare()

        let sink = CollectingSink()
        let silence = try TestAudio.silenceFile()
        let session = try session(sink: sink, file: silence, engines: [.unified: engine])

        await session.arm()
        let record = await session.finish(pin: .english)

        #expect(await session.state == .heardNothing)
        #expect(record.outcome == "heardNothing")
        #expect(await sink.inserted.isEmpty, "silence must never reach the user's app")
    }

    @Test("a refused paste is a loud failure, not a quiet success")
    func refusedInsertion() async throws {
        let engine = AppleSpeechEngine()
        try await engine.prepare()

        let sink = CollectingSink(outcome: .refused(reason: "Accessibility is off"))
        let session = try session(sink: sink, file: try TestAudio.spokenEnglishFile(),
                                  engines: [.unified: engine])

        await session.arm()
        let record = await session.finish(pin: .english)

        #expect(await session.state == .failed(.insertionRefused("Accessibility is off")))
        #expect(record.outcome == "failed")
        // The transcript still exists in the record even though it never landed, which is what
        // lets the menu offer "copy last".
        #expect(record.result?.isEmpty == false)
    }

    @Test("routing to a family with no engine says so rather than substituting one")
    func noEngineForFamily() async throws {
        // v1 fell back to a 30x slower engine in silence. A missing Uzbek model must read as a
        // missing Uzbek model.
        let sink = CollectingSink()
        let session = try session(sink: sink, file: try TestAudio.spokenEnglishFile(),
                                  engines: [.unified: AppleSpeechEngine()])

        await session.arm()
        let record = await session.finish(pin: .uzbek)

        #expect(await session.state == .failed(.noEngineReady(.uzbek, .uzbek)))
        #expect(await sink.inserted.isEmpty)
        #expect(record.errors.contains { $0.contains("uzbek") })
    }

    @Test("the session is reusable — two dictations in a row is the common case")
    func twoInARow() async throws {
        let engine = AppleSpeechEngine()
        try await engine.prepare()
        let sink = CollectingSink()
        let session = try session(sink: sink, file: try TestAudio.spokenEnglishFile(),
                                  engines: [.unified: engine])

        await session.arm()
        _ = await session.finish(pin: .english)
        await session.arm()
        _ = await session.finish(pin: .english)

        #expect(await session.state == .done)
        #expect(await sink.inserted.count == 2)
    }
}

@Suite("End to end — Uzbek", .enabled(if: UzbekModel.path != nil))
struct UzbekEndToEndTests {

    @Test("Uzbek speech reaches the sink already normalised")
    func uzbekPipeline() async throws {
        let path = try #require(UzbekModel.path)
        let clip = try #require(UzbekModel.clip)
        let engine = WhisperEngine(modelURL: URL(fileURLWithPath: path))
        try await engine.prepare()

        let sink = CollectingSink()
        let session = DictationSession(
            audio: try WAVFileSource(contentsOf: clip),
            router: TieredRouter(fallback: .uzbek),
            engines: [.uzbek: engine],
            sink: sink,
            normalise: { text, language in
                language == .uzbek ? UzbekNormaliser.clean(text) : text
            })

        await session.arm()
        let record = await session.finish(pin: .uzbek)

        #expect(await session.state == .done)
        let text = try #require(await sink.inserted.first)
        #expect(!text.isEmpty)

        // whisper emits an ASCII apostrophe where Uzbek wants the okina, and the normaliser is
        // the reason that never reaches the user. If `raw` had one, `result` must not.
        if record.raw?.contains("'") == true {
            #expect(!text.contains("'"),
                    "the ASCII apostrophe survived normalisation: \(text)")
        }
    }
}

extension TestAudio {
    /// The same clip as `spokenEnglish()`, as a file, for `WAVFileSource`.
    static func spokenEnglishFile() throws -> URL {
        _ = try spokenEnglish()
        return FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-tests", isDirectory: true)
            .appendingPathComponent("en.wav")
    }

    /// Two seconds of nothing, written as a real WAV so the parser is exercised too.
    static func silenceFile() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-tests", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("silence.wav")
        guard !FileManager.default.fileExists(atPath: url.path) else { return url }

        let frames = 32_000                       // 2 s at 16 kHz
        var data = Data()
        func append(_ string: String) { data.append(contentsOf: Array(string.utf8)) }
        func append32(_ value: Int) {
            for shift in stride(from: 0, to: 32, by: 8) {
                data.append(UInt8((value >> shift) & 0xFF))
            }
        }
        func append16(_ value: Int) {
            data.append(UInt8(value & 0xFF))
            data.append(UInt8((value >> 8) & 0xFF))
        }
        append("RIFF"); append32(36 + frames * 2); append("WAVE")
        append("fmt "); append32(16); append16(1); append16(1)
        append32(16_000); append32(32_000); append16(2); append16(16)
        append("data"); append32(frames * 2)
        data.append(Data(repeating: 0, count: frames * 2))
        try data.write(to: url)
        return url
    }
}
