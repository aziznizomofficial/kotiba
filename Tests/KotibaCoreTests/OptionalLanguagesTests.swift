import Foundation
import Testing

@testable import KotibaCore

// Band 1 for Turkish and Arabic (D-11): the routing rule, the session steps that act on it, and
// the text rules. The thresholds themselves are measured, not tested — `kotiba-probe route-eval
// --optional tr,ar` reproduces them (C4 §11); these pin what the code does with them.

private struct Fixed: AcousticClassifier {
    let value: [String: Double]
    func posterior(for audio: AudioBuffer) async -> [String: Double] { value }
}

private actor CountingVerifier: AcousticClassifier {
    let value: [String: Double]
    private(set) var calls = 0
    init(_ value: [String: Double]) { self.value = value }
    func posterior(for audio: AudioBuffer) async -> [String: Double] {
        calls += 1
        return value
    }
}

private struct Audio: AudioSource {
    var seconds: Double
    func start() async throws {}
    func stop() async throws -> AudioBuffer {
        AudioBuffer(samples: [Float](repeating: 0.1, count: Int(seconds * 16_000)))
    }
    func warmUp() async {}
}

private struct Engine: TranscriptionEngine {
    var engineID: String
    var supportedLanguages: Set<Language>
    var output: String
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: output, language: language, engineID: engineID)
    }
}

private struct Sink: TextSink {
    func insert(_ text: String) async throws -> InsertionOutcome { .inserted }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        .inserted
    }
}

private let everyEngine: [EngineFamily: any TranscriptionEngine] = [
    .unified: Engine(engineID: "parakeet", supportedLanguages: [.english, .russian],
                     output: "hello there, how are you doing today"),
    .uzbek: Engine(engineID: "uz", supportedLanguages: [.uzbek], output: "salom qalaysiz"),
    .turkish: Engine(engineID: "turbo", supportedLanguages: [.turkish],
                     output: "merhaba nasılsın bugün"),
    .arabic: Engine(engineID: "cohere", supportedLanguages: [.arabic], output: "مرحبا كيف حالك"),
]

private func session(posterior: [String: Double], seconds: Double = 6,
                     enabled: Set<Language> = [.turkish, .arabic],
                     engines: [EngineFamily: any TranscriptionEngine] = everyEngine,
                     verifier: (any AcousticClassifier)? = nil,
                     familiar: Bool = false) -> DictationSession {
    var config = DictationSession.Config()
    config.turkishFamiliar = familiar
    config.arabicFamiliar = familiar
    return DictationSession(
        audio: Audio(seconds: seconds),
        router: TieredRouter(classifier: Fixed(value: posterior),
                             optional: OptionalLanguageRules(enabled: enabled)),
        engines: engines, sink: Sink(), config: config, languageHead: verifier)
}

@Suite("Optional languages — the routing rule")
struct OptionalRoutingTests {

    let cluster = ClusterMass()

