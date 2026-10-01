import Foundation
import Testing

@testable import KotibaCore

// The dictation-language pickers' order: default rank, then recent use, with hysteresis.
// The windows/ port has the same cases in test/language-order.test.ts.

@Suite("Language picker order")
struct LanguageOrderTests {

    private let table = LanguageOrder.defaultCodes
    private func run(_ codes: [String], _ counts: [String: Int], previous: [String]? = nil) -> [String] {
        LanguageOrder.order(codes: codes, counts: counts, previous: previous, table: table)
    }

    @Test("a fresh install lists Uzbek, English, Russian")
    func defaultOrder() {
        #expect(LanguageOrder.defaultOrder.prefix(3) == [.uzbek, .english, .russian])
        #expect(LanguageOrder.ordered(counts: [:]).prefix(3) == [.uzbek, .english, .russian])
    }

    @Test("Arabic and Turkish slot in after Russian, in that order, with no code but the table")
    func newLanguagesSlotIn() {
        // Declared in an arbitrary order, as enum cases may be added.
        #expect(run(["tr", "ru", "ar", "en", "uz"], [:]) == ["uz", "en", "ru", "ar", "tr"])
        // A code the table has never heard of goes last, in declaration order.
        #expect(run(["zz", "en", "yy", "uz"], [:]) == ["uz", "en", "zz", "yy"])
    }

    @Test("a clear lead moves a language up")
    func usageReorders() {
        #expect(run(["uz", "en", "ru"], ["ru": 40, "en": 10, "uz": 2]) == ["ru", "en", "uz"])
    }

    @Test("a tie falls back to the default order")
    func ties() {
        #expect(run(["uz", "en", "ru"], ["ru": 5, "en": 5, "uz": 5]) == ["uz", "en", "ru"])
        #expect(run(["uz", "en", "ru"], ["ru": 9, "en": 9]) == ["en", "ru", "uz"])
    }

    @Test("hysteresis: under 3 more, or under 20% more, does not swap")
    func hysteresis() {
        #expect(run(["uz", "en", "ru"], ["uz": 10, "en": 12]) == ["uz", "en", "ru"])     // +2
        #expect(run(["uz", "en", "ru"], ["uz": 100, "en": 110]) == ["uz", "en", "ru"])   // +10%
        #expect(run(["uz", "en", "ru"], ["uz": 10, "en": 13]) == ["en", "uz", "ru"])     // +3, +30%
        #expect(run(["uz", "en", "ru"], ["uz": 0, "en": 3]) == ["en", "uz", "ru"])
        #expect(!LanguageOrder.isClearLead(2, over: 0))
    }

    @Test("what the user last saw is kept until a lead is clear")
    func previousSticks() {
        // English leads Uzbek by 2: the list they already saw (English first) stays.
        #expect(run(["uz", "en", "ru"], ["uz": 12, "en": 10], previous: ["en", "uz", "ru"])
                == ["en", "uz", "ru"])
        // Uzbek pulls clearly ahead: now it swaps back.
        #expect(run(["uz", "en", "ru"], ["uz": 20, "en": 10], previous: ["en", "uz", "ru"])
                == ["uz", "en", "ru"])
        // Same counts, same previous: idempotent.
        let once = run(["uz", "en", "ru"], ["ru": 30, "en": 9], previous: nil)
        #expect(run(["uz", "en", "ru"], ["ru": 30, "en": 9], previous: once) == once)
    }

    @Test("a stale previous order with a language added or removed is repaired")
    func previousRepaired() {
        // "gone" is dropped, the new "uz"/"ar" join, and with no usage everything is a tie.
        #expect(run(["uz", "en", "ru", "ar"], [:], previous: ["ru", "gone", "en"]) == ["uz", "en", "ru", "ar"])
        // With usage that keeps Russian ahead, the survivors keep their order and the new ones follow.
        #expect(run(["uz", "en", "ru", "ar"], ["ru": 30], previous: ["ru", "gone", "en"]) == ["ru", "uz", "en", "ar"])
    }

    @Test("Language wrapper covers every case exactly once")
    func wrapper() {
        let order = LanguageOrder.ordered(counts: [.russian: 50])
        #expect(Set(order) == Set(Language.allCases) && order.count == Language.allCases.count)
        #expect(order.first == .russian)
    }
}
