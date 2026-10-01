import Foundation

// Tasks P-02, P-03 and S-09. The optional polish step, as an OpenAI-compatible client.
//
// D-07: Kotiba hosts no inference and holds no credential of its own. Whoever wants transform
// modes supplies their own endpoint, key and model. That keeps Kotiba out of the data-processor
// role entirely — no per-user cost, no uptime obligation, and nothing to disclose beyond "if
// you configure this, your text goes to the endpoint you chose".
//
// The endpoint is a SETTING, not a constant. A Gonka key means nothing without knowing which
// broker issued it; the same is true of any OpenAI-compatible proxy. That cost an hour to learn
// once and is not worth learning twice.
//
// The accepted cost of BYO-key is support: someone else's failing key will look like a Kotiba
// bug. So every failure names the endpoint and the real error, and the deadline outcome
// distinguishes a throw from a timeout — an earlier version conflated them and reported a bad
// API key as an eight-second overrun.

public struct PolishConfiguration: Sendable, Codable, Equatable {
    /// e.g. `https://api.openai.com/v1` or a broker's own base. No trailing slash required.
    public var baseURL: String
    public var model: String
    /// Streaming is not optional for some brokers: one measured endpoint kills any request
    /// that produces no bytes for 150 s, and a non-streamed long completion trips it. Arriving
    /// tokens reset that timer; silence does not.
    public var stream: Bool
    public var maxTokens: Int
    public var temperature: Double

    public init(baseURL: String, model: String, stream: Bool = true,
                maxTokens: Int = 1024, temperature: Double = 0.2) {
        self.baseURL = baseURL
        self.model = model
        self.stream = stream
        self.maxTokens = maxTokens
        self.temperature = temperature
    }

    var completionsURL: URL? {
        let trimmed = baseURL.trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: trimmed + "/chat/completions")
    }
}

public enum PolishFailure: Error, Sendable, Equatable {
    case notConfigured
    case badEndpoint(String)
    case unauthorised(endpoint: String)
    case http(status: Int, endpoint: String, body: String)
    /// The endpoint no longer serves the configured model. Groq retired both of Kotiba's shipped
    /// names before 2026-08-22 and every polish for two days ended here, reported as a bare
    /// 404 with a JSON body — true, and nothing the user could act on.
    case modelNotServed(model: String, endpoint: String)
    case transport(endpoint: String, message: String)
    case emptyResponse(endpoint: String)
    /// The endpoint answered, and the answer was not in a shape this client can read.
    ///
    /// Distinct from `emptyResponse`, which used to absorb it: both parsers return "" for any
    /// structure they cannot walk, so "the model returned nothing" and "I could not understand
    /// this at all" arrived identical. The commonest cause is a stream/non-stream mismatch —
    /// asking for SSE and being handed one JSON body, or the reverse — which is a configuration
    /// problem the user can fix, reported as a model problem they cannot.
    case unreadableResponse(endpoint: String, detail: String)

    /// Always names the endpoint. When someone else's key fails, the message must not read as
    /// though Kotiba is broken.
    public var reason: String {
        switch self {
        case .notConfigured:
            return "no polish endpoint is configured"
        case .badEndpoint(let s):
            return "the polish endpoint is not a usable URL: \(s)"
        case .unauthorised(let e):
            return "\(e) rejected the API key (401). Check the key belongs to that endpoint."
        case .http(let status, let e, let body):
            return "\(e) returned HTTP \(status): \(body.prefix(200))"
        case .modelNotServed(let model, let e):
            return "\(e) no longer serves the model \(model). Choose one it does serve in "
                + "Settings › Clean-up."
        case .transport(let e, let message):
            return "could not reach \(e): \(message)"
        case .emptyResponse(let e):
            return "\(e) returned no content"
        case .unreadableResponse(let e, let detail):
            return "\(e) answered in a shape Kotiba could not read — \(detail)"
        }
    }
}

/// The HTTP surface, abstracted so tests never open a socket.
public protocol PolishTransport: Sendable {
    func post(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: PolishTransport {
    private let session: URLSession

    public init(timeout: TimeInterval = 30) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        // P-03: keep the connection warm. Measured worth ~150–190 ms of the round trip.
        config.httpMaximumConnectionsPerHost = 2
        session = URLSession(configuration: config)
    }

    public func post(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PolishFailure.transport(endpoint: request.url?.absoluteString ?? "?",
                                          message: "not an HTTP response")
        }
        return (data, http)
    }
}

public struct PolishClient: PolishEngine {
    public let polishID: String
    public var supportedLanguages: Set<Language>

    private let configuration: PolishConfiguration
    private let apiKey: String
    private let transport: any PolishTransport

    public init(configuration: PolishConfiguration, apiKey: String,
                transport: any PolishTransport = URLSessionTransport(),
                supportedLanguages: Set<Language> = Set(Language.allCases)) {
        self.configuration = configuration
        self.apiKey = apiKey
        self.transport = transport
        self.supportedLanguages = supportedLanguages
        self.polishID = configuration.model
    }

