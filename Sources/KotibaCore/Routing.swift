import Foundation

// Tasks R-01, R-04, R-07. The router, which is Kotiba's central differentiator and is smaller
// than it sounds.
//
// It decides ONE BIT: Uzbek engine, or the other one. It is not a three-way language choice,
// because Parakeet TDT v3 carries a unified 8192-token vocabulary and settles English against
// Russian inside its own decoder at zero cost. a commercial dictation app's history proves it: 60 of 60
// records pinned to "en", one of which emitted correct Cyrillic in 98 ms.
//
// Three tiers, cheapest first, and the cheapest is free:
//
//   P1  a manual per-mode pin        0 ms, absolute, beats everything
//   P4  acoustic posterior           ~35 ms, masked to two classes
//   P5  output script check          ~0 ms, runs after ASR as a verifier
//
// Deliberately absent: Whisper-family language ID. It costs 133–141 ms for `small` and
// 545–718 ms for `large-v3-turbo` — 53% and 240% of the entire key-release-to-text budget
// before any transcription happens — and `--audio-ctx` does not reduce it. Worse, it gets
// *more confidently wrong* as the model grows: `large-v3-turbo` labelled a Russian clip `kk`
// at p=0.962 while `small` got it right. You cannot buy your way out with model size.

// MARK: - Cluster mass

/// Turns a language-ID posterior into the one bit the engine router needs.
///
/// The naive rule — "route to Uzbek when `uz` wins" — never fires. A clean Uzbek sample scores
/// `tr 0.63 / az 0.17 / uz 0.00`, because the model has heard vastly more Turkish than Uzbek.
/// So the decision sums probability across Uzbek *and the languages it is mistaken for*, and
/// compares that mass against everything else.
public struct ClusterMass: Sendable {

    /// Languages an Uzbek utterance is routinely heard as. Turkish dominates; Azerbaijani,
    /// Turkmen, Kazakh and Kyrgyz are the rest of the Turkic neighbourhood, and Tajik shares
    /// the geography without sharing the family.
    public static let turkicCluster: Set<String> = ["uz", "tr", "az", "tk", "kk", "ky", "tg"]

    /// Above this share of total mass, the utterance routes to the Uzbek engine.
    ///
    /// This was 0.5 — untuned, chosen as "the Turkic cluster holds more probability than
    /// everything else combined" — with a note saying to re-derive it as soon as there was
    /// labelled audio. The audio arrived and it was re-derived, but only into
    /// `AppSettings.turkicThreshold`, so the constant here and the value the app shipped
    /// disagreed and anything constructing `ClusterMass()` got the abandoned one. `kotiba-probe`
    /// — the harness that produces the routing evidence the docs quote — is exactly that, so it
    /// contradicted the app on the same audio.
    ///
    /// 0.05 is the measured value: on 120 clips, 106 cleared 0.05 and only 47 cleared 0.50,
    /// against a worst control (real English and Russian) of 0.012. See
    /// Tests/KotibaEnginesTests/LanguageDetectorTests.swift, which derives it from the posteriors.
    public static let defaultThreshold = 0.05

    public let threshold: Double
    public let cluster: Set<String>

    public init(threshold: Double = ClusterMass.defaultThreshold,
                cluster: Set<String> = ClusterMass.turkicCluster) {
        self.threshold = threshold
        self.cluster = cluster
    }

    /// Summed probability of the Turkic cluster, normalised by the total. Returns 0 for an
    /// empty or all-zero posterior rather than dividing by zero.
    public func mass(_ posterior: [String: Double]) -> Double {
        let total = posterior.values.reduce(0, +)
        guard total > 0 else { return 0 }
        let inCluster = posterior.filter { cluster.contains($0.key) }.values.reduce(0, +)
        return inCluster / total
    }

    public func isUzbek(_ posterior: [String: Double]) -> Bool {
        mass(posterior) >= threshold
    }
}

// MARK: - Script check

/// The only cheap verifier available after transcription.
///
/// A mis-route is silent: WhisperKit `small` handed a Russian clip while unpinned produced
/// `Marguelan Ceisimbay podcast` — well-formed Latin text, no error, no low confidence. The one
/// thing that *is* observable is the script the engine wrote in, and it only helps when the
/// candidates use different alphabets. It is a smoke alarm, not a fire brigade.
public enum ScriptCheck: Sendable {

    public enum Script: String, Sendable, Codable, Equatable {
        case latin, cyrillic, arabic, mixed, neither
    }

