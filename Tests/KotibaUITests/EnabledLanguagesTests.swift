import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

// `AppSettings.enabledLanguages` and what follows from it in the controller: the migration from
// `optionalLanguages`, the removed auto-detect switch, pins, model rows and removable files.

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

private func store(_ json: String) -> UserDefaults {
    let defaults = scratch()
    defaults.set(Data(json.utf8), forKey: AppSettings.storageKey)
    return defaults
}

@Suite("Which languages are on")
@MainActor
struct EnabledLanguagesTests {

    @Test("a fresh install dictates in Uzbek, English and Russian")
    func defaults() {
        let settings = AppSettings.hermetic(store: scratch())
        #expect(settings.languageSubset.languages == Language.core)
    }

    @Test("optionalLanguages migrates to the core three plus those")
    func migratesOptional() {
        let settings = AppSettings(store: store(#"{"optionalLanguages":["ar"]}"#),
                                   modelDirectory: nil, modelBundle: nil)
        #expect(settings.enabledLanguages == [.english, .russian, .uzbek, .arabic])
    }

    @Test("auto-detect switched off becomes a pin on the default language")
    func migratesAutoDetectOff() {
        let settings = AppSettings(
            store: store(#"{"autoDetectLanguage":false,"defaultLanguage":"uz"}"#),
            modelDirectory: nil, modelBundle: nil)
        #expect(settings.pinnedLanguage == .uzbek)
        let kept = AppSettings(
            store: store(#"{"autoDetectLanguage":false,"pinnedLanguage":"ru"}"#),
            modelDirectory: nil, modelBundle: nil)
        #expect(kept.pinnedLanguage == .russian)
    }

    @Test("a stored pin or default on a language that is off is not kept")
    func pinAndDefaultFollowTheSet() {
        let settings = AppSettings(
            store: store(#"{"enabledLanguages":["en"],"pinnedLanguage":"uz","defaultLanguage":"ru"}"#),
            modelDirectory: nil, modelBundle: nil)
        #expect(settings.pinnedLanguage == nil)
        #expect(settings.defaultLanguage == .english)
        #expect(settings.availableLanguages == [.english])
    }

    @Test("an empty stored list reads as every language, never none")
    func neverEmpty() {
        let settings = AppSettings(store: store(#"{"enabledLanguages":[]}"#),
                                   modelDirectory: nil, modelBundle: nil)
        #expect(settings.languageSubset == .all)
    }

    @Test("turning a pinned language off clears the pin; the last one stays on")
    func controllerToggles() {
        let settings = AppSettings.hermetic(store: scratch())
        let controller = DictationController(settings: settings, devices: .testing)
        settings.pinnedLanguage = .russian
        controller.setLanguage(.russian, enabled: false)
        #expect(settings.pinnedLanguage == nil)
        #expect(!controller.dictationLanguages.contains(.russian))
        controller.setLanguage(.uzbek, enabled: false)
        controller.setLanguage(.english, enabled: false)   // the last one: refused
        #expect(settings.enabledLanguages == [.english])
        #expect(controller.pinFromSettings() == nil, "one language: routed free, not pinned")
    }

    @Test("a mode pinned to a language that is off does not route there")
    func modePinOff() {
        let settings = AppSettings.hermetic(store: scratch())
        settings.enabledLanguages = [.english, .uzbek]
        let controller = DictationController(settings: settings, devices: .testing)
        var mode = BuiltInModes.all[0]
        mode.language = .russian
        #expect(controller.effectivePin(for: mode) != .russian)
    }

    @Test("model files are offered for removal only when no language that is on uses them")
    func removableFiles() {
        let enOnly = LanguageSubset([.english])
        // turbo is Turkish's and Arabic's (2026-10-02), never Russian's to give back.
        #expect(LanguageModelFile.removable(for: .russian, on: enOnly) == [])
        #expect(LanguageModelFile.removable(for: .turkish, on: enOnly) == [.turbo])
        #expect(LanguageModelFile.removable(for: .turkish, on: LanguageSubset([.arabic])) == [])
        #expect(LanguageModelFile.removable(for: .arabic, on: enOnly)
                == [.turbo, .cohere, .arabicModes])
        #expect(LanguageModelFile.removable(for: .english, on: enOnly) == [])
        #expect(LanguageModelFile.removable(for: .uzbek, on: enOnly) == [.uzbek])
        #expect(LanguageModelFile.removable(for: .arabic, on: LanguageSubset([.turkish]))
                == [.cohere, .arabicModes])
        #expect(LanguageModelFile.removable(for: .english, on: LanguageSubset([.uzbek]))
                == [.parakeet])
    }

    @Test("the core follows the languages chosen; Turkish and Arabic bring everything they need")
    func downloadsFollow() {
        let items = ModelDownloads.Item.wanted(for: LanguageSubset([.english]))
        #expect(items.contains(.parakeet) && !items.contains(.uzbek) && !items.contains(.arabic))
        #expect(items.contains(.modes) && items.contains(.languageDetector))
        #expect(ModelDownloads.Item.wanted(for: LanguageSubset([.uzbek])).contains(.uzbek))
        #expect(!ModelDownloads.Item.wanted(for: LanguageSubset([.uzbek])).contains(.parakeet))
        // The three core languages: the core and nothing optional.
        let core = ModelDownloads.Item.wanted(for: LanguageSubset([.uzbek, .english, .russian]))
        #expect(core == Set(ModelDownloads.Item.core))
        // Arabic is the whole experience at once: Cohere with turbo, and its own modes model.
        #expect(ModelDownloads.Item.items(for: .arabic) == [.arabic, .arabicModes])
        #expect(ModelDownloads.Item.items(for: .turkish) == [.turkish])
        let arabic = ModelDownloads.Item.wanted(for: LanguageSubset([.uzbek, .arabic]))
        #expect(arabic.isSuperset(of: [.arabic, .arabicModes]) && !arabic.contains(.turkish))
    }
}
