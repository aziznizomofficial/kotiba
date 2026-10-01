import Foundation
import Synchronization

// Polish while the user is still talking.
//
// Measured before this existed: polish was the single largest latency item, median 1,615 ms and
// p90 3,687 ms after key-release, because the whole dictation went to a model only once the
// key came up. The speech itself arrives over seconds or minutes; almost all of it is known long
// before release. So each sentence is polished the moment the transcriber commits it, in the
// background, and at release only the sentence still being spoken remains:
//
//     commit("First sentence. Second")   → "First sentence." polishing now
//     commit(" sentence. Third")         → "Second sentence." queued behind it
//     finish(tail: " sentence")          → "Third sentence." — the only work left after release
//
// What the user waits for is therefore the *tail*: one sentence of prefill and generation. With
// Qwen3-1.7B on this M4 Pro that is ~90–160 ms at p50 (docs/research/C3-on-device-modes.md §5),
// against the 1,615 ms it replaces.
//
// Three properties are load-bearing:
//
//   * **Per-sentence fallback.** Every sentence carries its deterministic form, and that is what
//     is delivered if the model is slow, fails, or is refused by a guard — for that sentence
//     alone. A model that invents in sentence 7 of 12 no longer costs sentences 1–6 and 8–12.
//   * **One engine, in order.** A single llama.cpp context cannot run two generations at once,
//     and sentence order is the output order, so jobs are chained: each waits for the one before.
//   * **Insert once, never replace.** The result is meant to be pasted once, after `finish`.
//     Paste-then-replace was the commonest failure on record — `polish replace refused` 94 times
//     — because many apps do not expose their text over Accessibility.

