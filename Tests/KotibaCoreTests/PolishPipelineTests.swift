import Foundation
import Testing

@testable import KotibaCore

// The polish half of the pipeline, end to end, with a stub where the model goes.
//
// Everything here is the real thing except the model call and the Accessibility write: the real
// session, the real ordering, the real guards, the real replace path. What it pins is the set of
// properties that were all broken at once — polish never reaching the sink, polish running
// before insertion, and Uzbek being rewritten by a model that invents words.

private actor Sink: TextSink {
    private(set) var inserted: [String] = []
    private(set) var replaced: [(from: String, to: String)] = []
    /// Insertion order across both operations, so ordering can be asserted rather than assumed.
    private(set) var log: [String] = []
    private let allowReplace: Bool

    init(allowReplace: Bool = true) { self.allowReplace = allowReplace }

    func insert(_ text: String) async throws -> InsertionOutcome {
        inserted.append(text)
        log.append("insert:\(text)")
        return .inserted
    }

    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        guard allowReplace else {
            log.append("replace-refused")
            return .refused(reason: "this app does not expose its text field to Kotiba")
        }
        replaced.append((previous, text))
        log.append("replace:\(text)")
        return .inserted
    }
}

private struct StubPolisher: PolishEngine {
    var polishID = "stub"
    var supportedLanguages: Set<Language> = Set(Language.allCases)
    var output: String
    var delay: Duration = .zero
    /// Records when polish was called, so "insert first" is checked rather than trusted.
    var onCall: (@Sendable () -> Void)?

    func polish(_ text: String, language: Language, instructions: String) async throws -> String {
        onCall?()
        if delay > .zero { try await Task.sleep(for: delay) }
        return output
    }
}

/// Keeps what it was told, so the prompt the model saw can be asserted rather than assumed.
private final class InstructionLog: @unchecked Sendable {
    var instructions: [String] = []
    var languages: [Language] = []
}

private struct RecordingPolisher: PolishEngine {
    var polishID = "recording"
    var supportedLanguages: Set<Language> = Set(Language.allCases)
    let log: InstructionLog
    func polish(_ text: String, language: Language, instructions: String) async throws -> String {
        log.instructions.append(instructions)
        log.languages.append(language)
        return text
    }
}

private struct Engine: TranscriptionEngine {
    let text: String
    var engineID: String { "stub-engine" }
    var supportedLanguages: Set<Language> { Set(Language.allCases) }
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: text, language: language, engineID: engineID)
    }
}

private actor Source: AudioSource {
    func start() async throws {}
    func stop() async throws -> AudioBuffer {
        AudioBuffer(samples: (0..<16_000).map { $0.isMultiple(of: 2) ? 0.3 : -0.3 })
    }
    func warmUp() async {}
}

private func session(said: String, polisher: (any PolishEngine)?, sink: Sink,
                     language: Language = .english) -> DictationSession {
    DictationSession(
        audio: Source(),
        router: TieredRouter(fallback: language),
        engines: [EngineFamily(for: language): Engine(text: said)],
        sink: sink,
        normalise: { text, _ in text })
}

// The prompt used to be rendered once, before routing, for `mode.language ?? defaultLanguage` —
// which is "en" for every built-in mode. So a Russian or Uzbek dictation reached the model under
// a system prompt that said "The text is in en. Keep it in en. Never translate." — an
// instruction to translate it, from the one component whose job is to stop drift.
@Suite("Polish instructions follow the routed language")
struct PolishInstructionsByLanguage {

    @Test("the session picks the instructions for the language it actually routed to")
    func routedLanguageWins() async {
        for language in Language.allCases {
            let sink = Sink()
            let log = InstructionLog()
            let session = session(said: "salom", polisher: nil, sink: sink, language: language)
            await session.arm()
            // Every language, the two optional ones included (D-11): each routes to its own
            // family and gets its own instructions.
            let byLanguage: [Language: String] = [.english: "for English",
                                                  .russian: "for Russian",
                                                  .uzbek: "for Uzbek",
                                                  .turkish: "for Turkish",
                                                  .arabic: "for Arabic"]
            _ = await session.finish(
                polisher: RecordingPolisher(log: log),
                polishInstructions: .perLanguage(byLanguage))
            let expected = byLanguage[language]!
            #expect(log.instructions == [expected], "\(language)")
            #expect(log.languages == [language])
        }
    }

    @Test("a language with no instructions is not polished at all")
    func missingLanguageSkipsPolish() async {
        let sink = Sink()
        let log = InstructionLog()
        let session = session(said: "salom", polisher: nil, sink: sink, language: .uzbek)
        await session.arm()
        _ = await session.finish(polisher: RecordingPolisher(log: log),
                                 polishInstructions: .perLanguage([.english: "for English"]))
        #expect(log.instructions.isEmpty)
    }

