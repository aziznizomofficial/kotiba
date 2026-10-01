import Foundation
import Testing

@testable import KotibaCore

// Band 1. The measured posteriors below are real numbers from the research, not invented
// ones — in particular the `tr 0.63 / az 0.17 / uz 0.00` case, which is the whole reason
// cluster mass exists, and the Kazakh incident, which is why Whisper LID is not in this file.

private struct FixedClassifier: AcousticClassifier {
    let value: [String: Double]
    func posterior(for audio: AudioBuffer) async -> [String: Double] { value }
}

private func anyBuffer() -> AudioBuffer {
    AudioBuffer(samples: Array(repeating: 0.3, count: 16_000))
}

@Suite("Cluster mass — the rule that waits for `uz` to win never fires")
struct ClusterMassTests {

    @Test("the measured Uzbek posterior routes to Uzbek despite uz scoring exactly zero")
    func theCaseThatMotivatesAllOfThis() {
        // Measured on a clean Uzbek sample: the model has heard vastly more Turkish.
        let posterior = ["tr": 0.63, "az": 0.17, "uz": 0.00, "en": 0.12, "ru": 0.08]
        let cm = ClusterMass()
        #expect(cm.isUzbek(posterior))
        #expect(cm.mass(posterior) > 0.79)
        #expect(posterior["uz"] == 0.0, "argmax on `uz` would route this to the wrong engine")
    }

    @Test("clear English does not route to Uzbek")
    func english() {
        #expect(!ClusterMass().isUzbek(["en": 0.94, "ru": 0.03, "tr": 0.03]))
    }

    @Test("clear Russian does not route to Uzbek")
    func russian() {
        #expect(!ClusterMass().isUzbek(["ru": 0.88, "uk": 0.07, "en": 0.05]))
    }

    @Test("Tajik counts toward the cluster — same geography, different family")
    func tajik() {
        #expect(ClusterMass().isUzbek(["tg": 0.55, "en": 0.25, "ru": 0.20]))
    }

    @Test("an unnormalised posterior is handled by dividing through")
    func unnormalised() {
        let cm = ClusterMass()
        #expect(abs(cm.mass(["tr": 63, "en": 37]) - 0.63) < 1e-9)
    }

    @Test("an empty or all-zero posterior is 0, not a division by zero")
    func degenerate() {
        #expect(ClusterMass().mass([:]) == 0)
        #expect(ClusterMass().mass(["en": 0, "uz": 0]) == 0)
        #expect(!ClusterMass().isUzbek([:]))
    }

    @Test("exactly at the threshold routes to Uzbek — the asymmetry is deliberate")
    func boundary() {
        // A tie should favour the engine that can actually produce the language, because the
        // unified engine cannot emit Uzbek at all while the Uzbek engine merely emits English
        // badly. The costs of the two mistakes are not symmetric.
        //
        // The threshold is explicit so this keeps testing the boundary. It used to rely on the
        // default happening to be 0.5, which meant that changing the default would have left the
        // `>=`-not-`>` rule silently unverified.
        #expect(ClusterMass(threshold: 0.5).isUzbek(["tr": 0.5, "en": 0.5]))
        #expect(ClusterMass(threshold: 0.05).isUzbek(["tr": 0.05, "en": 0.95]))
    }

    @Test("the shipped default is the measured one, in both places that hold it")
    func defaultIsTheMeasuredValue() {
        // These were 0.5 in KotibaCore and 0.05 in the app. Anything built with `ClusterMass()`
        // — `kotiba-probe`, and `TieredRouter`'s own default argument — used the abandoned value.
        #expect(ClusterMass.defaultThreshold == 0.05)
        #expect(ClusterMass().threshold == 0.05)
    }
}

@Suite("Script check — the only cheap verifier after a silent mis-route")
struct ScriptCheckTests {

    @Test(arguments: [
        ("hello world", ScriptCheck.Script.latin),
        ("Маргулан Сейсимбай", .cyrillic),
        ("salom Маргулан", .mixed),
        ("123 …", .neither),
        ("", .neither),
    ])
    func detection(text: String, expected: ScriptCheck.Script) {
        #expect(ScriptCheck.script(of: text) == expected)
    }

