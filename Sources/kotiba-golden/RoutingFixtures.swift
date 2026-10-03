import Foundation
import KotibaCore

// cluster-mass.json, script-check.json and route.json.
//
// Routing is the one bit this app turns on, and 02-BEHAVIOUR §1 says it plainly: a port that
// takes the top language from the detector routes Uzbek to Turkish and looks correct in every
// unit test that does not use real audio. So every number below is produced by calling
// `ClusterMass`, `ScriptCheck` and `TieredRouter` — nothing here is a value someone typed in
// because they expected it.

/// A posterior held as an ordered list of pairs rather than a dictionary literal, so the fixture's
/// own source order is stable. It becomes a `[String: Double]` only at the moment it is handed to
/// `ClusterMass`, which is where the summation-order wobble documented on `num` comes from.
private struct Posterior {
    let name: String
    let pairs: [(String, Double)]
    var map: [String: Double] { Dictionary(uniqueKeysWithValues: pairs) }
    var json: JSONValue {
        obj(Dictionary(uniqueKeysWithValues: pairs.map { ($0.0, num($0.1, decimals: 6)) }))
    }
    init(_ name: String, _ pairs: [(String, Double)]) {
        self.name = name
        self.pairs = pairs
    }
}

private struct FixedClassifier: AcousticClassifier {
    let value: [String: Double]
    func posterior(for audio: AudioBuffer) async -> [String: Double] { value }
}

enum RoutingFixtures {

    // MARK: - cluster-mass.json

    /// Every language code the cluster contains, one at a time, at a probability just over the
    /// threshold — and every code it deliberately does not, at the same probability. A membership
    /// list is only checkable this way: `ug` (Uyghur), `tt` (Tatar) and `ba` (Bashkir) are Turkic
    /// and are *not* in the set, so a port that reached for "the Turkic languages" rather than
    /// copying the seven literal codes changes four decisions here.
    private static let membershipProbes: [Posterior] = {
        let inCluster = ClusterMass.turkicCluster.sorted()
        let outOfCluster = ["ar", "ba", "de", "en", "fa", "id", "ko", "mn", "ru", "tt", "ug", "uk"]
        // Anchored on `ja` rather than `en` so the probe list may itself contain `en` — the
        // membership question is "is this code in the cluster", and `en` has to be asked it too.
        return (inCluster + outOfCluster).map {
            Posterior("single language \($0) at 0.06 against ja 0.94", [($0, 0.06), ("ja", 0.94)])
        }
    }()

    private static let measuredPosteriors: [Posterior] = [
        // The case the whole mechanism exists for. Clean Uzbek: `uz` scores exactly zero.
        Posterior("clean Uzbek, measured — tr 0.63 / az 0.17 / uz 0.00",
                  [("tr", 0.63), ("az", 0.17), ("uz", 0.00), ("en", 0.12), ("ru", 0.08)]),
        // ggml-base on GAP-01 clip 0000: Uzbek heard mostly as Korean, and it still routes right.
        Posterior("GAP-01 clip 0000, ggml-base — heard mostly as Korean",
                  [("ko", 0.159), ("tr", 0.103), ("ar", 0.098), ("en", 0.088), ("de", 0.044),
                   ("id", 0.042), ("az", 0.014)]),
        Posterior("clear English", [("en", 0.94), ("ru", 0.03), ("tr", 0.03)]),
        Posterior("clear English, near-certain", [("en", 0.998)]),
        Posterior("clear Russian", [("ru", 0.88), ("uk", 0.07), ("en", 0.05)]),
        Posterior("clear Russian, near-certain", [("ru", 0.996), ("en", 0.001), ("nn", 0.001)]),
        Posterior("the worst control measured, ru03 at 0.012",
                  [("ru", 0.930), ("tr", 0.008), ("az", 0.004)]),
        Posterior("Tajik — same geography, different family, still in the cluster",
                  [("tg", 0.55), ("en", 0.25), ("ru", 0.20)]),
        // The two English utterances from this user's own diagnostics that routed to Uzbek, and
        // the real Uzbek that did not. 02-BEHAVIOUR: the classes interleave, so no threshold
        // separates them — these four cases are that claim, checkable.
        Posterior("diagnostics: English at cluster mass 0.230, routed to Uzbek",
                  [("en", 0.770), ("tr", 0.230)]),
        Posterior("diagnostics: English at cluster mass 0.119, routed to Uzbek",
                  [("en", 0.881), ("tr", 0.119)]),
        Posterior("diagnostics: real Uzbek at 0.183", [("en", 0.817), ("tr", 0.183)]),
        Posterior("diagnostics: real Uzbek at 0.0122 — this is the silent mis-route",
                  [("ru", 0.9878), ("tr", 0.0122)]),
        // Degenerate inputs. The guard is `total > 0`, not `!posterior.isEmpty`.
        Posterior("empty posterior", []),
        Posterior("all-zero posterior", [("en", 0), ("uz", 0)]),
        Posterior("unnormalised — the rule divides through", [("tr", 63), ("en", 37)]),
        Posterior("unnormalised, large", [("tr", 6300), ("en", 3700)]),
        // Boundary. Integer weights so the ratio is exact in binary and the >= is tested rather
        // than the rounding: 1/20 is 0.05 with no error at all.
        Posterior("exactly at 0.05, exactly representable — 1 against 19",
                  [("tr", 1), ("en", 19)]),
        Posterior("exactly at 0.05 as decimals", [("tr", 0.05), ("en", 0.95)]),
        Posterior("just under 0.05 — 1 against 20", [("tr", 1), ("en", 20)]),
        Posterior("just over 0.05 — 1 against 18", [("tr", 1), ("en", 18)]),
        Posterior("exactly at 0.5 — the abandoned threshold", [("tr", 1), ("en", 1)]),
        Posterior("cluster mass spread across all seven codes",
                  [("uz", 0.01), ("tr", 0.01), ("az", 0.01), ("tk", 0.01), ("kk", 0.01),
                   ("ky", 0.01), ("tg", 0.01), ("en", 0.93)]),
        Posterior("uz alone wins outright", [("uz", 0.99), ("en", 0.01)]),
        Posterior("the whole mass is Turkic", [("tr", 1.0)]),
    ]

