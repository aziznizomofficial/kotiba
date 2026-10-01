import Foundation

// How a dictated note is laid out, deterministically.
//
// The Note mode used to ask a model to restructure a whole dictation into Markdown. On-device
// models of the size that fits the latency budget could not be trusted with that: measured over
// the owner's own note-style sentences, Qwen3-1.7B turned "No need to ask me before doing." into
// three checkboxes about a pricing page from its own examples, and Qwen3.5-0.8B answered "Can you
// do it yourself?" with "No.". Both are pasted over the user's words if nothing stops them.
//
// So the model's job shrinks to one word per sentence — TASK or POINT — and everything visible is
// built here from the speaker's own words: a task becomes a checkbox with its lead-in ("I need
// to", "нужно", "… kerak") trimmed, an enumerated sentence becomes a bullet, the rest stays prose.
// A model that misclassifies costs a checkbox; it cannot cost a word.

public enum NoteLayout {

    public enum Kind: String, Sendable, Equatable {
        case task, item, point
    }

    public struct Line: Sendable, Equatable {
        public var kind: Kind
        public var text: String
        public init(kind: Kind, text: String) {
            self.kind = kind
            self.text = text
        }
    }

    // MARK: Enumerations

    /// Words that open an enumerated item, per language. Matched at the start of a sentence, with
    /// an optional trailing comma or colon.
    static let ordinalOpeners: [Language: [String]] = [
        .english: ["first of all", "firstly", "first", "secondly", "second", "thirdly", "third",
                   "fourth", "fifth", "then finally", "finally", "lastly", "number one",
                   "number two", "number three", "number four", "number five", "one", "two",
                   "three", "four", "five", "1", "2", "3", "4", "5"],
        .russian: ["во-первых", "во-вторых", "в-третьих", "в-четвёртых", "в-четвертых",
                   "в-пятых", "первое", "второе", "третье", "четвёртое", "четвертое", "пятое",
                   "и наконец", "наконец", "1", "2", "3", "4", "5"],
        .uzbek: ["birinchidan", "ikkinchidan", "uchinchidan", "to\u{02BB}rtinchidan",
                 "beshinchidan", "birinchi", "ikkinchi", "uchinchi", "to\u{02BB}rtinchi",
                 "beshinchi", "va nihoyat", "nihoyat", "oxirida", "1", "2", "3", "4", "5"],
        .turkish: ["birincisi", "ikincisi", "üçüncüsü", "dördüncüsü", "beşincisi", "ilk olarak",
                   "ikinci olarak", "üçüncü olarak", "ve son olarak", "son olarak", "sonuç olarak",
                   "1", "2", "3", "4", "5"],
        .arabic: ["أولاً", "أولا", "ثانياً", "ثانيا", "ثالثاً", "ثالثا", "رابعاً", "رابعا",
                  "خامساً", "خامسا", "وأخيراً", "وأخيرا", "أخيراً", "أخيرا", "1", "2", "3", "4",
                  "5"],
    ]

    /// The sentence with an ordinal opener removed, or nil when it does not open with one.
    ///
    /// The bare numbers ("one", "two") count only when followed by a comma, a colon or a stop:
    /// "One more thing" is not the first item of a list.
    public static func strippingOrdinal(_ sentence: String, language: Language) -> String? {
        let folded = UzbekPolishGuard.foldApostrophes(sentence)
        let lower = language.lowercased(folded)
        for opener in ordinalOpeners[language] ?? [] {
            let key = UzbekPolishGuard.foldApostrophes(opener)
            guard lower.hasPrefix(key) else { continue }
            let rest = folded.dropFirst(key.count)
            guard let next = rest.first else { continue }
            let bare = ["one", "two", "three", "four", "five", "1", "2", "3", "4", "5"]
                .contains(key)
            if bare { guard [",", ":", ".", ")"].contains(next) else { continue } }
            else { guard !next.isLetter else { continue } }
            let body = rest.drop(while: { $0 == "," || $0 == ":" || $0 == "." || $0 == ")"
                                          || $0 == " " || $0 == "-" })
            guard !body.isEmpty else { continue }
            return capitaliseFirst(String(body), language: language)
        }
        return nil
    }

