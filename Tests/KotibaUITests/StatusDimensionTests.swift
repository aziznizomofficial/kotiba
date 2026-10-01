import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

// `Status` carried two independent facts in one variable: app readiness (a model loading, a model
// that would not load) and the dictation lifecycle (listening, working, succeeded). Six methods
// wrote it with no rule about who wins, and `isBusy` collapsed both into the admission gate for
// `press()` — so re-preparing a model, which happens on every app activation, made the app refuse
// dictations with "Still finishing the last one." while nothing was finishing.

@Suite("Readiness and the dictation are separate facts")
@MainActor
struct StatusDimensionTests {

    private func controller() -> DictationController {
        DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
    }

    @Test("with no dictation running, the HUD shows readiness")
    func readinessShowsWhenIdle() {
        let controller = controller()
        controller.readiness = .preparing("Uzbek model")
        #expect(controller.status == .preparing("Uzbek model"))
    }

    // The bug, as a test: clicking the menu-bar item triggers `recheck()`, which prepares models
    // and sets readiness to `.preparing`. Holding the key right afterwards was refused.
    @Test("a model loading does not refuse a dictation")
    func preparingDoesNotBlockPress() {
        let controller = controller()
        controller.readiness = .preparing("Uzbek model")

        controller.press()

        #expect(controller.status == .listening,
                "a press during model preparation must be accepted: \(controller.status)")
    }

    @Test("a model that would not load does not refuse a dictation either")
    func failedReadinessDoesNotBlockPress() {
        let controller = controller()
        controller.readiness = .failed("the Uzbek model would not load")

        controller.press()

        #expect(controller.status == .listening)
    }

    @Test("once a dictation is running, it is what the HUD shows")
    func dictationWinsWhileRunning() {
        let controller = controller()
        controller.readiness = .preparing("Uzbek model")
        controller.press()
        #expect(controller.status == .listening, "not the readiness underneath it")
    }

    // Was "a second press while one is already running is still refused". The key is already
    // down, so a second key-down is a lost key-up or a stuck modifier; refusing it with "Still
    // finishing the last one." painted an error over a dictation that was working fine. It is
    // ignored now, and what must survive the split is that it does not start a second one.
    @Test("a second key-down while the key is held is ignored")
    func doublePressIgnored() {
        let controller = controller()
        controller.press()
        try? #require(controller.status == .listening)

        controller.press()

        #expect(controller.status == .listening, "got \(controller.status)")
        controller.cancel()
    }

    @Test("readiness is untouched by a dictation")
    func dimensionsDoNotLeak() {
        let controller = controller()
        controller.readiness = .preparing("Uzbek model")
        controller.press()
        #expect(controller.readiness == .preparing("Uzbek model"),
                "pressing must not overwrite what the app was doing underneath")
    }
}