    /// 0.05 is the shipped value; 0.5 is what the plan guessed and what anything constructing a
    /// bare `ClusterMass()` used to get; 0.012 is the worst control ever measured, included so a
    /// port can see what setting the threshold at the noise floor would do.
    private static let thresholds: [Double] = [0.012, 0.05, 0.5]

    static func clusterMass() -> JSONValue {
        var cases: [JSONValue] = []
        for posterior in measuredPosteriors + membershipProbes {
            let map = posterior.map
            for threshold in thresholds {
                let cm = ClusterMass(threshold: threshold)
                cases.append(obj([
                    "name": str(posterior.name),
                    "posterior": posterior.json,
                    "threshold": num(threshold, decimals: 6),
                    "mass": num(cm.mass(map)),
                    "isUzbek": .bool(cm.isUzbek(map)),
                ]))
            }
        }
        return obj([
            "fixture": str("cluster-mass"),
            "generator": str(Generator.identity),
            "source": str("KotibaCore/Routing.swift — ClusterMass.mass / ClusterMass.isUzbek"),
            "note": str("""
                Turkic cluster mass, the acoustic tier of the router. The rule is \
                `mass >= threshold`, not `>`: a tie routes to Uzbek on purpose, because the \
                unified engine cannot emit Uzbek at all while the Uzbek engine merely emits \
                English badly. `mass` is the summed probability of the cluster over the total \
                of every entry, and returns 0 for an empty or all-zero posterior rather than \
                dividing by zero.
                """),
            "constants": obj([
                "defaultThreshold": num(ClusterMass.defaultThreshold, decimals: 6),
                "turkicCluster": arr(ClusterMass.turkicCluster.sorted().map(str)),
                "comparison": str(">="),
            ]),
            "massTolerance": str("1e-9"),
            "massToleranceWhy": str("""
                `mass` sums a dictionary's values, and dictionary iteration order differs between \
                processes and between languages, so the last bits of the sum are not portable. \
                Compare `mass` within 1e-9; compare `isUzbek` exactly. No case here sits within \
                1e-9 of its threshold except the two deliberately exact ones, whose ratio is \
                representable with no error at all.
                """),
            "count": .int(cases.count),
            "cases": arr(cases),
        ])
    }

    // MARK: - script-check.json

    /// Uzbek's four Cyrillic letters, and a word carrying each, for building evidence-count
    /// probes. Words are real: `qaranghalady`, `yaqshi`, `ghamyn`, `hop` as the mis-routed
    /// dictation spelled them.
    private static let uzbekCyrillicWords = ["\u{049B}\u{0430}\u{0440}\u{0430}\u{043D}\u{0493}"
                                             + "\u{0430}\u{043B}\u{0430}\u{0434}\u{044B}",  // қаранғалады
                                             "\u{044F}\u{049B}\u{0448}\u{044B}",             // яқшы
                                             "\u{0493}\u{0430}\u{043C}\u{044B}\u{043D}",     // ғамын
                                             "\u{049B}\u{044B}\u{043B}\u{0438}\u{043F}",     // қылип
                                             "\u{0442}\u{044B}\u{043D}\u{044B}\u{049B}",     // тыниқ
                                             "\u{045E}\u{0437}\u{0431}\u{0435}\u{043A}"]     // ўзбек