    @Test("Cyrillic out of the Uzbek engine is impossible — its vocabulary has zero Cyrillic tokens")
    func cyrillicFromUzbekIsImpossible() {
        #expect(!ScriptCheck.agrees("Маргулан", with: .uzbek))
    }

    @Test("the real measured mis-route is caught")
    func theMeasuredMisroute() {
        // WhisperKit `small`, unpinned, on a Russian clip. Well-formed Latin, no error.
        let decision = RouteDecision(language: .russian, source: .acoustic)
        #expect(decision.verify("Marguelan Ceisimbay podcast")
                == .suspect(observed: .latin, suggests: .uzbek))
    }

    @Test("the same clip, pinned correctly, produces no complaint")
    func pinnedIsFine() {
        let decision = RouteDecision(language: .russian, source: .pin)
        #expect(decision.verify("Маргулансисимбай.") == .consistent)
    }

    @Test("a code-switched line is not flagged — mixed script is the user's normal register")
    func codeSwitchIsNotAnError() {
        let decision = RouteDecision(language: .uzbek, source: .acoustic)
        #expect(decision.verify("bugun bozorga bordim, потом домой") == .consistent)
    }

    @Test("digits and punctuation alone never trigger a false alarm")
    func degenerateOutput() {
        #expect(RouteDecision(language: .uzbek, source: .pin).verify("14 — 25%") == .consistent)
    }

    @Test("normal Uzbek output passes")
    func uzbekPasses() {
        let d = RouteDecision(language: .uzbek, source: .acoustic)
        #expect(d.verify("xo\u{02BB}p qarang aka, demo akkaunt ochib") == .consistent)
    }
}

// The mis-route the verifier could not see, and now can.
//
// Verbatim from this app's diagnostics, 2026-08-11T11:52:41Z. Uzbek speech scored a Turkic
// cluster mass of 0.0122 — below the 0.05 threshold — so it never reached the Uzbek model. The
// Russian large-v3-turbo took it and wrote the Uzbek out phonetically in Cyrillic. The old rule
// called that consistent, because Cyrillic from a Russian route agreed by definition.

@Suite("Script check — Uzbek written in Cyrillic by the Russian engine")
struct UzbekInCyrillic {

    static let measured =
        "хоп масалан қаранғалады німәдейсам ғамын яқшы тынық чотке қылып ез болады"

    @Test("the measured mis-route is now caught")
    func theSilentOne() {
        #expect(ScriptCheck.looksLikeUzbekInCyrillic(Self.measured))
        #expect(!ScriptCheck.agrees(Self.measured, with: .russian))
        let d = RouteDecision(language: .russian, source: .acoustic, turkicMass: 0.0122)
        #expect(d.verify(Self.measured) == .suspect(observed: .cyrillic, suggests: .uzbek))
    }

