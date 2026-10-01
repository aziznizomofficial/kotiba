import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

// D-11, the user's own history: `TurkishCheck` asks more of a first Turkish dictation
// (`verifiedFromUnfamiliar`) than of one from a user who has dictated Turkish before. The count
// it reads is `AppSettings.turkishDictations`, which only the controller writes — so the counting
// is pinned here, through the controller, and the threshold itself in OptionalLanguagesTests.

private struct ToneAudio: AudioSource {
    func start() async throws {}
    func stop() async throws -> AudioBuffer {
        AudioBuffer(samples: (0..<16_000).map { sinf(Float($0) * 0.05) * 0.4 })
    }
    func warmUp() async {}
}

private struct PinRouter: LanguageRouter {
    func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        RouteDecision(language: pin ?? .english, source: pin == nil ? .fallback : .pin)
    }
}

private struct AnyEngine: TranscriptionEngine {
    var engineID = "stub"
    var supportedLanguages: Set<Language> = [.english, .turkish]
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: "merhaba", language: language, engineID: engineID)
    }
}

private struct TurkishTestSink: TextSink {
    func insert(_ text: String) async throws -> InsertionOutcome { .inserted }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        .inserted
    }
}

@Suite("Turkish history")
@MainActor
struct TurkishHistoryTests {

    @Test("a delivered Turkish dictation is counted; an English one is not")
    func countsTurkishOnly() async {
        let settings = AppSettings.hermetic()
        settings.polishEnabled = false
        // A pin counts only on a language that is on (`AppSettings.enabledLanguages`).
        settings.enabledLanguages = [.english, .turkish]
        settings.pinnedLanguage = .turkish
        let controller = DictationController(settings: settings, devices: .testing)
        controller.sessionOverride = { _ in
            DictationSession(audio: ToneAudio(), router: PinRouter(),
                             engines: [.unified: AnyEngine(), .turkish: AnyEngine()],
                             sink: TurkishTestSink())
        }
        #expect(settings.turkishDictations == 0)
        controller.press()
        controller.release()
        await eventually { !controller.isRunning }
        #expect(settings.turkishDictations == 1)

        settings.pinnedLanguage = .english
        controller.press()
        controller.release()
        await eventually { !controller.isRunning }
        #expect(settings.turkishDictations == 1)
    }
}
