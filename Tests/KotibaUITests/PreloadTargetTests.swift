import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

// What the key-down preload should page in, as a rule rather than as a side effect.
//
// Same reasoning as `modelsChanged`: the effect is a 539 MB load, which no test can observe
// without real weights, so the decision is what gets tested.

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

@Suite("What gets paged in at key-down")
@MainActor
struct PreloadTargetTests {

    /// A file that exists, so `AppSettings.modelExists` accepts the path.
    private func stubModel() throws -> URL {
        URL(fileURLWithPath: try ModelFixture.plausible())
    }

    @Test("a mode that pins a language settles it")
    func pinWins() {
        let settings = AppSettings.hermetic(store: scratch())
        #expect(DictationController.languageToPreload(pin: .uzbek, settings: settings) == .uzbek)
    }

    @Test("with no detector, the default language is the only one the router can return")
    func noDetectorMeansDefault() {
        let settings = AppSettings.hermetic(store: scratch())
        settings.detectorModelPath = "" // no detector: nothing decides but the default
        settings.defaultLanguage = .russian
        #expect(DictationController.languageToPreload(pin: nil, settings: settings) == .russian)
    }

    // The shipped configuration, and the one that was broken: no built-in mode pins a language,
    // so this used to resolve to `defaultLanguage` — English — for which there is no whisper
    // engine to page in at all. The preload did nothing in exactly the case it was written for.
    @Test("one configured whisper model is the router's only non-English option, so page it in")
    func soleModelIsTheGuess() throws {
        let url = try stubModel()
        defer { try? FileManager.default.removeItem(at: url) }

        let settings = AppSettings.hermetic(store: scratch())
        settings.uzbekModelPath = url.path
        settings.detectorModelPath = url.path
        try #require(settings.autoDetectReady)

        #expect(DictationController.languageToPreload(pin: nil, settings: settings) == .uzbek,
                "English is Apple's engine and needs no paging in, so Uzbek is the only thing worth loading early")
    }

    // Bundled and auto-discovered installs — everyone who was handed the .dmg.
    //
    // `AppSettings` finds a model in three steps: the explicit setting, a known filename in the
    // support directory, then the same filename inside the app bundle. This rule read the raw
    // setting. On a bundled install that setting is empty, so `configured` came out empty and
    // nothing was ever paged in — the preload was dead in the one distribution it matters most
    // for, and the symptom is a 7.8 s wait on the first Uzbek dictation of every session.
    @Test("a model found without being configured still counts as configured")
    func discoveredModelIsPreloaded() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("kotiba-discovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try ModelFixture.writeStub(
            to: directory.appendingPathComponent(AppSettings.knownUzbekModels[0]))
        try ModelFixture.writeStub(
            to: directory.appendingPathComponent(AppSettings.knownDetectorModels[0]))

        let settings = AppSettings(store: scratch(), modelDirectory: directory, modelBundle: nil)
        try #require(settings.uzbekModelPath.isEmpty, "nothing was configured by hand")
        try #require(settings.autoDetectReady)

        #expect(DictationController.languageToPreload(pin: nil, settings: settings) == .uzbek,
                "the model is right there; the empty setting is not the question")
    }

    // The call site, not the rule. It passed `mode.language` alone — and no shipped mode pins a
    // language — so the one control a user has for overruling the acoustic router was ignored at
    // key-down. With both models present the guess is nil, so a pinned user got no preload at all.
    @Test("the menu pin decides what gets paged in")
    func menuPinIsHonoured() throws {
        let url = try stubModel()
        defer { try? FileManager.default.removeItem(at: url) }

        let settings = AppSettings.hermetic()
        settings.uzbekModelPath = url.path
        settings.russianModelPath = url.path
        settings.detectorModelPath = url.path
        try #require(settings.autoDetectReady)
        let controller = DictationController(settings: settings, devices: .testing)
        let mode = controller.modes.defaultMode
        try #require(mode.language == nil, "no built-in mode pins a language — that is the point")
        try #require(controller.languageToPreload(for: mode) == nil, "no honest guess without one")

        settings.pinnedLanguage = .russian

        #expect(controller.languageToPreload(for: mode) == .russian)
    }

    @Test("two configured models and no pin means there is no honest guess")
    func twoModelsNoGuess() throws {
        let url = try stubModel()
        defer { try? FileManager.default.removeItem(at: url) }

        let settings = AppSettings.hermetic(store: scratch())
        settings.uzbekModelPath = url.path
        settings.russianModelPath = url.path
        settings.detectorModelPath = url.path
        try #require(settings.autoDetectReady)

        #expect(DictationController.languageToPreload(pin: nil, settings: settings) == nil,
                "guessing here would page in 1 GB to use half of it; the session loads the routed engine on demand instead")
    }
}
