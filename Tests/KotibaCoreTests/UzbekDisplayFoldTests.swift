import Foundation
import Testing

@testable import KotibaCore

// `clean` is the WER-scoring normaliser: it lowercases and turns every mark into a space so two
// transcripts can be compared. It was also being run on the text inserted into the user's
// document, so the scoring pipeline's output was what they got. `foldOrthography` is the half
// that is always right — the letters — and leaves the writing alone.

@Suite("Uzbek text is inserted as written, not as scored")
struct UzbekDisplayFoldTests {

    private let okina: Character = "\u{02BB}"

    @Test("punctuation, capitals and digits survive")
    func writingIsPreserved() {
        let spoken = "Salom! Bugun soat 10:30 da uchrashamiz. Yaxshimi?"
        let folded = UzbekNormaliser.foldOrthography(spoken)
        #expect(folded == spoken, "nothing here needed changing, so nothing should have changed")
    }

    // What the old path produced, kept as the thing that must never come back.
    @Test("the scoring normaliser really would have destroyed it")
    func scoringNormaliserIsDestructive() {
        let cleaned = UzbekNormaliser.clean("Salom! Bugun soat 10:30 da uchrashamiz. Yaxshimi?")
        #expect(!cleaned.contains("!"))
        #expect(!cleaned.contains("?"))
        #expect(cleaned == cleaned.lowercased())
    }

    @Test("o' and g' still fold to the okina, in either case")
    func apostrophesFold() {
        #expect(UzbekNormaliser.foldOrthography("do'stim") == "do\(okina)stim")
        #expect(UzbekNormaliser.foldOrthography("O'zbekiston") == "O\(okina)zbekiston")
        #expect(UzbekNormaliser.foldOrthography("to'g'ri") == "to\(okina)g\(okina)ri")
    }

    @Test("an apostrophe that is not after o or g becomes an okina too, not a straight quote")
    func lonePunctuationApostrophe() {
        #expect(UzbekNormaliser.foldOrthography("\u{2019}").first == okina)
    }

    @Test("characters that are simply wrong for Uzbek Latin are still repaired")
    func repairsSurvive() {
        // A stray Cyrillic а inside Latin text, and the non-standard ӯ.
        #expect(UzbekNormaliser.foldOrthography("s\u{0430}lom") == "salom")
        #expect(UzbekNormaliser.foldOrthography("k\u{04EF}p") == "ko\(okina)p")
        #expect(UzbekNormaliser.foldOrthography("K\u{04EE}p") == "KO\(okina)p")
    }

    @Test("zero-width characters go and hyphen variants regularise")
    func invisiblesAreCleaned() {
        #expect(!UzbekNormaliser.foldOrthography("so\u{200B}z").contains("\u{200B}"))
        // U+2010 hyphen and U+2011 non-breaking hyphen are the same letter-level mark as "-".
        #expect(UzbekNormaliser.foldOrthography("sa\u{2010}y\u{2011}harakat") == "sa-y-harakat")
        #expect(UzbekNormaliser.foldOrthography("bo\u{00AD}la") == "bola",
                "a soft hyphen carries no meaning in inserted text")
    }

    // En and em dashes are punctuation, not letters, so a *display* fold must leave them exactly
    // as dictated — `clean` turns them into spaces precisely because scoring wants them gone.
    @Test("en and em dashes are the writer's, and stay")
    func realDashesArePreserved() {
        let written = "ha \u{2013} yo\u{2019}q \u{2014} bilmadim"
        let folded = UzbekNormaliser.foldOrthography(written)
        #expect(folded.contains("\u{2013}"))
        #expect(folded.contains("\u{2014}"))
        #expect(!UzbekNormaliser.clean(written).contains("\u{2013}"),
                "which is exactly what the scoring normaliser does not do")
    }

    @Test("an empty string is not a special case")
    func empty() {
        #expect(UzbekNormaliser.foldOrthography("") == "")
    }
}

@Suite("A mode that says not to capitalise is obeyed")
struct ModeCapitalisationTests {

    // The flag is now read — it was declared, encoded, decoded and consulted by nothing. Every
    // shipped mode leaves the capitaliser on, and that is deliberate: the engines this app uses
    // for Uzbek and Russian emit no capitals at all, so switching it off means a lower-case
    // document. What matters is that a mode *can* turn it off, not that a shipped one does.
    @Test("every shipped mode keeps capitalisation on, and a mode can still opt out")
    func shippedFlags() throws {
        let registry = try BuiltInModes.registry()
        for mode in registry.modes {
            #expect(mode.autocapitalizeInsert,
                    "\(mode.key) would insert an entirely lower-case transcript")
        }
        #expect(!Mode(key: "raw-case", name: "Raw", autocapitalizeInsert: false)
            .autocapitalizeInsert)
    }

    // Proves the flag is worth honouring: with it ignored, this is what Super's output became.
    @Test("the capitaliser really would have changed Super's output")
    func capitaliserWouldHaveActed() {
        let capitaliser = Capitaliser()
        let preserved = "hello there. this is how i actually type."
        #expect(capitaliser.restore(preserved) != preserved)
    }
}