    /// Whether a scalar is an Arabic-script *letter*: the Arabic, Arabic Supplement, Extended-A
    /// and presentation-form blocks, letters only — `،` `؛` `؟`, the Arabic-Indic digits and the
    /// tashkeel marks are in the same blocks and say nothing about the script on their own.
    public static func isArabicLetter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0600...0x06FF, 0x0750...0x077F, 0x08A0...0x08FF, 0xFB50...0xFDFF, 0xFE70...0xFEFF:
            return scalar.properties.isAlphabetic && scalar.properties.generalCategory != .nonspacingMark
        default:
            return false
        }
    }

    public static func script(of text: String) -> Script {
        var latin = 0
        var cyrillic = 0
        var arabic = 0
        for ch in text.unicodeScalars {
            switch ch.value {
            case 0x0041...0x005A, 0x0061...0x007A: latin += 1
            case 0x0400...0x04FF: cyrillic += 1
            default: if isArabicLetter(ch) { arabic += 1 }
            }
        }
        switch [latin > 0, cyrillic > 0, arabic > 0].filter({ $0 }).count {
        case 0: return .neither
        case 1: return latin > 0 ? .latin : cyrillic > 0 ? .cyrillic : .arabic
        default: return .mixed
        }
    }

    /// Share of the letters counted above that are Arabic, 0 when there are none. The script
    /// guard for Arabic polish (`PolishGuard`) keys off this rather than `script`, because Arabic
    /// dictation carries Latin names (`أرسل الملف على Google Drive`) and is then `.mixed`, which
    /// the general rule lets through in any direction.
    public static func arabicShare(_ text: String) -> Double {
        var counted = 0
        var arabic = 0
        for ch in text.unicodeScalars {
            switch ch.value {
            case 0x0041...0x005A, 0x0061...0x007A, 0x0400...0x04FF: counted += 1
            default:
                if isArabicLetter(ch) {
                    counted += 1
                    arabic += 1
                }
            }
        }
        return counted == 0 ? 0 : Double(arabic) / Double(counted)
    }

    /// The four Cyrillic letters that Uzbek has and Russian does not.
    ///
    /// Deliberately these four and not "everything outside the Russian alphabet". The wider rule
    /// looked more thorough and was worse: `ә ұ ү ң` are Kazakh, `ҷ ҳ ӣ` Tajik, `і ї є ґ` Ukrainian,
    /// and a Tashkent speaker dictating Russian names any of them without having switched language.
    private static let uzbekCyrillic = Set<Character>("ўқғҳ")

    /// How many letters in `text` are Uzbek-Cyrillic ones Russian does not have.
    ///
    /// This is the only cheap signal that separates Uzbek from Russian *after* transcription, and
    /// it exists because the pre-transcription signal failed. Measured, from this app's own
    /// diagnostics on 2026-08-11: Uzbek speech scored a Turkic cluster mass of 0.012 — below the
    /// 0.05 threshold — so it never reached the Uzbek model, the Russian large-v3-turbo got it
    /// instead, and the user was handed
    ///
    ///     хоп масалан қаранғалады німәдейсам ғамын яқшы тынық чотке қылып ез болады
    ///
    /// which is Uzbek spelled out phonetically in Cyrillic — six of these four letters in it. The
    /// old rule called that consistent, because Cyrillic from a Russian route agreed by definition,
    /// so nothing anywhere noticed.
    public static func nonRussianCyrillicCount(_ text: String) -> Int {
        text.lowercased().reduce(into: 0) { count, ch in
            if uzbekCyrillic.contains(ch) { count += 1 }
        }
    }

    /// How many *distinct words* in `text` carry an Uzbek-Cyrillic letter.
    ///
    /// Counting words rather than letters is what makes this rule usable, and it took two failed
    /// attempts to find. Neither a letter count nor a density ratio separates the two cases:
    ///
    ///     хоп масалан қаранғалады … яқшы тынық чотке қылып ез болады   6 letters, ~10% of Cyrillic
    ///     Я живу на Қўйлиқ, рядом с Мирзо Улуғбек                      4 letters, ~13% of Cyrillic
    ///
    /// The first is Uzbek that reached the wrong engine; the second is Russian a Russian speaker
    /// meant, naming a Tashkent neighbourhood. By letters the second looks *more* Uzbek than the
    /// first, so any threshold on letters or density either misses the mis-route or destroys the
    /// Russian sentence.
    ///
    /// Words separate them cleanly, because the two cases differ in kind rather than degree. A
    /// script mismatch is spread through the whole utterance — five different words above — while
    /// Russian borrows these letters only inside proper nouns, of which a sentence holds one or
    /// two. `Ғафур Ғулом` is two, `Қўйлиқ … Улуғбек` is two.
    public static func uzbekCyrillicWordCount(_ text: String) -> Int {
        let words = text.lowercased().split(whereSeparator: { !$0.isLetter })
        var seen = Set<String>()
        for word in words where word.contains(where: { uzbekCyrillic.contains($0) }) {
            seen.insert(String(word))
        }
        return seen.count
    }

    /// Four distinct words. The measured mis-route has five; the worst Russian false positive found
    /// has two.
    static let uzbekCyrillicEvidence = 4

    /// Whether a transcript from a non-Uzbek route is really Uzbek written in Cyrillic.
    ///
    /// One-directional by design: it is the recovery path for a mis-route that is otherwise silent
    /// and total, and it may only ever point toward Uzbek.
    ///
    /// It is a backstop, not a solution. It covers only the mis-routes that land on the Russian
    /// engine, which measured 16% of them — the other 84% go to Apple's English engine and come
    /// back as Latin that no script check can tell from a real transcript. The fix for those is the
    /// language pin.
    public static func looksLikeUzbekInCyrillic(_ text: String) -> Bool {
        uzbekCyrillicWordCount(text) >= uzbekCyrillicEvidence
    }

    /// Does this output look like it came from the engine we routed to?
    ///
    /// Uzbek is written in Latin here, and the Uzbek engine's vocabulary contains **zero
    /// Cyrillic tokens** — so Cyrillic out of the Uzbek engine is impossible rather than
    /// merely surprising, and means the audio was Russian.
    ///
    /// The other direction used to be unwatched: Cyrillic from a Russian route agreed by
    /// definition. It no longer does, because the letters are checkable — see
    /// `nonRussianCyrillicCount` for the dictation that made this necessary.
    ///
    /// Arabic script is the one unambiguous signal among the five: only Arabic is written in it,
    /// so it agrees with an Arabic route and with nothing else, and an Arabic route agrees with
    /// no other script (C4 §9.2). Turkish is Latin like Uzbek and English, and the script can say
    /// nothing about it — `TurkishCheck` is the verifier there.
    public static func agrees(_ text: String, with language: Language) -> Bool {
        switch script(of: text) {
        case .neither, .mixed:
            return true                     // punctuation, digits, or a code-switched line
        case .arabic:
            return language == .arabic
        case .cyrillic:
            // Cannot come from the Uzbek engine (its vocabulary holds no Cyrillic), nor from the
            // Turkish or Arabic route (turbo is told the language; Cohere writes Arabic).
            if language == .uzbek || language == .turkish || language == .arabic { return false }
            return !looksLikeUzbekInCyrillic(text)
        case .latin:
            // Latin from a Russian route is a mis-route; so is Latin from Cohere, which writes
            // Arabic script for Arabic speech.
            if language == .russian || language == .arabic { return false }
            // Latin from the Uzbek route used to agree by definition. It cannot: the Uzbek
            // fine-tune still speaks English, and when the acoustic pass hands it English it
            // answers in English — see `LexicalCheck`.
            if language == .uzbek { return !LexicalCheck.looksLikeEnglish(text) }
            return true
        }
    }
}

