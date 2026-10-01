import Foundation

// The deterministic half of every mode. Costs well under a millisecond, runs on every dictation
// that is not Raw, and cannot invent a word — the only operations are delete, re-punctuate and
// re-case. Measured on the 1,094 distinct English dictations in the owner's diagnostics, this is
// most of what a language model was being paid 1.6 s to do:
//
//   * 139 filler tokens ("Um,", "Uh,") across the set;
//   * 69 dictations with a full stop the transcriber placed at a pause mid-sentence — Apple's
//     SpeechTranscriber writes `you don't. Cross. a point`, and the lowercase letter after the
//     stop is its own admission that no sentence ended there;
//   * a capital on a common word after a comma or a filler (`I wanna, Have 3`, `So, Yeah`);
//   * 16 stuttered doubles (`and and`).
//
// And the model mostly did not fix them. Qwen3-1.7B under the preserve prompt returned 78 of 81
// English sentences unchanged once these rules had run; Apple's model, handed the same sentences,
// answered 4 of them and refused 1 (docs/research/C3-on-device-modes.md §3).
//
// Everything here is per-language on purpose. Uzbek ASR output is entirely lowercase, so the
// false-stop rule — "a stop followed by a lowercase word is not a sentence end" — would delete
// every sentence boundary in every Uzbek dictation. Uzbek also reduplicates words grammatically
// (`tez tez`, `sekin sekin`), so the stutter rule there only touches pronouns and particles.
//
// Turkish and Arabic (D-11) follow the Uzbek pattern, for the same reasons: both reduplicate as
// grammar (`yavaş yavaş`, `شوي شوي`), so only function words collapse; neither gets the English
// transcriber-artefact rules. Arabic has its own marks — `،` `؛` `؟` — which are punctuation
// everywhere punctuation is reasoned about here, and a closing question takes `؟`, not `?`.
// Turkish has its own casing: every comparison below lowercases through `Language.lowercased`,
// because the locale-free `lowercased()` turns `İ` into `i` + a combining dot.

public struct DictationCleanup: Sendable {

    public let language: Language

    /// Whether to close an unterminated last sentence with `.` or `?`. The pipeline turns it off
    /// for a segment that is not yet the end of the dictation.
    public var closesFinalSentence: Bool

    public init(language: Language, closesFinalSentence: Bool = true) {
        self.language = language
        self.closesFinalSentence = closesFinalSentence
    }

    /// What ends a sentence, in every language: `.` `!` `?` `…` and the Arabic `؟`.
    static let stops: Set<Character> = [".", "!", "?", "…", "\u{061F}"]

    /// A token's word, lowercased the way this language lowercases.
    func lower(_ token: Token) -> String { language.lowercased(token.core) }

    public func apply(_ text: String) -> String {
        var out = Self.collapseSpaces(text)
        out = applySpokenPunctuation(out)
        var tokens = Token.split(out)
        tokens = removeFillers(tokens)
        tokens = collapseStutters(tokens)
        if language == .english {
            tokens = repairFalseStops(tokens)
            tokens = lowercaseStrayCapitals(tokens)
        }
        out = Token.join(tokens)
        out = Self.fixSpacing(out)
        if closesFinalSentence { out = closeFinalSentence(out) }
        return out
    }

    // MARK: Tokens

    /// A whitespace-delimited chunk, split into what surrounds the word and the word itself.
    ///
    /// `core` keeps internal punctuation — `don't`, `o'zbek`, `3.5`, `e.g` — because the rules
    /// below reason about the word, and the edges are what they move around.
    struct Token: Equatable {
        var leading: String
        var core: String
        var trailing: String
        /// A line break that preceded this token, kept verbatim so "new line" survives.
        var breakBefore: String

        static let edgePunctuation: Set<Character> = [
            ",", ".", "!", "?", ";", ":", "…", "\"", "'", "(", ")", "[", "]", "«", "»",
            "\u{201C}", "\u{201D}", "\u{2018}", "\u{2019}", "-", "\u{2014}", "\u{2013}",
            // Arabic comma, semicolon and question mark.
            "\u{060C}", "\u{061B}", "\u{061F}",
        ]

        var lower: String { core.lowercased() }
        var endsSentence: Bool { trailing.contains(where: { DictationCleanup.stops.contains($0) }) }

        static func split(_ text: String) -> [Token] {
            var tokens: [Token] = []
            var pendingBreak = ""
            var current = ""
            func flush() {
                guard !current.isEmpty else { return }
                tokens.append(make(current, breakBefore: pendingBreak))
                pendingBreak = ""
                current = ""
            }
            for ch in text {
                if ch == "\n" {
                    flush()
                    pendingBreak.append(ch)
                } else if ch == " " || ch == "\t" {
                    flush()
                } else {
                    current.append(ch)
                }
            }
            flush()
            return tokens
        }

