import Foundation
import Testing
@testable import KotibaCore

// The on-device modes against a scripted engine. Fixtures are invented sentences in the shapes the
// real measurements found (docs/research/C3-on-device-modes.md), never the owner's own words.

/// Answers from a table keyed by the input; records what it was asked and in what order.
actor ScriptedEngine: PromptedPolishEngine {
    nonisolated let polishID = "scripted"
    nonisolated let supportedLanguages: Set<Language>
    private let answers: [String: String]
    private let delay: Duration
    private(set) var asked: [String] = []
    private(set) var prepared: [PolishPrompt] = []
    private var running = 0
    private(set) var maxConcurrent = 0

    init(_ answers: [String: String], languages: Set<Language> = Set(Language.allCases),
         delay: Duration = .zero) {
        self.answers = answers
        self.supportedLanguages = languages
        self.delay = delay
    }

    nonisolated func polish(_ text: String, language: Language,
                            instructions: String) async throws -> String {
        try await polish(text, language: language, prompt: PolishPrompt(system: instructions),
                         maxOutputTokens: 64)
    }

    nonisolated func polish(_ text: String, language: Language, prompt: PolishPrompt,
                            maxOutputTokens: Int) async throws -> String {
        try await answer(text)
    }

    nonisolated func prepare(_ prompts: [PolishPrompt]) async { await record(prompts) }

    private func record(_ prompts: [PolishPrompt]) { prepared += prompts }

    private func answer(_ text: String) async throws -> String {
        asked.append(text)
        running += 1
        maxConcurrent = max(maxConcurrent, running)
        defer { running -= 1 }
        if delay > .zero { try await Task.sleep(for: delay) }
        guard let answer = answers[text] else { throw PolishFailure.emptyResponse(endpoint: "scripted") }
        return answer
    }
}

struct PunctuationProjectionTests {

    @Test("the model's punctuation and case land on the speaker's words")
    func projectsPunctuation() {
        let result = PunctuationProjection.project(
            "Xoʻp, qarang, buvim bozorga ketdilar.", onto: "xoʻp qarang buvim bozorga ketdilar")
        #expect(result.text == "Xoʻp, qarang, buvim bozorga ketdilar.")
        #expect(result.aligned == 1)
    }

    @Test("a word the model changed keeps the speaker's spelling")
    func changedWordIsNotAdopted() {
        // Measured shape: the model "corrected" an Uzbek form to the literary one.
        let result = PunctuationProjection.project(
            "Assalomu alaykum, doʻstlarim, ahvolingiz yaxshimi?",
            onto: "assalomu alaykum doʻstlarim ahvollaringiz yaxshimi")
        #expect(result.text == "Assalomu alaykum, doʻstlarim, ahvollaringiz yaxshimi?")
    }

    @Test("a word the model added is dropped, one it removed is kept")
    func additionsDroppedRemovalsKept() {
        let result = PunctuationProjection.project(
            "Please, call the plumber today.", onto: "call the plumber today now")
        #expect(result.text == "call the plumber today now.")
    }

    @Test("an output about something else is refused rather than projected")
    func unrelatedOutputRefused() {
        let result = PunctuationProjection.project(
            "Welcome to the community, we are glad to have you!",
            onto: "change the greeting in every automation")
        #expect(result.aligned < PunctuationProjection.minimumAlignment)
        #expect(result.text == "change the greeting in every automation")
    }

    @Test("markdown or emoji at a word's edge is not punctuation")
    func onlyPunctuationCrosses() {
        let result = PunctuationProjection.project("**Buy** bread.", onto: "buy bread")
        #expect(result.text == "Buy bread.")
    }
}

struct SentenceGuardTests {

    let prompt = OnDeviceModes.messagePrompt(.english)

