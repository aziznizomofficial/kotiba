import Foundation

// MARK: - The language decision (P4, D-14)
//
// One calibrated decision over the languages that are on, from every piece of evidence the
// dictation has produced — instead of a chain of one-directional checks, each with its own
// threshold, each able to send speech to only one other language:
//
//   * what the audio sounds like: a dedicated language-ID model (`AcousticEvidence`, SpeechBrain's
//     VoxLingua107 ECAPA-TDNN — 107 languages, Uzbek among them as a class of its own);
//   * what each engine that ran wrote, read against every language's word list
//     (`TranscriptEvidence`): the Uzbek engine writing Arabic speech as Latin transliteration is
//     mostly unknown Uzbek words; Parakeet writing English as Cyrillic is no Russian at all;
//   * how often this user dictates each language (`LanguagePrior`) — a prior, never a wall.
//
// They add up as log-odds (`LanguageModel`, a multinomial logistic model fitted on the tuning
// halves, P4 §4) and the decision is a posterior over the enabled languages: the route is its
// top language; when the transcript the route produced pulls the other way, or the top is not
// sure, the runner-up's engine is asked too and the decision is made again with both transcripts
// in (`LanguageDecision.needsSecondOpinion`). The same function decides for every language, in
// every direction — no step can only ever point at Uzbek.

// MARK: Acoustic evidence

/// What the language-ID model heard: its log-posterior for each of the five languages and for
/// everything else, and how long the audio was.
public struct AcousticEvidence: Sendable, Equatable, Codable {
    /// log p(language) in `LanguageModel.order` order, then log p(none of the five).
    public var logProbabilities: [Double]
    public var seconds: Double

    /// Floor for a log-probability: the model's own posteriors go down to 1e-30, and nothing
    /// below about 1e-5 is evidence of anything but how sure it was elsewhere.
    public static let floor = log(1e-5)

    public init(posterior: [String: Double], seconds: Double) {
        let total = posterior.values.reduce(0, +)
        func lp(_ p: Double) -> Double { max(Self.floor, log(max(p, 0))) }
        guard total > 0 else {
            logProbabilities = Array(repeating: Self.floor, count: 6)
            self.seconds = seconds
            return
        }
        let five = LanguageModel.order.map { (posterior[$0.rawValue] ?? 0) / total }
        logProbabilities = five.map(lp) + [lp(1 - five.reduce(0, +))]
        self.seconds = seconds
    }

    public init(logProbabilities: [Double], seconds: Double) {
        self.logProbabilities = logProbabilities
        self.seconds = seconds
    }

    /// The features the model reads: the six log-probabilities and log seconds.
    public var featureVector: [Double] { logProbabilities + [log(max(seconds, 0.25))] }
}

// MARK: Transcript evidence

/// One transcript, read against every language's word list. Counts only: what they mean depends
/// on which engine wrote the text, and that is the model's business (`LanguageModel`).
public struct TranscriptEvidence: Sendable, Equatable, Codable {
    /// Words the lists can judge: not a proper noun or an acronym (a capital anywhere but a
    /// sentence's first letter), not a number's suffix, not a hesitation — `TranscriptCheck`'s
    /// rule. Hesitations count only when they are all there is.
    public var counted = 0
    /// Of `counted`, how many each list knows, in `LanguageModel.order` order.
    public var known: [Int] = [0, 0, 0, 0, 0]
    /// A repetition loop, a bare marker, or nothing: what an engine writes for speech it cannot
    /// read (`DictationSession.isUsableRerun`, without its Cyrillic rule).
    public var unusable = false

    public init() {}

    public init(counted: Int, known: [Int], unusable: Bool) {
        self.counted = counted
        self.known = known
        self.unusable = unusable
    }

    public static func read(_ text: String) -> TranscriptEvidence {
        var evidence = TranscriptEvidence()
        var hesitations: [String] = []
        for (word, startsSentence, afterDigit) in TranscriptCheck.words(scalarsOf: text) {
            if afterDigit { continue }
            let scalars = word.unicodeScalars
            if scalars.dropFirst().contains(where: { $0.properties.isUppercase }) { continue }
            if let first = scalars.first, first.properties.isUppercase, !startsSentence,
               word != "I" { continue }
            let lower = word.lowercased()
            if TranscriptCheck.hesitations.contains(lower) {
                hesitations.append(word)
                continue
            }
            evidence.count(word)
        }
        if evidence.counted == 0 { for word in hesitations { evidence.count(word) } }
        evidence.unusable = !isUsable(text)
        return evidence
    }

