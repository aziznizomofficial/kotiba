import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

// "A new press must work immediately after a paste, and even while the previous one is still
// finishing (never 'Still finishing the last one')."
//
// The admission gate used to be `!isRunning`, so any press that landed while the previous
// dictation was still transcribing or polishing was refused. It is `session == nil` now — only a
// key that is already down refuses a press — and that makes three things possible that were not
// before, all of which this file pins: two dictations in flight at once, a later one finishing
// first, and the pastes still arriving in press order.

private struct StubAudio: AudioSource {
    var buffer: AudioBuffer
    func start() async throws {}
    func stop() async throws -> AudioBuffer { buffer }
    func warmUp() async {}
}

private struct StubRouter: LanguageRouter {
    func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        RouteDecision(language: pin ?? .english, source: pin == nil ? .fallback : .pin)
    }
}

/// Answers with a fixed word after a fixed delay — the knob that makes a later dictation finish
/// before an earlier one.
private struct DelayedEngine: TranscriptionEngine {
    var engineID = "delayed"
    var supportedLanguages: Set<Language> = [.english, .uzbek, .russian]
    let word: String
    let delay: Duration

    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        try? await Task.sleep(for: delay)
        return Transcript(raw: word, language: language, engineID: engineID)
    }
}

/// Records what was pasted, in the order it was pasted.
private actor Pasteboard {
    private(set) var pasted: [String] = []
    func append(_ text: String) { pasted.append(text) }
}

private struct RecordingSink: TextSink {
    let board: Pasteboard
    func insert(_ text: String) async throws -> InsertionOutcome {
        await board.append(text)
        return .inserted
    }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        .inserted
    }
}

/// A take that streams until it is stopped, as `MicrophoneTake` does.
private final class LiveStub: LiveAudioSource, @unchecked Sendable {
    let chunks: AsyncStream<[Float]>
    private let continuation: AsyncStream<[Float]>.Continuation
    init() {
        (chunks, continuation) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .unbounded)
    }
    func start() async throws { continuation.yield([Float](repeating: 0.3, count: 1600)) }
    func stop() async throws -> AudioBuffer {
        continuation.finish()
        return AudioBuffer(samples: [Float](repeating: 0.3, count: 1600))
    }
    func warmUp() async {}
}

private actor StreamLog {
    private(set) var cancelled = 0
    func cancel() { cancelled += 1 }
}

private struct LoggedStream: TranscriptionStream {
    let log: StreamLog
    func append(_ samples: [Float]) async {}
    func finish(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: "streamed", language: language, engineID: "logged")
    }
    func cancel() async { await log.cancel() }
}

private struct LoggedStreamingEngine: StreamingTranscriptionEngine {
    let log: StreamLog
    let engineID = "logged"
    let supportedLanguages: Set<Language> = [.english, .russian, .uzbek]
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: "batch", language: language, engineID: engineID)
    }
    func openStream() async -> any TranscriptionStream { LoggedStream(log: log) }
}

@Suite("Pressing again while the last dictation is still finishing")
@MainActor
struct OverlappingDictationTests {

    private static let speech = AudioBuffer(
        samples: (0..<16_000).map { sinf(Float($0) * 0.05) * 0.4 })
    private static let words = ["one", "two", "three", "four", "five",
                                "six", "seven", "eight", "nine", "ten"]

    /// Dictation `i` takes longer the earlier it was pressed: the first is the slowest, so
    /// without ordering the pastes would come out exactly reversed.
    private func controller(board: Pasteboard) -> DictationController {
        let settings = AppSettings.hermetic()
        settings.polishEnabled = false
        settings.autoCapitalise = false
        let controller = DictationController(settings: settings, devices: .testing)
        var next = 0
        controller.sessionOverride = { turn in
            let i = next
            next += 1
            let engine = DelayedEngine(word: Self.words[i % Self.words.count],
                                       delay: .milliseconds(30 * (Self.words.count - i)))
            return DictationSession(
                audio: StubAudio(buffer: Self.speech),
                router: StubRouter(),
                engines: [.unified: engine, .uzbek: engine],
                sink: turn.ordered(RecordingSink(board: board)))
        }
        return controller
    }

    @Test("ten rapid presses, each over the last one's processing: all ten land, in order")
    func tenOverlappingInOrder() async {
        let board = Pasteboard()
        let controller = controller(board: board)

        var overlapped = 0
        for _ in Self.words {
            controller.press()
            // Every press after the first lands while earlier dictations are still in flight.
            #expect(controller.status == .listening,
                    "a press was not admitted: \(controller.status)")
            try? await Task.sleep(for: .milliseconds(5))
            controller.release()
            if controller.isRunning { overlapped += 1 }
        }
        #expect(overlapped == Self.words.count, "the releases did not actually overlap")

        await eventually { !controller.isRunning }
        #expect(!controller.isRunning)
        let pasted = await board.pasted
        #expect(pasted == Self.words, "pasted out of order or incompletely: \(pasted)")
        // The last one pressed is the one the HUD reports.
        #expect(controller.status == .succeeded("ten"), "the HUD shows \(controller.status)")
    }

    @Test("an older dictation finishing does not take the HUD from the one being spoken")
    func olderResultDoesNotOverwriteListening() async {
        let board = Pasteboard()
        let controller = controller(board: board)

        controller.press()
        controller.release()                 // "one" is now transcribing (300 ms)
        controller.press()                   // "two" is being spoken
        await eventually { await !board.pasted.isEmpty }
        #expect(await board.pasted == ["one"])
        #expect(controller.status == .listening,
                "the HUD must stay on the dictation being spoken, got \(controller.status)")
        controller.release()
        await eventually { !controller.isRunning }
        #expect(await board.pasted == ["one", "two"])
    }

    @Test("a cancelled dictation gives up its turn, so the ones behind it still paste")
    func cancelPassesTheTurn() async {
        let board = Pasteboard()
        let controller = controller(board: board)

        controller.press()
        controller.cancel()                  // "one": a shortcut, not a dictation
        controller.press()
        controller.release()                 // "two"
        await eventually { !controller.isRunning }
        #expect(await board.pasted == ["two"])
    }

    @Test("a cancelled dictation stops its streams, so their decodes do not run on behind it")
    func cancelStopsTheStreams() async {
        let log = StreamLog()
        let settings = AppSettings.hermetic()
        settings.polishEnabled = false
        let controller = DictationController(settings: settings, devices: .testing)
        let engine = LoggedStreamingEngine(log: log)
        controller.sessionOverride = { turn in
            DictationSession(audio: LiveStub(), router: StubRouter(),
                             engines: [.unified: engine, .uzbek: engine],
                             sink: turn.ordered(RecordingSink(board: Pasteboard())))
        }
        controller.press()
        try? await Task.sleep(for: .milliseconds(50))
        controller.cancel()
        await eventually { await log.cancelled == 2 }
        #expect(await log.cancelled == 2, "a stream of the cancelled dictation was left running")
    }
}
