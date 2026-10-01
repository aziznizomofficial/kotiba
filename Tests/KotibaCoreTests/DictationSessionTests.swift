import Foundation
import Synchronization
import Testing

@testable import KotibaCore

// Band 1. No signing, no models, no microphone, no network — milliseconds.
//
// The bar for C-06 is every transition covered including every failure edge, because the
// defects this state machine exists to prevent were all silent in the previous build: an
// empty transcript that should have said "I heard nothing", a fallback to a 30x slower
// engine that nothing reported, and a polish step in front of the insertion.

// MARK: - Doubles

private struct FakeAudio: AudioSource {
    var buffer: AudioBuffer
    var failOnStart = false
    var failOnStop = false
    /// Real `AVAudioEngine.start()` measured 103 ms on this Mac and 302 ms on the iPhone.
    /// That suspension is where the arm/finish race lives, so tests can reproduce it.
    var startDelay: Duration = .zero

    struct Boom: Error {}

    func start() async throws {
        if startDelay != .zero { try? await Task.sleep(for: startDelay) }
        if failOnStart { throw Boom() }
    }
    func stop() async throws -> AudioBuffer {
        if failOnStop { throw Boom() }
        return buffer
    }
    func warmUp() async {}
}

private struct FakeRouter: LanguageRouter {
    var decision: RouteDecision
    func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        if let pin { return RouteDecision(language: pin, source: .pin) }
        return decision
    }
}

private struct FakeEngine: TranscriptionEngine {
    var engineID = "fake"
    var supportedLanguages: Set<Language> = [.english]
    var ready = true
    var output = "hello world"
    var shouldThrow = false

    struct Boom: Error {}

    func isReady() async -> Bool { ready }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        if shouldThrow { throw Boom() }
        return Transcript(raw: output, language: language, engineID: engineID)
    }
}

/// An engine that takes longer than any deadline, for asserting the deadline exists.
private struct SlowEngine: TranscriptionEngine {
    var engineID = "slow-uz"
    var supportedLanguages: Set<Language> = [.uzbek]
    var delay: Duration

    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        try await Task.sleep(for: delay)
        return Transcript(raw: "too late", language: language, engineID: engineID)
    }
}

/// The shape every real engine actually has: cold until something loads it. `FakeEngine` cannot
/// model this because a struct's `prepare()` has nowhere to put the result, which is precisely why
/// the cold-start defect survived 368 passing tests.
private actor LazyEngine: TranscriptionEngine {
    nonisolated let engineID = "lazy"
    nonisolated let supportedLanguages: Set<Language> = [.english]

    private var loaded = false
    private(set) var prepareCalls = 0
    private let loadError: String?

    struct LoadFailed: Error, CustomStringConvertible {
        let description: String
    }

    init(loadError: String? = nil) { self.loadError = loadError }

    func isReady() async -> Bool { loaded }

    func prepare() async throws {
        prepareCalls += 1
        if let loadError { throw LoadFailed(description: loadError) }
        loaded = true
    }

    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        guard loaded else { throw LoadFailed(description: "transcribe reached a cold engine") }
        return Transcript(raw: "loaded and heard", language: language, engineID: engineID)
    }
}

/// Records what it was asked to do and when, so ordering can be asserted rather than assumed.
private final class SinkLog: @unchecked Sendable {
    enum Event: Equatable { case insert(String), replace(String, String) }
    private let lock = NSLock()
    private var _events: [Event] = []
    var events: [Event] { lock.lock(); defer { lock.unlock() }; return _events }
    func append(_ e: Event) { lock.lock(); _events.append(e); lock.unlock() }
}

private struct RecordingSink: TextSink {
    let log: SinkLog
    var insertOutcome: InsertionOutcome = .inserted
    var replaceOutcome: InsertionOutcome = .inserted
    var throwOnInsert = false

    struct Boom: Error {}

    func insert(_ text: String) async throws -> InsertionOutcome {
        if throwOnInsert { throw Boom() }
        log.append(.insert(text))
        return insertOutcome
    }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        log.append(.replace(previous, text))
        return replaceOutcome
    }
}

private struct FakePolisher: PolishEngine {
    var polishID = "fake-polish"
    var supportedLanguages: Set<Language> = [.english]
    var output: String?
    var delay: Duration = .zero
    var shouldThrow = false

    struct Boom: Error {}

    func polish(_ text: String, language: Language, instructions: String) async throws -> String {
        if delay != .zero { try await Task.sleep(for: delay) }
        if shouldThrow { throw Boom() }
        return output ?? text
    }
}

/// A polisher that cannot be cancelled, because the one that matters cannot be either.
///
/// `Task.detached` does not inherit cancellation, so the sleep inside runs to completion however
/// hard the caller cancels — which is exactly how `FoundationModels` behaves from Kotiba's side.
/// `FakePolisher` sleeps with `try await Task.sleep`, which throws the moment it is cancelled, so
/// it can never catch a deadline that only works by cooperation.
private struct StubbornPolisher: PolishEngine {
    var polishID = "stubborn"
    var supportedLanguages: Set<Language> = [.english]
    var duration: Duration
    /// Set when the body has run to the end — what a deadline that waited for it would wait for.
    let finished = Finished()

    final class Finished: Sendable {
        private let flag = Atomic<Bool>(false)
        var value: Bool { flag.load(ordering: .acquiring) }
        func set() { flag.store(true, ordering: .releasing) }
    }

    func polish(_ text: String, language: Language, instructions: String) async throws -> String {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            Task.detached { [duration, finished] in
                try? await Task.sleep(for: duration)
                finished.set()
                c.resume()
            }
        }
        return "arrived far too late"
    }
}

// MARK: - Fixtures

private func loudBuffer(seconds: Double = 1.0, amplitude: Float = 0.5) -> AudioBuffer {
    let n = Int(Double(AudioBuffer.sampleRate) * seconds)
    return AudioBuffer(samples: (0..<n).map { i in
        amplitude * Float(sin(Double(i) * 0.05))
    })
}

private func silentBuffer(seconds: Double = 1.0) -> AudioBuffer {
    let n = Int(Double(AudioBuffer.sampleRate) * seconds)
    return AudioBuffer(samples: Array(repeating: 0.0005, count: n))
}

private func makeSession(
    audio: FakeAudio,
    engine: any TranscriptionEngine = FakeEngine(),
    family: EngineFamily = .unified,
    sink: RecordingSink,
    router: FakeRouter = FakeRouter(decision: RouteDecision(language: .english, source: .acoustic)),
    polisher: FakePolisher? = nil,
    config: DictationSession.Config = DictationSession.Config(),
    normalise: @escaping @Sendable (String, Language) -> String = { t, _ in t }
) -> DictationSession {
    DictationSession(
        audio: audio, router: router, engines: [family: engine], sink: sink,
        polisher: polisher, normalise: normalise, config: config
    )
}

// MARK: - The happy path

