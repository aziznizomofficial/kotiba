import Foundation
import Testing

@testable import KotibaCore

// Ten error enums each hand-write an actionable `reason`, and exactly none of them conformed to
// `CustomStringConvertible`. The interchange format at every module boundary is `"\(error)"` —
// 23 sites — which for such an enum reflects the case name instead. Real diagnostics on this Mac
// contain the result six times over: `engineFailedToStart("permissionDenied")`, which tells the
// user nothing and names no pane to open.
//
// KotibaCore can only reach its own error types; the same conformance was added to the audio,
// platform, engines and models ones, and this is the rule they all now follow.

@Suite("An error interpolated into a string says what to do about it")
struct ErrorDescriptionTests {

    @Test("PolishFailure reads as its reason, not as its case name")
    func polishFailure() {
        let failure = PolishFailure.emptyResponse(endpoint: "https://api.groq.com")
        #expect("\(failure)" == failure.reason)
        #expect(!"\(failure)".hasPrefix("emptyResponse("),
                "reflection is what the user was being shown")
    }

    @Test("HistoryError reads as its reason")
    func historyError() {
        let failure = HistoryError.cannotOpen("/nowhere/history.sqlite")
        #expect("\(failure)" == failure.reason)
        #expect("\(failure)".contains("/nowhere/history.sqlite"))
    }

    @Test("TemplateError reads as its reason")
    func templateError() {
        let failure = TemplateError.unknownVariable("nonsense")
        #expect("\(failure)" == failure.reason)
    }

    // The property the whole change exists for: a message a person can act on, with no
    // Swift-shaped punctuation in it.
    @Test("no error description reads like a debugger dump")
    func nothingReflects() {
        let failures: [any Error] = [
            PolishFailure.emptyResponse(endpoint: "https://example.invalid"),
            HistoryError.sql("no such table: entries"),
            TemplateError.unknownVariable("x"),
        ]
        for failure in failures {
            let text = "\(failure)"
            #expect(!text.contains("(\""), "reads as a dump: \(text)")
            #expect(text.count > 12, "too terse to act on: \(text)")
        }
    }
}
