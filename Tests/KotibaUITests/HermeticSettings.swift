import Foundation
import KotibaAudio
import KotibaCore

@testable import KotibaUI

// Auto-discovery made these tests machine-dependent, and that is worth a file of its own.
//
// `AppSettings` looks for models by known filename in `~/Library/Application Support/Kotiba/models`
// and then inside the app bundle, so that someone handed a .dmg gets a working app without opening
// Settings. The cost is that a test holding a scratch `UserDefaults` would still find whatever
// models happen to be installed on the machine running it — so "an unconfigured Uzbek is not ready"
// passed on CI and failed on the developer's laptop, which is the worst possible way round.
//
// Every test that does not specifically care about discovery builds its settings through this, and
// gets an empty model directory and no bundle search. Tests that DO care pass a real path in
// `uzbekModelPath`, which wins over both search steps anyway.

extension AppSettings {
    static func hermetic(
        store: UserDefaults = UserDefaults(suiteName: UUID().uuidString)!
    ) -> AppSettings {
        let settings = AppSettings(
            store: store,
            modelDirectory: URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("kotiba-no-models-\(UUID().uuidString)"),
            modelBundle: nil,
            // Nor the real history and diagnostics: a test that reaches `start()` opens both.
            stateDirectory: URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("kotiba-state-\(UUID().uuidString)"))
        // Never a download from a test, whatever the test does to onboarding.
        settings.autoDownloadModels = false
        return settings
    }
}

// And no hardware. `DictationController` takes its microphone and its paste target as
// `Devices`; before it did, every controller a test built made a real `AVAudioEngine`, and any
// test that reached `start()`, `recheck()` or `press()` opened the owner's microphone. The real
// ones are exercised only by the opt-in hardware band (`KOTIBA_HARDWARE_TESTS=1`).
extension DictationController.Devices {
    /// A microphone that records silence and a sink that pastes nowhere.
    static var testing: Self {
        Self(microphone: ReplayMicrophone(speed: 4), sink: { NowhereSink() })
    }
}

/// Accepts every paste and keeps nothing.
struct NowhereSink: TextSink {
    func insert(_ text: String) async throws -> InsertionOutcome { .inserted }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        .inserted
    }
}

/// Waits until `condition` holds, polling, for as long as `timeout`.
///
/// For assertions about *what* happens, not how fast. The UI suites share the main actor with
/// every other suite, and at a load average of 10+ a fixed "1000 × 10 ms" wait went red on a
/// dictation that simply had not been scheduled yet. The bound is generous on purpose: a latch —
/// the defect these tests exist for — never clears at any bound, so a long one costs only a
/// slow failure and buys back a test that does not lie when the machine is busy.
@MainActor
func eventually(_ timeout: Duration = .seconds(60),
                _ condition: @MainActor () async -> Bool) async {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if await condition() { return }
        try? await Task.sleep(for: .milliseconds(5))
    }
}