@Suite("DictationSession — happy path")
struct HappyPath {
    @Test("runs every stage in order and ends done")
    func fullPipeline() async {
        let log = SinkLog()
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: log))
        await s.arm()
        let rec = await s.finish()

        #expect(await s.state == .done)
        #expect(await s.transitions == [
            .arming, .capturing, .finalising, .routing, .transcribing, .inserting, .done,
        ])
        #expect(log.events == [.insert("hello world")])
        #expect(rec.outcome == "done")
        #expect(rec.raw == "hello world")
        #expect(rec.result == "hello world")
        #expect(rec.errors.isEmpty)
    }

    @Test("records a timing for every stage that ran, and none for stages that did not")
    func timings() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: SinkLog()))
        await s.arm()
        let rec = await s.finish()
        for stage in ["arming", "finalising", "routing", "transcribing", "inserting"] {
            #expect(rec.stageMillis[stage] != nil, "missing stage \(stage)")
        }
        #expect(rec.stageMillis["polishing"] == nil)
    }

    @Test("captures audio characteristics and the engine that actually ran")
    func provenance() async {
        let engine = FakeEngine(engineID: "parakeet-v3", supportedLanguages: [.english])
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer(seconds: 2)),
                            engine: engine, sink: RecordingSink(log: SinkLog()))
        await s.arm()
        let rec = await s.finish()
        #expect(rec.engineID == "parakeet-v3")
        #expect(abs(rec.audioSeconds - 2.0) < 0.01)
        #expect(rec.peakAmplitude > 0.4)
        #expect(rec.route?.source == .acoustic)
    }

    @Test("deterministic normalisation is applied and both stages are kept")
    func normalisation() async {
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: SinkLog()),
            normalise: { t, _ in t.uppercased() }
        )
        await s.arm()
        let rec = await s.finish()
        #expect(rec.raw == "hello world")
        #expect(rec.result == "HELLO WORLD")
    }
}

// MARK: - Silence

@Suite("DictationSession — silence")
struct Silence {
    @Test("near-silence is a terminal state, not an empty transcript")
    func heardNothing() async {
        let log = SinkLog()
        let s = makeSession(audio: FakeAudio(buffer: silentBuffer()), sink: RecordingSink(log: log))
        await s.arm()
        let rec = await s.finish()

        #expect(await s.state == .heardNothing)
        #expect(rec.outcome == "heardNothing")
        #expect(log.events.isEmpty, "nothing may be inserted when nothing was heard")
        #expect(rec.raw == nil)
    }

    @Test("the microphone the take came from is written into the record, heard-nothing included")
    func recordsTheInputDevice() async {
        // 2026-10-01: twelve heard-nothing takes at peak 0.005–0.016 and nothing in the log said
        // which device had been listening.
        let phone = InputDeviceInfo(name: "Test iPhone Microphone", transport: .continuity,
                                    sampleRate: 48_000, overrodeDefault: false)
        let quiet = AudioBuffer(samples: Array(repeating: 0.008, count: 16_000 * 2), device: phone)
        let s = makeSession(audio: FakeAudio(buffer: quiet), sink: RecordingSink(log: SinkLog()))
        await s.arm()
        let rec = await s.finish()

        #expect(rec.outcome == "heardNothing")
        #expect(rec.inputDevice == phone)
        // A source that does not know (a WAV file) leaves it absent rather than inventing one.
        let s2 = makeSession(audio: FakeAudio(buffer: silentBuffer()), sink: RecordingSink(log: SinkLog()))
        await s2.arm()
        #expect(await s2.finish().inputDevice == nil)
    }

    @Test("no audio at all is a broken microphone, not a quiet room")
    func emptyIsNotSilence() async {
        // These were indistinguishable, because an empty buffer's peak is zero and so is a quiet
        // one's. Measured in one real session on 2026-08-11: seven captures where arming succeeded
        // in 20–59 ms, zero samples arrived, and the user was told they had said nothing — four of
        // them inside forty seconds, which is what pressing the key again and again looks like.
        let log = SinkLog()
        let s = makeSession(audio: FakeAudio(buffer: AudioBuffer(samples: [])),
                            sink: RecordingSink(log: log))
        await s.arm()
        let rec = await s.finish()

        #expect(rec.outcome == "failed", "an empty capture is a failure, not the user's silence")
        #expect(await s.state != .heardNothing)
        #expect(log.events.isEmpty)
        let joined = rec.errors.joined()
        #expect(joined.contains("no audio at all"))
        #expect(joined.contains("not a quiet room"))
    }

    @Test("audio just above the threshold still transcribes")
    func justAboveThreshold() async {
        var cfg = DictationSession.Config()
        cfg.silenceThreshold = 0.012
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer(amplitude: 0.02)),
                            sink: RecordingSink(log: SinkLog()), config: cfg)
        await s.arm()
        _ = await s.finish()
        #expect(await s.state == .done)
    }
}

// MARK: - Failure edges

