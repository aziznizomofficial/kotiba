import Foundation
import KotibaCore

// uzbek-delivery.json and capitalise.json.
//
// These two are one mechanism read from two ends. `UzbekNormaliser.forDelivery` decides which
// apostrophe glyph a word meant; `Capitaliser.restore` decides which letter starts a sentence —
// and the second is only able to do its job because the first left the punctuation alone. The
// project's most expensive bug was running the *scoring* normaliser here instead, which deleted
// every `.` `,` and `?` and thereby left the capitaliser nothing to find, so it produced exactly
// one capital per dictation, forever, and looked like a broken capitaliser rather than a
// misapplied normaliser. 02-BEHAVIOUR §2 is that story; these files are it made checkable.
//
// `uzbek-scoring.json` is deliberately NOT emitted. The wiring audit found the scoring normaliser
// (`clean` / `normaliseReference` / `normaliseHypothesis`) has no caller on the shipping path,
// and `foldOrthography` is on 02-BEHAVIOUR §3's confirmed-dead list. t04 has been told not to
// port them, so a fixture pinning their output would be a fixture for code that will not exist.

enum TextFixtures {

    // MARK: - Where the delivery corpus comes from

    /// One row of the delivery fixture before it is evaluated.
    private struct Sample {
        let text: String
        /// Which committed file this string came out of, keyed so a reader can find it again.
        let origin: String
        /// The rule it would expose if that rule were wrong. Empty for bulk corpus rows, whose
        /// value is volume rather than a named boundary.
        let exercises: String
    }

    /// The rule for which corpus rows appear, stated so it can be re-derived rather than trusted:
    ///
    ///  * every boundary case in `Corpus.textBoundaries`, each naming its constant;
    ///  * every one of the 318 `uzbek_text_norm` parity inputs — these carry the widest spread of
    ///    apostrophe glyphs in the repository, because the Python original was built against them;
    ///  * all 120 real transcripts, which is what the shipping model actually emits;
    ///  * all 745 UzbekVoice gold references, which is the okina-heavy half and where `forDelivery`
    ///    must be a **no-op** — 745 real Uzbek sentences that already have correct orthography are
    ///    the only way to catch a port that folds too eagerly;
    ///  * both halves of all 20 corrector pairs, the only real Uzbek here carrying capitals.
    private static var deliverySamples: [Sample] {
        var samples = Corpus.textBoundaries.map {
            Sample(text: $0.text, origin: "boundary", exercises: $0.exercises)
        }
        for (index, pair) in Corpus.parity.enumerated() {
            samples.append(Sample(text: pair.input,
                                  origin: "parity[\(index)].in/\(pair.mode)", exercises: ""))
        }
        for (index, text) in Corpus.transcripts.enumerated() {
            samples.append(Sample(text: text, origin: "transcript[\(index)]", exercises: ""))
        }
        for (key, text) in Corpus.evalReferences {
            samples.append(Sample(text: text, origin: "eval-reference[\(key)]", exercises: ""))
        }
        for (key, source, hypothesis) in Corpus.correctorPairs {
            samples.append(Sample(text: source, origin: "corrector[\(key)].src", exercises: ""))
            samples.append(Sample(text: hypothesis, origin: "corrector[\(key)].hyp", exercises: ""))
        }
        return samples
    }

    private static func count(_ text: String, of scalar: Character) -> Int {
        text.reduce(0) { $0 + ($1 == scalar ? 1 : 0) }
    }

    // MARK: - uzbek-delivery.json