    @Test("tightening is accepted")
    func tighteningAccepted() {
        #expect(SentenceGuard.checkRewrite(
            "Keep only Telegram.", against: "Yes, so keep only telegram.", language: .english,
            prompt: prompt, mayDrop: OnDeviceModes.droppable[.english]) == nil)
    }

    @Test("a changed fact is refused")
    func changedFactRefused() {
        let reason = SentenceGuard.checkRewrite(
            "Apply the price increase to all students.",
            against: "Apply the price added to all students.", language: .english, prompt: prompt)
        #expect(reason?.contains("increase") == true)
    }

    @Test("a deleted clause is refused even when everything else passes")
    func deletedClauseRefused() {
        let reason = SentenceGuard.checkRewrite(
            "First, buy the seeds.",
            against: "Okay, before I get back you need to do a few things, first, buy the seeds.",
            language: .english, prompt: prompt, mayDrop: OnDeviceModes.droppable[.english])
        #expect(reason?.contains("deleted") == true)
    }

    @Test("one of the prompt's own examples is refused")
    func exampleEchoRefused() {
        let example = prompt.examples[0].output
        #expect(SentenceGuard.checkRewrite(example, against: "Okay, fix them all.",
                                           language: .english, prompt: prompt) != nil)
    }

    @Test("Uzbek demands the word itself, not a shorter relative")
    func uzbekExactWords() {
        let uz = OnDeviceModes.messagePrompt(.uzbek)
        #expect(SentenceGuard.checkRewrite(
            "Erta soat beshda uchrashamiz.", against: "Xoʻp, ertaga soat beshda uchrashamiz.",
            language: .uzbek, prompt: uz, mayDrop: OnDeviceModes.droppable[.uzbek]) != nil)
        #expect(SentenceGuard.checkRewrite(
            "Ertaga soat beshda uchrashamiz.", against: "Xoʻp, ertaga soat beshda uchrashamiz.",
            language: .uzbek, prompt: uz, mayDrop: OnDeviceModes.droppable[.uzbek]) == nil)
    }
}

struct NoteLayoutTests {

    @Test("tasks lose their lead-in, items their ordinal, points stay prose")
    func lines() {
        #expect(NoteLayout.taskText("I need to call the vet tomorrow.", language: .english)
                == "Call the vet tomorrow")
        #expect(NoteLayout.taskText("Нужно позвать ребят.", language: .russian) == "Позвать ребят")
        #expect(NoteLayout.taskText("Mijozga qoʻngʻiroq qilish kerak.", language: .uzbek)
                == "Mijozga qoʻngʻiroq qilish")
        #expect(NoteLayout.strippingOrdinal("Second, water the roses.", language: .english)
                == "Water the roses.")
        #expect(NoteLayout.strippingOrdinal("One more thing about roses.", language: .english) == nil)
        #expect(NoteLayout.strippingOrdinal("Ikkinchidan, gullarni sugʻoring.", language: .uzbek)
                == "Gullarni sugʻoring.")
    }

    @Test("a note renders heading, prose and a list in the speaker's order")
    func render() {
        let note = NoteLayout.render(heading: "Garden", lines: [
            .init(kind: .point, text: "The roses bloomed early."),
            .init(kind: .task, text: "Buy mulch"),
            .init(kind: .item, text: "Tomatoes"),
        ])
        #expect(note == "## Garden\n\nThe roses bloomed early.\n\n- [ ] Buy mulch\n- Tomatoes")
    }

    @Test("a heading must be made of the note's own words")
    func headingGuard() {
        let text = "Remember to book the vet. The roses are blooming early."
        #expect(NoteLayout.acceptsHeading("Vet and roses", for: text))
        #expect(!NoteLayout.acceptsHeading("Pet care reminders", for: text))
        #expect(!NoteLayout.acceptsHeading(String(repeating: "vet ", count: 9), for: text))
    }
}

struct SentenceSplitterTests {

    @Test("complete sentences split off; the unfinished one waits")
    func incremental() {
        let (done, rest) = SentenceSplitter.split(
            "The seeds came today. We plant them on Friday. And then", keepIncompleteTail: true)
        #expect(done == ["The seeds came today.", "We plant them on Friday."])
        #expect(rest == " And then")
    }

    @Test("short fragments ride with the next sentence; abbreviations are not boundaries")
    func fragments() {
        let (done, _) = SentenceSplitter.split(
            "Okay. Meet at 3.5 km, e.g. near the gate. Bring water please.",
            keepIncompleteTail: false)
        #expect(done == ["Okay. Meet at 3.5 km, e.g. near the gate.", "Bring water please."])
    }

