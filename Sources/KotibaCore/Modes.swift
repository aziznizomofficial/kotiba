import Foundation

// Tasks M-01, M-02, M-03, M-05.
//
// One flat JSON file per mode, the filename stem equal to the key.
//
// a commercial dictation app has no template variables at all — 0 of 60 rendered prompts on disk contain
// `{{`, and its docs page has no interpolation syntax. Sections are appended in a fixed order
// under uppercase headers, so the transcript can only ever go last, and correctness rests on
// the LLM resolving English prose references to those headers — which its own documentation
// concedes weak models fail at. Kotiba ships real interpolation instead, and validates it when
// the mode is saved rather than discovering the problem mid-dictation.

// MARK: - Forward compatibility

/// Minimal JSON tree, kept only so unknown fields survive a round trip.
///
/// A3 established that a commercial dictation app's 27-field schema is "a floor, not a current schema" —
/// v2.12 through v2.17 demonstrably added fields. The same will happen here, and a mode file
/// written by a newer Kotiba must not be quietly destroyed by an older one that decodes it,
/// drops what it does not recognise, and writes it back.
public enum JSONValue: Sendable, Codable, Equatable {
    case string(String), number(Double), bool(Bool), array([JSONValue])
    case object([String: JSONValue]), null

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "unrepresentable JSON")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}

// MARK: - M-02 Prompt templates

public struct PromptVariable: Sendable, Hashable {
    public let name: String
    public init(_ name: String) { self.name = name }

    public static let transcript = PromptVariable("transcript")
    public static let selection = PromptVariable("selection")
    public static let clipboard = PromptVariable("clipboard")
    public static let app = PromptVariable("app")
    public static let window = PromptVariable("window")
    public static let datetime = PromptVariable("datetime")
    public static let locale = PromptVariable("locale")
    public static let language = PromptVariable("language")
    /// What the focused application expects — see `AppKnowledge`. Large formatting leverage for
    /// zero per-app code.
    public static let appFormat = PromptVariable("appFormat")
    /// The person dictating, so a mode that signs an email signs it correctly.
    public static let user = PromptVariable("user")
    /// What the caret is sitting in — "Enter a prompt for Gemini", "To:", "Search".
    public static let field = PromptVariable("field")
    /// Proper nouns visible on screen. Spelling help only, never substitution.
    public static let names = PromptVariable("names")

    public static let all: Set<PromptVariable> = [
        user, field, names,
        .transcript, .selection, .clipboard, .app, .window, .datetime, .locale, .language,
        .appFormat,
    ]
}

public enum TemplateError: Error, Sendable, Equatable {
    case unknownVariable(String)
    case unclosedPlaceholder
    /// A mode that never interpolates the transcript cannot be a dictation mode.
    case missingTranscript

    public var reason: String {
        switch self {
        case .unknownVariable(let n):
            let known = PromptVariable.all.map(\.name).sorted().joined(separator: ", ")
            return "unknown variable {{\(n)}} — available: \(known)"
        case .unclosedPlaceholder:
            return "a {{ was never closed"
        case .missingTranscript:
            return "the template never uses {{transcript}}, so the dictation would be discarded"
        }
    }
}

/// Everything a template may refer to. Split in time on purpose: `selection` and `clipboard`
/// are captured at recording *start*, `app` and `window` *after* transcription — which keeps
/// the Accessibility-tree walk off the latency-critical path and makes the app context
/// describe where the text will actually land.
public struct PromptContext: Sendable {
    public var transcript: String
    public var selection: String
    public var clipboard: String
    public var app: String
    public var window: String
    public var datetime: String
    public var locale: String
    public var language: String
    public var appFormat: String
    public var user: String
    public var field: String
    public var names: String

