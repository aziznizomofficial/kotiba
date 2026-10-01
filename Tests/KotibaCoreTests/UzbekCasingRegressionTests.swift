import Foundation
import Testing

@testable import KotibaCore

// Measured from 24 real Uzbek dictations in this Mac's diagnostics.jsonl: the Uzbek model emits
// **all lowercase** (0 of 24 raw transcripts contained a single uppercase letter) but **does**
// emit sentence punctuation (23 of 24). Every one of the 24 was inserted capitalised, because
// `Capitaliser` ran.
//
// So the deterministic capitaliser is not cosmetic here — it is the only thing standing between
// the user and an all-lowercase document. Any mode flag that switches it off has to be judged
// against that, not against what the flag's name suggests.

@Suite("Uzbek arrives capitalised, because the engine never capitalises anything")
struct UzbekCasingRegressionTests {

    /// Exactly what the Uzbek model produced on 2026-08-18, from diagnostics.
    private let asTheEngineEmitsIt =
        "assalomu alaykum. xo'p, bu stt programma bo'ladi. ai asosida ishlangan, nomi kotib."

    @Test("the shipped default mode does not switch capitalisation off")
    func defaultModeStillCapitalises() throws {
        // Super is `defaultModeKey` out of the box and on this Mac. It shipped
        // `autocapitalizeInsert: false`, which had never once taken effect — the flag was read by
        // nothing. Honouring it without changing it would have made every Uzbek dictation in the
        // default mode arrive entirely in lower case.
        let registry = try BuiltInModes.registry()
        let superMode = try #require(registry.mode(for: "super"))
        #expect(superMode.autocapitalizeInsert,
                "Super is the default mode; switching the capitaliser off here makes every Uzbek dictation arrive entirely in lower case")
    }

    @Test("the pipeline capitalises sentences the engine left flat")
    func sentencesAreRestored() {
        let folded = UzbekNormaliser.foldOrthography(asTheEngineEmitsIt)
        let result = Capitaliser(alwaysCapitalised: ["kotib"]).restore(folded)

        #expect(result.hasPrefix("Assalomu"), "\(result)")
        #expect(result.contains("Xo\u{02BB}p"), "sentence starts after a full stop: \(result)")
        #expect(result.contains("Kotib"), "vocabulary keeps its capital: \(result)")
    }

    // The other half of the same change: punctuation now survives to the user. Together these are
    // what the 2026-08-11 build already produced, so the branch must not read as a regression
    // against it.
    @Test("punctuation the engine emitted still reaches the user")
    func punctuationSurvives() {
        let folded = UzbekNormaliser.foldOrthography(asTheEngineEmitsIt)
        #expect(folded.contains("."))
        #expect(folded.contains(","))
        #expect(folded.contains("o\u{02BB}p"), "and o' still folds to the okina")
    }

    @Test("a mode may still opt out, which is what the flag is for")
    func optOutStillPossible() {
        let raw = Mode(key: "raw-case", name: "Raw case", autocapitalizeInsert: false)
        #expect(!raw.autocapitalizeInsert)
    }
}
