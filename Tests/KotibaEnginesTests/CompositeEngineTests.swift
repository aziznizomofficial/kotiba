import Foundation
import KotibaCore
import Testing

@testable import KotibaEngines

private typealias AudioBuffer = KotibaCore.AudioBuffer

/// A stand-in engine. Records what it was asked so a test can prove which member ran.
private actor StubEngine: TranscriptionEngine {
    nonisolated let engineID: String
    nonisolated let supportedLanguages: Set<Language>
    private var ready: Bool
    private var prepareThrows: Bool
    private(set) var calls: [Language] = []

    init(id: String, languages: Set<Language>, ready: Bool = true, prepareThrows: Bool = false) {
        engineID = id
        supportedLanguages = languages
        self.ready = ready
        self.prepareThrows = prepareThrows
    }

    func isReady() async -> Bool { ready }

    func prepare() async throws {
        if prepareThrows { throw EngineFailure.notReady("\(engineID) refuses") }
        ready = true
    }

    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        calls.append(language)
        return Transcript(raw: "from \(engineID)", language: language, engineID: engineID)
    }

    func callCount() async -> Int { calls.count }
}

@Suite("One family slot, several engines")
struct CompositeEngineTests {

    private let audio = AudioBuffer(samples: [0.1, 0.2, 0.3])

    @Test("the union of what its members can do is what it declares")
    func unionOfLanguages() {
        let composite = CompositeEngine([
            StubEngine(id: "apple", languages: [.english]),
            StubEngine(id: "whisper-ru", languages: [.russian]),
        ])
        #expect(composite.supportedLanguages == [.english, .russian])
    }

    @Test("the first engine that can do the language wins, and order is the preference")
    func firstCapableWins() async throws {
        // Apple is free and 4x faster, so it goes first for English even though whisper could
        // also do it.
        let apple = StubEngine(id: "apple", languages: [.english])
        let whisper = StubEngine(id: "whisper", languages: [.english, .russian])
        let composite = CompositeEngine([apple, whisper])

        let english = try await composite.transcribe(audio, language: .english)
        #expect(english.engineID == "apple")
        #expect(await whisper.callCount() == 0)

        let russian = try await composite.transcribe(audio, language: .russian)
        #expect(russian.engineID == "whisper")
    }

    @Test("an engine that cannot do the language is skipped, not asked and failed")
    func skipsIncapable() async throws {
        // This is the bug the type exists for: Russian routed to the unified family, reached
        // Apple, and failed with a message about routing rather than about a missing model.
        let apple = StubEngine(id: "apple", languages: [.english])
        let whisper = StubEngine(id: "whisper-ru", languages: [.russian])
        let composite = CompositeEngine([apple, whisper])

        let transcript = try await composite.transcribe(audio, language: .russian)
        #expect(transcript.engineID == "whisper-ru")
        #expect(await apple.callCount() == 0)
    }