public actor IncrementalPolish {

    public struct Outcome: Sendable, Equatable {
        public var text: String
        /// Per-sentence events worth a line in the diagnostics: fallbacks and why.
        public var notes: [String]
        public var sentences: Int
        /// Sentences whose model output was used.
        public var modelSentences: Int
        /// Wall-clock time `finish` spent waiting, i.e. what the user saw after release.
        public var tailMilliseconds: Double
        /// Sentences whose result came from `prime` — polished while the key was held.
        public var primed: Int = 0
    }

    public let behaviour: ModeBehaviour
    public let language: Language
    private let engine: (any PolishEngine)?
    private let usesModel: Bool

    private var pending = ""
    private var jobs: [Job] = []
    private var chain: Task<Void, Never>?
    private var headingJob: Task<String?, Never>?
    private var finished = false

    /// Sentences polished by `prime`, by their exact text, and those still being polished.
    private var memo: [String: SentenceResult] = [:]
    private var priming: [String: Task<SentenceResult?, Never>] = [:]
    /// A heading primed over the first three sentences, keyed by those sentences.
    private var primedHeading: (key: String, task: Task<String?, Never>)?
    private var primedHits = 0

    private struct Job {
        let sentence: String
        let task: Task<SentenceResult, Never>
    }

    /// Whether a model is involved for this mode and language at all. Without one every sentence
    /// is deterministic and instant, and priming has nothing to save.
    public var wantsModel: Bool { usesModel }

    struct SentenceResult: Sendable {
        var text: String
        var kind: NoteLayout.Kind?
        var usedModel: Bool
        var note: String?
    }

    /// `engine` may be nil, or may not claim `language`; the mode then runs on the deterministic
    /// layer alone, which is always correct and never slower.
    /// `superModelLanguages` is where Super asks the model at all; the default is the measured set.
    public init(behaviour: ModeBehaviour, language: Language, engine: (any PolishEngine)?,
                superModelLanguages: Set<Language> = OnDeviceModes.superModelLanguages) {
        self.behaviour = behaviour
        self.language = language
        self.engine = engine
        let claims = engine?.supportedLanguages.contains(language) ?? false
        switch behaviour {
        case .raw: usesModel = false
        case .superMode: usesModel = claims && superModelLanguages.contains(language)
        case .message, .note: usesModel = claims
        }
    }

    /// The prompts this session will run, so the engine can prefill them at key-down.
    public var prompts: [PolishPrompt] {
        guard usesModel else { return [] }
        switch behaviour {
        case .raw: return []
        case .superMode: return [OnDeviceModes.superPrompt(language)]
        case .message: return [OnDeviceModes.messagePrompt(language)]
        case .note: return [OnDeviceModes.noteClassifierPrompt(language),
                            OnDeviceModes.headingPrompt(language)]
        }
    }

    /// Warm the engine for this mode and language. Safe to skip; costs only the first sentence.
    public func prepare() async {
        guard usesModel, let prompted = engine as? any PromptedPolishEngine else { return }
        await prompted.prepare(prompts, language: language)
    }

    /// Text the transcriber has committed and will not revise. Complete sentences start polishing
    /// immediately; an unfinished one waits for more text or for `finish`.
    public func commit(_ segment: String) {
        guard !finished else { return }
        pending += segment
        let (complete, rest) = SentenceSplitter.split(pending, keepIncompleteTail: true)
        pending = rest
        for sentence in complete { enqueue(sentence) }
        startHeadingIfDue(final: false)
    }

    /// Polish, in the background, every complete sentence of `text` — the transcript *so far*,
    /// normalised exactly as the final one will be — that has not been polished yet.
    ///
    /// This is how the modes get ahead of key-up with a transcriber whose text is still
    /// provisional. Nothing primed is ever delivered on its own authority: `finish` looks each
    /// sentence of the *final* transcript up by its exact text, so a sentence the transcriber
    /// revised after it was primed is simply never asked for, and is polished at key-up like any
    /// other. What survives unchanged — nearly everything before the last pause — costs nothing
    /// after release. Call it as often as the text changes; a sentence is primed once.
    ///
    /// `includingLast` primes the unfinished last sentence too, exactly as `finish` would split
    /// it: most pauses before key-up are the end of it, and then it is the only sentence left.
    public func prime(_ text: String, includingLast: Bool = false) {
        guard !finished, usesModel else { return }
        let (complete, _) = SentenceSplitter.split(text, keepIncompleteTail: !includingLast)
        for sentence in complete where memo[sentence] == nil && priming[sentence] == nil {
            let previous = chain
            let behaviour = self.behaviour
            let language = self.language
            let engine = self.engine
            let task = Task<SentenceResult?, Never> {
                await previous?.value
                guard !Task.isCancelled else { return nil }
                let result = await Self.process(sentence, behaviour: behaviour, language: language,
                                                engine: engine)
                return Task.isCancelled ? nil : result
            }
            chain = Task { _ = await task.value }
            priming[sentence] = task
            Task { self.primed(sentence, await task.value) }
        }
        // Note: a heading over the first three sentences, as `startHeadingIfDue` would make it.
        if behaviour == .note, primedHeading == nil, complete.count >= 3, let engine {
            let text = complete.prefix(3).joined(separator: " ")
            let previous = chain
            let language = self.language
            let task = Task<String?, Never> {
                await previous?.value
                guard !Task.isCancelled else { return nil }
                return await Self.heading(for: text, language: language, engine: engine)
            }
            primedHeading = (text, task)
            chain = Task { _ = await task.value }
        }
    }

    private func primed(_ sentence: String, _ result: SentenceResult?) {
        priming[sentence] = nil
        if let result { memo[sentence] = result }
    }

    /// Everything after the last commit, then wait — at most `deadline` — for every sentence.
    /// A sentence still running at the deadline is delivered in its deterministic form.
    public func finish(tail: String, deadline: Duration = .milliseconds(1500)) async -> Outcome {
        let clock = ContinuousClock()
        let started = clock.now
        // Super in a language with a cap waits for the model only that long after release
        // (`OnDeviceModes.superTailCap`); what is not done by then goes in as the clean-up wrote it.
        let deadline = behaviour == .superMode
            ? min(deadline, OnDeviceModes.superTailCap[language] ?? deadline) : deadline
        let until = started.advanced(by: deadline)
        if !finished {
            finished = true
            pending += tail
            let (complete, _) = SentenceSplitter.split(pending, keepIncompleteTail: false)
            pending = ""
            // A primed sentence the final transcript no longer contains is dead work: stop it, so
            // the sentences that are still to do do not queue behind it.
            let wanted = Set(complete)
            for (sentence, task) in priming where !wanted.contains(sentence) { task.cancel() }
            if let primedHeading,
               complete.prefix(3).joined(separator: " ") != primedHeading.key {
                primedHeading.task.cancel()
                self.primedHeading = nil
            }
            for sentence in complete { enqueue(sentence) }
            startHeadingIfDue(final: true)
        }

        var results: [SentenceResult] = []
        var notes: [String] = []
        for job in jobs {
            if let result = await Self.value(of: job.task, until: until) {
                results.append(result)
            } else {
                job.task.cancel()
                results.append(fallback(job.sentence))
                notes.append("sentence not polished within \(deadline); kept as spoken")
            }
        }
        var heading: String?
        if let headingJob {
            heading = await Self.value(of: headingJob, until: until) ?? nil
            headingJob.cancel()
        }
        chain?.cancel()
        // Whatever the hold primed and the deadline did not wait for is dead work now, and it is
        // not stopped by anything above: a sentence found in `priming` became a job that *awaits*
        // the priming task, and cancelling that job does not reach the task it awaits — nor the
        // primes queued behind it, each its own unstructured task. Left running they kept the one
        // model context generating after this dictation had been pasted, and the next dictation's
        // sentences queued behind them (`LlamaEngine` is one actor) until its own deadline passed.
        for task in priming.values { task.cancel() }
        primedHeading?.task.cancel()
        notes += results.compactMap(\.note)

        let text = assemble(results, heading: heading)
        let elapsed = clock.now - started
        return Outcome(
            text: text, notes: notes, sentences: results.count,
            modelSentences: results.filter(\.usedModel).count,
            tailMilliseconds: Double(elapsed.components.seconds) * 1000
                + Double(elapsed.components.attoseconds) / 1e15,
            primed: primedHits)
    }

    /// Returns once every committed sentence has been processed. For callers that want to know
    /// the background has caught up — the probe measuring tail cost, and tests.
    public func idle() async {
        await chain?.value
    }

    /// Stop everything. What has been committed is abandoned.
    public func cancel() {
        finished = true
        chain?.cancel()
        headingJob?.cancel()
        for job in jobs { job.task.cancel() }
        for task in priming.values { task.cancel() }
        primedHeading?.task.cancel()
    }

    // MARK: Jobs

    private func enqueue(_ sentence: String) {
        // Primed during the hold: done, or nearly — never queued behind anything.
        if let hit = memo[sentence] {
            primedHits += 1
            jobs.append(Job(sentence: sentence, task: Task { hit }))
            return
        }
        if let running = priming[sentence] {
            primedHits += 1
            let behaviour = self.behaviour
            let language = self.language
            let engine = usesModel ? self.engine : nil
            let task = Task<SentenceResult, Never> {
                if let result = await running.value { return result }
                return await Self.process(sentence, behaviour: behaviour, language: language,
                                          engine: engine)
            }
            jobs.append(Job(sentence: sentence, task: task))
            return
        }
        let previous = chain
        let behaviour = self.behaviour
        let language = self.language
        let engine = usesModel ? self.engine : nil
        let task = Task<SentenceResult, Never> {
            // One generation at a time, in order.
            await previous?.value
            return await Self.process(sentence, behaviour: behaviour, language: language,
                                      engine: engine)
        }
        chain = Task { _ = await task.value }
        jobs.append(Job(sentence: sentence, task: task))
    }

    /// A heading once there is enough note to name: after the third sentence during capture, or
    /// at finish for a note of two sentences. One sentence gets no heading — it would only repeat
    /// itself.
    private func startHeadingIfDue(final: Bool) {
        guard behaviour == .note, usesModel, headingJob == nil, let engine else { return }
        guard jobs.count >= 3 || (final && jobs.count == 2) else { return }
        let text = jobs.prefix(3).map(\.sentence).joined(separator: " ")
        if let primedHeading, primedHeading.key == text {
            headingJob = primedHeading.task
            return
        }
        let previous = chain
        let language = self.language
        let task = Task<String?, Never> {
            await previous?.value
            guard !Task.isCancelled else { return nil }
            return await Self.heading(for: text, language: language, engine: engine)
        }
        headingJob = task
        chain = Task { _ = await task.value }
    }

    static func heading(for text: String, language: Language,
                        engine: any PolishEngine) async -> String? {
        guard let raw = try? await engine.polish(
            text, language: language, prompt: OnDeviceModes.headingPrompt(language),
            maxOutputTokens: 16) else { return nil }
        let heading = NoteLayout.cleanHeading(raw)
        guard NoteLayout.acceptsHeading(heading, for: text) else { return nil }
        // Uzbek takes the same bar the whole note is held to before it is inserted
        // (`UzbekPolishGuard`, which admits no new word at all). The stem rule above accepts
        // `Ertangi rejalar` over `Ertaga rejalarimizni…`; the note guard then refused the whole
        // note for the one inflected heading word, and every checkbox went with it.
        if language == .uzbek, !UzbekPolishGuard.check(heading, against: text).isAccepted {
            return nil
        }
        return heading
    }

    /// The task's value, or nil at the deadline — whichever comes first, without waiting for the
    /// loser. A task group cannot do this: it waits for every child, and a child awaiting an
    /// engine that has not yet noticed its cancellation holds `finish` hostage for as long as the
    /// engine takes. Measured with a 5 s engine and a 50 ms deadline: 5,050 ms. The job itself is
    /// cancelled by the caller.
    private static func value<T: Sendable>(of task: Task<T, Never>,
                                           until deadline: ContinuousClock.Instant) async -> T? {
        let race = Race<T>()
        return await withCheckedContinuation { continuation in
            race.start(continuation)
            Task { race.finish(await task.value) }
            Task {
                try? await Task.sleep(until: deadline, clock: .continuous)
                race.finish(nil)
            }
        }
    }

    // MARK: Per sentence

    private func fallback(_ sentence: String) -> SentenceResult {
        // A note lays its own lines out; a line break the sentence opened with is not part of it.
        let sentence = behaviour == .note
            ? sentence.trimmingCharacters(in: .whitespacesAndNewlines) : sentence
        return SentenceResult(text: sentence,
                       kind: behaviour == .note ? Self.heuristicKind(sentence, language) : nil,
                       usedModel: false, note: nil)
    }

    static func heuristicKind(_ sentence: String, _ language: Language) -> NoteLayout.Kind {
        if NoteLayout.strippingOrdinal(sentence, language: language) != nil { return .item }
        return NoteLayout.looksLikeTask(sentence, language: language) ? .task : .point
    }

    static func process(_ sentence: String, behaviour: ModeBehaviour, language: Language,
                        engine: (any PolishEngine)?) async -> SentenceResult {
        let kept = SentenceResult(text: sentence, kind: nil, usedModel: false, note: nil)
        switch behaviour {
        case .raw:
            return kept

        case .superMode:
            guard let engine, !Task.isCancelled else { return kept }
            do {
                let raw = try await engine.polish(
                    sentence, language: language, prompt: OnDeviceModes.superPrompt(language),
                    maxOutputTokens: SentenceSplitter.tokenBudget(for: sentence))
                let projected = PunctuationProjection.project(raw, onto: sentence)
                guard projected.aligned >= PunctuationProjection.minimumAlignment else {
                    return SentenceResult(
                        text: sentence, kind: nil, usedModel: false,
                        note: String(format: "super: model rewrote a sentence (%.0f%% aligned); "
                                     + "kept as spoken", projected.aligned * 100))
                }
                return SentenceResult(text: projected.text, kind: nil,
                                      usedModel: projected.text != sentence, note: nil)
            } catch {
                return SentenceResult(text: sentence, kind: nil, usedModel: false,
                                      note: "super: \(engine.polishID) failed: \(error)")
            }

        case .message:
            // No model: the rules — `trimOpeners`, which leaves a language without openers
            // untouched.
            guard let engine, !Task.isCancelled else {
                let trimmed = OnDeviceModes.trimOpeners(sentence, language: language)
                return SentenceResult(text: trimmed, kind: nil, usedModel: false, note: nil)
            }
            let prompt = OnDeviceModes.messagePrompt(language)
            do {
                let raw = try await engine.polish(
                    sentence, language: language, prompt: prompt,
                    maxOutputTokens: SentenceSplitter.tokenBudget(for: sentence))
                let output = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                // Arabic (C4 §14.5): the speaker's words with the model's punctuation, minus the
                // fillers, openers and repeats the model took out — never a word changed.
                if OnDeviceModes.messageByProjection.contains(language) {
                    let mayDrop = (OnDeviceModes.droppable[language] ?? [])
                        .union(OnDeviceModes.openers[language] ?? [])
                    let projected = PunctuationProjection.project(output, onto: sentence,
                                                                  mayDrop: mayDrop)
                    guard projected.aligned >= PunctuationProjection.minimumAlignment else {
                        let trimmed = OnDeviceModes.trimOpeners(sentence, language: language)
                        return SentenceResult(
                            text: trimmed, kind: nil, usedModel: false,
                            note: String(format: "message: model rewrote a sentence (%.0f%% "
                                         + "aligned); kept as spoken", projected.aligned * 100))
                    }
                    let delivered = OnDeviceModes.trimOpeners(
                        Orthography.forDelivery(projected.text, language: language),
                        language: language)
                    return SentenceResult(text: delivered, kind: nil,
                                          usedModel: delivered != sentence, note: nil)
                }
                if let rejection = SentenceGuard.checkRewrite(
                    output, against: sentence, language: language, prompt: prompt,
                    mayDrop: OnDeviceModes.droppable[language] ?? []) {
                    return SentenceResult(text: sentence, kind: nil, usedModel: false,
                                          note: "message: \(rejection); kept as spoken")
                }
                // The model writes ASCII apostrophes, and Latin `,` `?` after Arabic words; the rest
                // of the dictation carries what the session's normaliser put there.
                let delivered = Orthography.forDelivery(output, language: language)
                return SentenceResult(text: delivered, kind: nil, usedModel: delivered != sentence,
                                      note: nil)
            } catch {
                return SentenceResult(text: sentence, kind: nil, usedModel: false,
                                      note: "message: \(engine.polishID) failed: \(error)")
            }

        case .note:
            // The splitter keeps a sentence's leading line break so running text survives the
            // round trip; a note makes its own lines, and left in, the break defeated every rule
            // below that reads the sentence's first word — a task became prose — and a TASK
            // label wrote `- [ ] ` over a stray empty line.
            let sentence = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
            // An enumerated sentence is an item whatever a model thinks.
            if NoteLayout.strippingOrdinal(sentence, language: language) != nil {
                return SentenceResult(text: sentence, kind: .item, usedModel: false, note: nil)
            }
            let heuristic = heuristicKind(sentence, language)
            guard let engine, !Task.isCancelled else {
                return SentenceResult(text: sentence, kind: heuristic, usedModel: false, note: nil)
            }
            do {
                let raw = try await engine.polish(
                    sentence, language: language,
                    prompt: OnDeviceModes.noteClassifierPrompt(language), maxOutputTokens: 3)
                let label = raw.uppercased()
                let kind: NoteLayout.Kind = label.contains("TASK") ? .task
                    : label.contains("POINT") ? .point : heuristic
                return SentenceResult(text: sentence, kind: kind, usedModel: true, note: nil)
            } catch {
                return SentenceResult(text: sentence, kind: heuristic, usedModel: false,
                                      note: "note: \(engine.polishID) failed: \(error)")
            }
        }
    }

    // MARK: Assembly

    private func assemble(_ results: [SentenceResult], heading: String?) -> String {
        switch behaviour {
        case .raw, .superMode, .message:
            return Self.joinSentences(results.map(\.text))
        case .note:
            let lines = results.map {
                NoteLayout.line(for: $0.text, kind: $0.kind ?? .point, language: language)
            }
            return NoteLayout.render(heading: heading, lines: lines)
        }
    }

    /// Sentences back into running text. A sentence that began a new line when it was spoken
    /// ("new line", a paragraph break the transcriber kept) still begins one.
    static func joinSentences(_ sentences: [String]) -> String {
        var out = ""
        for sentence in sentences where !sentence.isEmpty {
            if out.isEmpty || out.hasSuffix("\n") || sentence.hasPrefix("\n") {
                out += sentence
            } else {
                out += " " + sentence
            }
        }
        return out
    }
}

