import Foundation

// Where the strings come from.
//
// The brief for this generator is explicit that it must not invent a parallel corpus, and the
// reason is worth restating: a fixture built from sentences someone wrote to exercise a branch
// tests the branch, not the language. Everything below is either already committed in this
// repository as evidence, or is a boundary case lifted verbatim from a test or a doc comment that
// names why the boundary is there.
//
//   Tests/KotibaCoreTests/Fixtures/uzbek-normaliser-parity.json   318 pairs, from NavAI's
//                                                               uzbek_text_norm v0.3.0
//   Tests/KotibaCoreTests/Fixtures/uzbek-transcripts.json         120 real transcripts from the
//                                                               shipping Uzbek model
//   archive/navo-models-evidence/gap01/refs.json                 745 UzbekVoice eval references
//   archive/navo-models-evidence/gap01/corrector.json             20 (source, corrected) pairs
//
// `Tests/KotibaAudioTests/Fixtures/mel-parity.json` is the fourth committed fixture and is
// deliberately not read: `MelSpectrogram` is on 02-BEHAVIOUR's confirmed-dead list, so there is
// nothing on the Windows side for it to be parity with.

enum Corpus {

    /// The repository root, found from this file rather than from the working directory, so
    /// `swift run kotiba-golden <out>` produces the same bytes from anywhere.
    static let repoRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // kotiba-golden
        .deletingLastPathComponent()   // Sources
        .deletingLastPathComponent()   // repo root

    static func json(_ relativePath: String) -> Any {
        let url = repoRoot.appendingPathComponent(relativePath)
        guard let data = try? Data(contentsOf: url),
              let value = try? JSONSerialization.jsonObject(with: data) else {
            FileHandle.standardError.write(
                Data("kotiba-golden: cannot read \(relativePath)\n".utf8))
            exit(1)
        }
        return value
    }

    // MARK: - Committed corpora

    struct ParityPair {
        let mode: String        // "reference" or "hypothesis"
        let input: String
        let expected: String    // what uzbek_text_norm v0.3.0 produced
    }

    /// 318 pairs. Order is the file's order, which is already stable.
    static let parity: [ParityPair] = {
        guard let root = json("Tests/KotibaCoreTests/Fixtures/uzbek-normaliser-parity.json")
                as? [String: Any],
              let pairs = root["pairs"] as? [[String: Any]] else { return [] }
        return pairs.compactMap {
            guard let mode = $0["mode"] as? String,
                  let input = $0["in"] as? String,
                  let out = $0["out"] as? String else { return nil }
            return ParityPair(mode: mode, input: input, expected: out)
        }
    }()

    /// 120 transcripts as the shipping Uzbek model actually emits them: ASCII apostrophes,
    /// sentence punctuation about two thirds of the time, and not one capital letter.
    static let transcripts: [String] = {
        guard let root = json("Tests/KotibaCoreTests/Fixtures/uzbek-transcripts.json")
                as? [String: Any],
              let list = root["transcripts"] as? [String] else { return [] }
        return list
    }()

    /// 745 gold references from the UzbekVoice evaluation material. These are the okina-heavy
    /// half of the corpus — 142 U+02BB and 10 U+02BC across the set — which is exactly the
    /// distinction `forDelivery` exists to get right and `clean` deliberately destroys.
    /// Sorted by clip key so the order is the file's content rather than its hash order.
    static let evalReferences: [(key: String, text: String)] = {
        guard let root = json("archive/navo-models-evidence/gap01/refs.json")
                as? [String: String] else { return [] }
        return root.keys.sorted().map { ($0, root[$0]!) }
    }()

    /// 20 (raw, corrected) pairs from the corrector benchmark — the only place in the repository
    /// where real Uzbek carries capitals, so the only real material that can tell an idempotent
    /// capitaliser from a destructive one.
    static let correctorPairs: [(key: String, source: String, hypothesis: String)] = {
        guard let list = json("archive/navo-models-evidence/gap01/corrector.json")
                as? [[String: Any]] else { return [] }
        return list.compactMap {
            guard let key = $0["key"] as? String,
                  let src = $0["src"] as? String,
                  let hyp = $0["hyp"] as? String else { return nil }
            return (key, src, hyp)
        }.sorted { $0.key < $1.key }
    }()

    // MARK: - Boundary cases

