import Foundation

/// What an Arabic transcript looks like when it reaches the user — every mode, Raw included,
/// the way `UzbekNormaliser.forDelivery` fixes Uzbek orthography (D-11, C4 §14.3).
///
/// Cohere writes good Arabic already: the Arabic comma `،`, a full stop, Western digits (121 of
/// 127 digits on the 200 FLEURS clips) and a sprinkling of vowel marks (2.5 % of its words).
/// Measured, neither it, turbo nor Qwen wrote a Latin mark after an Arabic letter (C4 §14.3) —
/// but an Arabic dictation can also come from turbo before Cohere is on disk, from FastConformer
/// on Windows, through a vocabulary replacement or in a mixed-script sentence, and the user
/// should get the same Arabic whichever it was. So delivery settles five things, and only these,
/// the same way on every path:
///
///   * **Marks.** `,` `;` `?` inside Arabic text become `،` `؛` `؟` — the marks Arabic is
///     written with on every Arabic keyboard. "Inside Arabic text" is the sentence so far (back
///     to the last terminator) holding at least as many Arabic letters as Latin and Cyrillic
///     ones, so `iPhone?` at the end of an Arabic question takes `؟` and an English sentence
///     dictated beside Arabic keeps its own marks. A comma between two digits (`1,500`) is a
///     number and stays.
///   * **Spacing** around those three marks: none before, one after when a word follows.
///   * **Digits.** Western 0–9, which is what the engine writes nineteen times in twenty and what
///     a search box, a spreadsheet and a phone dialler all take. The Arabic-Indic (٠–٩) and
///     Persian (۰–۹) forms, and the Arabic decimal and thousands separators between digits,
///     are folded onto them so one dictation never mixes the two.
///   * **Tatweel** (`ـ`), the stretching stroke, goes: it is typography, never a word, and it
///     breaks search.
///   * **Case endings.** Cohere vowels a word now and then: functional marks *inside* words —
///     the damma of a passive (`يُعد`), shadda (`فعّال`), the tanwin of `شكرًا` — which typed
///     Arabic keeps where it helps, and stray final short vowels (`مدينةِ`, `برلينَ`), which typed
///     Arabic does not write. So a fatha, damma, kasra or sukun that is the
///     *last* mark of a word is dropped; every other mark stays as the engine wrote it.
///
/// Nothing else: no letter is changed (the alef forms, `ى`/`ي` and `ة`/`ه` are the speaker's
/// spelling and the dialect's), no word added or removed, and text without an Arabic letter is
/// returned exactly as it came. Idempotent. No bidi control marks are ever inserted (C4 §9.5).
public enum ArabicNormaliser {

    public static let arabicComma: Unicode.Scalar = "\u{060C}"
    public static let arabicSemicolon: Unicode.Scalar = "\u{061B}"
    public static let arabicQuestion: Unicode.Scalar = "\u{061F}"
    static let tatweel: Unicode.Scalar = "\u{0640}"