    static func uzbekDelivery() -> JSONValue {
        var cases: [JSONValue] = []
        var changed = 0
        for sample in deliverySamples {
            let delivered = UzbekNormaliser.forDelivery(sample.text)
            // Idempotence is asserted per row rather than claimed once. `forDelivery` runs on
            // whatever the engine emitted, and the engine sometimes emits text that has already
            // been through it — the navai-uz family emits U+02BB natively in 71.8–76.7% of
            // transcripts. A second pass that moved anything would corrupt those.
            let twice = UzbekNormaliser.forDelivery(delivered)
            if delivered != sample.text { changed += 1 }
            var entry: [String: JSONValue] = [
                "in": str(sample.text),
                "origin": str(sample.origin),
                "out": str(delivered),
                "changed": .bool(delivered != sample.text),
                "idempotent": .bool(twice == delivered),
                "okinaOut": .int(count(delivered, of: UzbekNormaliser.okina)),
                "tutuqOut": .int(count(delivered, of: UzbekNormaliser.tutuq)),
                "asciiApostropheOut": .int(count(delivered, of: "'")),
            ]
            if !sample.exercises.isEmpty { entry["exercises"] = str(sample.exercises) }
            cases.append(obj(entry))
        }

        return obj([
            "fixture": str("uzbek-delivery"),
            "generator": str(Generator.identity),
            "source": str("KotibaCore/UzbekNormaliser.swift — UzbekNormaliser.forDelivery"),
            "note": str("""
                What the user actually receives. This, never `clean`, on the path to a document. \
                `forDelivery` fixes orthography and stops: case, punctuation, hyphens and digits \
                belong to the speaker. It decides between the two Uzbek modifier letters from the \
                single character immediately before the mark, lowercased — `o` or `g` give U+02BB \
                MODIFIER LETTER TURNED COMMA, everything else gives U+02BC MODIFIER LETTER \
                APOSTROPHE. Never a global replace: getting it backwards spells `san` + U+02BC + \
                `at` as `san` + U+02BB + `at`, which is visibly wrong to an Uzbek reader and \
                invisible to anyone testing in ASCII.
                """),
            "escapes": str("""
                Every non-ASCII scalar in this file is written as \\uXXXX on purpose. The whole \
                point of the fixture is the distinction between U+02BB and U+02BC, and a literal \
                glyph in a UTF-8 file is one editor, one core.autocrlf, one NFC pass away from \
                being the other one. Decode with a standard JSON parser; do not normalise the \
                result.
                """),
            "constants": obj([
                "okina": str(String(UzbekNormaliser.okina)),
                "tutuq": str(String(UzbekNormaliser.tutuq)),
                "okinaPrecededBy": arr(["o", "g"].map(str)),
                "precedingCharacterIsLowercasedFirst": .bool(true),
                "apostropheGlyphsFolded": arr("'\u{2018}\u{2019}\u{02BB}\u{02BC}\u{0060}"
                    .appending("\u{00B4}\u{02B9}\u{02BD}\u{2032}")
                    .map(String.init).sorted(by: scalarOrder).map(str)),
                "intraWordGuard": str("letters on BOTH sides or the mark stays punctuation"),
                "englishGenitive": str("mark + s or S, with nothing alphanumeric after, "
                                       + "emits ASCII U+0027 instead of an Uzbek letter"),
                "characterRepairs": obj([
                    "\u{0430}": str("a"),
                    "\u{04EF}": str("o\u{02BB}"),
                    "\u{04EE}": str("O\u{02BB}"),
                ]),
                "droppedScalars": arr(["\u{200B}", "\u{200C}", "\u{200D}", "\u{2060}",
                                       "\u{FEFF}", "\u{00AD}"].map(str)),
                "whitespace": str("runs of SPACE and TAB collapse to one SPACE; "
                                  + "NEWLINE survives because a mode may have asked for it; "
                                  + "the result is trimmed of whitespace and newlines"),
                "doesNotLowercase": .bool(true),
                "doesNotRemovePunctuation": .bool(true),
                "doesNotSpellNumbers": .bool(true),
            ]),
            "comparison": str("exact string equality — no tolerance, no normalisation"),
            "count": .int(cases.count),
            "changedCount": .int(changed),
            "cases": arr(cases),
        ])
    }