    @Test("off, every decision is the old one, with nothing extra recorded")
    func offIsUnchanged() {
        for posterior: [String: Double] in [["tr": 0.995], ["ar": 0.999], ["en": 0.9, "tr": 0.1],
                                            ["ru": 0.9], ["tr": 0.63, "az": 0.17, "en": 0.2]] {
            let d = TieredRouter.decide(posterior, seconds: 12, clusterMass: cluster,
                                        optional: OptionalLanguageRules())
            #expect(d.language == (cluster.isUzbek(posterior) ? .uzbek
                                   : (posterior["ru"] ?? 0) > (posterior["en"] ?? 0)
                                        ? .russian : .english))
            #expect(d.candidate == nil && d.turkishShare == nil && d.arabicShare == nil)
        }
    }

    @Test("Arabic from a 0.975 share, before the Turkic cluster; not at 0.974")
    func arabic() {
        let on = OptionalLanguageRules(enabled: [.arabic])
        #expect(TieredRouter.decide(["ar": 39, "fa": 1], seconds: 2, clusterMass: cluster,
                                    optional: on).language == .arabic)
        #expect(TieredRouter.decide(["ar": 974, "tr": 26], seconds: 2, clusterMass: cluster,
                                    optional: on).language != .arabic)
        #expect(TieredRouter.decide(["ar": 0.98, "tr": 0.02], seconds: 2, clusterMass: cluster,
                                    optional: on).family == .arabic)
    }

    @Test("a Turkish candidate needs Turkish on, a 0.9 share and 5 s, and is still routed Uzbek")
    func turkishCandidate() {
        let on = OptionalLanguageRules(enabled: [.turkish])
        let long = TieredRouter.decide(["tr": 0.995], seconds: 5, clusterMass: cluster, optional: on)
        #expect(long.language == .uzbek && long.candidate == .turkish)
        #expect(TieredRouter.decide(["tr": 0.995], seconds: 4.99, clusterMass: cluster,
                                    optional: on).candidate == nil)
        #expect(TieredRouter.decide(["tr": 89, "az": 11], seconds: 9, clusterMass: cluster,
                                    optional: on).candidate == nil)
        #expect(TieredRouter.decide(["tr": 0.995], seconds: 9, clusterMass: cluster,
                                    optional: OptionalLanguageRules(enabled: [.arabic]))
            .candidate == nil)
    }

    @Test("an Arabic candidate: Arabic on, an ar share of 0.05–0.975 and 3.5 s, on any base route")
    func arabicCandidate() {
        let on = OptionalLanguageRules(enabled: [.arabic])
        // Half-heard Arabic over English: still routed to the unified engine, with a candidate.
        let unified = TieredRouter.decide(["ar": 0.4, "fr": 0.35, "en": 0.25], seconds: 4,
                                          clusterMass: cluster, optional: on)
        #expect(unified.family == .unified && unified.candidate == .arabic)
        // Over the Turkic cluster: Uzbek, with a candidate.
        let turkic = TieredRouter.decide(["ar": 0.3, "tr": 0.5, "en": 0.2], seconds: 4,
                                         clusterMass: cluster, optional: on)
        #expect(turkic.language == .uzbek && turkic.candidate == .arabic)
        // Under 3.5 s, under 0.05, or Arabic off: no candidate.
        #expect(TieredRouter.decide(["ar": 0.4, "en": 0.6], seconds: 3.49, clusterMass: cluster,
                                    optional: on).candidate == nil)
        #expect(TieredRouter.decide(["ar": 0.049, "en": 0.951], seconds: 9, clusterMass: cluster,
                                    optional: on).candidate == nil)
        #expect(TieredRouter.decide(["ar": 0.4, "en": 0.6], seconds: 9, clusterMass: cluster,
                                    optional: OptionalLanguageRules(enabled: [.turkish]))
            .candidate == nil)
        // A Turkish candidate asks first (it leaves at most 0.1 for `ar`).
        let both = OptionalLanguageRules(enabled: [.turkish, .arabic])
        #expect(TieredRouter.decide(["tr": 0.92, "ar": 0.08], seconds: 9, clusterMass: cluster,
                                    optional: both).candidate == .turkish)
    }

    @Test("ArabicCheck is 0.98 of turbo's posterior, 0.95 once the user has dictated Arabic")
    func arabicCheck() {
        #expect(ArabicCheck.isArabic(["ar": 98, "en": 2], familiar: false))
        #expect(!ArabicCheck.isArabic(["ar": 97, "en": 3], familiar: false))
        #expect(ArabicCheck.isArabic(["ar": 95, "en": 5], familiar: true))
        #expect(!ArabicCheck.isArabic(["ar": 94, "en": 6], familiar: true))
        #expect(!ArabicCheck.isArabic([:], familiar: true))
        #expect(LanguageCheck.verifies(.arabic, ["ar": 1], familiar: false))
        #expect(!LanguageCheck.verifies(.uzbek, ["uz": 1], familiar: true))
        #expect(LanguageCheck.source(for: .arabic) == .arabicCheck)
    }

    @Test("the enabled set holds only optional languages")
    func onlyOptional() {
        #expect(OptionalLanguageRules(enabled: [.uzbek, .english, .turkish]).enabled == [.turkish])
    }

    @Test("TurkishCheck is a 0.99 share of turbo's posterior")
    func turkishCheck() {
        #expect(TurkishCheck.isTurkish(["tr": 99, "az": 1], familiar: true))
        #expect(!TurkishCheck.isTurkish(["tr": 98, "az": 2], familiar: true))
        #expect(!TurkishCheck.isTurkish([:], familiar: true))
        // Until the user has dictated Turkish once, 0.995.
        #expect(!TurkishCheck.isTurkish(["tr": 99, "az": 1], familiar: false))
        #expect(TurkishCheck.isTurkish(["tr": 199, "az": 1], familiar: false))
    }
}

