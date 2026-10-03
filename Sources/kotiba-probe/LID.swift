import Foundation
import KotibaCore
import KotibaEngines
import KotibaAudio

// `kotiba-probe lid-features rows.jsonl out.jsonl` — every clip's evidence as the language
// decision reads it (P4 §4): the language-ID model's acoustic features and, for each engine's
// transcript of the clip, the transcript features — computed by the shipped KotibaCore code
// (`AcousticEvidence`, `TranscriptEvidence`), so `Scripts/fit-lid.py` fits the model on exactly
// the numbers the app will compute.
//
// A row: {id, set, lang, tune, dur, ecapa: {code: p}, pk, uz, tr, ar} — `pk`, `uz`, `tr`, `ar`
// are Parakeet's, the Uzbek engine's, turbo's (told Turkish) and Cohere's transcripts.

extension Probe {
    struct LIDRow: Codable {
        var id: String
        var set: String
        var lang: String
        var tune: Bool
        var dur: Double
        var ecapa: [String: Double]
        var pk: String?
        var uz: String?
        var tr: String?
        var ar: String?
        /// Parakeet told English (its script filter), for clips where that was run.
        var pken: String?
        var short: Bool?
        /// whisper base's whole posterior and Turkic mass; turbo head's `tr` and `ar` shares —
        /// what the routing before P4 read.
        var post: [String: Double]?
        var mass: Double?
        var tv: Double?
        var av: Double?
    }

    static func lidTranscripts(_ row: LIDRow) -> [(String, TranscriptSource, String)] {
        [("pk", .unified, row.pk), ("uz", .uzbek, row.uz), ("tr", .turkish, row.tr),
         ("ar", .arabic, row.ar)].compactMap { k, s, t in t.map { (k, s, $0) } }
    }

    static func lidFeatures(_ args: [String]) throws {
        guard args.count >= 2 else { throw ProbeError.usage("lid-features <rows.jsonl> <out.jsonl>") }
        let rows = try readLIDRows(args[0])
        var out = ""
        for row in rows {
            var t: [String: [Double]] = [:]
            var raw: [String: [Int]] = [:]
            for (key, _, text) in lidTranscripts(row) {
                let e = TranscriptEvidence.read(text)
                t[key] = e.featureVector
                raw[key] = [e.counted] + e.known + [e.unusable ? 1 : 0]
            }
            let a = AcousticEvidence(posterior: row.ecapa, seconds: row.dur).featureVector
            let line: [String: Any] = ["id": row.id, "set": row.set, "lang": row.lang,
                                       "tune": row.tune, "dur": row.dur, "a": a, "t": t, "raw": raw]
            let data = try JSONSerialization.data(withJSONObject: line, options: [.sortedKeys])
            out += String(decoding: data, as: UTF8.self) + "\n"
        }
        try out.write(toFile: args[1], atomically: true, encoding: .utf8)
        print("lid-features: \(rows.count) rows → \(args[1])")
    }

    static func readLIDRows(_ path: String) throws -> [LIDRow] {
        try String(contentsOfFile: path, encoding: .utf8).split(separator: "\n")
            .map { try JSONDecoder().decode(LIDRow.self, from: Data($0.utf8)) }
    }
}

// MARK: - route-eval --lid: the chain before P4 against the decision after it

extension Probe {
    /// The engine-family transcript of a row: what the session would have in hand after routing
    /// to `language`.
    static func transcript(_ row: LIDRow, for language: Language) -> String {
        switch EngineFamily(for: language) {
        case .unified: return row.pk ?? ""
        case .uzbek: return row.uz ?? ""
        case .turkish: return row.tr ?? ""
        case .arabic: return row.ar ?? ""
        }
    }

    /// Parakeet's own en/ru label (`ParakeetEngine.writtenLanguage`): the script with more letters.
    static func parakeetLabel(_ text: String, else requested: Language) -> Language {
        var latin = 0, cyrillic = 0
        for s in text.unicodeScalars {
            switch s.value {
            case 0x41...0x5A, 0x61...0x7A: latin += 1
            case 0x400...0x4FF: cyrillic += 1
            default: break
            }
        }
        if latin == 0, cyrillic == 0 { return requested }
        return cyrillic > latin ? .russian : .english
    }