    @Test("a string literal is one instruction for every language")
    func literalIsFixed() {
        let fixed: PolishInstructions = "tidy"
        for language in Language.allCases {
            #expect(fixed.resolved(for: language) == "tidy")
        }
    }

    @Test("the prompt names the language, not its code")
    func promptNamesTheLanguage() throws {
        // A model told "The text is in uz" has to know what uz is; one told "Uzbek (Latin
        // script)" does not, and will not answer in Cyrillic.
        #expect(Language.english.promptName == "English")
        #expect(Language.russian.promptName == "Russian")
        #expect(Language.uzbek.promptName == "Uzbek (Latin script)")
        let context = PromptContext.forApp(bundleID: nil, transcript: "", language: .uzbek)
        let rendered = try #require(BuiltInModes.superMode.prompt).render(context)
        #expect(rendered.contains("The speaker used Uzbek (Latin script). Write in Uzbek (Latin script)."))
        #expect(!rendered.contains("in uz."))
    }
}

@Suite("Polish reaches the user's app, and only when it should")
struct PolishPipelineTests {

    @Test("the polished text replaces the raw text")
    func polishLands() async throws {
        // This is the property that was false for the entire life of the feature:
        // PasteboardSink.replace refused unconditionally, so every polish was computed, paid
        // for, and thrown away. Modes appeared to work and did nothing.
        let sink = Sink()
        let session = session(said: "hey just checking in", polisher: nil, sink: sink)
        await session.arm()
        _ = await session.finish(
            pin: .english,
            polisher: StubPolisher(output: "Hey, just checking in."),
            polishInstructions: "fix punctuation")

        #expect(await sink.inserted == ["hey just checking in"])
        #expect(await sink.replaced.count == 1)
        #expect(await sink.replaced.first?.to == "Hey, just checking in.")
    }