    /// A boundary case: the string, and the constant or rule it would expose if that constant
    /// were wrong. `exercises` is not decoration — the brief requires every constant in
    /// 02-BEHAVIOUR to have at least one case whose output changes if the constant changes, and
    /// this field is how a reader checks that claim without re-deriving it.
    struct Case {
        let text: String
        let exercises: String
        init(_ text: String, _ exercises: String) {
            self.text = text
            self.exercises = exercises
        }
    }

    static let okina = "\u{02BB}"     // MODIFIER LETTER TURNED COMMA — oʻ / gʻ
    static let tutuq = "\u{02BC}"     // MODIFIER LETTER APOSTROPHE — sanʼat / maʼno / taʼlim

    /// Text boundaries: delivery, scoring and capitalisation all run over this list, because the
    /// three of them disagree on most of it and the disagreement is the point.
    static let textBoundaries: [Case] = [
        // --- the okina / tutuq rule: the character immediately before, lowercased ---
        .init("o'n to'rt bo'ladi", "apostrophe after o -> U+02BB"),
        .init("g'isht", "apostrophe after g -> U+02BB"),
        .init("to'g'ri", "both marks in one word -> U+02BB twice"),
        .init("san'at", "apostrophe after n -> U+02BC, not U+02BB"),
        .init("ma'no", "apostrophe after a -> U+02BC"),
        .init("ta'lim", "apostrophe after a -> U+02BC"),
        .init("a'lo", "apostrophe after a -> U+02BC"),
        .init("O'zbekiston", "uppercase O is lowercased for the o/g test only"),
        .init("O'ZBEK", "uppercase throughout still folds to U+02BB and keeps its case"),
        .init("G'ALABA", "uppercase G -> U+02BB"),
        .init("San'at", "uppercase S before, n immediately before -> U+02BC"),
        // Every glyph a model might reach for, all resolving by the same rule.
        .init("san'at", "ASCII apostrophe U+0027"),
        .init("san\u{02BC}at", "already U+02BC — idempotence"),
        .init("san\u{02BB}at", "wrongly U+02BB — must be repaired to U+02BC"),
        .init("san\u{2018}at", "left single quote U+2018"),
        .init("san\u{2019}at", "right single quote U+2019"),
        .init("san\u{0060}at", "grave accent U+0060"),
        .init("san\u{00B4}at", "acute accent U+00B4"),
        .init("san\u{02B9}at", "modifier letter prime U+02B9"),
        .init("san\u{02BD}at", "modifier letter reversed comma U+02BD"),
        .init("san\u{2032}at", "prime U+2032"),
        .init("do\u{2019}stim", "right single quote after o -> U+02BB"),
        .init("do\u{00B4}stim", "acute after o -> U+02BB"),
        // --- the intra-word guard: letters on both sides or it stays punctuation ---
        .init("'boshida", "leading apostrophe is punctuation, not a letter"),
        .init("oxirida'", "trailing apostrophe is punctuation"),
        .init("' ", "an apostrophe alone survives, and the string trims"),
        .init("25' balandlik", "digit before is not a letter — stays punctuation"),
        .init("'salom.' keyingi gap.", "quoted sentence: capitaliser must see past the quote"),
        .init("\u{2018}salom\u{2019} dedi", "paired curly quotes stay a pair"),
        .init("\u{02BC}salom. \u{02BB}keyingi gap.",
              "a leading modifier letter must not consume the sentence start"),
        // --- the English-genitive exception ---
        .init("Chicago's kitobi", "lone trailing s after the mark -> ASCII apostrophe"),
        .init("Samsung's telefoni", "genitive inside a brand name"),
        .init("LG's", "genitive at end of string — afterThat is nil"),
        .init("do'stim", "a real Uzbek word ending -s after o' is still folded"),
        .init("go'sht", "and after g'"),
        .init("bo's", "o' then a lone terminal s: the genitive rule and the okina rule collide"),
        .init("qo'shni's", "genitive on a word that already contains an okina"),
        // --- the character repairs ---
        .init("s\u{0430}lom", "stray Cyrillic a U+0430 inside Latin -> ASCII a"),
        .init("t\u{04EF}rt", "U+04EF -> o + U+02BB"),
        .init("K\u{04EE}p", "U+04EE -> O + U+02BB"),
        .init("salom\u{200B}dunyo", "U+200B zero-width space dropped"),
        .init("salom\u{FEFF}dunyo", "U+FEFF BOM dropped"),
        .init("salom\u{200C}dunyo", "U+200C ZWNJ dropped"),
        .init("salom\u{200D}dunyo", "U+200D ZWJ dropped"),
        .init("salom\u{2060}dunyo", "U+2060 word joiner dropped"),
        .init("bo\u{00AD}la", "U+00AD soft hyphen dropped by delivery, spaced by clean"),
        // --- whitespace, which delivery collapses and scoring collapses differently ---
        .init("  salom   dunyo  ", "runs of space collapse; the result trims"),
        .init("salom\tdunyo", "a tab collapses to one space"),
        .init("birinchi qator\nikkinchi qator", "a newline a mode asked for survives delivery"),
        // --- punctuation and digits: the speaker's, and the whole reason clean is not delivery
        .init("Salom! Bugun soat 10:30 da uchrashamiz. Yaxshimi?",
              "the measured `clean`-on-delivery bug: 10:30, the ! and the ? all survive"),
        .init("assalomu alaykum, do'stim, yaxshimisiz? ahvollaring yaxshimi? charchamayapsanmi?",
              "the diagnostics case — three sentences, three capitals after delivery"),
        .init("assalomu alaykum. xo'p, bu stt programma bo'ladi. ai asosida ishlangan, nomi kotib.",
              "the 2026-08-18 dictation: all lowercase from the engine, punctuated"),
        .init("bir-ikki kun", "a hyphen survives delivery and becomes a space in clean"),
        .init("25 000 so'm", "a thousands separator survives delivery, is spelled out by clean"),
        .init("25 dollar", "digits survive delivery, become `yigirma besh` in the scoring pass"),
        .init("ha \u{2013} yo\u{2019}q \u{2014} bilmadim", "en and em dashes are the writer's"),
        .init("sa\u{2010}y\u{2011}harakat", "U+2010 and U+2011 hyphens"),
        .init("sa\u{2012}y\u{2015}harakat", "U+2012 figure dash and U+2015 horizontal bar"),
        .init("sa\u{2212}y", "U+2212 minus sign"),
        .init("narxi 25 ming. arzon", "a digit after a full stop must not consume the capital"),
        .init("nima? yaxshi! ha.", "all three terminators"),
        .init("gap tugadi\u{2026} keyingisi", "U+2026 ellipsis is a terminator too"),
        .init("salom, dunyo", "a comma is not a terminator"),
        .init("u dedi. \"salom\"", "a straight double quote is skippable"),
        .init("u dedi. \u{201C}salom\u{201D}", "a curly double quote is skippable"),
        .init("u dedi. (salom)", "a parenthesis is skippable"),
        .init("u dedi. [salom]", "a bracket is skippable"),
        .init("u dedi. \u{00AB}salom\u{00BB}", "guillemets are skippable"),
        .init("o\u{02BB}zbekiston go\u{02BB}zal",
              "the okina trap: O\u{02BB}zbekiston, never O\u{02BB}Zbekiston"),
        .init("o'zbekiston", "the same trap through the ASCII glyph"),
        .init("\u{043F}\u{0440}\u{0438}\u{0432}\u{0435}\u{0442}. \u{043A}\u{0430}\u{043A} "
              + "\u{0434}\u{0435}\u{043B}\u{0430}?",
              "Cyrillic capitalises too — the same pipeline sees Russian"),
        .init("", "empty input is not a special case"),
        .init("   ", "whitespace only"),
        .init("...", "punctuation only — no letters to capitalise"),
        .init("14 \u{2014} 25%", "digits and punctuation alone are script `neither`"),
        .init("[BLANK_AUDIO]", "whisper's own marker, which is not words"),
        .init("hello there. this is how i actually type.",
              "English through the same capitaliser"),
        .init("MENING ISMIM", "delivery never lowercases"),
        .init("Toshkent shahri", "already correct, so nothing may change"),
    ]

    /// Vocabulary terms that seed the capitaliser. 02-BEHAVIOUR §4: the capitaliser is seeded with
    /// the **union** across all three languages, so an Uzbek term is force-capitalised inside an
    /// English sentence too. Deliberately drawn from words that appear in the corpus above.
    static let vocabularyByLanguage: [(language: String, terms: [String])] = [
        ("en", ["Kotib", "Telegram"]),
        ("ru", ["\u{041C}\u{0438}\u{0440}\u{0437}\u{043E}"]),   // Мирзо
        ("uz", ["kotib", "toshkent", "samarqand", "o\u{02BB}zbekiston"]),
    ]
}