/// Resume a continuation exactly once, from whichever side gets there first.
private final class Race<T: Sendable>: Sendable {
    private let state = Mutex<(CheckedContinuation<T?, Never>?, Bool)>((nil, false))

    func start(_ continuation: CheckedContinuation<T?, Never>) {
        state.withLock { $0.0 = continuation }
    }

    func finish(_ value: T?) {
        let continuation: CheckedContinuation<T?, Never>? = state.withLock { s in
            guard !s.1, let c = s.0 else { return nil }
            s.1 = true
            return c
        }
        continuation?.resume(returning: value)
    }
}

// MARK: - Sentences

public enum SentenceSplitter {

    /// Splits at `. ! ? …` followed by whitespace, and at line breaks. Fragments shorter than
    /// three words ride along with the next sentence: a model given "Okay." alone has nothing to
    /// work with and is at its most likely to invent.
    ///
    /// With `keepIncompleteTail`, text after the last terminator is returned as the remainder —
    /// the transcriber may still be adding to it. Without it (at `finish`), it is a sentence.
    public static func split(_ text: String,
                             keepIncompleteTail: Bool) -> (sentences: [String], rest: String) {
        var sentences: [String] = []
        var current = ""
        let chars = Array(text)
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            // A line break ends the sentence before it and opens the next one, which carries it —
            // so "new line" still starts a line after the sentences are joined back together.
            if ch == "\n" {
                if !current.trimmingCharacters(in: .whitespaces).isEmpty {
                    sentences.append(current)
                    current = ""
                }
                current.append(ch)
                i += 1
                continue
            }
            current.append(ch)
            let atBoundary: Bool
            if ".!?…".contains(ch), i + 1 < chars.count,
                      chars[i + 1] == " " || chars[i + 1] == "\n" {
                // `3.5`, `e.g.` and `a.m.` are not boundaries: the character after a real
                // sentence end is whitespace, and the word before is longer than one letter.
                let word = current.dropLast().split(separator: " ").last ?? ""
                atBoundary = !(ch == "." && (word.count <= 1 || word.contains(".")))
            } else {
                atBoundary = false
            }
            if atBoundary {
                sentences.append(current)
                current = ""
            }
            i += 1
        }

