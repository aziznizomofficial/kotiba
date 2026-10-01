import Foundation

// C2. Text-side helpers for streamed decoding: how segment transcripts join, what the decoder is
// told came before a cut, and how to tell a decoder that is looping on its own prompt. The
// streaming contract itself is `TranscriptionStream` in Contracts.swift, shared with Parakeet.

/// How segment transcripts become one transcript, and what the decoder is told came before.
public enum SegmentText {

    /// Joins decoded segments with single spaces, dropping empties.
    ///
    /// Deliberately no case or punctuation repair here. The model punctuates each segment as if
    /// it might be the end of the utterance, and the previous text rides along as the prompt so
    /// that it mostly does not — measured in C2 §5 — and `Capitaliser` runs downstream on the
    /// joined text either way, so a sentence boundary that spans a cut is handled once, there.
    public static func join(_ segments: [String]) -> String {
        segments
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// The decoder prompt for the next segment: the style hint, then the end of what has been
    /// transcribed so far.
    ///
    /// Order matters. whisper keeps the *last* half-context of prompt tokens and drops from the
    /// front, and the text nearest the audio is what carries the sentence across a cut — so the
    /// hint goes first, where it is the thing lost if anything is. The carried text is cut at a
    /// word boundary so the decoder never conditions on half a word.
    public static func prompt(hint: String?, previous: String, carry: Int) -> String? {
        var parts: [String] = []
        if let hint, !hint.isEmpty { parts.append(hint) }
        if carry > 0 {
            let trimmed = previous.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.count > carry {
                let cut = trimmed.index(trimmed.endIndex, offsetBy: -carry)
                let tail = trimmed[cut...]
                if trimmed[trimmed.index(before: cut)].isWhitespace {
                    parts.append(String(tail))          // already starts on a word
                } else if let space = tail.firstIndex(where: \.isWhitespace) {
                    parts.append(String(tail[tail.index(after: space)...]))
                } else {
                    parts.append(String(tail))
                }
            } else if !trimmed.isEmpty {
                parts.append(trimmed)
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// Whether a decoded segment looks like the decoder looping rather than transcribing.
    ///
    /// Two shapes, both seen when previous text is fed back as a prompt: the segment repeats the
    /// end of the prompt it was given (the decoder "continued" into text it had already read), or
    /// it repeats itself — the same short phrase three or more times in a row. A caller that sees
    /// true re-decodes without the carried text.
    public static func looksLikeALoop(_ text: String, previous: String) -> Bool {
        let words = normalisedWords(text)
        guard !words.isEmpty else { return false }

        // The same n-gram (n = 1…4) three times back to back.
        for n in 1...4 where words.count >= n * 3 {
            var i = 0
            while i + n * 3 <= words.count {
                let a = words[i..<(i + n)]
                if a == words[(i + n)..<(i + 2 * n)], a == words[(i + 2 * n)..<(i + 3 * n)] {
                    // A single short word said three times can be real ("ha ha ha"), so a
                    // 1-gram only counts as a loop at five in a row.
                    if n > 1 { return true }
                    if i + 5 <= words.count, words[i..<(i + 5)].allSatisfy({ $0 == a.first }) {
                        return true
                    }
                }
                i += 1
            }
        }

        // A segment of four words or more that is wholly contained in the end of the prompt.
        let before = normalisedWords(previous)
        if words.count >= 4, before.count >= words.count {
            let tail = Array(before.suffix(max(words.count * 3, 24)))
            for start in 0...(tail.count - words.count)
            where Array(tail[start..<(start + words.count)]) == words {
                return true
            }
        }
        return false
    }

    private static func normalisedWords(_ text: String) -> [String] {
        text.lowercased()
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "'" && $0 != "\u{02BB}" })
            .map(String.init)
    }
}