    // MARK: Tasks

    /// Lead-ins that turn a sentence into a to-do without adding to it. Longest first.
    static let taskLeadIns: [Language: [String]] = [
        .english: ["i want you to", "i need you to", "i'd like you to", "don't forget to",
                   "make sure to", "make sure you", "remember to", "we need to", "we have to",
                   "we should", "i need to", "i have to", "i should", "you need to",
                   "you have to", "you should", "we must", "i must", "you must", "please",
                   "let's", "lets"],
        .russian: ["не забудь", "не забыть", "нам нужно", "мне нужно", "тебе нужно",
                   "вам нужно", "нам надо", "мне надо", "тебе надо", "вам надо", "надо",
                   "нужно", "необходимо", "пожалуйста"],
        .uzbek: ["iltimos", "esingizdan chiqmasin", "unutmang"],
        .turkish: ["unutma", "unutmayın", "lütfen", "yapmamız gerekiyor", "yapmam gerekiyor",
                   "yapman gerekiyor"],
        .arabic: ["لا تنس", "لا تنسى", "لا تنسوا", "من فضلك", "يجب أن", "يجب ان", "لازم",
                  "علينا أن", "علينا ان", "رجاءً", "رجاء",
                  // The dialects' and the to-do list's own (C4 §14.5): "don't forget" in Egyptian
                  // and Levantine, "remember to", "remind me", "let's", "it's necessary to",
                  // "please", "we need to", "I have to".
                  "ما تنساش", "ما تنسيش", "متنساش", "لا تنسي", "تذكر أن", "تذكر ان", "ذكرني",
                  "ذكّرني", "خليك فاكر", "خلينا", "ضروري", "لو سمحت", "يجب علينا", "يجب على",
                  "نحتاج أن", "نحتاج ان", "عليّ أن", "علي أن"],
    ]

    /// The text of a task line: lead-in removed, `… kerak` / `… lozim` removed in Uzbek, first
    /// letter capitalised, final full stop dropped (a checkbox is not a sentence).
    public static func taskText(_ sentence: String, language: Language) -> String {
        var text = sentence.trimmingCharacters(in: .whitespaces)
        let lower = language.lowercased(text)
        for leadIn in (taskLeadIns[language] ?? []).sorted(by: { $0.count > $1.count }) {
            guard lower.hasPrefix(leadIn) else { continue }
            let rest = text.dropFirst(leadIn.count)
            guard let next = rest.first, !next.isLetter else { continue }
            let trimmed = rest.drop(while: { $0 == " " || $0 == "," })
            // Never trim a sentence down to nothing, or to one word it cannot stand on.
            if trimmed.split(separator: " ").count >= 2 { text = String(trimmed) }
            break
        }
        if language == .uzbek {
            for tail in [" kerak.", " kerak", " lozim.", " lozim", " shart.", " shart"]
            where text.lowercased().hasSuffix(tail) && text.split(separator: " ").count > 2 {
                text = String(text.dropLast(tail.count))
                break
            }
        }
        while let last = text.last, last == "." { text.removeLast() }
        return capitaliseFirst(text, language: language)
    }

    /// Without a model: is this sentence a to-do? Lead-ins, `kerak`, and an English imperative
    /// opener. Conservative — a missed task is still on the page as a sentence.
    public static func looksLikeTask(_ sentence: String, language: Language) -> Bool {
        let lower = language.lowercased(sentence).trimmingCharacters(in: .whitespaces)
        if (taskLeadIns[language] ?? []).contains(where: { lower.hasPrefix($0 + " ") }) {
            return true
        }
        switch language {
        case .english:
            let first = lower.split(separator: " ").first.map {
                String($0).trimmingCharacters(in: .punctuationCharacters)
            } ?? ""
            return imperativeOpeners.contains(first) && !lower.hasSuffix("?")
        case .russian:
            return false
        case .uzbek:
            let bare = lower.trimmingCharacters(in: CharacterSet(charactersIn: ".!"))
            return bare.hasSuffix(" kerak") || bare.hasSuffix(" lozim")
        case .turkish:
            // `… gerekiyor` / `… lazım`: the Turkish counterpart of Uzbek's closing `kerak`.
            let bare = lower.trimmingCharacters(in: CharacterSet(charactersIn: ".!"))
            return bare.hasSuffix(" gerekiyor") || bare.hasSuffix(" lazım")
                || bare.hasSuffix(" gerek")
        case .arabic:
            return false
        }
    }