    public init(transcript: String, selection: String = "", clipboard: String = "",
                user: String = "", field: String = "", names: String = "",
                app: String = "", window: String = "", datetime: String = "",
                locale: String = "", language: String = "",
                appFormat: String = AppTextFormat.unknown.rawValue) {
        self.transcript = transcript
        self.selection = selection
        self.clipboard = clipboard
        self.app = app
        self.window = window
        self.datetime = datetime
        self.locale = locale
        self.language = language
        self.appFormat = appFormat
        self.user = user
        self.field = field
        self.names = names
    }

    /// Builds the context from a bundle identifier, filling in what that app expects.
    public static func forApp(
        bundleID: String?, transcript: String, language: Language,
        selection: String = "", clipboard: String = "", window: String = "",
        datetime: String = "", locale: String = "",
        user: String = "", field: String = "", names: [String] = [],
        appName: String? = nil
    ) -> PromptContext {
        let format = AppKnowledge.format(forBundleID: bundleID)
        return PromptContext(
            transcript: transcript, selection: selection, clipboard: clipboard,
            user: user,
            field: field.isEmpty ? "an unnamed field" : field,
            // Spelling help only. The prompt says so; this just supplies the candidates.
            names: names.isEmpty ? "none visible" : names.joined(separator: ", "),
            app: appName ?? bundleID ?? "an unknown application",
            window: window, datetime: datetime,
            locale: locale, language: language.promptName,
            appFormat: "\(format.rawValue). \(format.guidance)")
    }

    func value(for variable: String) -> String? {
        switch variable {
        case "transcript": return transcript
        case "selection": return selection
        case "clipboard": return clipboard
        case "app": return app
        case "window": return window
        case "datetime": return datetime
        case "locale": return locale
        case "language": return language
        case "appFormat": return appFormat
        case "user": return user
        case "field": return field
        case "names": return names
        default: return nil
        }
    }
}

public struct PromptTemplate: Sendable, Codable, Equatable {
    public let raw: String

    /// Validation happens here, at save time. A mode with a typo in a variable name is refused
    /// while the user is looking at it, rather than silently rendering an empty string into a
    /// prompt three days later.
    public init(validating raw: String, requireTranscript: Bool = true) throws {
        var seenTranscript = false
        var i = raw.startIndex
        while let open = raw.range(of: "{{", range: i..<raw.endIndex) {
            guard let close = raw.range(of: "}}", range: open.upperBound..<raw.endIndex) else {
                throw TemplateError.unclosedPlaceholder
            }
            let name = String(raw[open.upperBound..<close.lowerBound])
                .trimmingCharacters(in: .whitespaces)
            guard PromptVariable.all.contains(PromptVariable(name)) else {
                throw TemplateError.unknownVariable(name)
            }
            if name == "transcript" { seenTranscript = true }
            i = close.upperBound
        }
        if requireTranscript && !seenTranscript { throw TemplateError.missingTranscript }
        self.raw = raw
    }

    /// Rendering cannot fail: every variable was proven to exist at save time.
    public func render(_ context: PromptContext) -> String {
        var out = ""
        var i = raw.startIndex
        while let open = raw.range(of: "{{", range: i..<raw.endIndex) {
            guard let close = raw.range(of: "}}", range: open.upperBound..<raw.endIndex) else {
                break
            }
            out += raw[i..<open.lowerBound]
            let name = String(raw[open.upperBound..<close.lowerBound])
                .trimmingCharacters(in: .whitespaces)
            out += context.value(for: name) ?? ""
            i = close.upperBound
        }
        out += raw[i...]
        return out
    }
}

// MARK: - M-01 / M-03 The mode

public struct Mode: Sendable, Equatable {
    /// Stable identifier. The file this mode lives in must be named `<key>.json`.
    public var key: String
    /// Display name only, freely renameable and decoupled from `key`.
    public var name: String
    public var version: Int

    /// Custom instructions for the polish step. Nil means this mode never polishes — which is
    /// the default, because polish costs 4–18× the transcription it polishes.
    public var prompt: PromptTemplate?

    /// M-03: a mode *is* an (engine, language) pair. Nil means let the router decide.
    /// When set, this is the P1 pin — 0 ms and absolute.
    public var language: Language?
    public var voiceModelID: String?
    public var polishModelID: String?