@Suite("Optional languages — the session")
struct OptionalSessionTests {

    @Test("a Turkish candidate turbo calls Turkish goes to the Turkish engine")
    func verifiedTurkish() async {
        let verifier = CountingVerifier(["tr": 0.999])
        let s = session(posterior: ["tr": 0.995], verifier: verifier)
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .turkish)
        #expect(record.route?.source == .turkishCheck)
        #expect(record.route?.turkishVerified ?? 0 > 0.99)
        #expect(record.engineID == "turbo")
        #expect(await verifier.calls == 1)
    }

    @Test("a Turkish candidate turbo does not call Turkish stays Uzbek, and says what it heard")
    func unverifiedStaysUzbek() async {
        let s = session(posterior: ["tr": 0.995], verifier: CountingVerifier(["tr": 0.7, "uz": 0.3]))
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .uzbek)
        #expect(record.route?.turkishVerified == 0.7)
        #expect(record.engineID == "uz")
    }

    @Test("a first Turkish dictation needs 0.995; once the user has dictated Turkish, 0.99")
    func historyRaisesTheBar() async {
        let first = session(posterior: ["tr": 0.995], verifier: CountingVerifier(["tr": 0.993, "az": 0.007]))
        await first.arm()
        #expect(await first.finish().route?.language == .uzbek)
        let later = session(posterior: ["tr": 0.995], verifier: CountingVerifier(["tr": 0.993, "az": 0.007]),
                            familiar: true)
        await later.arm()
        #expect(await later.finish().route?.language == .turkish)
    }

    @Test("no answer from the check is Uzbek, never Turkish")
    func noAnswerIsUzbek() async {
        let s = session(posterior: ["tr": 0.995], verifier: CountingVerifier([:]))
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .uzbek)
        #expect(record.errors.contains { $0.contains("Turkish check could not answer") })
    }

    @Test("a short Turkish-sounding dictation never asks the check")
    func shortNeverAsks() async {
        let verifier = CountingVerifier(["tr": 1])
        let s = session(posterior: ["tr": 0.995], seconds: 3, verifier: verifier)
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .uzbek)
        #expect(await verifier.calls == 0)
    }

    @Test("a Turkish pin goes straight to the Turkish engine, unasked")
    func pinnedTurkish() async {
        let verifier = CountingVerifier(["tr": 0.0])
        let s = session(posterior: ["en": 1], verifier: verifier)
        await s.arm()
        let record = await s.finish(pin: .turkish)
        #expect(record.route?.language == .turkish && record.route?.source == .pin)
        #expect(await verifier.calls == 0)
    }

    @Test("an Arabic candidate turbo calls Arabic goes to the Arabic engine, from any route")
    func arabicCandidateVerified() async {
        for posterior: [String: Double] in [["ar": 0.4, "fr": 0.35, "en": 0.25],
                                            ["ar": 0.3, "tr": 0.5, "en": 0.2]] {
            let verifier = CountingVerifier(["ar": 0.99, "en": 0.01])
            let s = session(posterior: posterior, verifier: verifier)
            await s.arm()
            let record = await s.finish()
            #expect(record.route?.language == .arabic && record.route?.source == .arabicCheck)
            #expect(record.route?.arabicVerified.map { abs($0 - 0.99) < 1e-9 } == true)
            #expect(record.engineID == "cohere")
            #expect(await verifier.calls == 1)
        }
    }

    @Test("…and one turbo does not call Arabic keeps its base route; no head, no Arabic")
    func arabicCandidateRefused() async {
        let unsure = session(posterior: ["ar": 0.3, "tr": 0.5, "en": 0.2],
                             verifier: CountingVerifier(["ar": 0.97, "uz": 0.03]))
        await unsure.arm()
        let refused = await unsure.finish()
        #expect(refused.route?.language == .uzbek && refused.route?.candidate == nil)
        // The user who has dictated Arabic before: 0.97 is enough.
        let familiar = session(posterior: ["ar": 0.3, "tr": 0.5, "en": 0.2],
                               verifier: CountingVerifier(["ar": 0.97, "uz": 0.03]),
                               familiar: true)
        await familiar.arm()
        #expect(await familiar.finish().route?.language == .arabic)
        let headless = session(posterior: ["ar": 0.3, "tr": 0.5, "en": 0.2])
        await headless.arm()
        let record = await headless.finish()
        #expect(record.route?.language == .uzbek)
        #expect(record.errors.contains { $0.contains("Arabic check could not answer") })
    }

    @Test("an Arabic candidate under a pin is never asked")
    func arabicCandidatePinned() async {
        let verifier = CountingVerifier(["ar": 1])
        let s = session(posterior: ["ar": 0.4, "en": 0.6], verifier: verifier)
        await s.arm()
        #expect(await s.finish(pin: .english).route?.language == .english)
        #expect(await verifier.calls == 0)
    }

    @Test("Arabic by ear goes to the Arabic engine")
    func arabicAcoustic() async {
        let s = session(posterior: ["ar": 0.999])
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .arabic)
        #expect(record.engineID == "cohere")
    }

    @Test("Arabic script out of another route is transcribed again on the Arabic engine")
    func arabicScriptRecovers() async {
        var engines = everyEngine
        engines[.unified] = Engine(engineID: "turbo-ru", supportedLanguages: [.english, .russian],
                                   output: "مرحبا كيف حالك اليوم")
        let s = session(posterior: ["en": 0.9, "ru": 0.1], engines: engines)
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .arabic && record.route?.source == .scriptCheck)
        #expect(record.engineID == "cohere")
    }

    @Test("…but never over a pin, and not when Arabic is off")
    func arabicScriptRespectsPinAndSwitch() async {
        var engines = everyEngine
        engines[.unified] = Engine(engineID: "turbo-ru", supportedLanguages: [.english, .russian],
                                   output: "مرحبا كيف حالك اليوم")
        let pinned = session(posterior: ["en": 1], engines: engines)
        await pinned.arm()
        #expect(await pinned.finish(pin: .english).route?.language == .english)
        engines[.arabic] = nil
        let off = session(posterior: ["en": 1], enabled: [], engines: engines)
        await off.arm()
        #expect(await off.finish().route?.language != .arabic)
    }

    @Test("Latin out of the Arabic route goes to English")
    func latinOutOfArabic() async {
        var engines = everyEngine
        engines[.arabic] = Engine(engineID: "cohere", supportedLanguages: [.arabic],
                                  output: "send the report to the team today")
        let s = session(posterior: ["ar": 0.999], engines: engines)
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .english && record.route?.source == .lexicalCheck)
        #expect(record.engineID == "parakeet")
    }
}