    /// Fatha, damma, kasra, sukun — the short vowels (and the no-vowel mark) a case ending is
    /// written with. Tanwin (U+064B–U+064D) and shadda (U+0651) are not among them.
    static func isCaseVowel(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x064E, 0x064F, 0x0650, 0x0652: return true
        default: return false
        }
    }

    /// Any Arabic combining mark: the harakat U+064B–U+065F, superscript alef U+0670, and the
    /// small Quranic marks U+06D6–U+06ED.
    static func isArabicMark(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x064B...0x065F, 0x0670, 0x06D6...0x06ED: return true
        default: return false
        }
    }

    static func westernDigit(_ s: Unicode.Scalar) -> Unicode.Scalar? {
        switch s.value {
        case 0x0660...0x0669: return Unicode.Scalar(0x30 + s.value - 0x0660)
        case 0x06F0...0x06F9: return Unicode.Scalar(0x30 + s.value - 0x06F0)
        default: return nil
        }
    }

    static func isDigit(_ s: Unicode.Scalar?) -> Bool {
        guard let s else { return false }
        return (0x30...0x39).contains(s.value) || westernDigit(s) != nil
    }

    static func isLatinOrCyrillicLetter(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x41...0x5A, 0x61...0x7A, 0xC0...0x24F, 0x1E00...0x1EFF, 0x400...0x4FF:
            return s.properties.isAlphabetic
        default: return false
        }
    }

    /// Whether the text holds an Arabic letter at all. Nothing else is touched.
    public static func hasArabic(_ text: String) -> Bool {
        text.unicodeScalars.contains(where: ScriptCheck.isArabicLetter)
    }

    public static func forDelivery(_ text: String) -> String {
        guard hasArabic(text) else { return text }
        let input = Array(text.unicodeScalars)
        var out: [Unicode.Scalar] = []
        out.reserveCapacity(input.count)
        // Letters of each script since the last sentence terminator, for the marks' context.
        var arabic = 0
        var other = 0
        for (i, s) in input.enumerated() {
            let previous = i > 0 ? input[i - 1] : nil
            let next = i + 1 < input.count ? input[i + 1] : nil
            if s == tatweel { continue }
            if let digit = westernDigit(s) {
                out.append(digit)
                continue
            }
            // The Arabic decimal separator, thousands separator and percent sign — between or
            // after digits only; anywhere else they are left as written.
            if s == "\u{066B}", isDigit(previous), isDigit(next) { out.append("."); continue }
            if s == "\u{066C}", isDigit(previous), isDigit(next) { out.append(","); continue }
            if s == "\u{066A}", isDigit(previous) { out.append("%"); continue }
            if isCaseVowel(s) {
                // The last mark of the word: everything after it, marks skipped, is not a letter.
                var j = i + 1
                while j < input.count, isArabicMark(input[j]) { j += 1 }
                if j == input.count || !ScriptCheck.isArabicLetter(input[j]) { continue }
            }
            if ScriptCheck.isArabicLetter(s) {
                arabic += 1
            } else if isLatinOrCyrillicLetter(s) {
                other += 1
            }
            let inArabic = arabic > 0 && arabic >= other
            var mark = s
            switch s {
            case ",":
                // `1,500` is a number in any language.
                if inArabic, !(isDigit(previous) && isDigit(next)) { mark = arabicComma }
            case ";":
                if inArabic { mark = arabicSemicolon }
            case "?":
                if inArabic { mark = arabicQuestion }
            default:
                break
            }
            if mark == arabicComma || mark == arabicSemicolon || mark == arabicQuestion {
                // None before…
                while let last = out.last, last == " " || last == "\u{00A0}" { out.removeLast() }
                out.append(mark)
                // …one after, when a word or a number follows at once.
                if let next, next.properties.isAlphabetic || isDigit(next) {
                    out.append(" ")
                }
            } else {
                out.append(mark)
            }
            if s == "." || s == "!" || s == "?" || mark == arabicQuestion || s == "\n" {
                // A full stop between digits (`3.5`) ends nothing.
                if !(s == "." && isDigit(previous) && isDigit(next)) {
                    arabic = 0
                    other = 0
                }
            }
        }
        var view = String.UnicodeScalarView()
        view.append(contentsOf: out)
        return String(view)
    }
}

/// The orthography step every delivered text passes, per language: Uzbek's apostrophes
/// (`UzbekNormaliser.forDelivery`) and Arabic's marks, digits and case endings
/// (`ArabicNormaliser.forDelivery`); the other languages are delivered as written. One function,
/// so the session's normaliser, a mode's model output and the golden fixtures cannot disagree.
public enum Orthography {
    public static func forDelivery(_ text: String, language: Language) -> String {
        switch language {
        case .uzbek: return UzbekNormaliser.forDelivery(text)
        case .arabic: return ArabicNormaliser.forDelivery(text)
        case .english, .russian, .turkish: return text
        }
    }
}