    private mutating func count(_ word: String) {
        counted += 1
        for (i, language) in LanguageModel.order.enumerated() where Lexicon.contains(word, language) {
            known[i] += 1
        }
    }

    /// `DictationSession.isUsableRerun`, minus "Cyrillic is unusable", which was a rule about the
    /// Uzbek engine only. Here an empty text is unusable too.
    public static func isUsable(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let withoutMarkers = trimmed
            .replacingOccurrences(of: "\\[[^\\]]*\\]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\([^)]*\\)", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !withoutMarkers.isEmpty else { return false }
        let words = withoutMarkers.lowercased()
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "\u{02BB}" })
        var run = 1
        for (previous, current) in zip(words, words.dropFirst()) {
            run = previous == current ? run + 1 : 1
            if run >= 6 { return false }
        }
        return true
    }

    /// The features the model reads for one transcript: per list, log(1 + known) and
    /// log(1 + not known), then unusable. Logarithms because word evidence is not independent —
    /// the tenth unknown word of a transliteration says less than the first — and a 30 s
    /// dictation must not outvote the audio by its length alone.
    public var featureVector: [Double] {
        known.flatMap { [log1p(Double($0)), log1p(Double(counted - $0))] } + [unusable ? 1 : 0]
    }
}

// MARK: The user's own history

/// How often this user has dictated each language — a soft prior over the enabled ones.
///
/// `weight` × log of the user's share of each language, smoothed so a language they have never
/// used keeps a real chance: with 600 Uzbek, 400 English, 11 Arabic and no Turkish dictations the
/// spread from Uzbek to Turkish is 0.25 × log(620 / 20) = 0.86 nats — enough to keep a 2 s Uzbek
/// dictation the audio half-hears as Turkish in Uzbek, not enough to keep a clear Turkish one
/// out (P4 §5: held out, P2 Uzbek elsewhere 15 → 12 of 401 for such a user; short Turkish clips
/// 25 → 37 of 400 to Uzbek, against 400 of 400 before P4). A new user gets a flat prior.
public struct LanguagePrior: Sendable, Equatable, Codable {
    /// Dictations per language (any route, pins included) — `AppSettings.languageCounts`.
    public var counts: [Language: Int]
    public static let weight = 0.25
    /// Pseudo-dictations each enabled language starts with.
    public static let smoothing = 20.0

    public init(counts: [Language: Int] = [:]) { self.counts = counts }

    /// log-prior per enabled language, in nats, up to a constant.
    public func logPrior(_ language: Language, among enabled: Set<Language>) -> Double {
        let total = enabled.reduce(0.0) { $0 + Double(counts[$1] ?? 0) + Self.smoothing }
        guard total > 0 else { return 0 }
        let mine = Double(counts[language] ?? 0) + Self.smoothing
        return Self.weight * log(mine / total * Double(enabled.count))
    }
}

// MARK: The model

/// Which engine wrote a transcript. Each reads differently: Parakeet's unknown Latin words are
/// Uzbek or Turkish it could not write; the Uzbek engine's unknown Latin words are Arabic or
/// Turkish it transliterated.
public enum TranscriptSource: Int, Sendable, Codable, CaseIterable, Equatable {
    case unified = 0, uzbek, turkish, arabic

    public init(_ family: EngineFamily) {
        switch family {
        case .unified: self = .unified
        case .uzbek: self = .uzbek
        case .turkish: self = .turkish
        case .arabic: self = .arabic
        }
    }
}

/// The calibrated decision: score(language) = acoustic weights · acoustic features + Σ over the
/// transcripts present of that engine's weights · its features + the user's log-prior; the
/// posterior is the softmax over the enabled languages only. Weights are fitted on the tuning
/// halves (P4 §4, `Scripts/fit-lid.py`), golden-pinned (`route.json › lid`), and the same on
/// both platforms.
public struct LanguageModel: Sendable, Equatable {
    /// The five dictation languages in the model's fixed order — of its weights' rows, of
    /// `AcousticEvidence.logProbabilities` and of `TranscriptEvidence.known`.
    public static let order: [Language] = [.uzbek, .turkish, .arabic, .english, .russian]

    /// [language in `LanguageModel.order`][feature]: 7 acoustic features, then a bias.
    public var acoustic: [[Double]]
    /// [source][language][feature]: 11 transcript features each.
    public var transcript: [[[Double]]]

    public init(acoustic: [[Double]], transcript: [[[Double]]]) {
        self.acoustic = acoustic
        self.transcript = transcript
    }