    /// Release/1.0's key-up chain, step by step as `DictationSession.finish` runs it (3, 3b, 4a,
    /// 4a″, 4a′, 4b, 4c), over a row's whisper-base posterior, turbo-head shares and the four
    /// engines' transcripts. A first-time user (`TurkishCheck` 0.995, `ArabicCheck` 0.98) unless
    /// told otherwise.
    static func chainBefore(_ row: LIDRow, languages: LanguageSubset, turkishFamiliar: Bool,
                            arabicFamiliar: Bool) -> Language {
        let posterior = row.post ?? [:]
        var optional = OptionalLanguageRules()
        optional.enabled = languages.optional
        var routed = languages.decide(posterior, seconds: row.dur, clusterMass: ClusterMass(),
                                      optional: optional, preferring: .english)
        if routed.source == .only {
            routed = RouteDecision(language: routed.language, source: .only)
        }
        if let candidate = routed.candidate {
            let shares = ["tr": row.tv ?? 0, "ar": row.av ?? 0, "_": max(0, 1 - (row.tv ?? 0) - (row.av ?? 0))]
            let familiar = candidate == .arabic ? arabicFamiliar : turkishFamiliar
            routed = LanguageCheck.verifies(candidate, shares, familiar: familiar)
                ? routed.rerouted(to: candidate, by: LanguageCheck.source(for: candidate))
                : routed.rerouted(to: routed.language, by: routed.source)
        }
        var text = transcript(row, for: routed.language)
        // 4a
        if routed.family == .unified {
            let label = parakeetLabel(text, else: routed.language)
            if label != routed.language, languages.permits(label) {
                routed = routed.rerouted(to: label, by: .scriptCheck)
            }
        }
        // 4a″
        var settledByScript = false
        if routed.language != .arabic, ScriptCheck.script(of: text) == .arabic,
           languages.permits(.arabic) {
            let second = row.ar ?? ""
            if !second.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                text = second
                routed = routed.rerouted(to: .arabic, by: .scriptCheck)
                settledByScript = true
            }
        }
        // 4a′
        if routed.family == .unified, !settledByScript, languages.permits(.uzbek),
           TranscriptCheck.doubt(text) != nil {
            let answer = row.uz ?? ""
            if DictationSession.isUsableRerun(answer), !TranscriptCheck.readsAsEnglish(answer) {
                text = answer
                routed = routed.rerouted(to: .uzbek, by: .transcriptCheck)
            }
        }
        // 4b
        let verdict = routed.verify(text)
        if case .suspect(_, let suggests) = verdict, suggests == .uzbek, routed.language != .uzbek,
           languages.permits(.uzbek), DictationSession.isUsableRerun(row.uz ?? "") {
            text = row.uz ?? ""
            routed = routed.rerouted(to: .uzbek, by: .scriptCheck)
        }
        // 4c
        if case .suspect(_, let suggests) = verdict, suggests == .english,
           routed.language == .uzbek || routed.language == .arabic,
           routed.source != .transcriptCheck, languages.permits(.english),
           DictationSession.isUsableRerun(row.pk ?? "") {
            routed = routed.rerouted(to: .english, by: .lexicalCheck)
        }
        return routed.language
    }
}

extension Probe {
    /// The decision after P4 over one row, as `DictationSession.decideLanguage` makes it: route
    /// on the audio, read the routed engine's transcript, ask further engines while the policy
    /// says so, choose. Returns the language, how many engines beyond the routed one were asked,
    /// and whether Parakeet had to respell.
    static func chainAfter(_ row: LIDRow, policy: LanguagePolicy)
        -> (Language, asked: Int, respelled: Bool) {
        let acoustic = AcousticEvidence(posterior: row.ecapa, seconds: row.dur)
        let routed = policy.route(acoustic).language
        let first = transcript(row, for: routed)
        var written: Set<EngineFamily> = [EngineFamily(for: routed)]
        var evidence = [(routed, TranscriptEvidence.read(first))]
        var ask = policy.consider(acoustic, transcripts: evidence).ask
        var asked = 0
        while let next = ask {
            asked += 1
            let text = transcript(row, for: next)
            if TranscriptEvidence.isUsable(text) { written.insert(EngineFamily(for: next)) }
            evidence.append((next, TranscriptEvidence.read(text)))
            ask = policy.consider(acoustic, transcripts: evidence).ask
        }
        let final = policy.choose(acoustic, transcripts: evidence, deliverable: written).language
        let respelled = EngineFamily(for: final) == .unified
            && LanguagePolicy.respell(row.pk ?? "", as: final)
        return (final, asked, respelled)
    }

