import Foundation
import Testing

@testable import KotibaCore

// The measured corruptions, as tests.
//
// 7 of 14 real polishes of real Uzbek transcripts changed words the speaker did not say, and the
// general length-and-script guard caught 1 of them. The cases below are the real ones.

@Suite("Uzbek polish guard — the corruptions the general guard misses")
struct UzbekPolishGuardTests {

    @Test("the measured qwen corruption is caught")
    func catchesTheMeasuredFailure() {
        // qwen2.5:3b rewrote this, inventing two words and pulling both toward Turkish.
        let original = "bugun kechqurun uyga boraman chunki charchadim"
        let polished = "Bugun keçşurun uyga boraman, chunkı charchadim."

        let verdict = UzbekPolishGuard.check(polished, against: original)
        guard case .inventedWords(let words) = verdict else {
            Issue.record("the guard accepted a known corruption")
            return
        }
        #expect(words.contains("keçşurun"))
        #expect(words.contains("chunkı"))
        #expect(verdict.reason.contains("did not say"))
    }

    @Test("the general guard cannot see it, which is why this one exists")
    func generalGuardMissesIt() {
        // Same length, same script. Length ratio and ScriptCheck have nothing to work with —
        // an invented Uzbek word looks exactly like a real one.
        let original = "bugun kechqurun uyga boraman chunki charchadim"
        let polished = "Bugun keçşurun uyga boraman, chunkı charchadim."
        #expect(PolishGuard().check(polished, against: original) == nil,
                "if the general guard now catches this, the special one may be redundant")
    }

    @Test("legitimate corrections pass")
    func acceptsRealCorrections() {
        // Capitalisation, punctuation and filler removal are the whole point of a polish pass
        // and must not be rejected.
        let original = "assalomu alaykum doʻstim yaxshimisiz um ahvollaring yaxshimi"
        let polished = "Assalomu alaykum, doʻstim! Yaxshimisiz? Ahvollaring yaxshimi?"
        #expect(UzbekPolishGuard.check(polished, against: original).isAccepted)
    }

    @Test("an apostrophe swap is a repair, not an invention")
    func apostrophesAreFolded() {
        // whisper emits an ASCII apostrophe where Uzbek wants the okina, and a model may
        // "correct" it either way. Both spellings are the same word, so neither is an invention.
        let original = "put menyusi o'zgacha bo'ladi"
        let polished = "Put menyusi oʻzgacha boʻladi."
        #expect(UzbekPolishGuard.check(polished, against: original).isAccepted)

        #expect(UzbekPolishGuard.foldApostrophes("o'zgacha") == "oʻzgacha")
        #expect(UzbekPolishGuard.foldApostrophes("o‘zgacha") == "oʻzgacha")
        #expect(UzbekPolishGuard.foldApostrophes("o’zgacha") == "oʻzgacha")
    }

    @Test("dropping a filler is allowed; adding a word is not")
    func removalsAreFineAdditionsAreNot() {
        // Asymmetric on purpose. A correction pass legitimately deletes fillers, so a word
        // vanishing is expected; a word appearing is either a translation or an invention.
        #expect(UzbekPolishGuard.check("salom doʻstim", against: "salom um doʻstim").isAccepted)

        guard case .inventedWords = UzbekPolishGuard.check("salom aziz doʻstim",
                                                           against: "salom doʻstim") else {
            Issue.record("an added word was accepted")
            return
        }
    }

    @Test("a translation into Turkish is caught wholesale")
    func catchesTranslation() {
        let verdict = UzbekPolishGuard.check("Merhaba arkadaşım nasılsın",
                                             against: "assalomu alaykum doʻstim yaxshimisiz")
        #expect(!verdict.isAccepted)
    }

    @Test("splitting a run-together word is allowed — it is the fix, not the failure")
    func splitsAreAllowed() {
        // Measured on real Uzbek transcripts from the GAP-01 set. ASR runs words together and
        // pulling them apart is one of the most useful things a correction pass does; a rule
        // that only compared whole words rejected roughly a third of *correct* polishes.
        #expect(UzbekPolishGuard.check("bir-ikki sudga borsang",
                                       against: "birikki sudga borsang").isAccepted)
        #expect(UzbekPolishGuard.check("Buni eshitganmisiz? Ayasi yoʻq.",
                                       against: "buni eshitganmisizayasi yoʻq").isAccepted)
    }

    @Test("a split is allowed but an invention that merely starts the same is not")
    func splitRuleIsNotALoophole() {
        // The relaxation must not become a hole. An invention is not a substring of anything
        // that was said: keçşurun is nowhere inside kechqurun.
        let verdict = UzbekPolishGuard.check("bugun keçşurun uyga boraman",
                                             against: "bugun kechqurun uyga boraman")
        #expect(!verdict.isAccepted)

        // And a fragment shorter than three characters is never evidence — "a" is inside
        // almost every word.
        #expect(!UzbekPolishGuard.isSplitOf("a", ["assalomu"]))
        #expect(UzbekPolishGuard.isSplitOf("salomu", ["assalomu"]))
        // Equal length is not a split, it is a replacement.
        #expect(!UzbekPolishGuard.isSplitOf("assalomu", ["assalomu"]))
    }

    @Test("the real on-device corruption is still caught after the relaxation")
    func liveModelCorruptionStillCaught() {
        // What Apple's on-device model actually produced, 2026-08-08: assalomu became an
        // Arabic transliteration and the okina was dropped from doʻstim.
        let verdict = UzbekPolishGuard.check(
            "As-salamu alaykum, dostim, yaxshimisiz",
            against: "assalomu alaykum doʻstim yaxshimisiz")
        guard case .inventedWords(let words) = verdict else {
            Issue.record("the live corruption was accepted")
            return
        }
        #expect(words.contains("salamu") || words.contains("dostim"))
    }

    @Test("case and punctuation alone never trip it")
    func punctuationIsFree() {
        #expect(UzbekPolishGuard.check("Salom, Doʻstim!", against: "salom doʻstim").isAccepted)
    }
}