    public var contextFromSelection: Bool
    public var contextFromClipboard: Bool
    public var contextFromActiveApplication: Bool

    /// M-05: bundle identifiers this mode activates for. On iOS this can never be automatic —
    /// iOS 26.4 nulled `hostApplicationBundleId` and there is no replacement API.
    public var activationApps: [String]

    /// Whether the capitaliser may run on this mode's output.
    ///
    /// Read at last: this was declared, encoded, decoded and consulted by nothing, so Super —
    /// which ships it `false`, and whose prompt says "Do not capitalise" — had every
    /// sentence-initial letter capitalised anyway by the layer beneath it.
    public var autocapitalizeInsert: Bool

    /// Whether this mode may legitimately produce much more text than it was given.
    ///
    /// `PolishGuard` rejects anything outside [0.75, 2.0] of the input length, which is right
    /// for a correction pass and wrong for a mode whose job is to restructure: an email adds a
    /// greeting, paragraph breaks and a sign-off, and a short dictation easily doubles. Without
    /// this, Email and Note would be rejected on length every time and the user would be shown
    /// the raw transcript — which is precisely the "all modes do the same thing" complaint.
    public var restructures: Bool

    /// Fields written by a newer version of Kotiba, preserved verbatim.
    public var unknownFields: [String: JSONValue]

    public init(
        key: String, name: String, version: Int = 1, prompt: PromptTemplate? = nil,
        language: Language? = nil, voiceModelID: String? = nil, polishModelID: String? = nil,
        contextFromSelection: Bool = false, contextFromClipboard: Bool = false,
        contextFromActiveApplication: Bool = false, activationApps: [String] = [],
        autocapitalizeInsert: Bool = true,
        restructures: Bool = false,
        unknownFields: [String: JSONValue] = [:]
    ) {
        self.key = key
        self.name = name
        self.version = version
        self.prompt = prompt
        self.language = language
        self.voiceModelID = voiceModelID
        self.polishModelID = polishModelID
        self.contextFromSelection = contextFromSelection
        self.contextFromClipboard = contextFromClipboard
        self.contextFromActiveApplication = contextFromActiveApplication
        self.activationApps = activationApps
        self.autocapitalizeInsert = autocapitalizeInsert
        self.restructures = restructures
        self.unknownFields = unknownFields
    }

    /// Whether this mode wants a polish pass at all. Off unless it has instructions *and* a
    /// model to run them on.
    /// Whether this mode asks for a language model at all.
    ///
    /// Just the prompt. It used to also require `polishModelID`, which no built-in mode sets —
    /// so this answered false for every mode in the app, including the ones whose entire
    /// purpose is to reformat. Which model runs is the app's decision (on-device first, the
    /// user's key second), not something a mode names.
    public var polishes: Bool { prompt != nil }
}

extension Mode: Codable {
    private enum Key: String, CodingKey, CaseIterable {
        case key, name, version, prompt, language, voiceModelID, polishModelID
        case contextFromSelection, contextFromClipboard, contextFromActiveApplication
        case activationApps, autocapitalizeInsert, restructures
    }
    private struct Anything: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        key = try c.decode(String.self, forKey: .key)
        name = try c.decode(String.self, forKey: .name)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        if let raw = try c.decodeIfPresent(String.self, forKey: .prompt), !raw.isEmpty {
            prompt = try PromptTemplate(validating: raw)
        } else {
            prompt = nil
        }
        language = try c.decodeIfPresent(Language.self, forKey: .language)
        voiceModelID = try c.decodeIfPresent(String.self, forKey: .voiceModelID)
        polishModelID = try c.decodeIfPresent(String.self, forKey: .polishModelID)
        contextFromSelection = try c.decodeIfPresent(Bool.self, forKey: .contextFromSelection) ?? false
        contextFromClipboard = try c.decodeIfPresent(Bool.self, forKey: .contextFromClipboard) ?? false
        contextFromActiveApplication =
            try c.decodeIfPresent(Bool.self, forKey: .contextFromActiveApplication) ?? false
        activationApps = try c.decodeIfPresent([String].self, forKey: .activationApps) ?? []
        autocapitalizeInsert = try c.decodeIfPresent(Bool.self, forKey: .autocapitalizeInsert) ?? true
        restructures = try c.decodeIfPresent(Bool.self, forKey: .restructures) ?? false