@Suite("Optional languages — text")
struct OptionalTextTests {

    @Test("Turkish capitalises i as İ; Arabic is left exactly as it is")
    func capitaliser() {
        let c = Capitaliser()
        #expect(c.restore("istanbul büyük. ırmak da.", language: .turkish)
                == "İstanbul büyük. Irmak da.")
        #expect(c.restore("istanbul büyük.") == "Istanbul büyük.")
        #expect(c.restore("iPhone جديد. هل رأيته؟", language: .arabic) == "iPhone جديد. هل رأيته؟")
    }

    @Test("Arabic: ؟ closes a question, ، ؛ ؟ are spaced like , ; ?")
    func arabicCleanup() {
        let c = DictationCleanup(language: .arabic)
        #expect(c.apply("هل وصلت إلى البيت") == "هل وصلت إلى البيت؟")
        #expect(c.apply("سأصل غدا في الصباح") == "سأصل غدا في الصباح.")
        #expect(c.apply("مرحبا ، كيف الحال ؟ بخير") == "مرحبا، كيف الحال؟ بخير.")
        #expect(c.apply("امم أريد أن أذهب") == "أريد أن أذهب.")
    }

    @Test("Turkish: the question particle anywhere, grammar doubles kept, İ compared as İ")
    func turkishCleanup() {
        let c = DictationCleanup(language: .turkish)
        #expect(c.apply("yarın geliyor musun") == "yarın geliyor musun?")
        #expect(c.apply("hazır mısınız arkadaşlar") == "hazır mısınız arkadaşlar?")
        #expect(c.apply("yavaş yavaş gidiyoruz") == "yavaş yavaş gidiyoruz.")
        #expect(c.apply("ben ben eve geldim") == "ben eve geldim.")
        #expect(c.apply("bir şey söyleyeceğim") == "bir şey söyleyeceğim.")
    }

    @Test("a rewrite may not take mostly-Arabic text out of Arabic, even around a Latin name")
    func arabicGuard() {
        let guardian = PolishGuard()
        let original = "أرسل الملف إلى أحمد على Google Drive اليوم"
        #expect(guardian.check("Send the file to Ahmed on Google Drive today", against: original)
                != nil)
        #expect(guardian.check("أرسل الملف إلى أحمد على Google Drive اليوم.", against: original)
                == nil)
    }

    @Test("Arabic script agrees with an Arabic route and nothing else")
    func arabicScript() {
        let text = "مرحبا كيف حالك"
        #expect(ScriptCheck.script(of: text) == .arabic)
        #expect(ScriptCheck.agrees(text, with: .arabic))
        for language in [Language.english, .russian, .uzbek, .turkish] {
            #expect(!ScriptCheck.agrees(text, with: language))
        }
        #expect(!ScriptCheck.agrees("hello there", with: .arabic))
        #expect(ScriptCheck.agrees("İstanbul'a gidiyoruz", with: .turkish))
        #expect(ScriptCheck.script(of: "١٢٣ ؟") == .neither)
    }
}

