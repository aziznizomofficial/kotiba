import Foundation

// Tasks T-03, T-04, T-05. Everything that happens to the text after an engine emits it and
// before it reaches the user's app — none of it involving a model.
//
// Two of these exist because a commercial dictation app conflates them and pays for it. Vocabulary is an
// ASR-stage hint sent *with the audio*; replacements are a deterministic substitution applied
// *after* transcription. a commercial dictation app's own docs concede its vocabulary hint perturbs
// punctuation and language detection and is disabled entirely for Parakeet — so treating the
// two as one mechanism means a spelling fix you wanted costs you punctuation you didn't.

// MARK: - T-03 Replacements

/// One deterministic substitution. No regular expressions: a user-editable rule that can hang
/// the dictation pipeline on a pathological pattern is a bad trade for a feature that exists
/// to fix "Margulan" being spelled four ways.
public struct Replacement: Sendable, Codable, Equatable {
    public var find: String
    public var replaceWith: String
    /// When false, `find` matches case-insensitively and the replacement's own case is used.
    public var matchCase: Bool
    /// When true, the match must be bounded by non-letters on both sides.
    public var wholeWord: Bool

    public init(find: String, replaceWith: String, matchCase: Bool = false, wholeWord: Bool = true) {
        self.find = find
        self.replaceWith = replaceWith
        self.matchCase = matchCase
        self.wholeWord = wholeWord
    }
}

public struct ReplacementSet: Sendable, Codable, Equatable {
    public var rules: [Replacement]

    public init(_ rules: [Replacement] = []) { self.rules = rules }

    /// Single left-to-right pass. At each position the **longest** matching rule wins, and the
    /// text it produces is never rescanned.
    ///
    /// That last property is the point. Rescanning makes rules chain — `a→b` followed by `b→c`
    /// would silently turn every `a` into `c`, and the user who wrote those two rules did not
    /// ask for that. It also makes a rule like `x→xx` non-terminating. One pass, no chaining,
    /// no surprises.
    public func apply(to text: String) -> String {
        guard !rules.isEmpty else { return text }
        let chars = Array(text)
        var out = ""
        out.reserveCapacity(chars.count)
        var i = 0

        while i < chars.count {
            var matched: Replacement?
            var matchedLength = 0
            for rule in rules where !rule.find.isEmpty {
                let needle = Array(rule.find)
                guard needle.count > matchedLength, i + needle.count <= chars.count else { continue }
                let window = Array(chars[i..<(i + needle.count)])
                let same = rule.matchCase
                    ? window == needle
                    : String(window).lowercased() == rule.find.lowercased()
                guard same else { continue }
                if rule.wholeWord {
                    let before = i > 0 ? chars[i - 1] : " "
                    let after = i + needle.count < chars.count ? chars[i + needle.count] : " "
                    guard !before.isLetter, !before.isNumber, !after.isLetter, !after.isNumber
                    else { continue }
                }
                matched = rule
                matchedLength = needle.count
            }
            if let matched {
                out += matched.replaceWith
                i += matchedLength
            } else {
                out.append(chars[i])
                i += 1
            }
        }
        return out
    }
}

// MARK: - T-04 Vocabulary

/// Terms to bias the ASR toward, **per language**.
///
/// Per-language is not a refinement, it is the whole design. a commercial dictation app's vocabulary is
/// global; feeding Uzbek proper nouns into an English dictation biases the decoder toward
/// tokens the audio does not contain. For a trilingual user that is a permanent tax on the two
/// languages they are not currently speaking.
public struct Vocabulary: Sendable, Codable, Equatable {
    private var byLanguage: [Language: [String]]

    public init(_ byLanguage: [Language: [String]] = [:]) {
        self.byLanguage = byLanguage.mapValues { Self.tidy($0) }
    }

    private static func tidy(_ terms: [String]) -> [String] {
        var seen = Set<String>()
        return terms
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
    }

    public mutating func set(_ terms: [String], for language: Language) {
        byLanguage[language] = Self.tidy(terms)
    }

    public func terms(for language: Language) -> [String] { byLanguage[language] ?? [] }