// MARK: - Lexical check

/// The verifier for the mis-route the script check cannot see: English audio routed to the
/// Uzbek engine.
///
/// Measured from this app's own diagnostics, 2026-08-22/23. The acoustic pass scored this
/// speaker's English at Turkic cluster masses of 0.058, 0.075, 0.086, 0.119, 0.151, 0.230,
/// 0.313, 0.405, 0.429 and 0.457 — inside the range of their genuine Uzbek (0.051 … 0.961) — so
/// of 32 dictations routed to the Uzbek engine, 11 were English. No threshold separates them.
/// The Uzbek fine-tune still speaks English, so each came back as well-formed lowercase Latin
/// English — `kotub is somehow exit the app in some five, six hours` — which `ScriptCheck` had
/// to call consistent, because the only thing it can see is the alphabet.
///
/// Words separate the two cases completely, and with margin. Over all 32:
///
///     English   ≥ 4 distinct English function words,  0 words of Uzbek evidence   (11 of 11)
///     Uzbek     ≤ 1 distinct English function word,   ≥ 5 words of Uzbek evidence (21 of 21)
///
/// The floor is three English words — two above the worst genuine Uzbek, which was a
/// code-switched line containing "copy paste … app" — and ANY Uzbek evidence vetoes the verdict,
/// so a Tashkent speaker mixing English nouns into an Uzbek sentence is left alone. Both lists
/// are function words and grammar, not content: "telegram", "vebsayt" and "api" say nothing
/// about which language the sentence is in, and are deliberately absent.
///
/// One-directional, like the script check: it only ever says "this Uzbek route was English".
/// The reverse — Uzbek audio that reached Apple's English engine — comes back as English-looking
/// nonsense (`Asamu alaykum, Khalisan.`) that no word list can tell from a short English
/// dictation, and the fix for that is the language pin.
public enum LexicalCheck: Sendable {

    /// English function words. Grammar only — the words an English sentence cannot avoid.
    static let englishFunctionWords: Set<String> = [
        "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been", "am",
        "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
        "my", "your", "his", "its", "our", "their", "this", "that", "these", "those",
        "to", "of", "in", "on", "at", "for", "with", "from", "by", "as", "about", "into",
        "not", "no", "yes", "do", "does", "did", "have", "has", "had",
        "can", "could", "will", "would", "should", "may", "might", "must",
        "so", "if", "then", "than", "there", "here", "what", "which", "who", "when",
        "where", "why", "how", "all", "any", "some", "many", "much", "more", "most",
        "other", "such", "only", "just", "also", "very", "too", "now", "still", "again",
        "never", "always", "please", "okay", "ok", "let", "get", "make", "go", "come",
        "want", "need", "know", "think", "see", "like", "use",
    ]

    /// Uzbek function words, with apostrophes folded to ASCII (see `fold`).
    static let uzbekFunctionWords: Set<String> = [
        "va", "bu", "shu", "u", "men", "sen", "biz", "siz", "ular", "ham", "uchun", "bilan",
        "kerak", "emas", "yo'q", "ha", "bor", "edi", "bo'ldi", "bo'lsa", "bo'lib", "bo'ladi",
        "qil", "qildi", "qilish", "qilasan", "qiling", "keyin", "oldin", "hozir", "bugun",
        "ertaga", "kecha", "nima", "nega", "qanday", "qaysi", "kim", "qayerda", "qachon",
        "juda", "ko'p", "oz", "yana", "lekin", "ammo", "agar", "chunki", "degan", "deb",
        "dedi", "desa", "har", "hech", "bir", "ikki", "uch", "to'rt", "besh", "olti", "yetti",
        "sakkiz", "to'qqiz", "o'n", "yaxshi", "yomon", "katta", "kichik", "yangi", "eski",
        "xo'p", "mayli", "rahmat", "iltimos", "assalomu", "alaykum", "salom", "masalan",
        "meni", "mening", "seni", "sening", "uni", "uning", "bizni", "sizni", "ularni",
        "manga", "senga", "unga", "bizga", "sizga", "ularga", "shunday", "bunday", "qara",
        "qarang", "mana", "ana", "ku", "mi", "chi",
    ]

    /// Case suffixes and verb endings. An Uzbek sentence of any length carries several. An
    /// English one occasionally carries one by accident — "similar", "planning", "Canada" —
    /// which is why a word must be at least four letters longer than its suffix, why `-ing` is
    /// not on the list, and why the verdict below is a ratio rather than a veto.
    static let uzbekSuffixes = ["lar", "ning", "ni", "da", "dan", "ga", "gan", "moq", "yap",
                                "san", "siz", "miz", "lik"]

    /// Distinct English function words. The floor is three.
    static let englishEvidenceFloor = 3

    /// English evidence must outweigh Uzbek evidence by this factor. Genuine Uzbek measured at
    /// most 1 English word against 5 or more Uzbek; English measured 4 or more against 0 or 1.
    static let englishDominance = 3

    /// The okina ʻ (U+02BB), the tutuq ʼ (U+02BC) and the typographic ’ are all the apostrophe
    /// in `xo'p` — the engine writes ASCII, `UzbekNormaliser` rewrites it, and a user types
    /// whatever the keyboard gives. One orthography for the lookup.
    static func fold(_ text: String) -> String {
        text.lowercased()
            .replacingOccurrences(of: "\u{02BB}", with: "'")
            .replacingOccurrences(of: "\u{02BC}", with: "'")
            .replacingOccurrences(of: "\u{2019}", with: "'")
    }

    static func words(_ text: String) -> [Substring] {
        fold(text).split(whereSeparator: { !$0.isLetter && $0 != "'" })
    }

    /// How many *distinct* English function words `text` contains.
    public static func englishEvidence(_ text: String) -> Int {
        Set(words(text).filter { englishFunctionWords.contains(String($0)) }).count
    }