// MARK: - The hold

private final class LikelyLog: @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [EngineFamily: [Bool]] = [:]
    private var finishes: [EngineFamily] = []
    func likely(_ family: EngineFamily, _ value: Bool) {
        lock.withLock { calls[family, default: []].append(value) }
    }
    func finished(_ family: EngineFamily) { lock.withLock { finishes.append(family) } }
    func calls(_ family: EngineFamily) -> [Bool] { lock.withLock { calls[family] ?? [] } }
    var finished: [EngineFamily] { lock.withLock { finishes } }
}

/// A microphone that streams `seconds` of audio at 5× real time while the key is held.
private final class PacedMic: LiveAudioSource, @unchecked Sendable {
    let total: Int
    let chunks: AsyncStream<[Float]>
    private let continuation: AsyncStream<[Float]>.Continuation
    private var feeder: Task<Void, Never>?
    init(seconds: Double) {
        total = Int(seconds * 16_000)
        (chunks, continuation) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .unbounded)
    }
    func start() async throws {
        let continuation = self.continuation, total = self.total
        feeder = Task {
            var sent = 0
            while sent < total, !Task.isCancelled {
                let n = min(1600, total - sent)
                continuation.yield([Float](repeating: 0.3, count: n))
                sent += n
                try? await Task.sleep(for: .milliseconds(20))
            }
        }
    }
    func stop() async throws -> AudioBuffer {
        await feeder?.value
        continuation.finish()
        return AudioBuffer(samples: [Float](repeating: 0.3, count: total))
    }
    func warmUp() async {}
}

private struct LoggingStream: TranscriptionStream {
    let family: EngineFamily
    let log: LikelyLog
    /// Where the stream's speech detector says the speaker stopped; nil = no detector.
    var speechEnd: Int?
    func lastSpeechEnd() async -> Int? { speechEnd }
    func append(_ samples: [Float]) async {}
    func finish(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        log.finished(family)
        return Transcript(raw: family == .turkish ? "merhaba nasılsın bugün" : "salom qalaysiz",
                          language: language, engineID: family.rawValue)
    }
    func cancel() async {}
    func setLikely(_ likely: Bool) async { log.likely(family, likely) }
}

private struct LoggingEngine: StreamingTranscriptionEngine {
    let family: EngineFamily
    let log: LikelyLog
    var speechEnd: Int?
    var engineID: String { family.rawValue }
    var supportedLanguages: Set<Language> {
        family == .turkish ? [.turkish] : family == .arabic ? [.arabic] : [.uzbek]
    }
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: "batch", language: language, engineID: engineID)
    }
    func openStream() async -> any TranscriptionStream {
        LoggingStream(family: family, log: log, speechEnd: speechEnd)
    }
}