    private static var scriptTexts: [Corpus.Case] {
        var texts: [Corpus.Case] = [
            // The measured mis-route, verbatim from diagnostics 2026-08-11T11:52:41Z.
            .init("\u{0445}\u{043E}\u{043F} \u{043C}\u{0430}\u{0441}\u{0430}\u{043B}\u{0430}"
                  + "\u{043D} \u{049B}\u{0430}\u{0440}\u{0430}\u{043D}\u{0493}\u{0430}\u{043B}"
                  + "\u{0430}\u{0434}\u{044B} \u{043D}\u{0456}\u{043C}\u{04D9}\u{0434}\u{0435}"
                  + "\u{0439}\u{0441}\u{0430}\u{043C} \u{0493}\u{0430}\u{043C}\u{044B}\u{043D} "
                  + "\u{044F}\u{049B}\u{0448}\u{044B} \u{0442}\u{044B}\u{043D}\u{044B}\u{049B} "
                  + "\u{0447}\u{043E}\u{0442}\u{043A}\u{0435} \u{049B}\u{044B}\u{043B}\u{0438}"
                  + "\u{043F} \u{0435}\u{0437} \u{0431}\u{043E}\u{043B}\u{0430}\u{0434}\u{044B}",
                  "the measured mis-route: 6 letters across 5 distinct words"),
            .init("Marguelan Ceisimbay podcast",
                  "WhisperKit small on a Russian clip — well-formed Latin, no error"),
            .init("\u{041C}\u{0430}\u{0440}\u{0433}\u{0443}\u{043B}\u{0430}\u{043D} \u{0421}"
                  + "\u{0435}\u{0439}\u{0441}\u{0438}\u{043C}\u{0431}\u{0430}\u{0439}",
                  "Cyrillic out of the Uzbek engine is impossible, not surprising"),
            .init("\u{041C}\u{0430}\u{0440}\u{0433}\u{0443}\u{043B}\u{0430}\u{043D}\u{0441}"
                  + "\u{0438}\u{0441}\u{0438}\u{043C}\u{0431}\u{0430}\u{0439}.", "real Russian"),
            .init("\u{0422}\u{0430}\u{043A}, \u{0441}\u{043A}\u{0430}\u{0436}\u{0438} \u{043C}"
                  + "\u{043D}\u{0435} \u{0431}\u{0440}\u{0430}\u{0442}", "real Russian"),
            .init("\u{043D}\u{0443} \u{0447}\u{0451} \u{043F}\u{043E}\u{0439}\u{0434}\u{0451}"
                  + "\u{043C} \u{043D}\u{0430} \u{0442}\u{0440}\u{0435}\u{043D}\u{044C}\u{043A}"
                  + "\u{0443}", "real Russian, ё and ь"),
            // Tashkent Russian: every one of these fired under the first version of the rule.
            .init("\u{0412}\u{0441}\u{0442}\u{0440}\u{0435}\u{0442}\u{0438}\u{043C}\u{0441}"
                  + "\u{044F} \u{043D}\u{0430} \u{0492}\u{0430}\u{0444}\u{0443}\u{0440} \u{0492}"
                  + "\u{0443}\u{043B}\u{043E}\u{043C} \u{0432} \u{0441}\u{0435}\u{043C}\u{044C}",
                  "two Uzbek-Cyrillic words — under the 4-word evidence bar"),
            .init("\u{042F} \u{0436}\u{0438}\u{0432}\u{0443} \u{043D}\u{0430} \u{049A}\u{045E}"
                  + "\u{0439}\u{043B}\u{0438}\u{049B}, \u{0440}\u{044F}\u{0434}\u{043E}\u{043C} "
                  + "\u{0441} \u{041C}\u{0438}\u{0440}\u{0437}\u{043E} \u{0423}\u{043B}\u{0443}"
                  + "\u{0493}\u{0431}\u{0435}\u{043A}",
                  "4 letters, 2 words — more letters than the mis-route, and not a mis-route"),
            .init("\u{041D}\u{04B1}\u{0440}\u{0441}\u{04B1}\u{043B}\u{0442}\u{0430}\u{043D} "
                  + "\u{043F}\u{0440}\u{0438}\u{0435}\u{0445}\u{0430}\u{043B} \u{0438}\u{0437} "
                  + "\u{049A}\u{0430}\u{0437}\u{0430}\u{049B}\u{0441}\u{0442}\u{0430}\u{043D}"
                  + "\u{0430}", "Kazakh letters are not Uzbek letters"),
            .init("\u{041F}\u{043E}\u{0437}\u{0432}\u{043E}\u{043D}\u{0438} \u{04B7}\u{0430}"
                  + "\u{043C}\u{0448}\u{0435}\u{0434}\u{0443} \u{0432} \u{0422}\u{043E}\u{04B7}"
                  + "\u{0438}\u{043A}\u{0438}\u{0441}\u{0442}\u{043E}\u{043D}",
                  "Tajik letters are not Uzbek letters"),
            .init("\u{0426}\u{0435} \u{043D}\u{0435} \u{0440}\u{043E}\u{0441}\u{0456}\u{0439}"
                  + "\u{0441}\u{044C}\u{043A}\u{0430} \u{043C}\u{043E}\u{0432}\u{0430}, \u{0446}"
                  + "\u{0435} \u{041A}\u{0438}\u{0457}\u{0432}",
                  "Ukrainian letters are not Uzbek letters"),
            .init("\u{041A}\u{0430}\u{0440}\u{0430}\u{043A}\u{0430}\u{043B}\u{043F}\u{0430}"
                  + "\u{043A}\u{0441}\u{0442}\u{0430}\u{043D}, \u{041D}\u{04E9}\u{043A}\u{0438}"
                  + "\u{0441}, \u{041C}\u{043E}\u{0439}\u{043D}\u{0430}\u{049B}",
                  "Karakalpak: one qof, one word"),
            .init("\u{0430}\u{0431}\u{0432}\u{0433}\u{0434}\u{0435}\u{0451}\u{0436}\u{0437}"
                  + "\u{0438}\u{0439}\u{043A}\u{043B}\u{043C}\u{043D}\u{043E}\u{043F}\u{0440}"
                  + "\u{0441}\u{0442}\u{0443}\u{0444}\u{0445}\u{0446}\u{0447}\u{0448}\u{0449}"
                  + "\u{044A}\u{044B}\u{044C}\u{044D}\u{044E}\u{044F}",
                  "all 33 Russian lowercase letters count zero"),
            .init("\u{0410}\u{0411}\u{0412}\u{0413}\u{0414}\u{0415}\u{0401}\u{0416}\u{0417}"
                  + "\u{0418}\u{0419}\u{041A}\u{041B}\u{041C}\u{041D}\u{041E}\u{041F}\u{0420}"
                  + "\u{0421}\u{0422}\u{0423}\u{0424}\u{0425}\u{0426}\u{0427}\u{0428}\u{0429}"
                  + "\u{042A}\u{042B}\u{042C}\u{042D}\u{042E}\u{042F}",
                  "and all 33 uppercase — the count lowercases first"),
            .init("\u{04D9}\u{04B1}\u{04AF}\u{04A3}\u{04B7}\u{04E3}\u{0456}\u{0457}\u{0454}"
                  + "\u{0491}", "the wider rule's letters: Kazakh, Tajik, Ukrainian — all zero"),
            .init("\u{045E}\u{045E}", "ў twice"),
            .init("\u{049B}\u{049B}", "қ twice"),
            .init("\u{0493}\u{0493}", "ғ twice"),
            .init("\u{04B3}\u{04B3}", "ҳ twice"),
            .init("\u{040E}\u{049A}\u{0492}\u{04B2}", "the same four uppercase"),
            .init("bugun bozorga bordim, \u{043F}\u{043E}\u{0442}\u{043E}\u{043C} \u{0434}"
                  + "\u{043E}\u{043C}\u{043E}\u{0439}",
                  "a code-switched line is the user's normal register, not an error"),
            .init("xo\u{02BB}p qarang aka, demo akkaunt ochib", "normal Uzbek Latin output"),
            .init("qaranglar edi nima deysan", "Latin is never Uzbek-in-Cyrillic"),
            // Script classification boundaries. ASCII A–Z/a–z only; U+0400–U+04FF only.
            .init("A", "U+0041, the first Latin letter counted"),
            .init("Z", "U+005A, the last"),
            .init("a", "U+0061"),
            .init("z", "U+007A"),
            .init("\u{00C9}\u{00F1}\u{0161}", "accented Latin is NOT Latin here — script neither"),
            .init("\u{02BB}\u{02BC}", "the okina and tutuq are not Latin — script neither"),
            .init("\u{0400}", "U+0400, the first Cyrillic scalar counted"),
            .init("\u{04FF}", "U+04FF, the last"),
            .init("\u{0500}", "U+0500 is Cyrillic Supplement and is NOT counted"),
            .init("\u{03B1}\u{03B2}", "Greek is neither"),
            .init("123 \u{2026}", "digits and an ellipsis are neither"),
            .init("", "empty is neither"),
            .init("salom \u{041C}\u{0430}\u{0440}\u{0433}\u{0443}\u{043B}\u{0430}\u{043D}",
                  "one Latin letter and one Cyrillic letter make it mixed"),
            // D-11: Arabic is a script of its own; Turkish is Latin.
            .init("تشكلت في المحيط الأطلسي عاصفة جديدة.",
                  "Arabic: agrees with an Arabic route and nothing else"),
            .init("مُسَمّاة", "tashkeel marks are not letters, the letters around them are"),
            .init("١٢٣ ، ؛ ؟", "Arabic-Indic digits and Arabic punctuation alone: neither"),
            .init("أرسل الملف على Google Drive", "Arabic with a Latin name: mixed"),
            .init("\u{FEFB}\u{FE8D}", "presentation forms count as Arabic letters"),
            .init("\u{0640}", "tatweel is a letter-shaped mark: Unicode calls it a letter (Lm)"),
            .init("\u{0660}\u{0669}", "U+0660/U+0669 Arabic-Indic digits: neither"),
            .init("\u{0600}", "U+0600, a number sign in the block: neither"),
            .init("\u{06FF}", "U+06FF, the last letter of the block"),
            .init("\u{0750}\u{08A0}", "Arabic Supplement and Extended-A letters"),
            .init("Бу ерда مرحبا", "Cyrillic and Arabic: mixed"),
            .init("İstanbul'a gidiyoruz, çok güzel.", "Turkish: Latin, agrees with a Turkish route"),
            .init("ırmak şimdi öğle", "Turkish letters beyond ASCII still carry ASCII letters"),
            .init("ğüşıöç", "only Turkish letters and no ASCII: neither, like other accented Latin"),
        ]
        // The 4-distinct-word evidence bar, walked from 1 to 6. The mis-route has 5; the worst
        // Russian false positive found has 2; the constant is 4.
        for n in 1...6 {
            let text = uzbekCyrillicWords.prefix(n).joined(separator: " ")
            texts.append(.init(text, "\(n) distinct Uzbek-Cyrillic words — the bar is 4"))
        }
        // Repetition must not read as spread. A confused decoder repeating one word is one word.
        texts.append(.init(String(repeating: uzbekCyrillicWords[0] + " ", count: 8),
                           "the same word eight times is still one distinct word"))
        texts.append(.init(uzbekCyrillicWords.prefix(4).joined(separator: "-"),
                           "hyphens split words: the word splitter breaks on any non-letter"))
        texts.append(.init(uzbekCyrillicWords.prefix(4).joined(separator: "1"),
                           "digits split words too, in THIS splitter — it splits on !isLetter"))
        return texts
    }