    /// How many distinct words carry Uzbek evidence — a function word, or a suffixed word long
    /// enough that the suffix is not the whole word.
    public static func uzbekEvidence(_ text: String) -> Int {
        var seen = Set<Substring>()
        for word in words(text) {
            if uzbekFunctionWords.contains(String(word)) {
                seen.insert(word)
            } else if word.count >= 6,
                      uzbekSuffixes.contains(where: { word.hasSuffix($0) && word.count >= $0.count + 4 }) {
                seen.insert(word)
            }
        }
        return seen.count
    }

    /// Whether a Latin transcript from the Uzbek route is really English.
    public static func looksLikeEnglish(_ text: String) -> Bool {
        let english = englishEvidence(text)
        return english >= englishEvidenceFloor && english >= englishDominance * uzbekEvidence(text)
    }
}

// MARK: - Transcript check

/// The verifier for the mis-route nothing above can see: Uzbek audio routed to Parakeet.
///
/// Measured on the pipeline's own end-to-end run (P1 §0): 40 of 256 Uzbek dictations went to
/// Parakeet, the same 16 % as the whole-clip detector on the 344-clip harness. Nothing noticed,
/// because Parakeet does not fail on Uzbek — it writes something. But what it writes is not
/// English: over the 55 harness clips the detector missed, it wrote pseudo-Hungarian, -Polish,
/// -Dutch and -Lithuanian (`Nagyon koszta enda.`, `De wereld indeking kan gaan beter als
/// Windows.`, `…šunničiais bus teimo account…`), nothing at all (5), or Cyrillic (2). Real
/// English out of Parakeet is made of English words. So the one question worth asking of its
/// transcript is "what share of these words are English words?" — against a 39k-word list of
/// common English words and inflections (`EnglishWords`, from SCOWL) — and the transcript it
/// streams anyway is free to ask.
///
/// Measured (docs/research/P2-uzbek-route-and-tail.md §2): Parakeet's transcript reads below
/// `notEnglishBelow` for 91 % of all Uzbek clips and for 0 of 400 FLEURS English and Russian
/// ones. On the owner's own diagnostics — 1,159 dictations routed to English, read through the
/// same rule — it fired on 11 (0.9 %), and several of those were Uzbek greetings.
///
/// Doubt is not a verdict. What follows it is the Uzbek engine's own transcript of the same
/// audio (`readsAsEnglish`): English audio comes back from the Uzbek fine-tune as English, and
/// then Parakeet's transcript stands. The rule never moves a pinned dictation, and it only reads
/// Latin: Parakeet's Cyrillic on Uzbek audio is too close to Russian for a word list of this size.
public enum TranscriptCheck: Sendable {

    /// What a transcript is made of. `counted` leaves out what a word list cannot judge: proper
    /// nouns and acronyms (a capital anywhere but the first letter, or a first capital that does
    /// not start a sentence). `known` is how many of the counted words are English words.
    public struct Reading: Sendable, Equatable {
        public var words = 0
        public var latin = 0
        public var cyrillic = 0
        public var counted = 0
        public var known = 0
        public init() {}
        /// Share of counted words that are English words; nil when nothing was counted.
        public var coverage: Double? { counted > 0 ? Double(known) / Double(counted) : nil }
    }

    public enum Doubt: String, Sendable, Codable, Equatable {
        /// No words at all, though the speech detector heard speech: Parakeet gave up on it.
        case noWords
        /// Latin, and fewer than `notEnglishBelow` of its words are English words.
        case notEnglish
    }

    /// Below this share of English words, Parakeet's transcript is not English. On the tuning
    /// half: 0.6 caught 40 of 55 missed Uzbek clips, 0.7 caught 45 and 0.8 caught no more while
    /// flagging twice as much of the owner's English; 0 FLEURS clips at any of them.
    public static let notEnglishBelow = 0.7

    /// At or above this share, the Uzbek engine's transcript is English and Parakeet's stands.
    /// Uzbek comes back from it under 0.3 in 311 of 312 doubted harness clips; the owner's
    /// English misrouted to it measured 0.62–1.0.
    public static let readsAsEnglishFrom = 0.5

    static let lexicon: Set<String> = Set(EnglishWords.text.split(separator: "\n").map(String.init))

    /// Words in the list. For the golden fixture, and to pay the ~10 ms of building the set
    /// somewhere other than the first key-up.
    public static var lexiconCount: Int { lexicon.count }
    /// sha256 of the list as generated (newline-joined), so a port can prove it holds the same one.
    public static let lexiconSHA256 = EnglishWords.sha256

    /// Clitics an English word carries without being listed with them: `we'll`, `shouldn't`.
    private static let clitics = ["n't", "'re", "'ve", "'ll", "'d", "'m"]

    /// English the dictionary list does not carry, and that a dictation is made of. The list is
    /// a 2020 word-game dictionary: it has `hey` and `okay` but not `yeah`, `ok`, `yep`, `nope`,
    /// `um`, `uh` or `app`. So "Yeah." — a whole, common English dictation — read as 0 % English,
    /// was sent to the Uzbek engine, and even that engine's faithful "Yeah." then failed
    /// `readsAsEnglish` and *replaced* Parakeet's text on the Uzbek route. Measured with this
    /// list, `hesitations` and the digit-suffix rule over the cached Parakeet transcripts
    /// (2026-09-30): the owner's English doubted 11 → 8 of 1,182, FLEURS en/ru 0 → 0 of 400,
    /// Uzbek doubted 265 → 265 of 344 (tuning) and 299 → 298 of 401 (held out; the one is
    /// `Who er can ozen if here an aidan made?`). Kept apart from `lexicon` so the list and its
    /// golden sha256 stay as generated.
    static let supplement: Set<String> = [
        "yeah", "yep", "yup", "nope", "nah", "ok", "alright", "gotcha", "huh", "oops", "lol",
        "gonna", "wanna", "gotta", "kinda", "dunno", "anyways",
        "app", "apps", "online", "offline", "download", "downloads", "downloaded", "upload",
        "uploaded", "website", "websites", "setup", "login", "email", "emails", "browser",
        "screenshot", "screenshots", "inbox", "username", "wifi", "laptop", "podcast", "blog",
    ]

