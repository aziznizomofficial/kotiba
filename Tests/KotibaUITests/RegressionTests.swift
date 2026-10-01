import Foundation
import KotibaCore
import KotibaEngines
import Testing

@testable import KotibaUI

// One test per defect found by the 2026-08-07 adversarial review. Each of these fails against
// the code as it was written; that is the whole point of them. A test that passes both before
// and after a fix has not pinned anything.

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

@Suite("Settings persist without help from a view")
struct SettingsPersistenceRegressionTests {

    @Test("a change through the saving binding is on disk immediately")
    func boundBindingSaves() {
        // Thirteen of twenty-one controls used to mutate the object directly and rely on
        // TabView.onDisappear to persist. Quitting with the window open lost all of them.
        let store = scratch()
        let settings = AppSettings.hermetic(store: store)
        settings.bound(\.soundFeedback).wrappedValue = true
        settings.bound(\.polishModel).wrappedValue = "gpt-5"
        settings.bound(\.whisperBeamSize).wrappedValue = 5

        // A fresh object, same store. No save() call in between, no view lifecycle.
        let reread = AppSettings.hermetic(store: store)
        #expect(reread.soundFeedback)
        #expect(reread.polishModel == "gpt-5")
        #expect(reread.whisperBeamSize == 5)
    }

    @Test("the binding reads through to the live value")
    func boundBindingReads() {
        let settings = AppSettings.hermetic(store: scratch())
        settings.polishEnabled = true
        #expect(settings.bound(\.polishEnabled).wrappedValue)
    }

    @Test("every stored setting is in the snapshot, in both directions")
    func snapshotIsComplete() throws {
        // A field present in `init` but missing from `apply` (or the reverse) loses data with
        // no error anywhere. Cross-checked by round-tripping a value that differs from every
        // default: whatever is missing from either side comes back as the default.
        let store = scratch()
        let written = AppSettings.hermetic(store: store)
        written.defaultLanguage = .uzbek
        written.pinnedLanguage = .russian
        written.uzbekModelPath = "/a"
        written.russianModelPath = "/b"
        written.whisperUseGPU = false
        written.whisperBeamSize = 8      // not 5: 5 is the default now, and the probe must differ
        written.preloadAllLanguages = true
        written.silenceThreshold = 0.099
        written.soundFeedback = true
        written.vocabulary = ["uz": ["x"]]
        written.replacements = [Replacement(find: "a", replaceWith: "b")]
        written.autoCapitalise = false
        written.defaultModeKey = "email"
        written.modeFollowsApp = true
        written.polishEnabled = false
        written.polishBaseURL = "https://example.test/v1"
        written.polishModel = "m"
        written.polishKeyAccount = "acct"
        written.polishTimeoutSeconds = 17
        written.keepHistory = false
        written.historyLimit = 42
        written.diagnosticsEnabled = false
        written.save()

        let read = AppSettings.hermetic(store: store)
        let defaults = AppSettings.hermetic(store: scratch())
        var lost: [String] = []
        if read.defaultLanguage == defaults.defaultLanguage { lost.append("defaultLanguage") }
        if read.pinnedLanguage == defaults.pinnedLanguage { lost.append("pinnedLanguage") }
        if read.uzbekModelPath == defaults.uzbekModelPath { lost.append("uzbekModelPath") }
        if read.russianModelPath == defaults.russianModelPath { lost.append("russianModelPath") }
        if read.whisperUseGPU == defaults.whisperUseGPU { lost.append("whisperUseGPU") }
        if read.whisperBeamSize == defaults.whisperBeamSize { lost.append("whisperBeamSize") }
        if read.preloadAllLanguages == defaults.preloadAllLanguages {
            lost.append("preloadAllLanguages")
        }
        if read.silenceThreshold == defaults.silenceThreshold { lost.append("silenceThreshold") }
        if read.soundFeedback == defaults.soundFeedback { lost.append("soundFeedback") }
        if read.vocabulary == defaults.vocabulary { lost.append("vocabulary") }
        if read.replacements == defaults.replacements { lost.append("replacements") }
        if read.autoCapitalise == defaults.autoCapitalise { lost.append("autoCapitalise") }
        if read.defaultModeKey == defaults.defaultModeKey { lost.append("defaultModeKey") }
        if read.modeFollowsApp == defaults.modeFollowsApp { lost.append("modeFollowsApp") }
        if read.polishEnabled == defaults.polishEnabled { lost.append("polishEnabled") }
        if read.polishBaseURL == defaults.polishBaseURL { lost.append("polishBaseURL") }
        if read.polishModel == defaults.polishModel { lost.append("polishModel") }
        if read.polishKeyAccount == defaults.polishKeyAccount { lost.append("polishKeyAccount") }
        if read.polishTimeoutSeconds == defaults.polishTimeoutSeconds {
            lost.append("polishTimeoutSeconds")
        }
        if read.keepHistory == defaults.keepHistory { lost.append("keepHistory") }
        if read.historyLimit == defaults.historyLimit { lost.append("historyLimit") }
        if read.diagnosticsEnabled == defaults.diagnosticsEnabled {
            lost.append("diagnosticsEnabled")
        }
        #expect(lost.isEmpty, "these did not survive the round trip: \(lost)")
    }
}