@Suite("DictationSession — every failure edge")
struct Failures {
    @Test("arming failure is terminal and named")
    func armingFails() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer(), failOnStart: true),
                            sink: RecordingSink(log: SinkLog()))
        await s.arm()
        guard case .failed(.armingFailed) = await s.state else {
            Issue.record("expected armingFailed, got \(await s.state)"); return
        }
    }

    @Test("capture failure is terminal and named")
    func captureFails() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer(), failOnStop: true),
                            sink: RecordingSink(log: SinkLog()))
        await s.arm()
        let rec = await s.finish()
        guard case .failed(.captureFailed) = await s.state else {
            Issue.record("expected captureFailed, got \(await s.state)"); return
        }
        #expect(rec.outcome == "failed")
    }

    @Test("routing to a family with no registered engine fails loudly")
    func noEngineRegistered() async {
        let log = SinkLog()
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()), family: .unified, sink: RecordingSink(log: log),
            router: FakeRouter(decision: RouteDecision(language: .uzbek, source: .acoustic))
        )
        await s.arm()
        let rec = await s.finish()
        #expect(await s.state == .failed(.noEngineReady(.uzbek, .uzbek)))
        #expect(log.events.isEmpty)
        #expect(rec.errors.count == 1)
    }

    @Test("an engine that is not ready fails loudly instead of falling back silently")
    func engineNotReady() async {
        let log = SinkLog()
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()),
                            engine: FakeEngine(ready: false), sink: RecordingSink(log: log))
        await s.arm()
        let rec = await s.finish()
        #expect(await s.state == .failed(.noEngineReady(.unified, .english)))
        #expect(log.events.isEmpty, "a not-ready engine must never produce an insertion")
        #expect(rec.errors.contains { $0.contains("not ready") })
    }

    // The engines that matter are lazy: whisper reports `isReady() == false` until its 539 MB
    // context is mapped in, and it is only mapped in on demand. A session that refuses a cold
    // engine therefore refuses the language the app exists for — Uzbek never loaded on default
    // settings, and the only thing hiding it was `preloadAllLanguages` being on. So "not loaded
    // yet" and "cannot load" must produce different outcomes.
    @Test("a cold engine that can still load is loaded, not refused")
    func coldEngineIsLoaded() async {
        let log = SinkLog()
        let engine = LazyEngine()
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()),
                            engine: engine, sink: RecordingSink(log: log))
        await s.arm()
        let rec = await s.finish()
        #expect(await engine.prepareCalls == 1, "a cold engine must be given its one chance to load")
        #expect(await s.state == .done)
        #expect(log.events == [.insert("loaded and heard")])
        #expect(rec.outcome == "done")
    }

    @Test("loading on demand is timed, so a slow first dictation is explainable")
    func coldLoadIsMeasured() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()),
                            engine: LazyEngine(), sink: RecordingSink(log: SinkLog()))
        await s.arm()
        let rec = await s.finish()
        #expect(rec.stageMillis["loading"] != nil,
                "the on-demand load is the slowest thing in a first dictation and must be visible")
    }

    // An engine that cannot load is still a hard failure — but the reason it gave has to survive.
    // Reporting "not ready" for a missing file, a bad checksum and a revoked permission alike is
    // what turned a one-line fix into a forensic exercise.
    @Test("an engine whose load fails reports why, not just that it is not ready")
    func coldLoadFailureKeepsReason() async {
        let log = SinkLog()
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()),
                            engine: LazyEngine(loadError: "model file is not where settings say"),
                            sink: RecordingSink(log: log))
        await s.arm()
        let rec = await s.finish()
        #expect(await s.state == .failed(.noEngineReady(.unified, .english)))
        #expect(log.events.isEmpty, "a failed load must never produce an insertion")
        #expect(rec.errors.contains { $0.contains("model file is not where settings say") },
                "the load error is the whole diagnosis and must not be flattened to 'not ready'")
    }

    // A four-minute dictation overruns the ring and the tail is thrown away. The transcript is
    // then genuinely short, and reporting `.done` with an empty error list is the silent-truncation
    // failure this project keeps meeting. The count was being recorded — into a field nothing on
    // this path could read.
    @Test("audio dropped during capture is reported, not delivered as a complete recording")
    func droppedAudioIsReported() async {
        let truncated = AudioBuffer(samples: loudBuffer().samples, droppedSamples: 32_000)
        let s = makeSession(audio: FakeAudio(buffer: truncated),
                            sink: RecordingSink(log: SinkLog()))
        await s.arm()
        let rec = await s.finish()
        #expect(rec.errors.contains { $0.contains("dropped 32000 samples") },
                "lost audio must reach the record: \(rec.errors)")
        #expect(rec.errors.contains { $0.contains("2.0s") }, "and be legible as a duration")
    }

    @Test("a capture that dropped nothing says nothing")
    func noDropsNoNoise() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()),
                            sink: RecordingSink(log: SinkLog()))
        await s.arm()
        let rec = await s.finish()
        #expect(!rec.errors.contains { $0.contains("dropped") },
                "a clean capture must not invent a warning")
    }

    @Test("transcription throwing is terminal and named")
    func transcriptionThrows() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()),
                            engine: FakeEngine(shouldThrow: true), sink: RecordingSink(log: SinkLog()))
        await s.arm()
        _ = await s.finish()
        guard case .failed(.transcriptionFailed) = await s.state else {
            Issue.record("expected transcriptionFailed, got \(await s.state)"); return
        }
    }

    @Test("a refused insertion is a failure, not a success")
    func insertionRefused() async {
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()),
            sink: RecordingSink(log: SinkLog(), insertOutcome: .refused(reason: "no focused field"))
        )
        await s.arm()
        let rec = await s.finish()
        #expect(await s.state == .failed(.insertionRefused("no focused field")))
        #expect(rec.outcome == "failed")
    }

    @Test("a timed-out insertion is a failure, not a success")
    func insertionTimedOut() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()),
                            sink: RecordingSink(log: SinkLog(), insertOutcome: .timedOut))
        await s.arm()
        _ = await s.finish()
        #expect(await s.state == .failed(.insertionTimedOut))
    }

    @Test("a throwing sink is caught rather than propagated")
    func sinkThrows() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()),
                            sink: RecordingSink(log: SinkLog(), throwOnInsert: true))
        await s.arm()
        let rec = await s.finish()
        guard case .failed(.insertionRefused) = await s.state else {
            Issue.record("expected insertionRefused, got \(await s.state)"); return
        }
        #expect(rec.outcome == "failed")
    }

    @Test("finish() before arm() is a no-op rather than a crash")
    func finishWithoutArm() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: SinkLog()))
        let rec = await s.finish()
        #expect(await s.state == .idle)
        #expect(rec.outcome == "incomplete")
    }
}

// MARK: - Routing

@Suite("DictationSession — routing")
struct Routing {
    @Test("a pin beats the acoustic router and is recorded as the source")
    func pinWins() async {
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .english, source: .acoustic)),
            engines: [.uzbek: FakeEngine(engineID: "whisper-uz", supportedLanguages: [.uzbek])],
            sink: RecordingSink(log: SinkLog())
        )
        await s.arm()
        let rec = await s.finish(pin: .uzbek)
        #expect(rec.route?.source == .pin)
        #expect(rec.route?.language == .uzbek)
        #expect(rec.engineID == "whisper-uz")
    }

    @Test("language maps to engine family, and Uzbek is the only one that leaves the unified engine")
    func familyMapping() {
        #expect(EngineFamily(for: .english) == .unified)
        #expect(EngineFamily(for: .russian) == .unified)
        #expect(EngineFamily(for: .uzbek) == .uzbek)
    }
}

// MARK: - Polish

@Suite("DictationSession — polish never blocks the user")
struct Polish {
    @Test("insertion strictly precedes polish")
    func orderingIsStructural() async {
        let log = SinkLog()
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: log),
            polisher: FakePolisher(output: "Hello, world.")
        )
        await s.arm()
        _ = await s.finish(polishInstructions: "tidy")
        #expect(log.events == [.insert("hello world"), .replace("hello world", "Hello, world.")])
    }

    @Test("a successful polish is recorded without discarding the raw stages")
    func polishSucceeds() async {
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: SinkLog()),
            polisher: FakePolisher(output: "Hello, world.")
        )
        await s.arm()
        let rec = await s.finish(polishInstructions: "tidy")
        #expect(await s.state == .done)
        #expect(rec.raw == "hello world")
        #expect(rec.result == "hello world")
        #expect(rec.polished == "Hello, world.")
    }

    @Test("a polish that exceeds its deadline leaves the transcript alone and still succeeds")
    func polishTimesOut() async {
        var cfg = DictationSession.Config()
        cfg.polishDeadline = .milliseconds(30)
        let log = SinkLog()
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: log), config: cfg,
        )
        let s2 = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .english, source: .acoustic)),
            engines: [.unified: FakeEngine()],
            sink: RecordingSink(log: log),
            polisher: FakePolisher(output: "never arrives", delay: .seconds(10)),
            config: cfg
        )
        _ = s
        await s2.arm()
        let rec = await s2.finish(polishInstructions: "tidy")
        #expect(await s2.state == .done, "the session succeeds — the text is already inserted")
        #expect(rec.polished == nil)
        #expect(rec.errors.contains { $0.contains("exceeded") })
        #expect(log.events == [.insert("hello world")], "no replace may follow a timeout")
    }

    @Test("a throwing polisher leaves the transcript alone and still succeeds")
    func polishThrows() async {
        let log = SinkLog()
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: log),
            polisher: FakePolisher(output: "x", shouldThrow: true)
        )
        await s.arm()
        let rec = await s.finish(polishInstructions: "tidy")
        #expect(await s.state == .done)
        #expect(rec.polished == nil)
        #expect(log.events == [.insert("hello world")])
    }

    @Test("a polish that deletes content is rejected by the length guard")
    func lengthGuardRejects() async {
        let log = SinkLog()
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: log),
            polisher: FakePolisher(output: "Hi.")
        )
        await s.arm()
        let rec = await s.finish(polishInstructions: "tidy")
        #expect(rec.polished == nil)
        // The record says which way it failed and by how much, not merely that a guard fired.
        #expect(rec.errors.contains { $0.contains("deleted content") })
        #expect(rec.errors.contains { $0.contains("ratio") })
        #expect(log.events == [.insert("hello world")])
    }

    @Test("a refused replace leaves the raw transcript standing")
    func replaceRefused() async {
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()),
            sink: RecordingSink(log: SinkLog(), replaceOutcome: .refused(reason: "text moved")),
            polisher: FakePolisher(output: "Hello, world.")
        )
        await s.arm()
        let rec = await s.finish(polishInstructions: "tidy")
        #expect(await s.state == .done)
        #expect(rec.polished == nil)
        #expect(rec.errors.contains { $0.contains("replace refused") })
    }

    @Test("polish is skipped for a language the polisher does not support")
    func unsupportedLanguageSkipsPolish() async {
        let log = SinkLog()
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .uzbek, source: .acoustic)),
            engines: [.uzbek: FakeEngine(engineID: "whisper-uz", supportedLanguages: [.uzbek])],
            sink: RecordingSink(log: log),
            polisher: FakePolisher(supportedLanguages: [.english], output: "nope")
        )
        await s.arm()
        let rec = await s.finish(polishInstructions: "tidy")
        #expect(rec.polished == nil)
        #expect(log.events.count == 1)
    }

    @Test("no polish runs when the mode asks for none")
    func noInstructionsNoPolish() async {
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: SinkLog()),
            polisher: FakePolisher(output: "Hello, world.")
        )
        await s.arm()
        let rec = await s.finish()
        #expect(rec.polished == nil)
        #expect(await s.transitions.contains(.polishing) == false)
    }
}