    /// Whether a lowercase word (apostrophes folded to ') is an English word.
    public static func isEnglishWord(_ word: String) -> Bool {
        if lexicon.contains(word) || supplement.contains(word) { return true }
        if word.hasSuffix("'s"), lexicon.contains(String(word.unicodeScalars.dropLast(2))) {
            return true
        }
        for clitic in clitics where word.unicodeScalars.count > clitic.unicodeScalars.count
            && word.hasSuffix(clitic) {
            if lexicon.contains(String(word.unicodeScalars.dropLast(clitic.unicodeScalars.count))) {
                return true
            }
        }
        return false
    }

    /// Words by Unicode scalar, the way the Windows port walks them: a run of alphabetic scalars,
    /// with ' or ’ kept only between two letters. A word after `.`, `!` or `?` (or first) starts a
    /// sentence.
    /// And whether the word is glued to a digit before it — the `st` of `1st`, the `s` of `90s`,
    /// the `am` of `9am`: a number's suffix, which no word list judges.
    static func words(scalarsOf text: String)
        -> [(word: String, startsSentence: Bool, afterDigit: Bool)] {
        let scalars = Array(text.unicodeScalars)
        var out: [(String, Bool, Bool)] = []
        var i = 0
        var starts = true
        while i < scalars.count {
            let scalar = scalars[i]
            guard scalar.properties.isAlphabetic else {
                if scalar == "." || scalar == "!" || scalar == "?" { starts = true }
                i += 1
                continue
            }
            var j = i + 1
            while j < scalars.count {
                if scalars[j].properties.isAlphabetic {
                    j += 1
                } else if scalars[j] == "'" || scalars[j] == "\u{2019}", j + 1 < scalars.count,
                          scalars[j + 1].properties.isAlphabetic {
                    j += 1
                } else {
                    break
                }
            }
            var word = String.UnicodeScalarView()
            word.append(contentsOf: scalars[i..<j])
            out.append((String(word), starts, i > 0 && scalars[i - 1].properties.numericType != nil))
            starts = false
            i = j
        }
        return out
    }

    private static func isLatin(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x41...0x5A, 0x61...0x7A, 0x1E00...0x1EFF: return true
        case 0xC0...0x24F: return s.value != 0xD7 && s.value != 0xF7
        default: return false
        }
    }

    private static func isCyrillic(_ s: Unicode.Scalar) -> Bool { (0x400...0x4FF).contains(s.value) }

    /// Hesitation sounds, which every language makes. They are evidence of nothing when there are
    /// words beside them — `Um, yeah.` is English — and are counted as not English only when
    /// they are all there is, which is what Parakeet makes of some Uzbek (`Uh.`).
    static let hesitations: Set<String> = ["uh", "um", "hmm", "mhm", "er", "erm", "mm", "ah"]

    public static func read(_ text: String) -> Reading {
        var reading = Reading()
        var hesitated = 0
        for (word, startsSentence, afterDigit) in words(scalarsOf: text) {
            reading.words += 1
            let scalars = word.unicodeScalars
            if scalars.contains(where: isCyrillic) {
                reading.cyrillic += 1
            } else if scalars.contains(where: isLatin) {
                reading.latin += 1
            }
            // A number's suffix is not a word: `1st`, `2nd` and `3rd` counted `st`, `nd` and `rd`
            // as three non-English words (72 of them in the owner's English diagnostics).
            if afterDigit { continue }
            // A proper noun or an acronym says nothing about the language around it — `Gonka`,
            // `MCP`, `YouTube` — and Parakeet capitalises them.
            if scalars.dropFirst().contains(where: { $0.properties.isUppercase }) { continue }
            if let first = scalars.first, first.properties.isUppercase, !startsSentence,
               word != "I" { continue }
            let lower = word.lowercased().replacingOccurrences(of: "\u{2019}", with: "'")
            if hesitations.contains(lower) {
                hesitated += 1
                continue
            }
            reading.counted += 1
            if isEnglishWord(lower) { reading.known += 1 }
        }
        if reading.counted == 0 { reading.counted = hesitated }
        return reading
    }

    /// Whether Parakeet's transcript of an unpinned dictation doubts its own route. nil — the
    /// common case — means it reads as English (or as Cyrillic, which this does not judge).
    public static func doubt(_ unifiedTranscript: String) -> Doubt? {
        let reading = read(unifiedTranscript)
        if reading.words == 0 {
            // "25" is a transcript; an empty string after speech is not.
            let hasNumber = unifiedTranscript.unicodeScalars
                .contains { $0.properties.numericType != nil }
            return hasNumber ? nil : .noWords
        }
        guard reading.latin >= reading.cyrillic, let coverage = reading.coverage else { return nil }
        return coverage < notEnglishBelow ? .notEnglish : nil
    }

    /// Whether the Uzbek engine's transcript is English — then the audio was, and the doubt was
    /// wrong. Nothing countable is not English.
    public static func readsAsEnglish(_ text: String) -> Bool {
        (read(text).coverage ?? 0) >= readsAsEnglishFrom
    }
}

// MARK: - Optional languages (D-11)

/// How Turkish and Arabic are routed when the user has turned them on. Off — the default, and
/// the state of every install that never opens Languages — the router is exactly what it was:
/// nothing below is read, and the three core languages pay nothing for the two optional ones.
///
/// Every number is measured with the shipped detector (whisper base q5_1) over the 745 real Uzbek
/// clips of P2 (344 tuning / 401 held out), FLEURS en/ru/tr/ar and the Casablanca Arabic dialect
/// set, chosen on the tuning half and run once on the held-out half (C4 §11, reproduced by
/// `kotiba-probe route-eval --optional tr,ar`). Shares are of the whole posterior.
///
/// The constraint they were chosen under is the owner's: Uzbek sent anywhere else must stay at or
/// under 3.0 % held out — which it already was, 12 of 401, before either language existed — so a
/// rule that costs a single held-out Uzbek clip fails it. Where a decision is uncertain, Uzbek.
/// Measured with both on: Uzbek elsewhere 6/344 tuning and 12/401 held out, exactly as with both
/// off; English and Russian elsewhere 0/400.
public struct OptionalLanguageRules: Sendable, Equatable {
    /// Which optional languages are on. Empty: every rule below is skipped.
    public var enabled: Set<Language>

