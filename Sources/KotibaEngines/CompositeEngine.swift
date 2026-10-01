import Foundation
import KotibaCore

// One `EngineFamily` slot, several engines behind it.
//
// The architecture's two families were drawn around Parakeet TDT v3, which decides English
// against Russian inside its own decoder at zero cost. Parakeet (Ultra) now leads the slot, but it
// downloads 632 MB on first launch and compiles for the Neural Engine on its first load, and for
// that window something else has to answer: Apple's SpeechTranscriber for English, whisper for
// Russian. Without this type a Russian dictation in that window would reach an engine that
// refuses Russian and fail with a message about routing rather than about the missing model.
//
// So the `.unified` slot holds an ordered list: Parakeet, then Apple, then whisper. First engine
// that both supports the language and is ready — or can become ready — wins.
//
// The ordering is a preference, not a fallback in the dangerous sense. It never substitutes a
// different *language* — only a different engine for the language that was asked for. The
// predecessor's silent 30x-slower substitution was a substitution of engine for the same
// language with no record of it; every choice here is recorded in `engineID`.

public actor CompositeEngine: StreamingTranscriptionEngine {

    public nonisolated let engineID: String
    private let engines: [any TranscriptionEngine]

    public init(engineID: String = "composite", _ engines: [any TranscriptionEngine]) {
        self.engineID = engineID
        self.engines = engines
    }

    public nonisolated var supportedLanguages: Set<Language> {
        engines.reduce(into: Set<Language>()) { $0.formUnion($1.supportedLanguages) }
    }

    /// True when *any* member is ready, which is weaker than it looks and must not be read as
    /// "this composite can transcribe your language".
    ///
    /// Readiness here is genuinely per-language — the members hold different models with
    /// independent lifecycles — but `isReady()` takes no language, so this can only answer the
    /// question it was given. Apple's engine is prepared at startup and never unloads, so this
    /// returns true forever, whatever state the Russian model is in.
    ///
    /// The consequence is that a caller holding a composite cannot use this to decide whether to
    /// load anything, and `transcribe` therefore owns loading its own cold members. Before it did,
    /// a cold Russian model was skipped rather than loaded and every Russian dictation failed.
    public func isReady() async -> Bool {
        for engine in engines where await engine.isReady() { return true }
        return false
    }

    /// Prepares every member. One failing does not stop the others: an app with no Russian
    /// model must still dictate English.
    public func prepare() async throws {
        var failures: [String] = []
        for engine in engines {
            do { try await engine.prepare() } catch {
                failures.append("\(engine.engineID): \((error as? EngineFailure)?.reason ?? "\(error)")")
            }
        }
        // Only a total failure is a failure. Anything less and the app still works for
        // something, which is better than refusing to start.
        if failures.count == engines.count, !engines.isEmpty {
            throw EngineFailure.notReady(failures.joined(separator: "; "))
        }
    }

    public func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        var notReady: [String] = []
        for engine in engines where engine.supportedLanguages.contains(language) {
            // A member that is merely cold gets loaded, not skipped. `DictationSession` cannot do
            // this for us: it holds the composite, and `isReady()` here is an OR over members, so
            // it reads true whenever *English* is warm — which it always is, since Apple's engine
            // is prepared at startup. A cold Russian model was therefore invisible to the session's
            // own cold-start retry and skipped straight into `notReady` by the guard that used to
            // be on this line. Every Russian dictation failed on stock defaults, permanently,
            // because nothing on this path ever called `prepare()`.
            if await engine.isReady() == false {
                do {
                    try await engine.prepare()
                } catch {
                    notReady.append(
                        "\(engine.engineID) (\((error as? EngineFailure)?.reason ?? "\(error)"))")
                    continue
                }
                guard await engine.isReady() else { notReady.append(engine.engineID); continue }
            }
            return try await engine.transcribe(audio, language: language)
        }

        if !notReady.isEmpty {
            throw EngineFailure.notReady(
                "\(notReady.joined(separator: ", ")) can do \(language.rawValue) "
                + "but \(notReady.count == 1 ? "is" : "are") not loaded")
        }
        // A composite is a family slot, and its members are whatever the user has configured. So
        // "no member claims this language" is a setup fact, not a design one — reporting it as
        // `languageUnsupported` told the user the router had misrouted when all they had done was
        // never choose a model.
        throw EngineFailure.noEngineInstalled(language)
    }
}

// MARK: - Streaming through a family slot

extension CompositeEngine {
    /// A stream from the first member that can stream — Parakeet, in the shipped slot — which
    /// the session feeds during the hold. At key-up it is used only when that member can do the
    /// routed language; otherwise, or when it fails, the composite's ordinary member-by-member
    /// `transcribe` runs on the finalised recording, so a stream never narrows what the slot
    /// could have done in batch. With no streaming member it is a stream that does nothing.
    public func openStream() async -> any TranscriptionStream {
        for engine in engines {
            if let streaming = engine as? any StreamingTranscriptionEngine {
                return CompositeStream(owner: self, member: streaming,
                                       inner: await streaming.openStream())
            }
        }
        return CompositeStream(owner: self, member: nil, inner: nil)
    }
}

private actor CompositeStream: TranscriptionStream {
    let owner: CompositeEngine
    let member: (any StreamingTranscriptionEngine)?
    let inner: (any TranscriptionStream)?

    init(owner: CompositeEngine, member: (any StreamingTranscriptionEngine)?,
         inner: (any TranscriptionStream)?) {
        self.owner = owner
        self.member = member
        self.inner = inner
    }

    func append(_ samples: [Float]) async {
        await inner?.append(samples)
    }

    private var answeredByInner = false
    private var cancelled = false

    func finish(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        if let member, let inner, member.supportedLanguages.contains(language) {
            do {
                let transcript = try await inner.finish(audio, language: language)
                answeredByInner = true
                return transcript
            } catch {
                // Not ready (still downloading, say) or a decode that failed: the slot's other
                // members get their turn on the same audio, exactly as in batch. Not when the
                // finish itself was called off: then the other members would transcribe the whole
                // recording for nobody.
                if cancelled || Task.isCancelled { throw error }
            }
        } else {
            await inner?.cancel()
        }
        if cancelled || Task.isCancelled { throw CancellationError() }
        return try await owner.transcribe(audio, language: language)
    }

    func cancel() async {
        cancelled = true
        await inner?.cancel()
    }

    func progress() async -> StreamProgress? { await inner?.progress() }
    func setLikely(_ likely: Bool) async { await inner?.setLikely(likely) }
    func lastSpeechEnd() async -> Int? { await inner?.lastSpeechEnd() }

    /// The inner stream's word when it answered; `batch` when a member other than the streaming
    /// one did, because then the whole recording was decoded after key-up.
    func settlement() async -> String? {
        answeredByInner ? await inner?.settlement() : "batch"
    }
}
