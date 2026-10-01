import Foundation
import Testing

@testable import KotibaCore

@Suite("Replacements — one pass, no chaining")
struct ReplacementTests {

    @Test("a plain substitution applies")
    func basic() {
        let set = ReplacementSet([Replacement(find: "Margulan", replaceWith: "Marg'ulan")])
        #expect(set.apply(to: "salom Margulan") == "salom Marg'ulan")
    }

    @Test("rules do not chain — the user who wrote a→b and b→c did not ask for a→c")
    func noChaining() {
        let set = ReplacementSet([
            Replacement(find: "alpha", replaceWith: "beta"),
            Replacement(find: "beta", replaceWith: "gamma"),
        ])
        #expect(set.apply(to: "alpha") == "beta")
        #expect(set.apply(to: "beta") == "gamma")
    }

    @Test("a self-expanding rule terminates instead of running away")
    func selfExpandingTerminates() {
        let set = ReplacementSet([Replacement(find: "x", replaceWith: "xx", wholeWord: false)])
        #expect(set.apply(to: "x") == "xx")
        #expect(set.apply(to: "xxx") == "xxxxxx")
    }

    @Test("the longest matching rule wins at a given position")
    func longestWins() {
        let set = ReplacementSet([
            Replacement(find: "New", replaceWith: "N"),
            Replacement(find: "New York", replaceWith: "NYC"),
        ])
        #expect(set.apply(to: "New York") == "NYC")
    }

    @Test("whole-word matching does not fire inside a longer word")
    func wholeWord() {
        let set = ReplacementSet([Replacement(find: "cat", replaceWith: "dog", wholeWord: true)])
        #expect(set.apply(to: "the cat sat") == "the dog sat")
        #expect(set.apply(to: "concatenate") == "concatenate")
    }

    @Test("substring matching fires anywhere when whole-word is off")
    func substring() {
        let set = ReplacementSet([Replacement(find: "cat", replaceWith: "dog", wholeWord: false)])
        #expect(set.apply(to: "concatenate") == "condogenate")
    }

    @Test("case-insensitive by default, case-sensitive on request")
    func caseHandling() {
        let loose = ReplacementSet([Replacement(find: "swift", replaceWith: "Swift")])
        #expect(loose.apply(to: "i like SWIFT") == "i like Swift")

        let strict = ReplacementSet([
            Replacement(find: "swift", replaceWith: "Swift", matchCase: true)])
        #expect(strict.apply(to: "i like SWIFT") == "i like SWIFT")
    }

    @Test("an empty set and empty rules are no-ops rather than crashes")
    func degenerate() {
        #expect(ReplacementSet().apply(to: "unchanged") == "unchanged")
        #expect(ReplacementSet([Replacement(find: "", replaceWith: "x")]).apply(to: "abc") == "abc")
    }

    @Test("works on the okina and on Cyrillic, not just ASCII")
    func nonASCII() {
        let set = ReplacementSet([
            Replacement(find: "o\u{02BB}zbekiston", replaceWith: "O\u{02BB}zbekiston"),
            Replacement(find: "маргулан", replaceWith: "Маргулан"),
        ])
        #expect(set.apply(to: "men o\u{02BB}zbekiston") == "men O\u{02BB}zbekiston")
        #expect(set.apply(to: "это маргулан") == "это Маргулан")
    }
}

@Suite("Vocabulary — per language, or it taxes the languages you are not speaking")
struct VocabularyTests {

    @Test("an Uzbek vocabulary never reaches an English dictation")
    func doesNotLeak() {
        var v = Vocabulary()
        v.set(["Toshkent", "Samarqand"], for: .uzbek)
        v.set(["Xcode"], for: .english)

        #expect(v.terms(for: .uzbek) == ["Toshkent", "Samarqand"])
        #expect(v.terms(for: .english) == ["Xcode"])
        #expect(v.terms(for: .russian).isEmpty)
        #expect(v.hint(for: .uzbek)?.contains("Toshkent") == true)
        #expect(v.hint(for: .english)?.contains("Toshkent") != true)
    }