        // Merge short fragments forward, keeping their leading line breaks with them.
        var merged: [String] = []
        var carry = ""
        for sentence in sentences {
            let piece = carry + sentence
            if wordCount(piece) < 3 && !piece.contains("\n") {
                carry = piece
            } else {
                merged.append(piece)
                carry = ""
            }
        }
        var rest = carry + current
        if !keepIncompleteTail {
            if !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if wordCount(rest) < 3, let last = merged.popLast() {
                    merged.append(last + rest)
                } else {
                    merged.append(rest)
                }
            }
            rest = ""
        }
        return (merged.map(tidy).filter { !$0.isEmpty }, rest)
    }

    /// Leading spaces go; a leading line break stays, so layout survives the round trip.
    static func tidy(_ sentence: String) -> String {
        let breaks = sentence.prefix(while: { $0 == "\n" || $0 == " " }).filter { $0 == "\n" }
        let body = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty ? "" : String(breaks) + body
    }

    static func wordCount(_ text: String) -> Int {
        text.split(whereSeparator: { $0 == " " || $0 == "\n" }).count
    }

    /// Output ceiling for one sentence: its own length in tokens and a margin. Runaway generation
    /// is stopped here rather than detected afterwards.
    public static func tokenBudget(for sentence: String) -> Int {
        sentence.count / 2 + 24
    }
}