    /// `kotiba-probe route-eval --lid rows.jsonl [--languages uz,en,…] [--ask X]
    ///  [--prior uz=600,en=400,…] [--familiar] [--misses]`: the 5 × 5 confusion before P4 (the
    /// chain release/1.0 runs) and after it, per half, for whole recordings and for ≤ 3.5 s.
    static func routeEvalLID(_ args: [String]) throws {
        guard let path = args.first(where: { $0.hasSuffix(".jsonl") }) else {
            throw ProbeError.usage("route-eval --lid <rows.jsonl>")
        }
        var languages = LanguageSubset.all
        var policy = LanguagePolicy(enabled: Set(Language.allCases))
        var familiar = false
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--languages":
                i += 1
                languages = LanguageSubset((args[safe: i] ?? "").split(separator: ",")
                    .compactMap { Language(rawValue: String($0)) })
            case "--ask": i += 1; policy.askFrom = Double(args[safe: i] ?? "") ?? policy.askFrom
            case "--familiar": familiar = true
            case "--prior":
                i += 1
                var counts: [Language: Int] = [:]
                for pair in (args[safe: i] ?? "").split(separator: ",") {
                    let kv = pair.split(separator: "=")
                    if kv.count == 2, let l = Language(rawValue: String(kv[0])), let n = Int(kv[1]) {
                        counts[l] = n
                    }
                }
                policy.prior = LanguagePrior(counts: counts)
            default: break
            }
            i += 1
        }
        policy.enabled = languages.languages
        let rows = try readLIDRows(path)
        let showMisses = args.contains("--misses")
        let order = ["uz", "tr", "ar", "en", "ru"]
        struct Cell { var before: [String: [String: Int]] = [:]; var after: [String: [String: Int]] = [:]
                      var n = 0, asked = 0, respelled = 0 }
        var cells: [String: Cell] = [:]
        for row in rows where languages.contains(Language(rawValue: row.lang) ?? .english) {
            let truth = row.lang
            let before = chainBefore(row, languages: languages, turkishFamiliar: familiar,
                                     arabicFamiliar: familiar).rawValue
            let (after, asked, respelled) = chainAfter(row, policy: policy)
            let half = row.tune ? "tune" : "held"
            let bucket = row.dur <= 3.5 ? "short" : "long"
            for key in ["\(half) all", "\(half) \(bucket)", "\(half) set:\(row.set)"] {
                var c = cells[key, default: Cell()]
                c.before[truth, default: [:]][before, default: 0] += 1
                c.after[truth, default: [:]][after.rawValue, default: 0] += 1
                c.n += 1
                c.asked += asked > 0 ? 1 : 0
                c.respelled += respelled ? 1 : 0
                cells[key] = c
            }
            if showMisses, after.rawValue != truth || before != truth {
                print("\(row.tune ? "tune" : "held") \(row.set) \(row.id) \(truth): before \(before) after \(after.rawValue) asked \(asked) dur \(String(format: "%.1f", row.dur))")
            }
        }
        func table(_ m: [String: [String: Int]]) -> String {
            var s = "        " + order.map { $0.padding(toLength: 7, withPad: " ", startingAt: 0) }.joined() + "  off-diag\n"
            for t in order {
                guard let r = m[t] else { continue }
                let n = r.values.reduce(0, +)
                let off = n - (r[t] ?? 0)
                s += "  \(t) → " + order.map { String(r[$0] ?? 0).padding(toLength: 7, withPad: " ", startingAt: 0) }.joined()
                    + String(format: "  %d/%d = %.2f %%", off, n, Double(off) * 100 / Double(max(n, 1))) + "\n"
            }
            return s
        }
        print("languages on: \(languages.ordered.map(\.rawValue).joined(separator: ",")); ask from \(policy.askFrom); prior \(policy.prior.counts.map { "\($0.key.rawValue)=\($0.value)" }.sorted().joined(separator: ","))")
        for key in cells.keys.sorted() where !key.contains("set:") || args.contains("--sets") {
            let c = cells[key]!
            print("\n== \(key)  n=\(c.n)  second opinions \(c.asked) (\(String(format: "%.1f", Double(c.asked) * 100 / Double(max(c.n, 1)))) %)  respelled \(c.respelled)")
            print("before (release/1.0 chain):\n" + table(c.before))
            print("after (P4 decision):\n" + table(c.after))
        }
    }
}

