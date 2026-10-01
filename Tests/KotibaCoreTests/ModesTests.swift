import Foundation
import Testing

@testable import KotibaCore

@Suite("Prompt templates — validated at save time, not discovered mid-dictation")
struct PromptTemplateTests {

    @Test("a good template validates and renders every variable")
    func rendersEverything() throws {
        let t = try PromptTemplate(validating:
            "In {{app}} ({{window}}), at {{datetime}} in {{locale}}, language {{language}}. "
            + "Selected: {{selection}}. Clipboard: {{clipboard}}. Say: {{transcript}}")
        let out = t.render(PromptContext(
            transcript: "salom", selection: "sel", clipboard: "clip", app: "Xcode",
            window: "main.swift", datetime: "2026-08-06", locale: "en_UZ", language: "uz"))
        for expected in ["Xcode", "main.swift", "2026-08-06", "en_UZ", "uz", "sel", "clip", "salom"] {
            #expect(out.contains(expected), "missing \(expected) in: \(out)")
        }
    }

    @Test("a typo in a variable name is refused at save time")
    func typoIsRefused() {
        #expect(throws: TemplateError.unknownVariable("transcrpt")) {
            try PromptTemplate(validating: "Fix this: {{transcrpt}}")
        }
    }

    @Test("the error names what is available, so the fix is obvious")
    func errorIsActionable() {
        let reason = TemplateError.unknownVariable("nope").reason
        #expect(reason.contains("transcript"))
        #expect(reason.contains("clipboard"))
    }

    @Test("an unclosed placeholder is refused")
    func unclosed() {
        #expect(throws: TemplateError.unclosedPlaceholder) {
            try PromptTemplate(validating: "hello {{transcript")
        }
    }

    @Test("a template that never uses the transcript is refused — the dictation would vanish")
    func mustUseTranscript() {
        #expect(throws: TemplateError.missingTranscript) {
            try PromptTemplate(validating: "Summarise the clipboard: {{clipboard}}")
        }
    }

    @Test("whitespace inside the braces is tolerated")
    func whitespaceTolerated() throws {
        let t = try PromptTemplate(validating: "x {{  transcript  }} y")
        #expect(t.render(PromptContext(transcript: "OK")) == "x OK y")
    }

    @Test("the transcript can go anywhere — the whole reason for having interpolation")
    func transcriptIsNotForcedLast() throws {
        // a commercial dictation app appends fixed sections in a fixed order, so the transcript can only
        // ever be last. This is the divergence.
        let t = try PromptTemplate(validating: "{{transcript}}\n\nRewrite the above for {{app}}.")
        let out = t.render(PromptContext(transcript: "hello", app: "Slack"))
        #expect(out.hasPrefix("hello"))
        #expect(out.hasSuffix("Slack."))
    }

    @Test("a variable with no value renders empty rather than crashing")
    func emptyValue() throws {
        let t = try PromptTemplate(validating: "[{{selection}}]{{transcript}}")
        #expect(t.render(PromptContext(transcript: "x")) == "[]x")
    }

    @Test("a template with no placeholders at all still needs the transcript")
    func noPlaceholders() {
        #expect(throws: TemplateError.missingTranscript) {
            try PromptTemplate(validating: "just some prose")
        }
    }
}

@Suite("Mode — round-trips, and survives a newer version of itself")
struct ModeTests {

    private func roundTrip(_ json: String) throws -> (Mode, String) {
        let mode = try JSONDecoder().decode(Mode.self, from: Data(json.utf8))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let out = String(decoding: try encoder.encode(mode), as: UTF8.self)
        return (mode, out)
    }