    @Test("an engine that could do it but cannot be loaded says exactly that")
    func notLoadedIsDistinctFromUnsupported() async {
        // `ready: false` alone no longer reaches this: a member that is merely cold now gets
        // loaded rather than reported as missing, which is the whole point of the fix. Only a
        // member that cannot load ends up here, so that is what this now builds.
        let whisper = StubEngine(id: "whisper-ru", languages: [.russian], ready: false,
                                 prepareThrows: true)
        let composite = CompositeEngine([StubEngine(id: "apple", languages: [.english]), whisper])

        let error = await #expect(throws: EngineFailure.self) {
            _ = try await composite.transcribe(self.audio, language: .russian)
        }
        // "not loaded" and "not supported" need different fixes — one is a download, the other
        // is a language the app cannot do at all. Collapsing them wastes the user's time.
        guard case .notReady(let why) = error else {
            Issue.record("expected .notReady, got \(String(describing: error))")
            return
        }
        #expect(why.contains("whisper-ru"))
        #expect(why.contains("ru"))
    }

    // Still three distinct answers, and they still need three distinct fixes from the user. What
    // changed is which one fits a composite: its members are whatever has been *configured*, so
    // "no member claims this language" is a setup fact. Reporting it as `languageUnsupported`
    // told the user "the router misrouted" — a bug report about Kotiba — when all they had done
    // was never choose a model.
    @Test("a language no member can do means no model is installed, not a misroute")
    func noModelInstalled() async {
        let composite = CompositeEngine(engineID: "unified",
                                        [StubEngine(id: "apple", languages: [.english])])
        let error = await #expect(throws: EngineFailure.self) {
            _ = try await composite.transcribe(self.audio, language: .uzbek)
        }
        guard case .noEngineInstalled(let language) = error else {
            Issue.record("expected .noEngineInstalled, got \(String(describing: error))")
            return
        }
        #expect(language == .uzbek)
        #expect(error?.reason.contains("Settings") == true,
                "it has to name the thing the user can actually go and do")
        #expect(error?.reason.contains("misrouted") != true,
                "and must not read as a bug report about Kotiba")
    }

    @Test("ready when any member is ready")
    func readiness() async {
        let composite = CompositeEngine([
            StubEngine(id: "a", languages: [.english], ready: false),
            StubEngine(id: "b", languages: [.russian], ready: true),
        ])
        #expect(await composite.isReady())

        let none = CompositeEngine([StubEngine(id: "a", languages: [.english], ready: false)])
        #expect(await none.isReady() == false)
    }

    @Test("one member failing to prepare does not stop the others")
    func partialPrepare() async throws {
        // An app with no Russian model must still dictate English. Refusing to start because
        // one optional model is missing would be the wrong trade every time.
        let composite = CompositeEngine([
            StubEngine(id: "apple", languages: [.english]),
            StubEngine(id: "whisper-ru", languages: [.russian], ready: false,
                       prepareThrows: true),
        ])
        try await composite.prepare()
        #expect(await composite.isReady())
    }

    @Test("every member failing to prepare is a failure that names all of them")
    func totalPrepareFailure() async {
        let composite = CompositeEngine([
            StubEngine(id: "apple", languages: [.english], ready: false, prepareThrows: true),
            StubEngine(id: "whisper-ru", languages: [.russian], ready: false,
                       prepareThrows: true),
        ])
        let error = await #expect(throws: EngineFailure.self) { try await composite.prepare() }
        guard case .notReady(let why) = error else {
            Issue.record("expected .notReady, got \(String(describing: error))")
            return
        }
        #expect(why.contains("apple"))
        #expect(why.contains("whisper-ru"))
    }

    @Test("an empty composite prepares without complaint and is never ready")
    func emptyComposite() async throws {
        // Reachable during startup before any model is configured.
        let composite = CompositeEngine([])
        try await composite.prepare()
        #expect(await composite.isReady() == false)
    }

    // The shipped arrangement: Apple (English, prepared at startup) and whisper-ru (Russian,
    // cold on default settings) share the `.unified` slot. `isReady()` is an OR, so it reads
    // true on Apple alone — which means the session's own cold-start retry never fires for this
    // composite, and the cold Russian model has to be loaded here or nowhere. It used to be
    // skipped, so every Russian dictation failed on a stock install, permanently.
    @Test("a cold member that serves the language is loaded, not skipped")
    func coldMemberIsLoaded() async throws {
        let apple = StubEngine(id: "apple", languages: [.english], ready: true)
        let russian = StubEngine(id: "whisper-ru", languages: [.russian], ready: false)
        let composite = CompositeEngine([apple, russian])

        #expect(await composite.isReady(), "Apple alone makes the composite read as ready")

        let transcript = try await composite.transcribe(AudioBuffer(samples: [0.1]),
                                                        language: .russian)
        #expect(transcript.engineID == "whisper-ru")
        #expect(await russian.isReady(), "the cold member must have been prepared, not skipped")
        #expect(await apple.callCount() == 0, "and English must not have answered for Russian")
    }

    @Test("a member that cannot load says why, instead of just being absent")
    func coldMemberThatFailsExplains() async {
        let composite = CompositeEngine([
            StubEngine(id: "apple", languages: [.english], ready: true),
            StubEngine(id: "whisper-ru", languages: [.russian], ready: false, prepareThrows: true),
        ])
        let error = await #expect(throws: EngineFailure.self) {
            try await composite.transcribe(AudioBuffer(samples: [0.1]), language: .russian)
        }
        guard case .notReady(let why) = error else {
            Issue.record("expected .notReady, got \(String(describing: error))")
            return
        }
        #expect(why.contains("whisper-ru"))
        #expect(why.contains("refuses"), "the member's own reason must survive: \(why)")
    }
}
