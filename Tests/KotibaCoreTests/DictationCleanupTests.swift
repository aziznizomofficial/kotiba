import Testing
@testable import KotibaCore

// Fixtures are paraphrases of patterns measured in real diagnostics, never the owner's own text:
// the shape of the artefact is what matters, and the words are invented.

struct DictationCleanupTests {

    func en(_ s: String) -> String { DictationCleanup(language: .english).apply(s) }
    func ru(_ s: String) -> String { DictationCleanup(language: .russian).apply(s) }
    func uz(_ s: String) -> String { DictationCleanup(language: .uzbek).apply(s) }

    // MARK: Fillers

    @Test("a filler fenced by commas takes both commas with it")
    func fencedFiller() {
        #expect(en("Tell me how is, uh, the garden laid out") == "Tell me how is the garden laid out.")
    }

    @Test("a filler after a full stop leaves the stop where it was")
    func fillerAfterStop() {
        #expect(en("I want you to call me. Um, the plumber is late.")
                == "I want you to call me. The plumber is late.")
    }

    @Test("a filler that carried the sentence end hands it back")
    func fillerCarriesEnd() {
        #expect(en("we bought the seeds, um. Then we planted them.")
                == "we bought the seeds. Then we planted them.")
    }

    @Test("an opening filler disappears and hands its capital on")
    func openingFiller() {
        #expect(en("Um, can you water the plants?") == "Can you water the plants?")
    }

    @Test("Russian and Uzbek hesitations, including a bare fenced e")
    func otherLanguageFillers() {
        #expect(ru("Так, э, нужно купить хлеб.") == "Так, нужно купить хлеб.")
        #expect(uz("bu juda, e, qiziq kitob ekan.") == "bu juda qiziq kitob ekan.")
        #expect(uz("ee bugun havo yaxshi.") == "bugun havo yaxshi.")
    }

    @Test("words that are sometimes filler are left alone")
    func ambiguousFillersStay() {
        #expect(en("So I like the red one.") == "So I like the red one.")
        #expect(ru("Ну, пойдём гулять.") == "Ну, пойдём гулять.")
    }

    // MARK: Stutters

    @Test("an English or Russian stutter collapses, a meaningful double does not")
    func stutters() {
        #expect(en("Put the the pot on the stove.") == "Put the pot on the stove.")
        #expect(en("It is very very hot.") == "It is very very hot.")
        #expect(ru("Я я уже иду.") == "Я уже иду.")
        #expect(ru("Да да, конечно.") == "Да да, конечно.")
    }

    @Test("Uzbek reduplication is grammar and survives; a stuttered pronoun does not")
    func uzbekReduplication() {
        #expect(uz("u tez tez keladi.") == "u tez tez keladi.")
        #expect(uz("men men bozorga bordim.") == "men bozorga bordim.")
    }

    @Test("a repeat with punctuation between is speech, not a stutter")
    func repeatWithComma() {
        #expect(ru("Это то, то, то.") == "Это то, то, то.")
    }

    // MARK: English transcriber artefacts

    @Test("a stop followed by a lowercase word was a pause, not a sentence end")
    func falseStops() {
        #expect(en("Make sure you don't. Cross. a line of no return.")
                == "Make sure you don't. Cross a line of no return.")
        #expect(en("Check the max. speed and the weight.") == "Check the max speed and the weight.")
    }

    @Test("abbreviations and numbers keep their stops")
    func abbreviationsKeepStops() {
        #expect(en("Meet at 3.5 miles, e.g. near the bridge.") == "Meet at 3.5 miles, e.g. near the bridge.")
        #expect(en("Dr. smith called.") == "Dr. smith called.")
    }

    @Test("the false-stop rule never runs on Uzbek, whose transcripts are all lowercase")
    func uzbekKeepsLowercaseSentenceStarts() {
        #expect(uz("yaxshimisiz? ishlar qalay.") == "yaxshimisiz? ishlar qalay.")
        #expect(uz("bu kitob. u juda qiziq.") == "bu kitob. u juda qiziq.")
    }

    @Test("a common word capitalised mid-sentence goes back to lowercase; a name does not")
    func strayCapitals() {
        #expect(en("I wanna, Have three of them.") == "I wanna, have three of them.")
        #expect(en("Then I will Consider it.") == "Then I will consider it.")
        #expect(en("Ask Mark about the Notes app.") == "Ask Mark about the Notes app.")
    }

    @Test("a lone i is I")
    func pronounI() {
        #expect(en("yesterday i think i'm done.") == "yesterday I think I'm done.")
    }

    // MARK: Spoken punctuation

    @Test("unambiguous spoken commands become punctuation")
    func spokenCommands() {
        #expect(en("buy milk new line buy fresh bread") == "buy milk\nbuy fresh bread.")
        #expect(en("are you coming question mark") == "are you coming?")
        #expect(ru("ты придёшь вопросительный знак") == "ты придёшь?")
        #expect(uz("keldingizmi so'roq belgisi") == "keldingizmi?")
    }

    @Test("a word that is also a command stays a word")
    func periodIsAWord() {
        #expect(en("The trial period ends soon") == "The trial period ends soon.")
        #expect(ru("Встретимся в одной точке А") == "Встретимся в одной точке А.")
    }

    // MARK: Spacing and closing

    @Test("no space before a mark, one after it")
    func spacing() {
        #expect(en("Well , that is odd ,right ?") == "Well, that is odd, right?")
    }

    @Test("an unterminated dictation is closed with the right mark")
    func closing() {
        #expect(en("what time does the shop open") == "what time does the shop open?")
        #expect(en("the shop opens at nine") == "the shop opens at nine.")
        #expect(ru("когда откроется магазин") == "когда откроется магазин?")
        #expect(uz("ertaga kelasizmi") == "ertaga kelasizmi?")
        #expect(uz("ertaga soat beshda kelaman") == "ertaga soat beshda kelaman.")
    }

    @Test("one or two words are a label, not a sentence")
    func shortStaysOpen() {
        #expect(en("Shopping list") == "Shopping list")
    }

    @Test("a segment that is not the end of the dictation is not closed")
    func segmentsStayOpen() {
        var cleanup = DictationCleanup(language: .english)
        cleanup.closesFinalSentence = false
        #expect(cleanup.apply("and then we went home") == "and then we went home")
    }

    @Test("clean text comes back unchanged")
    func idempotent() {
        let text = "The seeds arrived on Monday. Can you plant them this weekend?"
        #expect(en(text) == text)
        #expect(en(en("Um, the the seeds. arrived")) == en("Um, the the seeds. arrived"))
    }

    // MARK: Review 2026-09-30 — words the cleanup used to lose

    @Test("\"new line\" after a determiner is speech, not a command")
    func newLineAsSpeech() {
        #expect(en("we launched a new line of shoes") == "we launched a new line of shoes.")
        #expect(en("the new line feature is great") == "the new line feature is great.")
        #expect(en("write a new paragraph about roses") == "write a new paragraph about roses.")
        // Still a command where nothing makes it a noun phrase.
        #expect(en("first item new line second item") == "first item\nsecond item")
    }

    @Test("a spoken full stop ends the sentence rather than vanishing")
    func spokenFullStop() {
        #expect(en("hello full stop how are you") == "hello. How are you?")
        #expect(en("I planted the roses full stop then I watered them")
                == "I planted the roses. Then I watered them.")
    }

    @Test("a letter in a list is not a hesitation")
    func listLettersSurvive() {
        #expect(en("A, B and C are the options") == "A, B and C are the options.")
        #expect(en("choose between x, a, and b") == "choose between x, a, and b.")
        #expect(uz("a, b va c variantlari bor") == "a, b va c variantlari bor.")
        // A real fenced hesitation still goes.
        #expect(uz("bu juda, e, qiziq kitob ekan.") == "bu juda qiziq kitob ekan.")
    }

    @Test("repeated digits and doubled names are not stutters")
    func numbersAndNamesAreNotStutters() {
        #expect(en("my pin is one one two three") == "my pin is one one two three.")
        #expect(en("zero zero seven is my code") == "zero zero seven is my code.")
        #expect(ru("мой код один один два три") == "мой код один один два три.")
        #expect(en("we flew to Bora Bora last year") == "we flew to Bora Bora last year.")
        // Real stutters still collapse, a capitalised one at a sentence start included.
        #expect(en("The the seeds arrived and and grew") == "The seeds arrived and grew.")
        #expect(en("and I I think so") == "and I think so.")
    }

    // MARK: wip/cleanup-fix — never delete or rewrite real content

    @Test("a doubled name or reduplicated word survives, even opening the sentence")
    func reduplicationSurvives() {
        #expect(en("Bora Bora is lovely") == "Bora Bora is lovely.")
        #expect(en("Walla Walla, Washington") == "Walla Walla, Washington.")
        #expect(en("the train goes choo choo") == "the train goes choo choo.")
        #expect(en("a salad salad, not a fruit salad") == "a salad salad, not a fruit salad.")
        #expect(en("I gave her her keys") == "I gave her her keys.")
        #expect(ru("белый белый снег") == "белый белый снег.")
        // Function-word stutters still collapse, at a line start too.
        #expect(en("first line\nThe The band") == "first line\nThe band")
        #expect(ru("в в доме") == "в доме")
    }

    @Test("a particle doubled after its verb is two words; opening a clause it is a stutter")
    func phrasalParticleDoubles() {
        #expect(en("I will sign in in the morning") == "I will sign in in the morning.")
        #expect(en("Also, in in the garden it grew") == "Also, in the garden it grew.")
    }

    @Test("a spoken command with nothing before it, or after a determiner, is speech")
    func commandsThatAreSpeech() {
        #expect(en("full stop, and more") == "full stop, and more.")
        #expect(en("new line hello there") == "new line hello there.")
        #expect(en("first item\nfull stop here") == "first item\nfull stop here.")
        #expect(en("the car came to a full stop and waited")
                == "the car came to a full stop and waited.")
        #expect(en("put a question mark there") == "put a question mark there.")
        // Still commands where they follow what they punctuate.
        #expect(en("Dear Sam. New line. Thanks for the seeds")
                == "Dear Sam.\nThanks for the seeds.")
        #expect(en("one full stop two full stop three") == "one. Two. Three.")
    }

    @Test("a command the transcriber capitalised as a name is the name")
    func capitalisedCommandIsAName() {
        #expect(en("visit New Line Cinema today") == "visit New Line Cinema today.")
        #expect(en("The New Line opened") == "The New Line opened.")
    }

    @Test("a common word inside a name keeps its capital; a stray one before a name does not")
    func titleRunsKeepCapitals() {
        #expect(en("we moved to New York last year") == "we moved to New York last year.")
        #expect(en("we read Lord Of The Rings") == "we read Lord Of The Rings.")
        #expect(en("and Then Maria came") == "and then Maria came.")
    }

    @Test("a capital letter standing alone is a name, not a stray capital")
    func singleCapitalLetterKept() {
        #expect(en("Section A, paragraph two covers it") == "Section A, paragraph two covers it.")
        #expect(en("we need a Plan B for the garden") == "we need a Plan B for the garden.")
    }
}