    public func polish(_ text: String, language: Language, instructions: String) async throws -> String {
        let content = try await complete(system: instructions, user: text)
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw PolishFailure.emptyResponse(endpoint: configuration.baseURL)
        }
        return content
    }

    /// Why an empty parse was empty, when the body says it was not the model's doing.
    ///
    /// Returns nil when the body really did carry an empty completion — that is
    /// `emptyResponse`, and it stays that. Everything else here is a shape problem, and naming
    /// it is the difference between a setting the user can change and a model they cannot.
    static func unreadableReason(_ data: Data, streaming: Bool) -> String? {
        let body = String(decoding: data, as: UTF8.self)
        let looksStreamed = body.contains("data:")
        let asJSON = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]

        if streaming, !looksStreamed, asJSON != nil {
            return "Kotiba asked for a stream and got a single JSON body; turn streaming off "
                + "for this endpoint"
        }
        if !streaming, looksStreamed, asJSON == nil {
            return "the endpoint streamed its answer when Kotiba did not ask it to; turn "
                + "streaming on for this endpoint"
        }
        if !streaming, asJSON == nil {
            return "the body is not JSON"
        }
        if !streaming, let asJSON, asJSON["choices"] == nil {
            let keys = asJSON.keys.sorted().prefix(6).joined(separator: ", ")
            return "no `choices` in the reply (top-level keys: \(keys))"
        }
        if streaming, !looksStreamed {
            return "no server-sent events in the reply"
        }
        return nil
    }

    /// S-09's `Test` button. A completion, never `GET /models` — some providers answer that
    /// 200 with no key at all, so it proves nothing.
    public func verifyKey() async throws -> String {
        try await complete(system: "Reply with the single word: ok",
                           user: "ok")
    }

    private func complete(system: String, user: String) async throws -> String {
        guard let url = configuration.completionsURL else {
            throw PolishFailure.badEndpoint(configuration.baseURL)
        }
        guard !apiKey.isEmpty else { throw PolishFailure.notConfigured }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": configuration.model,
            "max_tokens": configuration.maxTokens,
            "temperature": configuration.temperature,
            "stream": configuration.stream,
            "messages": [
                ["role": "system", "content": system],
                ["role": "user", "content": user],
            ],
        ])

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.post(request)
        } catch let failure as PolishFailure {
            throw failure
        } catch {
            throw PolishFailure.transport(endpoint: url.absoluteString,
                                          message: error.localizedDescription)
        }

        switch response.statusCode {
        case 200..<300:
            break
        case 401, 403:
            throw PolishFailure.unauthorised(endpoint: url.absoluteString)
        case 404 where String(decoding: data, as: UTF8.self).contains("model_not_found"):
            throw PolishFailure.modelNotServed(model: configuration.model,
                                               endpoint: url.absoluteString)
        default:
            throw PolishFailure.http(status: response.statusCode, endpoint: url.absoluteString,
                                     body: String(decoding: data, as: UTF8.self))
        }

        let content = configuration.stream
            ? Self.contentFromSSE(data)
            : Self.contentFromJSON(data)
        // Both parsers return "" for any structure they cannot walk, so an empty result has to be
        // interrogated rather than believed: a shape problem the user can fix must not be
        // reported as the model having said nothing.
        if content.isEmpty,
           let detail = Self.unreadableReason(data, streaming: configuration.stream) {
            throw PolishFailure.unreadableResponse(endpoint: configuration.baseURL, detail: detail)
        }
        return content
    }

    // MARK: Response shapes

    static func contentFromJSON(_ data: Data) -> String {
        guard
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let choices = root["choices"] as? [[String: Any]],
            let message = choices.first?["message"] as? [String: Any],
            let content = message["content"] as? String
        else { return "" }
        return content
    }

    /// Server-sent events: `data: {json}` lines terminated by `data: [DONE]`.
    ///
    /// Reasoning models put their thinking in `reasoning_content` and their answer in
    /// `content`; one measured model writes its thinking into `content` inside a `<think>`
    /// block instead. Only `content` is accumulated, and a leading `<think>…</think>` is
    /// stripped, because the user asked for tidied text and not for the model's monologue.
    static func contentFromSSE(_ data: Data) -> String {
        var out = ""
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { break }
            guard
                let chunk = payload.data(using: .utf8),
                let root = try? JSONSerialization.jsonObject(with: chunk) as? [String: Any],
                let choices = root["choices"] as? [[String: Any]],
                let delta = choices.first?["delta"] as? [String: Any],
                let piece = delta["content"] as? String
            else { continue }
            out += piece
        }
        return stripThinking(out)
    }

    static func stripThinking(_ text: String) -> String {
        guard let open = text.range(of: "<think>"),
              let close = text.range(of: "</think>", range: open.upperBound..<text.endIndex)
        else { return text }
        let remainder = String(text[close.upperBound...])
        return remainder.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// `"\(error)"` is this codebase's interchange format at the module boundaries — 23 sites convert
// that way — and for an `Error` enum without `CustomStringConvertible` it reflects the case name
// instead of the diagnosis. A denied microphone reached the user as
// `engineFailedToStart("permissionDenied")`, which appears verbatim in real diagnostics. Each of
// these types already writes the actionable sentence in `reason`; this is what makes the
// interchange format use it, with no call-site changes.

extension PolishFailure: CustomStringConvertible {
    public var description: String { reason }
}
