import Foundation
import KotibaCore

// language-id.json — the language decision of P4 (D-14): the word lists and their fold, what a
// transcript reads as (`TranscriptEvidence`), what a posterior becomes (`AcousticEvidence`), the
// prior, the fitted weights, and the policy's answers over synthetic evidence. A port must
// reproduce every number: the decision is a measured classifier, and a quietly different fold or
// weight is a quietly different router.
//
// Every text here was written for this fixture (no dictation, no corpus line). The posteriors
// are synthetic: the five languages' shares and a remainder, as the language-ID model writes them.

enum LanguageIDFixtures {

    private static let folds: [(String, Language)] = [
        ("Oʻzbekiston", .uzbek), ("o‘zbek", .uzbek), ("g`alaba", .uzbek), ("XOʼP", .uzbek),
        ("İstanbul", .turkish), ("ISIK", .turkish), ("ıslak", .turkish), ("Çiçek", .turkish),
        ("Ёлка", .russian), ("ЁЖИК", .russian), ("Привет", .russian),
        ("أَيُّهَا", .arabic), ("مدرسة", .arabic), ("إلى", .arabic), ("آمنت", .arabic),
        ("ٱلرَّحْمَٰنِ", .arabic), ("كـــتاب", .arabic), ("Hello", .english),
    ]

    private static let lookups: [(String, Language)] = [
        ("yaxshimi", .uzbek), ("Oʻzbekiston", .uzbek), ("bo'ladi", .uzbek), ("qalaysan", .uzbek),
        ("tavbatannasuha", .uzbek), ("ayyuhannasut", .uzbek), ("the", .uzbek),
        ("nasılsın", .turkish), ("NASILSIN", .turkish), ("güzel", .turkish), ("abijim", .turkish),
        ("унижение", .russian), ("ёлка", .russian), ("инсайд", .russian), ("виджетс", .russian),
        ("зе", .russian), ("контент", .russian),
        ("السلام", .arabic), ("الله", .arabic), ("أيها", .arabic), ("باقة", .arabic),
        ("folder", .english), ("widgets", .english), ("yaxshi", .english),
    ]

    private static let texts: [(String, String)] = [
        ("Inside the content folder.", "English"),
        ("Инсайд зе контент фоль.", "English transliterated into Cyrillic"),
        ("Зе виджетс оф.", "English transliterated, short"),
        ("Я не могу найти ключи, позвони мне вечером.", "Russian"),
        ("assalomu alaykum, do'stlar, qalaysizlar, ahvollar yaxshimi?", "Uzbek greeting"),
        ("ya ayyuhannas tubu ilallohi tavbatan nasuha", "Arabic transliterated into Uzbek spelling"),
        ("bugun bozorga bordim va non oldim.", "Uzbek"),
        ("nasilsin abicim bugun hava cok guzel", "Turkish without its letters"),
        ("Nasılsın, abicim? Bugün hava çok güzel.", "Turkish"),
        ("يا أيها الناس توبوا إلى الله توبة نصوحا", "Arabic"),
        ("﴿ يَا أَيُّهَا النَّاسُ ﴾", "Arabic with tashkeel and ornate brackets"),
        ("باقة باقة باقة باقة باقة باقة باقة", "a repetition loop"),
        ("Send it to Gonka on the 1st, um, okay.", "proper noun, number suffix, hesitation"),
        ("Uh.", "only a hesitation"),
        ("", "empty"),
        ("[BLANK_AUDIO]", "a marker only"),
        ("Morvalen tikoshar penduvi.", "made-up Latin"),
        ("first send all the files, keyin ko'ramiz", "code-switched"),
    ]

    /// (description, posterior, seconds)
    private static let acoustics: [(String, [String: Double], Double)] = [
        ("clear English", ["en": 0.97, "ru": 0.01, "uz": 0.005, "_": 0.015], 3.2),
        ("clear Uzbek", ["uz": 0.92, "tr": 0.04, "ar": 0.01, "_": 0.03], 4.1),
        ("Uzbek heard as Turkish", ["uz": 0.35, "tr": 0.55, "az": 0.05, "_": 0.05], 2.5),
        ("Arabic, half-heard", ["ar": 0.55, "uz": 0.25, "en": 0.1, "fa": 0.05, "_": 0.05], 2.8),
        ("English or Russian", ["en": 0.5, "ru": 0.45, "_": 0.05], 1.6),
        ("nothing of the five", ["fa": 0.6, "ur": 0.3, "_": 0.1], 5.0),
        ("a short Turkish phrase", ["tr": 0.8, "uz": 0.12, "az": 0.05, "_": 0.03], 3.3),
        ("empty", [:], 1.0),
    ]