// MARK: - Guard for one rewritten sentence

public enum SentenceGuard {

    /// Why a rewritten sentence may not replace the original, or nil when it may.
    ///
    /// On top of `PolishGuard` (refusal, echo, length, script, overlap), which was tuned for
    /// whole dictations: a rewrite may drop words and change their form, but every content word
    /// it contains must come from the input — equal, or sharing a stem (`приложения` →
    /// `приложении`). Measured on Qwen3-1.7B and Qwen3-4B Message rewrites of the owner's
    /// sentences, this is what separates "Yes, keep only telegram." → "Keep only Telegram."
    /// (fine) from "Apply the price added…" → "Apply the price increase…" (a changed fact).
    /// Uzbek gets `UzbekPolishGuard` instead, which admits no new word at all: its suffixes carry
    /// person and tense, and a changed suffix is a changed meaning (`bo'lsam` → `bo'lsak`).
    /// `mayDrop`, when given, is the only vocabulary the rewrite may delete.
    public static func checkRewrite(_ output: String, against input: String, language: Language,
                                    prompt: PolishPrompt,
                                    mayDrop: Set<String>? = nil) -> String? {
        guard !output.isEmpty else { return "empty output" }
        let sentenceGuard = PolishGuard(minimumRatio: 0.3, maximumRatio: 1.6,
                                        shortInputHeadroom: 24, minimumOverlap: 0.4)
        if let rejection = sentenceGuard.check(output, against: input,
                                               instructions: prompt.rendered) {
            return rejection.reason
        }
        if prompt.examples.contains(where: { $0.output == output && $0.input != input }) {
            return "polish returned one of its own examples"
        }
        if let mayDrop {
            let dropped = droppedWords(from: input, in: output, mayDrop: mayDrop,
                                       exact: language == .uzbek)
            guard dropped.isEmpty else {
                return "polish deleted words the speaker said "
                    + SpokenText.quote(dropped.prefix(4).joined(separator: ", "))
            }
        }
        if language == .uzbek {
            let verdict = UzbekPolishGuard.check(output, against: input)
            return verdict.isAccepted ? nil : verdict.reason
        }
        let novel = novelWords(in: output, given: input)
        guard novel.isEmpty else {
            return "polish introduced words the speaker did not say "
                + SpokenText.quote(novel.prefix(4).joined(separator: ", "))
        }
        return nil
    }

