import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

// `preferOnDeviceModel` was read three different ways: `makePolisher` treated it as a hard gate,
// `polishStatus` as a description of what would run, and the blocker did not read it at all —
// it asked whether Apple's model exists on the machine. Turning the toggle off with no API key
// saved therefore left every mode silently unpolished, with no blocker and a settings pane
// still reporting the on-device model as ready.

@Suite("What can polish is one answer, not three")
@MainActor
struct PolishAvailabilityTests {

    private func controller(onDevice: Bool) -> DictationController {
        let settings = AppSettings(store: scratch())
        settings.polishEnabled = true
        settings.preferOnDeviceModel = onDevice
        // An account no key was ever stored under, so the Keychain lookup genuinely finds nothing.
        settings.polishKeyAccount = "kotiba.test.\(UUID().uuidString)"
        return DictationController(settings: settings, devices: .testing)
    }

    @Test("with the on-device model off and no key, nothing can polish")
    func chainIsEmpty() {
        let controller = controller(onDevice: false)
        #expect(controller.polishChain(for: controller.modes.defaultMode).isEmpty)
    }

    @Test("and that is reported rather than silently doing nothing")
    func emptyChainRaisesABlocker() async {
        let controller = controller(onDevice: false)
        await controller.refreshBlockers()
        let blocker = controller.blockers.first { $0.id == "no-polisher" }
        #expect(blocker != nil,
                "polish is dead and the user is not told: \(controller.blockers.map(\.id))")
        #expect(blocker?.detail.isEmpty == false)
    }

    @Test("the settings pane agrees with the blocker instead of contradicting it")
    func statusMatchesReality() {
        let controller = controller(onDevice: false)
        let status = controller.polishStatus
        #expect(status.lowercased().contains("nothing can polish"),
                "reads as \"\(status)\"")
        #expect(!status.contains("is ready"),
                "the pane used to call a dead feature ready")
    }

    @Test("switching polish off entirely is a choice, not a fault")
    func disabledIsNotABlocker() async {
        let controller = controller(onDevice: false)
        controller.settings.polishEnabled = false
        await controller.refreshBlockers()
        #expect(controller.blockers.first { $0.id == "no-polisher" } == nil,
                "asking for no polish must not be reported as a problem")
        #expect(controller.polishStatus.contains("Off"))
    }
}