    /// Arabic, at or above this `ar` share. Arabic is a clear acoustic class — FLEURS Arabic
    /// scores a median 0.998, English and Russian at most 0.017, Turkish 0.002 — but a few Uzbek
    /// clips full of Arabic loanwords and prayer formulas score high too (the highest 0.974,
    /// `xatim qur'oni yakunida duoda qatnashdik`), so this sits just above the tuning half's
    /// highest. Held out: 85 of 98 MSA clips, 38 of 91 dialect clips, no Uzbek.
    ///
    /// There is deliberately no lower threshold for "Parakeet doubted its route and the detector
    /// half-heard Arabic": every one tried (0.5 … 0.95) took Uzbek on the tuning half — the
    /// Uzbek second opinion rescues those clips today — and a veto on Uzbek words in that
    /// opinion left short ones through. An Arabic dictation this misses goes to the Uzbek
    /// engine; the Arabic pin is the answer for a speaker it misses.
    public var arabicFrom: Double
    /// A Turkic-cluster recording with a `tr` share at least this is a Turkish *candidate*: routed
    /// to Uzbek unless `TurkishCheck` says Turkish. 199 of 200 FLEURS Turkish clips; 83 of 745
    /// Uzbek clips reach 0.8 and about one in sixteen 0.9.
    public var turkishCandidateFrom: Double
    /// …and only a recording at least this long. Short dictation is where Turkish and Uzbek are
    /// least separable: the Uzbek clips even turbo's language head hears as Turkish (a `tr` share
    /// of 1.000 on `uzib olamizmi`) are 1.6–4.8 s. 5 s is the shortest floor that took no Uzbek on
    /// the tuning half; held out it took none either. A shorter Turkish dictation goes to Uzbek —
    /// the owner's rule for an uncertain one — and the Turkish pin is the answer for it.
    public var turkishMinimumSeconds: Double
    /// Under `arabicFrom`, a recording with an `ar` share at least this is an Arabic *candidate*:
    /// routed as it would be with Arabic off unless `ArabicCheck` (turbo's language head) says
    /// Arabic. Chosen on the tuning half (C4 §14.1): English, Russian and Turkish never reach it
    /// (FLEURS max 0.017), so the check is asked only of Uzbek and Arabic — of 9 % of Uzbek
    /// dictations of 3.5 s or more, and of every Arabic one the outright rule misses but 1 in 7.
    public var arabicCandidateFrom: Double
    /// …and only a recording at least this long. turbo's head hears some short Uzbek as Arabic —
    /// `bizning fe'limiz sabablik bo'ldi` (2.2 s) at 0.993, `xatmi qur'on yakunida duoda
    /// qatnashdik` (3.3 s) at 0.983 — and from 3.5 s the highest Uzbek on either half is 0.861.
    /// A shorter Arabic dictation the outright rule misses is routed as before; the Arabic pin
    /// is the answer for it.
    public var arabicCandidateMinimumSeconds: Double

    public init(enabled: Set<Language> = [],
                arabicFrom: Double = OptionalLanguageRules.defaultArabicFrom,
                turkishCandidateFrom: Double = OptionalLanguageRules.defaultTurkishCandidateFrom,
                turkishMinimumSeconds: Double = OptionalLanguageRules.defaultTurkishMinimumSeconds,
                arabicCandidateFrom: Double = OptionalLanguageRules.defaultArabicCandidateFrom,
                arabicCandidateMinimumSeconds: Double =
                    OptionalLanguageRules.defaultArabicCandidateMinimumSeconds) {
        self.enabled = enabled.filter(\.isOptional)
        self.arabicFrom = arabicFrom
        self.turkishCandidateFrom = turkishCandidateFrom
        self.turkishMinimumSeconds = turkishMinimumSeconds
        self.arabicCandidateFrom = arabicCandidateFrom
        self.arabicCandidateMinimumSeconds = arabicCandidateMinimumSeconds
    }

    public static let defaultArabicFrom = 0.975
    public static let defaultArabicCandidateFrom = 0.05
    public static let defaultArabicCandidateMinimumSeconds = 3.5
    public static let defaultTurkishCandidateFrom = 0.9
    public static let defaultTurkishMinimumSeconds = 5.0

    /// `code`'s share of the whole posterior; 0 for an empty or all-zero one.
    public static func share(_ code: String, of posterior: [String: Double]) -> Double {
        let total = posterior.values.reduce(0, +)
        guard total > 0 else { return 0 }
        return (posterior[code] ?? 0) / total
    }
}

