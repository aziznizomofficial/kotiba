import Foundation

// What each mode asks an on-device model to do, one sentence at a time.
//
// Written for models of one to four billion parameters, which changes what a prompt must be:
//
//   * **Short, and about one sentence.** A small model handed a whole dictation drifts, answers
//     it, or truncates it — Apple's model did all three on the owner's real dictations (122
//     answers to short instructions, 53 truncations). Handed one sentence, the same failure
//     costs one sentence, and the guard falls back for that sentence alone.
//   * **Examples as real chat turns**, not prose. Measured with llama.cpp over the owner's
//     sentences, and cached once per mode and language so they cost nothing per dictation.
//   * **Examples in an unrelated domain.** With Qwen3-1.7B and Gemma 3 1B the commonest invention
//     was a phrase lifted from an example — "Okay, fix them all." came back as the example's
//     "Can you do it yourself?". The guard's echo check catches the verbatim case; keeping the
//     examples' vocabulary away from what the owner dictates makes the partial case rarer.
//
// Nothing here is derived from any other product's prompt; the wording is this project's own.

/// A system prompt plus worked examples, kept apart so an engine that can hold them as chat
/// turns — and cache them — does, and one that cannot gets them rendered into one string.
public struct PolishPrompt: Sendable, Hashable {
    public struct Example: Sendable, Hashable {
        public var input: String
        public var output: String
        public init(_ input: String, _ output: String) {
            self.input = input
            self.output = output
        }
    }

    public var system: String
    public var examples: [Example]

    public init(system: String, examples: [Example] = []) {
        self.system = system
        self.examples = examples
    }

    /// One string, for engines that take only instructions (Apple's model, a cloud endpoint).
    /// Also what `PolishGuard` searches for an echoed line.
    public var rendered: String {
        guard !examples.isEmpty else { return system }
        return system + "\n\nExamples:\n" + examples
            .map { "Input: \($0.input)\nOutput: \($0.output)" }
            .joined(separator: "\n\n")
    }
}

/// A polisher that can take a `PolishPrompt` as structured turns.
///
/// Optional: everything still works through `PolishEngine.polish(_:language:instructions:)` with
/// `prompt.rendered`. The llama.cpp engine adopts it because turns it has already seen are free —
/// the examples sit in its KV cache and only the new sentence is prefilled.
public protocol PromptedPolishEngine: PolishEngine {
    func polish(_ text: String, language: Language, prompt: PolishPrompt,
                maxOutputTokens: Int) async throws -> String

    /// Load weights and pre-fill the prompt now, so the first sentence does not pay for it.
    /// Called at key-down. Default: nothing.
    func prepare(_ prompts: [PolishPrompt]) async

    /// The same for one language's prompts: an engine made of several (`CompositePolisher`)
    /// warms only the member that will answer that language — Arabic's own modes model (C4
    /// §14.5) is not loaded for an English dictation. Default: `prepare(prompts)`.
    func prepare(_ prompts: [PolishPrompt], language: Language) async
}

extension PromptedPolishEngine {
    public func prepare(_ prompts: [PolishPrompt]) async {}
    public func prepare(_ prompts: [PolishPrompt], language: Language) async {
        await prepare(prompts)
    }
}

extension PolishEngine {
    /// Route a structured prompt to whichever surface the engine has.
    func polish(_ text: String, language: Language, prompt: PolishPrompt,
                maxOutputTokens: Int) async throws -> String {
        if let prompted = self as? any PromptedPolishEngine {
            return try await prompted.polish(text, language: language, prompt: prompt,
                                             maxOutputTokens: maxOutputTokens)
        }
        return try await polish(text, language: language, instructions: prompt.rendered)
    }
}

/// What a built-in mode does, independent of its display name.
public enum ModeBehaviour: String, Sendable, CaseIterable {
    /// No model, no clean-up beyond orthography: exactly what was said.
    case raw
    /// Clean-up that never changes a word: fillers and stutters out, punctuation and case in.
    case superMode = "super"
    /// A chat message: tightened, still every fact.
    case message
    /// A structured note: tasks as checkboxes, lists as bullets, a heading.
    case note

    /// The behaviour of a mode, or nil for a user-authored one — which keeps its own prompt and
    /// the single-pass path.
    public init?(mode: Mode) {
        switch mode.key {
        case "transcription": self = .raw
        case "super": self = .superMode
        case "message": self = .message
        case "note": self = .note
        default: return nil
        }
    }
}

