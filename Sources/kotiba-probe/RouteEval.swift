import Foundation
import KotibaCore

// `kotiba-probe route-eval` — the key-up routing rule, replayed over transcripts already made.
//
// Routing accuracy needs three things per clip: the detector's Turkic mass over the whole clip,
// Parakeet's transcript of it, and the Uzbek engine's. Producing them is the slow part
// (`detect --prefixes`, `bench --engine parakeet`, `stream`); deciding is instant. So this reads
// one JSON line per clip — {id, lang, tune, mass, pk, uz} — and applies the rule the session
// applies at key-up, through the same KotibaCore functions (`ClusterMass`, `TranscriptCheck`,
// `DictationSession.isUsableRerun`), so the numbers in P2 §2 are this code's, not a Python
// sketch's. `lang` is the truth; `tune` says which half of the split the clip is in.
//
// With `--optional tr,ar` (D-11, C4 §11) the rows also carry the detector's whole posterior
// (`post`), the clip's length (`dur`) and, for Turkish candidates, turbo's `tr` share (`tv`,
// from `detect --full` with the turbo model); the rule is then `TieredRouter.decide` with those
// languages on and `TurkishCheck` for a candidate. `--sweep` prints the Uzbek and Turkish/Arabic
// counts over a grid of the thresholds, for choosing them on the tuning half.
//
// Arabic candidates (C4 §14.1) are settled by the row's `av` (turbo's `ar` share) against
// `ArabicCheck.verifiedFromUnfamiliar`, or `verifiedFrom` with `--arabic-familiar`.
//
//   kotiba-probe route-eval rows.jsonl [--misses] [--optional tr,ar] [--ar-from X]
//                           [--ar-candidate X] [--ar-seconds S] [--ar-verified X] [--arabic-familiar]
//                           [--tr-candidate X] [--tr-verified X] [--tr-seconds S] [--sweep]
//                           [--languages uz,en,ru]
//
// `--languages` replays a user who turned the others off (`LanguageSubset.decide`): the decision
// restricted to those languages, Turkish/Arabic on exactly when listed, and the Uzbek second
// opinion (`TranscriptCheck`) only when Uzbek is. One family left (one language, or en+ru) means
// no detection at all: every clip goes there, labelled by Parakeet's own script for en+ru.

extension Probe {
    struct RouteEvalRow: Decodable {
        var id: String
        var lang: String
        var tune: Bool
        var mass: Double
        var pk: String
        var uz: String?
        var post: [String: Double]?
        var tv: Double?
        var dur: Double?
        /// turbo's `ar` share over the clip (`head`, fit:128, as the session hears it) — for an
        /// Arabic candidate (`ArabicCheck`, C4 §14.1).
        var av: Double?
    }

    struct RouteRule {
        var optional = OptionalLanguageRules()
        var verifiedFrom = TurkishCheck.verifiedFrom
        var arabicVerifiedFrom = ArabicCheck.verifiedFromUnfamiliar
        var languages = LanguageSubset.all

        /// The language the session would settle on for this row.
        func route(_ row: RouteEvalRow, cluster: ClusterMass) -> (Language, doubted: Bool) {
            let r = routeWithAcoustic(row, cluster: cluster)
            return (r.0, r.doubted)
        }

        /// …and the language before any transcript check: the acoustic tier alone (with
        /// Turkish's and Arabic's head checks), for the "acoustic only" column.
        func routeWithAcoustic(_ row: RouteEvalRow, cluster: ClusterMass)
            -> (Language, doubted: Bool, acoustic: Language) {
            let posterior = row.post ?? ["tr": row.mass, "en": 1 - row.mass]
            var decision = languages.decide(posterior, seconds: row.dur ?? 0,
                                            clusterMass: cluster, optional: optional)
            if decision.candidate == .turkish {
                decision = RouteDecision(language: (row.tv ?? 0) >= verifiedFrom ? .turkish : .uzbek,
                                         source: .turkishCheck)
            } else if decision.candidate == .arabic, (row.av ?? 0) >= arabicVerifiedFrom {
                decision = RouteDecision(language: .arabic, source: .arabicCheck)
            }
            guard decision.family == EngineFamily.unified else {
                return (decision.language, false, decision.language)
            }
            // Parakeet's own label (step 4a): Cyrillic is Russian — when Russian is on.
            if decision.source == .only, languages.contains(.russian), languages.contains(.english) {
                // As `ParakeetEngine.writtenLanguage`: the script with more letters.
                let cyrillic = row.pk.unicodeScalars.filter { (0x0400...0x04FF).contains($0.value) }
                let latin = row.pk.unicodeScalars.filter {
                    (0x41...0x5A).contains($0.value) || (0x61...0x7A).contains($0.value) }
                decision = RouteDecision(language: cyrillic.count > latin.count ? .russian : .english,
                                         source: .only)
            }
            guard languages.permits(.uzbek), TranscriptCheck.doubt(row.pk) != nil else {
                return (decision.language, false, decision.language)
            }
            let answer = row.uz ?? ""
            let uzbek = DictationSession.isUsableRerun(answer)
                && !TranscriptCheck.readsAsEnglish(answer)
            return (uzbek ? .uzbek : decision.language, true, decision.language)
        }
    }