/// Every detection says: Uzbek, and a Turkish candidate.
private struct CandidateRouter: LanguageRouter {
    func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        if let pin { return RouteDecision(language: pin, source: .pin) }
        return RouteDecision(language: .uzbek, source: .acoustic, turkicMass: 0.99,
                             turkishShare: 0.99, arabicShare: 0, candidate: .turkish)
    }
}

/// Every detection says: Uzbek, and an Arabic candidate (C4 §14.1).
private struct ArabicCandidateRouter: LanguageRouter {
    func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        if let pin { return RouteDecision(language: pin, source: .pin) }
        return RouteDecision(language: .uzbek, source: .acoustic, turkicMass: 0.4,
                             turkishShare: 0.3, arabicShare: 0.4, candidate: .arabic)
    }
}

/// Uzbek, with a `tr` share of 0.95 — a Turkish candidate once the audio is 5 s long.
private struct TurkishSoundingRouter: LanguageRouter {
    func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        if let pin { return RouteDecision(language: pin, source: .pin) }
        return RouteDecision(language: .uzbek, source: .acoustic, turkicMass: 0.99,
                             turkishShare: 0.95, arabicShare: 0,
                             candidate: audio.duration >= 5 ? .turkish : nil)
    }
}

/// Records how much audio each check heard.
private actor CoverageVerifier: AcousticClassifier {
    private(set) var heard: [Int] = []
    let value: [String: Double]
    init(_ value: [String: Double] = ["tr": 0.999]) { self.value = value }
    func posterior(for audio: AudioBuffer) async -> [String: Double] {
        heard.append(audio.samples.count)
        return value
    }
}

@Suite("Optional languages — the hold")
struct OptionalHoldTests {

    @Test("a pause after the candidate asks the check over every word, so key-up does not wait")
    func pauseCheckCoversTheEnd() async {
        let log = LikelyLog()
        // 7.2 s, the speaker stopped at 6.6 s: the spaced checks heard 3 and 6 s, and the 7–10 s
        // dictations of C4 §13 waited ~1 s at key-up for one over the whole recording. The head
        // says "not Turkish" here, so no verdict is trusted early and only the pause's covers.
        let end = Int(6.6 * 16_000)
        let engines: [EngineFamily: any TranscriptionEngine] = [
            .uzbek: LoggingEngine(family: .uzbek, log: log, speechEnd: end),
            .turkish: LoggingEngine(family: .turkish, log: log, speechEnd: end),
        ]
        let verifier = CoverageVerifier(["tr": 0.4, "uz": 0.6])
        let s = DictationSession(audio: PacedMic(seconds: 7.2), router: CandidateRouter(),
                                 engines: engines, sink: Sink(), languageHead: verifier)
        await s.arm()
        // 7.2 s of audio at 5× real time, and key-up once it has all arrived.
        try? await Task.sleep(for: .milliseconds(2_200))
        let record = await s.finish()
        let heard = await verifier.heard
        #expect(heard.contains { $0 > end })
        // Key-up asked nothing over the whole recording: at most it waited for the pause's check.
        #expect(!heard.contains(Int(7.2 * 16_000)))
        #expect((record.turkishCheckWaitMillis ?? 0) < 50)
        #expect(record.route?.language == .uzbek && record.route?.turkishVerified == 0.4)
    }

    @Test("key-up's own check reads to 0.3 s past the speech, not the silence held after it")
    func keyUpCheckStopsAtTheSpeech() async {
        let log = LikelyLog()
        let end = Int(5.5 * 16_000)
        let engines: [EngineFamily: any TranscriptionEngine] = [
            .uzbek: LoggingEngine(family: .uzbek, log: log, speechEnd: end),
            .turkish: LoggingEngine(family: .turkish, log: log, speechEnd: end),
        ]
        var config = DictationSession.Config()
        config.earlyRouting = nil   // nothing asked during the hold: key-up asks
        let verifier = CoverageVerifier()
        let s = DictationSession(audio: PacedMic(seconds: 8), router: CandidateRouter(),
                                 engines: engines, sink: Sink(), config: config,
                                 languageHead: verifier)
        await s.arm()
        try? await Task.sleep(for: .milliseconds(1_900))
        let record = await s.finish()
        #expect(await verifier.heard == [end + Int(0.3 * 16_000)])
        #expect(record.route?.language == .turkish)
    }

