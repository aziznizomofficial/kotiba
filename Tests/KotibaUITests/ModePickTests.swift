import Foundation
import KotibaCore
import Testing

@testable import KotibaUI

// Reported from real use: "I tried them out in a different window, with different modes, and
// they're absolutely doing the same thing."
//
// The cause was not the prompts. `setMode` recorded the app the choice was made in, and the
// choice expired when the frontmost application changed — but choosing from the menu bar makes
// *Kotiba* frontmost, so the very next dictation, in any other window, saw a different app and
// discarded the choice. Every mode ran as the default. Picking a mode had never once worked.

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

@Suite("A picked mode is the mode that runs")
@MainActor
struct ModePickTests {

    private func controller() -> DictationController {
        DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
    }

    @Test("a picked mode survives dictating in a different application")
    func pickSurvivesAppChange() {
        // The exact reported scenario. `resolveMode()` reads the frontmost app on every call,
        // and in a test that is the test runner — a different app from whatever was frontmost
        // when setMode ran, which is precisely the condition that used to wipe the choice.
        let controller = controller()
        controller.setMode("note")
        #expect(controller.resolveMode().key == "note")

        // Called repeatedly, as a session of dictations would.
        for _ in 0..<3 {
            controller.press()
            #expect(controller.activeModeKey == "note",
                    "the picked mode was lost between dictations")
            controller.cancel()
        }
        #expect(controller.resolveMode().key == "note")
    }

    @Test("the mode announced at key-down is the mode that runs, whatever changes while held")
    func modeIsFixedAtKeyDown() async {
        let controller = controller()
        controller.setMode("super")
        controller.press()
        #expect(controller.activeModeKey == "super")
        // A pick (or an app switch) while the key is held.
        controller.setMode("note")
        controller.release()
        await eventually { !controller.isRunning }
        #expect(controller.lastRecord?.modeKey == "super",
                "ran \(controller.lastRecord?.modeKey ?? "nothing") after announcing super")
    }

    @Test("a pick beats app activation")
    func pickBeatsActivation() {
        // Message claims Slack, Telegram and the rest. Choosing Super must win there too,
        // otherwise the choice is meaningless in exactly the apps people dictate into.
        let controller = controller()
        controller.setMode("super")
        #expect(controller.resolveMode().key == "super")
        #expect(controller.userPickedMode == "super")
    }

    @Test("the menu offers exactly Super, Note, Message, in that order")
    func selectableModes() {
        // Trimmed on the user's instruction. `transcription` stays in the registry because a
        // credential field is routed to it, but it is not offered: dictating raw is the state
        // the app falls into by itself whenever no model is available.
        let controller = controller()
        #expect(controller.selectableModes.map(\.key) == ["super", "note", "message"])
        #expect(!controller.selectableModes.contains { $0.key == "transcription" })
        // And it must still be reachable internally, or the password gate breaks.
        #expect(controller.modes.mode(for: "transcription") != nil)
    }

    @Test("switching between modes actually switches")
    func switchingWorks() {
        let controller = controller()
        for key in ["note", "super", "message", "transcription"] {
            controller.setMode(key)
            #expect(controller.resolveMode().key == key, "could not switch to \(key)")
        }
    }

    @Test("only the four shipped modes exist")
    func fourModes() {
        let controller = controller()
        #expect(Set(controller.modes.modes.map(\.key))
                == ["message", "super", "note", "transcription"])
    }
}

@Suite("A restructuring mode is allowed to compress")
struct RestructuringLengthTests {

