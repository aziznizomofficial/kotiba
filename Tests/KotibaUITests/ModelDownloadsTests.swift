import Foundation
import KotibaModels
import Testing

@testable import KotibaUI

// The first-run "Download models" list reads what is actually on disk — and says so honestly
// for the one model that cannot be fetched from here yet.

@Suite("The recommended models, as the onboarding and Settings show them")
@MainActor
struct ModelDownloadsTests {

    @Test("an empty models directory: everything missing, Uzbek not downloadable while private")
    func emptyDirectory() async {
        let controller = DictationController(settings: AppSettings.hermetic(), devices: .testing)
        await controller.models.refresh()
        #expect(controller.models.state(.parakeet) == .missing)
        #expect(controller.models.state(.speechDetector) == .missing)
        #expect(controller.models.state(.languageDetector) == .missing)
        #expect(controller.models.state(.modes) == .missing)
        if ModelCatalogue.uzbekEngineIsPublic {
            #expect(controller.models.state(.uzbek) == .missing)
        } else {
            #expect(controller.models.state(.uzbek)
                    == .unavailable(ModelCatalogue.uzbekEngineIsNotDownloadable))
        }
        // The core on an empty directory: ~2.5 GB — less the Uzbek model while it cannot be
        // fetched from here, which is never counted as something to download. Turkish and
        // Arabic (D-11) are never part of it.
        let checked = Set(ModelDownloads.Item.core)
        #expect(!checked.contains(.turkish) && !checked.contains(.arabic))
        #expect(!checked.contains(.arabicModes))
        #expect(controller.models.state(.turkish) == .missing)
        #expect(controller.models.state(.arabic) == .missing)
        // Arabic brings turbo with Cohere (C4 §14.1): the head and the loop fallback.
        #expect(ModelDownloads.Item.arabic.bytes
                == Int64(ModelCatalogue.arabicEngine.expectedBytes ?? 0)
                + Int64(ModelCatalogue.russianEngine.expectedBytes ?? 0))
        let total = controller.models.pendingBytes(checked)
        let uzbek = ModelDownloads.Item.uzbek.bytes
        let expected: ClosedRange<Int64> = ModelCatalogue.uzbekEngineIsPublic
            ? 2_400_000_000...2_700_000_000
            : (2_400_000_000 - uzbek)...(2_700_000_000 - uzbek)
        #expect(expected.contains(total), "\(total)")
    }

    @Test("a model placed in the directory reads as installed without downloading anything")
    func installedIsSeen() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("kotiba-models-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        FileManager.default.createFile(
            atPath: directory.appendingPathComponent(ModelCatalogue.polishModel.destination).path,
            contents: Data("gguf".utf8))
        FileManager.default.createFile(
            atPath: directory.appendingPathComponent(ModelCatalogue.speechDetector.destination)
                .path, contents: Data("silero".utf8))
        let settings = AppSettings(store: UserDefaults(suiteName: UUID().uuidString)!,
                                   modelDirectory: directory, modelBundle: nil)
        settings.autoDownloadModels = false
        let controller = DictationController(settings: settings, devices: .testing)
        await controller.models.refresh()
        #expect(controller.models.state(.modes) == .installed)
        #expect(controller.models.state(.speechDetector) == .installed)
        #expect(controller.models.state(.parakeet) == .missing)
        #expect(controller.models.diskBytes > 0)
    }

    @Test("engines never start a download before onboarding has asked")
    func noDownloadBeforeConsent() {
        let settings = AppSettings.hermetic()
        settings.autoDownloadModels = true
        settings.hasCompletedOnboarding = false
        #expect(!DictationController.mayDownload(settings))
        settings.hasCompletedOnboarding = true
        #expect(DictationController.mayDownload(settings))
        settings.autoDownloadModels = false
        #expect(!DictationController.mayDownload(settings))
    }

    @Test("a failed download keeps its reason through a refresh, until the file turns up")
    func failureSurvivesRefresh() async {
        let controller = DictationController(settings: AppSettings.hermetic(), devices: .testing)
        await controller.models.refresh()
        // What `fetch` records when `ModelStore` throws — a network error, a bad checksum. No
        // hermetic run can produce one for real, so the state is set as `fetch` would set it.
        controller.models.states[.modes] = .failed("checksum mismatch")
        await controller.models.refresh()
        #expect(controller.models.state(.modes) == .failed("checksum mismatch"))
    }

    @Test("the progress of a run never counts a model that cannot be fetched from here")
    func progressIgnoresUnavailable() async {
        let controller = DictationController(settings: AppSettings.hermetic(), devices: .testing)
        let models = controller.models!
        await models.refresh()
        let everything = Set(ModelDownloads.Item.allCases)
        // The onboarding's run, part-way: all but Uzbek installed.
        for item in ModelDownloads.Item.allCases where item != .uzbek {
            models.states[item] = .installed
        }
        models.states[.uzbek] = .unavailable("private")
        #expect(models.fraction(of: everything) == 1)
    }

    @Test("a card with no selection of its own shows the run's progress, not a full bar")
    func settingsCardFollowsTheRun() async {
        let controller = DictationController(settings: AppSettings.hermetic(), devices: .testing)
        let models = controller.models!
        await models.refresh()
        #expect(models.runFraction == 1)   // nothing running: nothing to show
        models.states[.speechDetector] = .downloading(0)
        models.states[.modes] = .downloading(0)
        // What `download([.modes])` records before its first byte, without starting a fetch.
        models.runItems = [.modes]
        #expect(models.runFraction == 0)
        #expect(models.fraction(of: []) == 1)
    }

    @Test("finishing or skipping setup starts the core: it is not a choice any more")
    func setupStartsTheCore() {
        let skipped = AppSettings.hermetic()   // hermetic: the flag starts false
        #expect(!DictationController.mayDownload(skipped))
        OnboardingView.settle(skipped, alwaysOn: true)
        #expect(skipped.hasCompletedOnboarding)
        #expect(skipped.autoDownloadModels)
        #expect(DictationController.mayDownload(skipped))
    }

    @Test("the core card's figure is its bar's total, and it is done when the core is")
    func coreCardTotals() async {
        let controller = DictationController(settings: AppSettings.hermetic(), devices: .testing)
        let models = controller.models!
        await models.refresh()
        let core = Set(ModelDownloads.Item.core)
        // A DMG install: Uzbek, both detectors inside the app; Parakeet and Qwen to come.
        for item in [ModelDownloads.Item.uzbek, .speechDetector, .languageDetector] {
            models.states[item] = .installed
        }
        let expected = ModelDownloads.Item.parakeet.bytes + ModelDownloads.Item.modes.bytes
        #expect(models.total(of: core) == expected)
        #expect((1_850_000_000...1_950_000_000).contains(expected), "\(expected)")
        #expect(!models.allInstalled(core))
        // Part-way through a run, the finished row still counts: the figure does not shrink.
        models.runItems = [.parakeet, .modes]
        models.states[.parakeet] = .installed
        models.states[.modes] = .downloading(0)
        #expect(models.total(of: core) == expected)
        #expect(models.fraction(of: core) > 0.3 && models.fraction(of: core) < 0.4)
        models.states[.modes] = .failed("offline")
        #expect(models.failure(in: core) == "offline")
        models.states[.modes] = .installed
        #expect(models.allInstalled(core))
    }

    @Test("Arabic's size counts turbo only when Turkish has not brought it")
    func arabicSize() async {
        let controller = DictationController(settings: AppSettings.hermetic(), devices: .testing)
        let models = controller.models!
        await models.refresh()
        let turbo = Int64(ModelCatalogue.russianEngine.expectedBytes ?? 0)
        let full = models.pendingBytes(for: .arabic)
        #expect(full == ModelDownloads.Item.arabic.bytes + ModelDownloads.Item.arabicModes.bytes)
        models.states[.turkish] = .installed
        #expect(models.pendingBytes(for: .arabic) == full - turbo)
        #expect(models.pendingBytes(for: .turkish) == 0)
    }
}