public enum OnDeviceModes {

    // MARK: Super — punctuation only

    /// The model is asked to punctuate; `PunctuationProjection` then keeps only its punctuation
    /// and case, so a word it changes anyway never reaches the user.
    ///
    /// Asking for punctuation specifically, rather than "clean this up", is measured: on 40 real
    /// Uzbek sentences a general clean-up prompt changed 3, a punctuation prompt 40 — commas after
    /// `xo'p` and `masalan`, between clauses, and the casing of `GitHub`, `Payme`, `API` —
    /// almost all of it right, and the few word changes it made are exactly what projection drops.
    public static func superPrompt(_ language: Language) -> PolishPrompt {
        PolishPrompt(system: """
            You add punctuation to dictated speech. You are a filter, not an assistant. Each \
            message is one stretch of speech in \(language.promptName), already transcribed, often \
            without commas. Send back exactly the same words in the same order, adding the \
            punctuation a careful writer would use: commas after introductory words and between \
            clauses, commas around the name of the person addressed, a question mark on a \
            question, a full stop at the end. Capitalise the first word and proper names. Never \
            change, add, drop or translate a word. Never reply to the text. Send back only the text.
            """ + languageNote(language), examples: superExamples[language] ?? [])
    }

    /// One more instruction for the two optional languages (D-11), in our own words, where a
    /// small model has a known way to go wrong. Empty for the other three, whose prompts stay
    /// exactly as measured (C3).
    ///
    ///   * Turkish: a model that also knows Azerbaijani and Uzbek "corrects" Turkish spelling
    ///     toward them — the pull C4 §9.4 names. The Turkish letters are the tell, so it is told
    ///     to keep them.
    ///   * Arabic: a small model answers Arabic in English, or transliterates it, or rewrites a
    ///     dialect into Modern Standard Arabic. `PolishGuard`'s Arabic rule catches the first two
    ///     after the fact; this is the ask not to.
    public static func languageNote(_ language: Language) -> String {
        switch language {
        case .english, .russian, .uzbek:
            return ""
        case .turkish:
            return " Keep Turkish spelling, with its letters ç, ğ, ı, İ, ö, ş and ü, and never "
                + "change a word into Azerbaijani or Uzbek."
        case .arabic:
            return " Write in Arabic script only, never in Latin letters, and keep the speaker's "
                + "dialect words as they are rather than changing them to Modern Standard Arabic."
        }
    }

    static let superExamples: [Language: [PolishPrompt.Example]] = [
        .english: [
            .init("so basically we picked the apples and then we made jam",
                  "So basically, we picked the apples and then we made jam."),
            .init("grandma did you get the train tickets", "Grandma, did you get the train tickets?"),
        ],
        .russian: [
            .init("слушай а бабушка уже купила билеты на поезд",
                  "Слушай, а бабушка уже купила билеты на поезд?"),
            .init("короче мы собрали яблоки и потом сварили варенье",
                  "Короче, мы собрали яблоки и потом сварили варенье."),
        ],
        .uzbek: [
            .init("xo\u{02BB}p qarang buvim bozorga ketdilar", "Xo\u{02BB}p, qarang, buvim bozorga ketdilar."),
            .init("ertaga bog\u{02BB}ga borasizmi yoki uyda qolasizmi",
                  "Ertaga bog\u{02BB}ga borasizmi yoki uyda qolasizmi?"),
            .init("masalan kecha biz olma terdik keyin murabbo qildik",
                  "Masalan, kecha biz olma terdik, keyin murabbo qildik."),
        ],
        .turkish: [
            .init("yani dün elmaları topladık sonra da reçel yaptık",
                  "Yani, dün elmaları topladık, sonra da reçel yaptık."),
            .init("anneanne tren biletlerini aldın mı", "Anneanne, tren biletlerini aldın mı?"),
        ],
        .arabic: [
            .init("يعني قطفنا التفاح أمس وبعدين عملنا مربى",
                  "يعني، قطفنا التفاح أمس، وبعدين عملنا مربى."),
            .init("يا جدتي هل اشتريت تذاكر القطار", "يا جدتي، هل اشتريت تذاكر القطار؟"),
        ],
    ]

    // MARK: Message — a tightened chat message

