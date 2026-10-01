import Foundation
import KotibaCore

// modes.json — the deterministic half of the modes, which the Windows port must reproduce
// exactly: `DictationCleanup`, `PunctuationProjection`, `SentenceSplitter`, `NoteLayout` and the
// model-free Note path of `IncrementalPolish`. The model's OUTPUT is not pinned here — it is the
// same GGUF on both platforms and its output is checked by the same guards, which are — but its
// INPUT is: `prompts` carries every per-sentence prompt `OnDeviceModes` builds, invoked, so the
// Windows port sends the model exactly the Mac's words.
//
// Inputs are invented sentences in the shapes measured in real diagnostics (never the owner's own
// words), plus the 120 committed Uzbek transcripts for the Uzbek clean-up, because the Uzbek rules
// (no false-stop repair, reduplication kept) are the ones a port gets wrong.

enum ModesFixtures {

    static let cleanupSamples: [(Language, String)] = [
        (.english, "Tell me how is, uh, the garden laid out"),
        (.english, "I want you to call me. Um, the plumber is late."),
        (.english, "we bought the seeds, um. Then we planted them."),
        (.english, "Um, can you water the plants?"),
        (.english, "Put the the pot on the stove."),
        (.english, "It is very very hot."),
        (.english, "Make sure you don't. Cross. a line of no return."),
        (.english, "Check the max. speed and the weight."),
        (.english, "Meet at 3.5 miles, e.g. near the bridge."),
        (.english, "I wanna, Have three of them."),
        (.english, "Then I will Consider it."),
        (.english, "Ask Mark about the Notes app."),
        (.english, "yesterday i think i'm done."),
        (.english, "buy milk new line buy fresh bread"),
        (.english, "are you coming question mark"),
        (.english, "The trial period ends soon"),
        (.english, "Well , that is odd ,right ?"),
        (.english, "what time does the shop open"),
        (.english, "Shopping list"),
        (.russian, "Так, э, нужно купить хлеб."),
        (.russian, "Я я уже иду."),
        (.russian, "Да да, конечно."),
        (.russian, "Это то, то, то."),
        (.russian, "ты придёшь вопросительный знак"),
        (.russian, "Встретимся в одной точке А"),
        (.russian, "когда откроется магазин"),
        (.uzbek, "bu juda, e, qiziq kitob ekan."),
        (.uzbek, "ee bugun havo yaxshi."),
        (.uzbek, "u tez tez keladi."),
        (.uzbek, "men men bozorga bordim."),
        (.uzbek, "yaxshimisiz? ishlar qalay."),
        (.uzbek, "keldingizmi so'roq belgisi"),
        (.uzbek, "ertaga kelasizmi"),
        (.uzbek, "ertaga soat beshda kelaman"),
    ] + reviewCleanupSamples + optionalLanguageCleanupSamples

    /// D-11: Turkish and Arabic. Fillers (and the ones deliberately kept — `şey`, `إيه`), function
    /// word stutters against grammatical reduplication, spoken punctuation, the question rules
    /// (Turkish's particle anywhere, Arabic's openers) and Arabic's own marks: a closing `؟`, and
    /// `، ؛ ؟` spaced like `, ; ?`. Turkish lowercases through its own locale, so `İ` compares.
    static let optionalLanguageCleanupSamples: [(Language, String)] = [
        (.turkish, "bu, ıı, çok güzel bir kitap"),
        (.turkish, "ee bugün hava çok güzel"),
        (.turkish, "ben ben markete gittim"),
        (.turkish, "yavaş yavaş gidiyoruz"),
        (.turkish, "bir şey söyleyeceğim"),
        (.turkish, "yarın geliyor musun"),
        (.turkish, "hazır mısınız arkadaşlar"),
        (.turkish, "bu ne"),
        (.turkish, "nereye gidiyorsun"),
        (.turkish, "saat beşte geleceğim"),
        (.turkish, "süt al yeni satır ekmek al"),
        (.turkish, "geliyor musun soru işareti"),
        (.turkish, "İstanbul İstanbul olalı böyle görmedi"),
        (.turkish, "Ve ve sonra gittik"),
        (.arabic, "امم أريد أن أذهب إلى السوق"),
        (.arabic, "في في البيت الآن"),
        (.arabic, "شوي شوي يا صديقي"),
        (.arabic, "هل وصلت إلى البيت"),
        (.arabic, "وهل تعرف الطريق"),
        (.arabic, "كيف حالك اليوم"),
        (.arabic, "من المدرسة إلى البيت مباشرة"),
        (.arabic, "سأصل غدا في الصباح"),
        (.arabic, "مرحبا ، كيف الحال ؟ بخير ؛ شكرا"),
        (.arabic, "اشتر الحليب سطر جديد اشتر الخبز"),
        (.arabic, "هل أنت قادم علامة استفهام"),
        (.arabic, "إيه ده يا جماعة"),
    ]

