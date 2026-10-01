import Foundation
import KotibaCore
import KotibaEngines
import Testing

@testable import KotibaUI

// The controller owns a real microphone and real engines, so these tests exercise only the
// parts that are pure: how failures are worded, how a mode is chosen, and what state a HUD
// would render. Nothing here opens a device.

@Suite("What the user is told when something breaks")
struct FailureMessageTests {

    @Test("every session failure becomes a sentence, not an enum case")
    func messagesAreHuman() {
        let cases: [SessionFailure] = [
            .armingFailed("AVAudioEngine error 561145187"),
            .captureFailed("dropped 400 samples"),
            .noEngineReady(.uzbek, .uzbek),
            .noEngineReady(.unified, .english),
            .noEngineReady(.unified, .russian),
            .transcriptionFailed("whisper_full returned 3"),
            .insertionRefused("Accessibility permission has not been granted"),
            .insertionTimedOut,
        ]
        for failure in cases {
            let message = DictationController.describe(failure)
            #expect(!message.isEmpty)
            // "an error occurred" cost days on the predecessor. Anything a HUD shows has to
            // survive being read by someone who did not write it.
            #expect(message.count > 12, "\(failure) reads as \"\(message)\"")
            #expect(!message.contains("Optional("))
            #expect(!message.contains("Error Domain"))
        }
    }

    @Test("a missing Uzbek model tells the user where to fix it")
    func missingUzbekModelIsActionable() {
        let message = DictationController.describe(SessionFailure.noEngineReady(.uzbek, .uzbek))
        #expect(message.contains("Settings"))
        #expect(message.lowercased().contains("uzbek"))
    }

    // `.unified` is English *and* Russian, so a failure carrying only the family could not say
    // which was missing — and the UI resolved that ambiguity by always blaming English, sending
    // anyone with an unloaded Russian model to look at the one engine that was working.
    @Test("a missing Russian model is not reported as an English problem")
    func missingRussianModelNamesRussian() {
        let message = DictationController.describe(SessionFailure.noEngineReady(.unified, .russian))
        #expect(message.lowercased().contains("russian"), "reads as \"\(message)\"")
        #expect(!message.lowercased().contains("english"))
        #expect(message.contains("Settings"))
    }

    @Test("an engine failure keeps the reason the engine gave")
    func engineFailurePassesThrough() {
        let message = DictationController.describe(
            EngineFailure.modelMissing(path: "/models/gone.bin"))
        #expect(message.contains("/models/gone.bin"))
    }
}

@Suite("Status drives the HUD")
struct StatusTests {

    @Test("busy states are exactly the ones that should block a second press")
    func busyStates() {
        #expect(DictationController.Status.listening.isBusy)
        #expect(DictationController.Status.preparing("Uzbek model").isBusy)
        #expect(DictationController.Status.working("transcribing").isBusy)

        // A finished dictation must not block the next one — the most common real usage is
        // two sentences in a row.
        #expect(!DictationController.Status.idle.isBusy)
        #expect(!DictationController.Status.succeeded("hello").isBusy)
        #expect(!DictationController.Status.heardNothing.isBusy)
        #expect(!DictationController.Status.failed("no").isBusy)
    }

    @Test("heardNothing is its own state, not a failure and not a success")
    func heardNothingIsDistinct() {
        // Roughly a third of the predecessor's dictations returned an empty string and called
        // it success. The state machine has a third terminal case precisely so the HUD can say
        // "I did not hear anything" instead of pasting nothing and looking fine.
        #expect(DictationController.Status.heardNothing != .succeeded(""))
        #expect(DictationController.Status.heardNothing != .failed(""))
    }
}

@Suite("Mode selection")
@MainActor
struct ModeSelectionTests {

    private func controller() -> DictationController {
        DictationController(settings: AppSettings.hermetic(store: UserDefaults(suiteName: UUID().uuidString)!), devices: .testing)
    }

    @Test("the shipped modes are all present and the default polishes")
    func modesLoad() {
        // Super is the default as of 2026-08-08: it is first in the menu, and it is the mode
        // whose failure is least costly — it changes as little as it can.
        let controller = controller()
        #expect(controller.modes.modes.count == 4)
        #expect(controller.modes.defaultMode.key == "super")
        #expect(controller.modes.defaultMode.polishes)
    }

    @Test("turning off follow-the-app pins the chosen mode")
    func pinnedMode() {
        let controller = controller()
        controller.settings.modeFollowsApp = false
        controller.setMode("note")
        #expect(controller.resolveMode().key == "note")
        #expect(controller.activeModeKey == "note")
    }

    @Test("setting a mode persists it, so it survives a relaunch")
    func modePersists() {
        let store = UserDefaults(suiteName: UUID().uuidString)!
        let first = DictationController(settings: AppSettings.hermetic(store: store), devices: .testing)
        first.setMode("note")

        let second = DictationController(settings: AppSettings.hermetic(store: store), devices: .testing)
        #expect(second.settings.defaultModeKey == "note")
        #expect(second.modes.defaultKey == "note")
    }

    @Test("the fallback registry is valid, so a broken prompt cannot crash launch")
    func fallbackRegistry() {
        // Only reachable if a shipped prompt fails its own validation — which a test prevents —
        // but a force-unwrap on the launch path deserves proof it cannot trap.
        let registry = ModeRegistry.emptyFallback
        #expect(registry.defaultMode.key == "transcription")
        #expect(!registry.modes.isEmpty)
    }
}

@Suite("Blockers name what the user has to do")
@MainActor
struct BlockerTests {

    @Test("no Uzbek model is always reported, because it is the most common setup gap")
    func uzbekBlocker() async {
        let controller = DictationController(
            settings: AppSettings.hermetic(store: UserDefaults(suiteName: UUID().uuidString)!), devices: .testing)
        await controller.refreshBlockers()
        let blocker = controller.blockers.first { $0.id == "uzbek-model" }
        #expect(blocker != nil)
        #expect(blocker?.detail.contains("Settings") == true)
    }

    @Test("every blocker has a title and a detail that says what to do")
    func blockersAreActionable() async {
        let controller = DictationController(
            settings: AppSettings.hermetic(store: UserDefaults(suiteName: UUID().uuidString)!), devices: .testing)
        await controller.refreshBlockers()
        for blocker in controller.blockers {
            #expect(!blocker.title.isEmpty)
            #expect(blocker.detail.count > 10, "\(blocker.id) says only \"\(blocker.detail)\"")
        }
        // Ids are what the UI keys on; duplicates would silently drop rows.
        #expect(Set(controller.blockers.map(\.id)).count == controller.blockers.count)
    }
}
