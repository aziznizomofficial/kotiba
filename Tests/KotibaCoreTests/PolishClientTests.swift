import Foundation
import Testing

@testable import KotibaCore

// No sockets. The transport is injected, so every branch — including the ones a real endpoint
// would only show you at 3am — is reachable in a millisecond.

private struct FakeTransport: PolishTransport {
    var status: Int = 200
    var body: Data = Data()
    var throwsTransport: Bool = false
    /// Captured so the request shape can be asserted.
    let seen: Recorder

    final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var _requests: [URLRequest] = []
        var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return _requests }
        func record(_ r: URLRequest) { lock.lock(); _requests.append(r); lock.unlock() }
    }

    struct Boom: Error { var localizedDescription: String { "connection refused" } }

    func post(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        seen.record(request)
        if throwsTransport { throw Boom() }
        let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                       httpVersion: nil, headerFields: nil)!
        return (body, response)
    }
}

private func sse(_ pieces: [String]) -> Data {
    var out = ""
    for p in pieces {
        let json = try! JSONSerialization.data(withJSONObject: [
            "choices": [["delta": ["content": p]]]
        ])
        out += "data: " + String(decoding: json, as: UTF8.self) + "\n\n"
    }
    out += "data: [DONE]\n"
    return Data(out.utf8)
}

private func plainJSON(_ content: String) -> Data {
    try! JSONSerialization.data(withJSONObject: [
        "choices": [["message": ["role": "assistant", "content": content]]]
    ])
}

private func client(_ transport: FakeTransport, stream: Bool = true,
                    key: String = "sk-test") -> PolishClient {
    PolishClient(
        configuration: PolishConfiguration(baseURL: "https://example.test/v1",
                                           model: "some-model", stream: stream),
        apiKey: key, transport: transport)
}

@Suite("Polish client — bring your own key")
struct PolishClientTests {

    @Test("a streamed response is reassembled in order")
    func streamed() async throws {
        let t = FakeTransport(body: sse(["Hello", ", ", "world."]), seen: .init())
        let out = try await client(t).polish("hello world", language: .english,
                                             instructions: "tidy")
        #expect(out == "Hello, world.")
    }

    @Test("a non-streamed response is read from the message body")
    func nonStreamed() async throws {
        let t = FakeTransport(body: plainJSON("Salom, dunyo."), seen: .init())
        let out = try await client(t, stream: false).polish("salom dunyo", language: .uzbek,
                                                            instructions: "tidy")
        #expect(out == "Salom, dunyo.")
    }

    @Test("the request carries the key, the model and the OpenAI-compatible shape")
    func requestShape() async throws {
        let t = FakeTransport(body: sse(["ok"]), seen: .init())
        _ = try await client(t).polish("x", language: .english, instructions: "be terse")

        let request = t.seen.requests.first
        #expect(request?.url?.absoluteString == "https://example.test/v1/chat/completions")
        #expect(request?.value(forHTTPHeaderField: "Authorization") == "Bearer sk-test")
        let body = try JSONSerialization.jsonObject(with: request!.httpBody!) as! [String: Any]
        #expect(body["model"] as? String == "some-model")
        #expect(body["stream"] as? Bool == true)
        let messages = body["messages"] as! [[String: String]]
        #expect(messages.first?["role"] == "system")
        #expect(messages.first?["content"] == "be terse")
        #expect(messages.last?["content"] == "x")
    }

