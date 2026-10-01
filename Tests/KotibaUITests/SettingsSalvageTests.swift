import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

/// Writes a settings blob straight into a store, so a test can hand `load()` something a future
/// or past version would have written.
private func store(_ json: String) -> UserDefaults {
    let defaults = scratch()
    defaults.set(Data(json.utf8), forKey: AppSettings.storageKey)
    return defaults
}

@Suite("Unreadable settings cost one field, not all of them")
@MainActor
struct SettingsSalvageTests {

    // `Snapshot` decodes atomically and `Language` is a bare raw-value enum with no unknown case,
    // so a language this version does not know threw and took all 27 settings with it. The user
    // got a factory-fresh app whose only complaint was "No Uzbek model" — pointing at the wrong
    // cause — and the model paths are the hardest state in the app to reconstruct by hand.
    @Test("a language from a newer version does not take the model paths with it")
    func unknownLanguageCostsOneField() {
        let settings = AppSettings(store: store("""
        {"defaultLanguage":"kk","uzbekModelPath":"/models/uz.bin","whisperBeamSize":7}
        """))

        #expect(settings.uzbekModelPath == "/models/uz.bin", "the expensive setting must survive")
        #expect(settings.whisperBeamSize == 7)
        #expect(settings.defaultLanguage == .english, "the unreadable one falls back to default")
        #expect(settings.loadFailure?.contains("defaultLanguage") == true,
                "and the user is told which: \(settings.loadFailure ?? "nil")")
    }

    @Test("a value of the wrong type costs only itself")
    func wrongTypeCostsOneField() {
        let settings = AppSettings(store: store("""
        {"whisperBeamSize":"five","russianModelPath":"/models/ru.bin"}
        """))
        #expect(settings.russianModelPath == "/models/ru.bin")
        #expect(settings.loadFailure?.contains("whisperBeamSize") == true)
    }

    // The compatibility the doc comment has always claimed, now actually true: a key this version
    // has never heard of is ignored rather than fatal.
    @Test("a setting added by a later version is ignored, not fatal")
    func unknownKeyIsHarmless() {
        let settings = AppSettings(store: store("""
        {"uzbekModelPath":"/models/uz.bin","somethingFromTheFuture":{"a":1}}
        """))
        #expect(settings.uzbekModelPath == "/models/uz.bin")
        #expect(settings.loadFailure == nil, "an unknown key is not a failure")
    }

    @Test("a clean blob reports no failure")
    func cleanBlobIsSilent() {
        let settings = AppSettings(store: store("""
        {"defaultLanguage":"uz","uzbekModelPath":"/models/uz.bin"}
        """))
        #expect(settings.defaultLanguage == .uzbek)
        #expect(settings.loadFailure == nil)
    }

    // `save()` fires on the next keystroke in Settings, so without this the only copy of the
    // user's real configuration was gone the moment they touched anything.
    @Test("the original bytes are kept when anything could not be read")
    func originalIsPreserved() {
        let defaults = store("""
        {"defaultLanguage":"kk","uzbekModelPath":"/models/uz.bin"}
        """)
        _ = AppSettings(store: defaults)
        let kept = defaults.data(forKey: AppSettings.storageKey + ".unreadable")
        #expect(kept != nil, "the unreadable blob must outlive the next save")
        #expect(String(data: kept ?? Data(), encoding: .utf8)?.contains("/models/uz.bin") == true)
    }

    @Test("total garbage is survivable and reported")
    func totalGarbage() {
        let settings = AppSettings(store: store("this is not json at all"))
        #expect(settings.loadFailure != nil)
        #expect(settings.defaultLanguage == .english, "defaults are always usable")
    }
}

// Groq retired both models Kotiba shipped with. Measured 2026-08-23 against the user's own key:
// `GET /models` lists neither `llama-3.3-70b-versatile` nor `llama-3.1-8b-instant`, and every
// polish since 2026-08-22 ended in HTTP 404 `model_not_found` on both — 10 of the last 60
// dictations, and 100% of the Russian and Uzbek ones, because on-device claims neither language.
// Every mode degraded to the raw transcript and looked identical, which is exactly "not staying
// true to modes". A stored blob keeps the retired names forever unless something rewrites them.

@Suite("Retired polish models are migrated on load")
@MainActor
struct RetiredModelMigration {