    /// Words of `input` that `output` lost, other than those in `mayDrop` and grammar words.
    ///
    /// `exact` demands the word itself back, not an inflection: Uzbek suffixes carry tense,
    /// person and case, and the stem rule accepted `ertaga` (tomorrow) → `erta` (early).
    public static func droppedWords(from input: String, in output: String,
                                    mayDrop: Set<String>, exact: Bool = false) -> [String] {
        let kept = words(of: output)
        let allowed = Set(mayDrop.map(fold))
        return words(of: input).filter { word in
            !allowed.contains(word) && word.count > 2 && !isConnective(word)
                && !kept.contains(where: { exact ? $0 == word : sharesStem(word, $0) })
        }
    }

    static func fold(_ word: String) -> String {
        arabicFold(UzbekPolishGuard.foldApostrophes(word.lowercased()))
    }

    /// Arabic spelling a rewrite may change without changing a word (C4 §14.5): vowel marks and
    /// tatweel dropped, the alef forms as `ا`, `ى` as `ي`, `ة` as `ه` — the orthographic choices
    /// writers make freely (C4's scorer folds the same). Text with no Arabic is returned as is.
    static func arabicFold(_ word: String) -> String {
        guard word.unicodeScalars.contains(where: ScriptCheck.isArabicLetter) else { return word }
        var out = String.UnicodeScalarView()
        for scalar in word.unicodeScalars {
            switch scalar.value {
            case 0x064B...0x065F, 0x0670, 0x0640: continue
            case 0x0622, 0x0623, 0x0625, 0x0671: out.append("\u{0627}")
            case 0x0649: out.append("\u{064A}")
            case 0x0629: out.append("\u{0647}")
            default: out.append(scalar)
            }
        }
        return String(out)
    }