    @Test("a trailing slash on the base URL does not produce a double slash")
    func urlJoining() async throws {
        let t = FakeTransport(body: sse(["ok"]), seen: .init())
        let c = PolishClient(
            configuration: PolishConfiguration(baseURL: "https://example.test/v1/",
                                               model: "m"),
            apiKey: "k", transport: t)
        _ = try? await c.polish("x", language: .english, instructions: "y")
        #expect(t.seen.requests.first?.url?.absoluteString
                == "https://example.test/v1/chat/completions")
    }

    @Test("a 401 names the endpoint and says the key may not belong to it")
    func unauthorised() async {
        let t = FakeTransport(status: 401, seen: .init())
        do {
            _ = try await client(t).polish("x", language: .english, instructions: "y")
            Issue.record("expected a failure")
        } catch let failure as PolishFailure {
            #expect(failure == .unauthorised(endpoint: "https://example.test/v1/chat/completions"))
            #expect(failure.reason.contains("example.test"))
            #expect(failure.reason.contains("belongs to that endpoint"))
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    @Test("any other HTTP error carries the status, the endpoint and the body")
    func httpError() async {
        let t = FakeTransport(status: 500, body: Data("upstream exploded".utf8), seen: .init())
        do {
            _ = try await client(t).polish("x", language: .english, instructions: "y")
            Issue.record("expected a failure")
        } catch let failure as PolishFailure {
            #expect(failure.reason.contains("500"))
            #expect(failure.reason.contains("example.test"))
            #expect(failure.reason.contains("upstream exploded"))
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    @Test("a retired model is named as a setting to change, not as an HTTP status")
    func modelNotServed() async {
        // Verbatim from Groq, 2026-08-22, after it retired both models Kotiba shipped with. The
        // user's diagnostics carried this 404 on every polish for two days, reported as
        // "returned HTTP 404: {json}" — true, and useless.
        let body = """
        {"error":{"message":"The model `some-model` does not exist or you do not have access \
        to it.","type":"invalid_request_error","code":"model_not_found"}}
        """
        let t = FakeTransport(status: 404, body: Data(body.utf8), seen: .init())
        do {
            _ = try await client(t).polish("x", language: .english, instructions: "y")
            Issue.record("expected a failure")
        } catch let failure as PolishFailure {
            #expect(failure == .modelNotServed(model: "some-model",
                                               endpoint: "https://example.test/v1/chat/completions"))
            #expect(failure.reason.contains("some-model"))
            #expect(failure.reason.contains("no longer serves"))
            #expect(failure.reason.contains("Settings"))
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    @Test("a 404 that is not about the model stays a plain HTTP error")
    func otherNotFound() async {
        let t = FakeTransport(status: 404, body: Data("no such route".utf8), seen: .init())
        do {
            _ = try await client(t).polish("x", language: .english, instructions: "y")
            Issue.record("expected a failure")
        } catch let failure as PolishFailure {
            #expect(failure.reason.contains("404"))
            #expect(failure.reason.contains("no such route"))
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    @Test("a transport failure names the endpoint rather than looking like a Kotiba bug")
    func transportFailure() async {
        let t = FakeTransport(throwsTransport: true, seen: .init())
        do {
            _ = try await client(t).polish("x", language: .english, instructions: "y")
            Issue.record("expected a failure")
        } catch let failure as PolishFailure {
            #expect(failure.reason.contains("could not reach"))
            #expect(failure.reason.contains("example.test"))
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    @Test("an empty key fails before any request is made")
    func emptyKey() async {
        let t = FakeTransport(seen: .init())
        do {
            _ = try await client(t, key: "").polish("x", language: .english, instructions: "y")
            Issue.record("expected a failure")
        } catch let failure as PolishFailure {
            #expect(failure == .notConfigured)
            #expect(t.seen.requests.isEmpty, "no request may be sent without a key")
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    @Test("a 200 with no content is a failure, not an empty polish")
    func emptyContent() async {
        let t = FakeTransport(body: sse([]), seen: .init())
        do {
            _ = try await client(t).polish("x", language: .english, instructions: "y")
            Issue.record("expected a failure")
        } catch let failure as PolishFailure {
            #expect(failure.reason.contains("no content"))
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    @Test("verifyKey uses a real completion — GET /models proves nothing")
    func verifyUsesCompletion() async throws {
        // Measured: some providers answer GET /models with 200 and no key at all.
        let t = FakeTransport(body: sse(["ok"]), seen: .init())
        _ = try await client(t).verifyKey()
        #expect(t.seen.requests.first?.httpMethod == "POST")
        #expect(t.seen.requests.first?.url?.lastPathComponent == "completions")
    }
}

@Suite("Reasoning-model response shapes")
struct ReasoningShapeTests {

    @Test("a <think> block is stripped and only the answer survives")
    func stripsThinking() {
        // One measured model writes its reasoning into `content` inside <think>…</think>
        // rather than into a separate field. The user asked for tidied text, not a monologue.
        let out = PolishClient.stripThinking("<think>weighing options</think>\n\nHello, world.")
        #expect(out == "Hello, world.")
    }

    @Test("text with no think block is untouched")
    func noThinkBlock() {
        #expect(PolishClient.stripThinking("Hello, world.") == "Hello, world.")
    }

    @Test("an unterminated think block is left alone rather than silently swallowing everything")
    func unterminated() {
        let text = "<think>never closed and then some text"
        #expect(PolishClient.stripThinking(text) == text)
    }

    @Test("deltas that carry reasoning_content but no content contribute nothing")
    func reasoningContentIgnored() {
        // Streaming reasoning models emit reasoning_content first; only content is the answer.
        let payload = """
        data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}

        data: {"choices":[{"delta":{"content":"Answer."}}]}

        data: [DONE]
        """
        #expect(PolishClient.contentFromSSE(Data(payload.utf8)) == "Answer.")
    }

    @Test("malformed SSE lines are skipped rather than aborting the whole response")
    func malformedLinesSkipped() {
        let payload = """
        data: not json at all

        data: {"choices":[{"delta":{"content":"Good"}}]}

        garbage line

        data: {"choices":[{"delta":{"content":" part."}}]}

        data: [DONE]
        """
        #expect(PolishClient.contentFromSSE(Data(payload.utf8)) == "Good part.")
    }
}
