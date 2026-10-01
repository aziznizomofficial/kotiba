import Foundation

// MARK: - The languages the user dictates in

/// The dictation languages that are on (Settings › Languages, onboarding's "Which languages do you
/// dictate in?"). Every one of the five can be turned off; at least one is always on.
///
/// A language that is off is **never routed to** — not by the detector, not by Turkish's or
/// Arabic's checks, not by a recovery after the fact — and costs nothing: no stream, no preload,
/// no model kept warm. What that buys, measured (P3 §"Fewer languages"): a speaker who dictates
/// only English and Russian never waits for a detection or an Uzbek second opinion, and one who
/// dictates Uzbek and English is never sent to Russian.
///
/// The router's whole decision is restricted here, in one pure function (`decide`), so the app,
/// `kotiba-probe route-eval` and the Windows port all replay exactly the same rule.
public struct LanguageSubset: Sendable, Equatable, Hashable {
    /// Never empty: an empty set reads as every language, so a corrupt or missing setting can
    /// never leave Kotiba with nothing to dictate in.
    public let languages: Set<Language>

    public init<S: Sequence>(_ languages: S) where S.Element == Language {
        let set = Set(languages)
        self.languages = set.isEmpty ? Set(Language.allCases) : set
    }

    /// Every language on: the router's rule exactly as it was before languages could be turned off.
    public static let all = LanguageSubset(Language.allCases)

    /// What a new install starts with: Uzbek, English and Russian; Turkish or Arabic also when the
    /// system's own language is one of them (onboarding's preset).
    public static func preset(systemLanguages: [String]) -> LanguageSubset {
        var on: Set<Language> = Language.core
        for code in systemLanguages {
            let primary = code.split(whereSeparator: { $0 == "-" || $0 == "_" }).first
                .map { $0.lowercased() } ?? ""
            if primary == "tr" { on.insert(.turkish) }
            if primary == "ar" { on.insert(.arabic) }
        }
        return LanguageSubset(on)
    }

    public func contains(_ language: Language) -> Bool { languages.contains(language) }

    public var isAll: Bool { languages.count == Language.allCases.count }

    /// In `Language` order, for settings and logs.
    public var ordered: [Language] { Language.allCases.filter(languages.contains) }

    /// The engine families that may run. English and Russian share one (Parakeet).
    public var families: Set<EngineFamily> { Set(languages.map { EngineFamily(for: $0) }) }

    /// The optional languages that are on (Turkish, Arabic), as `OptionalLanguageRules` reads them.
    public var optional: Set<Language> { languages.filter(\.isOptional) }

    /// Whether `language` may be turned off: the last one on may not.
    public func canTurnOff(_ language: Language) -> Bool {
        !contains(language) || languages.count > 1
    }

    /// The set with `language` turned on or off. Turning the last one off is refused (the set is
    /// returned unchanged) — the UI disables that toggle, this is the rule behind it.
    public func setting(_ language: Language, on: Bool) -> LanguageSubset {
        if on { return LanguageSubset(languages.union([language])) }
        guard canTurnOff(language) else { return self }
        return LanguageSubset(languages.subtracting([language]))
    }

    /// The route when there is nothing for the detector to decide: one language, or English and
    /// Russian alone — one engine family, and Parakeet settles English against Russian inside its
    /// own decoder (`TieredRouter`'s P4 label is advisory there). Then no detection runs at all,
    /// exactly like a pin. For English + Russian the label is `preferring` when it is one of them
    /// (the default language), else English; the unified engine's own label replaces it after.
    public func soleRoute(preferring: Language = .english) -> Language? {
        guard families.count == 1 else { return nil }
        if languages.count == 1 { return languages.first }
        return contains(preferring) ? preferring : .english
    }

    /// `preferred` when it is on, else the first that is, in the order a fallback should go:
    /// Uzbek (the owner's rule — when unsure, Uzbek), English, Russian, Turkish, Arabic.
    public func fallback(preferring preferred: Language) -> Language {
        if contains(preferred) { return preferred }
        return [Language.uzbek, .english, .russian, .turkish, .arabic].first(where: contains)
            ?? .english
    }

