import Foundation
import Testing

@testable import KotibaCore

@Suite("Built-in modes")
struct BuiltInModesTests {

    @Test("every shipped mode has a valid prompt and a unique key")
    func allModesAreWellFormed() throws {
        let registry = try BuiltInModes.registry()
        #expect(registry.modes.count == 4)
        #expect(Set(registry.modes.map(\.key)).count == registry.modes.count)
        for mode in registry.modes where mode.prompt != nil {
            // CHANGED 2026-08-08: the prompt is the model's *instructions*; the transcript is
            // delivered separately as the user turn. The preamble used to end with a literal
            // "TRANSCRIPT:" heading and a {{transcript}} placeholder that always rendered
            // empty, so every model received a labelled empty section. What must hold now is
            // that the prompt survived validation at all — a typo makes `try?` yield nil.
            #expect(mode.prompt?.raw.contains("{{language}}") == true,
                    "\(mode.key) lost its prompt to a validation failure")
            #expect(mode.prompt?.raw.contains("{{transcript}}") == false,
                    "\(mode.key) still carries a transcript placeholder it cannot fill")
        }
    }

    @Test("the default mode cleans up, and a raw mode is still there for anyone who wants it")
    func defaultCleansUp() throws {
        // REVERSED 2026-08-08. The first cut made the default raw on the grounds that polish
        // costs 4–18x the transcription it polishes — but that arithmetic was about a network
        // round trip. Apple's on-device model runs in-process, so the common case can afford
        // correction, and a dictation tool that cannot fix its own punctuation is a transcript
        // dump. Where no model is available the mode is a no-op, not a failure.
        let registry = try BuiltInModes.registry()
        #expect(registry.defaultKey == "message")
        #expect(registry.defaultMode.polishes)
        #expect(registry.defaultMode.prompt != nil)

        // The escape hatch survives: exactly what was said, no model involved.
        let raw = registry.mode(for: "transcription")
        #expect(raw?.prompt == nil)
        #expect(raw?.polishes == false)
    }

    @Test("Super preserves, Message rewrites — the two ends of the licence range")
    func licenceTiersDiffer() throws {
        // Trimmed to four modes on 2026-08-08 at the user's request: Message, Super, Note, Raw.
        // What has to stay true is that the two AI correction modes sit at opposite ends —
        // Super changes as little as it can, Message is allowed to reshape.
        let superPrompt = try #require(BuiltInModes.superMode.prompt?.raw)
        #expect(superPrompt.localizedCaseInsensitiveContains("keep every word"))
        #expect(superPrompt.localizedCaseInsensitiveContains("do not rephrase"))

        let message = try #require(BuiltInModes.message.prompt?.raw)
        #expect(message.localizedCaseInsensitiveContains("reorder")
                || message.localizedCaseInsensitiveContains("rewrite"))
        #expect(!message.localizedCaseInsensitiveContains("keep every word"))
    }

    @Test("every prompt forbids answering and forbids translating")
    func promptsAreNegativeFirst() throws {
        // Both are measured failures: models answer questions they were asked to reformat, and
        // one turned an English transcript into Russian while changing Tuesday to Monday.
        for mode in BuiltInModes.all {
            guard let raw = mode.prompt?.raw else { continue }
            #expect(raw.contains("Never answer"), "\(mode.key) does not forbid answering")
            #expect(raw.contains("Never translate"), "\(mode.key) does not forbid translating")
            #expect(raw.contains("{{language}}"), "\(mode.key) does not pin the language")
        }
    }

    @Test("every prompt tells the model what the target app expects")
    func promptsCarryAppFormat() throws {
        for mode in BuiltInModes.all {
            guard let raw = mode.prompt?.raw else { continue }
            #expect(raw.contains("{{appFormat}}"), "\(mode.key) ignores the app knowledge base")
            #expect(raw.contains("{{datetime}}"), "\(mode.key) cannot resolve 'tomorrow'")
        }
    }

    @Test("the language modes pin, so they never pay for a routing decision")
    func languageModesPin() throws {
        let registry = try BuiltInModes.registry()
        #expect(registry.mode(for: "message")?.language == nil,
                "the default must stay automatic")
    }

    @Test("modes activate for the apps they are for")
    func activation() throws {
        let registry = try BuiltInModes.registry()
        #expect(registry.mode(forBundleID: "com.tinyspeck.slackmacgap").key == "message")
        #expect(registry.mode(forBundleID: "md.obsidian").key == "note")
        #expect(registry.mode(forBundleID: "com.unknown.app").key == "message")
    }

    @Test("a rendered prompt contains the transcript and the app guidance, and nothing stray")
    func rendering() throws {
        let mode = BuiltInModes.message
        let context = PromptContext.forApp(
            bundleID: "com.tinyspeck.slackmacgap", transcript: "salom qalaysiz",
            language: .uzbek, datetime: "2026-08-07 09:00", locale: "en_UZ")
        let rendered = mode.prompt!.render(context)

        // The transcript is NOT in here — it goes to the model as the user turn.
        #expect(!rendered.contains("{{transcript}}"))
        #expect(rendered.contains("short chat message"))
        #expect(rendered.contains("Uzbek (Latin script)"), "the language is named, not coded")
        #expect(rendered.contains("2026-08-07"))
        #expect(!rendered.contains("{{"), "every placeholder must have been substituted")
    }
}