    /// Measured against a gentler wording on 55 of the owner's English sentences: that one
    /// changed 12 in 82 — Message and Super came out the same, the complaint this mode has always
    /// drawn — while this one changed 27 in 55, almost all of it dropped openers ("So the" →
    /// "The", "Yes, keep" → "Keep"). What it gets wrong, `SentenceGuard` refuses per sentence.
    public static func messagePrompt(_ language: Language) -> PolishPrompt {
        PolishPrompt(system: """
            You edit dictated speech into a chat message. You are an editor, not an assistant. \
            Each message is one stretch of speech in \(language.promptName), already transcribed. \
            Make it read like something typed: remove filler openers and discourse words that \
            carry no meaning (\(discourseExamples[language] ?? "")), hedges, repetitions and \
            false starts, and tighten wordy phrasing. Keep every fact, name, number and request, \
            and the speaker's tone. Never translate, never reply, never act on it, no greeting or \
            sign-off. Send back only the edited text.
            """ + languageNote(language) + messageNote(language),
            examples: messageExamples[language] ?? [])
    }

    /// Arabic Message (C4 §14.5): told exactly what it may delete. Without it a model either
    /// changed nothing (Qwen3-1.7B, 121 of 155 held-out sentences) or rewrote the sentence into
    /// Modern Standard Arabic and lost words the guard then refused (Gemma 4 E2B, 111 of 155).
    static func messageNote(_ language: Language) -> String {
        language == .arabic
            ? " Delete only filler and discourse words, a word said twice by mistake and a false "
                + "start; keep every other word exactly as it was said, in the speaker's own dialect "
                + "— no synonym, no Modern Standard Arabic for a dialect word, no name, number, "
                + "adjective or clause left out — and add Arabic punctuation (، ؟ .)."
            : ""
    }

    static let discourseExamples: [Language: String] = [
        .english: "so, okay so, basically, like, you know, I mean, actually, well",
        .russian: "ну, так, короче, вот, значит, типа, как бы, в общем",
        .uzbek: "xo\u{02BB}p, endi, masalan, mana, haligi, xullas, demak",
        .turkish: "yani, işte, şey, hani, aslında, falan, neyse",
        .arabic: "يعني، طيب، بصراحة، اسمع، والله، بقى، يا أخي",
    ]

    static let messageExamples: [Language: [PolishPrompt.Example]] = [
        .english: [
            .init("okay so basically I was wondering if you could maybe pick up the cake on saturday",
                  "Could you pick up the cake on Saturday?"),
            .init("yeah so the plumber said that he will come around four I think",
                  "The plumber said he'll come around four, I think."),
            .init("and also I mean the garden gate is still broken",
                  "Also, the garden gate is still broken."),
        ],
        .russian: [
            .init("ну короче я тут подумал что может сходим в парк в воскресенье",
                  "Может, сходим в парк в воскресенье?"),
            .init("так вот значит калитка в саду всё ещё сломана", "Калитка в саду всё ещё сломана."),
        ],
        .uzbek: [
            .init("xo\u{02BB}p endi men o\u{02BB}ylab ko\u{02BB}rdim ertaga bog\u{02BB}ga borsak bo\u{02BB}ladi",
                  "Ertaga bog\u{02BB}ga borsak bo\u{02BB}ladi."),
            .init("masalan bog\u{02BB}dagi eshik hali ham buzuq", "Bog\u{02BB}dagi eshik hali ham buzuq."),
        ],
        .turkish: [
            .init("yani şey diyecektim pazar günü parka gidebilir miyiz acaba",
                  "Pazar günü parka gidebilir miyiz?"),
            .init("işte bahçenin kapısı hâlâ kırık", "Bahçenin kapısı hâlâ kırık."),
        ],
        .arabic: [
            .init("طيب يعني كنت بفكر ممكن نروح الحديقة يوم الأحد",
                  "ممكن نروح الحديقة يوم الأحد؟"),
            .init("اسمع يعني باب الحديقة لسه مكسور", "باب الحديقة لسه مكسور."),
            .init("والله الأكل كان كان بارد شوية بس الخدمة حلوة",
                  "الأكل كان بارد شوية، بس الخدمة حلوة."),
        ],
    ]