    static func scriptCheck() -> JSONValue {
        let cases = scriptTexts.map { probe -> JSONValue in
            let text = probe.text
            var agrees: [String: JSONValue] = [:]
            for language in Language.allCases.sorted(by: { $0.rawValue < $1.rawValue }) {
                agrees[language.rawValue] = .bool(ScriptCheck.agrees(text, with: language))
            }
            return obj([
                "text": str(text),
                "exercises": str(probe.exercises),
                "script": str(ScriptCheck.script(of: text).rawValue),
                "arabicShare": num(ScriptCheck.arabicShare(text)),
                "nonRussianCyrillicCount": .int(ScriptCheck.nonRussianCyrillicCount(text)),
                "uzbekCyrillicWordCount": .int(ScriptCheck.uzbekCyrillicWordCount(text)),
                "looksLikeUzbekInCyrillic": .bool(ScriptCheck.looksLikeUzbekInCyrillic(text)),
                "agreesWith": obj(agrees),
            ])
        }
        return obj([
            "fixture": str("script-check"),
            "generator": str(Generator.identity),
            "source": str("KotibaCore/Routing.swift — ScriptCheck"),
            "note": str("""
                The output-script verifier, which runs after transcription and is the only cheap \
                signal that a route was wrong. Three rules a port gets wrong by being reasonable: \
                only ASCII A-Z/a-z count as Latin and only U+0400-U+04FF as Cyrillic, so \
                `\\p{Script=Latin}` is not a substitute; the evidence is counted in DISTINCT \
                WORDS, not letters, because by letters a Russian sentence naming two Tashkent \
                places looks more Uzbek than the real mis-route; and `agrees` is one-directional \
                per route, never symmetric.
                """),
            "constants": obj([
                "latinRanges": arr([str("U+0041-U+005A"), str("U+0061-U+007A")]),
                "cyrillicRange": str("U+0400-U+04FF"),
                // D-11. Letters only: Unicode alphabetic and not a nonspacing mark, so tashkeel,
                // the Arabic-Indic digits and `، ؛ ؟` in the same blocks count as nothing.
                "arabicRanges": arr(["U+0600-U+06FF", "U+0750-U+077F", "U+08A0-U+08FF",
                                     "U+FB50-U+FDFF", "U+FE70-U+FEFF"].map(str)),
                "arabicLetterRule": str("in an Arabic range, Unicode Alphabetic, and general "
                                        + "category not Mn"),
                "scriptOfTwoOrMoreScripts": str("mixed"),
                "arabicShare": str("Arabic letters / (ASCII Latin + Cyrillic + Arabic letters); "
                                   + "0 when there are none"),
                "uzbekCyrillicLetters": arr(["\u{045E}", "\u{049B}", "\u{0493}", "\u{04B3}"]
                    .sorted().map(str)),
                "uzbekCyrillicEvidenceWords": .int(4),
                "letterCountIsCaseInsensitive": .bool(true),
                "wordSplitter": str("split on !Character.isLetter, then deduplicate through a set"),
            ]),
            "count": .int(cases.count),
            "cases": arr(cases),
        ])
    }

    // MARK: - route.json

    /// Durations that matter, in seconds. 0.5 s and under is where the detector's recall collapses
    /// to 58.4%; 2.8 s and 8.8 s are the two clips D-08 measured beam size on; 10.7 s is the
    /// Uzbek engine's quoted 438 ms figure; 30 s is whisper's window.
    private static let durations: [Double] = [0.25, 0.5, 1.0, 2.0, 2.8, 5.0, 8.8, 10.7, 30.0]

    /// Peak amplitudes around the near-silence gate. 0.0018 is the measured median peak of the
    /// dictations that came back empty; 0.1326 is the median of the ones that worked.
    private static let peaks: [Float] = [0.0, 0.0018, 0.0119, 0.012, 0.0121, 0.1326, 1.0]

    private static func buffer(seconds: Double, peak: Float) -> AudioBuffer {
        AudioBuffer(samples: Array(repeating: peak,
                                   count: Int(seconds * Double(AudioBuffer.sampleRate))))
    }

    /// The transcripts a route is verified against, and what each one is.
    private static var verificationTexts: [Corpus.Case] {
        scriptTexts.filter { !$0.text.isEmpty }
    }