    @Test("genuine Russian is left alone — these are the app's own real Russian dictations")
    func realRussianPasses() {
        for text in ["Так, скажи мне брат, какие фильмы ты просмотрел в последний день?",
                     "ну чё пойдём на треньку",
                     "Маргулансисимбай."] {
            #expect(ScriptCheck.nonRussianCyrillicCount(text) == 0, "\(text)")
            #expect(!ScriptCheck.looksLikeUzbekInCyrillic(text), "\(text)")
            #expect(ScriptCheck.agrees(text, with: .russian), "\(text)")
            #expect(RouteDecision(language: .russian, source: .acoustic).verify(text)
                    == .consistent, "\(text)")
        }
    }

    @Test("Tashkent Russian names its own places and is left alone")
    func realRussianWithUzbekPlaceNames() {
        // Every one of these fired under the first version of this rule, which counted any
        // Cyrillic letter outside the Russian alphabet and needed only two of them. They are
        // Russian sentences a Russian speaker meant, and handing them to an Uzbek-only model
        // would be a worse failure than the mis-route this exists to recover.
        for text in ["Встретимся на Ғафур Ғулом в семь",
                     "Я живу на Қўйлиқ, рядом с Мирзо Улуғбек",
                     "Нұрсұлтан приехал из Қазақстана",
                     "Позвони Ҷамшеду в Тоҷикистон",
                     "Це не російська мова, це Київ",
                     "Каракалпакстан, Нөкис, Мойнақ"] {
            #expect(!ScriptCheck.looksLikeUzbekInCyrillic(text), "\(text)")
            #expect(ScriptCheck.agrees(text, with: .russian), "\(text)")
        }
    }

    @Test("only the four letters Uzbek has and Russian does not are counted")
    func theTellingLetters() {
        for letter in ["ў", "қ", "ғ", "ҳ"] {
            #expect(ScriptCheck.nonRussianCyrillicCount(letter + letter) == 2, "\(letter)")
        }
        // Russian's own 33 letters never count, in either case.
        #expect(ScriptCheck.nonRussianCyrillicCount(
            "абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ") == 0)
        // Kazakh, Tajik and Ukrainian letters are not Uzbek and are not evidence of it.
        #expect(ScriptCheck.nonRussianCyrillicCount("әұүңҷӣіїєґ") == 0)
    }

    @Test("words separate the two cases where letters and density cannot")
    func wordsNotLetters() {
        // By letters the Russian sentence looks MORE Uzbek than the real mis-route — 4 letters at
        // ~13% of its Cyrillic against 6 at ~10% — so no threshold on letters or density can tell
        // them apart. This is the measurement that forced the rule to count words.
        let russian = "Я живу на Қўйлиқ, рядом с Мирзо Улуғбек"
        #expect(ScriptCheck.nonRussianCyrillicCount(russian) == 4)
        #expect(ScriptCheck.nonRussianCyrillicCount(Self.measured) == 6)

        // By words they are two and five.
        #expect(ScriptCheck.uzbekCyrillicWordCount(russian) == 2)
        #expect(ScriptCheck.uzbekCyrillicWordCount(Self.measured) == 5)
        #expect(!ScriptCheck.looksLikeUzbekInCyrillic(russian))
        #expect(ScriptCheck.looksLikeUzbekInCyrillic(Self.measured))
    }

    @Test("the same word repeated is still one word")
    func repetitionIsNotEvidence() {
        // A repetition loop from a confused decoder must not look like a spread of Uzbek.
        let loop = String(repeating: "қаранғалады ", count: 8)
        #expect(ScriptCheck.uzbekCyrillicWordCount(loop) == 1)
        #expect(!ScriptCheck.looksLikeUzbekInCyrillic(loop))
    }

    @Test("Cyrillic out of the Uzbek engine still means the audio was Russian")
    func theOtherDirectionIsUnchanged() {
        let d = RouteDecision(language: .uzbek, source: .acoustic)
        #expect(d.verify("Маргулан Сейсимбай") == .suspect(observed: .cyrillic,
                                                           suggests: .russian))
    }

    @Test("Latin is never Uzbek-in-Cyrillic, whatever it says")
    func latinIsIrrelevant() {
        #expect(ScriptCheck.nonRussianCyrillicCount("xo\u{02BB}p qarang aka") == 0)
        #expect(!ScriptCheck.looksLikeUzbekInCyrillic("qaranglar edi nima deysan"))
    }
}

@Suite("TieredRouter — a pin is free and absolute")
struct TieredRouterTests {

    @Test("a pin short-circuits the classifier entirely")
    func pinBeatsEverything() async {
        // A classifier that would scream Uzbek. The pin must not consult it at all.
        let router = TieredRouter(classifier: FixedClassifier(value: ["tr": 0.99]))
        let d = await router.route(anyBuffer(), pin: .english)
        #expect(d.language == .english)
        #expect(d.source == .pin)
        #expect(d.family == .unified)
        #expect(d.turkicMass == nil, "a pin does no acoustic work, so there is no mass to record")
    }

    @Test("without a pin, the measured Uzbek posterior routes to the Uzbek engine")
    func acousticUzbek() async {
        let router = TieredRouter(classifier: FixedClassifier(
            value: ["tr": 0.63, "az": 0.17, "uz": 0.00, "en": 0.12, "ru": 0.08]))
        let d = await router.route(anyBuffer(), pin: nil)
        #expect(d.language == .uzbek)
        #expect(d.family == .uzbek)
        #expect(d.source == .acoustic)
        #expect((d.turkicMass ?? 0) > 0.79)
    }