        static func make(_ chunk: String, breakBefore: String) -> Token {
            let chars = Array(chunk)
            var start = 0
            var end = chars.count
            // An okina or apostrophe leading a word is part of it only in the middle; at the
            // edges it is a quote. `'salom'` → quote, salom, quote.
            while start < end, edgePunctuation.contains(chars[start]) { start += 1 }
            while end > start, edgePunctuation.contains(chars[end - 1]) { end -= 1 }
            return Token(leading: String(chars[0..<start]),
                         core: String(chars[start..<end]),
                         trailing: String(chars[end..<chars.count]),
                         breakBefore: breakBefore)
        }

        static func join(_ tokens: [Token]) -> String {
            var out = ""
            for (i, t) in tokens.enumerated() {
                if !t.breakBefore.isEmpty {
                    while out.hasSuffix(" ") { out.removeLast() }
                    out += t.breakBefore
                } else if i > 0 {
                    out += " "
                }
                out += t.leading + t.core + t.trailing
            }
            return out
        }
    }

    // MARK: Fillers

    /// Sounds that carry nothing, per language. Words that are sometimes filler and sometimes
    /// meaning — `like`, `so`, `ну`, `как бы`, `haligi` — are deliberately absent: deleting one
    /// that meant something is worse than keeping one that did not, and that call is what the
    /// Message mode's model is for.
    static let fillers: [Language: Set<String>] = [
        .english: ["um", "umm", "ummm", "uh", "uhh", "uhhh", "uhm", "erm", "hmm", "hmmm", "mm",
                   "mmm", "mhm"],
        .russian: ["э", "ээ", "эээ", "эм", "эмм", "ммм", "мм", "хм", "хмм", "а-а", "э-э", "э-э-э",
                   "um", "uh"],
        .uzbek: ["ee", "eee", "e-e", "mmm", "mm", "hmm", "hmmm", "um", "uh", "эээ", "ээ"],
        // `şey` and `yani` are fillers only sometimes — `bir şey` is "something", `yani` often
        // carries "that is" — so they stay, by the rule above.
        .turkish: ["ıı", "ııı", "ıh", "ee", "eee", "eh", "hmm", "hmmm", "mm", "mmm", "um", "uh"],
        // `إيه` is Egyptian "what" as often as it is a hesitation, so it stays.
        .arabic: ["امم", "اممم", "ممم", "مم", "أمم", "إمم", "اه", "آه", "um", "uh"],
    ]

    /// A bare `e` / `э` is a hesitation only when commas fence it off or it opens the text before
    /// a comma: `grammatik, e, talaffuzda` (measured, real Uzbek). Standing between two words it
    /// may be the vocative `e, qara` — which also has a comma, and is also a filler-like
    /// interjection, so the rule costs nothing there either.
    static let fencedFillers: Set<String> = ["e", "э", "a", "er"]

    /// A single letter beside another single letter, or before `and`/`or`, is an item of a list
    /// being read out — `A, B and C`, `x, a, and b` — not a hesitation. Deleting it deleted an
    /// option the speaker named.
    static func isListItem(at index: Int, in tokens: [Token]) -> Bool {
        guard tokens[index].core.count == 1 else { return false }
        func isLetter(_ i: Int) -> Bool {
            tokens.indices.contains(i) && tokens[i].core.count == 1
                && tokens[i].core.first?.isLetter == true
        }
        let next = tokens.indices.contains(index + 1) ? tokens[index + 1].lower : ""
        return isLetter(index - 1) || isLetter(index + 1) || listJoiners.contains(next)
    }

    static let listJoiners: Set<String> = ["and", "or", "va", "yoki", "и", "или", "ve", "veya",
                                          "yahut", "أو"]