    static let imperativeOpeners: Set<String> = [
        "add", "ask", "book", "buy", "call", "change", "check", "clean", "create", "delete",
        "email", "find", "finish", "fix", "get", "go", "make", "move", "order", "pay", "pick",
        "prepare", "remove", "reply", "review", "schedule", "send", "set", "ship", "start", "stop",
        "text", "update", "write", "turn", "install", "build", "test", "merge", "deploy", "open",
        "close", "print", "sign", "submit", "tell", "remind", "renew", "cancel", "bring", "take",
        "put", "save", "share", "upload", "download", "research", "analyze", "analyse", "draft",
    ]

    // MARK: Assembly

    /// One sentence into one note line, given its kind.
    public static func line(for sentence: String, kind: Kind, language: Language) -> Line {
        switch kind {
        case .task: return Line(kind: .task, text: taskText(sentence, language: language))
        case .item:
            // A list line, like a checkbox, is not a sentence: no closing full stop.
            var body = strippingOrdinal(sentence, language: language) ?? sentence
            while body.last == "." { body.removeLast() }
            return Line(kind: .item, text: body)
        case .point: return Line(kind: .point, text: sentence)
        }
    }

    /// The finished note. Consecutive points form one paragraph; tasks and items are list lines;
    /// a blank line separates a paragraph from a list.
    public static func render(heading: String?, lines: [Line]) -> String {
        var blocks: [String] = []
        var paragraph: [String] = []
        var list: [String] = []
        func flushParagraph() {
            if !paragraph.isEmpty { blocks.append(paragraph.joined(separator: " ")) }
            paragraph.removeAll()
        }
        func flushList() {
            if !list.isEmpty { blocks.append(list.joined(separator: "\n")) }
            list.removeAll()
        }
        for line in lines where !line.text.isEmpty {
            switch line.kind {
            case .point:
                flushList()
                paragraph.append(line.text)
            case .task:
                flushParagraph()
                // An item already marked as a checkbox by the speaker keeps one marker.
                list.append("- [ ] " + line.text)
            case .item:
                flushParagraph()
                list.append("- " + line.text)
            }
        }
        flushParagraph()
        flushList()
        if let heading, !heading.isEmpty { blocks.insert("## " + heading, at: 0) }
        return blocks.joined(separator: "\n\n")
    }

    // MARK: Heading guard

    /// Whether a model's heading is made only of the note's own words (or their stems), plus
    /// connectives. Anything else is the model naming the note with words the speaker did not say.
    public static func acceptsHeading(_ heading: String, for text: String) -> Bool {
        let words = SentenceGuard.words(of: heading)
        guard (1...6).contains(words.count),
              !heading.contains("\n"), heading.count <= 60 else { return false }
        let source = SentenceGuard.words(of: text)
        return words.allSatisfy { word in
            SentenceGuard.isConnective(word)
                || source.contains(where: { SentenceGuard.sharesStem(word, $0) })
        }
    }

    /// A heading as it should appear: trimmed of quotes, markdown and a final stop.
    public static func cleanHeading(_ raw: String) -> String {
        var text = raw.split(separator: "\n").first.map(String.init) ?? ""
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: "#*\"'«»“” \t."))
        return capitaliseFirst(text)
    }

    static func capitaliseFirst(_ text: String, language: Language = .english) -> String {
        guard let index = text.firstIndex(where: { $0.isLetter }) else { return text }
        return String(text[text.startIndex..<index]) + language.uppercased(String(text[index]))
            + String(text[text.index(after: index)...])
    }
}