    @Test("the two shipped Groq names become the two that Groq serves now")
    func shippedNamesMigrate() {
        let settings = AppSettings(store: store("""
        {"polishBaseURL":"https://api.groq.com/openai/v1",
         "polishModel":"llama-3.3-70b-versatile","polishFallbackModel":"llama-3.1-8b-instant"}
        """))
        #expect(settings.polishModel == "openai/gpt-oss-120b")
        #expect(settings.polishFallbackModel == "openai/gpt-oss-20b")
        #expect(settings.loadFailure == nil)
    }

    @Test("the defaults themselves are the served names")
    func defaultsAreCurrent() {
        let settings = AppSettings(store: scratch())
        #expect(settings.polishModel == "openai/gpt-oss-120b")
        #expect(settings.polishFallbackModel == "openai/gpt-oss-20b")
        #expect(AppSettings.retiredPolishModels[settings.polishModel] == nil)
        #expect(AppSettings.retiredPolishModels[settings.polishFallbackModel] == nil)
    }

    @Test("a model the user chose is left alone, and so is another provider's")
    func otherNamesAreUntouched() {
        let custom = AppSettings(store: store("""
        {"polishBaseURL":"https://api.groq.com/openai/v1","polishModel":"qwen/qwen3.6-27b"}
        """))
        #expect(custom.polishModel == "qwen/qwen3.6-27b")

        // Cerebras and OpenRouter serve names that overlap Groq's retired list. A retirement
        // at Groq says nothing about them.
        let elsewhere = AppSettings(store: store("""
        {"polishBaseURL":"https://api.cerebras.ai/v1","polishModel":"llama-3.3-70b-versatile"}
        """))
        #expect(elsewhere.polishModel == "llama-3.3-70b-versatile")
    }

    @Test("the migration is idempotent and persists")
    func persists() {
        let defaults = store("""
        {"polishBaseURL":"https://api.groq.com/openai/v1","polishModel":"llama-3.3-70b-versatile"}
        """)
        let first = AppSettings(store: defaults)
        first.save()
        let second = AppSettings(store: defaults)
        #expect(second.polishModel == "openai/gpt-oss-120b")
    }
}

@Suite("Upgrading from 0.2.2")
@MainActor
struct UpgradeFrom022Tests {

    // The installed 0.2.2's blob, key for key (read with `defaults export uz.kotiba.app -` on
    // 2026-09-30); the values are shipped defaults or neutral stand-ins, not the owner's. It has
    // none of the keys 1.0 added: hotkey, ducking, the Bluetooth mic, Always on, login, pinned
    // language, cloud polish, onboarding, downloads.
    @Test("the real 0.2.2 key set loads whole, skips onboarding and keeps right ⌘")
    func realKeySet() {
        let defaults = store("""
        {"autoCapitalise":true,"autoDetectLanguage":true,"defaultLanguage":"en",
         "defaultModeKey":"super","detectorModelPath":"","diagnosticsEnabled":true,
         "historyLimit":0,"keepHistory":true,"modeFollowsApp":false,"modelIdleUnloadMinutes":5,
         "polishBaseURL":"https://api.groq.com/openai/v1","polishEnabled":true,
         "polishFallbackModel":"openai/gpt-oss-20b","polishKeyAccount":"polish-default",
         "polishModel":"openai/gpt-oss-120b","polishTimeoutSeconds":8,"polishUzbek":true,
         "preferOnDeviceModel":true,"preloadAllLanguages":true,"replacements":[],
         "russianModelPath":"/models/ru.bin","silenceThreshold":0.012,"soundFeedback":true,
         "turkicThreshold":0.05,"uzbekModelPath":"/models/uz.bin",
         "vocabulary":{"en":["Kotiba"]},"whisperBeamSize":1,"whisperUseGPU":true}
        """)
        let settings = AppSettings(store: defaults, modelDirectory: nil, modelBundle: nil)
        #expect(settings.loadFailure == nil)
        #expect(settings.hasCompletedOnboarding)          // no first-run tour of their own app
        #expect(settings.hotkey == .rightCommand)
        #expect(settings.autoDownloadModels)               // "on for anyone already using it"
        #expect(DictationController.mayDownload(settings))
        #expect(!settings.alwaysOn && !settings.launchAtLogin)
        #expect(settings.pinnedLanguage == nil)
        #expect(!settings.cloudPolish)
        #expect(settings.preloadAllLanguages && settings.whisperBeamSize == 1)
        #expect(settings.soundFeedback && settings.polishUzbek)
        #expect(settings.uzbekModelPath == "/models/uz.bin")
        #expect(settings.vocabulary == ["en": ["Kotiba"]])
    }
}
