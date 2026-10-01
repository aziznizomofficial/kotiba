import Foundation
import Testing

@testable import KotibaCore

// The fixture is 120 real transcripts produced by the shipping Uzbek model over the Ovozify
// evaluation set — not invented sentences. They carry that model's actual habits: punctuation
// about two thirds of the time, capitals never, ASCII apostrophes rather than the okina.

private struct TranscriptFixture: Decodable {
    let source: String
    let transcripts: [String]
}

private func realTranscripts() throws -> [String] {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures/uzbek-transcripts.json")
    return try JSONDecoder().decode(TranscriptFixture.self, from: Data(contentsOf: url)).transcripts
}

@Suite("Capitalisation — deterministic, because the alternative confabulates")
struct CapitalisationTests {

    @Test("the definition of done: at least 80% sentence-initial capitals on real output")
    func theDefinitionOfDone() throws {
        let transcripts = try realTranscripts()
        #expect(transcripts.count >= 100)

        // Establish the baseline first, so the improvement is measured rather than assumed.
        let before = transcripts.map(Capitaliser.sentenceInitialCapitalRate).reduce(0, +)
            / Double(transcripts.count)
        let capitaliser = Capitaliser()
        let after = transcripts.map { capitaliser.restore($0) }
            .map(Capitaliser.sentenceInitialCapitalRate).reduce(0, +) / Double(transcripts.count)

        #expect(before < 0.05, "the model emits essentially no capitals: measured \(before)")
        #expect(after >= 0.8, "after restoration: \(after)")
    }

    @Test("the first letter of the text is capitalised")
    func firstLetter() {
        #expect(Capitaliser().restore("salom dunyo") == "Salom dunyo")
    }

    @Test("a new sentence after a full stop is capitalised")
    func afterTerminators() {
        let c = Capitaliser()
        #expect(c.restore("salom. qalaysiz?") == "Salom. Qalaysiz?")
        #expect(c.restore("nima? yaxshi! ha.") == "Nima? Yaxshi! Ha.")
    }

    @Test("a comma does not start a sentence")
    func commaIsNotATerminator() {
        #expect(Capitaliser().restore("salom, dunyo") == "Salom, dunyo")
    }

    @Test("the okina survives, and the letter before it is what gets capitalised")
    func okinaHandling() {
        // The trap: naive capitalisation produces OʻZbekiston or ʻOzbekiston.
        let c = Capitaliser()
        #expect(c.restore("o\u{02BB}zbekiston go\u{02BB}zal") == "O\u{02BB}zbekiston go\u{02BB}zal")
        #expect(c.restore("o'zbekiston") == "O'zbekiston")
    }

    @Test("already-capitalised text is left alone rather than mangled")
    func idempotent() {
        let c = Capitaliser()
        let text = "Salom. Qalaysiz? Yaxshi."
        #expect(c.restore(text) == text)
        #expect(c.restore(c.restore("salom. qalaysiz?")) == c.restore("salom. qalaysiz?"))
    }

    @Test("Cyrillic capitalises too, since the same pipeline sees Russian")
    func cyrillic() {
        #expect(Capitaliser().restore("привет. как дела?") == "Привет. Как дела?")
    }

    @Test("a sentence starting after a quote mark still capitalises")
    func afterQuotes() {
        #expect(Capitaliser().restore("u dedi. \"salom\"") == "U dedi. \"Salom\"")
    }

    @Test("a digit after a full stop does not consume the sentence start")
    func digitsDoNotSwallowTheStart() {
        // "14 dollar." then a new sentence — the capital belongs on the following word.
        #expect(Capitaliser().restore("narxi 25 ming. arzon") == "Narxi 25 ming. Arzon")
    }

    @Test("a dot inside a word is not a sentence end: addresses and file names keep their case")
    func dotsInsideWords() {
        let c = Capitaliser()
        #expect(c.restore("my email is john.doe@gmail.com") == "My email is john.doe@gmail.com")
        #expect(c.restore("open google.com please. then wait") == "Open google.com please. Then wait")
        #expect(c.restore("the file is notes.txt") == "The file is notes.txt")
        // A sentence end followed by a quote or a line break is still one.
        #expect(c.restore("u dedi.\nkeyin") == "U dedi.\nKeyin")
        // A closing modifier-letter quote too — the glyph `forDelivery` writes for one.
        #expect(c.restore("\u{02BC}salom.\u{02BC} keyingi gap.")
                == "\u{02BC}Salom.\u{02BC} Keyingi gap.")
        #expect(c.restore("u dedi.\u{02BB} keyin") == "U dedi.\u{02BB} Keyin")
    }

    @Test("an explicit lexicon capitalises names anywhere in a sentence")
    func lexicon() {
        let c = Capitaliser(alwaysCapitalised: ["toshkent", "samarqand"])
        #expect(c.restore("men toshkent va samarqand ko\u{02BB}rdim")
                == "Men Toshkent va Samarqand ko\u{02BB}rdim")
    }

    @Test("the lexicon stays out of the way of ordinary words")
    func lexiconIsNarrow() {
        let c = Capitaliser(alwaysCapitalised: ["toshkent"])
        #expect(c.restore("men uyga bordim") == "Men uyga bordim")
    }

    @Test("empty and punctuation-only input do not crash")
    func degenerate() {
        let c = Capitaliser()
        #expect(c.restore("") == "")
        #expect(c.restore("...") == "...")
        #expect(c.restore("   ") == "   ")
    }

    @Test("restoration never changes anything but letter case")
    func onlyCaseChanges() throws {
        // The guarantee that makes a deterministic capitaliser trustworthy where a model is
        // not: it cannot delete a clause, translate, or invent a word.
        let c = Capitaliser()
        for text in try realTranscripts() {
            let out = c.restore(text)
            #expect(out.count == text.count, "length changed for: \(text.prefix(50))")
            #expect(out.lowercased() == text.lowercased(),
                    "content changed for: \(text.prefix(50))")
        }
    }
}