extension Probe {
    /// `kotiba-probe ecapa --model EcapaLID.mlmodel --list L --jsonl O [--prefixes 3,0]`: the
    /// language-ID model as the app runs it (Core ML, CPU), per clip: the five languages' and the
    /// top classes' probabilities and the milliseconds it took (P4 §2).
    static func ecapa(_ args: [String]) async throws {
        var model: String?, list: String?, out: String?
        var prefixes: [Double] = [0]
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--model": i += 1; model = args[safe: i]
            case "--list": i += 1; list = args[safe: i]
            case "--jsonl": i += 1; out = args[safe: i]
            case "--prefixes":
                i += 1; prefixes = (args[safe: i] ?? "0").split(separator: ",").compactMap { Double($0) }
            default: break
            }
            i += 1
        }
        guard let model, let list, let out else {
            throw ProbeError.usage("ecapa --model M --list L --jsonl O [--prefixes 3,0]")
        }
        let lid = EcapaLanguageIdentifier(modelURL: URL(fileURLWithPath: model))
        let t0 = Date()
        try await lid.prepare()
        print("ecapa: loaded in \(Int(Date().timeIntervalSince(t0) * 1000)) ms")
        let paths = try String(contentsOfFile: list, encoding: .utf8).split(separator: "\n").map(String.init)
        var lines = ""
        for path in paths where !path.isEmpty {
            let samples = try WAVFile(contentsOf: URL(fileURLWithPath: path)).resampledTo16k()
            var rows: [[String: Any]] = []
            for prefix in prefixes {
                let n = prefix == 0 ? samples.count : min(samples.count, Int(prefix * 16_000))
                let t = Date()
                let posterior = await lid.posterior(for: AudioBuffer(samples: Array(samples.prefix(n))))
                let ms = Date().timeIntervalSince(t) * 1000
                let top = posterior.sorted { $0.value > $1.value }.prefix(12)
                var kept: [String: Double] = [:]
                for (k, v) in top { kept[k] = v }
                for code in ["uz", "tr", "ar", "en", "ru"] { kept[code] = posterior[code] ?? 0 }
                rows.append(["crop": prefix, "ms": ms, "posterior": kept])
            }
            let line: [String: Any] = ["path": path, "dur": Double(samples.count) / 16_000, "rows": rows]
            lines += String(decoding: try JSONSerialization.data(withJSONObject: line), as: UTF8.self) + "\n"
        }
        try lines.write(toFile: out, atomically: true, encoding: .utf8)
        print("ecapa: \(paths.count) clips → \(out)")
    }
}

extension Probe {
    /// `kotiba-probe vad --model ggml-silero.bin --list L --jsonl O`: seconds of speech per clip by
    /// the app's own speech detector (Silero, frames ≥ 0.5) — which 1–3 s crops are dictations at
    /// all (P4 §1: a crop cut from a recording's silent start is not one).
    static func vad(_ args: [String]) throws {
        var model: String?, list: String?, out: String?
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--model": i += 1; model = args[safe: i]
            case "--list": i += 1; list = args[safe: i]
            case "--jsonl": i += 1; out = args[safe: i]
            default: break
            }
            i += 1
        }
        guard let model, let list, let out,
              let silero = SileroSpeechDetector(modelURL: URL(fileURLWithPath: model)) else {
            throw ProbeError.usage("vad --model SILERO --list L --jsonl O")
        }
        var lines = ""
        for path in try String(contentsOfFile: list, encoding: .utf8).split(separator: "\n") {
            let samples = try WAVFile(contentsOf: URL(fileURLWithPath: String(path))).resampledTo16k()
            silero.reset()
            let p = silero.probabilities(samples[...])
            let speech = Double(p.filter { $0 >= 0.5 }.count * silero.frameSamples) / 16_000
            let line: [String: Any] = ["path": String(path), "speech": speech,
                                       "dur": Double(samples.count) / 16_000]
            lines += String(decoding: try JSONSerialization.data(withJSONObject: line), as: UTF8.self) + "\n"
        }
        try lines.write(toFile: out, atomically: true, encoding: .utf8)
    }
}