/// The second opinion that tells Turkish from Uzbek.
///
/// whisper base cannot: it hears most Uzbek as Turkish (that is why `ClusterMass` exists), and at
/// every threshold that keeps Turkish recall it takes Uzbek too — 10 of 745 clips even at a `tr`
/// share of 0.98, where Turkish recall is already down to 177 of 200. Nor can words: turbo told to
/// write Turkish writes Uzbek audio as fluent-looking Turkish (`Bu konuda çalışmalıyım.`), and the
/// Uzbek engine writes Turkish audio in Uzbek spelling (`bir cho'k … kontrollerdan`), so neither
/// transcript separates them (C4 §11.2).
///
/// whisper large-v3-turbo's own language head nearly does — the model the Turkish engine already
/// holds, so asking it costs one encoder pass on that engine's context and no new file. Every
/// FLEURS Turkish clip scored a `tr` share ≥ 0.9946; of the 83 Uzbek clips whisper base called
/// likely Turkish, 13 still reached 0.99 — all shorter than 5 s, which is what
/// `OptionalLanguageRules.turkishMinimumSeconds` is for. Over the full 30 s window it cost
/// ~0.6–0.9 s, too slow for the critical path, so the session asks it during the hold — spaced,
/// and again at the pause before key-up — only for a Turkish candidate, and key-up waits only for
/// what it has not yet heard. The head reads a window fitted to the audio (`headMargin`).
public enum TurkishCheck: Sendable {
    /// Turkish at or above this `tr` share from turbo's language head; Uzbek below — for a
    /// user who has dictated Turkish before.
    public static let verifiedFrom = 0.99
    /// …and this for one who never has (`AppSettings.turkishDictations` is 0): turning Turkish
    /// on is a reason to expect it, not proof, so the first one needs more. Measured on what the
    /// session hears (C4 §13.1, fit:128, speech cut + 0–300 ms): every FLEURS Turkish clip
    /// ≥ 0.9956, so 0.995 costs `route-eval` nothing (held-out 92/94, tuning 105/106 at both),
    /// and the highest Uzbek of 5 s or more is 0.949 — the margin under it doubles.
    public static let verifiedFromUnfamiliar = 0.995
    /// Encoder positions of silence after the audio in the window the head reads (50 a second),
    /// before the window is rounded up to a multiple of 256 (`WhisperEngine.AudioContext`).
    ///
    /// Measured (C4 §13, `kotiba-probe head`) over the 200 FLEURS Turkish clips and the 83 Uzbek
    /// clips whisper base hears as ≥ 0.8 Turkish. The full 30 s window cost ~560–620 ms a check;
    /// a fitted one 90 ms at 5 s and ~180–280 ms for a whole FLEURS clip. What the session reads —
    /// the speech cut where it ends, 0–300 ms after it, at the level `e2e` replays (peak 0.3) —
    /// every Turkish clip scored ≥ 0.9956 at 128 (full: ≥ 0.9985) and the highest Uzbek of 5 s
    /// or more 0.949 (full: 0.996). At 0 two Turkish clips fell to 0.986–0.987 there; at 256 and
    /// 512 the untrimmed files lost tuning clips. `route-eval` at 128 over the untrimmed files:
    /// held-out Uzbek 12/401 and Turkish 92/94 as with the full window, tuning Turkish 104/106
    /// (full 105) — the one more is a clip with 2.4 s of silence after its speech, which is why
    /// key-up's check reads only to the speech's end (`DictationSession.turkishPosterior`).
    public static let headMargin = 128

    /// The threshold for this user: `verifiedFrom` once they have dictated Turkish (a pinned
    /// Turkish dictation counts), `verifiedFromUnfamiliar` until then.
    public static func threshold(familiar: Bool) -> Double {
        familiar ? verifiedFrom : verifiedFromUnfamiliar
    }

    /// What turbo's posterior says: Turkish, or not.
    public static func isTurkish(_ verifierPosterior: [String: Double], familiar: Bool) -> Bool {
        OptionalLanguageRules.share("tr", of: verifierPosterior) >= threshold(familiar: familiar)
    }
}

/// The second opinion that finds the Arabic whisper base half-heard (C4 §14.1).
///
/// whisper base is sure of read MSA (median `ar` share 0.998) and unsure of everything else
/// Arabic: dialect speech scatters over French, Hebrew, Persian, Turkish and Greek (median 0.95,
/// a quarter under 0.57), and some MSA lands at 0.90–0.97 — under `arabicFrom`, which cannot
/// come down because Uzbek full of Arabic loanwords reaches 0.974. whisper large-v3-turbo's own
/// language head — the model the Turkish engine and Arabic's fallback already are, asked through
/// the same fitted window as `TurkishCheck` (`TurkishCheck.headMargin`) — hears 197 of 200 FLEURS
/// Arabic clips at ≥ 0.99 and dialects far better than base does. It is not a verdict on its own:
/// it also hears short Uzbek as Arabic (0.993 on a 2.2 s clip). So it is asked only of an Arabic
/// candidate (`OptionalLanguageRules.arabicCandidateFrom`, ≥ 3.5 s), where the highest Uzbek on
/// either half of P2's 745 clips is 0.861.
public enum ArabicCheck: Sendable {
    /// Arabic at or above this `ar` share of turbo's posterior, for a user who has dictated
    /// Arabic before.
    public static let verifiedFrom = 0.95
    /// …and this for one who never has (`AppSettings.arabicDictations` is 0).
    public static let verifiedFromUnfamiliar = 0.98

    public static func threshold(familiar: Bool) -> Double {
        familiar ? verifiedFrom : verifiedFromUnfamiliar
    }

    public static func isArabic(_ verifierPosterior: [String: Double], familiar: Bool) -> Bool {
        OptionalLanguageRules.share("ar", of: verifierPosterior) >= threshold(familiar: familiar)
    }
}

/// The candidate's own check: `TurkishCheck` for Turkish, `ArabicCheck` for Arabic — one turbo
/// head answers both (its posterior covers every language), the rule is the candidate's.
public enum LanguageCheck: Sendable {
    public static func verifies(_ candidate: Language, _ posterior: [String: Double],
                                familiar: Bool) -> Bool {
        switch candidate {
        case .turkish: return TurkishCheck.isTurkish(posterior, familiar: familiar)
        case .arabic: return ArabicCheck.isArabic(posterior, familiar: familiar)
        case .english, .russian, .uzbek: return false
        }
    }

    public static func source(for candidate: Language) -> RouteSource {
        candidate == .arabic ? .arabicCheck : .turkishCheck
    }
}

// MARK: - The router

/// Supplies an acoustic posterior. `KotibaLID` conforms with ECAPA; tests conform with a
/// dictionary. Kept separate from `LanguageRouter` so the decision logic stays pure and the
/// Core ML model stays out of `KotibaCore`.
public protocol AcousticClassifier: Sendable {
    /// A language-code → probability map. Need not be normalised.
    func posterior(for audio: AudioBuffer) async -> [String: Double]
}

