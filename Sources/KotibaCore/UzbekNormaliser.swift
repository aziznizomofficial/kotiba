import Foundation

// Task T-01. A Swift port of NavAI's `uzbek_text_norm` v0.3.0
// (https://github.com/NavAI-pro/uzbek-text-norm, MIT, Copyright (c) 2026 NavAI — the notice is
// reproduced in THIRD_PARTY_NOTICES.md), which is the
// normaliser the public Uzbek ASR leaderboard scores with. Using theirs rather than inventing
// one is deliberate: it makes Kotiba's own WER numbers directly comparable to published ones
// instead of merely internally consistent.
//
// This is a *deterministic* transform, never a model. Orthography is a lookup. The measured
// alternative — asking a small LLM to tidy Uzbek — silently rewrote words and, in one case,
// translated the sentence into Russian.
//
// Why it is load-bearing rather than cosmetic: the two Uzbek model lineages disagree about
// apostrophes. `rubaistt_v2_medium` emits an ASCII `'` in 75.9% of transcripts and never an
// okina; the `navai-uz` family emits the okina U+02BB in 71.8–76.7% and never an ASCII quote.
// Without folding, the same word from two engines is two different strings.
//
// Parity with the Python original is asserted against a 318-pair fixture in
// Tests/KotibaCoreTests/Fixtures/. If this file and that fixture ever disagree, this file is
// wrong: the fixture was generated from the reference implementation.

public enum UzbekNormaliser {

    /// U+02BB MODIFIER LETTER TURNED COMMA — the Uzbek okina in oʻ / gʻ.
    public static let okina: Character = "\u{02BB}"

    /// U+02BC MODIFIER LETTER APOSTROPHE — the tutuq belgisi in sanʼat / maʼno / taʼlim.
    ///
    /// A different letter from the okina, not a different rendering of it. `clean` conflates the
    /// two because WER scoring does not care; `forDelivery` does not, because the user reads it.
    public static let tutuq: Character = "\u{02BC}"

    /// Every glyph a model might use for either mark. `forDelivery` decides which one it meant
    /// from the preceding letter; the wider set here also catches the prime and acute that
    /// keyboards produce.
    static let deliveryApostrophes = Set<Character>(
        "'\u{2018}\u{2019}\u{02BB}\u{02BC}\u{0060}\u{00B4}\u{02B9}\u{02BD}\u{2032}")

    /// Annotation tokens dropped from both references and hypotheses.
    static let defaultTags: Set<String> = ["noise", "hesitation"]

    // MARK: - Presets

    /// A gold reference, already Latin: clean + numbers + drop-tags. No transliteration.
    public static func normaliseReference(_ text: String) -> String {
        normalise(text, transliterateCyrillic: false)
    }

    /// A model hypothesis, which may be Cyrillic: transliterate + clean + numbers + drop-tags.
    public static func normaliseHypothesis(_ text: String) -> String {
        normalise(text, transliterateCyrillic: true)
    }

    // MARK: - Delivery