    private static let priors: [(String, LanguagePrior)] = [
        ("new user", LanguagePrior()),
        ("dictates Uzbek, English, some Arabic", LanguagePrior(counts: [
            .uzbek: 600, .english: 400, .arabic: 11, .russian: 10])),
    ]

    private static let enabledSets: [[Language]] = [
        Language.allCases, [.uzbek, .english, .russian], [.uzbek, .english], [.english, .russian],
        [.uzbek, .turkish, .arabic], [.uzbek, .arabic, .english],
    ]

    private static func codes(_ set: [Language]) -> JSONValue {
        arr(LanguageModel.order.filter(set.contains).map { str($0.rawValue) })
    }

    private static func posterior(_ d: LanguageDecision) -> JSONValue {
        obj(Dictionary(uniqueKeysWithValues: d.posterior.map { ($0.key.rawValue, num($0.value, decimals: 6)) }))
    }

    private static func vector(_ v: [Double]) -> JSONValue { arr(v.map { num($0, decimals: 6) }) }

    static func all() -> JSONValue {
        let model = LanguageModel.fitted
        let foldCases = folds.map { word, language in
            obj(["word": str(word), "language": str(language.rawValue),
                 "folded": str(Lexicon.fold(word, for: language))])
        }
        let lookupCases = lookups.map { word, language in
            obj(["word": str(word), "language": str(language.rawValue),
                 "contains": .bool(Lexicon.contains(word, language))])
        }
        let evidence = texts.map { text, what in
            let e = TranscriptEvidence.read(text)
            return obj(["text": str(text), "exercises": str(what), "counted": .int(e.counted),
                        "known": arr(e.known.map { .int($0) }), "unusable": .bool(e.unusable),
                        "features": vector(e.featureVector)])
        }
        let acoustic = acoustics.map { what, p, seconds in
            obj(["exercises": str(what),
                 "posterior": obj(Dictionary(uniqueKeysWithValues: p.map { ($0.key, num($0.value, decimals: 6)) })),
                 "seconds": num(seconds, decimals: 3),
                 "features": vector(AcousticEvidence(posterior: p, seconds: seconds).featureVector)])
        }
        let prior = priors.flatMap { what, prior in
            enabledSets.map { set in
                obj(["prior": str(what), "counts": obj(Dictionary(uniqueKeysWithValues: prior.counts.map {
                        ($0.key.rawValue, JSONValue.int($0.value)) })),
                     "enabled": codes(set),
                     "logPrior": obj(Dictionary(uniqueKeysWithValues: set.map {
                        ($0.rawValue, num(prior.logPrior($0, among: Set(set)), decimals: 6)) }))])
            }
        }
        // The policy over every acoustic case × a routed transcript × a second engine's.
        // (description, acoustic case, routed language, routed transcript, the asked engine's
        // transcript, by index into `texts`).
        let scenarios: [(String, Int, Language, Int, Int)] = [
            ("English heard; Parakeet transliterated it", 4, .russian, 1, 6),
            ("English heard; Parakeet wrote English", 0, .english, 0, 6),
            ("Arabic half-heard; Parakeet doubts; the Uzbek engine transliterates", 3, .english, 16, 5),
            ("Arabic half-heard on Uzbek; Cohere's answer is Arabic", 3, .uzbek, 5, 9),
            ("Uzbek heard as Turkish; Uzbek is asked", 2, .turkish, 8, 6),
            ("a short Turkish phrase; the Uzbek engine wrote it", 6, .uzbek, 7, 8),
            ("clear Uzbek greeting", 1, .uzbek, 4, 0),
            ("nothing of the five; empty transcript", 5, .english, 14, 6),
            ("no acoustic evidence", 7, .english, 1, 4),
        ]
        var decisions: [JSONValue] = []
        for set in enabledSets {
            for (what, prior) in priors {
                for (description, ai, routedLanguage, ti, si) in scenarios {
                    let (_, p, seconds) = acoustics[ai]
                    let a: AcousticEvidence? = p.isEmpty ? nil : AcousticEvidence(posterior: p, seconds: seconds)
                    let policy = LanguagePolicy(model: model, prior: prior, enabled: Set(set))
                    let route = policy.route(a)
                    let routed = set.contains(routedLanguage) ? routedLanguage : route.language
                    let firstText = texts[ti].0
                    let first = TranscriptEvidence.read(firstText)
                    let (after, ask) = policy.consider(a, transcripts: [(routed, first)])
                    var entry: [String: JSONValue] = [
                        "scenario": str(description), "prior": str(what), "enabled": codes(set),
                        "acoustic": .int(ai), "routed": str(routed.rawValue), "firstText": .int(ti),
                        "route": posterior(route), "routeLanguage": str(route.language.rawValue),
                        "afterFirst": posterior(after), "afterFirstLanguage": str(after.language.rawValue),
                        "ask": ask.map { str($0.rawValue) } ?? .null,
                        "respell": .bool(LanguagePolicy.respell(firstText, as: after.language)),
                        "chooseFirst": posterior(policy.choose(a, transcripts: [(routed, first)])),
                    ]
                    if let ask {
                        let second = TranscriptEvidence.read(texts[si].0)
                        let both = [(routed, first), (ask, second)]
                        let (again, third) = policy.consider(a, transcripts: both)
                        let chosen = policy.choose(a, transcripts: both)
                        entry["secondText"] = .int(si)
                        entry["afterSecond"] = posterior(again)
                        entry["thirdAsk"] = third.map { str($0.rawValue) } ?? .null
                        entry["choose"] = posterior(chosen)
                        entry["chooseLanguage"] = str(chosen.language.rawValue)
                        entry["chooseRoutedOnly"] = posterior(policy.choose(
                            a, transcripts: both, deliverable: [EngineFamily(for: routed)]))
                    }
                    decisions.append(obj(entry))
                }
            }
        }
        return obj([
            "fixture": str("language-id"),
            "generator": str(Generator.identity),
            "source": str("KotibaCore/Lexicon.swift, LanguageID.swift, LanguageModelWeights.swift"),
            "note": str("""
                The language decision (P4, D-14). Fold: ' for U+2019 U+2018 U+02BB U+02BC and `; \
                Turkish U+0130, I and U+0131 -> i; Russian U+0451/U+0401 -> U+0435; Arabic drops \
                U+0610-061A U+064B-065F U+0670 U+06D6-06ED U+0640 and maps U+0623 U+0625 U+0622 \
                U+0671 -> U+0627, U+0649 -> U+064A, U+0629 -> U+0647; then lowercase. English is \
                TranscriptCheck.isEnglishWord. Transcript words and what is counted are \
                TranscriptCheck's (see transcript-check.json); known[i] counts the counted words \
                each list holds, in model order uz tr ar en ru. features: per list log1p(known), \
                log1p(counted - known), then unusable (empty, markers only, or six of one word in \
                a row). Acoustic features: log of each of the five shares of the posterior's total \
                then of the rest, floored at log(1e-5), then log(max(seconds, 0.25)). Score = \
                acoustic weights . [features, 1] + for each transcript its source's weights . its \
                features + logPrior; posterior = softmax over the enabled languages (empty set = \
                all). Ties rank in model order. consider(transcripts): the posterior over the \
                enabled languages with every transcript added; ask = the most likely language of a \
                family no transcript came from, when those families hold >= askFrom and fewer than \
                maxEngines families have written. choose(transcripts, deliverable): the same score \
                over the enabled languages of the deliverable families only (default: every \
                family that wrote). respell: unified \
                language, and more Cyrillic than Latin letters (A-Z a-z vs U+0400-04FF) for \
                English, or the reverse for Russian.
                """),
            "constants": obj([
                "askFrom": num(LanguagePolicy.defaultAskFrom, decimals: 6),
                "maxEngines": .int(LanguagePolicy.defaultMaxEngines),
                "priorWeight": num(LanguagePrior.weight, decimals: 6),
                "priorSmoothing": num(LanguagePrior.smoothing, decimals: 6),
                "order": arr(LanguageModel.order.map { str($0.rawValue) }),
            ]),
            "lists": obj(Dictionary(uniqueKeysWithValues: Language.allCases.map {
                ($0.rawValue, obj(["count": .int(Lexicon.counts[$0] ?? 0),
                                   "sha256": str(Lexicon.sha256[$0] ?? "")]))
            })),
            "weights": obj([
                "acoustic": arr(model.acoustic.map(vector)),
                "transcript": arr(model.transcript.map { arr($0.map(vector)) }),
            ]),
            "folds": arr(foldCases),
            "lookups": arr(lookupCases),
            "evidence": arr(evidence),
            "acousticEvidence": arr(acoustic),
            "prior": arr(prior),
            "decisions": arr(decisions),
        ])
    }
}