    // MARK: - capitalise.json

    /// The union across every language, which is what `DictationController` builds:
    /// `Set(settings.vocabulary.values.flatMap { $0 })`. 02-BEHAVIOUR §4 calls this out because it
    /// is the surprising half — an Uzbek term is force-capitalised inside an English sentence too,
    /// so "capitalise sentence starts" alone diverges the moment a user adds one vocabulary word.
    private static var unionVocabulary: Set<String> {
        Set(Corpus.vocabularyByLanguage.flatMap { $0.terms })
    }

    private static var capitaliseSamples: [Sample] {
        var samples = Corpus.textBoundaries.map {
            Sample(text: $0.text, origin: "boundary", exercises: $0.exercises)
        }
        // The 120 real transcripts are the measured case: 68.3% of them carry sentence
        // punctuation and 0.0% carry a capital, which is the entire reason a capitaliser exists
        // rather than a general corrector.
        for (index, text) in Corpus.transcripts.enumerated() {
            samples.append(Sample(text: text, origin: "transcript[\(index)]", exercises: ""))
        }
        // The corrector pairs are the only real Uzbek in this repository that already carries
        // capitals, so they are the only material that can tell an idempotent capitaliser from a
        // destructive one. `restore` must never lowercase.
        for (key, source, hypothesis) in Corpus.correctorPairs {
            samples.append(Sample(text: source, origin: "corrector[\(key)].src", exercises: ""))
            samples.append(Sample(text: hypothesis, origin: "corrector[\(key)].hyp", exercises: ""))
        }
        samples += capitaliserProbes.map {
            Sample(text: $0.text, origin: "probe", exercises: $0.exercises)
        }
        return samples
    }

    /// The core review of 2026-09-30 (4ee6c85): a terminator ends a sentence only once
    /// whitespace follows it. Before, `john.doe@gmail.com` was delivered `john.Doe@gmail.Com` —
    /// and the Windows port, with no fixture row inside a dotted word, kept doing it.
    static let capitaliserProbes: [Corpus.Case] = [
        .init("my email is john.doe@gmail.com", "a dot inside an address is not a sentence end"),
        .init("open google.com please. then wait", "a domain, then a real sentence end"),
        .init("the file is notes.txt", "a file name keeps its case"),
        .init("see e.g. the docs. next one", "e.g. mid-word dots; the stop before `next` counts"),
        .init("u dedi.\nkeyin", "a stop then a line break still ends the sentence"),
        .init("'salom.' keyingi gap", "a closing quote after the stop, then whitespace"),
        .init("\u{02BC}salom.\u{02BC} keyingi gap.", "a closing tutuq after the stop"),
        .init("narxi 3.5 ming. arzon", "a decimal point, then a real stop"),
        .init("wait...really? yes", "an ellipsis glued to a word does not open a sentence"),
        .init("hello.World and more", "a capital already there is never lowered"),
        .init("done. \"next\" one", "a quote after the space still waits for the letter"),
        .init("www.kotib.uz/yangi.html sahifasi", "a URL with a path"),
        .init("end.", "a stop at the very end"),
        .init("a.b. c", "stops glued to letters, then a space"),
    ]

    /// D-11: the same restore with the dictation's language. Turkish capitalises `i` as `İ` —
    /// `istanbul` must come back `İstanbul`, never `Istanbul` — and Arabic has no case at all, so
    /// a Latin word that opens an Arabic sentence is not "capitalised" either.
    static let languageProbes: [(Language, Corpus.Case)] = [
        (.turkish, .init("istanbul'a gidiyoruz. ırmak çok güzel.", "i → İ, ı → I at sentence starts")),
        (.turkish, .init("iyi günler. izmir'de misin?", "a second sentence opening with i")),
        (.turkish, .init("çok iyi. şimdi geliyorum. öğle yemeği hazır. ücret ödendi.",
                         "ç ş ö ü open sentences")),
        (.turkish, .init("İstanbul zaten büyük harfle.", "a capital İ already there stays")),
        (.turkish, .init("bu ne? ilginç.", "after a question mark")),
        (.english, .init("istanbul is big. it is.", "English keeps the locale-free rule")),
        (.uzbek, .init("iltimos kel. ishlar yaxshi.", "Uzbek keeps the locale-free rule")),
        (.arabic, .init("iPhone جديد وصل. هل رأيته؟ نعم.",
                        "Arabic: unchanged, the Latin word included")),
        (.arabic, .init("مرحبا. كيف حالك؟", "Arabic: unchanged")),
    ]

