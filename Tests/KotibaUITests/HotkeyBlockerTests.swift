import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

// `StartFailure.tapRefused` had nowhere to live. The only hotkey blocker asks
// `PushToTalkMonitor.isPermitted`, and a refused tap happens with the permission *granted* — so
// the app shell caught the failure, called `refreshBlockers()`, and `refreshBlockers()` had
// nothing to report. The user got a dead hotkey and an empty problem list, which reads as the
// app believing everything is fine.

@Suite("A refused event tap is a problem the user is told about")
@MainActor
struct HotkeyBlockerTests {

    @Test("a recorded hotkey failure becomes a blocker")
    func failureRaisesBlocker() async {
        let controller = DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
        controller.recordHotkeyFailure("macOS refused the event tap")
        await controller.refreshBlockers()

        let blocker = controller.blockers.first { $0.id == "hotkey-tap" }
        #expect(blocker != nil, "reported nothing: \(controller.blockers.map(\.id))")
        #expect(blocker?.detail.contains("macOS refused the event tap") == true,
                "the reason the tap gave is the whole diagnosis")
    }

    @Test("clearing it removes the blocker, so a recovered tap stops complaining")
    func recoveryClearsBlocker() async {
        let controller = DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
        controller.recordHotkeyFailure("macOS refused the event tap")
        await controller.refreshBlockers()
        try? #require(controller.blockers.contains { $0.id == "hotkey-tap" })

        controller.recordHotkeyFailure(nil)
        await controller.refreshBlockers()
        #expect(controller.blockers.first { $0.id == "hotkey-tap" } == nil)
    }

    @Test("a working tap raises nothing")
    func silentWhenFine() async {
        let controller = DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
        await controller.refreshBlockers()
        #expect(controller.blockers.first { $0.id == "hotkey-tap" } == nil,
                "a tap that never failed must not be reported as one that did")
    }
}
