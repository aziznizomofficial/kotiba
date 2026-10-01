import Foundation

// A model's punctuation, laid over the speaker's words.
//
// The measured failure of every model tried as a "light correction" pass is the same: it changes
// a word. Apple's model answered dictated instructions; Qwen3.5-4B turned the owner's Uzbek
// `ahvollaring` into the literary `ahvolingiz` and `proyektimizda` into `loyihamizda`; the
// byte-level Uzbek corrector wrote `магазин` in Cyrillic inside a Latin sentence. Each was
// rejected by a guard, and a rejected polish means the whole sentence loses the commas and
// question marks the model did get right.
//
// Projection keeps those and nothing else. The input's words are aligned to the model's words
// (longest common subsequence over case- and apostrophe-folded forms); every input word is kept,
// in order, and takes the model's case and the punctuation the model put around it when they
// align. A word the model added is dropped; a word the model removed is kept. So the output can
// differ from the input only in punctuation and capitalisation — by construction, not by a guard
// that might miss something.
//
// That is the Super mode's whole contract, which is why Super uses this and the restructuring
// modes do not.

public enum PunctuationProjection {

    public struct Result: Sendable, Equatable {
        public var text: String
        /// Share of the input's words the model's output could be aligned to.
        public var aligned: Double
    }

    /// Below this share of aligned words the model wrote something else, and its punctuation
    /// would land on the wrong words. Measured: every real sentence where the model only
    /// punctuated aligned at 1.00; the worst legitimate case (a model that also dropped a
    /// filler and merged `CRM ni`) at 0.83.
    public static let minimumAlignment = 0.7

    /// Projection that also lets the model take out what Message may take out (C4 §14.5):
    /// an input word the model dropped is dropped too when it is in `mayDrop` (folded) or is
    /// the same word as the one before it (said twice). Every other input word stays, so the
    /// output is the speaker's words, minus fillers and stumbles, with the model's punctuation.
    public static func project(_ model: String, onto input: String,
                               mayDrop: Set<String>) -> Result {
        project(model, onto: input, dropping: Set(mayDrop.map(fold)))
    }

    public static func project(_ model: String, onto input: String) -> Result {
        project(model, onto: input, dropping: nil)
    }