// MARK: - The length guard on its own

@Suite("polish plausibility guard")
struct PlausibilityGuard {
    @Test(arguments: [
        ("hello world", "Hello, world.", true),
        ("hello world", "hello world", true),
        // The measured Uzbek corrector failure: 119 tokens reduced to 4.
        ("onamizni bugun davleniya qilgan kim?", "Kim?", false),
        // The measured local-LLM failure sat at exactly 0.72.
        (String(repeating: "a", count: 100), String(repeating: "a", count: 72), false),
        (String(repeating: "a", count: 100), String(repeating: "a", count: 76), true),
        // Runaway generation is a failure too.
        ("short", String(repeating: "x", count: 500), false),
        ("", "anything", true),
    ])
    func guardBehaviour(original: String, polished: String, expected: Bool) {
        #expect(DictationSession.plausible(polished, given: original) == expected)
    }
}

// MARK: - Regressions found by adversarial review, 2026-08-06

@Suite("an engine that produces no words is not a success")
struct EmptyTranscript {
    @Test("an empty transcript is .heardNothing and is never inserted", arguments: ["", "   ", " \n\t "])
    func emptyIsNotSuccess(raw: String) async {
        let log = SinkLog()
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()),
                            engine: FakeEngine(output: raw), sink: RecordingSink(log: log))
        await s.arm()
        let rec = await s.finish()

        #expect(await s.state == .heardNothing)
        #expect(rec.outcome == "heardNothing")
        #expect(log.events.isEmpty, "an empty string must never be pasted into the user's app")
    }

    @Test("the recorded error names the engine and the audio, so it is diagnosable")
    func errorIsDiagnostic() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer(seconds: 3, amplitude: 0.5)),
                            engine: FakeEngine(engineID: "whisper-uz", output: ""),
                            sink: RecordingSink(log: SinkLog()))
        await s.arm()
        let rec = await s.finish()
        let joined = rec.errors.joined()
        #expect(joined.contains("whisper-uz"))
        #expect(joined.contains("3.00"), "duration must be in the record: \(joined)")
        #expect(joined.contains("no words"))
    }

    @Test("normalisation that reduces the text to nothing is caught too")
    func normalisedToEmpty() async {
        let log = SinkLog()
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()),
            engine: FakeEngine(output: "..."), sink: RecordingSink(log: log),
            normalise: { _, _ in "" }
        )
        await s.arm()
        _ = await s.finish()
        #expect(await s.state == .heardNothing)
        #expect(log.events.isEmpty)
    }
}

@Suite("a key-up during arming is not dropped")
struct ArmFinishRace {
    @Test("finish() called while arm() is still starting the engine waits, then completes")
    func finishDuringArming() async {
        let log = SinkLog()
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer(), startDelay: .milliseconds(60)),
                            sink: RecordingSink(log: log))
        async let arming: Void = s.arm()
        try? await Task.sleep(for: .milliseconds(10))   // land inside audio.start()
        let rec = await s.finish()
        await arming

        #expect(await s.state == .done, "a short press must still produce a dictation")
        #expect(rec.outcome == "done")
        #expect(log.events == [.insert("hello world")])
    }

    @Test("a failed arm still releases a waiting finish rather than hanging it")
    func armFailsWhileFinishWaits() async {
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer(), failOnStart: true, startDelay: .milliseconds(40)),
            sink: RecordingSink(log: SinkLog()))
        async let arming: Void = s.arm()
        try? await Task.sleep(for: .milliseconds(5))
        let rec = await s.finish()
        await arming
        guard case .failed(.armingFailed) = await s.state else {
            Issue.record("expected armingFailed, got \(await s.state)"); return
        }
        #expect(rec.outcome == "failed")
    }
}

@Suite("the session is reusable across presses")
struct Reuse {
    @Test("arming after a completed dictation starts a fresh one")
    func rearmAfterDone() async {
        let log = SinkLog()
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: log))
        await s.arm()
        let first = await s.finish()
        await s.arm()
        let second = await s.finish()

        #expect(await s.state == .done)
        #expect(log.events.count == 2, "the second press must produce its own insertion")
        #expect(second.startedAt >= first.startedAt)
        #expect(await s.transitions.first == .arming, "transitions are per-dictation, not cumulative")
        #expect(await s.transitions.count == 7)
    }

    @Test("arming after a failure starts a fresh one rather than staying wedged")
    func rearmAfterFailure() async {
        let log = SinkLog()
        let s = makeSession(audio: FakeAudio(buffer: silentBuffer()), sink: RecordingSink(log: log))
        await s.arm()
        _ = await s.finish()
        #expect(await s.state == .heardNothing)

        let s2 = makeSession(audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: log))
        await s2.arm()
        _ = await s2.finish()
        #expect(await s2.state == .done)
    }

    @Test("a second key-down before the key-up is ignored, not treated as a new utterance")
    func doubleArmIgnored() async {
        let s = makeSession(audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: SinkLog()))
        await s.arm()
        await s.arm()
        #expect(await s.transitions == [.arming, .capturing])
    }
}

@Suite("a polish that threw is not a polish that timed out")
struct PolishFailureAttribution {
    @Test("a throwing polisher records the error, not a deadline")
    func throwIsNotTimeout() async {
        let s = makeSession(
            audio: FakeAudio(buffer: loudBuffer()), sink: RecordingSink(log: SinkLog()),
            polisher: FakePolisher(polishID: "gonka", output: "x", shouldThrow: true)
        )
        await s.arm()
        let rec = await s.finish(polishInstructions: "tidy")
        let joined = rec.errors.joined()
        #expect(joined.contains("failed"), "the real error must survive: \(joined)")
        #expect(joined.contains("gonka"), "which polisher failed must be recorded")
        #expect(!joined.contains("exceeded"), "a throw must not be reported as a deadline overrun")
    }