    @Test("en and ru both land on the unified engine — the label is advisory inside it")
    func unifiedEngineForBoth() async {
        let en = TieredRouter(classifier: FixedClassifier(value: ["en": 0.9, "ru": 0.1]))
        let ru = TieredRouter(classifier: FixedClassifier(value: ["ru": 0.9, "en": 0.1]))
        let a = await en.route(anyBuffer(), pin: nil)
        let b = await ru.route(anyBuffer(), pin: nil)
        #expect(a.language == .english)
        #expect(b.language == .russian)
        #expect(a.family == .unified)
        #expect(b.family == .unified, "getting en-vs-ru wrong costs nothing; Parakeet decides")
    }

    @Test("no classifier falls back rather than guessing, and says so")
    func noClassifier() async {
        let d = await TieredRouter().route(anyBuffer(), pin: nil)
        #expect(d.source == .fallback)
        #expect(d.language == .english)
    }

    @Test("an empty posterior falls back rather than dividing by zero")
    func emptyPosterior() async {
        let router = TieredRouter(classifier: FixedClassifier(value: [:]))
        let d = await router.route(anyBuffer(), pin: nil)
        #expect(d.source == .fallback)
    }
}

// The mis-route in the other direction, which no script check can see.
//
// Verbatim from this app's diagnostics, 2026-08-22/23. The acoustic pass scored this speaker's
// ENGLISH at Turkic cluster masses of 0.058 … 0.457 — inside the range of their real Uzbek
// (0.051 … 0.961) — so a third of everything routed to the Uzbek engine was English. The Uzbek
// fine-tune still speaks English, so it answered in well-formed, lowercase, Latin English and
// `agrees` called that consistent: Latin from an Uzbek route agreed by definition.
//
// Words separate the cases cleanly. Over all 32 Uzbek-routed transcripts on disk, every English
// one carried four or more distinct English function words and not one word of Uzbek evidence;
// every genuine Uzbek one carried at most ONE English function word and five or more of Uzbek.

@Suite("Lexical check — English answered by the Uzbek engine")
struct EnglishOutOfUzbek {

    static let measuredEnglish = [
        "kotub is somehow exit the app in some five, six hours. check. nfx.",
        "is sole models unlimited use now for all users?",
        "ai balance apps icon is not visible on top bar. make it visible and pin.",
        "hi ladies and gentlemen, how are you? today you will have six different homework tasks.",
        "go to zamon folder in finder. and there inside the",
        "how is payme click or uzum qr different from pay payme merchant api?",
        "i seem to get it now. so you mean all the",
        "i will do my part as well soon.",
    ]

    static let measuredUzbek = [
        "xo'p qara do'stim uchta narsa qilishing kerak",
        "masalan oxirgi zamon proyektimizda nima qildik? vebsayt yasadik, telegram mini app yasadik",
        "tak. kotib, manga kerak, san shu no shu ishlatayotgan programmamdan copy paste qilishga",
        "assalomu alaykum, do'stim, yaxshimisiz? ahvollaring yaxshimi? charchamayapsanmi?",
        "meni fikrimcha, bu ahmoqni magazin olib ketish juda qiyin ish.",
        "hoy odamzod, men senga aytdim ku, uncha arzon bo'lmaydi deb.",
        "ba'zi kitoblarni olib kelishing kerak.",
        "o'zbekistonda arab tilida nashr qilingan kitoblar ro'yxati.",
        "e, listen, agar men bu platformalarni hamma yoqqa qo'yganimda hamma narsani build qilayotganimda",
        "xoʻp, uyga borgandan keyin, baʼzi bir ishlarni qilishing kerak.",
    ]

    @Test("every measured English mis-route is caught")
    func measuredEnglishIsCaught() {
        for text in Self.measuredEnglish {
            #expect(LexicalCheck.looksLikeEnglish(text), "\(text)")
            #expect(!ScriptCheck.agrees(text, with: .uzbek), "\(text)")
            let d = RouteDecision(language: .uzbek, source: .acoustic, turkicMass: 0.43)
            #expect(d.verify(text) == .suspect(observed: .latin, suggests: .english), "\(text)")
        }
    }

