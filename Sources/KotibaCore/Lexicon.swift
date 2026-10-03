import Foundation

// MARK: - Word lists, one per dictation language (P4 §3)

/// Is this a word of that language? The question every transcript is asked by the language
/// decision (`TranscriptEvidence`), for each of the five languages, whichever engine wrote it.
///
/// English is SCOWL (`TranscriptCheck.isEnglishWord`, P2 §2). The other four are every word form
/// in the Common Voice sentence collector for that language (CC0; `Scripts/lexicons.py`):
/// 121 k Uzbek, 34 k Turkish, 50 k Russian and 42 k Arabic forms. Big enough that real speech
/// out of its own engine reads mostly as known words — median coverage 0.89 for the Uzbek
/// engine on FLEURS Uzbek, 0.80 for Parakeet on FLEURS Russian — while an engine handed the
/// wrong language writes mostly unknown ones: the Uzbek engine's Latin transliteration of Arabic
/// (`ya ayyuhannasut tobu ilohi …`) median 0.33, of Turkish 0.52; Parakeet's Cyrillic for
/// English (`Инсайд зе контент фоль.`) 0.
///
/// Membership is asked of a *folded* word (`fold`), the way the lists were built.
public enum Lexicon: Sendable {

    /// The apostrophes Uzbek writes oʻ, gʻ and the tutuq with, all as '.
    static let apostrophes: Set<Unicode.Scalar> = ["\u{2019}", "\u{2018}", "\u{02BB}", "\u{02BC}", "`"]

    /// Arabic tashkeel, Quranic marks and the tatweel: not part of a word's spelling.
    static func isArabicMark(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x0610...0x061A, 0x064B...0x065F, 0x0670, 0x06D6...0x06ED, 0x0640: return true
        default: return false
        }
    }

    /// One orthography for the lookup — the one `Scripts/lexicons.py` built the lists in:
    /// apostrophes to ', Turkish İ/I/ı to i, Russian ё to е, Arabic without tashkeel or tatweel
    /// and with أ إ آ ٱ → ا, ى → ي, ة → ه; then lowercase. Unicode scalar by scalar, so the
    /// Windows port (`lexiconFold`) folds exactly the same.
    public static func fold(_ word: String, for language: Language) -> String {
        var scalars = String.UnicodeScalarView()
        for s in word.unicodeScalars {
            if apostrophes.contains(s) { scalars.append("'"); continue }
            switch language {
            case .turkish:
                if s == "\u{0130}" || s == "I" || s == "\u{0131}" { scalars.append("i"); continue }
            case .arabic:
                if isArabicMark(s) { continue }
                switch s.value {
                case 0x0623, 0x0625, 0x0622, 0x0671: scalars.append("\u{0627}"); continue
                case 0x0649: scalars.append("\u{064A}"); continue
                case 0x0629: scalars.append("\u{0647}"); continue
                default: break
                }
            case .russian:
                if s == "\u{0451}" || s == "\u{0401}" { scalars.append("\u{0435}"); continue }
            case .english, .uzbek:
                break
            }
            scalars.append(s)
        }
        return String(scalars).lowercased()
    }

    static let uzbek = set(UzbekWords.text)
    static let turkish = set(TurkishWords.text)
    static let russian = set(RussianWords.text)
    static let arabic = set(ArabicWords.text)

    private static func set(_ text: String) -> Set<String> {
        Set(text.split(separator: "\n").map(String.init))
    }

    /// Whether `word` — as written, any case, any apostrophe — is a word of `language`.
    public static func contains(_ word: String, _ language: Language) -> Bool {
        switch language {
        case .english:
            return TranscriptCheck.isEnglishWord(
                word.lowercased().replacingOccurrences(of: "\u{2019}", with: "'"))
        case .uzbek: return uzbek.contains(fold(word, for: .uzbek))
        case .turkish: return turkish.contains(fold(word, for: .turkish))
        case .russian: return russian.contains(fold(word, for: .russian))
        case .arabic: return arabic.contains(fold(word, for: .arabic))
        }
    }

    /// Words in each list, and each list's sha256 as generated — for the golden fixture, so the
    /// Windows port can prove it holds the same lists.
    public static var counts: [Language: Int] {
        [.english: TranscriptCheck.lexiconCount, .uzbek: uzbek.count, .turkish: turkish.count,
         .russian: russian.count, .arabic: arabic.count]
    }
    public static let sha256: [Language: String] = [
        .english: EnglishWords.sha256, .uzbek: UzbekWords.sha256, .turkish: TurkishWords.sha256,
        .russian: RussianWords.sha256, .arabic: ArabicWords.sha256,
    ]

    /// Build every set now (~0.1 s), off the critical path — called once at launch, like
    /// `TranscriptCheck.lexiconCount`.
    public static func warmUp() {
        _ = uzbek.count + turkish.count + russian.count + arabic.count + TranscriptCheck.lexiconCount
    }
}