    @Test("no terms yields nil, not an empty prompt — a decoder conditions on the difference")
    func emptyIsNil() {
        #expect(Vocabulary().hint(for: .english) == nil)
        #expect(Vocabulary([.english: []]).hint(for: .english) == nil)
    }

    @Test("the hint is punctuated, because a bare list taught the model not to punctuate")
    func hintIsPunctuated() {
        // Measured on the 344-clip Uzbek set. whisper conditions on initial_prompt as preceding
        // text, so the hint is a sample of what the transcript should look like:
        //
        //   no hint                          WER 25.19%   punctuation 68.3%
        //   "Kotiba, Toshkent"                WER 24.79%   punctuation 61.0%
        //   "Kotiba, Toshkent." + a sentence  WER 24.79%   punctuation 91.0%
        //
        // The bare list cost 7.3 points against no hint at all. Punctuation is not cosmetic here:
        // Capitaliser finds sentence starts by looking for it.
        var v = Vocabulary()
        v.set(["Kotiba", "Toshkent"], for: .uzbek)
        let hint = v.hint(for: .uzbek)

        #expect(hint == "Kotiba, Toshkent. Bu yerda ismlar to\u{02BB}g\u{02BB}ri yozilgan.",
                "this exact string is the one that measured 24.79% / 91.0%")
        #expect(hint?.hasSuffix(".") == true, "an unpunctuated hint is a model of unpunctuated text")
        #expect(hint?.contains("Kotiba") == true, "the user's terms must still be in there")
    }

    @Test("Uzbek gets the exemplar even with no vocabulary set — most people never open that pane")
    func exemplarWithoutTerms() {
        // Measured with no terms and nothing but the sentence:
        //   no hint at all       WER 25.19%   punctuation 68.3%
        //   the exemplar alone   WER 24.95%   punctuation 88.4%
        #expect(Vocabulary().hint(for: .uzbek)
                == "Bu yerda ismlar to\u{02BB}g\u{02BB}ri yozilgan.")
        // Russian is not measured and already comes back word-perfect, so it is left alone.
        #expect(Vocabulary().hint(for: .russian) == nil)
        #expect(Vocabulary().hint(for: .english) == nil)
    }

    @Test("the exemplar is in the language being transcribed, never another one")
    func exemplarMatchesLanguage() {
        // The prompt is decoder context. A sentence in the wrong language biases the decoder toward
        // that language, and for Uzbek that is the exact failure this app exists to avoid.
        var v = Vocabulary()
        v.set(["Kotiba"], for: .uzbek)
        v.set(["Kotiba"], for: .russian)
        v.set(["Kotiba"], for: .english)

        #expect(v.hint(for: .uzbek)?.contains("Bu yerda") == true)
        #expect(v.hint(for: .uzbek)?.contains("Здесь") != true)
        #expect(v.hint(for: .russian)?.contains("Здесь") == true)
        #expect(v.hint(for: .russian)?.contains("Bu yerda") != true)
        // English is Apple's engine, not whisper's, so there is nothing to condition.
        #expect(Vocabulary.styleExemplar(for: .english) == nil)
        #expect(v.hint(for: .english) == "Kotiba.")
    }

    @Test("blank entries and case-insensitive duplicates are dropped")
    func tidying() {
        var v = Vocabulary()
        v.set(["Toshkent", "  ", "toshkent", "", "Samarqand"], for: .uzbek)
        #expect(v.terms(for: .uzbek) == ["Toshkent", "Samarqand"])
    }

    @Test("Parakeet takes no hint — its own docs say vocabulary does not work there")
    func parakeetTakesNoHint() {
        #expect(!Vocabulary.acceptsHint(engineFamily: .unified))
        #expect(Vocabulary.acceptsHint(engineFamily: .uzbek))
    }
}

@Suite("Polish guard — length catches deletion, script catches translation")
struct PolishGuardTests {

    @Test("the measured Uzbek corrector failure is caught")
    func theCorrectorFailure() {
        // Invoked without its task prefix, it reduced this to "Kim?".
        let g = PolishGuard()
        let rejection = g.check("Kim?", against: "onamizni bugun davleniya qilgan kim?")
        guard case .truncated = rejection else {
            Issue.record("expected truncated, got \(String(describing: rejection))"); return
        }
    }