@Suite("Failures are kept, not erased")
@MainActor
struct FailureVisibilityRegressionTests {

    /// Points at a file that exists and is not a ggml model, so `prepare()` genuinely fails.
    /// Passes `ModelFile.inspect` — right magic, plausible size — and still will not load,
    /// because everything after the header is zeros. A stub of nineteen bytes used to be enough
    /// here; it now fails the cheap check first, which is a different path and a different test.
    private func brokenModel() throws -> String { try ModelFixture.plausible() }

    @Test("a model that will not load becomes a blocker naming the language")
    func loadFailureSurfaces() async throws {
        // `prepareEngines` set .failed and `start()` set .idle on the very next line, so the
        // only real diagnosis could never be observed. The user got "no engine ready", which
        // names the wrong cause.
        let settings = AppSettings.hermetic(store: scratch())
        settings.uzbekModelPath = try brokenModel()
        settings.defaultLanguage = .uzbek
        defer { try? FileManager.default.removeItem(atPath: settings.uzbekModelPath) }

        let controller = DictationController(settings: settings, devices: .testing)
        await controller.start()

        let blocker = controller.blockers.first { $0.id == "load-uz" }
        #expect(blocker != nil, "a broken Uzbek model produced no blocker")
        #expect(blocker?.title.contains("Uzbek") == true)
        #expect(blocker?.detail.isEmpty == false)

        // And the status must not have been flattened back to idle.
        if case .failed = controller.status {} else {
            Issue.record("status was \(controller.status), not .failed")
        }
    }

    @Test("a working setup ends idle, not stuck in a stale failure")
    func healthySetupIsIdle() async {
        let controller = DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
        await controller.start()
        #expect(controller.blockers.first { $0.id.hasPrefix("load-") } == nil)
        if case .failed = controller.status {
            Issue.record("a setup with no models configured reported \(controller.status)")
        }
    }
}

@Suite("The gesture cannot re-drive a finished dictation")
@MainActor
struct GestureRegressionTests {

    // Was "a press while still working is reported, not silently dropped", which asserted the
    // "Still finishing the last one." refusal. The defect it guarded — a bare return leaving
    // `self.session` on the previous dictation, whose key-up re-drove it — cannot come back: the
    // session is consumed at key-up, and a press while the last one works now starts a new one.
    @Test("a press while still working starts the next dictation")
    func pressWhileBusyStartsNext() {
        let controller = DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
        controller.press()          // now .listening
        controller.release()        // now .working
        guard case .working = controller.status else {
            Issue.record("expected .working after release, got \(controller.status)")
            return
        }
        controller.press()
        #expect(controller.status == .listening, "got \(controller.status)")
        controller.cancel()
    }

    @Test("a release with nothing armed does nothing at all")
    func releaseWithoutPress() {
        // The session is consumed at key-up now, so a second key-up has nothing to re-drive.
        let controller = DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
        controller.release()
        #expect(controller.status == .idle)
        controller.release()
        #expect(controller.status == .idle)
    }
}

@Suite("Settings changes do not needlessly reload 539 MB")
@MainActor
struct ModelReloadRegressionTests {