@Suite("App knowledge — a commercial dictation app's best idea, on bundle ids")
struct AppKnowledgeTests {

    @Test(arguments: [
        ("com.apple.Terminal", AppTextFormat.terminalCommand),
        ("com.googlecode.iterm2", .terminalCommand),
        ("com.apple.dt.Xcode", .code),
        ("com.microsoft.VSCode", .code),
        ("com.tinyspeck.slackmacgap", .chatMessage),
        ("com.apple.mail", .email),
        ("md.obsidian", .markdown),
        ("com.apple.Notes", .plainText),
        ("com.1password.1password", .password),
        ("com.nobody.knows", .unknown),
    ])
    func lookup(bundleID: String, expected: AppTextFormat) {
        #expect(AppKnowledge.format(forBundleID: bundleID) == expected)
    }

    @Test("longest prefix wins, and only on a dot boundary")
    func matching() {
        // com.apple matches nothing generic, but com.apple.Terminal must beat a shorter entry.
        #expect(AppKnowledge.format(forBundleID: "com.apple.Terminal") == .terminalCommand)
        // A prefix must not match mid-identifier.
        #expect(AppKnowledge.format(forBundleID: "com.apple.TerminalX") == .unknown)
        #expect(AppKnowledge.format(forBundleID: nil) == .unknown)
    }

    @Test("a credential field is flagged so nothing ever reformats a password")
    func passwordsAreSensitive() {
        // 1Password wanting a password is exactly the case that justifies the whole table.
        let format = AppKnowledge.format(forBundleID: "com.1password.1password")
        #expect(AppKnowledge.isSensitive(format))
        #expect(format.guidance.contains("Transcribe literally"))
        #expect(!AppKnowledge.isSensitive(.chatMessage))
    }

    @Test("every credential manager this audience runs is sensitive under its REAL bundle id")
    func versionedPasswordManagersAreSensitive() {
        // The matcher is exact-or-dot-boundary, so `com.agilebits.onepassword` does NOT cover
        // 1Password 7's actual id, which ends in a digit. That gap shipped. This test lists the
        // ids as the OS reports them, so a missing entry fails here and not in a user's vault.
        for id in [
            "com.agilebits.onepassword7", "com.agilebits.onepassword4",
            "com.agilebits.onepassword-osx", "com.1password.1password",
            "com.bitwarden.desktop", "org.keepassxc.keepassxc",
            "com.lastpass.LastPass", "com.lastpass.lastpassmacdesktop",
            "com.dashlane.dashlanephonefinal", "com.apple.keychainaccess", "com.apple.Passwords",
        ] {
            #expect(AppKnowledge.isSensitive(AppKnowledge.format(forBundleID: id)), "\(id)")
        }
    }

    @Test("terminal guidance forbids prose and code fences, which is the whole point")
    func terminalGuidance() {
        #expect(AppTextFormat.terminalCommand.guidance.contains("no prose"))
        #expect(AppTextFormat.terminalCommand.guidance.contains("no code fence"))
    }

    @Test("every format has non-empty guidance a model can act on")
    func allFormatsGuide() {
        for format in AppTextFormat.allCases {
            #expect(!format.guidance.isEmpty, "\(format.rawValue) has no guidance")
            #expect(!format.rawValue.isEmpty)
        }
    }
}