    /// Candidate second answers from the Uzbek engine, for the plausibility gate on recovery.
    private static let rerunCandidates: [Corpus.Case] = [
        .init("xo\u{02BB}p masalan qarangalady, yaxshi tinch", "a real answer — usable"),
        .init("", "empty — not usable"),
        .init("   \n ", "whitespace only — not usable"),
        .init("[BLANK_AUDIO]", "nothing but a bracketed marker — not usable"),
        .init("(music)", "nothing but a parenthesised marker — not usable"),
        .init("[BLANK_AUDIO] salom", "a marker plus a word — usable"),
        .init("\u{041C}\u{0430}\u{0440}\u{0433}\u{0443}\u{043B}\u{0430}\u{043D}",
              "Cyrillic from an engine with zero Cyrillic tokens — not usable"),
        .init("salom salom salom salom salom", "five in a row — still usable"),
        .init("salom salom salom salom salom salom", "six in a row — a repetition loop"),
        .init("salom salom salom salom salom salom salom", "seven — a repetition loop"),
        .init("salom SALOM Salom salom salom salom",
              "case does not break the run: the check lowercases first"),
        .init("do\u{02BB}st do\u{02BB}st do\u{02BB}st do\u{02BB}st do\u{02BB}st do\u{02BB}st",
              "the okina is inside a word for THIS splitter, so six okina words is a loop"),
        .init("bir ikki bir ikki bir ikki bir ikki", "alternating never reaches a run of six"),
    ]

    // MARK: - route.json › optional (D-11)

    /// Posteriors in the shapes C4 §11 measured, for the optional-language rule. Shares are what
    /// the rule reads, so several are integer weights whose share is exact.
    private static let optionalPosteriors: [Posterior] = [
        Posterior("FLEURS Turkish, typical — tr 0.995",
                  [("tr", 0.995), ("az", 0.003), ("en", 0.002)]),
        Posterior("FLEURS Turkish, the lowest measured — tr 0.89, under the candidate floor",
                  [("tr", 0.89), ("az", 0.076), ("en", 0.034)]),
        Posterior("Uzbek heard as Turkish — tr 0.972", [("tr", 0.972), ("az", 0.02), ("uz", 0.008)]),
        Posterior("clean Uzbek, measured — tr 0.63 / az 0.17 / uz 0.00",
                  [("tr", 0.63), ("az", 0.17), ("uz", 0.00), ("en", 0.12), ("ru", 0.08)]),
        Posterior("tr share exactly 0.9 — 9 against 1", [("tr", 9), ("az", 1)]),
        Posterior("tr share just under 0.9 — 89 against 11", [("tr", 89), ("az", 11)]),
        Posterior("FLEURS Arabic, typical — ar 0.998", [("ar", 0.998), ("fa", 0.002)]),
        Posterior("Uzbek prayer formula heard as Arabic — share 0.974, just under (974 : 26)",
                  [("ar", 974), ("tr", 8), ("fa", 6), ("he", 4), ("en", 8)]),
        Posterior("ar share exactly 0.975 — 39 against 1", [("ar", 39), ("fa", 1)]),
        Posterior("Arabic dialect with Turkic mass — ar 0.80, tr 0.15",
                  [("ar", 0.80), ("tr", 0.15), ("en", 0.05)]),
        Posterior("Arabic dialect, strong, with Turkic mass — ar 0.98, tr 0.02",
                  [("ar", 0.98), ("tr", 0.02)]),
        Posterior("clear English", [("en", 0.94), ("ru", 0.03), ("tr", 0.03)]),
        Posterior("clear Russian", [("ru", 0.88), ("uk", 0.07), ("en", 0.05)]),
        // C4 §14.1: the Arabic candidate band, 0.05 <= ar < 0.975, on either base route.
        Posterior("dialect Arabic heard as French — ar 0.40 (an Arabic candidate over unified)",
                  [("ar", 0.40), ("fr", 0.35), ("en", 0.25)]),
        Posterior("ar share exactly 0.05 — 1 against 19", [("ar", 1), ("en", 19)]),
        Posterior("ar share just under 0.05 — 49 against 951", [("ar", 49), ("en", 951)]),
        Posterior("Uzbek with Arabic loanwords — ar 0.30 over the Turkic cluster",
                  [("ar", 0.30), ("tr", 0.50), ("en", 0.20)]),
        Posterior("both candidates possible — tr 0.92, ar 0.08", [("tr", 0.92), ("ar", 0.08)]),
    ]

    /// turbo's language head, as `TurkishCheck` reads it.
    private static let verifierPosteriors: [Posterior] = [
        Posterior("FLEURS Turkish, the lowest measured — tr 0.9946",
                  [("tr", 0.9946), ("az", 0.004), ("en", 0.0014)]),
        Posterior("tr share exactly 0.99 — 99 against 1", [("tr", 99), ("az", 1)]),
        Posterior("just under 0.99 — 98 against 2", [("tr", 98), ("az", 2)]),
        Posterior("tr share exactly 0.995 — 199 against 1", [("tr", 199), ("az", 1)]),
        Posterior("between the two thresholds — tr 0.993", [("tr", 0.993), ("az", 0.007)]),
        Posterior("Uzbek, typical of what turbo gives — tr 0.042", [("tr", 0.042), ("uz", 0.9)]),
        Posterior("Uzbek at tr 0.947", [("tr", 0.947), ("az", 0.03), ("uz", 0.023)]),
        // `ArabicCheck` reads the same head (C4 §14.1).
        Posterior("FLEURS Arabic, typical — ar 0.9999", [("ar", 0.9999), ("fa", 0.0001)]),
        Posterior("ar share exactly 0.98 — 49 against 1", [("ar", 49), ("en", 1)]),
        Posterior("ar share exactly 0.95 — 19 against 1", [("ar", 19), ("en", 1)]),
        Posterior("between the two Arabic thresholds — ar 0.97", [("ar", 0.97), ("en", 0.03)]),
        Posterior("the highest Uzbek of 3.5 s or more — ar 0.861",
                  [("ar", 0.861), ("en", 0.039), ("uz", 0.1)]),
        Posterior("empty posterior", []),
    ]