    /// What the user actually receives. **This, never `clean`, on the path to a document.**
    ///
    /// `clean` exists to make WER comparable to the public leaderboard, and to do that it
    /// lowercases the text and replaces every punctuation mark with a space — correct against an
    /// unpunctuated reference corpus, ruinous for dictation. It shipped on the delivery path
    /// anyway, and this app's own diagnostics record what that cost. whisper emitted
    ///
    ///     assalomu alaykum, do'stim, yaxshimisiz? ahvollaring yaxshimi? charchamayapsanmi?
    ///
    /// and the user was handed
    ///
    ///     Assalomu alaykum doʻstim yaxshimisiz ahvollaring yaxshimi charchamayapsanmi
    ///
    /// — every comma and question mark deleted by a scoring function. It also made `Capitaliser`
    /// look broken for a reason that was not its fault: the capitaliser finds sentence starts by
    /// looking for `.`, `!` and `?`, and `Capitalisation.swift` measured that this Uzbek model
    /// emits sentence punctuation in 68.3% of transcripts. Strip that first and there is nothing
    /// left to find, so the output carries exactly one capital, on the first word, forever.
    ///
    /// So delivery fixes orthography and stops. Case, punctuation, hyphens and digits belong to
    /// the speaker. The two things a raw Uzbek transcript does need corrected are which
    /// apostrophe glyph it chose and the occasional Cyrillic look-alike inside a Latin word.
    public static func forDelivery(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        let chars = Array(text)

        for index in chars.indices {
            let ch = chars[index]
            if zeroWidth.contains(ch) || ch == "\u{00AD}" { continue }

            if deliveryApostrophes.contains(ch) {
                // Uzbek uses two marks here and they are not interchangeable:
                //
                //   oʻ / gʻ   U+02BB MODIFIER LETTER TURNED COMMA — part of the letter
                //   ʼ         U+02BC MODIFIER LETTER APOSTROPHE   — tutuq belgisi, the glottal
                //                                                   stop in sanʼat, maʼno, taʼlim
                //
                // `clean` folds both onto U+02BB, which spells `sanʻat` with the wrong glyph. The
                // model hands us an ASCII `'` for both — 75.9% of rubaistt transcripts — so the
                // letter in front of it is the only thing that can tell them apart.
                //
                // But it has to be *inside a word* first. Both marks are intra-word in Uzbek, and
                // the first version of this folded unconditionally, which broke two things:
                //
                //   * A quotation mark became a letter. U+02BC is Unicode category Lm, so
                //     `Capitaliser` — which takes the first `isLetter` it meets as the sentence's
                //     first letter — consumed the quote and capitalised nothing. `'salom.' keyingi`
                //     capitalises correctly; `ʼsalom.ʼ keyingi` came back with no capitals at all,
                //     reintroducing the exact symptom this function exists to cure.
                //   * Paired ‘…’ quotes were destroyed outright.
                //
                // So: letters on both sides, or it is punctuation and stays punctuation.
                let before = index > chars.startIndex ? chars[index - 1] : nil
                let after = index + 1 < chars.count ? chars[index + 1] : nil
                guard let before, let after, before.isLetter, after.isLetter else {
                    out.append(ch)
                    continue
                }

                // An English genitive is not Uzbek orthography. Measured on the first version:
                // "Chicago's" became "Chicagoʻs", "Samsung's" became "Samsungʻs" — an Uzbek letter
                // inside a brand name, which then fails to match in a search box or a URL. Uzbek
                // has no `'s` suffix, so a lone `s` at the end of the word gives it away.
                let afterThat = index + 2 < chars.count ? chars[index + 2] : nil
                let englishGenitive = (after == "s" || after == "S")
                    && (afterThat == nil || !(afterThat!.isLetter || afterThat!.isNumber))
                if englishGenitive {
                    out.append("'")
                    continue
                }

                let lower = before.lowercased().first
                out.append(lower == "o" || lower == "g" ? okina : tutuq)
                continue
            }

            switch ch {
            case "\u{0430}":                                   // stray Cyrillic а in Latin text
                out.append("a")
            case "\u{04EF}":                                    // ӯ, a non-standard ў
                out.append("o")
                out.append(okina)
            case "\u{04EE}":                                    // Ӯ
                out.append("O")
                out.append(okina)
            default:
                out.append(ch)
            }
        }

        // whisper.cpp concatenates segments each of which begins with a space, so runs of spaces
        // and tabs collapse. A newline is left alone — a mode may have asked for one.
        var collapsed = ""
        collapsed.reserveCapacity(out.count)
        var lastWasSpace = false
        for ch in out {
            let isSpace = ch == " " || ch == "\t"
            if isSpace {
                if !lastWasSpace { collapsed.append(" ") }
            } else {
                collapsed.append(ch)
            }
            lastWasSpace = isSpace
        }
        return collapsed.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func normalise(_ text: String, transliterateCyrillic: Bool) -> String {
        var t = text
        if transliterateCyrillic { t = cyrillicToLatin(t) }
        t = spellNumbers(in: t)
        t = clean(t)
        return t.split(separator: " ").filter { !defaultTags.contains(String($0)) }
            .joined(separator: " ")
    }

    // MARK: - 1. Cyrillic → Latin

    private static let cyr2latMulti: [(String, String)] = [
        ("ў", "o\u{02BB}"), ("ӯ", "o\u{02BB}"), ("қ", "q"), ("ғ", "g\u{02BB}"), ("ҳ", "h"),
        ("ё", "yo"), ("ю", "yu"), ("я", "ya"), ("ш", "sh"), ("ч", "ch"), ("ц", "ts"),
    ]
    private static let cyr2latOne: [(String, String)] = [
        ("а", "a"), ("б", "b"), ("в", "v"), ("г", "g"), ("д", "d"), ("ж", "j"), ("з", "z"),
        ("и", "i"), ("й", "y"), ("к", "k"), ("л", "l"), ("м", "m"), ("н", "n"), ("о", "o"),
        ("п", "p"), ("р", "r"), ("с", "s"), ("т", "t"), ("у", "u"), ("ф", "f"), ("х", "x"),
        ("э", "e"), ("ъ", "\u{02BB}"), ("ь", ""),
    ]
    /// Cyrillic "е" reads "ye" at a word start or after a vowel / soft or hard sign, else "e".
    private static let yeContext = Set<Character>(" \t\n\u{0430}\u{0435}\u{0451}\u{0438}\u{043E}\u{0443}\u{045E}\u{044D}\u{044E}\u{044F}\u{044C}\u{044A}")

    public static func cyrillicToLatin(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count + 8)
        var previous: Character? = nil
        for ch in text.lowercased() {
            if ch == "\u{0435}" {                                   // Cyrillic е
                let atStart = previous == nil
                out += (atStart || yeContext.contains(previous!)) ? "ye" : "e"
            } else {
                out.append(ch)
            }
            previous = ch
        }
        for (c, l) in cyr2latMulti { out = out.replacingOccurrences(of: c, with: l) }
        for (c, l) in cyr2latOne { out = out.replacingOccurrences(of: c, with: l) }
        return out
    }

