import Foundation
import Testing
import SwiftUI

@testable import KotibaCore
@testable import KotibaUI

// The Statistics pane and the History pane's per-row timings are computed from the diagnostics
// log. These pin down the arithmetic the pane puts in front of the user — latency, streak, the
// per-day gaps, the split — and the join that attaches a timing to a history row.

@Suite("Usage statistics")
@MainActor
struct UsageStatsTests {

    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// 2026-09-29 12:00 UTC.
    private let now = Date(timeIntervalSince1970: 1_790_683_200)

    private func record(daysAgo: Int, outcome: String = "done", text: String = "one two three",
                        language: Language = .english, mode: String? = "super",
                        stages: [String: Double] = ["arming": 50, "routing": 40,
                                                    "transcribing": 300, "inserting": 10],
                        audio: Double = 2) -> DictationRecord {
        var record = DictationRecord(startedAt: now.addingTimeInterval(Double(-daysAgo) * 86_400))
        record.outcome = outcome
        record.result = text
        record.route = RouteDecision(language: language, source: .pin)
        record.modeKey = mode
        record.stageMillis = stages
        record.audioSeconds = audio
        return record
    }

    @Test("Key-up to paste leaves out arming, which happens while the key is held")
    func latencyExcludesArming() {
        #expect(record(daysAgo: 0).releaseToPasteMillis == 350)
        var none = record(daysAgo: 0)
        none.stageMillis = ["arming": 50]
        #expect(none.releaseToPasteMillis == nil)
    }

    // The pipeline now runs the release-time detection beside the stream's finish, so the stages
    // overlap and their sum over-reads; the session measures key-up to insert directly.
    @Test("A record that measured key-up to insert directly is read as measured, not summed")
    func directMeasurementWins() {
        var measured = record(daysAgo: 0)
        measured.stageMillis = ["arming": 50, "routing": 40, "transcribing": 60,
                                "polishing": 30, "inserting": 5]
        measured.releaseToInsertMillis = 92
        #expect(measured.releaseToPasteMillis == 92)
        #expect(record(daysAgo: 0).releaseToPasteMillis == 350, "old records still sum")
    }

    @Test("Only finished dictations count; heard-nothing and failures are counted apart")
    func outcomes() {
        let stats = UsageStats(records: [
            record(daysAgo: 0),
            record(daysAgo: 0, outcome: "heardNothing", text: ""),
            record(daysAgo: 0, outcome: "failed"),
        ], now: now, calendar: calendar)
        #expect(stats.dictations == 1)
        #expect(stats.heardNothing == 1)
        #expect(stats.failed == 1)
        #expect(stats.words == 3)
        #expect(stats.todayDictations == 1)
    }

    @Test("Median and p90 are nearest-rank over finished dictations")
    func percentiles() {
        let records = (1...10).map { i in
            record(daysAgo: 0, stages: ["transcribing": Double(i * 100)])
        }
        let stats = UsageStats(records: records, now: now, calendar: calendar)
        #expect(stats.latencyMedianMillis == 500)
        #expect(stats.latencyP90Millis == 900)
        #expect(UsageStats.percentile([], 0.5) == nil)
    }

    @Test("The streak survives a morning with nothing yet, and breaks on a gap")
    func streak() {
        // Yesterday and the day before, nothing today: still a two-day streak.
        var stats = UsageStats(records: [record(daysAgo: 1), record(daysAgo: 2), record(daysAgo: 4)],
                               now: now, calendar: calendar)
        #expect(stats.streakDays == 2)
        stats = UsageStats(records: [record(daysAgo: 0), record(daysAgo: 1)],
                           now: now, calendar: calendar)
        #expect(stats.streakDays == 2)
        stats = UsageStats(records: [record(daysAgo: 3)], now: now, calendar: calendar)
        #expect(stats.streakDays == 0)
    }

    @Test("Every day of the range appears, with zero on the days with no dictation")
    func perDayHasGaps() {
        let stats = UsageStats(records: [record(daysAgo: 0), record(daysAgo: 0), record(daysAgo: 3)],
                               now: now, calendar: calendar, days: 7)
        #expect(stats.perDay.count == 7)
        #expect(stats.perDay.last?.dictations == 2)
        #expect(stats.perDay.map(\.dictations) == [0, 0, 0, 1, 0, 0, 2])
    }

    @Test("Splits are sorted by count and sum to one")
    func splits() {
        let stats = UsageStats(records: [
            record(daysAgo: 0, language: .uzbek, mode: "note"),
            record(daysAgo: 0), record(daysAgo: 0), record(daysAgo: 0, mode: nil),
        ], now: now, calendar: calendar)
        #expect(stats.byLanguage.first?.key == "en")
        #expect(stats.byLanguage.map(\.count) == [3, 1])
        #expect(abs(stats.byMode.map(\.fraction).reduce(0, +) - 1) < 1e-9)
        #expect(stats.byMode.contains { $0.key == "unknown" })
    }