    static func optionalRouting() -> JSONValue {
        let enabledSets: [[Language]] = [[], [.turkish], [.arabic], [.turkish, .arabic]]
        var decisions: [JSONValue] = []
        for posterior in optionalPosteriors {
            for enabled in enabledSets {
                for seconds in [2.0, 3.49, 3.5, 4.99, 5.0, 12.0] {
                    let rules = OptionalLanguageRules(enabled: Set(enabled))
                    let d = TieredRouter.decide(posterior.map, seconds: seconds,
                                                clusterMass: ClusterMass(), optional: rules)
                    decisions.append(obj([
                        "posteriorName": str(posterior.name),
                        "posterior": posterior.json,
                        "enabled": arr(enabled.map { str($0.rawValue) }),
                        "seconds": num(seconds, decimals: 6),
                        "language": str(d.language.rawValue),
                        "family": str(d.family.rawValue),
                        "source": str(d.source.rawValue),
                        "candidate": d.candidate.map { str($0.rawValue) } ?? .null,
                        "turkicMass": d.turkicMass.map { num($0) } ?? .null,
                        "turkishShare": d.turkishShare.map { num($0) } ?? .null,
                        "arabicShare": d.arabicShare.map { num($0) } ?? .null,
                    ]))
                }
            }
        }
        let checks = verifierPosteriors.map { posterior in
            obj([
                "posteriorName": str(posterior.name),
                "posterior": posterior.json,
                "turkishShare": num(OptionalLanguageRules.share("tr", of: posterior.map)),
                "isTurkish": .bool(TurkishCheck.isTurkish(posterior.map, familiar: true)),
                "isTurkishUnfamiliar": .bool(TurkishCheck.isTurkish(posterior.map,
                                                                    familiar: false)),
                "arabicShare": num(OptionalLanguageRules.share("ar", of: posterior.map)),
                "isArabic": .bool(ArabicCheck.isArabic(posterior.map, familiar: true)),
                "isArabicUnfamiliar": .bool(ArabicCheck.isArabic(posterior.map, familiar: false)),
            ])
        }
        return obj([
            "note": str("""
                Turkish and Arabic, optional dictation languages (D-11). Off, nothing here is                 read and every decision above stands. On: Arabic outright at an `ar` share >=                 arabicFrom (checked before the Turkic cluster); a Turkic recording with a `tr`                 share >= turkishCandidateFrom that is at least turkishMinimumSeconds long is routed                 to Uzbek with candidate `tr`, and key-up asks turbo's language head                 (`TurkishCheck`): Turkish at a `tr` share >= turkishVerifiedFrom (turkishVerifiedFromUnfamiliar                 until the user has dictated Turkish once: isTurkishUnfamiliar), Uzbek otherwise                 (source `turkishCheck` when Turkish), over an encoder window fitted to the audio                 plus turkishHeadMargin positions. Shares are of the whole posterior.                 turkishShare/arabicShare are recorded only when a language is on.                 Arabic candidate (C4 §14.1): under arabicFrom, an `ar` share >= arabicCandidateFrom                 on a recording at least arabicCandidateMinimumSeconds long keeps its base route                 (Uzbek or unified) with candidate `ar` — unless the Turkish candidate rule already                 named `tr` — and the same head settles it (`ArabicCheck`): Arabic at an `ar` share                 >= arabicVerifiedFrom once the user has dictated Arabic (isArabic),                 arabicVerifiedFromUnfamiliar until then (isArabicUnfamiliar), source `arabicCheck`;                 the base route otherwise.
                """),
            "constants": obj([
                "arabicFrom": num(OptionalLanguageRules.defaultArabicFrom, decimals: 6),
                "turkishCandidateFrom": num(OptionalLanguageRules.defaultTurkishCandidateFrom,
                                            decimals: 6),
                "turkishMinimumSeconds": num(OptionalLanguageRules.defaultTurkishMinimumSeconds,
                                             decimals: 6),
                "turkishVerifiedFrom": num(TurkishCheck.verifiedFrom, decimals: 6),
                // …until the user has dictated Turkish once (settings › turkishDictations).
                "turkishVerifiedFromUnfamiliar": num(TurkishCheck.verifiedFromUnfamiliar,
                                                     decimals: 6),
                // The head's encoder window: the audio plus this many positions of silence,
                // rounded up to 256 (`WhisperEngine.AudioContext.fitted`, C4 §13).
                "turkishHeadMargin": .int(TurkishCheck.headMargin),
                "arabicCandidateFrom": num(OptionalLanguageRules.defaultArabicCandidateFrom,
                                           decimals: 6),
                "arabicCandidateMinimumSeconds": num(
                    OptionalLanguageRules.defaultArabicCandidateMinimumSeconds, decimals: 6),
                "arabicVerifiedFrom": num(ArabicCheck.verifiedFrom, decimals: 6),
                // …until the user has dictated Arabic once (settings › arabicDictations).
                "arabicVerifiedFromUnfamiliar": num(ArabicCheck.verifiedFromUnfamiliar,
                                                    decimals: 6),
                "comparisons": str(">= everywhere; seconds is the recording's length"),
                "order": str("pin, then Arabic, then the Turkic cluster (Turkish candidate, else "
                             + "Arabic candidate), then unified (Arabic candidate)"),
            ]),
            "decisionCount": .int(decisions.count),
            "decisions": arr(decisions),
            "turkishCheckCount": .int(checks.count),
            "turkishCheck": arr(checks),
        ])
    }

    /// Every non-empty set of the five languages, in a stable order (by size, then `Language`).
    static let languageSubsets: [[Language]] = {
        let all = Language.allCases
        var sets: [[Language]] = []
        for mask in 1..<(1 << all.count) {
            sets.append(all.enumerated().filter { mask & (1 << $0.offset) != 0 }.map(\.element))
        }
        return sets.sorted { $0.count != $1.count ? $0.count < $1.count
            : $0.map { all.firstIndex(of: $0)! }.lexicographicallyPrecedes(
                $1.map { all.firstIndex(of: $0)! }) }
    }()

