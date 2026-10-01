import Foundation
import Testing

@testable import KotibaCore

// T-01's definition of done: match the Python package on a checked-in corpus.
//
// The fixture was generated from `uzbek_text_norm` v0.3.0 itself over real material — 90 gold
// references, 140 hypotheses from three engines with three different apostrophe habits
// (rubaistt's ASCII quote, navai's okina, stock Whisper's Cyrillic), plus 44 synthetic edge
// cases the corpus barely exercises. Where the fixture and the Swift disagree, the Swift is
// wrong by definition.

private struct ParityPair: Decodable {
    let mode: String
    let `in`: String
    let out: String
}

private struct ParityFixture: Decodable {
    let generator: String
    let pairs: [ParityPair]
}

private func loadFixture() throws -> ParityFixture {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures/uzbek-normaliser-parity.json")
    return try JSONDecoder().decode(ParityFixture.self, from: Data(contentsOf: url))
}

@Suite("Uzbek normaliser — parity with uzbek_text_norm v0.3.0")
struct UzbekNormaliserParity {

    @Test("every pair in the fixture round-trips identically")
    func fullCorpusParity() throws {
        let fixture = try loadFixture()
        #expect(fixture.pairs.count >= 200, "T-01 asks for at least 200 pairs")

        var mismatches: [(String, String, String)] = []
        for p in fixture.pairs {
            let got = p.mode == "reference"
                ? UzbekNormaliser.normaliseReference(p.in)
                : UzbekNormaliser.normaliseHypothesis(p.in)
            if got != p.out { mismatches.append((p.in, p.out, got)) }
        }

        if !mismatches.isEmpty {
            for (input, want, got) in mismatches.prefix(10) {
                Issue.record("""
                    input:    \(input.debugDescription)
                    expected: \(want.debugDescription)
                    got:      \(got.debugDescription)
                    """)
            }
        }
        #expect(mismatches.isEmpty,
                "\(mismatches.count) of \(fixture.pairs.count) pairs diverge from the reference")
    }
}

@Suite("Uzbek normaliser — the behaviours that matter downstream")
struct UzbekNormaliserBehaviour {

    @Test("both lineages' apostrophes fold to the same string")
    func apostrophesConverge() {
        // rubaistt emits ASCII, navai emits the okina. Same word, two engines.
        let ascii = UzbekNormaliser.normaliseReference("o'n to'rt bo'ladi")
        let okina = UzbekNormaliser.normaliseReference("oʻn toʻrt boʻladi")
        let curly = UzbekNormaliser.normaliseReference("o‘n to‘rt bo‘ladi")
        let back = UzbekNormaliser.normaliseReference("o`n to`rt bo`ladi")
        #expect(ascii == okina)
        #expect(ascii == curly)
        #expect(ascii == back)
        #expect(ascii.contains("\u{02BB}"), "the target glyph is the okina, not an ASCII quote")
    }

    @Test("digits and their spelled-out forms compare equal")
    func numbersConverge() {
        #expect(UzbekNormaliser.normaliseReference("14 dollar")
                == UzbekNormaliser.normaliseReference("o'n to'rt dollar"))
        #expect(UzbekNormaliser.normaliseReference("25 000 so'm")
                == UzbekNormaliser.normaliseReference("yigirma besh ming so'm"))
    }

    @Test(arguments: [
        (0, "nol"), (1, "bir"), (14, "o'n to'rt"), (100, "bir yuz"), (137, "bir yuz o'ttiz yetti"),
        (1000, "bir ming"), (10_000, "o'n ming"), (100_000, "yuz ming"),
        (1_000_000, "bir million"), (2024, "ikki ming yigirma to'rt"),
    ])
    func cardinals(n: Int, expected: String) {
        #expect(UzbekNormaliser.numberToWords(n) == expected)
    }

    @Test(arguments: [
        (1, "birinchi"), (2, "ikkinchi"), (4, "to'rtinchi"), (20, "yigirmanchi"),
        (100, "yuzinchi"), (1000, "minginchi"), (2024, "ikki ming yigirma to'rtinchi"),
    ])
    func ordinals(n: Int, expected: String) {
        #expect(UzbekNormaliser.numberToOrdinalWords(n) == expected)
    }

    @Test("Cyrillic output from stock Whisper transliterates rather than mismatching wholesale")
    func cyrillicTransliterates() {
        #expect(UzbekNormaliser.normaliseHypothesis("ўзбекистон") == "o\u{02BB}zbekiston")
        #expect(UzbekNormaliser.normaliseHypothesis("нима гап") == "nima gap")
    }

    @Test("hyphenated compounds split, matching Whisper's own normaliser")
    func compoundsSplit() {
        #expect(UzbekNormaliser.normaliseReference("oq-qora") == "oq qora")
    }

    @Test("annotation tags are dropped from both sides")
    func tagsDropped() {
        #expect(UzbekNormaliser.normaliseReference("noise salom hesitation dunyo") == "salom dunyo")
    }

    @Test("empty and punctuation-only input normalise to empty — which the session treats as heard-nothing")
    func degenerateInput() {
        #expect(UzbekNormaliser.normaliseReference("") == "")
        #expect(UzbekNormaliser.normaliseReference("   ") == "")
        #expect(UzbekNormaliser.normaliseReference("...") == "")
        #expect(UzbekNormaliser.normaliseReference("-") == "")
    }
}