    /// An Arabic word without the clitics written onto its front — `و`/`ف` ("and"), then
    /// `ب`/`ل`/`ك` ("in/for/like"), then the article `ال` (`لل` for `ل` + `ال`) — so `والكتاب`,
    /// `للكتاب` and `الكتاب` are the one word `كتاب` to the guard. Never shorter than two letters.
    static func arabicStem(_ word: String) -> String {
        var w = Array(word)
        func drop(_ n: Int) { if w.count - n >= 2 { w.removeFirst(n) } }
        if let first = w.first, first == "\u{0648}" || first == "\u{0641}", w.count > 3 { drop(1) }
        if w.count > 3, w[0] == "\u{0644}", w[1] == "\u{0644}" { drop(2) }
        else {
            if let first = w.first, first == "\u{0628}" || first == "\u{0644}" || first == "\u{0643}",
               w.count > 4, w[1] == "\u{0627}", w[2] == "\u{0644}" { drop(1) }
            if w.count > 3, w[0] == "\u{0627}", w[1] == "\u{0644}" { drop(2) }
        }
        return String(w)
    }

    /// Content words in `output` with no counterpart in `input`.
    public static func novelWords(in output: String, given input: String) -> [String] {
        let source = words(of: input)
        return words(of: output).filter { word in
            !isConnective(word) && !word.allSatisfy(\.isNumber)
                && !source.contains(where: { sharesStem(word, $0) })
        }
    }

    /// Lowercased, apostrophe-folded words.
    static func words(of text: String) -> [String] {
        UzbekPolishGuard.foldApostrophes(text).lowercased()
            .split(whereSeparator: { !($0.isLetter || $0.isNumber || $0 == "\u{02BB}") })
            .map { arabicFold(String($0)) }
    }

    /// The same word, or one inflection of it: one is a prefix of the other, or they share a
    /// stem of at least four letters that covers half of the longer word.
    static func sharesStem(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        // Arabic writes "and", "the" and the prepositions onto the word: compare what is left.
        if a.unicodeScalars.contains(where: ScriptCheck.isArabicLetter) {
            let (x, y) = (arabicStem(a), arabicStem(b))
            if x != a || y != b { return sharesStem(x, y) }
        }
        let shorter = min(a.count, b.count)
        let common = zip(a, b).prefix(while: { $0 == $1 }).count
        if common == shorter, shorter >= 3 { return true }
        return common >= 4 && Double(common) >= 0.5 * Double(max(a.count, b.count))
    }

