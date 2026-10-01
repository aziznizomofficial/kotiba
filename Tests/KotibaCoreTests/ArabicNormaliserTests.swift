import Foundation
import Testing

@testable import KotibaCore

// Arabic delivery (D-11, C4 §14.3): marks, spacing, digits, tatweel and case endings — and
// nothing else. The Windows port pins the same rows through golden/arabic-delivery.json.

@Suite("ArabicNormaliser")
struct ArabicNormaliserTests {

    @Test("Latin , ; ? inside Arabic become ، ؛ ؟, spaced like Arabic writes them")
    func marks() {
        #expect(ArabicNormaliser.forDelivery("مرحبا , كيف حالك ?")
                == "مرحبا، كيف حالك؟")
        #expect(ArabicNormaliser.forDelivery("أولا;ثانيا") == "أولا؛ ثانيا")
        #expect(ArabicNormaliser.forDelivery("نعم،لا") == "نعم، لا")
        #expect(ArabicNormaliser.forDelivery("هل وصلت ؟") == "هل وصلت؟")
    }

    @Test("a Latin word closing an Arabic question still takes ؟; an English sentence keeps ?")
    func context() {
        #expect(ArabicNormaliser.forDelivery("هل عندك iPhone?") == "هل عندك iPhone؟")
        #expect(ArabicNormaliser.forDelivery("شكرا. Are you there? نعم")
                == "شكرا. Are you there? نعم")
    }

    @Test("numbers: 1,500 and 3.5 stay; Arabic-Indic and Persian digits become 0–9")
    func digits() {
        #expect(ArabicNormaliser.forDelivery("دفعت 1,500 دينار") == "دفعت 1,500 دينار")
        #expect(ArabicNormaliser.forDelivery("الساعة ٣٫٥ و ٢٠٪") == "الساعة 3.5 و 20%")
        #expect(ArabicNormaliser.forDelivery("عام ۱۹۹۰") == "عام 1990")
        #expect(ArabicNormaliser.forDelivery("في 3.5 ساعات. ثم") == "في 3.5 ساعات. ثم")
    }

    @Test("tatweel goes; a final short vowel goes; marks inside a word and tanwin stay")
    func marksOnLetters() {
        #expect(ArabicNormaliser.forDelivery("جمـــيل") == "جميل")
        #expect(ArabicNormaliser.forDelivery("في مدينةِ برلينَ") == "في مدينة برلين")
        #expect(ArabicNormaliser.forDelivery("يُعد فعّال شكرًا") == "يُعد فعّال شكرًا")
        // shadda + final damma: the damma goes, the shadda stays.
        #expect(ArabicNormaliser.forDelivery("تُميّزُ،") == "تُميّز،")
    }

    @Test("text with no Arabic letter is returned exactly; delivery is idempotent")
    func untouched() {
        for text in ["Hello, world?", "Привет, мир?", "1,5 ? ;", "", "salom, doʻstim?"] {
            #expect(ArabicNormaliser.forDelivery(text) == text)
        }
        for text in ["مرحبا , كيف حالك ?", "في مدينةِ برلينَ ؟", "الساعة ٣٫٥", "هل عندك iPhone?"] {
            let once = ArabicNormaliser.forDelivery(text)
            #expect(ArabicNormaliser.forDelivery(once) == once)
        }
    }

    @Test("Orthography routes each language to its own delivery step")
    func orthography() {
        #expect(Orthography.forDelivery("مرحبا ?", language: .arabic) == "مرحبا؟")
        #expect(Orthography.forDelivery("مرحبا ?", language: .english) == "مرحبا ?")
        #expect(Orthography.forDelivery("do'stim", language: .uzbek)
                == UzbekNormaliser.forDelivery("do'stim"))
    }
}

@Suite("Arabic modes (C4 §14.5)")
struct ArabicModesTests {

