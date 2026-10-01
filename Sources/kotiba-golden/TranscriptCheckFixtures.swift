import Foundation
import KotibaCore

// transcript-check.json — `TranscriptCheck`, the key-up reading of Parakeet's transcript that
// sends Uzbek the acoustic pass missed back to the Uzbek engine (session step 4a′).
//
// Every text below was written for this fixture; none is a real dictation or a corpus
// transcript. The gibberish lines imitate the *shape* of what Parakeet writes for Uzbek audio —
// Latin words that are not English, some with Central-European diacritics — without copying
// any. What a port must reproduce exactly: the word splitter (by Unicode scalar, apostrophes
// only between letters), which words are left uncounted (a capital after the first letter; a
// first capital that does not start a sentence, except `I`), the clitic stripping, the two
// thresholds, and the list itself (count and sha256).

enum TranscriptCheckFixtures {

    private static let texts: [Corpus.Case] = [
        // English, as Parakeet writes it.
        .init("Please send the report to the team before lunch.", "plain English: every word known"),
        .init("Okay, fix them all.", "short English"),
        .init("Okay.", "one word"),
        .init("I think we should move the meeting to Thursday.", "I mid-sentence is counted"),
        .init("We'll see, but I don't think it's ready and they shouldn't ship.",
              "clitics: 'll, n't, 's"),
        .init("It\u{2019}s the cat\u{2019}s toy, isn\u{2019}t it?", "curly apostrophes fold to '"),
        .init("Ask Gonka about the Codex bridge on the OVH server.",
              "proper nouns and an acronym are not counted"),
        .init("Open YouTube and iCloud, then check the MCP logs.",
              "a capital after the first letter: not counted"),
        .init("Deploy it. Kotib should restart.",
              "a capitalised word that starts a sentence IS counted"),
        .init("the api key for the vps is in the keychain", "lowercase jargon is counted as unknown"),
        .init("rock'n'roll o'clock ma'am", "apostrophes inside words are kept"),
        .init("'quoted' words", "an apostrophe at the edge of a word is not part of it"),
        .init("Twenty five. 25!", "digits are not words"),
        // Not English, the shape Parakeet writes for Uzbek audio.
        .init("Morvalen tikoshar penduvi askarel dunemba.", "made-up Latin: nothing known"),
        .init("Keštar volunė šimka tar lėmos.", "diacritics: every such word is unknown"),
        .init("De morvalen sal tikoshar met Windows.", "a few short words look English"),
        .init("I can tikoshar a penduvi.", "mostly English-looking, one in three unknown"),
        .init("Has made tolvik?", "two of three known: 0.67 is under 0.7"),
        // Uzbek, as the Uzbek engine writes it.
        .init("bugun bozorga bordim va non oldim.", "Uzbek Latin"),
        .init("xo\u{02BB}p, qarang aka, men hozir kelaman.", "Uzbek with the okina"),
        .init("xo'p, men ham borsam bo'ladimi?", "Uzbek with ASCII apostrophes"),
        .init("men ham shu gapni aytdim", "Uzbek words that happen to be English words"),
        .init("first send all the files, keyin ko'ramiz", "code-switched, mostly English"),
        .init("bu loyiha uchun yangi dizayn kerak edi, deadline ertaga", "Uzbek with one English word"),
        // Cyrillic, mixed, empty.
        .init("\u{041F}\u{0440}\u{0438}\u{0432}\u{0435}\u{0442}, \u{043A}\u{0430}\u{043A} "
              + "\u{0434}\u{0435}\u{043B}\u{0430}?", "Russian: not judged here"),
        .init("\u{041F}\u{0440}\u{0438}\u{0432}\u{0435}\u{0442} hello world",
              "more Latin than Cyrillic words: judged"),
        .init("\u{041F}\u{0440}\u{0438}\u{0432}\u{0435}\u{0442} \u{043C}\u{0438}\u{0440} hello",
              "more Cyrillic than Latin: not judged"),
        .init("", "empty: no words"),
        .init("...", "punctuation only: no words"),
        .init("25", "a number is a transcript, not an absence of one"),
        .init("\u{03B1}\u{03B2}\u{03B3} \u{03B4}\u{03B5}", "Greek: words, neither Latin nor Cyrillic"),
        .init("caf\u{00E9} clich\u{00E9}", "the list's own accented entries"),
        .init("ÉCLAIRS", "all capitals: not counted"),
        // The core review of 2026-09-30 (2c94b75): the supplement list, hesitations, and a
        // number's suffix. The Windows port counted "Yeah." as 0 % English.
        .init("Yeah.", "supplement: a whole English dictation the list lacks"),
        .init("Ok.", "supplement: ok"),
        .init("Yep, the app sent the email.", "supplement: yep, app, email"),
        .init("Nope, I'm gonna upload it online.", "supplement: nope, gonna, upload, online"),
        .init("Um, yeah.", "a hesitation beside a word is not counted"),
        .init("Uh.", "only hesitations: counted, and not English"),
        .init("Um uh hmm.", "several hesitations and nothing else"),
        .init("Um morvalen tikoshar.", "a hesitation beside non-English"),
        .init("Er, the 1st and 2nd of the 90s at 9am.", "digit suffixes are not counted"),
        .init("Meet on the 3rd.", "3rd: `rd` is a suffix"),
        .init("I saw 2 cats.", "a spaced digit does not make the next word a suffix"),
        .init("The apps' downloads.", "an apostrophe at the edge"),
    ]