    /// Grammar words a rewrite may add without adding a fact.
    static func isConnective(_ word: String) -> Bool {
        word.count <= 2 || connectives.contains(word)
    }

    /// Folded the same way `words(of:)` folds, so `i'm` matches the `iʻm` it becomes.
    static let connectives: Set<String> = Set(connectiveList.map(fold))

    static let connectiveList: [String] = [
        // English
        "the", "and", "but", "for", "with", "that", "this", "these", "those", "then", "than",
        "was", "were", "are", "is", "be", "been", "can", "could", "would", "should", "will",
        "shall", "may", "might", "must", "not", "you", "your", "our", "we", "they", "them",
        "their", "his", "her", "its", "it's", "i'm", "i'll", "i've", "let", "let's", "please",
        "also", "just", "there", "here", "what", "which", "who", "how", "when", "where", "why",
        "have", "has", "had", "does", "did", "don't", "doesn't", "can't", "won't", "all", "any",
        "some", "into", "onto", "from", "about", "once", "done",
        // Russian
        "и", "в", "во", "не", "на", "что", "чтобы", "как", "это", "то", "так", "уже", "ещё",
        "еще", "да", "нет", "мы", "вы", "они", "она", "он", "мне", "нам", "вам", "тебе", "для",
        "или", "но", "же", "ли", "бы", "по", "за", "из", "от", "до", "при", "про", "его", "её",
        "их", "все", "всё", "там", "тут", "здесь", "можно", "нужно", "надо", "давай", "давайте",
        // Uzbek
        "va", "bu", "shu", "ham", "bilan", "uchun", "esa", "lekin", "endi", "keyin", "bir",
        "biz", "siz", "ular", "men", "sen", "yoki", "agar", "chunki",
        // Arabic (C4 §14.5): prepositions, conjunctions, pronouns and the copula a rewrite
        // may add to make a sentence read as typed (two-letter ones are connectives anyway).
        "على", "الى", "إلى", "عن", "مع", "لكن", "ثم", "هذا", "هذه", "ذلك", "تلك", "التي", "الذي",
        "الذين", "انه", "أنه", "انها", "أنها", "كان", "كانت", "قد", "لقد", "هو", "هي", "هم",
        "نحن", "انا", "أنا", "انت", "أنت", "كل", "بعض", "او", "أو", "اذا", "إذا", "لان", "لأن",
        "حتى", "عند", "بين", "ايضا", "أيضا", "هناك", "يكون", "تكون",
    ]
}

extension OnDeviceModes {
    /// Languages where Super asks the model for punctuation at all. Measured with the
    /// punctuation prompt and Qwen3-1.7B over the owner's real sentences, after the deterministic
    /// layer:
    ///
    ///   * Uzbek — the transcriber emits no capitals and few commas; the model improved 40 of 40
    ///     sentences (commas, names), for a tail of ~106 ms p50.
    ///   * English — Apple's transcriber already punctuates; 8 of 55 sentences changed, most of
    ///     them a single comma. Not worth a model call after release.
    ///   * Russian — whisper large-v3-turbo already punctuates; 9 of 42 changed and every one was
    ///     a word change that projection throws away.
    ///   * Arabic (C4 §14.5) — Cohere punctuates MSA well and dialect hardly at all (punctuation
    ///     F1 25 against the Casablanca references, a stop at the end of 5 % of clips). Asked to
    ///     punctuate, Gemma 4 E2B lifts dialect to 42.5 (Qwen3-1.7B 35.3) and costs MSA 1.5
    ///     points (73.8 → 72.3); projection keeps every word. 100 % of held-out sentences passed.
    public static let superModelLanguages: Set<Language> = [.uzbek, .arabic]

    /// How long Super waits after release for a sentence the model has not finished, where
    /// that is shorter than the session's tail deadline.
    ///
    /// Arabic (C4 §14.4): a FLEURS dictation's only sentence reaches the model when Cohere's
    /// pause decode lands — after a release 0.3 s past the last word — so Super waited for a whole
    /// generation every time: 203 → 541 ms p50 with Gemma 4 E2B, 402 with Qwen3-1.7B, against a
    /// ~250 ms budget. Capped, Super keeps the model's punctuation for every sentence finished
    /// during the hold and delivers the last one as Cohere and the clean-up wrote it — Message is
    /// the mode that always waits for the model.
    public static let superTailCap: [Language: Duration] = [.arabic: .milliseconds(40)]
}