    /// Is a posterior code evidence for some language that is on?
    ///
    /// `en`, `ru`, `ar` are their own language's evidence. The Turkic cluster (`ClusterMass`) is
    /// the Turkic route's — Uzbek's, or Turkish's — so it stays while either is on (`tr` is how a
    /// clean Uzbek clip is mostly heard). Every other code is no language's evidence: it is the
    /// "everything else" the cluster threshold was measured against, and stays, so a share means
    /// what it meant when its threshold was chosen.
    public func keeps(_ code: String) -> Bool {
        switch code {
        case "en": return contains(.english)
        case "ru": return contains(.russian)
        case "ar": return contains(.arabic)
        default:
            if ClusterMass.turkicCluster.contains(code) {
                return contains(.uzbek) || contains(.turkish)
            }
            return true
        }
    }

    /// The detector's posterior with the evidence for languages that are off removed — and so,
    /// since every share and mass is of the total, renormalised over what is left. With every
    /// language on it is the posterior unchanged.
    public func restrict(_ posterior: [String: Double]) -> [String: Double] {
        isAll ? posterior : posterior.filter { keeps($0.key) }
    }

    /// The acoustic tier, restricted to the languages that are on. Pure, and the only rule: the
    /// router, `kotiba-probe route-eval` and the goldens call it.
    ///
    /// 1. Nothing to decide (`soleRoute`): that language, source `only`, without the posterior.
    /// 2. Otherwise `TieredRouter.decide` over the restricted posterior, with the optional rules
    ///    only for optional languages that are on (`rules.enabled` ∩ this set), then mapped into the
    ///    set — every branch lands on a language that is on:
    ///    * a Turkic route with Uzbek off is Turkish (Turkish is on, or the cluster was dropped);
    ///      English and Russian score a Turkic mass of at most 0.012 against a 0.05 threshold, so
    ///      with Uzbek off there is nothing left for Turkish's own check to separate it from;
    ///    * an English/Russian route with both off goes to Uzbek when it is on (where unsure,
    ///      Uzbek), else to Arabic when its share outweighs the Turkic mass, else Turkish;
    ///    * the unified label is the one of English/Russian that is on.
    /// A candidate (`tr`/`ar`) is only ever one that is on, and never the route itself.
    public func decide(_ posterior: [String: Double], seconds: Double,
                       clusterMass: ClusterMass = ClusterMass(),
                       optional rules: OptionalLanguageRules,
                       preferring: Language = .english) -> RouteDecision {
        if let sole = soleRoute(preferring: preferring) {
            return RouteDecision(language: sole, source: .only)
        }
        if isAll { return TieredRouter.decide(posterior, seconds: seconds,
                                             clusterMass: clusterMass, optional: rules) }
        var on = rules
        on.enabled = rules.enabled.intersection(optional)
        let base = TieredRouter.decide(restrict(posterior), seconds: seconds,
                                       clusterMass: clusterMass, optional: on)
        if contains(base.language) { return base }
        let target: Language
        switch base.family {
        case .uzbek:
            // Uzbek off. Turkish if on; otherwise the cluster was dropped and this cannot be
            // reached, but the set decides, not the arithmetic.
            target = contains(.turkish) ? .turkish
                : contains(.english) || contains(.russian) ? unifiedLabel(base)
                : .arabic
        case .unified:
            if contains(.english) || contains(.russian) {
                target = unifiedLabel(base)
            } else if contains(.uzbek) {
                target = .uzbek
            } else {
                target = (base.arabicShare ?? 0) > (base.turkicMass ?? 0) || !contains(.turkish)
                    ? .arabic : .turkish
            }
        case .turkish, .arabic:
            target = fallback(preferring: .uzbek)   // unreachable: optional routes need `on`
        }
        // The candidate stays only when it is on and is not now the route.
        let candidate = base.candidate.flatMap { contains($0) && $0 != target ? $0 : nil }
        return RouteDecision(language: target, source: base.source, turkicMass: base.turkicMass,
                             turkishShare: base.turkishShare, arabicShare: base.arabicShare,
                             candidate: candidate)
    }

    /// English or Russian, whichever is on — the router's own label when both are.
    private func unifiedLabel(_ base: RouteDecision) -> Language {
        if contains(.english), contains(.russian) {
            return base.language == .russian ? .russian : .english
        }
        return contains(.russian) ? .russian : .english
    }

    /// Whether a recovery after transcription (the script, transcript and lexical checks, and the
    /// unified engine's own en/ru label) may move the route to `language`. Only to one that is on.
    public func permits(_ language: Language) -> Bool { contains(language) }
}