    /// The core review of 2026-09-30 (197ef6e): words the clean-up used to delete. Every input
    /// from its regression tests, plus the edges of each new rule — the Windows port, pinned
    /// only by the rows above, still deleted all of them.
    static let reviewCleanupSamples: [(Language, String)] = [
        // `new line` after a determiner is a noun phrase, not a command.
        (.english, "we launched a new line of shoes"),
        (.english, "the new line feature is great"),
        (.english, "write a new paragraph about roses"),
        (.english, "first item new line second item"),
        (.english, "our whole new line is out"),
        (.english, "The New Line opened"),
        (.english, "one new line, then another new line please"),
        (.english, "buy a new line, new line and milk"),
        // A spoken full stop ends the sentence: the next word takes a capital.
        (.english, "hello full stop how are you"),
        (.english, "I planted the roses full stop then I watered them"),
        (.english, "done full stop"),
        (.english, "one full stop two full stop three"),
        (.english, "really question mark yes exclamation mark 3 more"),
        (.english, "full stop, and more"),
        (.russian, "да вопросительный знак ну восклицательный знак хорошо"),
        (.uzbek, "keldingizmi so'roq belgisi ha undov belgisi yaxshi"),
        // A letter in a list is not a hesitation.
        (.english, "A, B and C are the options"),
        (.english, "choose between x, a, and b"),
        (.english, "the answer is a, or maybe e, I think"),
        (.english, "er, a, the thing"),
        (.uzbek, "a, b va c variantlari bor"),
        (.uzbek, "bu juda, e, qiziq kitob ekan."),
        (.uzbek, "variant a, yoki b"),
        (.russian, "пункты а, б и в"),
        (.russian, "Так, э, или нет"),
        // Repeated digits and doubled names are not stutters.
        (.english, "my pin is one one two three"),
        (.english, "zero zero seven is my code"),
        (.english, "call nine nine nine now"),
        (.english, "oh oh seven"),
        (.russian, "мой код один один два три"),
        (.russian, "две две штуки"),
        (.english, "we flew to Bora Bora last year"),
        (.english, "Bora Bora is lovely"),
        (.english, "Walla Walla, Washington"),
        (.english, "The the seeds arrived and and grew"),
        (.english, "and I I think so"),
        (.english, "we saw. The The band"),
        (.english, "first line\nNew New York"),
        // A capital standing alone is a name.
        (.english, "Section A, paragraph two covers it"),
        (.english, "we need a Plan B for the garden"),
        (.english, "take vitamin A daily"),
        (.english, "then A good one"),
        (.english, "go to Section I now"),
    ] + contentSafetySamples

    /// wip/cleanup-fix: shapes where the clean-up still changed what was said. Doubles are
    /// collapsed only on function words (reduplication, names, phrasal particles survive); a
    /// spoken command is speech when nothing precedes it, when a determiner makes it a noun, or
    /// when the transcriber capitalised it as a name; a common word inside a name keeps its
    /// capital.
    static let contentSafetySamples: [(Language, String)] = [
        (.english, "first line\nThe The band"),
        (.english, "I will sign in in the morning"),
        (.english, "Also, in in the garden it grew"),
        (.english, "a salad salad, not a fruit salad"),
        (.english, "the train goes choo choo"),
        (.english, "I gave her her keys"),
        (.russian, "белый белый снег"),
        (.russian, "в в доме"),
        (.english, "the car came to a full stop and waited"),
        (.english, "put a question mark there"),
        (.english, "visit New Line Cinema today"),
        (.english, "Dear Sam. New line. Thanks for the seeds"),
        (.english, "new line hello there"),
        (.english, "first item\nfull stop here"),
        (.english, "Are you coming? Question mark."),
        (.english, "we moved to New York last year"),
        (.english, "we read Lord Of The Rings"),
        (.english, "and Then Maria came"),
    ]