    @Test("every measured genuine Uzbek is left alone — including the code-switched ones")
    func measuredUzbekPasses() {
        for text in Self.measuredUzbek {
            #expect(!LexicalCheck.looksLikeEnglish(text), "\(text)")
            #expect(ScriptCheck.agrees(text, with: .uzbek), "\(text)")
            #expect(RouteDecision(language: .uzbek, source: .acoustic).verify(text)
                    == .consistent, "\(text)")
        }
    }

    @Test("the evidence is counted in distinct words, with a margin of two")
    func theNumbers() {
        // Real Uzbek peaked at one English function word ("copy paste … app"); the floor is three.
        #expect(LexicalCheck.englishEvidence("tak. kotib, manga kerak, copy paste qilishga") <= 1)
        #expect(LexicalCheck.englishEvidenceFloor == 3)
        // Repetition is one word.
        #expect(LexicalCheck.englishEvidence("the the the the the") == 1)
        #expect(!LexicalCheck.looksLikeEnglish("the the the the the"))
    }

    @Test("Uzbek evidence outweighs English unless English dominates three to one")
    func uzbekOutweighs() {
        // Three English function words against two Uzbek ones: a code-switched Uzbek line.
        let mixed = "bu is the app for kerak"
        #expect(LexicalCheck.englishEvidence(mixed) == 3)
        #expect(LexicalCheck.uzbekEvidence(mixed) == 2)
        #expect(!LexicalCheck.looksLikeEnglish(mixed))
        // Accidental suffix matches in English — "similar" ends in -lar, "planning" in -ning —
        // are real, and they do not veto the verdict: the English evidence dominates.
        let english = "it is similar to what we had in the planning for all of them"
        #expect(LexicalCheck.uzbekEvidence(english) == 2)
        #expect(LexicalCheck.englishEvidence(english) >= 6)
        #expect(LexicalCheck.looksLikeEnglish(english))
        // A suffix counts as evidence: -lar, -ning, -ni, -da, -dan, -ga.
        #expect(LexicalCheck.uzbekEvidence("kitoblarni olib kelishing") > 0)
        #expect(LexicalCheck.uzbekEvidence("there is the app") == 0)
        // -ing is not on the list, or every English gerund would be Uzbek; "happening" still
        // matches -ning, and the sentence is still English.
        #expect(LexicalCheck.uzbekEvidence("something is happening to all of them this morning") == 1)
        #expect(LexicalCheck.looksLikeEnglish("something is happening to all of them this morning"))
    }

    @Test("apostrophe variants are one orthography")
    func apostrophes() {
        // The engine writes ASCII ', the normaliser writes ʻ U+02BB and ʼ U+02BC, a keyboard
        // writes ’. `xo'p` is the same function word under all four.
        for apostrophe in ["'", "\u{02BB}", "\u{02BC}", "\u{2019}"] {
            let text = "xo\(apostrophe)p, ko\(apostrophe)p yo\(apostrophe)q"
            #expect(LexicalCheck.uzbekEvidence(text) == 3, "\(text)")
        }
    }

    @Test("short or wordless text is never English evidence")
    func shortTextIsNoEvidence() {
        #expect(!LexicalCheck.looksLikeEnglish(""))
        #expect(!LexicalCheck.looksLikeEnglish("yaxshi."))
        #expect(!LexicalCheck.looksLikeEnglish("screen recording."))
        #expect(!LexicalCheck.looksLikeEnglish("kaplya v okeane."))
        #expect(!LexicalCheck.looksLikeEnglish("123 456"))
    }

    @Test("the English route is not second-guessed by its own words")
    func englishRouteUnchanged() {
        for text in Self.measuredEnglish {
            #expect(ScriptCheck.agrees(text, with: .english), "\(text)")
            #expect(RouteDecision(language: .english, source: .acoustic).verify(text)
                    == .consistent)
        }
    }
}
