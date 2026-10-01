import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

// The model around `LanguageOrder`: what it counts (the Statistics source and window), and when
// it is allowed to move.

@MainActor
@Suite("Language order model")
struct LanguageOrderModelTests {

    static let now = Date(timeIntervalSince1970: 1_800_000_000)

    static func record(_ language: Language, daysAgo: Double = 1, outcome: String = "done") -> DictationRecord {
        var record = DictationRecord(startedAt: now.addingTimeInterval(-daysAgo * 86_400))
        record.outcome = outcome
        record.result = "x"
        record.route = RouteDecision(language: language, source: .pin)
        return record
    }

    static func model() -> LanguageOrderModel {
        LanguageOrderModel(url: URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("kotiba-order-\(UUID().uuidString).jsonl"))
    }

    @Test("counts only successful dictations from the last 30 days")
    func counting() {
        let records = (0..<5).map { _ in Self.record(.russian) }
            + [Self.record(.russian, daysAgo: 45), Self.record(.english, outcome: "failed"),
               Self.record(.english, outcome: "heardNothing"), Self.record(.uzbek)]
        let counts = LanguageOrderModel.counts(in: records, now: Self.now)
        #expect(counts[.russian] == 5)
        #expect(counts[.english] == nil)
        #expect(counts[.uzbek] == 1)
    }

    @Test("a fresh model is the default order; usage reorders it")
    func reorders() {
        let model = Self.model()
        #expect(model.order.prefix(3) == [.uzbek, .english, .russian])
        model.apply((0..<20).map { _ in Self.record(.russian) }, now: Self.now)
        #expect(model.order.first == .russian)
    }

    @Test("the order does not move while a picker is on screen")
    func heldWhileVisible() async {
        let model = Self.model()
        await model.refreshThenHold()                       // empty log: default order, now held
        model.apply((0..<20).map { _ in Self.record(.russian) }, now: Self.now)
        #expect(model.order.prefix(3) == [.uzbek, .english, .russian])
        model.release()
        model.apply((0..<20).map { _ in Self.record(.russian) }, now: Self.now)
        #expect(model.order.first == .russian)
    }

    @Test("onboarding's models step lists Uzbek, then English/Russian, then the helpers")
    func modelsOrder() {
        let order = ModelDownloads.Item.displayOrder
        #expect(Array(order.prefix(2)) == [.uzbek, .parakeet])
        #expect(Set(order) == Set(ModelDownloads.Item.allCases))
    }
}