    /// The hint string an engine receives, e.g. whisper.cpp's `initial_prompt`.
    ///
    /// Returns nil rather than an empty string when there is nothing to say: an empty prompt is
    /// not the same as no prompt to a decoder, and some engines condition on it.
    ///
    /// **The shape matters as much as the words, and it is measured.** whisper conditions on
    /// `initial_prompt` as *preceding text* — it is a sample of what the transcript should look
    /// like, not a keyword list — so a bare comma-separated fragment is a model of unpunctuated
    /// writing and the decoder obliges. On the 344-clip Uzbek set:
    ///
    ///     no hint at all                              WER 25.19 %   punctuation 68.3 %
    ///     "Kotiba, Toshkent"                           WER 24.79 %   punctuation 61.0 %
    ///     "Kotiba, Toshkent."                          WER 25.05 %   punctuation 91.0 %
    ///     "Kotiba, Toshkent." + a full sentence        WER 24.79 %   punctuation 91.0 %
    ///
    /// The bare list was costing 7.3 points of punctuation emission against no hint at all, and a
    /// punctuated one gains 23. That is not cosmetic: `Capitaliser` finds sentence starts by
    /// looking for `.`, `!` and `?`, so punctuation the model never emitted is also every capital
    /// after the first one.
    /// And the exemplar goes out even when the user has set no vocabulary at all, for Uzbek.
    /// Measured on the same set with no terms and nothing but the sentence:
    ///
    ///     no hint at all                  WER 25.19 %   punctuation 68.3 %
    ///     the exemplar alone              WER 24.95 %   punctuation 88.4 %
    ///
    /// 20 points of punctuation for nothing, and most people never open the vocabulary pane. Only
    /// Uzbek, because only Uzbek is measured: Russian already comes back word-perfect through
    /// large-v3-turbo, and perturbing a decoder that is already right on the strength of another
    /// language's result is not a trade worth making.
    ///
    /// Arabic is the second language that gets the exemplar with no terms, and for the same
    /// reason: measured (C4 §3.2), whisper turbo writes almost no Arabic punctuation unprompted —
    /// a stop at the end of 4.5 % of utterances, punctuation F1 5 — and with this sentence in
    /// front 99 % and 35, at no MSA WER cost (+0.24, CI [−0.14, +0.64]). It reaches only turbo:
    /// the Arabic family's own engine, Cohere, takes no prompt, and turbo is what answers while
    /// Cohere is not downloaded or after a decode loop.
    public func hint(for language: Language) -> String? {
        let terms = terms(for: language)
        let exemplar = Self.styleExemplar(for: language)
        guard !terms.isEmpty else {
            return language == .uzbek || language == .arabic ? exemplar : nil
        }
        var hint = terms.joined(separator: ", ") + "."
        if let exemplar { hint += " " + exemplar }
        return hint
    }

    /// One well-formed, punctuated sentence in the target language, appended to the term list.
    ///
    /// This is the part that buys the punctuation back, and it has to be in the language being
    /// transcribed — the prompt is decoder context, so a sentence in the wrong language biases the
    /// decoder toward the wrong language, which for Uzbek is the failure this whole app is built
    /// around. English has no exemplar because whisper is not the English engine here.
    static func styleExemplar(for language: Language) -> String? {
        switch language {
        case .uzbek:   return "Bu yerda ismlar to\u{02BB}g\u{02BB}ri yozilgan."
        case .russian: return "Здесь имена написаны правильно."
        case .english: return nil
        // Turbo already punctuates Turkish (F1 62, a stop on 99 %, C4 §3.1): no exemplar, for
        // the reason Russian's is not sent without terms.
        case .turkish: return "Burada isimler doğru yazılmıştır."
        // The sentence C4 measured (Scripts/measure/tr-ar/run.sh, `turbo-prompt`), our own words.
        case .arabic:  return "مرحبًا، هذه رسالة قصيرة. هل يمكنك مراجعتها؟ شكرًا."
        }
    }

    /// Whether this engine should be sent a hint at all.
    ///
    /// Parakeet takes none: a commercial dictation app's own documentation says vocabulary "works effectively
    /// with all voice models except Nova or Parakeet", and the unified-vocabulary decoder is
    /// exactly where the hint has nothing to bind to.
    public static func acceptsHint(engineFamily: EngineFamily) -> Bool {
        engineFamily == .uzbek || engineFamily == .turkish || engineFamily == .arabic
    }
}

// MARK: - T-05 Polish guard

