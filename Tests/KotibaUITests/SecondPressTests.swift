import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

// Reported from real use on the installed build: "it keeps saying still processing the previous
// one and won't record."
//
// `runTask` is assigned in `release()` and was cleared only in `cancel()`, which has no caller in
// the shipping app — so it stayed non-nil for the life of the process. That was harmless while
// the admission gate asked `status.isBusy`, which clears itself when the dictation reaches
// `.succeeded`. Splitting readiness from the dictation moved the gate onto `runTask`, and a
// condition that never cleared became one that refused every press after the first.

@Suite("A finished dictation lets the next one start")
@MainActor
struct SecondPressTests {

    private func controller() -> DictationController {
        DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
    }

    /// A dictation gets as far as it can without a microphone, then settles.
    private func runOnce(_ controller: DictationController) async {
        controller.press()
        controller.release()
        // `release()` hands off to `runTask`; wait for it rather than guessing at a delay.
        //
        // The bound is deliberately far longer than the work takes. These tests share a
        // `@MainActor` with every other UI suite, so the wall-clock cost of one attempt is a
        // fact about machine load, not about the controller: a 2 s bound went red on a cold
        // build simply because a slower suite was holding the actor. A latch — the defect this
        // file exists for — never clears at any bound, so being generous costs a slow failure
        // and buys back a test that does not lie when the machine is busy.
        await eventually { !controller.isRunning }
    }

    @Test("the second press is accepted, and so is the tenth")
    func repeatedPressesWork() async {
        let controller = controller()

        for attempt in 1...10 {
            await runOnce(controller)
            #expect(!controller.isRunning,
                    "attempt \(attempt) left the controller claiming a dictation is still running")

            controller.press()
            guard case .failed(let why, _) = controller.status, why.contains("Still finishing") else {
                controller.release()
                continue
            }
            Issue.record("press \(attempt + 1) was refused with \"\(why)\"")
            return
        }
    }

    @Test("a finished dictation stops blocking recheck")
    func recheckStillRuns() async {
        let controller = controller()
        await runOnce(controller)
        // Before the fix this returned at its first guard for the rest of the process, so the
        // microphone was never warmed again on activation.
        await controller.recheck()
        #expect(!controller.isRunning)
    }

    // Was "a genuine double press is still refused", asserting the "Still finishing" message.
    // A key-down with the key already down is a stuck modifier or a lost key-up; it is ignored
    // now, and the dictation being recorded is left alone rather than papered over with an error.
    @Test("a key-down while the key is already down is ignored, not refused")
    func doublePressIgnored() {
        let controller = controller()
        controller.press()
        controller.press()

        #expect(controller.status == .listening,
                "the held dictation must still read as listening, got \(controller.status)")
        controller.cancel()
    }

    @Test("a press while the last one is still finishing is accepted")
    func pressDuringFinishing() {
        let controller = controller()
        controller.press()
        controller.release()
        // The first dictation is now finishing — `isRunning` — and the next press must start
        // listening straight away rather than say "Still finishing the last one."
        controller.press()
        #expect(controller.status == .listening, "got \(controller.status)")
        controller.cancel()
    }
}