    @Test("the measured 0.72 ratio is caught, and 0.76 is not")
    func theMeasuredBoundary() {
        let g = PolishGuard()
        let original = String(repeating: "a", count: 100)
        #expect(g.check(String(repeating: "a", count: 72), against: original) != nil)
        #expect(g.check(String(repeating: "a", count: 76), against: original) == nil)
    }

    @Test("a translation is caught by script even though its length is fine")
    func translationCaughtByScript() {
        // The measured failure: a <=2B model turned English into Russian at a plausible length.
        let g = PolishGuard()
        let rejection = g.check("Встреча во вторник в три часа",
                                against: "meeting on tuesday at three")
        guard case .scriptChanged(let from, let to) = rejection else {
            Issue.record("expected scriptChanged, got \(String(describing: rejection))"); return
        }
        #expect(from == .latin)
        #expect(to == .cyrillic)
    }

    @Test("runaway generation is caught — the model answered instead of reformatting")
    func runaway() {
        let g = PolishGuard()
        guard case .inflated = g.check(String(repeating: "x", count: 500), against: "short") else {
            Issue.record("expected inflated"); return
        }
    }

    @Test("legitimate punctuation and capitalisation passes")
    func legitimatePolishPasses() {
        let g = PolishGuard()
        #expect(g.check("Hello, world.", against: "hello world") == nil)
        #expect(g.check("Qaytarish imkoni yo\u{02BB}q.", against: "qaytarish imkoni yo\u{02BB}q") == nil)
    }

    @Test("adding punctuation to Cyrillic stays Cyrillic and passes")
    func cyrillicToCyrillic() {
        #expect(PolishGuard().check("Привет, как дела?", against: "привет как дела") == nil)
    }

    @Test("a code-switched line is not rejected for mixing scripts")
    func mixedScriptAllowed() {
        let g = PolishGuard()
        #expect(g.check("Bugun bozorga bordim, потом домой.",
                        against: "bugun bozorga bordim потом домой") == nil)
    }

    @Test("empty input is not judged")
    func emptyOriginal() {
        #expect(PolishGuard().check("anything", against: "") == nil)
    }

    @Test("every rejection explains itself in words a user could act on")
    func reasonsAreLegible() {
        #expect(PolishRejection.truncated(ratio: 0.3).reason.contains("deleted content"))
        #expect(PolishRejection.inflated(ratio: 9).reason.contains("ran away"))
        #expect(PolishRejection.scriptChanged(from: .latin, to: .cyrillic)
                .reason.contains("changed script"))
        #expect(PolishRejection.unrelated(overlap: 0).reason.contains("none of the words"))
        #expect(PolishRejection.echoedPrompt.reason.contains("its own instructions"))
        #expect(PolishRejection.refused.reason.contains("refused"))
    }
}

// What length and script could not see. Every input/output pair below is verbatim from this
// app's diagnostics — each one PASSED the guard above and was pasted over the user's words.
@Suite("Polish guard — the hallucinations that length and script let through")
struct PolishGuardHallucinationTests {

    static let superPrompt = """
        You are a dictation formatter. The text is in English.
        Speaker: the speaker. Writing into Terminal (a shell command) — an unnamed field.
        Now: 2026-08-23 01:18 (en_UZ).
        RIGHT:
          input:  can you send me the report by friday
          output: Can you send me the report by Friday?
        Your response must contain ONLY the formatted text. Nothing else.
        """