    @Test("an unconfigured model reads as unchanged, not as moved")
    func unsetPathsCompareEqual() {
        // The defect: comparing `String?` (nil, from build() refusing an empty path) against
        // `String` ("") made `nil != ""` true, so this returned true forever for anyone who had
        // not configured *both* models — the default state, and the permanent state of the
        // Uzbek-only user this app is built for. Every settings close then tore down a 539 MB
        // context and reloaded it.
        let settings = AppSettings.hermetic(store: scratch())
        #expect(!DictationController.modelsChanged(loadedUzbek: nil, loadedRussian: nil,
                                                   settings: settings))
    }

    @Test("a path that does not exist reads as unchanged too")
    func absentFileComparesEqual() {
        // build() also returns nil for a path that is set but missing, so the same asymmetry
        // applies to a model the user deleted from disk.
        let settings = AppSettings.hermetic(store: scratch())
        settings.uzbekModelPath = "/definitely/not/here.bin"
        #expect(!DictationController.modelsChanged(loadedUzbek: nil, loadedRussian: nil,
                                                   settings: settings))
    }

    @Test("a real change is still detected")
    func genuineChangeDetected() throws {
        let url = URL(fileURLWithPath: try ModelFixture.plausible())
        defer { try? FileManager.default.removeItem(at: url) }

        let settings = AppSettings.hermetic(store: scratch())
        settings.uzbekModelPath = url.path

        // Newly configured, nothing loaded yet.
        #expect(DictationController.modelsChanged(loadedUzbek: nil, loadedRussian: nil,
                                                  settings: settings))
        // Already loaded from that exact file.
        #expect(!DictationController.modelsChanged(loadedUzbek: url.path, loadedRussian: nil,
                                                   settings: settings))
        // Loaded from somewhere else.
        #expect(DictationController.modelsChanged(loadedUzbek: "/old/model.bin",
                                                  loadedRussian: nil, settings: settings))
        // Removed from settings while still loaded.
        settings.uzbekModelPath = ""
        #expect(DictationController.modelsChanged(loadedUzbek: url.path, loadedRussian: nil,
                                                  settings: settings))
    }

    @Test("closing settings with nothing configured changes nothing")
    func settingsCloseIsQuiet() async {
        let controller = DictationController(settings: AppSettings.hermetic(store: scratch()), devices: .testing)
        await controller.start()
        let before = controller.status
        await controller.settingsChanged()
        #expect(controller.status == before)
        #expect(controller.blockers.first { $0.id.hasPrefix("load-") } == nil)
    }
}

@Suite("Loaded models are handed back when nobody is dictating")
@MainActor
struct IdleUnloadRegressionTests {

    // The defect: `WhisperEngine.unload()` was written, documented as being worth 539 MB, and
    // called from nowhere in the app. Lazy loading therefore only deferred the cost — the first
    // dictation in a language loaded a model that then stayed for the process lifetime. On a
    // menu-bar app that is never quit, `footprint` measured 1618 MB, 1395 MB of it whisper
    // contexts, against 110 MB at launch.

    @Test("a fresh install releases after five idle minutes")
    func defaultReleasesAfterFiveMinutes() {
        let settings = AppSettings(store: scratch())
        #expect(DictationController.idleUnloadDelay(settings: settings) == .seconds(300))
    }

    @Test("zero minutes means never, for someone who wants the latency instead")
    func zeroDisables() {
        let settings = AppSettings(store: scratch())
        settings.modelIdleUnloadMinutes = 0
        #expect(DictationController.idleUnloadDelay(settings: settings) == nil)
    }

    @Test("loading every language up front does not mean keeping it forever")
    func preloadStillReleases() {
        // The first cut of this fix let `preloadAllLanguages` suppress the timer, on the theory
        // that it was an explicit request to hold the memory. That reading made the fix useless
        // on the one configuration that actually reported the bug: the machine measured at
        // 1618 MB had preload switched on, which is *why* both models were resident at once.
        //
        // The settings answer different questions. Preload is about when a model loads; this is
        // about how long an unused one is kept. "Never" is how you ask for the old behaviour.
        let settings = AppSettings(store: scratch())
        settings.preloadAllLanguages = true
        #expect(DictationController.idleUnloadDelay(settings: settings) == .seconds(300))

        settings.modelIdleUnloadMinutes = 15
        #expect(DictationController.idleUnloadDelay(settings: settings) == .seconds(900))

        settings.modelIdleUnloadMinutes = 0
        #expect(DictationController.idleUnloadDelay(settings: settings) == nil)
    }