    static func cleanup() -> JSONValue {
        var rows: [(Language, String)] = cleanupSamples
        rows += Corpus.transcripts.map { (.uzbek, $0) }
        return arr(rows.map { language, text in
            var open = DictationCleanup(language: language)
            open.closesFinalSentence = false
            return obj([
                "language": str(language.rawValue),
                "in": str(text),
                "out": str(DictationCleanup(language: language).apply(text)),
                "outOpen": str(open.apply(text)),
            ])
        })
    }

    static let projectionSamples: [(model: String, input: String)] = [
        ("Xo\u{02BB}p, qarang, buvim bozorga ketdilar.", "xo\u{02BB}p qarang buvim bozorga ketdilar"),
        ("Assalomu alaykum, do\u{02BB}stlarim, ahvolingiz yaxshimi?",
         "assalomu alaykum do\u{02BB}stlarim ahvollaringiz yaxshimi"),
        ("Please, call the plumber today.", "call the plumber today now"),
        ("Welcome to the community, we are glad to have you!",
         "change the greeting in every automation"),
        ("**Buy** bread.", "buy bread"),
    ]

    static func projection() -> JSONValue {
        arr(projectionSamples.map { model, input in
            let result = PunctuationProjection.project(model, onto: input)
            return obj(["model": str(model), "in": str(input), "out": str(result.text),
                        "aligned": num(result.aligned)])
        })
    }

    static let splitSamples = [
        "The seeds came today. We plant them on Friday. And then",
        "Okay. Meet at 3.5 km, e.g. near the gate. Bring water please.",
        "buy milk and eggs\nbuy fresh bread",
    ]

    static func split() -> JSONValue {
        arr(splitSamples.map { text in
            let incremental = SentenceSplitter.split(text, keepIncompleteTail: true)
            let final = SentenceSplitter.split(text, keepIncompleteTail: false)
            return obj(["in": str(text),
                        "sentences": arr(incremental.sentences.map(str)),
                        "rest": str(incremental.rest),
                        "final": arr(final.sentences.map(str))])
        })
    }

    static let noteSamples: [(Language, String)] = [
        (.english, "We need to fix the fence. First, buy nails. Second, borrow a hammer."),
        (.english, "The roses bloomed early. Remember to order mulch. Can you do it yourself?"),
        (.russian, "Нужно позвать ребят. Во-первых, купить дрова. Во-вторых, собрать палатки."),
        (.uzbek, "Mijozga qo\u{02BB}ng\u{02BB}iroq qilish kerak. Birinchidan, shartnomani yuborish."),
        // 2ec8ceb: a sentence that opened a new line is laid out like any other.
        (.english, "Send the report to Anna today.\nCall the plumber about the sink tomorrow."),
        (.english, "The roses bloomed.\n\nFirst, buy nails.\nRemember to order mulch."),
        (.uzbek, "Hisobotni tayyorlash kerak.\nMijozga qo\u{02BB}ng\u{02BB}iroq qilish kerak."),
    ]

    static func note() async -> JSONValue {
        var rows: [JSONValue] = []
        for (language, text) in noteSamples {
            let session = IncrementalPolish(behaviour: .note, language: language, engine: nil)
            let outcome = await session.finish(tail: text)
            rows.append(obj(["language": str(language.rawValue), "in": str(text),
                             "out": str(outcome.text)]))
        }
        return arr(rows)
    }

