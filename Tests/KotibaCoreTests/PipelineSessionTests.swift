import Foundation
import Testing

@testable import KotibaCore

// Band 1. The session's pipeline work during the hold: a stream per family, language detection
// while the key is down (standing the Uzbek stream down on audio that is not Uzbek), the route
// taken from a detection that already heard every word, and the mode's polish primed from the
// stream's text so key-up has only the tail left. No model, no microphone.

private final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var log: [String] = []
    func add(_ s: String) { lock.withLock { log.append(s) } }
    var all: [String] { lock.withLock { log } }
    func count(_ prefix: String) -> Int { all.filter { $0.hasPrefix(prefix) }.count }
}

/// Streams `seconds` of audio in 20 ms chunks as fast as they are taken.
private final class Take: LiveAudioSource, @unchecked Sendable {
    let chunks: AsyncStream<[Float]>
    private let continuation: AsyncStream<[Float]>.Continuation
    private let samples: [Float]
    private var feeder: Task<Void, Never>?

    init(seconds: Double) {
        samples = (0..<Int(seconds * 16_000)).map { Float(sin(Double($0) * 0.05)) * 0.4 }
        (chunks, continuation) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .unbounded)
    }
    func start() async throws {
        let samples = self.samples, continuation = self.continuation
        feeder = Task {
            var i = 0
            while i < samples.count {
                continuation.yield(Array(samples[i..<min(i + 320, samples.count)]))
                i += 320
                await Task.yield()
            }
        }
    }
    func stop() async throws -> AudioBuffer {
        await feeder?.value
        continuation.finish()
        return AudioBuffer(samples: samples)
    }
    func warmUp() async {}
}

private actor FakeStream: TranscriptionStream {
    let family: String
    let calls: Calls
    let text: String
    let language: Language
    let spoken: Int
    private var fed = 0
    init(family: String, calls: Calls, text: String, language: Language, spoken: Int) {
        self.family = family
        self.calls = calls
        self.text = text
        self.language = language
        self.spoken = spoken
    }
    func append(_ samples: [Float]) async { fed += samples.count }
    func finish(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        calls.add("finish-\(family)")
        return Transcript(raw: text, language: self.language, engineID: family)
    }
    func cancel() async { calls.add("cancel-\(family)") }
    func setLikely(_ likely: Bool) async { calls.add("likely-\(family)-\(likely)") }
    func settlement() async -> String? { "speculation" }
    func lastSpeechEnd() async -> Int? { spoken }
    /// The whole text once two seconds have been fed — a pause decode.
    func progress() async -> StreamProgress? {
        fed >= 32_000 ? StreamProgress(committed: "", provisional: text, language: language,
                                       speechEnd: spoken) : nil
    }
}

private struct FakeEngine: StreamingTranscriptionEngine {
    let family: String
    let calls: Calls
    let text: String
    let language: Language
    let supportedLanguages: Set<Language>
    var spoken = 16_000
    var engineID: String { family }
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        calls.add("batch-\(family)")
        return Transcript(raw: text, language: self.language, engineID: family)
    }
    func openStream() async -> any TranscriptionStream {
        calls.add("open-\(family)")
        return FakeStream(family: family, calls: calls, text: text, language: language,
                          spoken: spoken)
    }
}

private struct MassRouter: LanguageRouter {
    let calls: Calls
    let mass: Double
    func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        if let pin { return RouteDecision(language: pin, source: .pin) }
        calls.add("route-\(Int(audio.duration.rounded()))s")
        return mass >= 0.05
            ? RouteDecision(language: .uzbek, source: .acoustic, turkicMass: mass)
            : RouteDecision(language: .english, source: .acoustic, turkicMass: mass)
    }
}

private actor Pasted: TextSink {
    private(set) var texts: [String] = []
    func insert(_ text: String) async throws -> InsertionOutcome {
        texts.append(text)
        return .inserted
    }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        .inserted
    }
}

private func session(_ calls: Calls, mass: Double, seconds: Double = 4, spoken: Int = 16_000,
                     pin: Language? = nil, sink: Pasted = Pasted(),
                     live: DictationSession.LivePolish? = nil,
                     unifiedText: String = "Water the roses today.") -> DictationSession {
    DictationSession(
        audio: Take(seconds: seconds),
        router: MassRouter(calls: calls, mass: mass),
        engines: [
            .unified: FakeEngine(family: "unified", calls: calls,
                                 text: unifiedText, language: .english,
                                 supportedLanguages: [.english, .russian], spoken: spoken),
            .uzbek: FakeEngine(family: "uzbek", calls: calls, text: "gullarni sugʻoring.",
                               language: .uzbek, supportedLanguages: [.uzbek], spoken: spoken),
        ],
        sink: sink, config: patient, expectedPin: pin, livePolish: live)
}

/// Deadlines far past the work: these tests are about what happens, not how fast, and a
/// parallel suite at load 10+ can starve the cooperative pool for a second or more.
private var patient: DictationSession.Config {
    var config = DictationSession.Config()
    config.liveTailDeadline = .seconds(30)
    config.polishDeadline = .seconds(30)
    return config
}

@Suite("The pipeline during the hold")
struct PipelineSessionTests {

    @Test("unpinned, both families stream; pinned, only the pin's")
    func streamsPerFamily() async {
        let calls = Calls()
        let s = session(calls, mass: 0.0)
        await s.arm()
        #expect(calls.count("open-unified") == 1 && calls.count("open-uzbek") == 1)
        await s.finish()

        let pinned = Calls()
        let p = session(pinned, mass: 0.0, pin: .uzbek)
        await p.arm()
        #expect(pinned.count("open-") == 1 && pinned.count("open-uzbek") == 1)
        await p.finish(pin: .uzbek)
    }