    @Test("the raw transcript is inserted BEFORE the model is asked")
    func insertionComesFirst() async throws {
        // The single largest self-inflicted latency error available, and v1 made it. The words
        // must be on screen before anything slow starts.
        let sink = Sink()
        nonisolated(unsafe) var sawInsertFirst = false
        // A realistic pair. "raw" -> "Polished." is a 3x expansion, which PolishGuard rejects
        // on length alone — correctly, and it cost this test a failure before the input was
        // made to look like something a correction pass would actually produce.
        let said = "hey there how are you"
        let watcher = StubPolisher(output: "Hey there, how are you?",
                                   onCall: { sawInsertFirst = true })

        let session = session(said: said, polisher: nil, sink: sink)
        await session.arm()
        _ = await session.finish(pin: .english, polisher: watcher,
                                 polishInstructions: "fix")

        #expect(sawInsertFirst)
        let log = await sink.log
        #expect(log.first == "insert:\(said)",
                "the log begins with \(String(describing: log.first))")
        #expect(log.contains("replace:Hey there, how are you?"))
    }

    @Test("a polish that times out leaves the raw transcript standing")
    func timeoutKeepsRaw() async throws {
        var config = DictationSession.Config()
        config.polishDeadline = .milliseconds(50)
        let sink = Sink()
        let session = DictationSession(
            audio: Source(), router: TieredRouter(fallback: .english),
            engines: [.unified: Engine(text: "raw text")], sink: sink,
            normalise: { text, _ in text }, config: config)

        await session.arm()
        let record = await session.finish(
            pin: .english,
            polisher: StubPolisher(output: "never arrives", delay: .seconds(5)),
            polishInstructions: "fix")

        #expect(await sink.replaced.isEmpty)
        #expect(record.polished == nil)
        #expect(record.outcome == "done", "a slow polish must not fail the dictation")
        #expect(record.errors.contains { $0.contains("exceeded") })
    }

    @Test("a refusing app leaves the raw transcript, and says so")
    func refusedReplaceIsRecorded() async throws {
        let sink = Sink(allowReplace: false)
        let session = session(said: "raw text", polisher: nil, sink: sink)
        await session.arm()
        let record = await session.finish(pin: .english,
                                          polisher: StubPolisher(output: "Raw text."),
                                          polishInstructions: "fix")

        #expect(record.polished == nil)
        #expect(record.outcome == "done")
        #expect(record.errors.contains { $0.contains("replace refused") })
    }

    @Test("a polisher that does not claim the language is never asked")
    func unsupportedLanguageIsSkipped() async throws {
        // This is how Uzbek is kept away from a model that would rewrite it: the polisher
        // declares its languages and the session skips it. One line, no new control flow.
        let sink = Sink()
        nonisolated(unsafe) var asked = false
        let englishOnly = StubPolisher(polishID: "english-only", supportedLanguages: [.english],
                                       output: "should not happen",
                                       onCall: { asked = true })

        let session = session(said: "salom doʻstim", polisher: nil, sink: sink, language: .uzbek)
        await session.arm()
        _ = await session.finish(pin: .uzbek, polisher: englishOnly,
                                 polishInstructions: "fix")

        #expect(!asked, "an English-only polisher was handed Uzbek")
        #expect(await sink.replaced.isEmpty)
        #expect(await sink.inserted == ["salom doʻstim"])
    }

    @Test("an Uzbek polish that invents a word is rejected, and names the word")
    func uzbekInventionRejected() async throws {
        // The measured failure: 7 of 14 real polishes changed words the speaker did not say.
        // Length and script cannot see it — same length, same alphabet.
        let sink = Sink()
        let session = session(said: "bugun kechqurun uyga boraman", polisher: nil, sink: sink,
                              language: .uzbek)
        await session.arm()
        let record = await session.finish(
            pin: .uzbek,
            polisher: StubPolisher(output: "Bugun keçşurun uyga boraman."),
            polishInstructions: "fix")

        #expect(await sink.replaced.isEmpty, "a corrupted Uzbek polish reached the user's app")
        #expect(record.polished == nil)
        #expect(record.errors.contains { $0.contains("did not say") })
        #expect(record.errors.contains { $0.contains("keçşurun") })
    }

    @Test("a legitimate Uzbek polish is allowed through")
    func uzbekCorrectionAccepted() async throws {
        // The guard must not be so strict that it rejects the whole point of the feature.
        let sink = Sink()
        let session = session(said: "salom doʻstim yaxshimisiz", polisher: nil, sink: sink,
                              language: .uzbek)
        await session.arm()
        let record = await session.finish(
            pin: .uzbek,
            polisher: StubPolisher(output: "Salom, doʻstim! Yaxshimisiz?"),
            polishInstructions: "fix")

        #expect(await sink.replaced.first?.to == "Salom, doʻstim! Yaxshimisiz?")
        #expect(record.polished == "Salom, doʻstim! Yaxshimisiz?")
    }

    @Test("a restructuring mode inserts the polished text once, never needing to replace")
    func restructuringInsertsOnce() async throws {
        // The bug this exists for: polish was computed correctly and then could not be written
        // back. Measured in real use, "polish replace refused; raw transcript stands" on four
        // dictations out of eight — many apps do not expose their text field over
        // Accessibility. The user saw the raw transcript every time and concluded the modes
        // were identical.
        let sink = Sink(allowReplace: false)   // the app that refuses replacement
        let session = session(said: "buy milk and call the bank", polisher: nil, sink: sink)
        await session.arm()
        let record = await session.finish(
            pin: .english,
            polisher: StubPolisher(output: "## Errands\n- [ ] Buy milk\n- [ ] Call the bank"),
            polishInstructions: "make a note",
            polishGuard: PolishGuard(minimumRatio: 0.12, maximumRatio: 3.0,
                                     shortInputHeadroom: 120),
            insertAfterPolish: true)

        // Exactly one insertion, and it is the checklist — not the raw text, and no replace.
        #expect(await sink.inserted == ["## Errands\n- [ ] Buy milk\n- [ ] Call the bank"])
        #expect(await sink.replaced.isEmpty)
        #expect(record.polished == "## Errands\n- [ ] Buy milk\n- [ ] Call the bank")
        #expect(record.outcome == "done")
    }

    @Test("if the polish fails, the raw text is still inserted once")
    func restructuringFallsBackToRaw() async throws {
        // Waiting for the polish must never mean losing the dictation.
        var config = DictationSession.Config()
        config.polishDeadline = .milliseconds(50)
        let sink = Sink(allowReplace: false)
        let session = DictationSession(
            audio: Source(), router: TieredRouter(fallback: .english),
            engines: [.unified: Engine(text: "buy milk and call the bank")], sink: sink,
            normalise: { text, _ in text }, config: config)
        await session.arm()
        let record = await session.finish(
            pin: .english,
            polisher: StubPolisher(output: "never arrives", delay: .seconds(5)),
            polishInstructions: "make a note",
            insertAfterPolish: true)

        #expect(await sink.inserted == ["buy milk and call the bank"])
        #expect(record.outcome == "done")
        #expect(record.polished == nil)
        #expect(record.errors.contains { $0.contains("exceeded") })
    }

    @Test("no instructions means no model call at all")
    func rawModeAsksNothing() async throws {
        let sink = Sink()
        nonisolated(unsafe) var asked = false
        let session = session(said: "exactly this", polisher: nil, sink: sink)
        await session.arm()
        _ = await session.finish(pin: .english,
                                 polisher: StubPolisher(output: "no", onCall: { asked = true }),
                                 polishInstructions: nil)

        #expect(!asked, "raw transcription paid for a model call")
        #expect(await sink.inserted == ["exactly this"])
        #expect(await sink.replaced.isEmpty)
    }
}