        // Whatever this version does not know about is carried through untouched.
        let known = Set(Key.allCases.map(\.rawValue))
        let all = try decoder.container(keyedBy: Anything.self)
        var extras: [String: JSONValue] = [:]
        for k in all.allKeys where !known.contains(k.stringValue) {
            extras[k.stringValue] = try all.decode(JSONValue.self, forKey: k)
        }
        unknownFields = extras
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(key, forKey: .key)
        try c.encode(name, forKey: .name)
        try c.encode(version, forKey: .version)
        try c.encodeIfPresent(prompt?.raw, forKey: .prompt)
        try c.encodeIfPresent(language, forKey: .language)
        try c.encodeIfPresent(voiceModelID, forKey: .voiceModelID)
        try c.encodeIfPresent(polishModelID, forKey: .polishModelID)
        try c.encode(contextFromSelection, forKey: .contextFromSelection)
        try c.encode(contextFromClipboard, forKey: .contextFromClipboard)
        try c.encode(contextFromActiveApplication, forKey: .contextFromActiveApplication)
        try c.encode(activationApps, forKey: .activationApps)
        try c.encode(autocapitalizeInsert, forKey: .autocapitalizeInsert)
        try c.encode(restructures, forKey: .restructures)

        var extra = encoder.container(keyedBy: Anything.self)
        for (k, v) in unknownFields {
            guard let ck = Anything(stringValue: k) else { continue }
            try extra.encode(v, forKey: ck)
        }
    }
}

// MARK: - M-05 Registry

public struct ModeRegistry: Sendable {
    public private(set) var modes: [Mode]
    public var defaultKey: String

    public enum RegistryError: Error, Sendable, Equatable {
        case duplicateKey(String)
        case emptyRegistry
    }

    public init(modes: [Mode], defaultKey: String) throws {
        guard !modes.isEmpty else { throw RegistryError.emptyRegistry }
        var seen = Set<String>()
        for m in modes where !seen.insert(m.key).inserted {
            throw RegistryError.duplicateKey(m.key)
        }
        self.modes = modes
        self.defaultKey = modes.contains(where: { $0.key == defaultKey }) ? defaultKey : modes[0].key
    }

    public func mode(for key: String) -> Mode? { modes.first { $0.key == key } }

    public var defaultMode: Mode { mode(for: defaultKey) ?? modes[0] }

    /// The mode to use for a given frontmost application.
    ///
    /// Matching is by **bundle identifier**, not display name. a commercial dictation app matches on display
    /// name, which breaks the moment an app is localised or renamed. Longest match wins so
    /// `com.apple.dt.Xcode` beats a rule for `com.apple`.
    public func mode(forBundleID bundleID: String?) -> Mode {
        guard let bundleID else { return defaultMode }
        var best: Mode?
        var bestLength = 0
        for m in modes {
            for pattern in m.activationApps
            where bundleID == pattern || bundleID.hasPrefix(pattern + ".") {
                if pattern.count > bestLength {
                    best = m
                    bestLength = pattern.count
                }
            }
        }
        return best ?? defaultMode
    }
}

// `"\(error)"` is this codebase's interchange format at the module boundaries — 23 sites convert
// that way — and for an `Error` enum without `CustomStringConvertible` it reflects the case name
// instead of the diagnosis. A denied microphone reached the user as
// `engineFailedToStart("permissionDenied")`, which appears verbatim in real diagnostics. Each of
// these types already writes the actionable sentence in `reason`; this is what makes the
// interchange format use it, with no call-site changes.

extension TemplateError: CustomStringConvertible {
    public var description: String { reason }
}