    @Test("an early Uzbek that sounded Turkish is not trusted once the recording passes 5 s")
    func earlyUzbekDoesNotSkipTheFloor() async {
        let log = LikelyLog()
        // Let go on the last syllable (5.5 s of speech in 5.6 s), after one detection at 4.2 s.
        let end = Int(5.5 * 16_000)
        let engines: [EngineFamily: any TranscriptionEngine] = [
            .uzbek: LoggingEngine(family: .uzbek, log: log, speechEnd: end),
            .turkish: LoggingEngine(family: .turkish, log: log, speechEnd: end),
        ]
        var config = DictationSession.Config()
        config.earlyRouting?.first = 4.2   // one detection, at 4.2 s: Uzbek, trusted from 4 s
        let s = DictationSession(audio: PacedMic(seconds: 5.6), router: TurkishSoundingRouter(),
                                 engines: engines, sink: Sink(), config: config,
                                 languageHead: CoverageVerifier())
        await s.arm()
        try? await Task.sleep(for: .milliseconds(1_300))
        let record = await s.finish()
        #expect(record.earlyRouteSeconds.map { $0 < 5 } == true)
        #expect(record.route?.language == .turkish && record.route?.source == .turkishCheck)
    }

    @Test("optional streams open stood down; a candidate raises Turkish; a trusted verdict stands Uzbek down")
    func holdFollowsTheCheck() async {
        let log = LikelyLog()
        let engines: [EngineFamily: any TranscriptionEngine] = [
            .uzbek: LoggingEngine(family: .uzbek, log: log),
            .turkish: LoggingEngine(family: .turkish, log: log),
            .arabic: LoggingEngine(family: .arabic, log: log),
        ]
        let s = DictationSession(audio: PacedMic(seconds: 11), router: CandidateRouter(),
                                 engines: engines, sink: Sink(),
                                 languageHead: CountingVerifier(["tr": 0.999]))
        await s.arm()
        try? await Task.sleep(for: .milliseconds(2_600))   // 11 s of audio at 5× real time
        let record = await s.finish()
        #expect(log.calls(.turkish).first == false)
        #expect(!log.calls(.arabic).isEmpty && log.calls(.arabic).allSatisfy { !$0 })
        #expect(log.calls(.turkish).contains(true))
        #expect(log.calls(.uzbek).last == false)
        #expect(record.route?.language == .turkish && record.route?.source == .turkishCheck)
        #expect(log.finished == [.turkish])
    }

    @Test("an Arabic candidate over Uzbek keeps Cohere off the GPU in the hold; a pause check settles key-up")
    func arabicCandidateHold() async {
        let log = LikelyLog()
        let end = Int(6.6 * 16_000)
        let engines: [EngineFamily: any TranscriptionEngine] = [
            .uzbek: LoggingEngine(family: .uzbek, log: log, speechEnd: end),
            .arabic: LoggingEngine(family: .arabic, log: log, speechEnd: end),
        ]
        let verifier = CoverageVerifier(["ar": 0.99, "en": 0.01])
        var config = DictationSession.Config()
        config.arabicFamiliar = true
        let s = DictationSession(audio: PacedMic(seconds: 7.2), router: ArabicCandidateRouter(),
                                 engines: engines, sink: Sink(), config: config,
                                 languageHead: verifier)
        await s.arm()
        try? await Task.sleep(for: .milliseconds(2_200))
        let record = await s.finish()
        // Over an Uzbek base the Arabic stream stays stood down in the hold (the Uzbek one is
        // on the same GPU, C4 §14.4); the head's "yes" sends key-up to it all the same.
        #expect(!log.calls(.arabic).isEmpty && log.calls(.arabic).allSatisfy { !$0 })
        // Key-up used the hold's check over every word (never a whole-recording one).
        let heard = await verifier.heard
        #expect(heard.contains { $0 > end } && !heard.contains(Int(7.2 * 16_000)))
        #expect(record.route?.language == .arabic && record.route?.source == .arabicCheck)
        #expect(log.finished == [.arabic])
    }
}