    static var languageCases: [JSONValue] {
        let bare = Capitaliser()
        let seeded = Capitaliser(alwaysCapitalised: unionVocabulary)
        return languageProbes.map { language, probe in
            obj([
                "language": str(language.rawValue),
                "in": str(probe.text),
                "exercises": str(probe.exercises),
                "out": str(bare.restore(probe.text, language: language)),
                "outWithVocabulary": str(seeded.restore(probe.text, language: language)),
            ])
        }
    }

    // MARK: - arabic-delivery.json (D-11, C4 §14.3)

    /// Rows for `ArabicNormaliser.forDelivery`: every rule, each edge (numbers, Latin inside
    /// Arabic, English beside it, marks on letters), and texts with no Arabic letter at all.
    static let arabicDeliverySamples: [(text: String, exercises: String)] = [
        ("مرحبا , كيف حالك ?", "Latin comma and question mark inside Arabic, spaced before"),
        ("أولا;ثانيا", "Latin semicolon, no space after"),
        ("نعم،لا", "Arabic comma glued to the next word"),
        ("هل وصلت ؟", "space before an Arabic question mark"),
        ("هل عندك iPhone?", "a Latin word ending an Arabic question: the sentence is Arabic"),
        ("شكرا. Are you there? نعم", "an English sentence keeps its own marks"),
        ("Hello, مرحبا, hi, ok?", "Latin letters outnumber Arabic: Latin marks stay"),
        ("دفعت 1,500 دينار", "a comma between digits is a number"),
        ("الساعة ٣٫٥ و ٢٠٪", "Arabic-Indic digits, decimal separator and percent sign"),
        ("عام ۱۹۹۰", "Persian digits"),
        ("رقم ٣٬٠٠٠ فقط", "Arabic thousands separator between digits"),
        ("في 3.5 ساعات. ثم", "a full stop between digits ends nothing"),
        ("جمـــيل", "tatweel"),
        ("في مدينةِ برلينَ", "case endings: final kasra and fatha"),
        ("يُعد فعّال شكرًا", "passive damma, shadda and tanwin are kept"),
        ("تُميّزُ،", "shadda kept, final damma dropped before a mark"),
        ("قالَ: نعمْ", "final fatha and sukun"),
        ("هٰذا كتاب", "superscript alef is spelling, kept"),
        ("مرحبا\nكيف حالك ?", "a newline ends a sentence"),
        ("هل أنت بخير ؟ نعم ، شكرا", "Arabic marks already, spaced the wrong way"),
        ("أرسل الملف على Google Drive , من فضلك", "a Latin name inside an Arabic sentence"),
        ("، بداية", "a mark at the very start"),
        ("نهاية ,", "a mark at the very end"),
        ("Hello, world?", "no Arabic letter: untouched"),
        ("Привет, мир?", "Cyrillic only: untouched"),
        ("salom, doʻstim?", "Uzbek only: untouched"),
        ("١٢٣ , ؟", "Arabic-Indic digits but no Arabic letter: untouched"),
        ("", "empty"),
    ]