    /// Languages whose Message keeps every word the speaker said but fillers, openers and
    /// repeats: the model's output is projected onto the sentence (`PunctuationProjection`
    /// with `mayDrop`) instead of passing `SentenceGuard`.
    ///
    /// Arabic (C4 §14.5): asked to rewrite, Qwen3-1.7B changed 34 of 155 held-out sentences and
    /// 21 of those lost or swapped a content word (`صخر`, `عادل`, `استبداله` → `استبدالهم`);
    /// Gemma 4 E2B rewrote dialect into Modern Standard Arabic and lost words in 111. What both
    /// did well is punctuate and take out fillers — so that, and only that, is kept.
    public static let messageByProjection: Set<Language> = [.arabic]

    /// Discourse openers a sentence may lose in Message without losing meaning, removed only at
    /// the start of a sentence (with the comma after them), repeatedly: `يعني، طيب خلينا نروح`
    /// → `خلينا نروح`. Only words that are never the content of a sentence when they open it:
    /// "I mean", "okay", "honestly", "listen". `بس` ("but"/"only"), `والله` (an oath the
    /// speaker may mean), `شوف` ("look" — or "watch the film") and `خلاص` ("done") stay.
    public static let openers: [Language: Set<String>] = [
        .arabic: ["يعني", "طيب", "بصراحة", "اسمع", "اسمعي", "اسمعوا"],
    ]

    /// `sentence` without its leading discourse openers (`openers`). Nothing else changes; a
    /// sentence that is nothing but openers is returned as it was.
    public static func trimOpeners(_ sentence: String, language: Language) -> String {
        guard let words = openers[language], !words.isEmpty else { return sentence }
        let leading = sentence.prefix(while: { $0.isWhitespace })
        var rest = Substring(sentence.dropFirst(leading.count))
        var trimmed = false
        while true {
            let word = rest.prefix(while: { $0.isLetter })
            guard !word.isEmpty, words.contains(String(word)) else { break }
            var after = rest.dropFirst(word.count)
            // The opener's own comma, Arabic or Latin, and the space after it.
            if let mark = after.first, mark == "\u{060C}" || mark == "," { after = after.dropFirst() }
            let next = after.drop(while: { $0.isWhitespace })
            // An opener is only an opener with a sentence after it.
            guard let first = next.first, first.isLetter else { break }
            rest = next
            trimmed = true
        }
        return trimmed ? String(leading) + String(rest) : sentence
    }

    /// Words Message may delete without deleting meaning. Anything else the speaker said must
    /// still be in the rewrite — as itself or an inflection of it — or the sentence is kept as
    /// spoken. Measured: without this, one Uzbek rewrite kept only "Birinchisi," of "xo'p, qara,
    /// kelgunimcha bir nechta ish qilishing kerak birinchisi," and passed every other check.
    public static let droppable: [Language: Set<String>] = [
        .english: ["so", "okay", "ok", "basically", "like", "actually", "well", "yeah", "yes",
                   "oh", "oops", "just", "really", "literally", "kind", "sort", "mean", "know",
                   "anyway", "anyways", "right", "also", "then", "now", "maybe", "probably",
                   "perhaps", "honestly", "guess", "fact", "course", "hey", "alright",
                   "you", "i", "um", "uh", "and", "but", "the", "that", "this"],
        .russian: ["ну", "так", "короче", "вот", "значит", "типа", "как", "бы", "это", "общем",
                   "ладно", "слушай", "смотри", "просто", "вообще", "кстати", "собственно",
                   "чё", "че", "ага", "ой", "да", "итак", "ведь", "же", "тут", "там", "например",
                   "и", "а", "но", "что", "то", "я"],
        .uzbek: ["xo\u{02BB}p", "xop", "endi", "masalan", "mana", "haligi", "anu", "qara",
                 "qarang", "yani", "ya\u{02BB}ni", "xullas", "hullas", "demak", "aslida",
                 "umuman", "tak", "ha", "e", "ee", "voy", "bilasanmi", "bilasizmi", "va",
                 "keyin", "lekin", "shu", "bu"],
        .turkish: ["yani", "işte", "şey", "hani", "aslında", "falan", "neyse", "acaba", "tamam",
                   "evet", "peki", "ee", "ya", "bak", "bakın", "ve", "ama", "de", "da", "bu",
                   "şu", "sonra", "ben", "diyecektim"],
        .arabic: ["يعني", "طيب", "بصراحة", "اسمع", "خلاص", "يا", "أخي", "اخي", "بس", "آه", "اه",
                  "و", "ثم", "بعدين", "هذا", "هذه", "كنت", "بفكر", "أنا", "انا", "إنه", "انه",
                  // Dialect discourse words (C4 §14.5): the oath used as emphasis, Egyptian
                  // and Levantine "so/then", "also" opening a sentence, "actually", Gulf "so".
                  "والله", "بقى", "بقا", "كما", "أصلا", "أصلاً", "اصلا", "عاد", "ترى", "يعنى"],
    ]