    @Test("a custom timeout is honoured exactly")
    func customTimeout() {
        let settings = AppSettings(store: scratch())
        settings.modelIdleUnloadMinutes = 15
        #expect(DictationController.idleUnloadDelay(settings: settings) == .seconds(900))
        settings.modelIdleUnloadMinutes = 0.5
        #expect(DictationController.idleUnloadDelay(settings: settings) == .seconds(30))
    }

    @Test("the countdown is polled, not slept through")
    func pollIntervalIsSane() {
        // The first version slept once for the whole timeout. In an LSUIElement app App Nap
        // defers that indefinitely: measured here, a 60 s countdown fired on time and a 300 s
        // one had not fired eight minutes later. Polling against wall-clock survives the
        // deferral — a late fire still sees the true elapsed time.
        #expect(DictationController.pollInterval(for: .seconds(300)) == 30)
        #expect(DictationController.pollInterval(for: .seconds(60)) == 15)
        // Never so coarse that a short timeout is slept straight through.
        #expect(DictationController.pollInterval(for: .seconds(3)) == 1)
        #expect(DictationController.pollInterval(for: .seconds(3600)) == 30)
    }

    @Test("releasing is safe with nothing loaded, and says so")
    func releaseWithNothingLoaded() async {
        let controller = DictationController(settings: AppSettings.hermetic(store: scratch()),
                                             devices: .testing)
        await controller.start()
        await controller.releaseModels()
        #expect(!controller.modelsResident)
    }

    @Test("the whole wiring releases a real model, not just the rule in isolation",
          .enabled(if: ProcessInfo.processInfo.environment["KOTIBA_UZ_MODEL"] != nil))
    func endToEndRelease() async throws {
        // Everything above tests the rule. This tests the wiring — that something actually
        // arms the countdown at load, that it survives to fire, and that firing reaches
        // `unload()`. Installed on a real Mac the first version of this change did not release
        // at all, and every unit test still passed.
        let path = ProcessInfo.processInfo.environment["KOTIBA_UZ_MODEL"]!
        let settings = AppSettings(store: scratch())
        settings.uzbekModelPath = path
        settings.defaultLanguage = .uzbek
        settings.preloadAllLanguages = true
        settings.modelIdleUnloadMinutes = 0.05      // 3 seconds

        let controller = DictationController(settings: settings, devices: .testing)
        await controller.start()
        #expect(controller.modelsResident, "nothing loaded, so the release proves nothing")

        try await Task.sleep(for: .seconds(6))
        #expect(!controller.modelsResident, "the countdown never reached unload()")

        // Releasing is only half of it. A user whose models were handed back while they made
        // coffee must find dictation working when they come back, without knowing that a
        // release happened or that anything needs pressing to undo it.
        await controller.recheck()
        #expect(controller.modelsResident, "released and never came back")
    }

    @Test("the timeout survives a settings round trip")
    func persists() {
        let store = scratch()
        let settings = AppSettings(store: store)
        settings.modelIdleUnloadMinutes = 15
        settings.save()

        let reloaded = AppSettings(store: store)
        #expect(reloaded.modelIdleUnloadMinutes == 15)
    }

    @Test("a blob written before this setting existed keeps the new default")
    func oldBlobGetsTheDefault() {
        // Every Snapshot field is optional precisely so an older settings blob still loads.
        // An existing user must inherit the five-minute release, not a decoded zero that would
        // silently reproduce the bug this fixes.
        let store = scratch()
        let old = AppSettings(store: store)
        old.modelIdleUnloadMinutes = 42     // present in the blob, then removed below
        old.save()

        let data = store.data(forKey: AppSettings.storageKey)!
        var blob = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        blob.removeValue(forKey: "modelIdleUnloadMinutes")
        store.set(try! JSONSerialization.data(withJSONObject: blob),
                  forKey: AppSettings.storageKey)

        #expect(AppSettings(store: store).modelIdleUnloadMinutes == 5)
    }
}