    func removeFillers(_ tokens: [Token]) -> [Token] {
        let plain = Self.fillers[language] ?? []
        var input = tokens
        var out: [Token] = []
        for i in input.indices {
            let token = input[i]
            let lower = self.lower(token)
            let fenced = Self.fencedFillers.contains(lower)
                && token.trailing.hasPrefix(",")
                && (out.last.map { $0.trailing.hasSuffix(",") || $0.endsSentence } ?? true)
                && !Self.isListItem(at: i, in: input)
            guard !token.core.isEmpty, token.leading.isEmpty, plain.contains(lower) || fenced else {
                out.append(token)
                continue
            }
            // The filler goes; what to do with the punctuation around it.
            //
            //   "how is, uh, the logic"  → both commas existed only for the filler: drop both.
            //   "give me. Um, captions"  → the stop belongs to the sentence before: kept.
            //   "and then, um. The next" → the filler carried the sentence end: move it back.
            //   "Так, э, нужно"          → the first comma follows an opening word: it stays.
            let carriesEnd = token.endsSentence
            let opensSentence = out.last.map { $0.endsSentence } ?? true
            if var previous = out.popLast() {
                let previousOpens = out.last.map { $0.endsSentence } ?? true
                if carriesEnd, !previous.endsSentence {
                    previous.trailing = previous.trailing.replacingOccurrences(of: ",", with: "")
                        + token.trailing.filter { ".!?…".contains($0) }
                } else if previous.trailing == ",", !carriesEnd, !previousOpens,
                          i + 1 < input.count {
                    previous.trailing = ""
                }
                out.append(previous)
            }
            // A filler that opened a sentence carried its capital; the word after it inherits
            // it, or the false-stop rule below would read "me. the" as a pause.
            if opensSentence, token.core.first?.isUppercase == true, i + 1 < input.count,
               let first = input[i + 1].core.first, first.isLowercase {
                input[i + 1].core = first.uppercased() + input[i + 1].core.dropFirst()
            }
            // A line break the filler sat after must not vanish with it.
            if !token.breakBefore.isEmpty, i + 1 < input.count, input[i + 1].breakBefore.isEmpty {
                input[i + 1].breakBefore = token.breakBefore
            }
        }
        return out
    }

    // MARK: Stutters

    /// The only English and Russian words a double of which is collapsed as a stutter: articles,
    /// pronouns, conjunctions, the prepositions that are never also a verb's particle, and a few
    /// modals. A stutter is a restart on a short function word — every double in the owner's
    /// diagnostics that was one (`and and`, `the the`, `with with`, `they they`, `this this`) is
    /// on this list. The list used to run the other way — collapse any double except a list of
    /// known real ones — and that deleted words from every shape nobody had listed yet:
    /// reduplicated names (`Bora Bora`, `Walla Walla`, `Baden-Baden` said as two words), baby
    /// talk and onomatopoeia (`choo choo`, `bye bye`), contrastive reduplication (`a salad salad,
    /// not a fruit salad`), Russian emphasis (`белый белый снег`, `тихо тихо`) and — five of the
    /// seven `in in` in the owner's diagnostics — a phrasal verb meeting its own preposition:
    /// `sign in in the morning`, `hand it in in time`. That is why `in`, `on`, `up`, `out`, `off`,
    /// `over`, `down`, `by`, `about` and friends are absent; `is`, `was`, `had`, `that`, `do`,
    /// `can`, `will` and `her` are absent for `what it is is`, `had had`, `can-can`, `Will will`
    /// and `gave her her keys`. A stutter left in costs a word of noise; a real word deleted
    /// changes what the speaker said.
    static let stutterable: [Language: Set<String>] = [
        .english: [
            "the", "a", "an", "and", "or", "but", "nor", "if", "as", "than", "because", "although",
            "i", "me", "my", "you", "your", "he", "him", "his", "she", "it", "its", "we",
            "us", "our", "they", "them", "their", "this", "these", "those", "who", "which", "what",
            "where", "when", "why", "how", "other", "another", "to", "of", "for", "with", "from",
            "at", "into", "onto",
            "would", "could", "should", "might", "must", "shall",
            "i'm", "i've", "i'll", "i'd", "you're", "we're", "they're", "it's", "that's",
            "there's", "he's", "she's", "don't", "didn't", "doesn't",
        ],
        .russian: [
            "я", "ты", "он", "она", "оно", "мы", "вы", "они", "меня", "мне", "мной", "тебя", "тебе",
            "тобой", "его", "него", "её", "ее", "неё", "нее", "ему", "нему", "ей", "ней", "им",
            "ним", "их", "них", "нас", "нам", "вас", "вам", "мой", "моя", "моё", "мое", "мои",
            "твой", "твоя", "твои", "наш", "наша", "наше", "наши", "ваш", "ваша", "ваше", "ваши",
            "этот", "эта", "это", "эти", "этого", "этой", "этом", "и", "а", "но", "или", "в", "во",
            "на", "с", "со", "к", "ко", "по", "от", "из", "за", "для", "до", "про", "без", "при",
            "над", "под", "через", "же", "бы", "ли", "если", "чтобы", "потому", "который",
            "которая", "которое", "которые",
        ],
        .uzbek: [],
        // Turkish reduplicates adjectives and adverbs as grammar (`yavaş yavaş`, `güzel güzel`,
        // `ara ara`), so, as for Uzbek, only pronouns, conjunctions and postpositions.
        .turkish: [
            "ben", "sen", "biz", "siz", "onlar", "bu", "şu", "bunu", "şunu", "onu", "benim",
            "senin", "bizim", "sizin", "onun", "ve", "ama", "fakat", "ile", "için", "gibi",
            "ki", "eğer", "çünkü", "veya", "yani",
        ],
        // Arabic writes `و` and `ف` as prefixes, so the separate function words are few; its
        // reduplication (`شوي شوي`, `واحد واحد`) is grammar and stays.
        .arabic: [
            "في", "على", "إلى", "الى", "عن", "هذا", "هذه", "ذلك", "تلك", "أنا", "انا", "أنت",
            "انت", "هو", "هي", "نحن", "هم", "أن", "إن", "ان", "لكن", "أو", "ثم", "التي",
            "الذي",
        ],
    ]