/// Why a polish result was refused. Each case names what the user would otherwise have lost.
public enum PolishRejection: Sendable, Equatable {
    /// Content was deleted. The measured cases: an Uzbek corrector invoked without its task
    /// prefix cut 119 tokens to 4, and a local LLM produced a 0.72 ratio while quietly
    /// rewriting the text.
    case truncated(ratio: Double)
    /// Runaway generation — the model answered the transcript instead of reformatting it.
    case inflated(ratio: Double)
    /// The script changed, which length alone cannot catch. Measured: a ≤2B model translated
    /// English into Russian *and* changed "Tuesday" to "Monday", at a length ratio well inside
    /// any plausible band.
    case scriptChanged(from: ScriptCheck.Script, to: ScriptCheck.Script)
    /// The output shares almost none of the input's words: the model wrote something else.
    /// Measured, each pasted over the user's text at a length ratio inside the band and in the
    /// same script: `Okay, fix them all.` → `Now: 2026-08-23 01:18 (en_UZ).`, and `Change all
    /// automations to send this one link to any DM.` → a YouTube URL.
    case unrelated(overlap: Double)
    /// The output is a line from the prompt itself. Measured: Apple's model returned the worked
    /// example's answer — `Can you send me the report by Friday?` — for `Can you do it
    /// yourself?`, and the `Now:` clock line for two other dictations.
    case echoedPrompt
    /// The model declined. Measured on gpt-oss-120b at temperature 0.2: `I’m sorry, but I can’t
    /// help with that.` for a Russian sentence, once in two runs.
    case refused

    public var reason: String {
        switch self {
        case .truncated(let r):
            return String(format: "polish deleted content (length ratio %.2f)", r)
        case .inflated(let r):
            return String(format: "polish ran away (length ratio %.2f)", r)
        case .scriptChanged(let from, let to):
            return "polish changed script from \(from.rawValue) to \(to.rawValue)"
        case .unrelated(let overlap):
            return String(format: "polish kept almost none of the words (%.0f%% overlap) — "
                          + "the model wrote something else", overlap * 100)
        case .echoedPrompt:
            return "polish returned a line from its own instructions"
        case .refused:
            return "polish refused to process the text"
        }
    }
}

public struct PolishGuard: Sendable {
    public var minimumRatio: Double
    public var maximumRatio: Double

    /// 0.75 sits just above the measured 0.72 failure and just below the tightest legitimate
    /// case seen — a corrector that removes filler words. It is a floor derived from observed
    /// failures, not a tuned constant.
    /// Extra characters a short dictation may gain regardless of ratio. See `check`.
    public var shortInputHeadroom: Int

    /// The share of the input's content words the output must keep.
    ///
    /// Length and script are blind to a model that writes something else of about the same
    /// size in the same alphabet, and that is the failure the diagnostics are full of. Over
    /// every accepted polish on record, legitimate Super outputs kept 0.93–1.00 of the words;
    /// the hallucinations kept 0.00, 0.00, 0.00, 0.29 and 0.29. The default is 0.6. A mode that
    /// restructures legitimately drops to 0.29 on record, with its one answer-instead-of-format
    /// at 0.18 — `DictationController` passes 0.25 for those.
    public var minimumOverlap: Double

    public init(minimumRatio: Double = 0.75, maximumRatio: Double = 2.0,
                shortInputHeadroom: Int = 0, minimumOverlap: Double = 0.6) {
        self.minimumRatio = minimumRatio
        self.maximumRatio = maximumRatio
        self.shortInputHeadroom = shortInputHeadroom
        self.minimumOverlap = minimumOverlap
    }

    /// The guard for a mode whose output is a different shape — Message, Note, Email.
    ///
    /// An email adds a greeting and a sign-off; a note turns a ramble into three checkboxes.
    /// Measured in the wild at length ratios of 0.23 and 0.30, both rejected by the default
    /// floor, which is why Note appeared to do nothing. The overlap floor is lower for the same
    /// reason: the lowest legitimate rewrite on record kept 0.29 of the words, and the one
    /// answer-instead-of-format in these modes kept 0.18.
    public static let restructuring = PolishGuard(minimumRatio: 0.12, maximumRatio: 3.0,
                                                  shortInputHeadroom: 120, minimumOverlap: 0.25)

    /// Below this many content words, overlap is noise: "If I open." → "If I open Terminal".
    public static let overlapFloorWords = 3

    /// Words of three letters or more, lowercased, apostrophes folded — the ones that carry
    /// content. Two-letter words are mostly grammar and digits are formatting.
    static func contentWords(_ text: String) -> Set<String> {
        let folded = text.lowercased()
            .replacingOccurrences(of: "\u{02BB}", with: "'")
            .replacingOccurrences(of: "\u{02BC}", with: "'")
            .replacingOccurrences(of: "\u{2019}", with: "'")
        return Set(folded.split(whereSeparator: { !$0.isLetter && $0 != "'" })
            .filter { $0.count >= 3 }
            .map(String.init))
    }

