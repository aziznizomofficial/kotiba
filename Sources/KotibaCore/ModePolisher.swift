import Foundation

/// A built-in mode as a `PolishEngine`, for the path where the whole transcript arrives at once.
///
/// `IncrementalPolish` is the real shape — sentences polished while the user speaks — but it needs
/// a transcriber that commits text during capture. Until the pipeline streams, this runs the same
/// per-sentence machinery over a finished transcript, so the modes behave identically either way:
/// the same prompts, the same projection for Super, the same per-sentence guards and fallbacks.
/// Only the latency differs — here every sentence is after release.
///
/// It claims every language, because the deterministic layer always works. Whether a *model* is
/// involved for a language is decided per session by what `engine` claims.
public struct ModePolisher: PolishEngine {

    public let behaviour: ModeBehaviour
    private let engine: (any PolishEngine)?
    private let deadline: Duration
    private let notes = ModeNotes()

    /// `deadline` bounds the whole post-release wait on this path, where every sentence is after
    /// release. Two seconds: a long dictation gets its first sentences from the model and the
    /// rest in their deterministic form, rather than holding the paste. The session's own 8 s
    /// ceiling is never reached. With a streaming transcriber `IncrementalPolish` applies its
    /// deadline to the tail alone and this does not arise.
    public init(behaviour: ModeBehaviour, engine: (any PolishEngine)?,
                deadline: Duration = .seconds(2)) {
        self.behaviour = behaviour
        self.engine = engine
        self.deadline = deadline
    }

    public var polishID: String {
        "\(behaviour.rawValue)+" + (engine?.polishID ?? "rules")
    }

    public let supportedLanguages = Set(Language.allCases)

    /// `instructions` is ignored: a built-in mode carries its own per-sentence prompts, and the
    /// rendered whole-dictation template is only for user-authored modes and the cloud path.
    public func polish(_ text: String, language: Language,
                       instructions: String) async throws -> String {
        let session = IncrementalPolish(behaviour: behaviour, language: language, engine: engine)
        let outcome = await session.finish(tail: text, deadline: deadline)
        await notes.record(outcome, engine: engine)
        return outcome.text
    }

    public func drainNotes() async -> [String] {
        var drained = await notes.drain()
        if let engine { drained += await engine.drainNotes() }
        return drained
    }
}

private actor ModeNotes {
    private var notes: [String] = []
    func record(_ outcome: IncrementalPolish.Outcome, engine: (any PolishEngine)?) {
        // Only what went wrong: `DictationSession` files these under the record's errors.
        notes += outcome.notes
    }
    func drain() -> [String] {
        defer { notes.removeAll() }
        return notes
    }
}
