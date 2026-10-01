import Foundation
import Testing

@testable import KotibaCore

// Both response parsers return "" for any structure they cannot walk, and `polish()` mapped ""
// to `emptyResponse`. So "the model returned nothing" and "I could not read this at all" arrived
// identical — and the commonest cause of the second is a stream/non-stream mismatch, which is a
// setting the user can change reported as a model problem they cannot.

@Suite("An unreadable reply is not an empty one")
struct PolishResponseShapeTests {

    private func body(_ s: String) -> Data { Data(s.utf8) }

    @Test("asking for a stream and getting one JSON body names the setting to change")
    func streamExpectedJSONReceived() {
        let reason = PolishClient.unreadableReason(
            body(#"{"choices":[{"message":{"content":"hi"}}]}"#), streaming: true)
        #expect(reason != nil)
        #expect(reason?.contains("streaming off") == true, "reads as \(reason ?? "nil")")
    }

    @Test("getting a stream when none was asked for names the setting to change")
    func jsonExpectedStreamReceived() {
        let reason = PolishClient.unreadableReason(
            body("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\ndata: [DONE]\n"),
            streaming: false)
        #expect(reason != nil)
        #expect(reason?.contains("streaming on") == true, "reads as \(reason ?? "nil")")
    }

    @Test("a reply that is not JSON at all says so")
    func notJSON() {
        #expect(PolishClient.unreadableReason(body("<html>502 Bad Gateway</html>"),
                                              streaming: false) != nil)
    }

    @Test("a JSON reply with no choices names the keys it did find")
    func noChoices() {
        let reason = PolishClient.unreadableReason(
            body(#"{"error":{"message":"model decommissioned"},"id":"x"}"#), streaming: false)
        #expect(reason?.contains("choices") == true)
        #expect(reason?.contains("error") == true, "the keys present are the diagnosis")
    }

    // The case that must stay `emptyResponse`: the shape was fine and the model said nothing.
    @Test("a well-formed reply carrying an empty completion is not a shape problem")
    func genuinelyEmpty() {
        #expect(PolishClient.unreadableReason(
            body(#"{"choices":[{"message":{"content":""}}]}"#), streaming: false) == nil)
    }

    @Test("a well-formed stream carrying nothing is not a shape problem either")
    func genuinelyEmptyStream() {
        #expect(PolishClient.unreadableReason(body("data: [DONE]\n"), streaming: true) == nil)
    }
}