    /// The openings a model uses when it declines. Checked only when the original does not
    /// open the same way, because a dictated apology is not a refusal.
    static let refusalOpenings = [
        "i'm sorry", "i am sorry", "sorry,", "sorry but", "i can't", "i cannot", "i can not",
        "as an ai", "i'm unable", "i am unable", "i won't", "i will not",
    ]

    static func opensWithRefusal(_ text: String) -> Bool {
        let head = text.lowercased()
            .replacingOccurrences(of: "\u{2019}", with: "'")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return refusalOpenings.contains(where: { head.hasPrefix($0) })
    }

    /// Below this many characters the length ratio stops meaning anything.
    ///
    /// A greeting and a sign-off are a fixed cost, not a proportion: "sounds good" (11 chars)
    /// becoming "Hi,\n\nSounds good.\n\nBest,\nAziz" is a ratio of 2.5 and is exactly right.
    /// Measured against 46 real a commercial dictation app outputs the ratio band holds beautifully for
    /// ordinary dictations — every one landed between 0.78 and 1.13 — and says nothing useful
    /// about a five-word one.
    public static let ratioFloorLength = 60

    /// `instructions` is the system prompt the model ran under, when the caller has it: the
    /// only way to recognise a line the model copied out of its own prompt.
    public func check(_ polished: String, against original: String,
                      instructions: String? = nil) -> PolishRejection? {
        guard !original.isEmpty else { return nil }

        // A refusal first, because in a restructuring mode it can be inside the length band.
        if Self.opensWithRefusal(polished), !Self.opensWithRefusal(original) {
            return .refused
        }

        // A line from the prompt. Twelve characters is the floor, and an echo has to bring
        // words the speaker did not say — so "Nothing else." dictated and tidied is not one,
        // even though the prompt ends with exactly that.
        let trimmed = polished.trimmingCharacters(in: .whitespacesAndNewlines)
        if let instructions, trimmed.count >= 12,
           instructions.range(of: trimmed, options: .caseInsensitive) != nil,
           !Self.contentWords(polished).isSubset(of: Self.contentWords(original)) {
            return .echoedPrompt
        }

        let ratio = Double(polished.count) / Double(original.count)
        if ratio < minimumRatio { return .truncated(ratio: ratio) }

        // On a short dictation the upper ratio stops meaning anything: a greeting and a
        // sign-off are a fixed cost, not a proportion. "sounds good" (11 chars) becoming
        // "Hi,\n\nSounds good.\n\nBest,\nAziz" is a ratio of 2.5 and is exactly right.
        //
        // An absolute allowance rather than skipping the check, because the short input is
        // also where runaway generation is most dangerous — a model that answers a five-word
        // dictation with a paragraph would sail through a disabled check. `shortInputHeadroom`
        // is 0 unless a restructuring mode asked for it, so this changes nothing by default.
        let allowance = original.count < Self.ratioFloorLength
            ? max(Double(original.count + shortInputHeadroom) / Double(original.count),
                  maximumRatio)
            : maximumRatio
        if ratio > allowance { return .inflated(ratio: ratio) }

        // Script is checked second because it catches what length cannot: a translation is
        // roughly the same length as its input.
        let before = ScriptCheck.script(of: original)
        let after = ScriptCheck.script(of: polished)
        if before != after, before != .neither, after != .neither, before != .mixed, after != .mixed {
            return .scriptChanged(from: before, to: after)
        }
        // Arabic, stricter (D-11): a rewrite of mostly-Arabic text must stay mostly Arabic. The
        // rule above lets `.mixed` through in both directions, and Arabic dictation is often
        // mixed — a Latin brand name is enough — so a model that transliterated the sentence into
        // Latin, or answered it in English around the one Latin word, was not caught.
        if ScriptCheck.arabicShare(original) >= 0.5, ScriptCheck.arabicShare(polished) < 0.5,
           after != .neither {
            return .scriptChanged(from: before, to: after)
        }

        // Overlap last: what is left when the output is the right length, in the right
        // alphabet, and about something else entirely.
        let said = Self.contentWords(original)
        if said.count >= Self.overlapFloorWords {
            let overlap = Double(said.intersection(Self.contentWords(polished)).count)
                / Double(said.count)
            if overlap < minimumOverlap { return .unrelated(overlap: overlap) }
        }
        return nil
    }
}