    // MARK: Note — one label per sentence

    /// A one-word answer: what kind of line this sentence becomes. The formatting itself is done
    /// by `NoteLayout`, so the model has nowhere to put an invented word.
    public static func noteClassifierPrompt(_ language: Language) -> PolishPrompt {
        PolishPrompt(system: """
            You sort sentences from a dictated note in \(language.promptName). Reply with exactly \
            one word. TASK if the sentence says something must, should or will be done — an \
            instruction, a to-do, a request. POINT for anything else: a fact, an observation, a \
            question, context. Never reply to the sentence itself.
            """ + noteLanguageNote(language), examples: noteExamples[language] ?? [])
    }

    /// Arabic (C4 §14.5): Qwen3-1.7B labelled 38 of 108 FLEURS sentences — news and
    /// encyclopaedia facts in the past tense, "a bomb went off outside the office" — TASK, while
    /// it labelled the short composed points right. Told what a report of events is, with one
    /// as an example.
    static func noteLanguageNote(_ language: Language) -> String {
        language == .arabic
            ? " A sentence that reports what happened, or describes how something is, is POINT "
                + "however long it is; TASK needs someone to do something."
            : ""
    }

    static let noteExamples: [Language: [PolishPrompt.Example]] = [
        .english: [
            .init("Remember to book the vet for the dog.", "TASK"),
            .init("The roses on the fence are blooming early this year.", "POINT"),
            .init("Can you pick up flour on the way home?", "TASK"),
        ],
        .russian: [
            .init("Нужно записать собаку к ветеринару.", "TASK"),
            .init("Розы у забора в этом году зацвели рано.", "POINT"),
        ],
        .uzbek: [
            .init("Itni veterinarga yozdirish kerak.", "TASK"),
            .init("Bu yil devor yonidagi atirgullar erta gulladi.", "POINT"),
        ],
        .turkish: [
            .init("Köpeği veterinere götürmeyi unutma.", "TASK"),
            .init("Bu yıl çitteki güller erken açtı.", "POINT"),
        ],
        .arabic: [
            .init("لازم نحجز موعد للكلب عند الطبيب البيطري.", "TASK"),
            .init("الورود عند السور تفتحت بدري هذه السنة.", "POINT"),
            .init("افتتحت البلدية حديقة جديدة قرب النهر بعد سنتين من العمل.", "POINT"),
            .init("اشترِ سماداً للورد في طريقك إلى البيت.", "TASK"),
        ],
    ]

    /// A few words naming what the note is about, built from the speaker's own words — the guard
    /// rejects a heading containing any word the note does not.
    public static func headingPrompt(_ language: Language) -> PolishPrompt {
        PolishPrompt(system: """
            You name dictated notes. Each message is a note in \(language.promptName). Reply with \
            a title of two to five words taken from the note's own words, in the same language. \
            No quotes, no full stop, nothing else.
            """ + languageNote(language), examples: headingExamples[language] ?? [])
    }

    static let headingExamples: [Language: [PolishPrompt.Example]] = [
        .english: [.init("Remember to book the vet for the dog. The roses are blooming early.",
                         "Vet and roses")],
        .russian: [.init("Нужно записать собаку к ветеринару. Розы зацвели рано.",
                         "Ветеринар и розы")],
        .uzbek: [.init("Itni veterinarga yozdirish kerak. Atirgullar erta gulladi.",
                       "Veterinar va atirgullar")],
        .turkish: [.init("Köpeği veterinere götürmeyi unutma. Güller erken açtı.",
                         "Veteriner ve güller")],
        .arabic: [.init("لازم نحجز موعد للكلب عند الطبيب البيطري. الورود تفتحت بدري.",
                        "الطبيب البيطري والورود")],
    ]
}