    @Test("a genuine timeout still says exceeded")
    func timeoutSaysTimeout() async {
        var cfg = DictationSession.Config()
        cfg.polishDeadline = .milliseconds(30)
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .english, source: .acoustic)),
            engines: [.unified: FakeEngine()],
            sink: RecordingSink(log: SinkLog()),
            polisher: FakePolisher(output: "never arrives", delay: .seconds(10)),
            config: cfg
        )
        await s.arm()
        let rec = await s.finish(polishInstructions: "tidy")
        let joined = rec.errors.joined()
        #expect(joined.contains("exceeded"))
        #expect(!joined.contains("failed:"))
    }

    // Every deadline test above uses a polisher that sleeps cooperatively, so it stops the instant
    // it is cancelled — which means they all passed against an implementation that could not
    // actually enforce a deadline. The real on-device polisher is the opposite: `FoundationModels`
    // publishes no cancellation hook, so the deadline has to hold without the body's cooperation.
    @Test("the deadline holds even when the polisher ignores cancellation entirely")
    func deadlineBoundsAnUncooperativeBody() async {
        var cfg = DictationSession.Config()
        cfg.polishDeadline = .milliseconds(50)
        // What is asserted is "returned on the deadline, not on the body" — so it is asked of the
        // body directly, not of a stopwatch. Two stopwatch versions of this test went red on a
        // loaded machine: 50 ms of work bounded at 1 s came back at 1.14 s, and then bounded at
        // 2 s came back at up to 2.97 s, in 16 of 40 full runs on 2026-09-29. The whole suite runs
        // in parallel and several suites hold cooperative threads for seconds, so the deadline's
        // own timer waits for a thread; no bound under the body's length survives that for sure.
        // Whether the body had finished when `finish()` returned survives any amount of it.
        let polisher = StubbornPolisher(duration: .seconds(30))
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .english, source: .acoustic)),
            engines: [.unified: FakeEngine()],
            sink: RecordingSink(log: SinkLog()),
            polisher: polisher,
            config: cfg
        )
        await s.arm()

        let clock = ContinuousClock()
        let start = clock.now
        let rec = await s.finish(polishInstructions: "tidy")
        let elapsed = clock.now - start

        #expect(!polisher.finished.value,
                "finish() must return on the deadline, not when the body feels like it: \(elapsed)")
        #expect(rec.errors.joined().contains("exceeded"))
        #expect(rec.polished == nil, "a polish that missed the deadline must not be adopted")
    }
}

// MARK: - Recovering a mis-route

// Measured, 2026-08-11T11:52:41Z: Uzbek speech scored a Turkic cluster mass of 0.0122, fell below
// the 0.05 threshold, went to the Russian model and came back as Uzbek spelled out in Cyrillic.
// Nothing checked. `RouteSource.scriptCheck` and `RouteDecision.verify` had both been written for
// exactly this case and neither was ever called from anywhere.

@Suite("DictationSession — the Uzbek-as-Russian mis-route")
struct MisrouteRecovery {

    static let cyrillicUzbek =
        "хоп масалан қаранғалады німәдейсам ғамын яқшы тынық чотке қылып ез болады"
    static let realUzbek = "xo\u{02BB}p masalan qaranglar edi, yaxshi tiniq bo\u{02BB}ladi."

