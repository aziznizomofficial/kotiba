import Foundation
import KotibaCore
import Testing

@testable import KotibaUI

// A private defaults suite per test, so nothing here reads or writes the real app's settings.

private func scratchDefaults(_ name: String = UUID().uuidString) -> UserDefaults {
    UserDefaults(suiteName: name)!
}

@Suite("Settings survive a round trip")
struct SettingsPersistenceTests {

    @Test("every field survives save and load")
    func roundTrip() {
        let store = scratchDefaults()
        let written = AppSettings.hermetic(store: store)
        written.defaultLanguage = .uzbek
        written.uzbekModelPath = "/models/ggml-navoi-medium-q5_0.bin"
        written.whisperUseGPU = false
        written.whisperBeamSize = 5
        written.silenceThreshold = 0.03
        written.soundFeedback = true
        written.vocabulary = ["uz": ["Kotiba", "Toshkent"], "en": ["Kotiba"]]
        written.replacements = [Replacement(find: "teh", replaceWith: "the")]
        written.autoCapitalise = false
        written.defaultModeKey = "email"
        written.modeFollowsApp = false
        written.polishEnabled = true
        written.polishBaseURL = "https://openrouter.ai/api/v1"
        written.polishModel = "qwen/qwen3-30b"
        written.polishKeyAccount = "openrouter"
        written.polishTimeoutSeconds = 12
        written.keepHistory = false
        written.historyLimit = 500
        written.diagnosticsEnabled = false
        written.save()

        let read = AppSettings.hermetic(store: store)
        #expect(read.defaultLanguage == .uzbek)
        #expect(read.uzbekModelPath == "/models/ggml-navoi-medium-q5_0.bin")
        #expect(read.whisperUseGPU == false)
        #expect(read.whisperBeamSize == 5)
        #expect(read.silenceThreshold == 0.03)
        #expect(read.soundFeedback)
        #expect(read.vocabulary["uz"] == ["Kotiba", "Toshkent"])
        #expect(read.replacements == [Replacement(find: "teh", replaceWith: "the")])
        #expect(read.autoCapitalise == false)
        #expect(read.defaultModeKey == "email")
        #expect(read.modeFollowsApp == false)
        #expect(read.polishEnabled)
        #expect(read.polishBaseURL == "https://openrouter.ai/api/v1")
        #expect(read.polishModel == "qwen/qwen3-30b")
        #expect(read.polishKeyAccount == "openrouter")
        #expect(read.polishTimeoutSeconds == 12)
        #expect(read.keepHistory == false)
        #expect(read.historyLimit == 500)
        #expect(read.diagnosticsEnabled == false)
    }

    @Test("a blob written by another version loads, and missing fields keep their defaults")
    func forwardsAndBackwards() throws {
        // The whole reason settings are one JSON blob rather than thirty defaults keys: a
        // version bump must not need a migration per field.
        let store = scratchDefaults()
        let partial = """
        {"defaultLanguage":"uz","somethingFromTheFuture":42,"polishModel":"gpt-5"}
        """
        store.set(Data(partial.utf8), forKey: AppSettings.storageKey)

        let settings = AppSettings.hermetic(store: store)
        #expect(settings.defaultLanguage == .uzbek)
        #expect(settings.polishModel == "gpt-5")
        // Untouched by the blob, so still the shipped default.
        #expect(settings.autoCapitalise)
        #expect(settings.polishBaseURL == "https://api.groq.com/openai/v1")
    }

    @Test("a corrupt blob leaves the app usable rather than taking it down")
    func corruptBlob() {
        let store = scratchDefaults()
        store.set(Data("this is not json".utf8), forKey: AppSettings.storageKey)
        let settings = AppSettings.hermetic(store: store)
        #expect(settings.defaultLanguage == .english)
        #expect(settings.autoCapitalise)
    }

