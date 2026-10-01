import Foundation
import KotibaCore
import Observation
import SwiftUI

// The live order of the dictation-language pickers (see `LanguageOrder` for the rule): the
// default order until the diagnostics log has something to say, then by successful dictations in
// the last 30 days — the same log, and the same 30-day window (`StatsBucketing(.month)`), the
// Statistics page uses.
//
// WHEN it recomputes is the other half of "no jitter": only when a picker's page opens (or the
// window/menu is about to), never while one is on screen. A pane calls `refreshThenHold()` as it
// appears and `release()` as it goes; while held, `refresh` is a no-op, so a dictation that lands
// beside an open Home page cannot shuffle the row the user is reading.

@Observable
@MainActor
public final class LanguageOrderModel {

    public private(set) var order: [Language] = LanguageOrder.defaultOrder
    /// A picker is on screen: the order stands until it is gone.
    private var held = false
    private let url: URL

    public init(url: URL) {
        self.url = url
    }

    /// Successful dictations per language over the last 30 days ending `now`. Pure, so the test
    /// can feed records without a file.
    public static func counts(in records: [DictationRecord], now: Date = Date(),
                                          calendar: Calendar = .current) -> [Language: Int] {
        let window = StatsBucketing(period: .month, now: now, earliest: nil, calendar: calendar)
        var counts: [Language: Int] = [:]
        for record in records where record.succeeded && window.contains(record.startedAt) {
            if let language = record.route?.language { counts[language, default: 0] += 1 }
        }
        return counts
    }

    /// Recompute from records already in hand. No-op while a picker is showing.
    public func apply(_ records: [DictationRecord], now: Date = Date()) {
        guard !held else { return }
        let next = LanguageOrder.ordered(counts: Self.counts(in: records, now: now), previous: order)
        guard next != order else { return }
        // Soft: the pickers key their rows by language, so a reorder glides.
        withAnimation(Theme.Motion.smooth) { order = next }
    }

    /// Re-read the log (off the main actor) and recompute. No-op while a picker is showing.
    public func refresh() async {
        guard !held else { return }
        let url = self.url
        let records = await Task.detached(priority: .utility) { UsageLog.load(from: url) }.value
        apply(records)
    }

    /// A picker's page appeared: settle the order once, then freeze it while the page is up.
    public func refreshThenHold() async {
        await refresh()
        if !Task.isCancelled { held = true }
    }

    /// The picker's page went away.
    public func release() { held = false }
}
