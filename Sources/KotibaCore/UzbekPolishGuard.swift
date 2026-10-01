import Foundation

// The guard that stands between a language model and Uzbek.
//
// Measured, on real Uzbek transcripts through real cloud models: **7 of 14 polishes changed
// words the speaker did not say, and `PolishGuard` caught 1 of the 7.** Length ratio and script
// check cannot see this failure, because an invented Uzbek word is the same length and the same
// script as the real one. `kechqurun` became `keçşurun`; `chunki` became `chunkı`.
//
// The pull is always toward Turkish. It is the same force that makes Uzbek ASR hard — a
// multilingual model given clean Uzbek answers `tr 0.63 / az 0.17 / uz 0.00` — and it does not
// go away because the task changed from listening to correcting.
//
// The rule below flagged 13 of 13 corruptions with 0 false positives on 9 legitimate polishes.
// It is deliberately blunt: a correction pass may reorder, requote, capitalise and punctuate,
// but it has no business introducing a *word* that was not in the input. Anything that does is
// either a translation or an invention, and both are worse than leaving the transcript alone.

public enum UzbekPolishGuard {

    /// Folds every apostrophe-ish character onto the okina, U+02BB.
    ///
    /// Split out of `UzbekNormaliser.clean` deliberately: `clean` also lowercases and strips
    /// punctuation, which would throw away exactly the capitals and full stops a polish pass was
    /// asked to add. Comparison needs the fold and nothing else.
    public static func foldApostrophes(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            switch scalar.value {
            // ' ‘ ’ ` ´ ʼ ʻ ʹ ′ and the modifier turned comma.
            case 0x0027, 0x2018, 0x2019, 0x0060, 0x00B4, 0x02BC, 0x02BB, 0x02B9, 0x2032, 0x02BD:
                out.append(Unicode.Scalar(0x02BB)!)
            default:
                out.append(scalar)
            }
        }
        return String(out)
    }

    /// The word types in a string, apostrophes folded and case ignored.
    static func vocabulary(of text: String) -> Set<String> {
        let folded = foldApostrophes(text).lowercased()
        let words = folded.split(whereSeparator: { scalar in
            // The okina is part of a word in Uzbek, not a separator. Everything else that is
            // not a letter or a digit is.
            !(scalar.isLetter || scalar.isNumber || scalar == "\u{02BB}")
        })
        return Set(words.map(String.init))
    }

    public enum Verdict: Equatable, Sendable {
        case accepted
        /// The polish introduced words the speaker did not say. Carries them, so the diagnostics
        /// name what was invented rather than saying "rejected".
        case inventedWords([String])

        public var isAccepted: Bool { self == .accepted }

        public var reason: String {
            switch self {
            case .accepted:
                return "accepted"
            case .inventedWords(let words):
                let list = words.sorted().prefix(5).joined(separator: ", ")
                return "the polish introduced \(words.count) word"
                    + (words.count == 1 ? "" : "s")
                    + " the speaker did not say \(SpokenText.quote(list)) — Uzbek transcript kept "
                    + "as spoken"
            }
        }
    }

    /// Whether a polished Uzbek string may replace the original.
    ///
    /// Additions are the failure mode; removals are not. A correction pass legitimately drops
    /// filler words, so a word disappearing is fine and a word appearing is not.
    public static func check(_ polished: String, against original: String) -> Verdict {
        let before = vocabulary(of: original)
        let after = vocabulary(of: polished)
        let introduced = after.subtracting(before).filter { !isSplitOf($0, before) }
        guard introduced.isEmpty else { return .inventedWords(Array(introduced)) }
        return .accepted
    }

    /// Whether a "new" word is really a piece of a word that was already there.
    ///
    /// Real ASR runs words together, and pulling them apart is one of the most useful things a
    /// correction pass does. Measured on real Uzbek transcripts: `birikki` -> `bir-ikki` and
    /// `eshitganmisizayasi` -> `eshitganmisiz? Ayasi` are both right, and a rule that only
    /// compared whole words called all four halves inventions. That would have rejected
    /// roughly a third of *correct* polishes.
    ///
    /// A split is safe to allow because it adds no new letters — every character was already in
    /// front of the user. An invention is not a substring: `keçşurun` is nowhere inside
    /// `kechqurun`, `chunkı` is nowhere inside `chunki`, and `dostim` is nowhere inside
    /// `doʻstim`. All three measured corruptions stay rejected.
    static func isSplitOf(_ word: String, _ original: Set<String>) -> Bool {
        // Two characters is too short to be evidence of anything — "a" is inside almost
        // everything, and allowing it would open the door the rule exists to keep shut.
        guard word.count >= 3 else { return false }
        return original.contains { $0.count > word.count && $0.contains(word) }
    }
}