    /// `LanguageSubset`: the router restricted to the languages that are on.
    static func languageSubsetRouting() -> JSONValue {
        var decisions: [JSONValue] = []
        for posterior in optionalPosteriors + [
            Posterior("empty posterior", []),
            Posterior("Turkish heard as Azerbaijani — az 0.6, tr 0.3",
                      [("az", 0.6), ("tr", 0.3), ("en", 0.1)]),
        ] {
            for set in languageSubsets {
                let subset = LanguageSubset(set)
                // 5 s: long enough for either candidate rule. `preferring` matters only to
                // `soleRoute` and `fallback`, pinned per set below.
                for seconds in [5.0] {
                    for preferring in [Language.english] {
                        // The optional rules as the app builds them: on for the optional languages
                        // in the set (the app also needs their engine, which is not modelled).
                        let rules = OptionalLanguageRules(enabled: subset.optional)
                        let d = subset.decide(posterior.map, seconds: seconds,
                                              clusterMass: ClusterMass(), optional: rules,
                                              preferring: preferring)
                        decisions.append(obj([
                            "posteriorName": str(posterior.name),
                            "posterior": posterior.json,
                            "languages": arr(set.map { str($0.rawValue) }),
                            "seconds": num(seconds, decimals: 6),
                            "preferring": str(preferring.rawValue),
                            "language": str(d.language.rawValue),
                            "family": str(d.family.rawValue),
                            "source": str(d.source.rawValue),
                            "candidate": d.candidate.map { str($0.rawValue) } ?? .null,
                            "turkicMass": d.turkicMass.map { num($0) } ?? .null,
                            "turkishShare": d.turkishShare.map { num($0) } ?? .null,
                            "arabicShare": d.arabicShare.map { num($0) } ?? .null,
                        ]))
                    }
                }
            }
        }
        let sets = languageSubsets.map { set -> JSONValue in
            let subset = LanguageSubset(set)
            return obj([
                "languages": arr(set.map { str($0.rawValue) }),
                "families": arr(EngineFamily.allCases.filter(subset.families.contains)
                    .map { str($0.rawValue) }),
                "soleRouteEnglish": subset.soleRoute(preferring: .english)
                    .map { str($0.rawValue) } ?? .null,
                "soleRouteRussian": subset.soleRoute(preferring: .russian)
                    .map { str($0.rawValue) } ?? .null,
                "fallbackEnglish": str(subset.fallback(preferring: .english).rawValue),
                "fallbackRussian": str(subset.fallback(preferring: .russian).rawValue),
                "canTurnOff": arr(Language.allCases.filter(subset.canTurnOff)
                    .map { str($0.rawValue) }),
                "keeps": arr(["en", "ru", "ar", "tr", "uz", "az", "kk", "fr", "uk"]
                    .filter(subset.keeps).map { str($0) }),
            ])
        }
        return obj([
            "note": str("""
                LanguageSubset (the per-language on/off): an empty set reads as all five. \
                soleRoute: one family on (one language, or en+ru) means no detection, source \
                `only`, language = the one on, or for en+ru `preferring` when it is en/ru else en. \
                Otherwise the posterior is restricted (codes `keeps` rejects are dropped: en/ru/ar \
                when that language is off, the Turkic cluster when uz and tr are both off; every \
                other code stays) and TieredRouter.decide runs over it with optional rules for \
                the optional languages on; a result outside the set maps: Uzbek route to tr if \
                on, else the unified label, else ar; unified route to the en/ru label that is on, \
                else uz, else ar when arabicShare > turkicMass or tr is off, else tr. The \
                candidate stays only when on and not the route. With all five on it is \
                TieredRouter.decide unchanged.
                """),
            "setCount": .int(sets.count),
            "sets": arr(sets),
            "decisionCount": .int(decisions.count),
            "decisions": arr(decisions),
        ])
    }