    @Test("a minimal mode decodes with sensible defaults")
    func minimal() throws {
        let (m, _) = try roundTrip(#"{"key":"default","name":"Default"}"#)
        #expect(m.key == "default")
        #expect(m.version == 1)
        #expect(m.language == nil, "no pin means the router decides")
        #expect(m.autocapitalizeInsert)
        #expect(!m.polishes)
    }

    @Test("a pinned mode carries its language, which becomes the free P1 route")
    func pinned() throws {
        let (m, _) = try roundTrip(#"{"key":"uz","name":"Uzbek","language":"uz"}"#)
        #expect(m.language == .uzbek)
        #expect(EngineFamily(for: m.language!) == .uzbek)
    }

    @Test("a field written by a newer Kotiba survives the round trip untouched")
    func unknownFieldsPreserved() throws {
        // This is the whole point: an older build must not silently delete a newer build's data.
        let json = #"""
        {"key":"k","name":"N","diarize":true,"futureThing":{"nested":[1,"two"]},"tempo":0.5}
        """#
        let (m, encoded) = try roundTrip(json)
        #expect(m.unknownFields["diarize"] == .bool(true))
        #expect(m.unknownFields["tempo"] == .number(0.5))
        #expect(encoded.contains("diarize"))
        #expect(encoded.contains("futureThing"))
        #expect(encoded.contains("nested"))
    }

    @Test("an invalid prompt makes the whole mode fail to load, loudly")
    func invalidPromptRejected() {
        #expect(throws: (any Error).self) {
            _ = try JSONDecoder().decode(
                Mode.self, from: Data(#"{"key":"k","name":"N","prompt":"{{nope}}"}"#.utf8))
        }
    }

    @Test("a mode polishes when it has a prompt — the model is the app's choice")
    func polishNeedsBoth() throws {
        let promptOnly = try JSONDecoder().decode(
            Mode.self, from: Data(#"{"key":"a","name":"A","prompt":"do {{transcript}}"}"#.utf8))
        // CHANGED 2026-08-08: this used to also require polishModelID, which no built-in
        // mode sets — so it answered false for every mode in the app, including the ones whose
        // whole purpose is to reformat. Which model runs is the app's decision (on-device
        // first, the user's key second), not something a mode names.
        #expect(promptOnly.polishes)

        let both = try JSONDecoder().decode(Mode.self, from: Data(
            #"{"key":"b","name":"B","prompt":"do {{transcript}}","polishModelID":"gpt"}"#.utf8))
        #expect(both.polishes)
    }
}

@Suite("Mode registry — activation by bundle id, not display name")
struct ModeRegistryTests {

    private func registry() throws -> ModeRegistry {
        try ModeRegistry(modes: [
            Mode(key: "default", name: "Default"),
            Mode(key: "code", name: "Code", language: .english,
                 activationApps: ["com.apple.dt.Xcode", "com.microsoft.VSCode"]),
            Mode(key: "apple", name: "Apple things", activationApps: ["com.apple"]),
            Mode(key: "uz", name: "Uzbek", language: .uzbek, activationApps: ["org.telegram"]),
        ], defaultKey: "default")
    }

    @Test("an exact bundle id selects its mode")
    func exactMatch() throws {
        #expect(try registry().mode(forBundleID: "com.microsoft.VSCode").key == "code")
    }

    @Test("the longest matching prefix wins")
    func longestPrefixWins() throws {
        // Both "com.apple" and "com.apple.dt.Xcode" match; the specific one must win.
        #expect(try registry().mode(forBundleID: "com.apple.dt.Xcode").key == "code")
        #expect(try registry().mode(forBundleID: "com.apple.Safari").key == "apple")
    }

    @Test("a prefix only matches on a dot boundary, not mid-identifier")
    func boundaryRespected() throws {
        #expect(try registry().mode(forBundleID: "com.applesauce.App").key == "default")
    }

    @Test("an unknown or absent app falls back to the default")
    func fallback() throws {
        #expect(try registry().mode(forBundleID: "com.unknown.Thing").key == "default")
        #expect(try registry().mode(forBundleID: nil).key == "default")
    }

    @Test("activation carries the language pin with it")
    func activationCarriesPin() throws {
        #expect(try registry().mode(forBundleID: "org.telegram.desktop").language == .uzbek)
    }

    @Test("duplicate keys are refused")
    func duplicates() {
        #expect(throws: ModeRegistry.RegistryError.duplicateKey("x")) {
            try ModeRegistry(modes: [Mode(key: "x", name: "A"), Mode(key: "x", name: "B")],
                             defaultKey: "x")
        }
    }

    @Test("an empty registry is refused, and a bad default falls back to the first mode")
    func degenerate() throws {
        #expect(throws: ModeRegistry.RegistryError.emptyRegistry) {
            try ModeRegistry(modes: [], defaultKey: "x")
        }
        let r = try ModeRegistry(modes: [Mode(key: "only", name: "Only")], defaultKey: "missing")
        #expect(r.defaultKey == "only")
    }
}