    @Test("a line break is a boundary and survives")
    func lineBreaks() {
        let (done, _) = SentenceSplitter.split("buy milk and eggs\nbuy fresh bread",
                                               keepIncompleteTail: false)
        #expect(done == ["buy milk and eggs", "\nbuy fresh bread"])
        #expect(IncrementalPolish.joinSentences(done) == "buy milk and eggs\nbuy fresh bread")
    }
}

struct IncrementalPolishTests {

    @Test("sentences committed during capture are polished before release")
    func backgroundWork() async {
        let engine = ScriptedEngine([
            "We planted the seeds today.": "We planted the seeds today.",
            "Water them every morning.": "Water them every morning.",
        ])
        let session = IncrementalPolish(behaviour: .message, language: .english, engine: engine)
        await session.commit("We planted the seeds today. Water them")
        await session.idle()
        #expect(await engine.asked == ["We planted the seeds today."])
        let outcome = await session.finish(tail: " every morning.", deadline: .seconds(30))
        #expect(outcome.text == "We planted the seeds today. Water them every morning.")
        #expect(await engine.asked.count == 2)
    }

    @Test("one engine, one sentence at a time, in order")
    func serialised() async {
        let engine = ScriptedEngine([
            "First sentence here.": "First sentence here.",
            "Second sentence here.": "Second sentence here.",
            "Third sentence here.": "Third sentence here.",
        ], delay: .milliseconds(20))
        let session = IncrementalPolish(behaviour: .message, language: .english, engine: engine)
        await session.commit("First sentence here. Second sentence here. ")
        // A deadline far past the work: this is about order, and the default 1.5 s went by
        // before the third sentence was asked in 1 of 40 full runs on a loaded machine, when the
        // parallel suite held every cooperative thread. The deadline has tests of its own.
        let outcome = await session.finish(tail: "Third sentence here.", deadline: .seconds(30))
        #expect(await engine.maxConcurrent == 1)
        #expect(await engine.asked == ["First sentence here.", "Second sentence here.",
                                       "Third sentence here."])
        #expect(outcome.sentences == 3)
    }

    @Test("a refused sentence falls back alone; its neighbours keep the model's work")
    func perSentenceFallback() async {
        let engine = ScriptedEngine([
            "So, the roses bloomed early.": "The roses bloomed early.",
            "Can you do it yourself?": "Sure! I would be happy to help with that.",
            "Yeah, the mulch arrived.": "The mulch arrived.",
        ])
        let session = IncrementalPolish(behaviour: .message, language: .english, engine: engine)
        let outcome = await session.finish(
            tail: "So, the roses bloomed early. Can you do it yourself? Yeah, the mulch arrived.",
            deadline: .seconds(30))
        #expect(outcome.text
                == "The roses bloomed early. Can you do it yourself? The mulch arrived.")
        #expect(outcome.modelSentences == 2)
        #expect(outcome.notes.count == 1)
    }

    @Test("a slow model is abandoned at the deadline and the sentence arrives as spoken")
    func deadline() async {
        let engine = ScriptedEngine(["The roses need water today.": "Roses: water."],
                                    delay: .seconds(20))
        let session = IncrementalPolish(behaviour: .message, language: .english, engine: engine)
        let outcome = await session.finish(tail: "The roses need water today.",
                                           deadline: .milliseconds(50))
        #expect(outcome.text == "The roses need water today.")
        // Far below the engine's 20 s, with room for a parallel test run that is starving the
        // cooperative pool (measured 1.8 s there, 50 ms alone).
        #expect(outcome.tailMilliseconds < 10_000)
        #expect(outcome.notes.first?.contains("not polished") == true)
    }

    @Test("Super never changes a word, whatever the model says")
    func superProjects() async {
        let engine = ScriptedEngine([
            "xoʻp qarang ertaga bogʻga boramiz": "Xoʻp, qarang, erta bogʻga boramiz!",
        ])
        let session = IncrementalPolish(behaviour: .superMode, language: .uzbek, engine: engine)
        let outcome = await session.finish(tail: "xoʻp qarang ertaga bogʻga boramiz",
                                           deadline: .seconds(30))
        #expect(outcome.text == "Xoʻp, qarang, ertaga bogʻga boramiz!")
    }

    @Test("Super does not ask the model in English — the transcriber already punctuates")
    func superSkipsEnglish() async {
        let engine = ScriptedEngine([:])
        let session = IncrementalPolish(behaviour: .superMode, language: .english, engine: engine)
        let outcome = await session.finish(tail: "The roses bloomed early.", deadline: .seconds(30))
        #expect(outcome.text == "The roses bloomed early.")
        #expect(await engine.asked.isEmpty)
        #expect(await session.prompts.isEmpty)
    }

    @Test("an engine that does not claim the language is never asked")
    func unclaimedLanguage() async {
        let engine = ScriptedEngine([:], languages: [.english])
        let session = IncrementalPolish(behaviour: .message, language: .russian, engine: engine)
        let outcome = await session.finish(tail: "Ну, купи хлеба, пожалуйста.",
                                           deadline: .seconds(30))
        #expect(outcome.text == "Ну, купи хлеба, пожалуйста.")
        #expect(await engine.asked.isEmpty)
    }

    @Test("Note: the model labels, the layout writes, and a heading comes from the words")
    func note() async {
        let text = "Remember to book the vet for the dog. The roses are blooming early."
        let engine = ScriptedEngine([
            "Remember to book the vet for the dog.": "TASK",
            "The roses are blooming early.": "POINT",
            text: "Vet and roses",
        ])
        let session = IncrementalPolish(behaviour: .note, language: .english, engine: engine)
        let outcome = await session.finish(tail: text, deadline: .seconds(30))
        #expect(outcome.text
                == "## Vet and roses\n\n- [ ] Book the vet for the dog\n\nThe roses are blooming early.")
    }

    @Test("Note: a sentence that opened a new line is laid out like any other")
    func noteAfterLineBreak() async {
        let text = "Send the report to Anna today.\nCall the plumber about the sink tomorrow."
        let session = IncrementalPolish(behaviour: .note, language: .english, engine: nil)
        let outcome = await session.finish(tail: text, deadline: .seconds(30))
        #expect(outcome.text == "- [ ] Send the report to Anna today\n"
                + "- [ ] Call the plumber about the sink tomorrow")
        // And with a model that says TASK: never an empty checkbox over a stray line.
        let engine = ScriptedEngine([
            "Send the report to Anna today.": "TASK",
            "Call the plumber about the sink tomorrow.": "TASK",
        ])
        let modelled = IncrementalPolish(behaviour: .note, language: .english, engine: engine)
        let again = await modelled.finish(tail: text, deadline: .seconds(30))
        #expect(!again.text.contains("[ ] \n"), "\(again.text)")
        #expect(again.text.hasSuffix("- [ ] Call the plumber about the sink tomorrow"))
    }

    @Test("Uzbek Note: a heading with a word the speaker did not say is dropped, not the note")
    func uzbekHeadingMustBeTheSpeakersWords() async {
        let sentences = ["Ertaga rejalarimizni muhokama qilamiz.", "Hisobotni tayyorlash kerak.",
                         "Mijozlarga qo\u{02BB}ng\u{02BB}iroq qilish kerak."]
        let text = sentences.joined(separator: " ")
        var answers = Dictionary(uniqueKeysWithValues: sentences.map { ($0, "TASK") })
        answers[text] = "Ertangi rejalar"
        let engine = ScriptedEngine(answers)
        let session = IncrementalPolish(behaviour: .note, language: .uzbek, engine: engine)
        let outcome = await session.finish(tail: text, deadline: .seconds(30))
        #expect(outcome.text.contains("- [ ] "), "the layout survived")
        // What the session checks before inserting a Note: no word the speaker did not say.
        #expect(UzbekPolishGuard.check(outcome.text, against: text).isAccepted, "\(outcome.text)")
    }

    @Test("Note without a model still lays out tasks and enumerations")
    func noteWithoutModel() async {
        let session = IncrementalPolish(behaviour: .note, language: .english, engine: nil)
        let outcome = await session.finish(
            tail: "We need to fix the fence. First, buy nails. Second, borrow a hammer.",
            deadline: .seconds(30))
        #expect(outcome.text == "- [ ] Fix the fence\n- Buy nails\n- Borrow a hammer")
    }

    @Test("prepare hands the mode's prompts to the engine at key-down")
    func prepare() async {
        let engine = ScriptedEngine([:])
        let session = IncrementalPolish(behaviour: .note, language: .uzbek, engine: engine)
        await session.prepare()
        #expect(await engine.prepared == [OnDeviceModes.noteClassifierPrompt(.uzbek),
                                          OnDeviceModes.headingPrompt(.uzbek)])
    }

    @Test("ModePolisher runs the same machinery for a whole transcript at once")
    func modePolisher() async throws {
        let engine = ScriptedEngine(["So, the mulch arrived.": "The mulch arrived."])
        let polisher = ModePolisher(behaviour: .message, engine: engine)
        #expect(polisher.supportedLanguages == Set(Language.allCases))
        let text = try await polisher.polish("So, the mulch arrived.", language: .english,
                                             instructions: "ignored")
        #expect(text == "The mulch arrived.")
        #expect(polisher.polishID == "message+scripted")
    }
}