    // MARK: - 2. Numbers → words

    private static let ones = [1: "bir", 2: "ikki", 3: "uch", 4: "to'rt", 5: "besh",
                               6: "olti", 7: "yetti", 8: "sakkiz", 9: "to'qqiz"]
    private static let tens = [10: "o'n", 20: "yigirma", 30: "o'ttiz", 40: "qirq", 50: "ellik",
                               60: "oltmish", 70: "yetmish", 80: "sakson", 90: "to'qson"]
    private static let scales: [(Int, String)] = [(1_000_000_000, "milliard"),
                                                  (1_000_000, "million"), (1_000, "ming"), (1, "")]
    private static let vowels = Set<Character>("aeiou")

    /// 1…999. `leadingBir` decides how a hundreds digit of 1 reads: "bir yuz" in the final
    /// group, bare "yuz" when it multiplies a higher scale ("yuz ming").
    private static func spellGroup(_ n: Int, leadingBir: Bool) -> String {
        var parts: [String] = []
        let (hundreds, rest) = (n / 100, n % 100)
        if hundreds == 1 {
            parts.append(leadingBir ? "bir yuz" : "yuz")
        } else if hundreds > 0 {
            parts.append(ones[hundreds]! + " yuz")
        }
        if rest > 0 {
            if rest < 10 {
                parts.append(ones[rest]!)
            } else {
                let (t, o) = (rest / 10, rest % 10)
                parts.append(tens[t * 10]! + (o > 0 ? " " + ones[o]! : ""))
            }
        }
        return parts.joined(separator: " ")
    }