    /// The scores, before the softmax, for every language in `LanguageModel.order`.
    public func scores(acoustic evidence: AcousticEvidence?,
                       transcripts: [TranscriptSource: TranscriptEvidence],
                       prior: LanguagePrior, enabled: Set<Language>) -> [Double] {
        LanguageModel.order.enumerated().map { i, language in
            var s = 0.0
            if let evidence {
                let x = evidence.featureVector + [1]
                s += zip(acoustic[i], x).reduce(0) { $0 + $1.0 * $1.1 }
            }
            for (source, t) in transcripts {
                s += zip(transcript[source.rawValue][i], t.featureVector).reduce(0) { $0 + $1.0 * $1.1 }
            }
            return s + prior.logPrior(language, among: enabled)
        }
    }

    public func decide(acoustic evidence: AcousticEvidence?,
                       transcripts: [TranscriptSource: TranscriptEvidence] = [:],
                       prior: LanguagePrior = LanguagePrior(),
                       enabled: Set<Language>) -> LanguageDecision {
        let on = enabled.isEmpty ? Set(Language.allCases) : enabled
        let s = scores(acoustic: evidence, transcripts: transcripts, prior: prior, enabled: on)
        let pairs = LanguageModel.order.enumerated().filter { on.contains($0.element) }
        let top = pairs.map { s[$0.offset] }.max() ?? 0
        let exps = pairs.map { ($0.element, exp(s[$0.offset] - top)) }
        let z = exps.reduce(0) { $0 + $1.1 }
        var posterior: [Language: Double] = [:]
        for (language, e) in exps { posterior[language] = e / z }
        return LanguageDecision(posterior: posterior)
    }
}

/// A posterior over the enabled languages, and what to do with it.
public struct LanguageDecision: Sendable, Equatable, Codable {
    public var posterior: [Language: Double]

    public init(posterior: [Language: Double]) { self.posterior = posterior }

    /// Ranked, ties broken in `LanguageModel.order` order (Uzbek first — the owner's rule:
    /// when unsure, Uzbek).
    public var ranked: [(language: Language, probability: Double)] {
        LanguageModel.order.compactMap { l in posterior[l].map { (l, $0) } }
            .enumerated()
            .sorted { $0.element.1 != $1.element.1 ? $0.element.1 > $1.element.1
                                                    : $0.offset < $1.offset }
            .map { ($0.element.0, $0.element.1) }
    }

    public var language: Language { ranked.first?.language ?? .english }
    public var confidence: Double { ranked.first?.probability ?? 0 }
}

// MARK: The policy: route, read, ask another engine while the evidence points away

/// The moments the session decides, as one pure rule the app, `kotiba-probe route-eval --lid`
/// and the Windows port all run (golden language-id.json):
///
/// 1. **Route** (`route`): the audio and the prior alone — which engine finishes the dictation.
/// 2. **Read** (`consider`): every transcript in hand is added. When the posterior then gives the
///    languages of engines *not yet heard from* at least `askFrom` between them, the most likely
///    of those is asked: its engine transcribes the same audio, and its transcript is read too.
///    Repeated — at most `maxEngines` engines in all — so the Uzbek engine's transliteration of
///    Arabic, once read, can send the dictation on to Cohere. Symmetric: Parakeet's text can
///    send a dictation to Arabic as readily as to Uzbek, the Uzbek engine's to Turkish or English.
/// 3. **Choose** (`choose`): the decision over every transcript, among the languages of the
///    engines that wrote one (nothing else has a transcript to deliver).
///
/// Inside Parakeet's family the decision also names English or Russian, and that beats the
/// script Parakeet happened to write: Cyrillic out of English speech (`Инсайд зе контент фоль.`)
/// is decoded again with Parakeet held to the decided script (`respell`).
public struct LanguagePolicy: Sendable, Equatable {
    public var model: LanguageModel
    public var prior: LanguagePrior
    public var enabled: Set<Language>
    /// Ask another engine while the languages of the engines not yet heard from hold at least
    /// this much. Chosen on the tuning half (P4 §4).
    public var askFrom: Double
    /// Engines that may write a transcript of one dictation, the routed one included.
    public var maxEngines: Int

    public static let defaultAskFrom = 0.1
    public static let defaultMaxEngines = 3

    public init(model: LanguageModel = .fitted, prior: LanguagePrior = LanguagePrior(),
                enabled: Set<Language>, askFrom: Double = LanguagePolicy.defaultAskFrom,
                maxEngines: Int = LanguagePolicy.defaultMaxEngines) {
        self.model = model
        self.prior = prior
        self.enabled = enabled.isEmpty ? Set(Language.allCases) : enabled
        self.askFrom = askFrom
        self.maxEngines = maxEngines
    }