    /// Words at the edges of the list and its rules, looked up directly.
    private static let lookups = [
        "a", "i", "the", "okay", "éclairs", "zygote", "don't", "shouldn't", "we'll", "cat's",
        "o'clock", "api", "kotib", "gonka", "va", "bu", "men", "ham", "koszta", "n't", "'s",
        // The supplement, and its limits: clitics and 's are looked up in the list alone.
        "yeah", "ok", "yep", "yup", "nope", "nah", "alright", "gotcha", "huh", "oops", "lol",
        "gonna", "wanna", "gotta", "kinda", "dunno", "anyways", "app", "apps", "online",
        "offline", "download", "downloads", "downloaded", "upload", "uploaded", "website",
        "websites", "setup", "login", "email", "emails", "browser", "screenshot", "screenshots",
        "inbox", "username", "wifi", "laptop", "podcast", "blog", "app's", "email's", "um", "uh",
    ]

    static func all() -> JSONValue {
        let cases = texts.map { probe -> JSONValue in
            let reading = TranscriptCheck.read(probe.text)
            return obj([
                "text": str(probe.text),
                "exercises": str(probe.exercises),
                "words": .int(reading.words),
                "latin": .int(reading.latin),
                "cyrillic": .int(reading.cyrillic),
                "counted": .int(reading.counted),
                "known": .int(reading.known),
                "coverage": reading.coverage.map { num($0, decimals: 6) } ?? .null,
                "doubt": TranscriptCheck.doubt(probe.text).map { str($0.rawValue) } ?? .null,
                "readsAsEnglish": .bool(TranscriptCheck.readsAsEnglish(probe.text)),
            ])
        }
        let words = lookups.map { word -> JSONValue in
            obj(["word": str(word), "isEnglishWord": .bool(TranscriptCheck.isEnglishWord(word))])
        }
        return obj([
            "fixture": str("transcript-check"),
            "generator": str(Generator.identity),
            "source": str("KotibaCore/Routing.swift — TranscriptCheck; list: KotibaCore/EnglishWords.swift"),
            "note": str("""
                The key-up reading of Parakeet's transcript (DictationSession step 4a′). Words are \
                runs of Unicode-alphabetic scalars, with ' or U+2019 kept only between two letters; \
                a word after . ! ? (or the first) starts a sentence. A word is not counted if any \
                scalar after its first is uppercase, or if its first is uppercase, it does not \
                start a sentence and it is not "I", or if the scalar before it is numeric (the st \
                of 1st, the s of 90s). Counted words are lowercased and U+2019 folded to '; a \
                hesitation (uh um hmm mhm er erm mm ah) is set aside, and counts - as not English - \
                only when nothing else was counted. The rest are looked up as they are in the list \
                or its supplement (the lookups pin every supplement word), then in the list alone \
                without 's, then without one of n't 're 've 'll 'd 'm. doubt: no words and no numeric scalar -> noWords; else, if latin >= cyrillic \
                and something was counted, coverage < notEnglishBelow -> notEnglish. Latin = any \
                scalar in A-Z a-z U+00C0-U+024F (not U+00D7, U+00F7) U+1E00-U+1EFF; Cyrillic = any \
                in U+0400-U+04FF, checked first.
                """),
            "constants": obj([
                "notEnglishBelow": num(TranscriptCheck.notEnglishBelow, decimals: 6),
                "readsAsEnglishFrom": num(TranscriptCheck.readsAsEnglishFrom, decimals: 6),
                "lexiconCount": .int(TranscriptCheck.lexiconCount),
                "lexiconSHA256": str(TranscriptCheck.lexiconSHA256),
            ]),
            "lookups": arr(words),
            "count": .int(cases.count),
            "cases": arr(cases),
        ])
    }
}