// The regression that shipped: `clean` was on the delivery path. It is the leaderboard's
// normaliser — lowercase, no punctuation — and it spent months quietly deleting every comma and
// full stop the Uzbek model produced, and with them every sentence boundary `Capitaliser` needed.
//
// The first case below is verbatim from this app's diagnostics on 2026-08-08: what whisper said,
// and what the user was handed.

@Suite("Uzbek delivery — the transcript the user actually receives")
struct UzbekDelivery {

    @Test("the diagnostics case: punctuation survives, and so do the sentences")
    func realDictationKeepsItsPunctuation() {
        let raw = "assalomu alaykum, do'stim, yaxshimisiz? ahvollaring yaxshimi? charchamayapsanmi?"
        let delivered = UzbekNormaliser.forDelivery(raw)

        #expect(delivered == "assalomu alaykum, do\u{02BB}stim, yaxshimisiz? "
                + "ahvollaring yaxshimi? charchamayapsanmi?")
        #expect(delivered.contains(","), "the commas the model produced must reach the document")
        #expect(delivered.contains("?"), "so must the question marks")

        // And now the capitaliser has boundaries to work with — three sentences, three capitals.
        let capitalised = Capitaliser().restore(delivered)
        #expect(capitalised.hasPrefix("Assalomu"))
        #expect(capitalised.contains("? Ahvollaring"))
        #expect(capitalised.contains("? Charchamayapsanmi"))
        #expect(Capitaliser.sentenceInitialCapitalRate(capitalised) == 1.0)
    }

    @Test("what `clean` would have done to the same string, for the record")
    func cleanIsForScoringOnly() {
        let raw = "assalomu alaykum, do'stim, yaxshimisiz?"
        #expect(UzbekNormaliser.clean(raw)
                == "assalomu alaykum do\u{02BB}stim yaxshimisiz")
        #expect(!UzbekNormaliser.clean(raw).contains(","))
        #expect(!UzbekNormaliser.clean(raw).contains("?"))
    }

    @Test("case is the speaker's — delivery never lowercases")
    func casePreserved() {
        #expect(UzbekNormaliser.forDelivery("Toshkent shahri") == "Toshkent shahri")
        #expect(UzbekNormaliser.forDelivery("MENING ISMIM") == "MENING ISMIM")
        #expect(UzbekNormaliser.forDelivery("O'zbekiston") == "O\u{02BB}zbekiston")
    }

    @Test("oʻ / gʻ take the okina; the tutuq belgisi takes its own letter")
    func twoDifferentMarks() {
        // U+02BB — part of the letter.
        #expect(UzbekNormaliser.forDelivery("o'n to'rt bo'ladi")
                == "o\u{02BB}n to\u{02BB}rt bo\u{02BB}ladi")
        #expect(UzbekNormaliser.forDelivery("g'isht") == "g\u{02BB}isht")
        // U+02BC — the glottal stop. `clean` spells all four of these with the okina.
        #expect(UzbekNormaliser.forDelivery("san'at") == "san\u{02BC}at")
        #expect(UzbekNormaliser.forDelivery("ma'no") == "ma\u{02BC}no")
        #expect(UzbekNormaliser.forDelivery("ta'lim") == "ta\u{02BC}lim")
        #expect(UzbekNormaliser.forDelivery("a'lo") == "a\u{02BC}lo")
        // Whichever glyph the model reached for, the answer is the same.
        for variant in ["san'at", "sanʼat", "sanʻat", "san‘at", "san’at", "san`at"] {
            #expect(UzbekNormaliser.forDelivery(variant) == "san\u{02BC}at",
                    "\(variant.debugDescription) should deliver as sanʼat")
        }
        #expect(UzbekNormaliser.forDelivery("O'ZBEK") == "O\u{02BB}ZBEK", "uppercase O' is still oʻ")
    }

    @Test("hyphens and digits are left exactly as spoken")
    func hyphensAndDigitsSurvive() {
        // `clean` turns the hyphen into a space and spells the digits out in Uzbek words.
        #expect(UzbekNormaliser.forDelivery("bir-ikki kun") == "bir-ikki kun")
        #expect(UzbekNormaliser.forDelivery("25 000 so'm") == "25 000 so\u{02BB}m")
        #expect(UzbekNormaliser.clean("bir-ikki kun") == "bir ikki kun")
        #expect(UzbekNormaliser.normaliseReference("25 dollar") == "yigirma besh dollar")
    }

    @Test("the junk that is still worth removing")
    func stillTidies() {
        #expect(UzbekNormaliser.forDelivery("salom\u{200B}dunyo") == "salomdunyo")
        #expect(UzbekNormaliser.forDelivery("  salom   dunyo  ") == "salom dunyo")
        #expect(UzbekNormaliser.forDelivery("s\u{0430}lom") == "salom", "stray Cyrillic а")
        #expect(UzbekNormaliser.forDelivery("t\u{04EF}rt") == "to\u{02BB}rt", "ӯ is a non-standard ў")
    }

    @Test("idempotent — running it twice changes nothing")
    func idempotent() {
        for input in ["assalomu alaykum, do'stim, yaxshimisiz?", "O'zbekiston san'ati",
                      "bir-ikki 25 kun", "salom"] {
            let once = UzbekNormaliser.forDelivery(input)
            #expect(UzbekNormaliser.forDelivery(once) == once, "\(input.debugDescription)")
        }
    }

    @Test("a newline a mode asked for is not collapsed away")
    func newlinesSurvive() {
        #expect(UzbekNormaliser.forDelivery("birinchi qator\nikkinchi qator")
                == "birinchi qator\nikkinchi qator")
    }

    // The first version of forDelivery folded every apostrophe-shaped character unconditionally,
    // which broke two things an adversarial review caught by running the code.

    @Test("a quotation mark stays a quotation mark, and the capitaliser can still see past it")
    func quotesAreNotLetters() {
        // U+02BC is Unicode category Lm — a *letter* — so folding an opening quote onto it made
        // Capitaliser take the quote as the sentence's first letter, "uppercase" a character with
        // no uppercase form, and leave the real first letter alone. Zero capitals, which is the
        // exact symptom forDelivery exists to cure.
        let delivered = UzbekNormaliser.forDelivery("'salom.' keyingi gap.")
        #expect(delivered == "'salom.' keyingi gap.", "not between two letters, so not a letter")

        let capitalised = Capitaliser().restore(delivered)
        #expect(capitalised == "'Salom.' Keyingi gap.")
        #expect(Capitaliser.sentenceInitialCapitalRate(capitalised) == 1.0)

        // Paired curly quotes survive as quotes rather than becoming two modifier letters.
        #expect(UzbekNormaliser.forDelivery("\u{2018}salom\u{2019} dedi")
                == "\u{2018}salom\u{2019} dedi")

        // And belt-and-braces: even handed a leading modifier letter from somewhere else, the
        // capitaliser finds the real first letter.
        #expect(Capitaliser().restore("\u{02BC}salom. \u{02BB}keyingi gap.")
                == "\u{02BC}Salom. \u{02BB}Keyingi gap.")
    }

    @Test("an English genitive does not get an Uzbek letter put inside it")
    func englishGenitivesSurvive() {
        // "Chicago's" became "Chicagoʻs" — an Uzbek letter inside a brand name, which then fails
        // to match in a search box or a URL. Uzbek has no `'s` suffix, so a lone trailing s is the
        // tell.
        #expect(UzbekNormaliser.forDelivery("Chicago's kitobi") == "Chicago's kitobi")
        #expect(UzbekNormaliser.forDelivery("Samsung's telefoni") == "Samsung's telefoni")
        #expect(UzbekNormaliser.forDelivery("LG's") == "LG's")
        // But a real Uzbek word ending in -s after oʻ/gʻ is still folded.
        #expect(UzbekNormaliser.forDelivery("do'stim") == "do\u{02BB}stim")
        #expect(UzbekNormaliser.forDelivery("go'sht") == "go\u{02BB}sht")
    }

    @Test("an apostrophe has to be inside a word to be one of Uzbek's two letters")
    func onlyIntraWord() {
        #expect(UzbekNormaliser.forDelivery("'boshida") == "'boshida")
        #expect(UzbekNormaliser.forDelivery("oxirida'") == "oxirida'")
        #expect(UzbekNormaliser.forDelivery("' ") == "'")
        #expect(UzbekNormaliser.forDelivery("25' balandlik") == "25' balandlik")
        // Still idempotent with the real letters already in place.
        for input in ["do\u{02BB}stim", "san\u{02BC}at", "'salom.' keyingi", "Chicago's"] {
            #expect(UzbekNormaliser.forDelivery(UzbekNormaliser.forDelivery(input))
                    == UzbekNormaliser.forDelivery(input), "\(input)")
        }
    }
}