    @Test("audio that is clearly not Uzbek stands the Uzbek stream down during the hold")
    func standsDown() async {
        let calls = Calls()
        let s = session(calls, mass: 0.001, seconds: 4)
        await s.arm()
        for _ in 0..<6000 where calls.count("likely-uzbek-false") == 0 {
            try? await Task.sleep(for: .milliseconds(5))
        }
        #expect(calls.count("route-") >= 1, "no detection during the hold: \(calls.all)")
        #expect(calls.count("likely-uzbek-false") == 1)
        let record = await s.finish()
        #expect(record.route?.language == .english)
        #expect(calls.count("cancel-uzbek") == 1, "the unlikely stream was not cancelled")
        #expect(record.earlyRoute?.language == .english)
    }

    @Test("Parakeet's un-English pause decode keeps the Uzbek stream up, and key-up takes its text")
    func unEnglishTextKeepsUzbek() async {
        // The acoustic pass says English at every detection (mass 0.001 would stand the Uzbek
        // stream down); Parakeet's pause decode at 2 s is not English. The hold keeps the Uzbek
        // stream speculating, and key-up — routed to Parakeet — reads the same text, asks the
        // Uzbek stream, and keeps its answer.
        let calls = Calls()
        let sink = Pasted()
        let s = session(calls, mass: 0.001, seconds: 4, sink: sink,
                        unifiedText: "Morvalen tikoshar penduvi askarel.")
        await s.arm()
        for _ in 0..<6000 where calls.count("likely-uzbek-true") == 0 {
            try? await Task.sleep(for: .milliseconds(5))
        }
        // A detection at the first pause may stand it down before Parakeet has written anything;
        // the text stands it back up, and no later detection stands it down again.
        let likely = calls.all.filter { $0.hasPrefix("likely-uzbek") }
        #expect(likely.last == "likely-uzbek-true", "\(calls.all)")
        let record = await s.finish()
        #expect(calls.all.filter { $0.hasPrefix("likely-uzbek") }.last == "likely-uzbek-true")
        #expect(record.route?.language == .uzbek)
        #expect(record.route?.source == .transcriptCheck)
        #expect(record.unifiedDoubt == "notEnglish")
        #expect(calls.count("finish-uzbek") == 1 && calls.count("batch-uzbek") == 0)
        #expect(calls.count("cancel-uzbek") == 0)
        #expect(await sink.texts == ["gullarni sugʻoring."])
    }

    @Test("English from Parakeet cancels the Uzbek stream at key-up without asking it")
    func englishTextCancelsUzbek() async {
        let calls = Calls()
        let s = session(calls, mass: 0.001, seconds: 4)
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .english && record.route?.source == .acoustic)
        #expect(record.unifiedDoubt == nil)
        #expect(calls.count("finish-uzbek") == 0 && calls.count("cancel-uzbek") == 1)
        #expect(record.stageMillis["rerouting"] == nil)
    }

    @Test("uncertain audio keeps the Uzbek stream working")
    func uncertainKeepsBoth() async {
        let calls = Calls()
        let s = session(calls, mass: 0.03, seconds: 4)
        await s.arm()
        try? await Task.sleep(for: .milliseconds(100))
        #expect(calls.count("likely-uzbek-false") == 0)
        await s.finish()
    }

    @Test("a detection that heard every word is the route; key-up does not ask again")
    func trustsADetectionThatHeardEverything() async {
        let calls = Calls()
        // Speech ends at 1 s; the 3 s detection heard it all.
        let s = session(calls, mass: 0.6, seconds: 4, spoken: 16_000)
        await s.arm()
        for _ in 0..<6000 where calls.count("route-") == 0 {
            try? await Task.sleep(for: .milliseconds(5))
        }
        try? await Task.sleep(for: .milliseconds(20))
        let before = calls.count("route-")
        let record = await s.finish()
        #expect(calls.count("route-") == before, "key-up detected again: \(calls.all)")
        #expect(record.route?.language == .uzbek)
        #expect(record.stageMillis["routing"] == nil)
        #expect(record.tail == "speculation")
        #expect(record.releaseToInsertMillis != nil)
    }

    @Test("speech past the last detection: key-up detects over the whole recording")
    func detectsWhenSpeechWentOn() async {
        let calls = Calls()
        let s = session(calls, mass: 0.0, seconds: 4, spoken: 4 * 16_000)
        await s.arm()
        try? await Task.sleep(for: .milliseconds(100))
        let record = await s.finish()
        #expect(calls.count("route-4s") == 1, "\(calls.all)")
        #expect(record.stageMillis["routing"] != nil)
    }

    @Test("the mode's sentence is polished during the hold and pasted once at key-up")
    func primedPolishIsPasted() async {
        let calls = Calls()
        let engine = ScriptedEngine(["Water the roses today.": "Water the roses today!"])
        let sink = Pasted()
        let s = session(calls, mass: 0.0, seconds: 3, pin: .english, sink: sink,
                        live: .init(behaviour: .message, engine: engine))
        await s.arm()
        for _ in 0..<6000 where await engine.asked.isEmpty {
            try? await Task.sleep(for: .milliseconds(5))
        }
        let record = await s.finish(pin: .english, insertAfterPolish: true)
        #expect(await sink.texts == ["Water the roses today!"])
        #expect(record.liveSentences == 1)
        #expect(await engine.asked.count == 1, "the primed sentence was polished again")
        #expect(record.polished == "Water the roses today!")
    }
}