    static func routeEval(_ args: [String]) throws {
        if args.contains("--lid") { return try routeEvalLID(args) }
        guard let path = args.first(where: { !$0.hasPrefix("--") && Double($0) == nil
                                             && !$0.contains(",") }) else {
            throw ProbeError.usage("route-eval <rows.jsonl> [--misses] [--optional tr,ar] …")
        }
        let showMisses = args.contains("--misses")
        var rule = RouteRule()
        var enabled: Set<Language> = []
        var i = 0
        while i < args.count {
            func value() -> Double? { i += 1; return Double(args[safe: i] ?? "") }
            switch args[i] {
            case "--optional":
                i += 1
                enabled = Set((args[safe: i] ?? "").split(separator: ",")
                    .compactMap { Language(rawValue: String($0)) })
            case "--languages":
                i += 1
                rule.languages = LanguageSubset((args[safe: i] ?? "").split(separator: ",")
                    .compactMap { Language(rawValue: String($0)) })
                enabled = rule.languages.optional
            case "--ar-from": rule.optional.arabicFrom = value() ?? rule.optional.arabicFrom
            case "--tr-seconds":
                rule.optional.turkishMinimumSeconds = value() ?? rule.optional.turkishMinimumSeconds
            case "--tr-candidate":
                rule.optional.turkishCandidateFrom = value() ?? rule.optional.turkishCandidateFrom
            case "--tr-verified": rule.verifiedFrom = value() ?? rule.verifiedFrom
            // A user who has never dictated Turkish (`TurkishCheck.verifiedFromUnfamiliar`).
            case "--unfamiliar": rule.verifiedFrom = TurkishCheck.verifiedFromUnfamiliar
            // Arabic is measured unfamiliar by default (the stricter bar); `--arabic-familiar`
            // replays a user who has dictated Arabic before (`ArabicCheck.verifiedFrom`).
            case "--arabic-familiar": rule.arabicVerifiedFrom = ArabicCheck.verifiedFrom
            case "--ar-verified": rule.arabicVerifiedFrom = value() ?? rule.arabicVerifiedFrom
            case "--ar-candidate":
                rule.optional.arabicCandidateFrom = value() ?? rule.optional.arabicCandidateFrom
            case "--ar-seconds":
                rule.optional.arabicCandidateMinimumSeconds =
                    value() ?? rule.optional.arabicCandidateMinimumSeconds
            default: break
            }
            i += 1
        }
        rule.optional.enabled = enabled
        let rows = try String(contentsOfFile: path, encoding: .utf8)
            .split(separator: "\n")
            .map { try JSONDecoder().decode(RouteEvalRow.self, from: Data($0.utf8)) }
        let cluster = ClusterMass()

        if args.contains("--sweep") {
            sweep(rows, rule: rule, cluster: cluster)
            return
        }

        struct Tally { var n = 0, wrong = 0, acousticWrong = 0, doubted = 0
                       var to: [String: Int] = [:] }
        var tallies: [String: Tally] = [:]
        // `--matrix`: every set against every language it went to, per half — the confusion
        // matrix, which names Uzbek → Turkish and Turkish → Uzbek separately.
        var matrix: [String: [String: Int]] = [:]
        for row in rows {
            let truth = row.lang == "ard" ? "ar" : row.lang
            let (routed, doubted, acoustic) = rule.routeWithAcoustic(row, cluster: cluster)
            matrix["\(row.tune ? "tune" : "held-out") \(row.lang)", default: [:]][routed.rawValue,
                                                                              default: 0] += 1
            let key = "\(row.tune ? "tune" : "held-out") \(row.lang)"
            var t = tallies[key, default: Tally()]
            t.n += 1
            if routed.rawValue != truth {
                t.wrong += 1
                t.to[routed.rawValue, default: 0] += 1
            }
            // en ↔ ru inside Parakeet is not a misroute (it labels itself, step 4a).
            let sameFamily = EngineFamily(for: acoustic) == .unified
                && (truth == "en" || truth == "ru")
            if acoustic.rawValue != truth, !sameFamily { t.acousticWrong += 1 }
            if doubted { t.doubted += 1 }
            tallies[key] = t
            if showMisses, routed.rawValue != truth {
                print("miss  \(key)  \(row.id) → \(routed.rawValue)  mass "
                      + String(format: "%.3f", row.mass) + "  doubted \(doubted)  "
                      + "tr \(String(format: "%.3f", OptionalLanguageRules.share("tr", of: row.post ?? [:])))  "
                      + "ar \(String(format: "%.3f", OptionalLanguageRules.share("ar", of: row.post ?? [:])))  "
                      + "tv \(row.tv.map { String(format: "%.3f", $0) } ?? "-")  "
                      + "av \(row.av.map { String(format: "%.3f", $0) } ?? "-")  "
                      + "dur \(row.dur.map { String(format: "%.1f", $0) } ?? "-")")
            }
        }
        print("optional languages on: "
              + (enabled.isEmpty ? "none" : enabled.map(\.rawValue).sorted().joined(separator: ","))
              + "; languages on: " + rule.languages.ordered.map(\.rawValue).joined(separator: ","))
        print("set            n   misrouted (this rule)   misrouted (acoustic only)   doubted   went to")
        for key in tallies.keys.sorted() {
            let t = tallies[key]!
            func pct(_ k: Int) -> String { String(format: "%d = %.2f %%", k, Double(k) * 100 / Double(t.n)) }
            print("\(key.padding(toLength: 14, withPad: " ", startingAt: 0)) \(t.n)   "
                  + "\(pct(t.wrong).padding(toLength: 22, withPad: " ", startingAt: 0))  "
                  + "\(pct(t.acousticWrong).padding(toLength: 26, withPad: " ", startingAt: 0))  "
                  + "\(t.doubted)   "
                  + t.to.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }
                    .joined(separator: ", "))
        }
        if args.contains("--matrix") {
            let columns = ["uz", "tr", "en", "ru", "ar"]
            print("\nconfusion (rows: what was said; columns: where it went)")
            print("set".padding(toLength: 16, withPad: " ", startingAt: 0)
                  + columns.map { $0.padding(toLength: 6, withPad: " ", startingAt: 0) }.joined())
            for key in matrix.keys.sorted() {
                print(key.padding(toLength: 16, withPad: " ", startingAt: 0)
                      + columns.map { String(matrix[key]?[$0] ?? 0)
                          .padding(toLength: 6, withPad: " ", startingAt: 0) }.joined())
            }
        }
    }

    /// Uzbek sent elsewhere, and Turkish/Arabic recall, per half, over a threshold grid.
    static func sweep(_ rows: [RouteEvalRow], rule base: RouteRule, cluster: ClusterMass) {
        print("arFrom trSeconds trCand trVerified | uz→other tune/held | tr ok tune/held | "
              + "ar ok tune/held | ard ok tune/held | en/ru→other")
        for arFrom in [0.9, 0.95, 0.975, 0.98] {
            for trSeconds in [0.0, 3, 4, 5, 6] {
                for trCand in [0.8, 0.9] {
                    for trVerified in [0.95, 0.98, 0.99] {
                        var rule = base
                        rule.optional.arabicFrom = arFrom
                        rule.optional.turkishMinimumSeconds = trSeconds
                        rule.optional.turkishCandidateFrom = trCand
                        rule.verifiedFrom = trVerified
                        var c: [String: (tune: Int, held: Int)] = [:]
                        var n: [String: (tune: Int, held: Int)] = [:]
                        for row in rows {
                            let truth = row.lang == "ard" ? "ar" : row.lang
                            let routed = rule.route(row, cluster: cluster).0.rawValue
                            let hit = truth == "uz" || truth == "en" || truth == "ru"
                                ? routed != truth : routed == truth
                            let set = truth == "en" || truth == "ru" ? "enru" : row.lang
                            var v = c[set, default: (0, 0)]
                            var m = n[set, default: (0, 0)]
                            if row.tune { v.tune += hit ? 1 : 0; m.tune += 1 }
                            else { v.held += hit ? 1 : 0; m.held += 1 }
                            c[set] = v
                            n[set] = m
                        }
                        func f(_ k: String) -> String {
                            let v = c[k, default: (0, 0)], m = n[k, default: (0, 0)]
                            return "\(v.tune)/\(m.tune) \(v.held)/\(m.held)"
                        }
                        print(String(format: "%.3f  %.1f  %.2f  %.2f", arFrom, trSeconds, trCand,
                                     trVerified)
                              + " | \(f("uz")) | \(f("tr")) | \(f("ar")) | \(f("ard")) | \(f("enru"))")
                    }
                }
            }
        }
    }
}