    private static func session(
        log: SinkLog,
        unified: String = cyrillicUzbek,
        uzbek: FakeEngine? = FakeEngine(engineID: "whisper-uz",
                                        supportedLanguages: [.uzbek],
                                        output: realUzbek)
    ) -> DictationSession {
        var engines: [EngineFamily: any TranscriptionEngine] = [
            .unified: FakeEngine(engineID: "whisper-ru", supportedLanguages: [.russian],
                                 output: unified),
        ]
        if let uzbek { engines[.uzbek] = uzbek }
        return DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .russian, source: .acoustic,
                                                       turkicMass: 0.0122)),
            engines: engines,
            sink: RecordingSink(log: log)
        )
    }

    @Test("non-Russian Cyrillic sends the audio back through the Uzbek engine")
    func recovers() async {
        let log = SinkLog()
        let s = Self.session(log: log)
        await s.arm()
        let rec = await s.finish()

        #expect(rec.outcome == "done")
        #expect(rec.raw == Self.realUzbek, "the Uzbek engine's answer is the one kept")
        #expect(rec.engineID == "whisper-uz")
        #expect(rec.route?.language == .uzbek)
        #expect(rec.route?.source == .scriptCheck)
        #expect(rec.route?.turkicMass == 0.0122, "what the acoustic pass thought is preserved")
        #expect(log.events == [.insert(Self.realUzbek)])
        // Never silent: the record says what happened and why.
        let joined = rec.errors.joined()
        #expect(joined.contains("Cyrillic that is not Russian"))
        #expect(joined.contains("whisper-ru"))
        #expect(rec.stageMillis["rerouting"] != nil)
    }

    @Test("genuine Russian is not second-guessed — no rerun, no extra latency")
    func realRussianIsLeftAlone() async {
        let russian = "Так, скажи мне брат, какие фильмы ты просмотрел в последний день?"
        let log = SinkLog()
        let s = Self.session(log: log, unified: russian)
        await s.arm()
        let rec = await s.finish()

        #expect(rec.raw == russian)
        #expect(rec.engineID == "whisper-ru")
        #expect(rec.route?.source == .acoustic)
        #expect(rec.route?.language == .russian)
        #expect(rec.stageMillis["rerouting"] == nil, "the Uzbek engine must not have been woken")
        #expect(rec.errors.isEmpty)
    }

    @Test("with no Uzbek engine loaded it does not report something it cannot act on")
    func noUzbekEngine() async {
        let log = SinkLog()
        let s = Self.session(log: log, uzbek: nil)
        await s.arm()
        let rec = await s.finish()
        #expect(rec.raw == Self.cyrillicUzbek, "the bad answer still stands — there is no other")
        #expect(rec.stageMillis["rerouting"] == nil)
    }

    @Test("an Uzbek engine that is not ready is not waited on")
    func uzbekNotReady() async {
        let log = SinkLog()
        let s = Self.session(log: log, uzbek: FakeEngine(engineID: "whisper-uz",
                                                         supportedLanguages: [.uzbek],
                                                         ready: false))
        await s.arm()
        let rec = await s.finish()
        #expect(rec.engineID == "whisper-ru")
        #expect(rec.stageMillis["rerouting"] == nil)
    }

    @Test("a rerun that throws leaves the first answer in place")
    func rerunThrowsSafely() async {
        let log = SinkLog()
        let s = Self.session(log: log, uzbek: FakeEngine(engineID: "whisper-uz",
                                                         supportedLanguages: [.uzbek],
                                                         shouldThrow: true))
        await s.arm()
        let rec = await s.finish()
        #expect(rec.raw == Self.cyrillicUzbek)
        #expect(rec.engineID == "whisper-ru")
        #expect(rec.route?.source == .acoustic, "the route is only overturned on a real answer")
    }

    @Test("a rerun that returns nothing leaves the first answer in place")
    func rerunEmptySafely() async {
        let log = SinkLog()
        let s = Self.session(log: log, uzbek: FakeEngine(engineID: "whisper-uz",
                                                         supportedLanguages: [.uzbek],
                                                         output: "   "))
        await s.arm()
        let rec = await s.finish()
        #expect(rec.raw == Self.cyrillicUzbek)
        #expect(rec.engineID == "whisper-ru")
        #expect(rec.route?.source == .acoustic)
    }

    @Test("a pin is never overruled — P1 stays absolute")
    func pinIsAbsolute() async {
        // Routing.swift documents a pin as "0 ms, absolute, beats everything". Post-hoc evidence
        // is not allowed to beat the one signal the user actually authored. It is still recorded,
        // because a pinned route that reads as another language is worth knowing about.
        let log = SinkLog()
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .russian, source: .pin)),
            engines: [
                .unified: FakeEngine(engineID: "whisper-ru", supportedLanguages: [.russian],
                                     output: MisrouteRecovery.cyrillicUzbek),
                .uzbek: FakeEngine(engineID: "whisper-uz", supportedLanguages: [.uzbek],
                                   output: MisrouteRecovery.realUzbek),
            ],
            sink: RecordingSink(log: log)
        )
        await s.arm()
        let rec = await s.finish()

        #expect(rec.raw == MisrouteRecovery.cyrillicUzbek, "the pinned engine's answer stands")
        #expect(rec.route?.source == .pin)
        #expect(rec.route?.language == .russian)
        #expect(rec.stageMillis["rerouting"] == nil, "the Uzbek engine must not have been asked")
        let joined = rec.errors.joined()
        #expect(joined.contains("Cyrillic that is not Russian"), "it is still reported")
        #expect(joined.contains("pinned"))
    }

    @Test("the detection is recorded even when there is nothing to try instead")
    func alwaysReported() async {
        // The first version reported only on success, so the default configuration — where the
        // Uzbek model is configured but not resident, because preloadAllLanguages is off — looked
        // exactly like a route nobody had ever doubted.
        let log = SinkLog()
        let s = Self.session(log: log, uzbek: nil)
        await s.arm()
        let rec = await s.finish()
        let joined = rec.errors.joined()
        #expect(joined.contains("Cyrillic that is not Russian"))
        #expect(joined.contains("not loaded"), "and it says what would make it recoverable")
    }

    @Test("a second answer that is not usable is refused, and the refusal is recorded")
    func unusableRerunsAreRefused() async {
        for output in ["[BLANK_AUDIO]",
                       "(silence)",
                       String(repeating: "salom ", count: 9),
                       "Маргулан Сейсимбай подкаст"] {
            let log = SinkLog()
            let s = Self.session(log: log,
                                 uzbek: FakeEngine(engineID: "whisper-uz",
                                                   supportedLanguages: [.uzbek], output: output))
            await s.arm()
            let rec = await s.finish()
            #expect(rec.raw == Self.cyrillicUzbek, "\(output.prefix(20)) should not replace it")
            #expect(rec.route?.source == .acoustic, "\(output.prefix(20))")
            #expect(rec.errors.joined().contains("not usable"), "\(output.prefix(20))")
        }
    }

    @Test("a real Uzbek answer is usable; the rejects are not")
    func usabilityRule() {
        #expect(DictationSession.isUsableRerun(MisrouteRecovery.realUzbek))
        #expect(DictationSession.isUsableRerun("xo\u{02BB}p qarang aka, demo akkaunt ochib"))
        #expect(!DictationSession.isUsableRerun(""))
        #expect(!DictationSession.isUsableRerun("   \n "))
        #expect(!DictationSession.isUsableRerun("[BLANK_AUDIO]"))
        #expect(!DictationSession.isUsableRerun(" [ BLANK_AUDIO ] "))
        #expect(!DictationSession.isUsableRerun("(музыка)"))
        // Cyrillic cannot come out of the Uzbek engine — its vocabulary has none.
        #expect(!DictationSession.isUsableRerun("Маргулан Сейсимбай"))
        // A repetition loop, which is what a mismatched model does with nothing to say.
        #expect(!DictationSession.isUsableRerun(String(repeating: "bir ", count: 8)))
        // Five in a row is still a sentence someone might dictate; six is the bar.
        #expect(DictationSession.isUsableRerun("bir bir bir bir bir sonini yozing"))
        // A marker alongside real words keeps the real words.
        #expect(DictationSession.isUsableRerun("[BLANK_AUDIO] salom do\u{02BB}stim qalaysiz"))
    }

    @Test("a rerun that never answers does not hold the transcript hostage")
    func rerunHasADeadline() async {
        var cfg = DictationSession.Config()
        cfg.rerouteDeadline = .milliseconds(30)
        let log = SinkLog()
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .russian, source: .acoustic)),
            engines: [
                .unified: FakeEngine(engineID: "whisper-ru", supportedLanguages: [.russian],
                                     output: MisrouteRecovery.cyrillicUzbek),
                .uzbek: SlowEngine(delay: .seconds(10)),
            ],
            sink: RecordingSink(log: log),
            config: cfg
        )
        await s.arm()
        let rec = await s.finish()
        #expect(rec.raw == MisrouteRecovery.cyrillicUzbek)
        #expect(rec.errors.joined().contains("did not answer within"))
        #expect(log.events == [.insert(MisrouteRecovery.cyrillicUzbek)])
    }

    @Test("the rerun's deadline grows with the recording: a long dictation is not cut off at 10 s")
    func rerunDeadlineScalesWithLength() async {
        var cfg = DictationSession.Config()
        cfg.rerouteDeadline = .milliseconds(50)
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer(seconds: 4)),
            router: FakeRouter(decision: RouteDecision(language: .russian, source: .acoustic)),
            engines: [
                .unified: FakeEngine(engineID: "whisper-ru", supportedLanguages: [.russian],
                                     output: MisrouteRecovery.cyrillicUzbek),
                // Slower than the floor, well inside what 4 s of audio is allowed.
                .uzbek: SlowEngine(delay: .milliseconds(400)),
            ],
            sink: RecordingSink(log: SinkLog()),
            config: cfg
        )
        await s.arm()
        let rec = await s.finish()
        #expect(rec.raw == "too late", "\(rec.errors)")
        #expect(rec.route?.language == .uzbek)
    }

    @Test("instructions asked for after transcription are asked after the microphone stopped")
    func instructionsAfterTheMicrophone() async {
        let order = OrderLog()
        let s = DictationSession(
            audio: StopLoggingAudio(buffer: loudBuffer(), log: order),
            router: FakeRouter(decision: RouteDecision(language: .english, source: .acoustic)),
            engines: [.unified: FakeEngine(supportedLanguages: [.english], output: "hello world")],
            sink: RecordingSink(log: SinkLog()))
        await s.arm()
        let rec = await s.finish(
            polisher: FakePolisher(output: "Hello, world."),
            polishInstructionsAfterTranscription: {
                await order.add("instructions")
                return .fixed("Punctuate.")
            },
            insertAfterPolish: true)
        #expect(await order.events == ["stop", "instructions"])
        #expect(rec.polished == "Hello, world.", "the late instructions were used: \(rec.errors)")
    }

    @Test("a route that already said Uzbek is never rerun — that would be a loop")
    func neverLoops() async {
        let log = SinkLog()
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .uzbek, source: .acoustic)),
            engines: [.uzbek: FakeEngine(engineID: "whisper-uz", supportedLanguages: [.uzbek],
                                         output: MisrouteRecovery.cyrillicUzbek)],
            sink: RecordingSink(log: log)
        )
        await s.arm()
        let rec = await s.finish()
        #expect(rec.stageMillis["rerouting"] == nil)
        #expect(rec.engineID == "whisper-uz")
    }
}

// MARK: - Recovering the other mis-route

// Measured, 2026-08-23T09:36:31Z: English speech scored a Turkic cluster mass of 0.429, went to
// the Uzbek fine-tune, and came back as `kotub is somehow exit the app in some five, six hours.`
// — lowercase, Latin, English, and accepted, because Latin from an Uzbek route agreed by
// definition. A third of all Uzbek routes on disk were this.

@Suite("DictationSession — the English-as-Uzbek mis-route")
struct EnglishMisrouteRecovery {

    static let uzbekEngineEnglish =
        "kotub is somehow exit the app in some five, six hours. check. nfx."
    static let appleEnglish = "Kotiba is somehow exiting the app in some five, six hours. Check."

