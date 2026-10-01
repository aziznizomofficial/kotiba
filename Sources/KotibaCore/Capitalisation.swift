import Foundation

// Task T-02. Restoring capitals to Uzbek ASR output.
//
// Measured on 344 real transcripts: the shipping Uzbek model emits sentence punctuation in
// 68.3% of them and capitals in **0.0%**. So the missing piece is capitalisation specifically,
// not punctuation — which is why this is a capitaliser and not a general "corrector".
//
// It is deterministic, and that is the point. The one model that does this job well
// (islomov/rubai-corrector-transcript-uz) reproduces its author's examples 8/8 and carries no
// licence at all, so it cannot ship. And the general-purpose alternative — asking a small LLM
// — was measured translating English into Russian and changing "Tuesday" to "Monday". A rule
// that is occasionally too conservative beats a model that is occasionally confabulating.
//
// The okina is the trap here. `oʻzbekiston` capitalises to `Oʻzbekiston`, never `OʻZbekiston`
// — the okina is a letter, so the "first letter" is the `o` before it, and naive
// word-capitalisation that skips non-alphanumerics gets this wrong.

public struct Capitaliser: Sendable {

    /// Terminators after which the next letter starts a sentence. `؟` too: a Turkish or English
    /// word after an Arabic question — rare, but a sentence start all the same.
    private static let terminators: Set<Character> = [".", "!", "?", "…", "\u{061F}"]
    /// Characters that may sit between a terminator and the next sentence.
    ///
    /// The curly quotes are here for the same reason the straight ones always were: without them a
    /// quoted sentence ends, the closing `”` clears `atSentenceStart`, and the sentence after it
    /// never gets its capital.
    private static let skippable: Set<Character> = [
        " ", "\n", "\t", "\"", "'", "«", "»", ")", "]",
        "\u{2018}", "\u{2019}", "\u{201C}", "\u{201D}",
    ]

    /// Uzbek's two modifier letters. Unicode calls them letters — category Lm — and they have no
    /// uppercase form, so a sentence may not *begin* with one even though a word may contain one.
    ///
    /// Without this, `restore` took a leading one as the sentence's first letter, "uppercased" it
    /// to itself, cleared `atSentenceStart` and left the real first letter lowercase. Measured:
    /// `ʼsalom.ʼ keyingi gap.` came back with no capitals at all, while the same string with ASCII
    /// quotes capitalised correctly — the exact symptom `forDelivery` exists to cure, reachable
    /// through the glyphs it produces.
    private static let modifierLetters: Set<Character> = ["\u{02BB}", "\u{02BC}"]

    /// Words always capitalised regardless of position. Kept deliberately small: a big list is
    /// a source of wrong capitalisations in the middle of ordinary sentences, and the user's
    /// own replacements (T-03) are the right place for names they care about.
    public var alwaysCapitalised: Set<String>

    public init(alwaysCapitalised: Set<String> = []) {
        self.alwaysCapitalised = Set(alwaysCapitalised.map { $0.lowercased() })
    }

    /// `language` decides how a letter is capitalised: Turkish capitalises `i` as `İ`
    /// (`istanbul` → `İstanbul`, never `Istanbul`), and Arabic has no case at all — the text comes
    /// back untouched, so a Latin word that happens to open an Arabic sentence (`iPhone …`) is not
    /// "capitalised" into `IPhone`. Nil is the locale-free rule every caller had before.
    public func restore(_ text: String, language: Language? = nil) -> String {
        guard !text.isEmpty, language != .arabic else { return text }
        let upper: (String) -> String = { language?.uppercased($0) ?? $0.uppercased() }
        var out = [Character]()
        out.reserveCapacity(text.count)

        var atSentenceStart = true
        var wordBuffer = [Character]()

        func flushWord() {
            guard !wordBuffer.isEmpty else { return }
            let word = String(wordBuffer)
            if alwaysCapitalised.contains(language?.lowercased(word) ?? word.lowercased()) {
                out.append(contentsOf: Self.capitaliseFirstLetter(word, language: language))
            } else {
                out.append(contentsOf: wordBuffer)
            }
            wordBuffer.removeAll(keepingCapacity: true)
        }

        // A terminator ends a sentence only once whitespace follows it. Straight after one, a
        // letter is still inside the word: `john.doe@gmail.com` came out `john.Doe@gmail.Com`,
        // and `notes.txt`, `google.com` and `e.g.` likewise.
        var afterTerminator = false
        for ch in text {
            if ch.isLetter || ch == "\u{02BB}" || ch == "'" {
                if atSentenceStart, ch.isLetter, !Self.modifierLetters.contains(ch) {
                    flushWord()
                    out.append(contentsOf: upper(String(ch)))
                    atSentenceStart = false
                } else {
                    wordBuffer.append(ch)
                }
                // A closing `'` after the stop is a quote, not the next word: `'salom.' keyingi`.
                // So is a closing U+02BC or U+02BB — Unicode calls them letters, but no word
                // starts with one (`modifierLetters`), and `forDelivery` writes the closing
                // quote of `ʼsalom.ʼ keyingi` as one: counted as a letter, it cancelled the
                // sentence end and `keyingi` lost its capital again.
                if ch.isLetter, !Self.modifierLetters.contains(ch) { afterTerminator = false }
                continue
            }

            flushWord()
            out.append(ch)
            if Self.terminators.contains(ch) {
                afterTerminator = true
            } else if ch.isWhitespace {
                if afterTerminator { atSentenceStart = true }
                afterTerminator = false
            } else if !Self.skippable.contains(ch) {
                // A comma or a digit does not begin a sentence.
                atSentenceStart = false
                afterTerminator = false
            }
        }
        flushWord()
        return String(out)
    }

    /// Uppercases the first *letter*, leaving a leading okina or quote where it is.
    static func capitaliseFirstLetter(_ word: String, language: Language? = nil) -> String {
        guard let index = word.firstIndex(where: { $0.isLetter }) else { return word }
        let letter = String(word[index])
        return String(word[word.startIndex..<index])
            + (language?.uppercased(letter) ?? letter.uppercased())
            + String(word[word.index(after: index)...])
    }

    /// What fraction of sentences in `text` begin with a capital. The measure T-02 is graded on.
    public static func sentenceInitialCapitalRate(_ text: String) -> Double {
        var sentences = 0
        var capitalised = 0
        var expectingStart = true
        for ch in text {
            if expectingStart, ch.isLetter {
                sentences += 1
                if ch.isUppercase { capitalised += 1 }
                expectingStart = false
            } else if terminators.contains(ch) {
                expectingStart = true
            }
        }
        return sentences > 0 ? Double(capitalised) / Double(sentences) : 1
    }
}