    /// Uzbek reduplicates adjectives, adverbs and verbs as grammar (`tez tez`, `asta asta`,
    /// `katta katta`), so only these — pronouns, particles, conjunctions — are treated as stutters.
    static let uzbekStutterable: Set<String> = [
        "men", "sen", "u", "biz", "siz", "ular", "bu", "shu", "o\u{02BB}sha", "va", "lekin",
        "keyin", "endi", "ham", "bilan", "uchun", "agar", "chunki", "yani", "ya\u{02BB}ni",
        "manga", "menga", "senga", "unga", "bizga", "sizga", "mening", "sening", "uning",
        "the", "and", "a", "i",
    ]

    func collapseStutters(_ tokens: [Token]) -> [Token] {
        var out: [Token] = []
        for token in tokens {
            if let previous = out.last,
               previous.trailing.isEmpty, token.leading.isEmpty, token.breakBefore.isEmpty,
               !previous.core.isEmpty,
               lower(previous) == lower(token),
               isStutterable(lower(token))
                || (opensClause(out) && Self.clauseOpeningStutterable[language]?
                        .contains(lower(token)) == true),
               !isNamePair(previous, token, opensSentence: out.count == 1
                               || out[out.count - 2].endsSentence
                               || !previous.breakBefore.isEmpty) {
                // Keep the first one's case (it may open the sentence) and the second one's
                // trailing punctuation (it may close it).
                var merged = previous
                merged.trailing = token.trailing
                out[out.count - 1] = merged
                continue
            }
            out.append(token)
        }
        return out
    }

    /// A particle doubled where no verb comes before it — `Also, in in the garden`, a dictation
    /// or a clause opening `on on Monday` — cannot be a phrasal verb meeting its preposition, so
    /// there it is a stutter after all.
    static let clauseOpeningStutterable: [Language: Set<String>] = [
        .english: ["in", "on", "up", "out", "off", "over", "down", "by", "about", "through",
                   "around"],
    ]

    /// Whether the last token of `out` (the first of a pair) opens the text, a line or a clause.
    func opensClause(_ out: [Token]) -> Bool {
        out.count == 1 || !out[out.count - 1].breakBefore.isEmpty
            || !out[out.count - 2].trailing.isEmpty
    }

    /// `Bora Bora`, `Baden Baden`: both capitalised with neither opening the sentence is a name,
    /// not a stutter. `I I` is the exception — its capital says nothing.
    func isNamePair(_ first: Token, _ second: Token, opensSentence: Bool) -> Bool {
        !opensSentence && first.lower != "i"
            && first.core.first?.isUppercase == true && second.core.first?.isUppercase == true
    }

    func isStutterable(_ word: String) -> Bool {
        switch language {
        case .uzbek:
            return Self.uzbekStutterable.contains(UzbekPolishGuard.foldApostrophes(word))
        case .english, .russian, .turkish, .arabic:
            return (Self.stutterable[language] ?? []).contains(word)
        }
    }

    // MARK: English transcriber artefacts

    /// `you don't. Cross. a point` → `you don't. Cross a point`.
    ///
    /// The transcriber puts a stop at a pause and then, knowing better, lowercases the next word.
    /// A stop followed by a lowercase word is therefore removed — unless the word before it is an
    /// abbreviation (`e.g.`, `a.m.`, `etc.`), a single letter, or a number.
    func repairFalseStops(_ tokens: [Token]) -> [Token] {
        var out = tokens
        guard out.count > 1 else { return out }
        for i in 0..<(out.count - 1) {
            let next = out[i + 1]
            guard out[i].trailing == ".", next.leading.isEmpty, next.breakBefore.isEmpty,
                  let first = next.core.first, first.isLetter, first.isLowercase else { continue }
            let word = out[i].lower
            guard word.count > 1, !word.contains("."), word.allSatisfy(\.isLetter) || word.contains("'"),
                  !Self.abbreviations.contains(word) else { continue }
            out[i].trailing = ""
        }
        return out
    }