    static func route() async -> JSONValue {
        // --- the acoustic tier, at every threshold, with and without a pin ---
        var decisions: [JSONValue] = []
        for posterior in measuredPosteriors {
            let map = posterior.map
            let classifier: (any AcousticClassifier)? = FixedClassifier(value: map)
            for pin in [Language?.none, .english, .russian, .uzbek, .turkish, .arabic] {
                let router = TieredRouter(classifier: classifier,
                                          clusterMass: ClusterMass(),
                                          fallback: .english)
                let d = await router.route(buffer(seconds: 2.0, peak: 0.1326), pin: pin)
                decisions.append(obj([
                    "posteriorName": str(posterior.name),
                    "posterior": posterior.json,
                    "pin": pin.map { str($0.rawValue) } ?? .null,
                    "threshold": num(ClusterMass.defaultThreshold, decimals: 6),
                    "language": str(d.language.rawValue),
                    "family": str(d.family.rawValue),
                    "source": str(d.source.rawValue),
                    "turkicMass": d.turkicMass.map { num($0) } ?? .null,
                ]))
            }
        }
        // No classifier at all, and an empty posterior: both fall back rather than guess, and the
        // fallback language is `AppSettings.defaultLanguage`, not a hard-coded English.
        for fallback in Language.allCases.sorted(by: { $0.rawValue < $1.rawValue }) {
            for (name, classifier) in [("no classifier", (any AcousticClassifier)?.none),
                                       ("empty posterior", FixedClassifier(value: [:]))] {
                let router = TieredRouter(classifier: classifier, fallback: fallback)
                let d = await router.route(buffer(seconds: 2.0, peak: 0.1326), pin: nil)
                decisions.append(obj([
                    "posteriorName": str(name),
                    "posterior": obj([:]),
                    "pin": .null,
                    "fallback": str(fallback.rawValue),
                    "threshold": num(ClusterMass.defaultThreshold, decimals: 6),
                    "language": str(d.language.rawValue),
                    "family": str(d.family.rawValue),
                    "source": str(d.source.rawValue),
                    "turkicMass": d.turkicMass.map { num($0) } ?? .null,
                ]))
            }
        }

        // --- the amplitude gate, which is the duration axis: a buffer's peak decides whether it
        //     ever reaches the router at all, and its duration decides nothing except what the
        //     record says. Both are asserted here because a port that computes duration from a
        //     sample rate other than 16 000 is silently wrong everywhere else too.
        var buffers: [JSONValue] = []
        for seconds in durations {
            for peak in peaks {
                let b = buffer(seconds: seconds, peak: peak)
                buffers.append(obj([
                    "requestedSeconds": num(seconds, decimals: 6),
                    "sampleCount": .int(b.samples.count),
                    "duration": num(b.duration),
                    "peakAmplitude": num(Double(b.peakAmplitude)),
                    "clearsSilenceGate": .bool(b.peakAmplitude >= 0.012),
                ]))
            }
        }
        // Dropped samples: a truncated recording must not read as a complete one.
        for dropped in [0, 1, 16_000, 48_000] {
            let b = AudioBuffer(samples: Array(repeating: 0.1326, count: 32_000),
                                droppedSamples: dropped)
            buffers.append(obj([
                "requestedSeconds": num(2.0, decimals: 6),
                "sampleCount": .int(b.samples.count),
                "duration": num(b.duration),
                "droppedSamples": .int(b.droppedSamples),
                "droppedSeconds": num(b.droppedSeconds),
                "peakAmplitude": num(Double(b.peakAmplitude)),
                "clearsSilenceGate": .bool(b.peakAmplitude >= 0.012),
            ]))
        }

        // --- verification and the recovery path ---
        var verdicts: [JSONValue] = []
        for probe in verificationTexts {
            for language in Language.allCases.sorted(by: { $0.rawValue < $1.rawValue }) {
                for source in [RouteSource.acoustic, .pin, .fallback] {
                    let mass: Double? = source == .pin ? nil : 0.0122
                    let decision = RouteDecision(language: language, source: source,
                                                 turkicMass: mass)
                    let verdict = decision.verify(probe.text)
                    var entry: [String: JSONValue] = [
                        "transcript": str(probe.text),
                        "exercises": str(probe.exercises),
                        "routeLanguage": str(language.rawValue),
                        "routeSource": str(source.rawValue),
                        "turkicMass": mass.map { num($0) } ?? .null,
                    ]
                    switch verdict {
                    case .consistent:
                        entry["verdict"] = str("consistent")
                        entry["observed"] = .null
                        entry["suggests"] = .null
                    case .suspect(let observed, let suggests):
                        entry["verdict"] = str("suspect")
                        entry["observed"] = str(observed.rawValue)
                        entry["suggests"] = str(suggests.rawValue)
                    }
                    // What the session does with that verdict. The four constraints from
                    // DictationSession step 4b, made checkable rather than described.
                    let suspectTowardUzbek: Bool = {
                        if case .suspect(_, let suggests) = verdict {
                            return suggests == .uzbek && language != .uzbek
                        }
                        return false
                    }()
                    let attemptsRecovery = suspectTowardUzbek && source != .pin
                    entry["recovery"] = obj([
                        "attempted": .bool(attemptsRecovery),
                        "blockedByPin": .bool(suspectTowardUzbek && source == .pin),
                        "reTranscribesToward": attemptsRecovery ? str(Language.uzbek.rawValue)
                                                                : .null,
                        "resultingSourceOnSuccess": attemptsRecovery
                            ? str(RouteSource.scriptCheck.rawValue) : .null,
                        "turkicMassOnSuccess": attemptsRecovery
                            ? (mass.map { num($0) } ?? .null) : .null,
                        "deadlineSeconds": .int(10),
                    ])
                    verdicts.append(obj(entry))
                }
            }
        }

        // The second answer's plausibility gate. Handing Russian audio to an Uzbek-only fine-tune
        // is the best way there is to get a repetition loop, and pasting one over a correct
        // Russian transcript is worse than the mis-route it was meant to fix.
        let reruns = rerunCandidates.map { probe in
            obj([
                "secondAnswer": str(probe.text),
                "exercises": str(probe.exercises),
                "isUsable": .bool(DictationSession.isUsableRerun(probe.text)),
            ])
        }

        return obj([
            "fixture": str("route"),
            "generator": str(Generator.identity),
            "source": str("KotibaCore/Routing.swift, KotibaCore/Contracts.swift, "
                          + "KotibaCore/DictationSession.swift"),
            "note": str("""
                The whole route decision, in the order the session takes it: the near-silence gate \
                on the buffer, the three router tiers, the post-transcription script check, and \
                the bounded recovery that check can trigger. Recovery may only ever move toward \
                Uzbek, is never allowed to overrule a pin, must produce a plausible replacement \
                rather than merely a non-empty one, and is bounded by a deadline (10 s, or 0.5 s per \
                second of audio when that is longer) after which the first transcript stands.
                """),
            "constants": obj([
                "sampleRate": .int(AudioBuffer.sampleRate),
                "silenceThreshold": num(0.012, decimals: 6),
                "silenceComparison": str("peakAmplitude >= silenceThreshold"),
                "rerouteDeadlineSeconds": .int(Int(DictationSession.Config().rerouteDeadline
                    .components.seconds)),
                // e20bc66: the ceiling scales with the recording — max(the seconds above, this
                // much per second of audio). A fixed 10 s could never finish a second pass over
                // a long dictation, so the misroute it exists to undo stood every time.
                "rerouteDeadlinePerSecondOfAudio": num(DictationSession.Config()
                    .rerouteDeadlinePerSecond, decimals: 6),
                "rerouteDeadlineRule": str("max(rerouteDeadlineSeconds, audioSeconds * "
                                           + "rerouteDeadlinePerSecondOfAudio)"),
                "polishDeadlineSeconds": .int(8),
                "repetitionRunLimit": .int(6),
                "recoveryDirection": str("uzbek only"),
                "pinIsAbsolute": .bool(true),
                // The sources both ports produce, in the Swift declaration order. `lexicalCheck` (step 4c)
                // is Mac-only until Windows has that step.
                "routeSources": arr([RouteSource.pin, .acoustic, .scriptCheck, .transcriptCheck,
                                     .fallback, .turkishCheck, .arabicCheck, .only, .languageID]
                                    .map { str($0.rawValue) }),
                "engineFamilies": arr(EngineFamily.allCases.map { str($0.rawValue) }),
                "familyForLanguage": obj(Dictionary(uniqueKeysWithValues:
                    Language.allCases.map { ($0.rawValue, str(EngineFamily(for: $0).rawValue)) })),
            ]),
            "massTolerance": str("1e-9"),
            "decisionCount": .int(decisions.count),
            "decisions": arr(decisions),
            "optional": optionalRouting(),
            "languageSubsets": languageSubsetRouting(),
            "bufferCount": .int(buffers.count),
            "buffers": arr(buffers),
            "verdictCount": .int(verdicts.count),
            "verdicts": arr(verdicts),
            "rerunCount": .int(reruns.count),
            "rerunsDerivedBy": str("""
                Invoked: `DictationSession.isUsableRerun` is public, so every row is the return \
                value of the function the session itself calls. (It was internal once, and this \
                section was a verbatim transcription of its body; that seam is gone.)
                """),
            "reruns": arr(reruns),
        ])
    }
}