    static func guardRows() -> JSONValue {
        let cases: [(Language, String, String)] = [
            (.english, "Yes, so keep only telegram.", "Keep only Telegram."),
            (.english, "Apply the price added to all students.", "Apply the price increase to all students."),
            (.english, "Okay, before I get back you need to do a few things, first, buy the seeds.",
             "First, buy the seeds."),
            (.uzbek, "Xo\u{02BB}p, ertaga soat beshda uchrashamiz.", "Erta soat beshda uchrashamiz."),
            (.uzbek, "Xo\u{02BB}p, ertaga soat beshda uchrashamiz.", "Ertaga soat beshda uchrashamiz."),
        ]
        + [
            // The reasons quote the speaker (0c5ff76): pinned whole, because the diagnostics
            // summary redacts exactly what sits between the guillemets.
            (.english, "Yes, keep only the dentist telegram today.", "Keep only telegram."),
            (.english, "Send the invoice to the client on Monday.", "Send the bill to the customer."),
            (.uzbek, "Ertaga kechqurun boraman.", "Ertaga ke\u{00E7}\u{015F}urun boraman."),
            (.uzbek, "Ertaga kechqurun uyga boraman.", "Kechqurun boraman."),
            // Arabic (C4 §14.5): spelling folded (vowel marks, alef forms), clitics stripped.
            (.arabic, "والكتاب على الطاولة", "الكتاب على الطاولة."),
            (.arabic, "يُعد الخبز بزيت الزيتون عشاءً", "يعد الخبز بزيت الزيتون عشاء."),
            (.arabic, "والله الأكل كان بارد", "الأكل كان بارد."),
            (.arabic, "أنا جبل من صخر صوان", "أنا جبل من صوان."),
            (.arabic, "استبداله في المجلس", "استبدالهم في المجلس."),
        ]
        return arr(cases.map { language, input, output in
            let reason = SentenceGuard.checkRewrite(
                output, against: input, language: language,
                prompt: OnDeviceModes.messagePrompt(language),
                mayDrop: OnDeviceModes.droppable[language] ?? [])
            return obj(["language": str(language.rawValue), "in": str(input), "rewrite": str(output),
                        "accepted": .bool(reason == nil),
                        "reason": reason.map(str) ?? .null])
        })
    }

    /// `UzbekPolishGuard.check` — the verdict and its note, which quotes the invented words.
    static func uzbekGuardRows() -> JSONValue {
        let cases: [(polished: String, original: String)] = [
            ("ertaga ke\u{00E7}\u{015F}urun boraman", "ertaga kechqurun boraman"),
            ("Ertaga kechqurun boraman.", "ertaga kechqurun boraman"),
            ("bir-ikki kitob", "birikki kitob"),
            ("alfa beta gamma delta epsilon zeta eta", "salom"),
            ("chunk\u{0131} u keldi", "chunki u keldi"),
            ("\u{00AB}gap\u{00BB} bor", "gap bor"),
        ]
        return arr(cases.map { polished, original in
            let verdict = UzbekPolishGuard.check(polished, against: original)
            return obj(["polished": str(polished), "original": str(original),
                        "accepted": .bool(verdict.isAccepted),
                        "reason": verdict.isAccepted ? .null : str(verdict.reason)])
        })
    }

    /// `SpokenText` — how a note quotes the speaker, and how the diagnostics summary redacts it.
    static func spokenText() -> JSONValue {
        let quoted = ["dentist, today", "", "salom dunyo \u{00BB} kelajak", "\u{00AB}ichki\u{00BB}",
                      "one"]
        let lines = [
            "polish deleted words the speaker said \u{00AB}dentist, today\u{00BB}",
            "no quote here at all",
            "two \u{00AB}a b c\u{00BB} and \u{00AB}d\u{00BB} end",
            "empty \u{00AB}\u{00BB} quote",
            "unterminated \u{00AB}salom dunyo",
            "a closing \u{00BB} alone",
            "commas \u{00AB}a,b,,c\u{00BB}",
            "the Uzbek engine's second answer was not usable "
                + SpokenText.quote("salom dunyo \u{00BB} kelajak") + " \u{2014} the first stands.",
        ]
        return obj([
            "quote": arr(quoted.map { obj(["in": str($0), "out": str(SpokenText.quote($0))]) }),
            "redact": arr(lines.map { obj(["in": str($0), "out": str(SpokenText.redact($0))]) }),
        ])
    }

    // MARK: - Note with a scripted model