    static func arabicDelivery() -> JSONValue {
        var cases: [JSONValue] = []
        for sample in arabicDeliverySamples {
            let delivered = ArabicNormaliser.forDelivery(sample.text)
            let twice = ArabicNormaliser.forDelivery(delivered)
            cases.append(obj([
                "in": str(sample.text),
                "out": str(delivered),
                "changed": .bool(delivered != sample.text),
                "idempotent": .bool(twice == delivered),
                "exercises": str(sample.exercises),
                // What the whole orthography step gives for the same text in every language:
                // only Arabic (and Uzbek's own rule) may change anything.
                "byLanguage": obj(Dictionary(uniqueKeysWithValues: Language.allCases.map {
                    ($0.rawValue, str(Orthography.forDelivery(sample.text, language: $0)))
                })),
            ]))
        }
        return obj([
            "fixture": str("arabic-delivery"),
            "generator": str(Generator.identity),
            "source": str("KotibaCore/ArabicNormaliser.swift — ArabicNormaliser.forDelivery, "
                          + "Orthography.forDelivery"),
            "note": str("""
                Arabic as delivered, every mode. Inside Arabic text (the sentence so far — back to                 the last . ! ? U+061F or newline, a full stop between digits excepted — has at                 least as many Arabic letters as Latin and Cyrillic ones) `,` `;` `?` become                 U+060C U+061B U+061F with no space before and one after when a letter or digit                 follows; a comma between two digits stays. Arabic-Indic U+0660-0669 and Persian                 U+06F0-06F9 digits become 0-9; U+066B and U+066C between digits become . and ,;                 U+066A after a digit becomes %. Tatweel U+0640 is removed. A fatha, damma, kasra                 or sukun (U+064E U+064F U+0650 U+0652) that is the last mark of a word — the next                 non-mark scalar is not an Arabic letter — is removed; tanwin, shadda and every                 mark inside a word stay. Text with no Arabic letter is returned unchanged.
                """),
            "cases": arr(cases),
        ])
    }