    @Test("loading does not write, so opening the app cannot rewrite settings 20 times")
    func loadingIsSilent() {
        let store = scratchDefaults()
        let first = AppSettings.hermetic(store: store)
        first.defaultModeKey = "note"
        first.save()
        let before = store.data(forKey: AppSettings.storageKey)

        _ = AppSettings.hermetic(store: store)   // load only
        #expect(store.data(forKey: AppSettings.storageKey) == before)
    }

    @Test("the API key is never in the settings blob")
    func noSecrets() throws {
        // Anything in here can end up in a support bundle. The key lives in the Keychain and
        // this file holds only the account name that finds it.
        let store = scratchDefaults()
        let settings = AppSettings.hermetic(store: store)
        settings.polishKeyAccount = "openrouter"
        settings.save()
        let blob = try #require(store.data(forKey: AppSettings.storageKey))
        let text = String(decoding: blob, as: UTF8.self)
        #expect(text.contains("openrouter"))
        #expect(!text.lowercased().contains("apikey"))
        #expect(!text.lowercased().contains("\"key\""))
        #expect(!text.contains("sk-"))
    }
}

@Suite("Derived settings")
struct SettingsDerivedTests {

    @Test("the vocabulary converts, dropping language codes nothing supports")
    func vocabularyConverts() {
        let settings = AppSettings.hermetic(store: scratchDefaults())
        settings.vocabulary = ["uz": ["Kotiba"], "en": ["Kotiba"], "kl": ["nonsense"]]
        let vocabulary = settings.vocabularyValue
        #expect(vocabulary.terms(for: .uzbek) == ["Kotiba"])
        #expect(vocabulary.terms(for: .english) == ["Kotiba"])
        #expect(vocabulary.terms(for: .russian).isEmpty)
    }

    @Test("Uzbek is not ready until the file on disk is actually a model")
    func uzbekReadiness() throws {
        let settings = AppSettings.hermetic(store: scratchDefaults())
        #expect(!settings.uzbekReady)

        // A path is not a model.
        settings.uzbekModelPath = "/definitely/not/here.bin"
        #expect(!settings.uzbekReady)

        // Neither is a file. This is the case existence-checking waved through: a half-finished
        // download of a 539 MB model turned `uzbekReady` true, cleared the "No Uzbek model"
        // blocker and put a green tick in the settings pane, and the only sign anything was
        // wrong arrived 7.8 s into a load attempt.
        let stub = try ModelFixture.truncated()
        defer { try? FileManager.default.removeItem(atPath: stub) }
        settings.uzbekModelPath = stub
        #expect(!settings.uzbekReady)
        #expect(AppSettings.modelProblem(stub) != nil, "and it says which of the two it is")

        let model = try ModelFixture.plausible()
        defer { try? FileManager.default.removeItem(atPath: model) }
        settings.uzbekModelPath = model
        #expect(settings.uzbekReady)
        #expect(AppSettings.modelProblem(model) == nil)
    }

    // Auto-discovery is what makes a .dmg usable. Before it, `uzbekModelPath` defaulted to the
    // empty string and the app reported "no model" until someone opened Settings and pasted a file
    // path — fine on the machine that built it, impossible for anyone handed a build. English
    // worked out of the box and the language the app exists for did not.

    @Test("a model is found by name in the models directory, with no setting at all")
    func discoversByName() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-models-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let settings = AppSettings(store: scratchDefaults(), modelDirectory: directory,
                                   modelBundle: nil)
        #expect(!settings.uzbekReady, "nothing is there yet")

