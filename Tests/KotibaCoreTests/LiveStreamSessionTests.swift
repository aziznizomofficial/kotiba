import Foundation
import Testing

@testable import KotibaCore

// Band 1. The session's half of streaming: audio pumped from a live source into the unified
// engine's stream while the key is held, the stream finished at key-up only when the route is
// the unified family, and the unified engine's own language taking over the router's en/ru
// guess. No model and no microphone — the stream here is a recorder.

private final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var _appended = 0
    private var _finished: [Language] = []
    private var _cancelled = 0
    private var _batch = 0
    var appended: Int { lock.withLock { _appended } }
    var finished: [Language] { lock.withLock { _finished } }
    var cancelled: Int { lock.withLock { _cancelled } }
    var batch: Int { lock.withLock { _batch } }
    func append(_ n: Int) { lock.withLock { _appended += n } }
    func finish(_ l: Language) { lock.withLock { _finished.append(l) } }
    func cancel() { lock.withLock { _cancelled += 1 } }
    func batchCall() { lock.withLock { _batch += 1 } }
}

/// A microphone whose take streams `total` samples in 1600-sample chunks while "capturing", and
/// finishes the stream at `stop()` — the contract `MicrophoneTake` keeps.
private final class LiveFake: LiveAudioSource, @unchecked Sendable {
    let total: Int
    let chunks: AsyncStream<[Float]>
    private let continuation: AsyncStream<[Float]>.Continuation
    private var feeder: Task<Void, Never>?

    init(total: Int, paced: Bool = false) {
        self.total = total
        (chunks, continuation) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .unbounded)
        self.paced = paced
    }
    let paced: Bool

    func start() async throws {
        let continuation = self.continuation
        let total = self.total
        let paced = self.paced
        feeder = Task {
            var sent = 0
            while sent < total, !Task.isCancelled {
                let n = min(1600, total - sent)
                continuation.yield([Float](repeating: 0.5, count: n))
                sent += n
                if paced { try? await Task.sleep(for: .milliseconds(20)) }
            }
        }
    }
    func stop() async throws -> AudioBuffer {
        feeder?.cancel()
        await feeder?.value
        continuation.finish()
        return AudioBuffer(samples: (0..<total).map { Float(sin(Double($0) * 0.05)) * 0.5 })
    }
    func warmUp() async {}
}

private struct RecorderStream: TranscriptionStream {
    let log: Log
    /// What the engine "wrote" — its language is what the transcript reports.
    let written: Language
    func append(_ samples: [Float]) async { log.append(samples.count) }
    func finish(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        log.finish(language)
        return Transcript(raw: written == .russian ? "Привет, как дела?" : "Hello there.",
                          language: written, engineID: "streamer")
    }
    func cancel() async { log.cancel() }
}

private struct StreamingFake: StreamingTranscriptionEngine {
    let log: Log
    var written: Language = .english
    let engineID = "streamer"
    let supportedLanguages: Set<Language> = [.english, .russian]
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        log.batchCall()
        return Transcript(raw: "batch", language: language, engineID: engineID)
    }
    func openStream() async -> any TranscriptionStream {
        RecorderStream(log: log, written: written)
    }
}

private struct UzbekFake: TranscriptionEngine {
    let engineID = "uz"
    let supportedLanguages: Set<Language> = [.uzbek]
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: "salom dunyo", language: .uzbek, engineID: engineID)
    }
}

private struct FixedRouter: LanguageRouter {
    var language: Language
    func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        if let pin { return RouteDecision(language: pin, source: .pin) }
        return RouteDecision(language: language, source: .acoustic)
    }
}

private struct NullSink: TextSink {
    func insert(_ text: String) async throws -> InsertionOutcome { .inserted }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        .inserted
    }
}

private func session(_ log: Log, route: Language, written: Language = .english,
                     samples: Int = 16_000 * 3, paced: Bool = false) -> DictationSession {
    DictationSession(
        audio: LiveFake(total: samples, paced: paced),
        router: FixedRouter(language: route),
        engines: [.unified: StreamingFake(log: log, written: written), .uzbek: UzbekFake()],
        sink: NullSink())
}

@Suite("Streaming while the key is held")
struct LiveStreamSessionTests {

    @Test("audio is pumped into the stream during the hold, and key-up finishes it")
    func pumpsAndFinishes() async throws {
        let log = Log()
        let s = session(log, route: .english)
        await s.arm()
        try await Task.sleep(for: .milliseconds(100))
        #expect(log.appended > 0, "nothing reached the stream while capturing")
        let record = await s.finish()
        #expect(log.appended == 16_000 * 3, "the stream did not see every sample by key-up")
        #expect(log.finished == [.english])
        #expect(log.batch == 0, "key-up decoded in batch although a stream was open")
        #expect(record.raw == "Hello there.")
    }