    static func project(_ model: String, onto input: String,
                        dropping: Set<String>?) -> Result {
        typealias Token = DictationCleanup.Token
        let source = Token.split(input)
        let target = Token.split(model)
        guard !source.isEmpty else { return Result(text: input, aligned: 1) }

        let a = source.map { fold($0.core) }
        let b = target.map { fold($0.core) }
        let pairs = lcs(a, b)
        // With `dropping`, the words the model may take out do not count against it.
        let counted = a.indices.filter { index in
            guard !a[index].isEmpty else { return false }
            guard let dropping else { return true }
            return !(dropping.contains(a[index]) || (index > 0 && a[index - 1] == a[index]))
        }.count
        let aligned = min(1, Double(pairs.count) / Double(counted.clamped(min: 1)))
        guard aligned >= minimumAlignment else { return Result(text: input, aligned: aligned) }

        var out = source
        var alignedIndices = Set<Int>()
        for (i, j) in pairs {
            alignedIndices.insert(i)
            let from = target[j]
            let fromWord = strip(from.core)
            // Case: take the model's only when it is the same letters.
            if fromWord.lowercased() == source[i].core.lowercased() {
                out[i].core = fromWord
            } else if fromWord.first?.isUppercase == true, let first = source[i].core.first,
                      first.isLowercase {
                out[i].core = String(first).uppercased() + source[i].core.dropFirst()
            }
            out[i].leading = sanitise(from.leading)
            out[i].trailing = sanitise(from.trailing)
        }
        // The model ended a sentence on a word it kept, and then dropped the words the speaker
        // said after it: the end belongs after those words, not before them. Without this,
        // "call the plumber today now" came back as "call the plumber today. now".
        // With `dropping`, a pause the model put before words it left out (and we keep) belongs
        // after them, at the end of the speaker's phrase: "بارد، شوية بس" → "بارد شوية، بس".
        if dropping != nil {
            var k = 0
            while k < out.count {
                if alignedIndices.contains(k), !out[k].trailing.isEmpty, !out[k].endsSentence {
                    var j = k + 1
                    while j < out.count, !alignedIndices.contains(j) { j += 1 }
                    if j > k + 1, out[j - 1].trailing.isEmpty {
                        out[j - 1].trailing = out[k].trailing
                        out[k].trailing = ""
                    }
                    k = j
                } else {
                    k += 1
                }
            }
        }
        var i = 0
        while i < out.count {
            if alignedIndices.contains(i), out[i].endsSentence {
                var j = i + 1
                while j < out.count, !alignedIndices.contains(j) { j += 1 }
                if j > i + 1, !out[j - 1].endsSentence {
                    let mark = out[i].trailing.filter { ".!?…".contains($0) }
                    out[i].trailing.removeAll { ".!?…".contains($0) }
                    out[j - 1].trailing += mark
                }
                i = j
            } else {
                i += 1
            }
        }
        // Message's projection: the model's deletions of fillers and repeats are kept.
        if let dropping {
            var kept: [Token] = []
            var carriedBreak = ""
            for (index, token) in out.enumerated() {
                let word = a[index]
                let repeated = index > 0 && !word.isEmpty && a[index - 1] == word
                if !alignedIndices.contains(index), !word.isEmpty,
                   dropping.contains(word) || repeated {
                    // Its sentence end moves to the word before it; a line break it opened, to
                    // the word after it.
                    if token.endsSentence, var last = kept.popLast() {
                        if !last.endsSentence { last.trailing += token.trailing }
                        kept.append(last)
                    }
                    if !token.breakBefore.isEmpty { carriedBreak = token.breakBefore }
                    continue
                }
                var next = token
                if !carriedBreak.isEmpty, next.breakBefore.isEmpty { next.breakBefore = carriedBreak }
                carriedBreak = ""
                kept.append(next)
            }
            // A sentence that is nothing but fillers stays as it was.
            if !kept.isEmpty { out = kept }
        }
        // Punctuation on an input word the model dropped stays as the speaker had it; the model's
        // words that were never in the input are simply not emitted.
        return Result(text: DictationCleanup.fixSpacing(Token.join(out)), aligned: aligned)
    }

    /// Only punctuation may come across. Anything else found at a word's edge — an emoji, a
    /// markdown marker — is the model writing, not punctuating.
    static func sanitise(_ edge: String) -> String {
        edge.filter { DictationCleanup.Token.edgePunctuation.contains($0) }
    }

    static func fold(_ word: String) -> String {
        SentenceGuard.arabicFold(UzbekPolishGuard.foldApostrophes(strip(word).lowercased())
            .replacingOccurrences(of: "\u{02BB}", with: "'"))
    }

    /// The word without whatever non-letters the model wrapped it in (`**Buy**`).
    static func strip(_ word: String) -> String {
        let isPart: (Character) -> Bool = { $0.isLetter || $0.isNumber }
        guard let first = word.firstIndex(where: isPart),
              let last = word.lastIndex(where: isPart) else { return word }
        return String(word[first...last])
    }

    /// Index pairs of a longest common subsequence. Sentences are tens of words, so the quadratic
    /// table is a few thousand cells.
    static func lcs(_ a: [String], _ b: [String]) -> [(Int, Int)] {
        guard !a.isEmpty, !b.isEmpty else { return [] }
        var table = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                table[i][j] = !a[i].isEmpty && a[i] == b[j]
                    ? table[i + 1][j + 1] + 1
                    : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var pairs: [(Int, Int)] = []
        var i = 0, j = 0
        while i < a.count, j < b.count {
            if !a[i].isEmpty, a[i] == b[j] {
                pairs.append((i, j)); i += 1; j += 1
            } else if table[i + 1][j] >= table[i][j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        return pairs
    }
}

extension Int {
    fileprivate func clamped(min lower: Int) -> Int { Swift.max(self, lower) }
}