        let newer = directory.appendingPathComponent(AppSettings.knownUzbekModels[0])
        try ModelFixture.writeStub(to: newer)
        #expect(settings.uzbekReady)
        #expect(settings.resolvedUzbekPath == newer.path)
        #expect(settings.uzbekModelPath.isEmpty, "found without the setting being touched")
    }

    @Test("the preferred model name wins when several are present")
    func prefersTheBetterModel() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-models-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        for name in AppSettings.knownUzbekModels {
            try ModelFixture.writeStub(to: directory.appendingPathComponent(name))
        }
        let settings = AppSettings(store: scratchDefaults(), modelDirectory: directory,
                                   modelBundle: nil)
        // Order is deliberate: uzbek_stt_v1 measured 21.68% against navoi-medium's 25.19%, so
        // someone who has both should be served by the better one without choosing.
        #expect(settings.resolvedUzbekPath
                == directory.appendingPathComponent(AppSettings.knownUzbekModels[0]).path)
    }

    @Test("an explicit setting still beats discovery, so a deliberate choice is never overridden")
    func explicitWins() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-models-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try ModelFixture.writeStub(
            to: directory.appendingPathComponent(AppSettings.knownUzbekModels[0]))

        let chosen = directory.appendingPathComponent("my-own-model.bin")
        try ModelFixture.writeStub(to: chosen)

        let settings = AppSettings(store: scratchDefaults(), modelDirectory: directory,
                                   modelBundle: nil)
        settings.uzbekModelPath = chosen.path
        #expect(settings.resolvedUzbekPath == chosen.path)
    }

    @Test("Russian and the detector discover the same way")
    func otherLanguagesDiscoverToo() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-models-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try ModelFixture.writeStub(
            to: directory.appendingPathComponent(AppSettings.knownRussianModels[0]))
        try ModelFixture.writeStub(
            to: directory.appendingPathComponent(AppSettings.knownDetectorModels[0]))

        let settings = AppSettings(store: scratchDefaults(), modelDirectory: directory,
                                   modelBundle: nil)
        #expect(settings.russianReady)
        #expect(settings.resolvedDetectorPath != nil)
        #expect(settings.availableLanguages == [.english, .russian])
    }

    @Test("a model shipped inside the app bundle is found — this is what a .dmg rests on")
    func discoversInsideTheBundle() throws {
        // Scripts/make-dmg.sh copies the weights to Contents/Resources/models, and the whole claim
        // that the disk image works on a machine that has never run `make bootstrap` comes down to
        // this lookup. Built here as a real bundle on disk rather than trusted.
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("Kotiba-\(UUID().uuidString).app")
        let resources = root.appendingPathComponent("Contents/Resources/models")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try ModelFixture.writeStub(
            to: resources.appendingPathComponent(AppSettings.knownUzbekModels[0]))
        try ModelFixture.writeStub(
            to: resources.appendingPathComponent(AppSettings.knownRussianModels[0]))

        let bundle = try #require(Bundle(url: root), "could not open the staged bundle")
        // An empty support directory, so only the bundle can answer.
        let empty = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-empty-\(UUID().uuidString)")
        let settings = AppSettings(store: scratchDefaults(), modelDirectory: empty,
                                   modelBundle: bundle)

        #expect(settings.uzbekReady, "a bundled Uzbek model was not found")
        #expect(settings.russianReady)
        #expect(settings.resolvedUzbekPath?.hasPrefix(root.path) == true)
        #expect(settings.uzbekModelPath.isEmpty, "and without any setting being written")
    }

    @Test("the models directory beats the bundle, so a newer model can be dropped in")
    func supportDirectoryWinsOverBundle() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("Kotiba-\(UUID().uuidString).app")
        let resources = root.appendingPathComponent("Contents/Resources/models")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try ModelFixture.writeStub(
            to: resources.appendingPathComponent(AppSettings.knownUzbekModels[0]))

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-models-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let dropped = directory.appendingPathComponent(AppSettings.knownUzbekModels[0])
        try ModelFixture.writeStub(to: dropped)

        let bundle = try #require(Bundle(url: root))
        let settings = AppSettings(store: scratchDefaults(), modelDirectory: directory,
                                   modelBundle: bundle)
        #expect(settings.resolvedUzbekPath == dropped.path,
                "a model dropped into the support directory must win over the shipped one")
    }

    @Test("support lives outside any sandbox container")
    func supportDirectory() {
        // The app is deliberately unsandboxed — Accessibility and Input Monitoring do not
        // survive the sandbox — so this must not be a container path.
        let path = AppSettings.supportDirectory.path
        #expect(path.hasSuffix("/Kotiba"))
        #expect(!path.contains("Containers"))
    }
}