    @Test("the measured zero-overlap hallucinations are caught")
    func zeroOverlap() {
        let g = PolishGuard()
        for (said, got) in [
            ("Okay, fix them all.", "Now: 2026-08-23 01:18 (en_UZ)."),
            ("What about the remaining five?", "Now: 2026-08-19 00:51 (en_UZ)."),
            ("Change all automations to send this one link to any DM.",
             "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
        ] {
            let rejection = g.check(got, against: said)
            guard case .unrelated = rejection else {
                Issue.record("expected unrelated for \(got), got \(String(describing: rejection))")
                continue
            }
        }
    }

    @Test("a line lifted from the prompt is caught even when the words overlap")
    func promptEcho() {
        // Apple's model returned the worked example's answer instead of the dictation, at an
        // overlap of 0.67 — "can" and "you" — so the overlap floor alone would have passed it.
        let g = PolishGuard()
        let rejection = g.check("Can you send me the report by Friday?",
                                against: "Can you do it yourself?",
                                instructions: Self.superPrompt)
        #expect(rejection == .echoedPrompt)
        // And the clock line, which is also in the prompt, is caught by the same rule first.
        #expect(g.check("Now: 2026-08-23 01:18 (en_UZ).", against: "Okay, fix them all.",
                        instructions: Self.superPrompt) == .echoedPrompt)
        // But a short phrase that happens to appear in the prompt is not an echo when the
        // speaker said it.
        #expect(g.check("Nothing else.", against: "nothing else",
                        instructions: Self.superPrompt) == nil)
    }

    @Test("the measured answer-instead-of-format under Super is caught")
    func superAnswered() {
        // 0.29 overlap: the model carried out the instruction instead of tidying it.
        let g = PolishGuard()
        let rejection = g.check(
            "Welcome to the automation system. Please follow the instructions below.",
            against: "In all automations, change the welcome message to the following text.")
        guard case .unrelated = rejection else {
            Issue.record("expected unrelated, got \(String(describing: rejection))"); return
        }
    }

    @Test("a refusal is caught whatever its length")
    func refusal() {
        // gpt-oss-120b at temperature 0.2, on a Russian sentence naming Mavrodi, once in two.
        let g = PolishGuard()
        for refusal in ["I’m sorry, but I can’t help with that.",
                        "I'm sorry, but I can't comply with that.",
                        "Sorry, I cannot assist with this request.",
                        "I can't help with that."] {
            #expect(g.check(refusal, against: "Найди то, что Сергей Мавроди сказал про каплю воды.")
                    == .refused, "\(refusal)")
        }
        // A dictation that itself begins with an apology is not a refusal.
        #expect(g.check("I'm sorry, but I can't make it on Friday.",
                        against: "I'm sorry but I can't make it on Friday") == nil)
    }

    @Test("every legitimate Super output on record still passes")
    func superPasses() {
        let g = PolishGuard()
        for (said, got) in [
            ("Okay. Monitor it every minute and don't stop between tasks.",
             "Monitor it every minute and don't stop between tasks."),
            ("Nib itself on top bar.", "Nib itself on top bar"),
            ("Ну чё пойдём на треньку", "Ну, чё, пойдём на тренировку"),
            ("So as a standard.", "So as a standard"),
            ("S 4.", "S 4"),
        ] {
            #expect(g.check(got, against: said) == nil, "\(got)")
        }
    }

    @Test("a restructuring mode keeps its freedom, down to the lowest legitimate rewrite")
    func restructuringFloor() {
        // Message and Note rewrite aggressively. The lowest legitimate overlap on record is
        // 0.29 ("I want you to build me a telegram bot…" → "I want a Telegram bot with AI…");
        // the one answer-instead-of-format in those modes scored 0.18.
        let g = PolishGuard.restructuring
        #expect(g.check("Build me", against: "I want you to build me.") == nil)
        let rejection = g.check(
            "## Sample Messages\nNo sample messages provided.",
            against: "So add this into consideration and now I will send the sample "
                     + "messages that the bot should learn from, later on today.")
        guard case .unrelated(let overlap) = rejection else {
            Issue.record("expected unrelated, got \(String(describing: rejection))"); return
        }
        #expect(overlap < 0.25)
    }

    @Test("very short dictations are not judged on overlap")
    func shortInputs() {
        // Fewer than three content words is not enough to measure against.
        let g = PolishGuard()
        #expect(g.check("If I open Terminal", against: "If I open.") == nil)
        #expect(g.check("Chat place", against: "Chat place.") == nil)
    }
}
