import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

// Reported from the installed build: the HUD says "Ready" where the transcript should be, and a
// failed dictation is announced only by its sound.
//
// `status` was `isRunning ? dictation : readiness`, and `release()` clears `runTask` on the line
// *after* `settle()` has written `.succeeded(text)` — so `isRunning` went false microseconds
// after the outcome was written and the projection fell straight back to `readiness`, which is
// `.idle`. The HUD then lingers 2.5 s reading `status` and renders "Ready" every time. On main,
// before readiness and the dictation were split apart, `status` was a stored variable that simply
// kept the last thing written to it, so the outcome stayed up until the next press for free.
//
// The fix must not put the *admission gate* back on a latched value: refusing a press because a
// finished dictation is still on screen is the "Still finishing the last one." bug, and it is
// pinned separately by `SecondPressTests`. Admission asks `isRunning`; the HUD asks `status`.

// MARK: - Doubles

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

private struct StubEngine: TranscriptionEngine {
    var engineID = "stub"
    var supportedLanguages: Set<Language> = [.english, .uzbek, .russian]
    var output = "salom dunyo"
    var shouldThrow = false

    struct Boom: Error, CustomStringConvertible {
        let description = "the engine fell over"
    }

    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        if shouldThrow { throw Boom() }
        return Transcript(raw: output, language: language, engineID: engineID)
    }
}

/// Types nowhere. The real sink drives Accessibility into whatever app is frontmost, which a test
/// must never do.
private struct StubSink: TextSink {
    func insert(_ text: String) async throws -> InsertionOutcome { .inserted }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        .inserted
    }
}

@Suite("A finished dictation stays on the HUD")
@MainActor
struct OutcomeVisibilityTests {

    /// A second of tone, comfortably over the 0.012 silence threshold.
    private static let speech = AudioBuffer(
        samples: (0..<16_000).map { sinf(Float($0) * 0.05) * 0.4 })
    private static let silence = AudioBuffer(samples: [Float](repeating: 0, count: 16_000))

    private func controller(audio: AudioBuffer,
                            engine: StubEngine = StubEngine()) -> DictationController {
        let settings = AppSettings.hermetic()
        // Polish is a separate subsystem with its own tests, and on a Mac where Apple's on-device
        // model is available it would really run.
        settings.polishEnabled = false
        let controller = DictationController(settings: settings, devices: .testing)
        controller.sessionOverride = { _ in
            DictationSession(
                audio: StubAudio(buffer: audio),
                router: StubRouter(),
                engines: [.unified: engine, .uzbek: engine],
                sink: StubSink())
        }
        return controller
    }

    /// Press, release, and wait for the run to actually finish rather than guessing at a delay.
    private func runOnce(_ controller: DictationController) async {
        controller.press()
        controller.release()
        await eventually { !controller.isRunning }
    }

    // The finding, as a test.
    @Test("the transcript is what the HUD shows after the run ends")
    func succeededOutlivesTheRun() async {
        let controller = controller(audio: Self.speech)

        await runOnce(controller)

        #expect(!controller.isRunning)
        #expect(controller.status == .succeeded("salom dunyo"),
                "the HUD reads this for 2.5 s after key-up and it said \(controller.status)")
    }

    // The 2.5 s linger in `KotibaMacApp.scheduleHide()`, compressed. The outcome has to survive
    // wall-clock time with nothing else happening, not just the instant after `settle()`.
    @Test("and it is still there once the HUD has had time to draw it")
    func succeededSurvivesTheLinger() async {
        let controller = controller(audio: Self.speech)
        await runOnce(controller)

        try? await Task.sleep(for: .milliseconds(200))

        #expect(controller.status == .succeeded("salom dunyo"))
    }

    @Test("silence is reported as silence, not as Ready")
    func heardNothingOutlivesTheRun() async {
        let controller = controller(audio: Self.silence)

        await runOnce(controller)

        #expect(controller.status == .heardNothing,
                "the user needs to be told nothing was heard: \(controller.status)")
    }

    // Before the fix this was the loudest symptom: `settle()` plays the failure sound and writes
    // the message, and the message was gone before anything could render it.
    @Test("a failure is readable, not just audible")
    func failureOutlivesTheRun() async {
        let controller = controller(audio: Self.speech,
                                    engine: StubEngine(shouldThrow: true))

        await runOnce(controller)

        guard case .failed(let why, _) = controller.status else {
            Issue.record("expected the failure to still be showing, got \(controller.status)")
            return
        }
        #expect(!why.isEmpty)
    }

    // The regression this fix must not cause. `press()` asks `isRunning`, never `status`.
    @Test("a finished dictation on screen does not refuse the next press")
    func theOutcomeIsNotAnAdmissionGate() async {
        let controller = controller(audio: Self.speech)
        await runOnce(controller)
        try? #require(controller.status == .succeeded("salom dunyo"))

        controller.press()

        #expect(controller.status == .listening,
                "the latch is for the HUD only; admission keys off isRunning: \(controller.status)")
    }

    @Test("the next press clears the last result rather than leaving it underneath")
    func pressClearsTheOutcome() async {
        let controller = controller(audio: Self.speech)
        await runOnce(controller)

        controller.press()
        controller.cancel()

        #expect(controller.status == .idle,
                "a cancelled dictation has no outcome, and the previous one is over")
    }

    // The one thing besides a press that is allowed to take the HUD back. A model that starts
    // loading — or one that will not — is news the user needs more than a transcript they have
    // already been handed.
    @Test("a readiness change that matters supersedes the result")
    func readinessTakesItBack() async {
        let controller = controller(audio: Self.speech)
        await runOnce(controller)
        try? #require(controller.status == .succeeded("salom dunyo"))

        controller.readiness = .preparing("Uzbek model")

        #expect(controller.status == .preparing("Uzbek model"))
    }

    // ...but re-writing the same readiness must not. `settleStatus()` writes `.idle` over `.idle`
    // on every app activation, and treating that as news would wipe the transcript off the HUD
    // for anyone who clicks the menu-bar item after dictating.
    @Test("re-writing the same readiness does not")
    func unchangedReadinessLeavesItAlone() async {
        let controller = controller(audio: Self.speech)
        await runOnce(controller)

        controller.readiness = .idle

        #expect(controller.status == .succeeded("salom dunyo"))
    }
}
