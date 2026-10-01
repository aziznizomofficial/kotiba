import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

// `resolveMode()` consults `userPickedMode` before `modeFollowsApp`, so a pin is absolute. It had
// exactly one writer — `setMode` — which never wrote nil, and the Settings picker labelled
// "Fallback mode" called it. Changing the fallback therefore switched off app-following, with its
// toggle still showing on, permanently and across relaunches.

@Suite("Pinning a mode and choosing a fallback are different things")
@MainActor
struct ModePinTests {

    private func controller() -> DictationController {
        let settings = AppSettings(store: scratch())
        settings.modeFollowsApp = true
        return DictationController(settings: settings, devices: .testing)
    }

    @Test("setting the fallback does not pin a mode")
    func fallbackDoesNotPin() {
        let controller = controller()
        controller.setDefaultMode("note")

        #expect(controller.settings.defaultModeKey == "note", "the fallback did change")
        #expect(controller.userPickedMode == nil,
                "but app-following must survive a change to the mode it falls back to")
    }

    @Test("picking a mode by hand does pin it")
    func handPickPins() {
        let controller = controller()
        controller.setMode("note")
        #expect(controller.userPickedMode == "note")
    }

    // The transition `userPickedMode`'s own documentation promised — "sticks until they choose
    // another, or Automatic" — and which had no implementation anywhere in Sources or Apps.
    @Test("a pinned mode can be released again")
    func pinIsReleasable() {
        let controller = controller()
        controller.setMode("note")
        try? #require(controller.userPickedMode != nil)

        controller.clearPickedMode()
        #expect(controller.userPickedMode == nil)
    }

    @Test("the fallback still decides when nothing is pinned and no app matches")
    func fallbackAppliesWhenUnpinned() {
        let controller = controller()
        controller.settings.modeFollowsApp = false
        controller.setDefaultMode("message")
        #expect(controller.activeModeKey == "message")
    }
}