@Suite("Composite polisher picks by language")
struct CompositePolisherTests {

    private struct Stub: PolishEngine {
        let polishID: String
        let supportedLanguages: Set<Language>
        var fails = false
        func polish(_ text: String, language: Language, instructions: String) async throws
            -> String {
            if fails { throw PolishFailure.emptyResponse(endpoint: polishID) }
            return "\(polishID):\(text)"
        }
    }

    @Test("a language the first member does not claim falls through to the next")
    func fallsThrough() async throws {
        // The real case: Apple's on-device model claims 23 locales and neither Russian nor
        // Uzbek is among them. Choosing it outright would strip polish from two of three
        // languages, silently.
        let composite = CompositePolisher([
            Stub(polishID: "apple-on-device", supportedLanguages: [.english]),
            Stub(polishID: "cloud", supportedLanguages: Set(Language.allCases)),
        ])
        #expect(try await composite.polish("x", language: .english, instructions: "i")
                == "apple-on-device:x")
        #expect(try await composite.polish("x", language: .russian, instructions: "i")
                == "cloud:x")
    }

    @Test("the union is what it claims to support")
    func union() {
        let composite = CompositePolisher([
            Stub(polishID: "a", supportedLanguages: [.english]),
            Stub(polishID: "b", supportedLanguages: [.russian]),
        ])
        #expect(composite.supportedLanguages == [.english, .russian])
    }

    @Test("a member that throws does not end it")
    func recoversFromFailure() async throws {
        let composite = CompositePolisher([
            Stub(polishID: "broken", supportedLanguages: [.english], fails: true),
            Stub(polishID: "working", supportedLanguages: [.english]),
        ])
        #expect(try await composite.polish("x", language: .english, instructions: "i")
                == "working:x")
    }

    // Recovering is right; recovering in silence is not. Someone who turned on "prefer the
    // on-device model" did so to keep their dictation off the network, and a quiet failover sends
    // it there anyway. `polishID` cannot say — it is the joined member list, so diagnostics read
    // "apple-on-device+llama-3.3-70b+llama-3.1-8b" whichever one ran.
    @Test("falling back to another member is recorded, not silent")
    func fallbackIsRecorded() async throws {
        let composite = CompositePolisher([
            Stub(polishID: "apple-on-device", supportedLanguages: [.english], fails: true),
            Stub(polishID: "cloud", supportedLanguages: [.english]),
        ])
        _ = try await composite.polish("x", language: .english, instructions: "i")
        let notes = await composite.drainNotes()
        #expect(notes.count == 1, "the failover must leave exactly one remark: \(notes)")
        #expect(notes[0].contains("cloud"), "which member actually ran")
        #expect(notes[0].contains("apple-on-device"), "and which one it replaced")
    }

    @Test("draining twice does not repeat a note into a later dictation")
    func notesAreDrained() async throws {
        let composite = CompositePolisher([
            Stub(polishID: "broken", supportedLanguages: [.english], fails: true),
            Stub(polishID: "working", supportedLanguages: [.english]),
        ])
        _ = try await composite.polish("x", language: .english, instructions: "i")
        _ = await composite.drainNotes()
        #expect(await composite.drainNotes().isEmpty)
    }

    @Test("a first-choice member that works says nothing")
    func noFallbackNoNote() async throws {
        let composite = CompositePolisher([
            Stub(polishID: "apple-on-device", supportedLanguages: [.english]),
            Stub(polishID: "cloud", supportedLanguages: [.english]),
        ])
        _ = try await composite.polish("x", language: .english, instructions: "i")
        #expect(await composite.drainNotes().isEmpty,
                "the ordinary path must not add noise to every record")
    }

    @Test("no member for the language throws rather than returning the input unchanged")
    func noMemberThrows() async {
        let composite = CompositePolisher([Stub(polishID: "a", supportedLanguages: [.english])])
        await #expect(throws: (any Error).self) {
            _ = try await composite.polish("x", language: .uzbek, instructions: "i")
        }
    }
}