    @Test("A rare stage is left off the per-stage chart rather than shown as typical")
    func rareStagesDropped() {
        var records = (0..<40).map { _ in record(daysAgo: 0) }
        records[0].stageMillis["loading"] = 7800
        let stats = UsageStats(records: records, now: now, calendar: calendar)
        #expect(!stats.stageMedians.contains { $0.stage == "loading" })
        #expect(stats.stageMedians.map(\.stage) == ["routing", "transcribing", "inserting"])
    }

    @Test("The log parser skips a torn line instead of losing the file")
    func parserSkipsBadLines() throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("usage-\(UUID().uuidString).jsonl")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        struct Line: Encodable { var record: DictationRecord }
        var data = try encoder.encode(Line(record: record(daysAgo: 0)))
        data.append(contentsOf: Array("\n{\"record\": {\"torn\n".utf8))
        data.append(try encoder.encode(Line(record: record(daysAgo: 1))))
        data.append(0x0A)
        try data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(UsageLog.load(from: url).count == 2)
    }

    @Test("A history row finds its diagnostics record despite the log's whole-second dates")
    func historyJoin() {
        let model = UsageModel(url: URL(fileURLWithPath: "/nonexistent"))
        var logged = record(daysAgo: 0, text: "salom dunyo")
        logged.startedAt = Date(timeIntervalSince1970: 1_790_683_200)  // as ISO-8601 left it
        model.apply([logged], now: now)

        let entry = HistoryEntry(startedAt: Date(timeIntervalSince1970: 1_790_683_200.734),
                                 language: .uzbek, engineID: "x", raw: "salom dunyo",
                                 result: "salom dunyo")
        #expect(model.record(for: entry)?.modeKey == "super")

        // A neighbouring second only counts when the text agrees.
        let other = HistoryEntry(startedAt: Date(timeIntervalSince1970: 1_790_683_201.2),
                                 language: .uzbek, engineID: "x", raw: "boshqa", result: "boshqa")
        #expect(model.record(for: other) == nil)
    }

    @Test("A just-finished record is folded in once, without waiting for the file")
    func includeIsIdempotent() {
        let model = UsageModel(url: URL(fileURLWithPath: "/nonexistent"))
        model.apply([], now: now)
        let fresh = record(daysAgo: 0)
        model.include(fresh)
        model.include(fresh)
        #expect(model.records.count == 1)
    }
}

@Suite("The pill")
@MainActor
struct PillStateTests {

    @Test("Every controller status maps to a pill state, and outcomes fold away on their own")
    func mapping() {
        var record = DictationRecord(startedAt: Date())
        record.stageMillis = ["arming": 40, "transcribing": 120, "inserting": 5]
        #expect(PillState(status: .listening, record: nil) == .listening)
        #expect(PillState(status: .working("transcribing"), record: nil) == .processing)
        #expect(PillState(status: .preparing("Uzbek model"), record: nil) == .processing)
        #expect(PillState(status: .succeeded("hi"), record: record) == .success(millis: 125))
        #expect(PillState(status: .idle, record: nil) == .hidden)
        if case .attention = PillState(status: .heardNothing, record: nil) {} else {
            Issue.record("heard-nothing should be an amber attention state")
        }
        // The pill says its few words; the sentence stays on Home.
        #expect(PillState(status: .failed("boom — the long reason", pill: "Couldn’t paste"), record: nil)
                == .attention("Couldn’t paste"))
        #expect(PillState(status: .failed("a model failed to load"), record: nil)
                == .attention(L("pill.failed.generic")))
        #expect(PillState.success(millis: nil).dwell != nil)
        #expect(PillState.listening.dwell == nil)
    }
}

@Suite("The stat-tile row fills its width")
struct TileRowColumnsTests {
    @Test("four tiles take 4, 2 or 1 columns — never an empty fifth, never three and a lone one")
    func divisorsOfFour() {
        func count(_ width: CGFloat) -> Int {
            AdaptiveGrid<EmptyView>.columnCount(width: width, minimum: 138, spacing: 12, maximum: 4)
        }
        // The default 1000-pt window with overlay scroll bars: five 138-pt columns fit.
        #expect(count(742) == 4)
        #expect(count(860) == 4)        // the readable-width cap
        #expect(count(560) == 2)        // three fit; three would leave the fourth alone
        #expect(count(290) == 2)
        #expect(count(200) == 1)
        #expect(count(0) == 1)
    }
}
