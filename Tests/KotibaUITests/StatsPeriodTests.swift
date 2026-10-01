import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaUI

// The Statistics page's period — Today, Week, Month, All time — and how each is cut into bars.
// In New York, on purpose: it has daylight saving, and the two days a year a day is not 24 hours
// long are exactly where "add 86,400 seconds" and "hour = seconds since midnight / 3,600" break.
// 2026: the clocks go forward at 02:00 on 8 March and back at 02:00 on 1 November.

@Suite("Statistics periods")
struct StatsPeriodTests {

    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }()

    static func at(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    static func record(_ date: Date, outcome: String = "done", words: Int = 3) -> DictationRecord {
        var record = DictationRecord(startedAt: date)
        record.outcome = outcome
        record.result = Array(repeating: "word", count: words).joined(separator: " ")
        record.route = RouteDecision(language: .english, source: .pin)
        record.modeKey = "super"
        record.stageMillis = ["transcribing": 100]
        return record
    }

    func stats(_ records: [DictationRecord], now: Date, _ period: StatsPeriod) -> UsageStats {
        UsageStats(records: records, now: now, calendar: Self.calendar, period: period)
    }

    @Test("Today is 24 hourly bars, 00 to 23, with the current hour lit")
    func today() {
        let now = Self.at(2026, 9, 29, 14, 20)
        let records = [Self.record(Self.at(2026, 9, 29, 0, 5)), Self.record(Self.at(2026, 9, 29, 14, 1)),
                       Self.record(Self.at(2026, 9, 29, 14, 19)), Self.record(Self.at(2026, 9, 28, 23, 59))]
        let s = stats(records, now: now, .today)
        #expect(s.barUnit == .hour)
        #expect(s.bars.count == 24)
        #expect(s.bars.map(\.dictations)[0] == 1)
        #expect(s.bars[14].dictations == 2)
        #expect(s.bars.filter(\.isCurrent).map(\.index) == [14])
        // Yesterday 23:59 is not today's.
        #expect(s.dictations == 3)
        #expect(s.words == 9)
    }

    @Test("A daylight-saving day still has 24 hourly bars; the skipped hour is empty, the repeated one counted once")
    func todayAcrossDST() {
        // Spring forward: 02:00–03:00 does not exist on 8 March.
        let spring = stats([Self.record(Self.at(2026, 3, 8, 1, 30)), Self.record(Self.at(2026, 3, 8, 3, 30))],
                           now: Self.at(2026, 3, 8, 20), .today)
        #expect(spring.bars.count == 24)
        #expect(spring.bars[1].dictations == 1 && spring.bars[2].dictations == 0 && spring.bars[3].dictations == 1)
        // Fall back: 01:00–02:00 happens twice on 1 November; both land in bar 01.
        let first = Self.calendar.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 1, minute: 30))!
        let second = first.addingTimeInterval(3600)
        #expect(Self.calendar.component(.hour, from: second) == 1)
        let fall = stats([Self.record(first), Self.record(second), Self.record(Self.at(2026, 11, 1, 23, 50))],
                         now: Self.at(2026, 11, 1, 23, 55), .today)
        #expect(fall.bars.count == 24)
        #expect(fall.bars[1].dictations == 2)
        #expect(fall.bars[23].dictations == 1)
        #expect(fall.dictations == 3)
    }

    @Test("Week is the last 7 local days, each bar starting at midnight, across a clock change")
    func weekAcrossDST() {
        let now = Self.at(2026, 3, 10, 9)
        let records = [Self.record(Self.at(2026, 3, 3, 23, 59)),   // 8 days back: out
                       Self.record(Self.at(2026, 3, 4, 0, 0)),     // the first instant in
                       Self.record(Self.at(2026, 3, 8, 23, 30)),   // the 23-hour day
                       Self.record(Self.at(2026, 3, 10, 8))]
        let s = stats(records, now: now, .week)
        #expect(s.barUnit == .day)
        #expect(s.bars.count == 7)
        for bar in s.bars {
            #expect(Self.calendar.component(.hour, from: bar.start) == 0, "\(bar.start)")
            #expect(Self.calendar.component(.minute, from: bar.start) == 0)
        }
        #expect(Self.calendar.component(.day, from: s.bars[0].start) == 4)
        #expect(s.bars.map(\.dictations) == [1, 0, 0, 0, 1, 0, 1])
        #expect(s.bars.last?.isCurrent == true)
        #expect(s.dictations == 3)
    }

    @Test("Month is the last 30 local days")
    func month() {
        let now = Self.at(2026, 11, 3, 10)
        let records = (0..<40).map { Self.record(Self.calendar.date(byAdding: .day, value: -$0, to: now)!) }
        let s = stats(records, now: now, .month)
        #expect(s.bars.count == 30)
        #expect(s.dictations == 30)
        #expect(s.bars.allSatisfy { $0.dictations == 1 })
        #expect(Self.calendar.component(.day, from: s.bars[0].start) == 5)
        #expect(Self.calendar.component(.month, from: s.bars[0].start) == 10)
    }

    @Test("All time goes by weeks starting Monday, and by months past half a year")
    func allTime() {
        let now = Self.at(2026, 9, 30, 10)   // a Wednesday
        let short = stats([Self.record(Self.at(2026, 8, 20)), Self.record(now)], now: now, .all)
        #expect(short.barUnit == .week)
        for bar in short.bars {
            #expect(Self.calendar.component(.weekday, from: bar.start) == 2, "a Monday")
            #expect(Self.calendar.component(.hour, from: bar.start) == 0)
        }
        // 20 August 2026 is a Thursday: its week began Monday 17 August.
        #expect(Self.calendar.component(.day, from: short.bars[0].start) == 17)
        #expect(short.bars.count == 7)
        #expect(short.bars.map(\.dictations).reduce(0, +) == 2)
        #expect(short.bars.last?.isCurrent == true)

        let long = stats([Self.record(Self.at(2025, 11, 15)), Self.record(now)], now: now, .all)
        #expect(long.barUnit == .month)
        #expect(long.bars.count == 11)   // November 2025 … September 2026
        #expect(Self.calendar.component(.day, from: long.bars[0].start) == 1)
        #expect(long.bars.first?.dictations == 1 && long.bars.last?.dictations == 1)
        #expect(long.dictations == 2)
    }

    @Test("An empty log still draws the period's axis, all zero")
    func empty() {
        let now = Self.at(2026, 9, 30, 10)
        for period in StatsPeriod.allCases {
            let s = stats([], now: now, period)
            #expect(!s.bars.isEmpty, "\(period)")
            #expect(s.bars.allSatisfy { $0.dictations == 0 })
            #expect(s.dictations == 0 && s.latencyMedianMillis == nil)
        }
    }

    @Test("The period drives the totals and splits; the streak and today's count are the whole log's")
    func periodDrivesTotals() {
        let now = Self.at(2026, 9, 30, 10)
        let records = (0..<10).map { Self.record(Self.calendar.date(byAdding: .day, value: -$0, to: now)!) }
            + [Self.record(Self.at(2026, 9, 30, 9), outcome: "failed")]
        let today = stats(records, now: now, .today)
        let week = stats(records, now: now, .week)
        let all = stats(records, now: now, .all)
        #expect(today.dictations == 1 && week.dictations == 7 && all.dictations == 10)
        #expect(today.failed == 1)
        #expect(today.streakDays == 10 && week.streakDays == 10)
        #expect(today.todayDictations == 1 && all.todayDictations == 1)
        #expect(week.byLanguage.first?.count == 7)
        #expect(week.earliest == all.earliest)
    }

    @Test("The period is a setting that opens on Week and survives a restart; an unknown one reads as Week")
    func remembered() {
        #expect(StatsPeriod.default == .week)
        #expect(StatsPeriod.resolve("today") == .today)
        #expect(StatsPeriod.resolve("fortnight") == .week)
        let store = UserDefaults(suiteName: UUID().uuidString)!
        let written = AppSettings.hermetic(store: store)
        #expect(written.statsPeriod == "week")
        written.statsPeriod = "all"
        written.save()
        #expect(AppSettings.hermetic(store: store).statsPeriod == "all")
    }

    @Test("Axis labels are unique within a chart and show every third hour")
    @MainActor
    func labels() {
        let now = Self.at(2026, 9, 30, 10)
        for period in StatsPeriod.allCases {
            let s = stats([Self.record(Self.at(2024, 1, 5)), Self.record(now)], now: now, period)
            let labels = s.bars.map { PeriodChart.label($0, unit: s.barUnit) }
            #expect(Set(labels).count == labels.count, "\(period): \(labels)")
            let shown = PeriodChart.shownLabels(s.bars, unit: s.barUnit)
            #expect(shown.count <= 8, "\(period)")
            #expect(shown.last == labels.last || s.barUnit == .hour)
        }
        let today = stats([], now: now, .today)
        #expect(PeriodChart.shownLabels(today.bars, unit: .hour).first == "00")
        #expect(PeriodChart.shownLabels(today.bars, unit: .hour).count == 8)
    }
}