    static let abbreviations: Set<String> = [
        "etc", "vs", "mr", "mrs", "ms", "dr", "st", "jr", "sr", "inc", "ltd", "co", "no", "approx",
    ]

    /// `I wanna, Have 3` → `I wanna, have 3`; `I will Consider` → `I will consider`.
    ///
    /// Only for words on a list of common lowercase English words that are not also names people
    /// dictate — `Will`, `May`, `Mark`, `Notes`, `Mail` and `Code` are deliberately absent — and
    /// never at a sentence start. Nor inside a name: a common word with a capitalised word on
    /// each side (`The New Line opened`, `Lord Of The Rings`) is part of a title, and `New`
    /// before one is how place and company names open (`New York`, `New Line Cinema`). One
    /// capitalised neighbour is not enough — in the owner's diagnostics this transcriber put a
    /// stray capital before a name ten times (`and Then Maria`, `every Finished draft`) and
    /// wrote a name that opens with a common word no times, so that is still lowercased.
    func lowercaseStrayCapitals(_ tokens: [Token]) -> [Token] {
        var out = tokens
        for i in out.indices {
            let token = out[i]
            let atStart = i == 0 || out[i - 1].endsSentence || !token.breakBefore.isEmpty
            if token.lower == "i" || token.lower.hasPrefix("i'") {
                out[i].core = "I" + token.core.dropFirst()
                continue
            }
            // A capital standing alone is a name — `Plan B`, `Section A`, `vitamin A` — and
            // `a` being a common word made the first of those `Section a`.
            guard !atStart, token.leading.isEmpty, token.core.count > 1,
                  let first = token.core.first, first.isUppercase,
                  token.core.dropFirst().allSatisfy({ $0.isLowercase || $0 == "'" }),
                  Self.commonLowercase.contains(token.lower) else { continue }
            // Neighbours read from the input, so the answer does not depend on the direction of
            // the loop. Punctuation between two words ends a name (`So, Yeah`); a sentence
            // opener counts — the `The` of `The New Line` is part of it.
            let joinsNext = i + 1 < tokens.count && token.trailing.isEmpty
                && tokens[i + 1].leading.isEmpty && tokens[i + 1].breakBefore.isEmpty
                && Self.isTitleCased(tokens[i + 1])
            let joinsPrevious = i > 0 && tokens[i - 1].trailing.isEmpty
                && Self.isTitleCased(tokens[i - 1])
            if joinsNext, joinsPrevious || token.lower == "new" { continue }
            out[i].core = token.lower
        }
        return out
    }

    /// `Line`, `York`, `McDonald` — a capital and then at least one lowercase letter. Not `I`,
    /// `I'm`, a lone `A`, or an all-caps `API`, none of which says the writer meant a name.
    static func isTitleCased(_ token: Token) -> Bool {
        guard let first = token.core.first, first.isUppercase, token.core.count > 1,
              !(token.lower == "i" || token.lower.hasPrefix("i'")) else { return false }
        return token.core.dropFirst().contains(where: \.isLowercase)
    }

