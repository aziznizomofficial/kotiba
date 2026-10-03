import Foundation
import Testing

@testable import KotibaCore

// Band 1. The language decision of P4 (D-14): the word lists and their fold, what a transcript
// reads as, the prior, and the policy over the fitted model — on the owner's own failure cases
// (written here as text only, no audio), every one of which went to the wrong language before.

@Suite("Language decision — word lists and transcript evidence")
struct LexiconTests {

    @Test("the fold is the lists' own: apostrophes, Turkish i, Russian ё, Arabic marks")
    func fold() {
        #expect(Lexicon.fold("Oʻzbekiston", for: .uzbek) == "o'zbekiston")
        #expect(Lexicon.fold("o‘zbek", for: .uzbek) == "o'zbek")
        #expect(Lexicon.fold("İstanbul", for: .turkish) == "istanbul")
        #expect(Lexicon.fold("ISIK", for: .turkish) == "isik")
        #expect(Lexicon.fold("ıslak", for: .turkish) == "islak")
        #expect(Lexicon.fold("Ёлка", for: .russian) == "елка")
        #expect(Lexicon.fold("أَيُّهَا", for: .arabic) == "ايها")
        #expect(Lexicon.fold("مدرسة", for: .arabic) == "مدرسه")
    }

    @Test("each list knows its own language's common words, in any of its spellings")
    func membership() {
        #expect(Lexicon.contains("yaxshimi", .uzbek))
        #expect(Lexicon.contains("Oʻzbekiston", .uzbek))
        #expect(Lexicon.contains("nasılsın", .turkish))
        #expect(Lexicon.contains("унижение", .russian))
        #expect(Lexicon.contains("السلام", .arabic))
        #expect(Lexicon.contains("folder", .english))
        #expect(!Lexicon.contains("инсайд", .russian))
        #expect(!Lexicon.contains("виджетс", .russian))
        #expect(!Lexicon.contains("tavbatannasuha", .uzbek))
    }

    @Test("the lists are the generated ones")
    func listsAreGenerated() {
        #expect(Lexicon.counts[.uzbek] == UzbekWords.count)
        #expect(Lexicon.counts[.turkish] == TurkishWords.count)
        #expect(Lexicon.counts[.russian] == RussianWords.count)
        #expect(Lexicon.counts[.arabic] == ArabicWords.count)
    }

    @Test("Parakeet's Cyrillic for English is no Russian; real Russian is")
    func transliteratedEnglish() {
        let ru = LanguageModel.order.firstIndex(of: .russian)!
        let fake = TranscriptEvidence.read("Инсайд зе контент фоль.")
        #expect(fake.counted == 4 && fake.known[ru] <= 1)
        let real = TranscriptEvidence.read("Боль и унижение.")
        #expect(real.counted == 3 && real.known[ru] == 3)
    }

    @Test("proper nouns, numbers' suffixes and lone hesitations are not counted")
    func counting() {
        let e = TranscriptEvidence.read("Send it to Gonka on the 1st, um, okay.")
        #expect(e.counted == 6)          // send it to on the okay
        #expect(TranscriptEvidence.read("Uh.").counted == 1)
        #expect(TranscriptEvidence.read("").unusable)
        #expect(TranscriptEvidence.read("ha ha ha ha ha ha ha").unusable)
        #expect(!TranscriptEvidence.read("Привет, как дела?").unusable)
    }

    @Test("the prior is flat for a new user and soft for a practised one")
    func prior() {
        let all = Set(Language.allCases)
        let flat = LanguagePrior()
        #expect(flat.logPrior(.turkish, among: all) == flat.logPrior(.uzbek, among: all))
        let owner = LanguagePrior(counts: [.uzbek: 600, .english: 400, .arabic: 11, .russian: 10])
        let spread = owner.logPrior(.uzbek, among: all) - owner.logPrior(.turkish, among: all)
        #expect(spread > 0.7 && spread < 1.0, "\(spread)")   // 0.25 × log(620 / 20)
    }
}

// MARK: - The session's decision after transcription (step 4L)

private struct StillAudio: AudioSource {
    let seconds: Double
    func start() async throws {}
    func stop() async throws -> AudioBuffer {
        AudioBuffer(samples: (0..<Int(seconds * 16_000)).map { Float(sin(Double($0) * 0.05)) * 0.4 })
    }
    func warmUp() async {}
}

private final class Asked: @unchecked Sendable {
    private let lock = NSLock()
    private var log: [String] = []
    func add(_ s: String) { lock.withLock { log.append(s) } }
    var all: [String] { lock.withLock { log } }
}

private struct Batch: TranscriptionEngine, ScriptRespelling {
    let id: String
    let text: String
    let language: Language
    let supportedLanguages: Set<Language>
    let asked: Asked
    var respelled: String?
    var engineID: String { id }
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        asked.add(id)
        return Transcript(raw: text, language: self.language, engineID: id)
    }
    func transcribe(_ audio: AudioBuffer, writtenIn language: Language) async throws -> Transcript {
        asked.add("\(id)-respell")
        return Transcript(raw: respelled ?? text, language: language, engineID: id)
    }
}