    static func capitalise() -> JSONValue {
        let bare = Capitaliser()
        let seeded = Capitaliser(alwaysCapitalised: unionVocabulary)

        let cases = capitaliseSamples.map { sample -> JSONValue in
            let plain = bare.restore(sample.text)
            let withVocabulary = seeded.restore(sample.text)
            var entry: [String: JSONValue] = [
                "in": str(sample.text),
                "origin": str(sample.origin),
                "out": str(plain),
                "outWithVocabulary": str(withVocabulary),
                "idempotent": .bool(bare.restore(plain) == plain),
                "rateIn": num(Capitaliser.sentenceInitialCapitalRate(sample.text)),
                "rateOut": num(Capitaliser.sentenceInitialCapitalRate(plain)),
            ]
            if !sample.exercises.isEmpty { entry["exercises"] = str(sample.exercises) }
            return obj(entry)
        }

        // The composed delivery path, in the order DictationController's `normalise` closure runs
        // it: forDelivery for Uzbek only, then replacements, then the capitaliser — gated on
        // `settings.autoCapitalise && mode.autocapitalizeInsert`. Replacements are empty here;
        // they have their own owner and their own fixture is not this task's.
        //
        // The gate is the whole reason this section exists. `autocapitalizeInsert` shipped
        // `false` on Super, the default-ish mode, and was read by nothing — so it had never once
        // taken effect. The moment it was honoured it mattered enormously: measured over 24 real
        // Uzbek dictations, the Uzbek model emits ALL LOWERCASE, not one capital in 24, while
        // still emitting sentence punctuation. A port that honours a `false` here without also
        // flipping Super's literal to `true` ships every Uzbek dictation entirely in lower case
        // and passes its own tests doing it.
        var pipeline: [JSONValue] = []
        let pipelineTexts = Corpus.textBoundaries.filter { !$0.text.isEmpty }
            + Corpus.transcripts.prefix(24).map { Corpus.Case($0, "real transcript") }
        for probe in pipelineTexts {
            for language in Language.allCases.sorted(by: { $0.rawValue < $1.rawValue }) {
                for autoCapitalise in [true, false] {
                    for modeAllows in [true, false] {
                        var out = probe.text
                        if language == .uzbek { out = UzbekNormaliser.forDelivery(out) }
                        let capitalises = autoCapitalise && modeAllows
                        if capitalises { out = seeded.restore(out, language: language) }
                        pipeline.append(obj([
                            "in": str(probe.text),
                            "language": str(language.rawValue),
                            "autoCapitalise": .bool(autoCapitalise),
                            "modeAutocapitalizeInsert": .bool(modeAllows),
                            "capitaliserRan": .bool(capitalises),
                            "out": str(out),
                        ]))
                    }
                }
            }
        }

        return obj([
            "fixture": str("capitalise"),
            "generator": str(Generator.identity),
            "source": str("KotibaCore/Capitalisation.swift — Capitaliser.restore, "
                          + "Capitaliser.sentenceInitialCapitalRate; composed as in "
                          + "KotibaUI/DictationController.swift's `normalise` closure"),
            "note": str("""
                Restoring capitals to Uzbek ASR output, which is needed because the shipping \
                model emits sentence punctuation in 68.3% of transcripts and capitals in 0.0%. \
                Two traps. The okina is a letter with no uppercase form, so the first letter of \
                `o` + U+02BB + `zbekiston` is the `o` — a naive word-capitaliser that skips \
                non-alphanumerics produces `O` + U+02BB + `Zbekiston`. And a sentence may not \
                BEGIN with U+02BB or U+02BC even though a word may contain one: without that \
                exclusion a leading modifier letter is taken as the sentence's first letter, \
                uppercased to itself, and the real first letter is left lower case.
                """),
            "constants": obj([
                "terminators": arr([".", "!", "?", "\u{2026}", "\u{061F}"].map(str)),
                // D-11. The pipeline and `languageCases` pass the dictation's language: Turkish
                // upper-cases through the `tr` locale (i → İ, ı → I), Arabic is returned as is.
                "languageAware": obj([
                    "tr": str("uppercase and lowercase through the Turkish locale: i↔İ, ı↔I"),
                    "ar": str("no case: restore returns the text unchanged"),
                    "others": str("locale-free, exactly as with no language"),
                ]),
                "skippable": arr([" ", "\n", "\t", "\"", "'", "\u{00AB}", "\u{00BB}", ")", "]",
                                  "\u{2018}", "\u{2019}", "\u{201C}", "\u{201D}"]
                    .sorted(by: scalarOrder).map(str)),
                "modifierLettersThatCannotStartASentence": arr(["\u{02BB}", "\u{02BC}"].map(str)),
                "charactersTreatedAsPartOfAWord": arr(["any Character.isLetter",
                                                       "\u{02BB}", "'"].map(str)),
                "vocabularyIsMatchedLowercased": .bool(true),
                "vocabularySeedIsTheUnionAcrossAllLanguages": .bool(true),
                "capitaliseFirstLetterSkipsLeadingNonLetters": .bool(true),
                "emptyTextRateIsOne": num(Capitaliser.sentenceInitialCapitalRate(""), decimals: 9),
                "neverLowercases": .bool(true),
                "gate": str("settings.autoCapitalise && mode.autocapitalizeInsert"),
            ]),
            "vocabulary": obj(Dictionary(uniqueKeysWithValues: Corpus.vocabularyByLanguage.map {
                ($0.language, arr($0.terms.sorted(by: scalarOrder).map(str)))
            })),
            "vocabularyUnion": arr(unionVocabulary.sorted(by: scalarOrder)
                .map(str)),
            "rateTolerance": str("1e-9"),
            "count": .int(cases.count),
            "cases": arr(cases),
            "languageCount": .int(languageCases.count),
            "languageCases": arr(languageCases),
            "pipelineCount": .int(pipeline.count),
            "pipeline": arr(pipeline),
        ])
    }
}