    private static func session(
        log: SinkLog,
        uzbekOutput: String = uzbekEngineEnglish,
        unified: FakeEngine? = FakeEngine(engineID: "apple-speech",
                                          supportedLanguages: [.english, .russian],
                                          output: appleEnglish),
        source: RouteSource = .acoustic
    ) -> DictationSession {
        var engines: [EngineFamily: any TranscriptionEngine] = [
            .uzbek: FakeEngine(engineID: "whisper-uz", supportedLanguages: [.uzbek],
                               output: uzbekOutput),
        ]
        if let unified { engines[.unified] = unified }
        return DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .uzbek, source: source,
                                                       turkicMass: 0.429)),
            engines: engines,
            sink: RecordingSink(log: log)
        )
    }

    @Test("English out of the Uzbek engine sends the audio back through the unified engine")
    func recovers() async {
        let log = SinkLog()
        let s = Self.session(log: log)
        await s.arm()
        let rec = await s.finish()

        #expect(rec.outcome == "done")
        #expect(rec.raw == Self.appleEnglish, "the English engine's answer is the one kept")
        #expect(rec.engineID == "apple-speech")
        #expect(rec.route?.language == .english)
        #expect(rec.route?.source == .lexicalCheck)
        #expect(rec.route?.turkicMass == 0.429, "what the acoustic pass thought is preserved")
        #expect(log.events == [.insert(Self.appleEnglish)])
        let joined = rec.errors.joined()
        #expect(joined.contains("reads as English"))
        #expect(joined.contains("whisper-uz"))
        #expect(rec.stageMillis["rerouting"] != nil)
    }

    @Test("genuine Uzbek is not second-guessed — no rerun, no extra latency")
    func realUzbekIsLeftAlone() async {
        let uzbek = "xo'p qara do'stim uchta narsa qilishing kerak"
        let log = SinkLog()
        let s = Self.session(log: log, uzbekOutput: uzbek)
        await s.arm()
        let rec = await s.finish()
        #expect(rec.engineID == "whisper-uz")
        #expect(rec.route?.source == .acoustic)
        #expect(rec.route?.language == .uzbek)
        #expect(rec.stageMillis["rerouting"] == nil, "the unified engine must not have been woken")
        #expect(rec.errors.isEmpty)
    }

    @Test("a pin is never overruled, and the suspicion is still recorded")
    func pinIsAbsolute() async {
        let log = SinkLog()
        let s = Self.session(log: log, source: .pin)
        await s.arm()
        let rec = await s.finish()
        #expect(rec.engineID == "whisper-uz")
        #expect(rec.route?.source == .pin)
        #expect(rec.stageMillis["rerouting"] == nil)
        let joined = rec.errors.joined()
        #expect(joined.contains("reads as English"))
        #expect(joined.contains("pinned"))
    }

    @Test("with no unified engine, or a cold one, the first answer stands and says why")
    func noUnifiedEngine() async {
        for unified in [nil, FakeEngine(engineID: "apple-speech",
                                        supportedLanguages: [.english], ready: false)] {
            let log = SinkLog()
            let s = Self.session(log: log, unified: unified)
            await s.arm()
            let rec = await s.finish()
            #expect(rec.raw == Self.uzbekEngineEnglish)
            #expect(rec.engineID == "whisper-uz")
            #expect(rec.stageMillis["rerouting"] == nil)
            #expect(rec.errors.joined().contains("reads as English"))
        }
    }

    @Test("a second answer that is empty or throws leaves the first in place")
    func unusableRerunsAreRefused() async {
        for engine in [FakeEngine(engineID: "apple-speech", supportedLanguages: [.english],
                                  output: "   "),
                       FakeEngine(engineID: "apple-speech", supportedLanguages: [.english],
                                  shouldThrow: true)] {
            let log = SinkLog()
            let s = Self.session(log: log, unified: engine)
            await s.arm()
            let rec = await s.finish()
            #expect(rec.raw == Self.uzbekEngineEnglish)
            #expect(rec.engineID == "whisper-uz")
            #expect(rec.route?.source == .acoustic)
            #expect(log.events == [.insert(Self.uzbekEngineEnglish)])
        }
    }
}

// MARK: - Uzbek that reached Parakeet (step 4a′)

@Suite("DictationSession — Uzbek routed to Parakeet, read from Parakeet's transcript")
struct UzbekOnParakeetRecovery {

    static let parakeetOnUzbek = "Morvalen tikoshar penduvi askarel dunemba."
    static let uzbekAnswer = "bugun bozorga bordim va non oldim."

    private static func session(unified: String = parakeetOnUzbek,
                                uzbek: String = uzbekAnswer, uzbekReady: Bool = true,
                                pin: Language? = nil, log: SinkLog = SinkLog()) -> DictationSession {
        DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: pin.map { RouteDecision(language: $0, source: .pin) }
                ?? RouteDecision(language: .english, source: .acoustic, turkicMass: 0.012)),
            engines: [
                .unified: FakeEngine(engineID: "parakeet", supportedLanguages: [.english, .russian],
                                     output: unified),
                .uzbek: FakeEngine(engineID: "whisper-uz", supportedLanguages: [.uzbek],
                                   ready: uzbekReady, output: uzbek),
            ],
            sink: RecordingSink(log: log)
        )
    }

    @Test("un-English text from Parakeet is replaced by the Uzbek engine's answer")
    func recovers() async {
        let log = SinkLog()
        let s = Self.session(log: log)
        await s.arm()
        let rec = await s.finish()
        #expect(rec.outcome == "done")
        #expect(rec.raw == Self.uzbekAnswer)
        #expect(rec.engineID == "whisper-uz")
        #expect(rec.route?.language == .uzbek)
        #expect(rec.route?.source == .transcriptCheck)
        #expect(rec.route?.turkicMass == 0.012, "what the acoustic pass thought is preserved")
        #expect(rec.unifiedDoubt == "notEnglish")
        #expect(rec.stageMillis["rerouting"] != nil)
        #expect(log.events == [.insert(Self.uzbekAnswer)])
    }

    @Test("an Uzbek answer that reads as English leaves Parakeet's text, and says so")
    func englishAnswerKeepsParakeet() async {
        let s = Self.session(uzbek: "please send the report to the team before lunch")
        await s.arm()
        let rec = await s.finish()
        #expect(rec.raw == Self.parakeetOnUzbek)
        #expect(rec.route?.source == .acoustic)
        #expect(rec.unifiedDoubt == "notEnglish", "the doubt is recorded whatever came of it")
        #expect(rec.errors.joined().contains("read as English"))
    }

    @Test("English from Parakeet is not second-guessed: no Uzbek pass, no extra latency")
    func englishIsLeftAlone() async {
        let s = Self.session(unified: "Please send the report to the team before lunch.")
        await s.arm()
        let rec = await s.finish()
        #expect(rec.engineID == "parakeet")
        #expect(rec.unifiedDoubt == nil)
        #expect(rec.stageMillis["rerouting"] == nil)
        #expect(rec.errors.isEmpty)
    }

    @Test("a one-word English reply stays English — the Uzbek engine is not asked, nor believed")
    func shortEnglishReplies() async {
        for reply in ["Yeah.", "Ok.", "Yep, sounds good.", "Um, yeah, I think so.",
                      "Meet me on the 1st at 9am."] {
            // What the Uzbek fine-tune does with English audio: writes the English back.
            let s = Self.session(unified: reply, uzbek: reply)
            await s.arm()
            let rec = await s.finish()
            #expect(rec.engineID == "parakeet", "\(reply) was rerouted")
            #expect(rec.route?.language == .english, "\(reply)")
            #expect(rec.unifiedDoubt == nil, "\(reply)")
            #expect(rec.stageMillis["rerouting"] == nil, "\(reply) paid an Uzbek decode")
        }
        // A hesitation alone is still no evidence of English.
        #expect(TranscriptCheck.doubt("Uh.") == .notEnglish)
    }

    @Test("a pin is never overruled, and the check does not even run")
    func pinIsAbsolute() async {
        let s = Self.session(pin: .english)
        await s.arm()
        let rec = await s.finish(pin: .english)
        #expect(rec.engineID == "parakeet")
        #expect(rec.unifiedDoubt == nil)
        #expect(rec.stageMillis["rerouting"] == nil)
    }

    @Test("a cold Uzbek engine: the doubt is recorded and Parakeet's text stands")
    func coldUzbek() async {
        let s = Self.session(uzbekReady: false)
        await s.arm()
        let rec = await s.finish()
        #expect(rec.raw == Self.parakeetOnUzbek)
        #expect(rec.unifiedDoubt == "notEnglish")
        #expect(rec.stageMillis["rerouting"] == nil)
    }

    @Test("the Uzbek answer is not then sent back to English by the lexical check (4c)")
    func noChain() async {
        // Unknown words drag the coverage under 0.5, yet four English function words would trip
        // `LexicalCheck` — which must not run on a route this step just took.
        let answer = "the zorvan tulkar of menvik torbalim is kelvaro dunem and"
        let s = Self.session(uzbek: answer)
        await s.arm()
        let rec = await s.finish()
        #expect(!TranscriptCheck.readsAsEnglish(answer) && LexicalCheck.looksLikeEnglish(answer))
        #expect(rec.route?.source == .transcriptCheck)
        #expect(rec.raw == answer)
    }
}