    /// Emits ASCII apostrophes (to'rt, o'n); `clean` folds them to the okina afterwards.
    public static func numberToWords(_ value: Int) -> String {
        precondition(value >= 0, "numberToWords expects a non-negative integer")
        if value == 0 { return "nol" }
        if value >= 1_000_000_000_000 {                 // beyond milliard: read digit by digit
            return String(value).map { $0 == "0" ? "nol" : ones[Int(String($0))!]! }
                .joined(separator: " ")
        }
        var n = value
        var out: [String] = []
        for (div, name) in scales {
            let q = n / div
            n %= div
            guard q > 0 else { continue }
            let isOnesGroup = name.isEmpty
            if q == 1 && !isOnesGroup {
                out.append("bir " + name)
            } else if isOnesGroup {
                out.append(spellGroup(q, leadingBir: true))
            } else {
                out.append(spellGroup(q, leadingBir: false) + " " + name)
            }
        }
        return out.joined(separator: " ")
    }

    private static let ordinalDropBir = ["bir yuz": "yuz", "bir ming": "ming",
                                         "bir million": "million", "bir milliard": "milliard"]

    /// Suffixes only the last word: "-inchi" after a consonant, "-nchi" after a vowel.
    /// Exact powers drop the leading "bir" — 100 → yuzinchi, 1000 → minginchi.
    public static func numberToOrdinalWords(_ value: Int) -> String {
        let cardinal = numberToWords(value)
        let words = ordinalDropBir[cardinal] ?? cardinal
        guard let sep = words.lastIndex(of: " ") else {
            return words + (vowels.contains(words.last ?? "x") ? "nchi" : "inchi")
        }
        let head = String(words[words.startIndex..<sep])
        var last = String(words[words.index(after: sep)...])
        last += vowels.contains(last.last ?? "x") ? "nchi" : "inchi"
        return head + " " + last
    }

    private static let thousandsSep = try! NSRegularExpression(pattern: "(?<=\\d)[,\\s](?=\\d{3}\\b)")
    private static let ordinalPattern = try! NSRegularExpression(
        pattern: "(\\d+)[-\u{2010}-\u{2015}]([^\\W\\d_]+)")
    private static let digitRun = try! NSRegularExpression(pattern: "\\d+")
    private static let bareOrdinalMarker: Set<String> = ["chi", "nchi", "inchi"]

    public static func spellNumbers(in text: String) -> String {
        var t = replaceAll(thousandsSep, in: text) { _, _ in "" }
        t = replaceAll(ordinalPattern, in: t) { m, s in
            guard let n = Int(group(m, 1, s)) else { return group(m, 0, s) }
            let word = numberToOrdinalWords(n)
            let suffix = group(m, 2, s)
            return bareOrdinalMarker.contains(suffix.lowercased()) ? word : word + " " + suffix
        }
        return replaceAll(digitRun, in: t) { m, s in
            guard let n = Int(group(m, 0, s)) else { return group(m, 0, s) }
            return numberToWords(n)
        }
    }

    // MARK: - 3. Cleaning

    /// BOM, ZWSP, ZWNJ, ZWJ, word joiner — dropped entirely.
    private static let zeroWidth = Set<Character>("\u{FEFF}\u{200B}\u{200C}\u{200D}\u{2060}")
    /// Hyphen, non-breaking hyphen, figure dash, horizontal bar, minus — folded to ASCII "-",
    /// which the punctuation pass then turns into a space. En and em dash are already below.
    private static let uniHyphen = Set<Character>("\u{2010}\u{2011}\u{2012}\u{2015}\u{2212}")
    /// Every apostrophe-like glyph that folds to the okina.
    private static let apostrophes = Set<Character>("'\u{2018}\u{2019}\u{02BB}\u{02BC}\u{0060}")
    /// Replaced with a SPACE, not deleted, so hyphenated compounds split the way Whisper's
    /// BasicTextNormalizer splits them: "sa'y-harakat" → "saʻy harakat".
    private static let punctuation = Set<Character>(
        "!\"$%&()*+,-./:;=>?[\\]_{}~\u{00AB}\u{00BB}\u{00BC}\u{00BD}\u{00BE}\u{2013}\u{2014}"
        + "\u{201C}\u{201D}\u{201E}\u{201F}\u{2022}\u{2026}\u{2033}\u{203D}\u{20AC}\u{2122}\u{221A}")