    /// A model that answers the note classifier from a table (anything else: POINT) and every
    /// heading request with one fixed heading, and records what it was asked, in order.
    actor ScriptedNoteEngine: PromptedPolishEngine {
        nonisolated let polishID = "golden-scripted"
        nonisolated let supportedLanguages = Set(Language.allCases)
        let labels: [String: String]
        let heading: String?
        private(set) var asked: [String] = []

        init(labels: [String: String], heading: String?) {
            self.labels = labels
            self.heading = heading
        }

        nonisolated func polish(_ text: String, language: Language,
                                instructions: String) async throws -> String {
            throw PolishFailure.emptyResponse(endpoint: "golden-scripted")
        }

        nonisolated func polish(_ text: String, language: Language, prompt: PolishPrompt,
                                maxOutputTokens: Int) async throws -> String {
            try await answer(text, heading: prompt == OnDeviceModes.headingPrompt(language))
        }

        private func answer(_ text: String, heading isHeading: Bool) throws -> String {
            asked.append(text)
            if isHeading {
                guard let heading else { throw PolishFailure.emptyResponse(endpoint: "golden") }
                return heading
            }
            return labels[text] ?? "POINT"
        }
    }

    static let modelledNoteSamples: [(Language, String, [String: String], String?)] = [
        // 2ec8ceb: an Uzbek heading must pass the note's own guard.
        (.uzbek, "Ertaga rejalarimizni muhokama qilamiz. Hisobotni tayyorlash kerak. "
            + "Mijozlarga qo\u{02BB}ng\u{02BB}iroq qilish kerak.",
         ["Hisobotni tayyorlash kerak.": "TASK",
          "Mijozlarga qo\u{02BB}ng\u{02BB}iroq qilish kerak.": "TASK"], "Ertangi rejalar"),
        (.uzbek, "Ertaga rejalarimizni muhokama qilamiz. Hisobotni tayyorlash kerak. "
            + "Mijozlarga qo\u{02BB}ng\u{02BB}iroq qilish kerak.",
         ["Hisobotni tayyorlash kerak.": "TASK"], "Rejalar"),
        (.english, "We planned tomorrow. Write the report. Call the clients.",
         ["Write the report.": "TASK", "Call the clients.": "TASK"], "Tomorrow's plans"),
        // 2ec8ceb: a sentence after a line break is classified trimmed, never an empty checkbox.
        (.english, "Send the report to Anna today.\nCall the plumber about the sink tomorrow.",
         ["Send the report to Anna today.": "TASK",
          "Call the plumber about the sink tomorrow.": "TASK"], "Errands"),
        (.uzbek, "Hisobotni tayyorlash kerak.\nMijozga qo\u{02BB}ng\u{02BB}iroq qilish kerak.",
         ["Hisobotni tayyorlash kerak.": "TASK",
          "Mijozga qo\u{02BB}ng\u{02BB}iroq qilish kerak.": "POINT"], "Hisobot"),
        (.russian, "Купить дрова.\n\nСобрать палатки. Позвать ребят.",
         ["Купить дрова.": "TASK"], nil),
    ]

    static func modelledNote() async -> JSONValue {
        var rows: [JSONValue] = []
        for (language, text, labels, heading) in modelledNoteSamples {
            let engine = ScriptedNoteEngine(labels: labels, heading: heading)
            let session = IncrementalPolish(behaviour: .note, language: language, engine: engine)
            let outcome = await session.finish(tail: text, deadline: .seconds(30))
            rows.append(obj([
                "language": str(language.rawValue), "in": str(text),
                "labels": obj(labels.mapValues(str)),
                "heading": heading.map(str) ?? .null,
                "asked": arr(await engine.asked.map(str)),
                "out": str(outcome.text),
                "modelSentences": .int(outcome.modelSentences),
            ]))
        }
        return arr(rows)
    }

    // MARK: - The per-sentence prompts, as the model receives them

    /// `OnDeviceModes`, INVOKED per behaviour and language: the system text, the example turns
    /// in order, and `rendered` (what `PolishGuard` searches for an echoed line and what an
    /// engine without chat turns receives). The Windows port sends the same GGUF these exact
    /// strings, so a character that differs is a different model output on Windows.
    static func prompt(_ prompt: PolishPrompt) -> JSONValue {
        obj(["system": str(prompt.system),
             "examples": arr(prompt.examples.map { obj(["input": str($0.input), "output": str($0.output)]) }),
             "rendered": str(prompt.rendered)])
    }