    // Before the route is known the unified stream's finish may start *beside* the release-time
    // detection — it runs on the Neural Engine, so it costs the detection nothing — but a route
    // elsewhere cancels it and its transcript is never used.
    @Test("a dictation routed to Uzbek cancels the unified stream and never uses its text")
    func uzbekCancels() async throws {
        let log = Log()
        let s = session(log, route: .uzbek)
        await s.arm()
        let record = await s.finish()
        #expect(log.finished.count <= 1)
        #expect(log.cancelled == 1)
        #expect(record.engineID == "uz")
        #expect(record.raw == "salom dunyo")
    }

    @Test("the pump stops at key-up: nothing is appended after the stream was handed over")
    func pumpStopsAtKeyUp() async throws {
        let log = Log()
        let s = session(log, route: .english, samples: 16_000 * 60, paced: true)
        await s.arm()
        try await Task.sleep(for: .milliseconds(150))
        _ = await s.finish()
        let atKeyUp = log.appended
        try await Task.sleep(for: .milliseconds(500))
        #expect(log.appended == atKeyUp)
    }

    @Test("the unified engine's written language replaces the router's en/ru guess")
    func engineLanguageWins() async throws {
        let log = Log()
        // The router guessed English; the engine wrote Russian.
        let s = session(log, route: .english, written: .russian)
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .russian)
        #expect(record.route?.source == .scriptCheck)
    }

    @Test("a pin is never overruled by the engine's language")
    func pinStands() async throws {
        let log = Log()
        let s = session(log, route: .english, written: .russian)
        await s.arm()
        let record = await s.finish(pin: .english)
        #expect(record.route?.language == .english)
        #expect(record.route?.source == .pin)
    }

    @Test("English written on a Russian route is relabelled, never sent to the Uzbek engine")
    func latinOnRussianRouteIsNotUzbek() async throws {
        // Before 4a, Latin text on a Russian route read as a mis-route toward Uzbek, and good
        // English was handed to the Uzbek fine-tune for a second pass.
        let log = Log()
        let s = session(log, route: .russian, written: .english)
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .english)
        #expect(record.engineID == "streamer")
        #expect(record.raw == "Hello there.")
    }
}

/// A stream that has text from its first chunk on, so the hold's polish is primed at once.
private struct TalkativeStream: TranscriptionStream {
    let log: Log
    func append(_ samples: [Float]) async { log.append(samples.count) }
    func finish(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: "Hello there, how are you.", language: .english, engineID: "talkative")
    }
    func cancel() async { log.cancel() }
    func progress() async -> StreamProgress? {
        StreamProgress(committed: "", provisional: "Hello there, how are you.", language: .english)
    }
}

private struct TalkativeEngine: StreamingTranscriptionEngine {
    let log: Log
    let engineID = "talkative"
    let supportedLanguages: Set<Language> = [.english, .russian]
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: "batch", language: language, engineID: engineID)
    }
    func openStream() async -> any TranscriptionStream { TalkativeStream(log: log) }
}

/// A modes model whose load takes as long as a cold Qwen's first Metal compile.
private struct ColdModel: PromptedPolishEngine {
    let polishID = "cold"
    let supportedLanguages: Set<Language> = Set(Language.allCases)
    func polish(_ text: String, language: Language, instructions: String) async throws -> String {
        text
    }
    func polish(_ text: String, language: Language, prompt: PolishPrompt,
                maxOutputTokens: Int) async throws -> String { text }
    func prepare(_ prompts: [PolishPrompt]) async {
        try? await Task.sleep(for: .seconds(3))
    }
}

@Suite("Streaming while the key is held — the modes model loading")
struct LiveStreamPolishLoadTests {

    @Test("a cold modes model loads beside the hold, not in front of the microphone's audio")
    func coldModelDoesNotStallThePump() async throws {
        let log = Log()
        let s = DictationSession(
            audio: LiveFake(total: 16_000 * 2, paced: true),
            router: FixedRouter(language: .english),
            engines: [.unified: TalkativeEngine(log: log), .uzbek: UzbekFake()],
            sink: NullSink(),
            livePolish: DictationSession.LivePolish(behaviour: .message, engine: ColdModel()))
        await s.arm()
        // Two seconds of audio at the hardware's pace; the model takes three to load.
        try await Task.sleep(for: .milliseconds(1_500))
        #expect(log.appended >= 16_000, "the streams saw \(log.appended) samples in 1.5 s")
    }
}