    @Test("a checklist made from a rambling dictation is not rejected")
    func checklistSurvives() {
        // Measured in the wild: Note returned ratios of 0.23 and 0.30, and the 0.5 floor threw
        // both away, so the user saw the raw transcript and concluded the mode did nothing.
        let dictation = String(repeating: "and then we should probably also do the thing ", count: 8)
        let checklist = """
            ## Tasks
            - [ ] Do the thing
            - [ ] Do the other thing
            """
        let ratio = Double(checklist.count) / Double(dictation.count)
        #expect(ratio < 0.5, "the fixture must exercise the case that failed (\(ratio))")

        #expect(PolishGuard().check(checklist, against: dictation) != nil,
                "the correction-mode guard should still reject this")
        #expect(PolishGuard.restructuring
            .check(checklist, against: dictation) == nil)
    }

    @Test("even a restructuring mode rejects an empty-ish answer")
    func stillCatchesNothing() {
        let dictation = String(repeating: "some real content here ", count: 20)
        #expect(PolishGuard.restructuring
            .check("ok", against: dictation) != nil)
    }
}

// The override that did not exist.
//
// The menu bar had no language picker, on the grounds that detection was "measured at 88% on
// Uzbek with no English or Russian ever mistaken for it", with Settings › Languages as the
// fallback. Measured on 745 clips of real Uzbek through the shipping ggml-base-q5_1 detector at
// the live 0.05 threshold: recall 83.1%, and 58.4% under two seconds. English is mistaken for it
// — the owner's own diagnostics carry English at cluster mass 0.230 and 0.119 against real Uzbek
// at 0.183 and 0.0122, so no threshold separates the classes. And `defaultLanguage` was never
// consulted as a pin once a detector had loaded, so the advertised fallback did nothing at all.

@Suite("A pinned language is the language that runs")
@MainActor
struct LanguagePinTests {

    private func controller() -> DictationController {
        DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
    }

    @Test("automatic by default — the router still gets to decide")
    func automaticByDefault() {
        let controller = controller()
        #expect(controller.pinnedLanguage == nil)
    }

    @Test("a pin beats the default language")
    func pinBeatsDefault() {
        let settings = AppSettings.hermetic(store: scratch())
        settings.defaultLanguage = .english
        let controller = DictationController(settings: settings, devices: .testing)

        controller.setPinnedLanguage(.uzbek)
        #expect(controller.pinnedLanguage == .uzbek)
        #expect(controller.pinFromSettings() == .uzbek,
                "the pin must reach the router, or it is decoration")
    }

    @Test("clearing the pin goes back to automatic and does not resurrect itself")
    func clearingReturnsToAutomatic() {
        let store = scratch()
        let settings = AppSettings.hermetic(store: store)
        let controller = DictationController(settings: settings, devices: .testing)

        controller.setPinnedLanguage(.uzbek)
        controller.setPinnedLanguage(nil)
        #expect(controller.pinnedLanguage == nil)

        // The subtle one: Snapshot assigns pinnedLanguage straight through rather than with
        // `if let`, because nil is a real value here — it is what Automatic means. With `if let`
        // a cleared pin would silently come back on the next launch.
        let reread = AppSettings.hermetic(store: store)
        #expect(reread.pinnedLanguage == nil, "a cleared pin came back from storage")
    }

    @Test("a pin survives a relaunch")
    func pinPersists() {
        let store = scratch()
        let first = AppSettings.hermetic(store: store)
        DictationController(settings: first, devices: .testing).setPinnedLanguage(.uzbek)
        #expect(AppSettings.hermetic(store: store).pinnedLanguage == .uzbek)
    }

    @Test("only languages that have a model are offered")
    func onlyUsableLanguagesAreOffered() throws {
        let settings = AppSettings.hermetic(store: scratch())
        let controller = DictationController(settings: settings, devices: .testing)
        // Nothing configured: English is always available, the other two are not.
        #expect(controller.pinnableLanguages == [.english])

        // A model that exists on disk makes its language pinnable. Contents do not matter here —
        // `availableLanguages` asks whether the file is there, and loading it is a later problem
        // the settings pane reports on separately.
        let stub = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("kotiba-pin-\(UUID().uuidString).bin")
        try ModelFixture.writeStub(to: stub)
        defer { try? FileManager.default.removeItem(at: stub) }
        settings.uzbekModelPath = stub.path
        #expect(controller.pinnableLanguages == [.uzbek, .english])
    }
}