/// `prime`: sentences polished while the key is held, reused at key-up only if they survived.
struct PrimedPolishTests {

    @Test("a sentence primed during the hold is not asked again at key-up")
    func primedSentenceIsReused() async {
        let engine = ScriptedEngine([
            "So we planted the seeds today.": "We planted the seeds today.",
            "Water them every morning.": "Water them every morning.",
        ])
        let session = IncrementalPolish(behaviour: .message, language: .english, engine: engine)
        await session.prime("So we planted the seeds today. Water them")
        await session.idle()
        #expect(await engine.asked == ["So we planted the seeds today."])
        let outcome = await session.finish(
            tail: "So we planted the seeds today. Water them every morning.",
            deadline: .seconds(30))
        #expect(outcome.text == "We planted the seeds today. Water them every morning.")
        #expect(outcome.primed == 1)
        #expect(await engine.asked.count == 2, "the primed sentence was polished twice")
    }

    @Test("a sentence the transcriber revised is polished again, never pasted stale")
    func revisedSentenceIsPolishedAgain() async {
        let engine = ScriptedEngine([
            "The roses bloom early this year.": "The roses bloom early this year.",
            "The roses bloomed early this year.": "The roses bloomed early this year.",
        ])
        let session = IncrementalPolish(behaviour: .message, language: .english, engine: engine)
        await session.prime("The roses bloom early this year. And")
        await session.idle()
        let outcome = await session.finish(tail: "The roses bloomed early this year.",
                                           deadline: .seconds(30))
        #expect(outcome.text == "The roses bloomed early this year.")
        #expect(outcome.primed == 0)
    }