    static func prompts() -> JSONValue {
        var byLanguage: [String: JSONValue] = [:]
        for language in Language.allCases {
            byLanguage[language.rawValue] = obj([
                "promptName": str(language.promptName),
                "super": prompt(OnDeviceModes.superPrompt(language)),
                "message": prompt(OnDeviceModes.messagePrompt(language)),
                "noteClassifier": prompt(OnDeviceModes.noteClassifierPrompt(language)),
                "heading": prompt(OnDeviceModes.headingPrompt(language)),
                // A set in Swift: sorted here so the fixture is byte-stable across runs.
                "droppable": arr((OnDeviceModes.droppable[language] ?? []).sorted(by: scalarOrder).map(str)),
                "superUsesModel": .bool(OnDeviceModes.superModelLanguages.contains(language)),
                // C4 §14.5: Message keeps the speaker's words (projection with `mayDrop`).
                "messageByProjection": .bool(OnDeviceModes.messageByProjection.contains(language)),
                // C4 §14.4: Super's wait after release, where capped (milliseconds), else null.
                "superTailCapMs": OnDeviceModes.superTailCap[language].map {
                    .int(Int($0.components.seconds * 1000
                             + $0.components.attoseconds / 1_000_000_000_000_000))
                } ?? .null,
            ])
        }
        return obj(byLanguage)
    }

    /// `OnDeviceModes.trimOpeners` (C4 §14.5), every language, over sentences that exercise it.
    static func openers() -> JSONValue {
        let sentences = [
            "يعني، طيب خلينا نروح بكرة.", "اسمع, الاجتماع اتأجل.", "هو يعني تعبان.",
            "بس أنا تعبان.", "طيب.", "  بصراحة الأكل كان بارد.", "طيب؟ نروح؟",
            "اسمعي، يعني، لازم نتكلم.", "يعنيكم الأمر؟", "so we left.",
        ]
        return arr(sentences.map { sentence in
            obj(["in": str(sentence),
                 "out": obj(Dictionary(uniqueKeysWithValues: Language.allCases.map {
                     ($0.rawValue, str(OnDeviceModes.trimOpeners(sentence, language: $0)))
                 }))])
        })
    }

    /// Arabic Message (C4 §14.5): the model's output projected onto the sentence, dropping only
    /// what `mayDrop` (droppable + openers) and repeats allow.
    static let arabicMessageSamples: [(model: String, input: String)] = [
        ("الأكل كان بارد، بس الخدمة حلوة.", "والله الأكل كان كان بارد شوية بس الخدمة حلوة"),
        ("ما بغيت والو. بغيت نفهم علاش جينا هنايا.", "ما بغيت والو بغيت نفهم علاش جينا هنايا"),
        ("لا يبغى بيزات ولا يبغى شي.", "هو لا يبغى بيزات ولا يبغى شي"),
        ("أنا لست ولدًا. لم أفعل شيئًا.", "اولا انا مش ولد ثانيا انا معملتش حاجة"),
        ("يعني، الاجتماع اتأجل؟", "يعني الاجتماع اتأجل"),
    ]

    static func arabicMessage() -> JSONValue {
        let mayDrop = (OnDeviceModes.droppable[.arabic] ?? [])
            .union(OnDeviceModes.openers[.arabic] ?? [])
        return arr(arabicMessageSamples.map { model, input in
            let result = PunctuationProjection.project(model, onto: input, mayDrop: mayDrop)
            return obj(["model": str(model), "in": str(input), "out": str(result.text),
                        "aligned": num(result.aligned),
                        "accepted": .bool(result.aligned >= PunctuationProjection.minimumAlignment)])
        })
    }

    static func all() async -> JSONValue {
        obj(["cleanup": cleanup(), "projection": projection(), "split": split(),
             "note": await note(), "noteModelled": await modelledNote(),
             "messageGuard": guardRows(), "uzbekGuard": uzbekGuardRows(),
             "spokenText": spokenText(), "prompts": prompts(), "openers": openers(),
             "arabicMessage": arabicMessage()])
    }
}