    /// Frequent English words that are practically never a proper noun when dictated.
    static let commonLowercase: Set<String> = Set("""
        a about above after again against all almost also always am an and another any anyone \
        anything are around as ask at away back be because been before being below between both \
        but by can can't come could couldn't create did didn't do does doesn't doing don't done \
        down during each either else enough even ever every everything few find first fix for \
        from full fully get give go going gonna got had has have having he her here hers him his \
        how however if in into is isn't it it's its just keep know last later less let let's like \
        little look lot made make many maybe me might mine more most much must my need never new \
        next no nor not nothing now of off often on once one only or other our ours out over own \
        please put quite rather really right run said same say see seem send set she should \
        shouldn't show since so some something still such sure take than that that's the their \
        them then there these they thing things think this those though through to together too \
        try turn under until up upon us use very want wanna was wasn't way we well were weren't \
        what when where whether which while who whom whose why with within without won't would \
        wouldn't yeah yes yet you your yours consider check change move open close add remove \
        start stop build make sure also actually basically just because okay ok instead each \
        both whole every everyone someone somebody nobody anybody tell told write read made \
        want wanted wants need needed needs have has had let lets makes making go goes went gone
        """.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init))

    // MARK: Spoken punctuation

    /// Only commands that cannot be ordinary speech. `period` is a word (`the trial period`), and
    /// so is Russian `точка` (`в одной точке А`, measured in the owner's own dictation), so
    /// neither is here; `full stop` and `точка с запятой` are.
    static let spokenPunctuation: [Language: [(phrase: String, replacement: String)]] = [
        .english: [("new paragraph", "\n\n"), ("new line", "\n"), ("question mark", "?"),
                   ("exclamation mark", "!"), ("exclamation point", "!"), ("full stop", "."),
                   ("semicolon", ";")],
        .russian: [("новый абзац", "\n\n"), ("с новой строки", "\n"), ("новая строка", "\n"),
                   ("вопросительный знак", "?"), ("восклицательный знак", "!"),
                   ("точка с запятой", ";"), ("двоеточие", ":")],
        .uzbek: [("yangi xatboshi", "\n\n"), ("yangi qator", "\n"), ("so\u{02BB}roq belgisi", "?"),
                 ("undov belgisi", "!"), ("nuqtali vergul", ";")],
        // `nokta` alone is a word (`bir nokta`, "a point"), like `точка`, so it is not here.
        .turkish: [("yeni paragraf", "\n\n"), ("yeni satır", "\n"), ("soru işareti", "?"),
                   ("ünlem işareti", "!"), ("noktalı virgül", ";")],
        // Likewise `نقطة` alone ("a point", "a dot").
        .arabic: [("فقرة جديدة", "\n\n"), ("سطر جديد", "\n"), ("علامة استفهام", "\u{061F}"),
                  ("علامة تعجب", "!"), ("فاصلة منقوطة", "\u{061B}")],
    ]

    /// Words after which `new line` / `new paragraph` is a noun phrase — `a new line of shoes`,
    /// `the new line feature` — and not a command. Without it both words were deleted and a line
    /// break put in their place, which is the one thing this layer promises never to do.
    static let nounPhraseOpeners = "a|an|the|this|that|these|those|our|my|your|their|his|her|its|"
        + "whole|entire|new|every|each|another|one"

    /// The same for the marks: `the car came to a full stop`, `put a question mark there`, `the
    /// semicolon is rare`. Narrower than the list above — `one full stop two` is a command, and
    /// so is `whole` or `new` before a mark only by accident of phrasing — but a determiner or a
    /// possessive before `full stop` is always the noun.
    static let markOpeners = "a|an|the|this|that|these|those|our|my|your|their|his|her|its|"
        + "every|each|another|any"

    /// Whether the phrase a pattern matched is speech rather than a command. `leading` is the
    /// commas and whitespace the pattern took in front of it, `before` everything before those.
    ///
    ///   * Nothing before it: a command punctuates or breaks what was said before it, and at the
    ///     start of a dictation there is nothing. `Full stop, and more` pasted `. and more`.
    ///   * A mark (not a break) at the start of a line has nothing to attach to either.
    ///   * The transcriber capitalised it as a name: a later word of the phrase capitalised
    ///     (`New Line Cinema`, `the Full Stop cafe`), or the first one mid-sentence (`call New
    ///     line`) — the transcriber writes a command it recognises in lowercase.
    static func isSpeech(phrase: String, leading: String, before: String,
                         breaksLine: Bool) -> Bool {
        guard let last = before.last else { return true }
        if !breaksLine, leading.contains("\n") { return true }
        let words = phrase.split(whereSeparator: \.isWhitespace)
        if words.dropFirst().contains(where: { $0.first?.isUppercase == true }) { return true }
        let midSentence = !leading.contains("\n") && !".!?…".contains(last)
        return midSentence && words.first?.first?.isUppercase == true
    }

    func applySpokenPunctuation(_ text: String) -> String {
        guard let rules = Self.spokenPunctuation[language], !rules.isEmpty else { return text }
        // Compared against an apostrophe-folded copy so `so'roq`, `so‘roq` and `soʻroq` all match.
        var out = text
        for (phrase, replacement) in rules {
            let breaksLine = replacement.hasPrefix("\n")
            let openers = breaksLine ? Self.nounPhraseOpeners : Self.markOpeners
            let guardNoun = language == .english
                ? "(?<!\\b(?:" + openers + ")\\s)" : ""
            let pattern = "(?i)([,\\s]*)" + guardNoun + "\\b(" + phrase
                .replacingOccurrences(of: "\u{02BB}", with: "['\u{2018}\u{2019}\u{02BB}\u{02BC}`]")
                .replacingOccurrences(of: " ", with: "\\s+")
                + ")\\b[.,]?"
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let template = breaksLine ? replacement : replacement + " "
            // A spoken sentence end opens a sentence, so the word after it takes a capital. Left
            // lowercase, `hello. how are you` read to `repairFalseStops` as a transcriber's stray
            // stop and the spoken "full stop" vanished without trace.
            let endsSentence = [".", "?", "!", "\u{061F}"].contains(replacement)
            let source = out as NSString
            var rebuilt = ""
            var cursor = 0
            var capitaliseNext = false
            for match in regex.matches(in: out, range: NSRange(location: 0, length: source.length)) {
                let speech = Self.isSpeech(
                    phrase: source.substring(with: match.range(at: 2)),
                    leading: source.substring(with: match.range(at: 1)),
                    before: source.substring(to: match.range.location), breaksLine: breaksLine)
                // Speech is copied through untouched, and it is the rest of a sentence, so a
                // capital owed by a command before it is paid to whatever comes first.
                let end = speech ? match.range.location + match.range.length : match.range.location
                var between = source.substring(
                    with: NSRange(location: cursor, length: end - cursor))
                if capitaliseNext {
                    between = Self.capitalisingFirstLetter(between, language: language)
                }
                rebuilt += between + (speech ? "" : template)
                cursor = match.range.location + match.range.length
                capitaliseNext = speech ? false : endsSentence
            }
            var rest = source.substring(from: cursor)
            if capitaliseNext { rest = Self.capitalisingFirstLetter(rest, language: language) }
            out = rebuilt + rest
        }
        return out
    }

    static func capitalisingFirstLetter(_ text: String, language: Language = .english) -> String {
        guard let index = text.firstIndex(where: { !$0.isWhitespace }),
              text[index].isLetter else { return text }
        return String(text[..<index]) + language.uppercased(String(text[index]))
            + String(text[text.index(after: index)...])
    }

    // MARK: Spacing

    static func collapseSpaces(_ text: String) -> String {
        var out = ""
        var lastWasSpace = false
        for ch in text {
            let isSpace = ch == " " || ch == "\t" || ch == "\u{00A0}"
            if isSpace, lastWasSpace { continue }
            out.append(isSpace ? " " : ch)
            lastWasSpace = isSpace
        }
        return out
    }

    /// No space before `, . ! ? ; : …` (or the Arabic `، ؛ ؟`), one after it before a letter, no
    /// doubled marks, no trailing spaces on a line.
    static func fixSpacing(_ text: String) -> String {
        var chars = Array(text)
        var out: [Character] = []
        out.reserveCapacity(chars.count)
        let closers: Set<Character> = [",", ".", "!", "?", ";", ":", "…", ")", "]", "»",
                                       "\u{060C}", "\u{061B}", "\u{061F}"]
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            if ch == " ", i + 1 < chars.count, closers.contains(chars[i + 1]) {
                i += 1
                continue
            }
            // `,,` `,.` `.,` — keep the stronger of the two.
            if (ch == "," || ch == "."), let last = out.last, last == "," || last == "." ,
               !(ch == "." && last == ".") {
                if ch == "." { out[out.count - 1] = "." }
                i += 1
                continue
            }
            out.append(ch)
            // A space after a comma, semicolon, question or exclamation mark when a letter
            // follows immediately. Not after `.` or `:` — `3.5`, `e.g.`, `3:30`, URLs.
            if [",", ";", "?", "!", "\u{060C}", "\u{061B}", "\u{061F}"].contains(ch),
               i + 1 < chars.count, chars[i + 1].isLetter {
                out.append(" ")
            }
            i += 1
        }
        chars = out
        // Trailing spaces before a newline, and at the ends.
        let lines = String(chars).split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespaces)
    }

    // MARK: Final sentence

    /// Closes an unterminated dictation with `?` when it plainly asks something, `.` otherwise —
    /// and in Arabic with `؟`, the mark Arabic writes.
    ///
    /// Three words minimum: a one- or two-word dictation is usually a label, a name or a search,
    /// and a full stop there is an imposition.
    func closeFinalSentence(_ text: String) -> String {
        guard let last = text.last, last.isLetter || last.isNumber else { return text }
        let lastLine = text.split(separator: "\n").last.map(String.init) ?? text
        let words = lastLine.split(whereSeparator: { $0 == " " })
        let sentence = Self.lastSentence(of: lastLine)
        let asks = Self.isQuestion(sentence, language: language)
        // Uzbek packs a question into two words — `ertaga kelasizmi` — so a question needs two;
        // so does Turkish (`geliyor musun`) and Arabic (`هل وصلت`).
        guard words.count >= 3 || (words.count == 2 && asks) else { return text }
        return text + (asks ? (language == .arabic ? "\u{061F}" : "?") : ".")
    }

    static func lastSentence(of text: String) -> String {
        guard let cut = text.lastIndex(where: { stops.contains($0) }) else { return text }
        return String(text[text.index(after: cut)...]).trimmingCharacters(in: .whitespaces)
    }

    static let englishQuestionOpeners: Set<String> = [
        "what", "why", "how", "when", "where", "who", "whom", "whose", "which", "can", "could",
        "would", "should", "do", "does", "did", "is", "are", "was", "were", "will", "shall",
        "have", "has", "may", "am", "isn't", "aren't", "don't", "doesn't", "didn't", "won't",
        "can't", "couldn't", "wouldn't", "shouldn't",
    ]
    static let russianQuestionWords: Set<String> = [
        "что", "почему", "зачем", "как", "когда", "где", "куда", "откуда", "кто", "сколько",
        "какой", "какая", "какое", "какие", "каким", "чей", "чья", "чьё", "разве", "неужели",
        "ли",
    ]
    static let uzbekQuestionWords: Set<String> = [
        "nima", "nimaga", "nimani", "nega", "qanday", "qanaqa", "qachon", "qayerda", "qayerga",
        "qayerdan", "kim", "kimga", "kimni", "qaysi", "necha", "nechta", "qancha", "nimalar",
    ]

    /// Ordinary words that happen to end in the interrogative `-mi`.
    static let uzbekNotQuestions: Set<String> = ["ismi", "qismi", "rasmi", "jismi", "hammi", "ilmi"]

    /// Turkish question words. Unlike English they need not open the sentence (`Bu ne?`,
    /// `Saat kaçta?`), so the first and the last word are both asked.
    static let turkishQuestionWords: Set<String> = [
        "ne", "neden", "niye", "niçin", "nasıl", "nerede", "nereye", "nereden", "neresi", "kim",
        "kime", "kimi", "kimin", "kimde", "hangi", "hangisi", "kaç", "kaçta", "kaçıncı",
    ]

    /// Turkish's question particle is a separate word — `mı mi mu mü` — carrying person and tense
    /// after it: `geliyor musun`, `hazır mısınız`, `doğru mudur`. Any word of the sentence may be
    /// it, and nothing else in Turkish is spelled this way.
    static func isTurkishQuestionParticle(_ word: String) -> Bool {
        guard let first = word.first, "m".contains(first), word.count >= 2 else { return false }
        let vowel = word[word.index(after: word.startIndex)]
        guard "ıiuü".contains(vowel) else { return false }
        let rest = String(word.dropFirst(2))
        return rest.isEmpty || turkishParticleEndings.contains(rest)
    }

    static let turkishParticleEndings: Set<String> = [
        "sın", "sin", "sun", "sün", "yım", "yim", "yum", "yüm", "yız", "yiz", "yuz", "yüz",
        "sınız", "siniz", "sunuz", "sünüz", "dır", "dir", "dur", "dür", "ydı", "ydi", "ydu",
        "ydü", "ymış", "ymiş", "ymuş", "ymüş", "yken",
    ]

    /// Arabic interrogatives, which open the sentence. `من` ("who", but far more often "from")
    /// and `ما` ("what", and the negation) are left out: they would turn statements into
    /// questions. The dialect forms are the ones a dictation is spoken in.
    static let arabicQuestionOpeners: Set<String> = [
        "هل", "أين", "اين", "كيف", "لماذا", "لماذ", "متى", "ماذا", "كم", "أي", "أليس", "ألا",
        "ليش", "ليه", "وين", "فين", "شو", "إيش", "ايش", "إزاي", "ازاي", "امتى", "إمتى",
    ]

    static func isQuestion(_ sentence: String, language: Language) -> Bool {
        let words = language.lowercased(sentence)
            .split(whereSeparator: { !$0.isLetter && $0 != "'" && $0 != "\u{02BB}" && $0 != "-" })
            .map(String.init)
        guard let first = words.first else { return false }
        switch language {
        case .english:
            return englishQuestionOpeners.contains(first)
        case .russian:
            return russianQuestionWords.contains(first)
                || (words.count > 1 && words[1] == "ли")
        case .uzbek:
            // The interrogative suffixes are the reliable signal: `yaxshimisiz`, `bo'ladimi`,
            // `ko'rdingizmi`, `-chi`. A question word helps only when it opens the sentence.
            let lastWord = UzbekPolishGuard.foldApostrophes(words.last ?? "")
            let suffixed = !uzbekNotQuestions.contains(lastWord)
                && ["mi", "mikan", "mikin", "misiz", "misan", "misizlar", "mizmi"]
                    .contains(where: { lastWord.hasSuffix($0) && lastWord.count > $0.count + 2 })
            return suffixed || uzbekQuestionWords.contains(first)
        case .turkish:
            return words.contains(where: isTurkishQuestionParticle)
                || turkishQuestionWords.contains(first)
                || turkishQuestionWords.contains(words.last ?? "")
        case .arabic:
            // `وهل`, `فكيف`: the conjunction is written onto the question word.
            let bare = (first.hasPrefix("و") || first.hasPrefix("ف")) && first.count > 2
                ? String(first.dropFirst()) : first
            return arabicQuestionOpeners.contains(first) || arabicQuestionOpeners.contains(bare)
        }
    }
}