    @Test("Message trims sentence-initial openers only, with their comma, and nothing else")
    func trimOpeners() {
        #expect(OnDeviceModes.trimOpeners("يعني، طيب خلينا نروح بكرة.", language: .arabic)
                == "خلينا نروح بكرة.")
        #expect(OnDeviceModes.trimOpeners("اسمع, الاجتماع اتأجل.", language: .arabic)
                == "الاجتماع اتأجل.")
        // Not mid-sentence, not a word that means something, not a sentence of openers only.
        #expect(OnDeviceModes.trimOpeners("هو يعني تعبان.", language: .arabic) == "هو يعني تعبان.")
        #expect(OnDeviceModes.trimOpeners("بس أنا تعبان.", language: .arabic) == "بس أنا تعبان.")
        #expect(OnDeviceModes.trimOpeners("طيب.", language: .arabic) == "طيب.")
        #expect(OnDeviceModes.trimOpeners("so we left.", language: .english) == "so we left.")
    }

    private struct Rewriter: PolishEngine {
        var polishID: String { "rewriter" }
        var supportedLanguages: Set<Language> { [.arabic, .english] }
        func polish(_ text: String, language: Language, instructions: String) async throws -> String {
            "REWRITTEN"
        }
    }

    @Test("Arabic Message keeps every word but fillers, whatever the model wrote")
    func messageByProjection() async {
        // A model that rewrites: nothing of it aligns, so the sentence stays, minus its openers.
        let arabic = IncrementalPolish(behaviour: .message, language: .arabic, engine: Rewriter())
        #expect(await arabic.wantsModel)
        await arabic.commit("يعني، الاجتماع اتأجل. ")
        let outcome = await arabic.finish(tail: "طيب خلينا نروح بكرة.", deadline: .seconds(2))
        #expect(outcome.text == "الاجتماع اتأجل. خلينا نروح بكرة.")
        #expect(outcome.modelSentences == 0)
        #expect(OnDeviceModes.messageByProjection == [.arabic])
    }

    @Test("the Message projection drops a filler or a repeat the model dropped, and nothing else")
    func projectionMayDrop() {
        let mayDrop: Set<String> = ["والله", "يعني"]
        // The model dropped a filler, a repeat and a content word, and punctuated.
        let model = "الأكل كان بارد، بس الخدمة حلوة."
        let input = "والله الأكل كان كان بارد شوية بس الخدمة حلوة"
        let projected = PunctuationProjection.project(model, onto: input, mayDrop: mayDrop)
        #expect(projected.text == "الأكل كان بارد شوية، بس الخدمة حلوة.")
        // Plain projection counts the dropped filler and repeat against the model (6 of 9
        // aligned, under 0.7) and keeps the sentence exactly as spoken.
        #expect(PunctuationProjection.project(model, onto: input).text == input)
    }

    private struct SlowPunctuator: PromptedPolishEngine {
        var polishID: String { "slow" }
        var supportedLanguages: Set<Language> { [.arabic] }
        func polish(_ text: String, language: Language, instructions: String) async throws -> String {
            text
        }
        func polish(_ text: String, language: Language, prompt: PolishPrompt,
                    maxOutputTokens: Int) async throws -> String {
            try? await Task.sleep(for: .seconds(30))
            return text.replacingOccurrences(of: " بس", with: "، بس")
        }
    }

    @Test("Arabic Super waits for the model only 40 ms after release (C4 §14.4)")
    func superTailCap() async {
        #expect(OnDeviceModes.superTailCap[.arabic] == .milliseconds(40))
        let polish = IncrementalPolish(behaviour: .superMode, language: .arabic,
                                       engine: SlowPunctuator())
        let started = ContinuousClock.now
        let outcome = await polish.finish(tail: "الأكل كان بارد بس الخدمة حلوة.",
                                          deadline: .seconds(10))
        // Behaviour, not scheduler speed: the model would take 30 s and the deadline is 10 s, so
        // returning within 3 s can only be the 40 ms cap. (A 400 ms bound read 459 ms under a
        // parallel `swift test` and failed a working cap.)
        #expect(ContinuousClock.now - started < .seconds(3))
        #expect(outcome.text == "الأكل كان بارد بس الخدمة حلوة.")
    }
}

