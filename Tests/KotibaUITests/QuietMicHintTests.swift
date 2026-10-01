import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

// The quiet-microphone hint, end to end through the controller with invented devices: a held take
// that barely registered names the microphone on the pill and on Home, once per device per hour,
// and goes away when a dictation comes out as text. No real audio state is read or written — the
// session is given a stub source that returns a labelled buffer.

private struct LabelledAudio: AudioSource {
    var buffer: AudioBuffer
    func start() async throws {}
    func stop() async throws -> AudioBuffer { buffer }
    func warmUp() async {}
}

private struct OneRouter: LanguageRouter {
    func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        RouteDecision(language: pin ?? .english, source: pin == nil ? .fallback : .pin)
    }
}

private struct WordsEngine: TranscriptionEngine {
    var engineID = "stub"
    var supportedLanguages: Set<Language> = [.english, .uzbek, .russian]
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: "salom dunyo", language: language, engineID: engineID)
    }
}

private struct NoPaste: TextSink {
    func insert(_ text: String) async throws -> InsertionOutcome { .inserted }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome { .inserted }
}

private nonisolated let phone = InputDeviceInfo(name: "Test iPhone Microphone", transport: .continuity,
                                    sampleRate: 48_000, overrodeDefault: false)
private nonisolated let deskMic = InputDeviceInfo(name: "Test Desk Mic", transport: .usb, sampleRate: 44_100)

/// `seconds` of a constant `peak`.
private nonisolated func take(seconds: Double, peak: Float, device: InputDeviceInfo?) -> AudioBuffer {
    AudioBuffer(samples: Array(repeating: peak, count: Int(seconds * 16_000)), device: device)
}

@Suite("Quiet-microphone hint")
@MainActor
struct QuietMicHintTests {

    private func controller(_ buffer: @escaping @Sendable () -> AudioBuffer) -> DictationController {
        let settings = AppSettings.hermetic()
        settings.polishEnabled = false
        let controller = DictationController(settings: settings, devices: .testing)
        controller.sessionOverride = { _ in
            DictationSession(audio: LabelledAudio(buffer: buffer()), router: OneRouter(),
                             engines: [.unified: WordsEngine(), .uzbek: WordsEngine()],
                             sink: NoPaste())
        }
        return controller
    }

    private func runOnce(_ controller: DictationController) async {
        controller.press()
        controller.release()
        await eventually { !controller.isRunning }
    }

    @Test("a long, near-silent take says which microphone, on the pill and on Home")
    func raisesTheHint() async {
        let c = controller { take(seconds: 8, peak: 0.008, device: phone) }
        await runOnce(c)

        #expect(c.status == .heardNothing)
        #expect(c.quietMic == phone)
        let state = PillState(status: c.status, record: c.lastRecord, quietMic: c.quietMicForPill)
        #expect(state == .attention(L("pill.quietMic", "Test iPhone")), "\(state)")
        #expect(L("pill.quietMic", "Test iPhone") == "Mic very quiet — using Test iPhone?")

        let notice = c.quietMicNotice
        #expect(notice?.title.contains("Test iPhone Microphone") == true)
        #expect(notice?.detail == L("home.quietMic.detail.continuity"), "Continuity is called out")
        #expect(notice?.settingsURL
                == "x-apple.systempreferences:com.apple.Sound-Settings.extension?input")
    }

    @Test("a short tap, or a take with no known device, keeps the ordinary message")
    func ordinaryHeardNothing() async {
        let tap = controller { take(seconds: 1.0, peak: 0.008, device: phone) }
        await runOnce(tap)
        #expect(tap.status == .heardNothing)
        #expect(tap.quietMic == nil && tap.quietMicForPill == nil)
        #expect(PillState(status: tap.status, record: tap.lastRecord, quietMic: tap.quietMicForPill)
                == .attention(L("pill.heardNothing")))

        let unknown = controller { take(seconds: 8, peak: 0.008, device: nil) }
        await runOnce(unknown)
        #expect(unknown.quietMic == nil)
    }

    @Test("once per device per hour: the second take in the burst gets the plain message")
    func notTwice() async {
        let c = controller { take(seconds: 8, peak: 0.008, device: phone) }
        await runOnce(c)
        #expect(c.quietMicForPill == phone)
        c.dismissQuietMic()

        await runOnce(c)
        #expect(c.status == .heardNothing)
        #expect(c.quietMicForPill == nil, "the pill must not nag")
        #expect(c.quietMic == nil, "…and neither must Home, once it was dismissed")
    }

    @Test("the limiter is per device, and an hour later it speaks again")
    func perDeviceAndExpiry() {
        let c = controller { take(seconds: 8, peak: 0.008, device: phone) }
        func record(_ device: InputDeviceInfo) -> DictationRecord {
            var r = DictationRecord(startedAt: Date())
            r.outcome = "heardNothing"; r.audioSeconds = 9; r.peakAmplitude = 0.01
            r.inputDevice = device
            return r
        }
        let t0 = Date(timeIntervalSince1970: 1_785_000_000)
        #expect(c.noteQuietMic(record(phone), ownsHUD: true, now: t0))
        #expect(!c.noteQuietMic(record(phone), ownsHUD: true, now: t0 + 120))
        #expect(c.noteQuietMic(record(deskMic), ownsHUD: true, now: t0 + 130))
        #expect(c.quietMic == deskMic)
        #expect(QuietMic.kind(of: deskMic) == .external)
        #expect(c.quietMicNotice?.detail == L("home.quietMic.detail.external"))
        #expect(c.noteQuietMic(record(phone), ownsHUD: false, now: t0 + 3700))
        #expect(c.quietMicForPill == nil, "a take that does not own the HUD never writes the pill")
    }

    @Test("a dictation that comes out as text clears the Home notice")
    func clearsOnSuccess() async {
        let c = controller { take(seconds: 2, peak: 0.4, device: phone) }
        var quiet = DictationRecord(startedAt: Date())
        quiet.outcome = "heardNothing"; quiet.audioSeconds = 9; quiet.peakAmplitude = 0.01
        quiet.inputDevice = phone
        #expect(c.noteQuietMic(quiet, ownsHUD: true))
        #expect(c.quietMic != nil)

        await runOnce(c)
        #expect(c.status == .succeeded("salom dunyo"))
        #expect(c.quietMic == nil)
    }
}