    public func route(_ acoustic: AcousticEvidence?) -> LanguageDecision {
        model.decide(acoustic: acoustic, prior: prior, enabled: enabled)
    }

    private func sources(_ transcripts: [(Language, TranscriptEvidence)])
        -> [TranscriptSource: TranscriptEvidence] {
        var out: [TranscriptSource: TranscriptEvidence] = [:]
        for (language, evidence) in transcripts {
            out[TranscriptSource(EngineFamily(for: language))] = evidence
        }
        return out
    }

    /// The decision over every enabled language with the transcripts in hand, and the language
    /// whose engine to ask next — nil when the engines heard from already hold more than
    /// 1 − `askFrom`, or `maxEngines` have written.
    public func consider(_ acoustic: AcousticEvidence?,
                         transcripts: [(Language, TranscriptEvidence)])
        -> (decision: LanguageDecision, ask: Language?) {
        let decision = model.decide(acoustic: acoustic, transcripts: sources(transcripts),
                                    prior: prior, enabled: enabled)
        let heard = Set(transcripts.map { EngineFamily(for: $0.0) })
        guard heard.count < maxEngines else { return (decision, nil) }
        let outside = decision.posterior.filter { !heard.contains(EngineFamily(for: $0.key)) }
        guard outside.values.reduce(0, +) >= askFrom,
              let next = decision.ranked.first(where: {
                  !heard.contains(EngineFamily(for: $0.language)) })?.language
        else { return (decision, nil) }
        return (decision, next)
    }

    /// The language to deliver: the decision over every transcript, among the languages of the
    /// engines that wrote a usable one (`deliverable`; by default every engine that wrote).
    public func choose(_ acoustic: AcousticEvidence?,
                       transcripts: [(Language, TranscriptEvidence)],
                       deliverable: Set<EngineFamily>? = nil) -> LanguageDecision {
        let heard = deliverable ?? Set(transcripts.map { EngineFamily(for: $0.0) })
        let on = enabled.filter { heard.contains(EngineFamily(for: $0)) }
        return model.decide(acoustic: acoustic, transcripts: sources(transcripts), prior: prior,
                            enabled: on.isEmpty ? enabled : on)
    }

    /// Whether Parakeet's transcript must be decoded again in the decided language: it wrote the
    /// other script (more Cyrillic letters than Latin for English, the reverse for Russian).
    public static func respell(_ text: String, as language: Language) -> Bool {
        guard language == .english || language == .russian else { return false }
        var latin = 0, cyrillic = 0
        for s in text.unicodeScalars {
            switch s.value {
            case 0x41...0x5A, 0x61...0x7A: latin += 1
            case 0x400...0x4FF: cyrillic += 1
            default: break
            }
        }
        return language == .english ? cyrillic > latin : latin > cyrillic
    }
}

// MARK: The router

/// The acoustic route of P4: the language-ID model over the recording, through the policy's
/// `route`. A pin and a single enabled family are free, exactly as in `TieredRouter`.
public struct LanguageIDRouter: LanguageRouter {
    private let classifier: any AcousticClassifier
    public let policy: LanguagePolicy
    private let fallback: Language

    public init(classifier: any AcousticClassifier, policy: LanguagePolicy,
                fallback: Language = .english) {
        self.classifier = classifier
        self.policy = policy
        self.fallback = LanguageSubset(policy.enabled).fallback(preferring: fallback)
    }

    public func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision {
        if let pin { return RouteDecision(language: pin, source: .pin) }
        let languages = LanguageSubset(policy.enabled)
        if let sole = languages.soleRoute(preferring: fallback) {
            return RouteDecision(language: sole, source: .only)
        }
        let posterior = await classifier.posterior(for: audio)
        guard !posterior.isEmpty else { return RouteDecision(language: fallback, source: .fallback) }
        return Self.decide(posterior, seconds: audio.duration, policy: policy)
    }

    /// The acoustic route over one posterior. Static and pure for `route-eval` and the goldens.
    public static func decide(_ posterior: [String: Double], seconds: Double,
                              policy: LanguagePolicy) -> RouteDecision {
        let acoustic = AcousticEvidence(posterior: posterior, seconds: seconds)
        let decision = policy.route(acoustic)
        return RouteDecision(language: decision.language, source: .acoustic,
                             acoustic: acoustic, probabilities: decision.codes)
    }
}

extension LanguageDecision {
    /// The posterior keyed by language code, as the record stores it.
    public var codes: [String: Double] {
        Dictionary(uniqueKeysWithValues: posterior.map { ($0.key.rawValue, $0.value) })
    }
}
