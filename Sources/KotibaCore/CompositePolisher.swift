import Foundation

// Several polishers behind one, picked by language.
//
// Apple's on-device model claims 23 locales and neither Russian nor Uzbek is among them —
// Turkish is, which is the exact attractor that makes Uzbek go wrong. So "prefer on-device"
// cannot mean "use on-device": choosing it outright would silently strip polish from two of
// Kotiba's three languages, because `DictationSession` skips a polisher that does not claim the
// route's language.
//
// Ordered, first-capable-wins. Same shape as `CompositeEngine`, and for the same reason: the
// choice is between engines for one language, never between languages.

/// Collects what the composite has to say about a run, so it survives to the record.
/// An actor because copies of the struct must share one, and because the alternative is an
/// `@unchecked Sendable` exemption this module has no business spending.
private actor RunNotes {
    private var notes: [String] = []
    func add(_ note: String) { notes.append(note) }
    func drain() -> [String] {
        defer { notes.removeAll() }
        return notes
    }
}

public struct CompositePolisher: PolishEngine {

    private let members: [any PolishEngine]
    private let notes = RunNotes()

    public init(_ members: [any PolishEngine]) {
        self.members = members
    }

    public func drainNotes() async -> [String] { await notes.drain() }

    /// Named for what actually ran, resolved at construction so diagnostics can show the set.
    public var polishID: String {
        members.map(\.polishID).joined(separator: "+")
    }

    public var supportedLanguages: Set<Language> {
        members.reduce(into: Set<Language>()) { $0.formUnion($1.supportedLanguages) }
    }

    public func polish(_ text: String, language: Language,
                       instructions: String) async throws -> String {
        try await firstCapable(language) { member in
            try await member.polish(text, language: language, instructions: instructions)
        }
    }

    private func firstCapable(
        _ language: Language,
        _ body: (any PolishEngine) async throws -> String
    ) async throws -> String {
        var lastFailure: (any Error)?
        var failedBefore: [String] = []
        for member in members where member.supportedLanguages.contains(language) {
            do {
                let polished = try await body(member)
                // Say so when this was not the first choice. Falling back from the on-device
                // member to a network one sends the user's dictation somewhere they asked it not
                // to go, and until this line existed nothing recorded that it had happened.
                if let first = failedBefore.first {
                    await notes.add(
                        "polish fell back to \(member.polishID) after \(first) failed"
                        + (failedBefore.count > 1
                           ? " (and \(failedBefore.count - 1) more)" : ""))
                }
                return polished
            } catch {
                // A member that fails is not the end: the next one may serve this language too,
                // and the raw transcript is already on screen either way. The error is kept so
                // the caller records something specific rather than "polish failed".
                lastFailure = error
                failedBefore.append("\(member.polishID) (\(error))")
                if Task.isCancelled { throw error }
            }
        }
        if let lastFailure { throw lastFailure }
        throw PolishFailure.emptyResponse(endpoint: polishID)
    }
}

// Structured prompts go through to a member that can hold them as turns; the others get the
// rendered string. Same order, same fallback, same notes.
extension CompositePolisher: PromptedPolishEngine {
    public func polish(_ text: String, language: Language, prompt: PolishPrompt,
                       maxOutputTokens: Int) async throws -> String {
        try await firstCapable(language) { member in
            try await member.polish(text, language: language, prompt: prompt,
                                    maxOutputTokens: maxOutputTokens)
        }
    }

    public func prepare(_ prompts: [PolishPrompt]) async {
        for case let member as any PromptedPolishEngine in members {
            await member.prepare(prompts)
        }
    }

    /// Only the member that will answer `language` — the first that claims it.
    public func prepare(_ prompts: [PolishPrompt], language: Language) async {
        guard let member = members.first(where: { $0.supportedLanguages.contains(language) }),
              let prompted = member as? any PromptedPolishEngine else { return }
        await prompted.prepare(prompts, language: language)
    }
}