public struct TieredRouter: LanguageRouter {
    private let classifier: (any AcousticClassifier)?
    private let clusterMass: ClusterMass
    private let fallback: Language
    public let optional: OptionalLanguageRules
    /// The dictation languages that are on. Nothing outside it is ever returned.
    public let languages: LanguageSubset

    public init(
        classifier: (any AcousticClassifier)? = nil,
        clusterMass: ClusterMass = ClusterMass(),
        fallback: Language = .english,
        optional: OptionalLanguageRules = OptionalLanguageRules(),
        languages: LanguageSubset = .all
    ) {
        self.classifier = classifier
        self.clusterMass = clusterMass
        self.fallback = languages.fallback(preferring: fallback)
        self.optional = optional
        self.languages = languages
    }

    public func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        // P1. A pin is absolute and free. Nothing below it runs — not even to log a second
        // opinion, because the acoustic pass costs real milliseconds on the critical path.
        if let pin {
            return RouteDecision(language: pin, source: .pin)
        }
        // One language on (or English and Russian alone): nothing to decide, and just as free.
        if let sole = languages.soleRoute(preferring: fallback) {
            return RouteDecision(language: sole, source: .only)
        }

        // P4. One acoustic pass over the whole utterance at key-release. Not a rolling pass
        // over a prefix: prefix answers are wrong *and* confident, and their accuracy is not
        // even monotonic in prefix length — a Russian clip scored `en` p=0.640 at 0.5 s, higher
        // than the correct `ru` at 1.0 s.
        guard let classifier else {
            return RouteDecision(language: fallback, source: .fallback)
        }
        let posterior = await classifier.posterior(for: audio)
        guard !posterior.isEmpty else {
            return RouteDecision(language: fallback, source: .fallback)
        }
        return languages.decide(posterior, seconds: audio.duration, clusterMass: clusterMass,
                                optional: optional, preferring: fallback)
    }

    /// The acoustic tier over one posterior of `seconds` of audio. Static and pure so
    /// `kotiba-probe route-eval` and the golden fixtures replay exactly what the router does.
    public static func decide(_ posterior: [String: Double], seconds: Double,
                              clusterMass: ClusterMass,
                              optional: OptionalLanguageRules) -> RouteDecision {
        let mass = clusterMass.mass(posterior)
        let rules = optional
        let on = !rules.enabled.isEmpty
        let tr = on ? OptionalLanguageRules.share("tr", of: posterior) : nil
        let ar = on ? OptionalLanguageRules.share("ar", of: posterior) : nil

        // Arabic first: its rule is strict enough that no Uzbek clip measured reaches it, and an
        // Arabic clip that also carried Turkic mass (a few dialect ones do) belongs here.
        if rules.enabled.contains(.arabic), let ar, ar >= rules.arabicFrom {
            return RouteDecision(language: .arabic, source: .acoustic, turkicMass: mass,
                                 turkishShare: tr, arabicShare: ar)
        }
        // Half-heard Arabic, from any route: settled by `ArabicCheck` (C4 §14.1). A Turkish
        // candidate needs a `tr` share of 0.9, which leaves at most 0.1 for `ar`, so the two
        // can coincide only when both thresholds are moved — and then Turkish asks first.
        let arabicCandidate = rules.enabled.contains(.arabic)
            && (ar ?? 0) >= rules.arabicCandidateFrom
            && seconds >= rules.arabicCandidateMinimumSeconds
        if mass >= clusterMass.threshold {
            let candidate: Language? = rules.enabled.contains(.turkish)
                && (tr ?? 0) >= rules.turkishCandidateFrom
                && seconds >= rules.turkishMinimumSeconds ? .turkish
                : arabicCandidate ? .arabic : nil
            return RouteDecision(language: .uzbek, source: .acoustic, turkicMass: mass,
                                 turkishShare: tr, arabicShare: ar, candidate: candidate)
        }
        // Inside the unified engine the language label is advisory: Parakeet decides en-vs-ru
        // itself. Recording the more likely of the two is for the log and the HUD, not for the
        // engine, which is why getting it wrong here costs nothing.
        let ru = posterior["ru"] ?? 0
        let en = posterior["en"] ?? 0
        return RouteDecision(language: ru > en ? .russian : .english,
                             source: .acoustic, turkicMass: mass,
                             turkishShare: tr, arabicShare: ar,
                             candidate: arabicCandidate ? .arabic : nil)
    }
}

// MARK: - Verification after the fact

public enum RouteVerdict: Sendable, Equatable {
    case consistent
    /// The output script disagrees with the route. Carries what the script suggests instead.
    case suspect(observed: ScriptCheck.Script, suggests: Language)
}

extension RouteDecision {
    /// Run after transcription, before insertion. ~0 ms in the common case.
    ///
    /// This deliberately does **not** re-run the other engine on its own authority. Doing so
    /// costs the slow engine's full latency on every false positive, and nothing in the
    /// research measures how often that would fire. It reports; the caller decides.
    public func verify(_ transcript: String) -> RouteVerdict {
        guard !ScriptCheck.agrees(transcript, with: language) else { return .consistent }
        let observed = ScriptCheck.script(of: transcript)
        // Cyrillic is evidence in whichever direction the route did not go: out of the Uzbek
        // engine it means the audio was Russian, and out of the Russian one — where it only
        // reaches here at all when the letters are not Russian letters — it means Uzbek.
        // Latin out of the Uzbek engine only disagrees when the words are English words.
        //
        // Arabic script suggests Arabic from any route; out of the Arabic route, Latin suggests
        // English and Cyrillic Russian (Cohere writes Arabic for Arabic speech). Cyrillic out of
        // the Turkish route suggests Russian, like out of the Uzbek one.
        let suggests: Language
        switch (observed, language) {
        case (.arabic, _): suggests = .arabic
        case (.cyrillic, .uzbek), (.cyrillic, .turkish), (.cyrillic, .arabic): suggests = .russian
        case (.cyrillic, _): suggests = .uzbek
        case (.latin, .uzbek), (.latin, .arabic): suggests = .english
        default: suggests = .uzbek
        }
        return .suspect(observed: observed, suggests: suggests)
    }
}