private struct Posterior: AcousticClassifier {
    let p: [String: Double]
    func posterior(for audio: AudioBuffer) async -> [String: Double] { p }
}

private actor Collected: TextSink {
    private(set) var texts: [String] = []
    func insert(_ text: String) async throws -> InsertionOutcome { texts.append(text); return .inserted }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome { .inserted }
}

/// A model whose behaviour these tests can state without the fitted numbers (which are refitted
/// as data grows): a language scores its acoustic log-probability, plus, for every transcript,
/// log(1 + its words that language's list knows) − log(1 + those it does not).
private let standIn: LanguageModel = {
    let acoustic = (0..<5).map { i in (0..<8).map { $0 == i ? 1.0 : 0 } }
    let perSource = (0..<5).map { i in
        (0..<11).map { j in j == 2 * i ? 1.0 : j == 2 * i + 1 ? -1.0 : 0 } }
    return LanguageModel(acoustic: acoustic, transcript: Array(repeating: perSource, count: 4))
}()

private func lidSession(heard: [String: Double], seconds: Double = 3, unified: String,
                        respelled: String? = nil, uzbek: String = "bugun bozorga bordim.",
                        arabic: String = "", asked: Asked, sink: Collected = Collected())
    -> DictationSession {
    let policy = LanguagePolicy(model: standIn, enabled: Set(Language.allCases))
    var config = DictationSession.Config()
    config.earlyRouting = nil
    config.languageID = policy
    return DictationSession(
        audio: StillAudio(seconds: seconds),
        router: LanguageIDRouter(classifier: Posterior(p: heard), policy: policy),
        engines: [
            .unified: Batch(id: "unified", text: unified, language: .english,
                            supportedLanguages: [.english, .russian], asked: asked,
                            respelled: respelled),
            .uzbek: Batch(id: "uzbek", text: uzbek, language: .uzbek, supportedLanguages: [.uzbek],
                          asked: asked),
            .arabic: Batch(id: "arabic", text: arabic, language: .arabic,
                           supportedLanguages: [.arabic], asked: asked),
            .turkish: Batch(id: "turkish", text: "bugün pazara gittim.", language: .turkish,
                            supportedLanguages: [.turkish], asked: asked),
        ],
        sink: sink, config: config)
}

@Suite("Language decision — the session")
struct LanguageDecisionSessionTests {

    @Test("English heard, Parakeet wrote Cyrillic: English, respelled in Latin")
    func respellsEnglish() async {
        let asked = Asked()
        let sink = Collected()
        let s = lidSession(heard: ["en": 0.93, "ru": 0.05, "_": 0.02], unified: "Инсайд зе контент фоль.",
                           respelled: "Inside the content folder.", asked: asked, sink: sink)
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .english, "\(String(describing: record.route))")
        #expect(asked.all.contains("unified-respell"), "\(asked.all)")
        #expect(await sink.texts.first?.contains("Inside") == true)
    }

    @Test("Arabic half-heard, Parakeet's words unknown: the Arabic engine is asked and stands")
    func arabicFromParakeet() async {
        let asked = Asked()
        let s = lidSession(heard: ["en": 0.45, "ar": 0.4, "uz": 0.1, "_": 0.05],
                           unified: "Ya ayuhannas tubu ilallahi taubatan nasuha.",
                           uzbek: "ya ayyuhannasut tobu ilohi allohi tavbatannasuha.",
                           arabic: "يا أيها الناس توبوا إلى الله توبة نصوحا", asked: asked)
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .arabic, "\(String(describing: record.route)) \(asked.all)")
        #expect(record.secondOpinion == .arabic || record.route?.source == .acoustic, "\(String(describing: record.languageAfterTranscript)) \(asked.all)")
    }

    @Test("a clear Uzbek greeting stays Uzbek and asks nobody")
    func uzbekStays() async {
        let asked = Asked()
        let s = lidSession(heard: ["uz": 0.9, "tr": 0.05, "ar": 0.03, "_": 0.02], unified: "",
                           uzbek: "assalomu alaykum, do'stlar, qalaysizlar, ahvollar yaxshimi?",
                           asked: asked)
        await s.arm()
        let record = await s.finish()
        #expect(record.route?.language == .uzbek)
        #expect(record.secondOpinion == nil)
        #expect(asked.all == ["uzbek"], "\(asked.all)")
    }

    @Test("a pin is never moved")
    func pinStands() async {
        let asked = Asked()
        let s = lidSession(heard: ["ar": 0.99, "_": 0.01], unified: "Инсайд зе контент фоль.",
                           respelled: "Inside the content folder.", asked: asked)
        await s.arm()
        let record = await s.finish(pin: .russian)
        #expect(record.route?.language == .russian && record.route?.source == .pin)
        #expect(asked.all == ["unified"], "\(asked.all)")
    }
}