    /// Orthography only: fixes the letters, keeps the writing.
    ///
    /// `clean` is a **scoring** normaliser — it lowercases and turns every mark into a space so
    /// two transcripts can be compared for WER. It was also being run on the text inserted into
    /// the user's app, which is a different job entirely: dictating
    /// "Salom! Bugun soat 10:30 da uchrashamiz. Yaxshimi?" produced
    /// "Salom bugun soat 10 30 da uchrashamiz yaxshimi" — every sentence boundary, the time
    /// separator and the question mark gone, and then the capitaliser found no terminators left
    /// and capitalised only the first word.
    ///
    /// This does the half that is always right: zero-width characters out, Unicode hyphens and
    /// dashes regularised, `o'`/`g'` folded to the okina (U+02BB), and the handful of characters
    /// that are simply wrong for Uzbek Latin — a stray Cyrillic а, ӯ/Ӯ, a soft hyphen — repaired.
    /// Case and punctuation are the user's.
    public static func foldOrthography(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        for ch in text where !zeroWidth.contains(ch) {
            out.append(uniHyphen.contains(ch) ? "-" : ch)
        }

        var folded = ""
        folded.reserveCapacity(out.count)
        var previous: Character? = nil
        for ch in out {
            // Lowercased for the o/g test only — an "O'" at the start of a sentence is the same
            // letter as an "o'" in the middle of one.
            let lowerPrevious = previous.map { Character($0.lowercased()) }
            if apostrophes.contains(ch), let p = lowerPrevious, p == "o" || p == "g" {
                folded.append(okina)
            } else if ch == "\u{2018}" || ch == "\u{2019}" || ch == "\u{02BC}" {
                folded.append(okina)
            } else if ch == "\u{0430}" {
                folded.append("a")
            } else if ch == "\u{04EF}" {
                folded.append("o"); folded.append(okina)
            } else if ch == "\u{04EE}" {
                folded.append("O"); folded.append(okina)
            } else if ch == "\u{00AD}" {
                // A soft hyphen carries no meaning in inserted text; dropping it beats spacing it.
            } else {
                folded.append(ch)
            }
            previous = ch
        }
        return folded
    }

    public static func clean(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        for ch in text where !zeroWidth.contains(ch) {
            out.append(uniHyphen.contains(ch) ? "-" : ch)
        }
        out = out.lowercased()

        // o' / o‘ / o` … → oʻ, and the same for g. Then any remaining curly apostrophe.
        var folded = ""
        folded.reserveCapacity(out.count)
        var previous: Character? = nil
        for ch in out {
            if apostrophes.contains(ch), let p = previous, p == "o" || p == "g" {
                folded.append(okina)
            } else if ch == "\u{2018}" || ch == "\u{2019}" || ch == "\u{02BC}" {
                folded.append(okina)
            } else {
                folded.append(ch)
            }
            previous = ch
        }

        var stripped = ""
        stripped.reserveCapacity(folded.count)
        for ch in folded {
            if punctuation.contains(ch) {
                stripped.append(" ")
            } else if ch == "\u{0430}" {              // stray Cyrillic а inside Latin text
                stripped.append("a")
            } else if ch == "\u{04EF}" || ch == "\u{04EE}" {   // ӯ / Ӯ, a non-standard ў
                stripped.append("o")
                stripped.append(okina)
            } else if ch == "\u{00AD}" {              // soft hyphen
                stripped.append(" ")
            } else {
                stripped.append(ch)
            }
        }

        let collapsed = stripped.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return String(collapsed.map { $0 == "'" ? okina : $0 })
    }

    // MARK: - NSRegularExpression helpers

    private static func group(_ m: NSTextCheckingResult, _ i: Int, _ s: NSString) -> String {
        let r = m.range(at: i)
        return r.location == NSNotFound ? "" : s.substring(with: r)
    }

    private static func replaceAll(
        _ re: NSRegularExpression, in text: String,
        _ body: (NSTextCheckingResult, NSString) -> String
    ) -> String {
        let ns = text as NSString
        let matches = re.matches(in: text, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return text }
        var out = ""
        var last = 0
        for m in matches {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            out += body(m, ns)
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }
}