@Suite("TranscriptCheck")
struct TranscriptCheckTests {
    @Test("English reads as English; the shapes Parakeet writes for Uzbek do not")
    func readings() {
        #expect(TranscriptCheck.doubt("Please send the report to the team before lunch.") == nil)
        #expect(TranscriptCheck.doubt("Ask Gonka about the Codex bridge on the OVH server.") == nil,
                "proper nouns and acronyms are not held against English")
        #expect(TranscriptCheck.doubt("We'll see, but I don't think it's ready.") == nil)
        #expect(TranscriptCheck.doubt("Morvalen tikoshar penduvi askarel.") == .notEnglish)
        #expect(TranscriptCheck.doubt("Keštar volunė šimka tar lėmos.") == .notEnglish)
        #expect(TranscriptCheck.doubt("") == .noWords)
        #expect(TranscriptCheck.doubt("...") == .noWords)
        #expect(TranscriptCheck.doubt("25") == nil, "a number is a transcript")
        #expect(TranscriptCheck.doubt("Привет, как дела?") == nil, "Cyrillic is not judged")
    }

    @Test("the Uzbek engine's English reads as English, its Uzbek does not")
    func verifier() {
        #expect(TranscriptCheck.readsAsEnglish("please send the report to the team"))
        #expect(!TranscriptCheck.readsAsEnglish("bugun bozorga bordim va non oldim."))
        #expect(!TranscriptCheck.readsAsEnglish("xoʻp, qarang aka, men hozir kelaman."))
        #expect(!TranscriptCheck.readsAsEnglish(""))
    }

    @Test("the list is the generated one")
    func lexicon() {
        #expect(TranscriptCheck.lexiconCount == 39_154)
        #expect(TranscriptCheck.isEnglishWord("shouldn't") && TranscriptCheck.isEnglishWord("cat's"))
        #expect(!TranscriptCheck.isEnglishWord("kotib") && !TranscriptCheck.isEnglishWord("va"))
    }
}

private actor OrderLog {
    private(set) var events: [String] = []
    func add(_ event: String) { events.append(event) }
}

private struct StopLoggingAudio: AudioSource {
    var buffer: AudioBuffer
    let log: OrderLog
    func start() async throws {}
    func stop() async throws -> AudioBuffer {
        await log.add("stop")
        return buffer
    }
    func warmUp() async {}
}

// MARK: - Languages that are off (`LanguageSubset`)

@Suite("DictationSession — languages that are off are never routed to")
struct LanguagesOff {

    private static func config(_ languages: [Language]) -> DictationSession.Config {
        var config = DictationSession.Config()
        config.languages = LanguageSubset(languages)
        return config
    }

    @Test("English off: Uzbek that came back as English is not re-run on the English engine")
    func noRecoveryToEnglishWhenOff() async {
        let log = SinkLog()
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .uzbek, source: .acoustic,
                                                       turkicMass: 0.429)),
            engines: [
                .uzbek: FakeEngine(engineID: "whisper-uz", supportedLanguages: [.uzbek],
                                   output: EnglishMisrouteRecovery.uzbekEngineEnglish),
                .unified: FakeEngine(engineID: "apple-speech",
                                     supportedLanguages: [.english, .russian],
                                     output: EnglishMisrouteRecovery.appleEnglish),
            ],
            sink: RecordingSink(log: log),
            config: Self.config([.uzbek, .russian]))
        await s.arm()
        let rec = await s.finish()
        #expect(rec.route?.language == .uzbek, "English is off; the Uzbek route stands")
        #expect(rec.engineID == "whisper-uz")
    }

    @Test("Uzbek off: Cyrillic that is not Russian is not re-run on the Uzbek engine")
    func noRecoveryToUzbekWhenOff() async {
        let log = SinkLog()
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .russian, source: .acoustic)),
            engines: [
                .uzbek: FakeEngine(engineID: "whisper-uz", supportedLanguages: [.uzbek],
                                   output: "salom dunyo"),
                .unified: FakeEngine(engineID: "unified", supportedLanguages: [.english, .russian],
                                     output: "хоп масалан қаранғалады"),
            ],
            sink: RecordingSink(log: log),
            config: Self.config([.english, .russian]))
        await s.arm()
        let rec = await s.finish()
        #expect(rec.route?.language != .uzbek)
        #expect(rec.engineID == "unified")
    }

    @Test("one language on: no detection, routed there for free (source `only`)")
    func soleLanguage() async {
        let log = SinkLog()
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            // The router would say Uzbek; it must not be asked.
            router: FakeRouter(decision: RouteDecision(language: .uzbek, source: .acoustic)),
            engines: [.unified: FakeEngine(engineID: "unified",
                                           supportedLanguages: [.english, .russian],
                                           output: "hello there")],
            sink: RecordingSink(log: log),
            config: Self.config([.english]))
        await s.arm()
        let rec = await s.finish()
        #expect(rec.outcome == "done")
        #expect(rec.route == RouteDecision(language: .english, source: .only))
        #expect(rec.stageMillis["routing"] == nil, "no detection ran")
    }

    @Test("English and Russian alone: no detection, and Parakeet's own label still stands")
    func englishAndRussianAlone() async {
        let log = SinkLog()
        let s = DictationSession(
            audio: FakeAudio(buffer: loudBuffer()),
            router: FakeRouter(decision: RouteDecision(language: .uzbek, source: .acoustic)),
            engines: [.unified: LabellingEngine(output: "привет, как дела", language: .russian)],
            sink: RecordingSink(log: log),
            config: Self.config([.english, .russian]))
        await s.arm()
        let rec = await s.finish()
        #expect(rec.route?.language == .russian)
        #expect(rec.stageMillis["routing"] == nil)
    }
}

/// An engine that names the language it wrote, the way Parakeet does.
private struct LabellingEngine: TranscriptionEngine {
    var engineID = "parakeet"
    var supportedLanguages: Set<Language> = [.english, .russian]
    var output: String
    var language: Language
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language _: Language) async throws -> Transcript {
        Transcript(raw: output, language: language, engineID: engineID)
    }
}
