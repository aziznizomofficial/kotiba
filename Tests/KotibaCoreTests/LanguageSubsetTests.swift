import Foundation
import Testing

@testable import KotibaCore

// `LanguageSubset`: the router restricted to the languages the user dictates in. The rule is
// pinned byte-for-byte in route.json › languageSubsets (Windows replays it); these are the
// properties that matter whatever the numbers.

@Suite("LanguageSubset — the languages that are on")
struct LanguageSubsetTests {

    /// Posteriors across the routes: Uzbek, Turkish, Arabic, English, Russian, noise, empty.
    static let posteriors: [[String: Double]] = [
        ["tr": 0.63, "az": 0.17, "uz": 0.0, "en": 0.12, "ru": 0.08],
        ["tr": 0.995, "az": 0.003, "en": 0.002],
        ["ar": 0.998, "fa": 0.002],
        ["ar": 0.40, "fr": 0.35, "en": 0.25],
        ["en": 0.94, "ru": 0.03, "tr": 0.03],
        ["ru": 0.88, "uk": 0.07, "en": 0.05],
        ["fr": 0.5, "de": 0.5],
        ["ar": 974, "tr": 8, "fa": 6, "he": 4, "en": 8],
        [:],
    ]

    static var everySubset: [LanguageSubset] {
        (1..<32).map { mask in
            LanguageSubset(Language.allCases.enumerated()
                .filter { mask & (1 << $0.offset) != 0 }.map(\.element))
        }
    }

    @Test("never routes to, or names as a candidate, a language that is off")
    func neverOutside() {
        for subset in Self.everySubset {
            for posterior in Self.posteriors {
                for seconds in [1.0, 4.0, 12.0] {
                    let d = subset.decide(posterior, seconds: seconds,
                                          optional: OptionalLanguageRules(enabled: subset.optional))
                    #expect(subset.contains(d.language), "\(subset.ordered) → \(d.language)")
                    if let candidate = d.candidate {
                        #expect(subset.contains(candidate) && candidate != d.language)
                    }
                }
            }
        }
    }

    @Test("all five on is exactly the router as it was")
    func allIsUnchanged() {
        let rules = OptionalLanguageRules(enabled: [.turkish, .arabic])
        for posterior in Self.posteriors {
            for seconds in [2.0, 5.0, 12.0] {
                #expect(LanguageSubset.all.decide(posterior, seconds: seconds, optional: rules)
                        == TieredRouter.decide(posterior, seconds: seconds,
                                               clusterMass: ClusterMass(), optional: rules))
            }
        }
    }

    @Test("one family left means nothing to detect: one language, or English and Russian")
    func soleRoute() {
        #expect(LanguageSubset([.english]).soleRoute() == .english)
        #expect(LanguageSubset([.uzbek]).soleRoute() == .uzbek)
        #expect(LanguageSubset([.english, .russian]).soleRoute(preferring: .russian) == .russian)
        #expect(LanguageSubset([.english, .russian]).soleRoute(preferring: .uzbek) == .english)
        #expect(LanguageSubset([.uzbek, .english]).soleRoute() == nil)
        #expect(LanguageSubset([.turkish, .arabic]).soleRoute() == nil)
        let d = LanguageSubset([.english]).decide(["tr": 1], seconds: 9,
                                                  optional: OptionalLanguageRules())
        #expect(d == RouteDecision(language: .english, source: .only))
    }

    @Test("a sole route never asks the detector")
    func routerSkipsClassifier() async {
        struct Exploding: AcousticClassifier {
            func posterior(for audio: AudioBuffer) async -> [String: Double] {
                Issue.record("the detector was asked")
                return [:]
            }
        }
        let router = TieredRouter(classifier: Exploding(), languages: LanguageSubset([.russian]))
        let d = await router.route(AudioBuffer(samples: [Float](repeating: 0.1, count: 16_000)),
                                   pin: nil)
        #expect(d == RouteDecision(language: .russian, source: .only))
    }

    @Test("evidence for a language that is off is dropped; the rest renormalises")
    func restrict() {
        let uzEn = LanguageSubset([.uzbek, .english])
        #expect(uzEn.restrict(["tr": 0.5, "ru": 0.4, "ar": 0.05, "fr": 0.05])
                == ["tr": 0.5, "fr": 0.05])
        // Russian heard in Uzbek speech no longer counts against the Turkic cluster.
        let d = uzEn.decide(["tr": 0.04, "ru": 0.9, "en": 0.06], seconds: 3,
                            optional: OptionalLanguageRules())
        #expect(d.language == .uzbek)
        // The Turkic cluster stays while Turkish is on even with Uzbek off.
        #expect(LanguageSubset([.turkish, .english]).keeps("az"))
        #expect(!LanguageSubset([.english, .arabic]).keeps("tr"))
        #expect(LanguageSubset.all.restrict(["ru": 1, "x": 2]) == ["ru": 1, "x": 2])
    }

    @Test("Uzbek off, Turkish on: a Turkic recording is Turkish outright, at any length")
    func turkishWithoutUzbek() {
        let subset = LanguageSubset([.english, .turkish])
        let d = subset.decide(["tr": 0.63, "az": 0.17, "en": 0.2], seconds: 1.5,
                              optional: OptionalLanguageRules(enabled: [.turkish]))
        #expect(d.language == .turkish)
        #expect(d.candidate == nil)
    }

    @Test("English and Russian off: the non-Turkic side goes to Uzbek")
    func uzbekCatchesTheRest() {
        let d = LanguageSubset([.uzbek, .arabic]).decide(
            ["en": 0.9, "fr": 0.1], seconds: 2, optional: OptionalLanguageRules(enabled: [.arabic]))
        #expect(d.language == .uzbek)
    }

    @Test("the last language on cannot be turned off; an empty set reads as all five")
    func lastOne() {
        let one = LanguageSubset([.uzbek])
        #expect(!one.canTurnOff(.uzbek))
        #expect(one.setting(.uzbek, on: false) == one)
        #expect(one.setting(.english, on: true).ordered == [.english, .uzbek])
        #expect(LanguageSubset([]) == .all)
    }

    @Test("the onboarding preset: the core three, plus Turkish or Arabic when the Mac speaks it")
    func preset() {
        #expect(LanguageSubset.preset(systemLanguages: ["en-US"]).languages == Language.core)
        #expect(LanguageSubset.preset(systemLanguages: ["tr-TR"]).contains(.turkish))
        #expect(LanguageSubset.preset(systemLanguages: ["ar_EG", "en"]).contains(.arabic))
        #expect(!LanguageSubset.preset(systemLanguages: ["trk"]).contains(.turkish))
    }

    @Test("the fallback is a language that is on, Uzbek first")
    func fallback() {
        #expect(LanguageSubset([.russian, .uzbek]).fallback(preferring: .english) == .uzbek)
        #expect(LanguageSubset([.russian]).fallback(preferring: .english) == .russian)
        #expect(LanguageSubset.all.fallback(preferring: .english) == .english)
    }
}