    @Test("the unfinished last sentence is primed too when asked, for a release after a pause")
    func lastSentencePrimed() async {
        let engine = ScriptedEngine(["Can you water the roses today?": "Water the roses today?"])
        let session = IncrementalPolish(behaviour: .message, language: .english, engine: engine)
        await session.prime("Can you water the roses today?", includingLast: true)
        await session.idle()
        let outcome = await session.finish(tail: "Can you water the roses today?",
                                           deadline: .seconds(30))
        #expect(outcome.primed == 1)
        #expect(await engine.asked.count == 1)
    }

    @Test("primes the deadline did not wait for stop at key-up, so the next dictation does not queue behind them")
    func leftoverPrimesStop() async throws {
        let sentences = ["The roses need water today.", "The mulch arrived this morning.",
                         "The seeds go in on Friday."]
        let engine = ScriptedEngine(Dictionary(uniqueKeysWithValues: sentences.map { ($0, $0) }),
                                    delay: .milliseconds(300))
        let session = IncrementalPolish(behaviour: .message, language: .english, engine: engine)
        await session.prime(sentences.joined(separator: " "), includingLast: true)
        let outcome = await session.finish(tail: sentences.joined(separator: " "),
                                           deadline: .milliseconds(20))
        #expect(outcome.text == sentences.joined(separator: " "))
        // Long enough for all three 300 ms generations to have run had they been left going.
        try await Task.sleep(for: .milliseconds(1_200))
        #expect(await engine.asked.count <= 1, "primed sentences kept generating after finish")
    }

    @Test("priming costs nothing where no model is involved")
    func noModelNoPriming() async {
        let engine = ScriptedEngine([:])
        let session = IncrementalPolish(behaviour: .superMode, language: .english, engine: engine)
        await session.prime("The roses bloomed early. And then", includingLast: true)
        await session.idle()
        #expect(await engine.asked.isEmpty)
        #expect(await session.wantsModel == false)
    }
}
