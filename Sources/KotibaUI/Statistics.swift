import Foundation
import KotibaCore
import Observation

// What the Statistics pane and the History pane's per-row timings are computed from.
//
// The source is `diagnostics.jsonl`, read-only, not the history database. History keeps the text
// but not the mode or a single stage timing; the diagnostics record keeps both, one line per
// dictation, written by `DictationController.persist` whether or not the dictation produced text.
// The cost is that the log is a rolling window — `DiagnosticsStore` discards its oldest half past
// 2 MB — so every number here is "over the dictations still in the log", and the pane says so.
//
// Nothing in this file writes anything, and nothing reaches into the controller's private stores:
// the file is opened for reading only, off the main actor, and parsed line by line so one torn or
// future-format line costs that line, not the whole history.

// MARK: - The log

public enum UsageLog {

    /// Where `DictationController` writes its diagnostics.
    public static var defaultURL: URL {
        AppSettings.supportDirectory.appendingPathComponent("diagnostics.jsonl")
    }

    private nonisolated struct Line: Decodable {
        var record: DictationRecord
    }

    /// Every record in the file, oldest first. An unreadable line is skipped, not fatal.
    public nonisolated static func load(from url: URL) -> [DictationRecord] {
        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var records: [DictationRecord] = []
        records.reserveCapacity(2048)
        for line in data.split(separator: 0x0A, omittingEmptySubsequences: true) {
            if let parsed = try? decoder.decode(Line.self, from: Data(line)) {
                records.append(parsed.record)
            }
        }
        return records
    }
}

// MARK: - One dictation, as statistics see it

extension DictationRecord {

    /// Key-up to text-in-the-app.
    ///
    /// The session now records it directly (`releaseToInsertMillis`, wall clock), and that is
    /// what this reads when it is there. The stages are no longer a partition of that time: the
    /// release-time language detection runs *beside* the stream's finish, work polished during
    /// the hold happens before key-up, and the controller does a little between key-up and the
    /// session. Summing them is kept only for records written before the direct measurement —
    /// every stage but `arming` (which happens while the key is held), `loading` and `polishing`
    /// included, as it always was.
    public var releaseToPasteMillis: Double? {
        if let releaseToInsertMillis { return releaseToInsertMillis }
        let after = stageMillis.filter { $0.key != "arming" }
        guard !after.isEmpty else { return nil }
        return after.values.reduce(0, +)
    }

    /// What ended up in the user's app — the polish when it survived, the transcript otherwise.
    public var finalText: String? { polished ?? result }

    public var wordCount: Int {
        guard let text = finalText else { return 0 }
        return text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
    }

    public var succeeded: Bool { outcome == "done" }
}

// MARK: - The period

/// What the Statistics page covers: today, the last 7 days, the last 30, or everything the log
/// holds. The raw value is what `AppSettings.statsPeriod` stores (and the Windows settings file,
/// under the same key and values).
public enum StatsPeriod: String, CaseIterable, Sendable, Identifiable {
    case today, week, month, all

    /// The page opens on the last 7 days until the user picks another.
    public static let `default`: StatsPeriod = .week

    public var id: String { rawValue }

    /// A stored choice; an unknown one (a newer build's) reads as the default.
    public static func resolve(_ stored: String) -> StatsPeriod { StatsPeriod(rawValue: stored) ?? .default }
}

/// How long one bar of the chart is.
public enum StatsBucketUnit: String, Sendable, Equatable {
    case hour, day, week, month
}

/// Where a period starts and how its chart is cut, in local calendar terms.
///
/// Calendar arithmetic throughout, never `86_400` seconds: a day is 23 or 25 hours on the two
/// daylight-saving Sundays, and a bar that is "24 hours after the last one" drifts off midnight
/// for the rest of the chart. Hours are bucketed by their hour-of-day number, so the chart of a
/// daylight-saving day still has 24 bars, 00 to 23 — the skipped hour an empty bar, the repeated
/// one counted once. Weeks start on Monday, as they do in Uzbekistan and Russia, whatever the
/// region's own first weekday.
public struct StatsBucketing: Sendable {
    public let period: StatsPeriod
    public let unit: StatsBucketUnit
    /// Where each bar starts, oldest first. For `.hour`, the day's midnight plus the hour —
    /// or, for an hour the clocks skip, where that hour would have been.
    public let starts: [Date]
    /// The first instant the period covers, or nil for all time.
    public let from: Date?
    /// Weeks go by months past about six months: 26 weekly bars are the most that stay legible.
    public static let weeklyUpToDays = 183

    public init(period: StatsPeriod, now: Date, earliest: Date?, calendar base: Calendar = .current) {
        var calendar = base
        calendar.firstWeekday = 2
        self.period = period
        let today = calendar.startOfDay(for: now)
        func day(_ offset: Int) -> Date { calendar.date(byAdding: .day, value: offset, to: today) ?? today }
        switch period {
        case .today:
            unit = .hour
            from = today
            starts = (0..<24).map { hour in
                calendar.date(bySettingHour: hour, minute: 0, second: 0, of: today)
                    ?? today.addingTimeInterval(Double(hour) * 3600)
            }
        case .week:
            unit = .day
            from = day(-6)
            starts = (-6...0).map(day)
        case .month:
            unit = .day
            from = day(-29)
            starts = (-29...0).map(day)
        case .all:
            from = nil
            let first = earliest.map { min($0, now) } ?? now
            let span = calendar.dateComponents([.day], from: calendar.startOfDay(for: first), to: today).day ?? 0
            let component: Calendar.Component = span > Self.weeklyUpToDays ? .month : .weekOfYear
            unit = component == .month ? .month : .week
            let last = calendar.dateInterval(of: component, for: now)?.start ?? today
            var cursor = calendar.dateInterval(of: component, for: first)?.start ?? last
            var starts: [Date] = []
            while cursor <= last, starts.count < 1_000 {
                starts.append(cursor)
                guard let next = calendar.date(byAdding: component == .month ? .month : .weekOfYear,
                                               value: 1, to: cursor) else { break }
                cursor = next
            }
            self.starts = starts.isEmpty ? [last] : starts
        }
        self.calendar = calendar
    }

    private let calendar: Calendar

    /// Whether a moment falls in the period (up to `now`; the future is nobody's).
    public func contains(_ date: Date) -> Bool {
        guard let from else { return true }
        return date >= from
    }

    /// The bar a moment belongs to, as an index into `starts`, or nil outside the chart.
    public func bucket(of date: Date) -> Int? {
        switch unit {
        case .hour:
            guard let from, calendar.isDate(date, inSameDayAs: from) else { return nil }
            return calendar.component(.hour, from: date)
        case .day:
            return starts.firstIndex(of: calendar.startOfDay(for: date))
        case .week:
            return calendar.dateInterval(of: .weekOfYear, for: date).flatMap { starts.firstIndex(of: $0.start) }
        case .month:
            return calendar.dateInterval(of: .month, for: date).flatMap { starts.firstIndex(of: $0.start) }
        }
    }
}

// MARK: - The numbers

public struct UsageStats: Sendable, Equatable {

    /// The typing speed "time saved" is measured against. An average adult types around 40 words
    /// a minute; the pane states this number next to the result rather than hiding it.
    public static let typingWordsPerMinute: Double = 40

    public struct Day: Sendable, Equatable, Identifiable {
        public var date: Date
        public var dictations: Int
        public var words: Int
        public var id: Date { date }
    }

    public struct Share: Sendable, Equatable, Identifiable {
        public var key: String
        public var count: Int
        public var fraction: Double
        public var id: String { key }
    }

    /// One bar of the period's chart.
    public struct Bar: Sendable, Equatable, Identifiable {
        public var index: Int
        public var start: Date
        public var dictations: Int
        public var words: Int
        /// The bar "now" is in: this hour, today, this week, this month.
        public var isCurrent: Bool
        public var id: Int { index }
    }

    public struct StageTime: Sendable, Equatable, Identifiable {
        public var stage: String
        public var medianMillis: Double
        public var id: String { stage }
    }

    public var dictations = 0
    public var heardNothing = 0
    public var failed = 0
    public var words = 0
    public var spokenSeconds: Double = 0
    public var perDay: [Day] = []
    /// The period everything above the streak and the footnote covers, and its chart.
    public var period: StatsPeriod = .all
    public var barUnit: StatsBucketUnit = .day
    public var bars: [Bar] = []
    public var byLanguage: [Share] = []
    public var byMode: [Share] = []
    public var latencyMedianMillis: Double?
    public var latencyP90Millis: Double?
    public var stageMedians: [StageTime] = []
    public var streakDays = 0
    public var todayDictations = 0
    public var todayWords = 0
    public var earliest: Date?

    /// Minutes it would have taken to type the same words.
    public var typingSeconds: Double { Double(words) / Self.typingWordsPerMinute * 60 }

    /// Typing time minus what dictating actually cost: the speaking, and the wait after key-up.
    /// Floored at zero — a single short dictation can "save" negative time, and saying so helps
    /// nobody.
    public var savedSeconds: Double {
        let waited = (latencyMedianMillis ?? 0) / 1000 * Double(dictations)
        return max(0, typingSeconds - spokenSeconds - waited)
    }

    public init() {}

    /// Everything the pane shows, from the records alone.
    ///
    /// - Parameters:
    ///   - days: how many calendar days the per-day chart covers, ending today. Days with no
    ///     dictation appear with zero, so the chart's x axis is honest about gaps.
    ///   - period: what the totals, the splits, the timings and `bars` cover. The streak, today's
    ///     counts, `perDay` and `earliest` always read the whole log — Home shows them.
    public init(records all: [DictationRecord], now: Date = Date(),
                calendar: Calendar = .current, days: Int = 30, period: StatsPeriod = .all) {
        let everything = all.filter(\.succeeded)
        earliest = all.map(\.startedAt).min()

        // The period: what the totals, the splits, the timings and the chart read.
        let bucketing = StatsBucketing(period: period, now: now, earliest: earliest, calendar: calendar)
        let records = all.filter { bucketing.contains($0.startedAt) }
        let done = records.filter(\.succeeded)
        self.period = period
        dictations = done.count
        heardNothing = records.filter { $0.outcome == "heardNothing" }.count
        failed = records.filter { $0.outcome == "failed" }.count
        words = done.reduce(0) { $0 + $1.wordCount }
        spokenSeconds = done.reduce(0) { $0 + $1.audioSeconds }

        barUnit = bucketing.unit
        var counts = Array(repeating: (0, 0), count: bucketing.starts.count)
        for record in done {
            guard let index = bucketing.bucket(of: record.startedAt), counts.indices.contains(index) else {
                continue
            }
            counts[index] = (counts[index].0 + 1, counts[index].1 + record.wordCount)
        }
        let current = bucketing.bucket(of: now)
        bars = bucketing.starts.enumerated().map { index, start in
            Bar(index: index, start: start, dictations: counts[index].0, words: counts[index].1,
                isCurrent: index == current)
        }

        // Per day, over the whole log: Home's today and streak.
        let today = calendar.startOfDay(for: now)
        var byDay: [Date: (Int, Int)] = [:]
        for record in everything {
            let day = calendar.startOfDay(for: record.startedAt)
            let current = byDay[day] ?? (0, 0)
            byDay[day] = (current.0 + 1, current.1 + record.wordCount)
        }
        perDay = (0..<max(1, days)).reversed().compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: -offset, to: today) else {
                return nil
            }
            let value = byDay[day] ?? (0, 0)
            return Day(date: day, dictations: value.0, words: value.1)
        }
        todayDictations = byDay[today]?.0 ?? 0
        todayWords = byDay[today]?.1 ?? 0

        // Streak: consecutive days with at least one dictation, ending today — or yesterday, so
        // the streak does not read zero at nine in the morning before the first dictation.
        var cursor = byDay[today] == nil
            ? calendar.date(byAdding: .day, value: -1, to: today) ?? today
            : today
        var streak = 0
        while byDay[cursor] != nil {
            streak += 1
            guard let previous = calendar.date(byAdding: .day, value: -1, to: cursor) else { break }
            cursor = previous
        }
        streakDays = streak

        // Splits.
        byLanguage = Self.shares(done.map { $0.route?.language.rawValue ?? "?" })
        byMode = Self.shares(done.map { $0.modeKey ?? "unknown" })

        // Latency, key-up to pasted.
        let latencies = done.compactMap(\.releaseToPasteMillis).sorted()
        latencyMedianMillis = Self.percentile(latencies, 0.5)
        latencyP90Millis = Self.percentile(latencies, 0.9)

        // Where the time goes, in pipeline order.
        let order = ["finalising", "loading", "routing", "transcribing", "rerouting", "polishing",
                     "inserting"]
        stageMedians = order.compactMap { stage in
            let values = done.compactMap { $0.stageMillis[stage] }.sorted()
            // A stage that ran on fewer than one in twenty dictations (a cold load, a reroute)
            // would put a misleading median on the chart as if it were paid every time.
            guard values.count * 20 >= max(1, done.count),
                  let median = Self.percentile(values, 0.5) else { return nil }
            return StageTime(stage: stage, medianMillis: median)
        }
    }

    /// Nearest-rank percentile of an already-sorted array.
    public static func percentile(_ sorted: [Double], _ p: Double) -> Double? {
        guard !sorted.isEmpty else { return nil }
        let rank = Int((p * Double(sorted.count)).rounded(.up)) - 1
        return sorted[min(sorted.count - 1, max(0, rank))]
    }

    private static func shares(_ keys: [String]) -> [Share] {
        let total = max(1, keys.count)
        var counts: [String: Int] = [:]
        for key in keys { counts[key, default: 0] += 1 }
        return counts
            .map { Share(key: $0.key, count: $0.value, fraction: Double($0.value) / Double(total)) }
            .sorted { $0.count != $1.count ? $0.count > $1.count : $0.key < $1.key }
    }
}

// MARK: - The live model the window holds

/// The diagnostics log, loaded off the main actor and kept current as dictations land.
@Observable
public final class UsageModel {
    public private(set) var records: [DictationRecord] = []
    public private(set) var stats = UsageStats()
    public private(set) var loaded = false
    /// Records by the second they started, for the History pane's per-row timings.
    private var bySecond: [Int: DictationRecord] = [:]
    private let url: URL

    public init(url: URL = UsageLog.defaultURL) {
        self.url = url
    }

    /// Re-read the file. Cheap — 1,400 lines parse in tens of milliseconds — and done off-main.
    public func reload() async {
        let url = self.url
        let fresh = await Task.detached(priority: .utility) { UsageLog.load(from: url) }.value
        apply(fresh)
    }

    /// Fold in a record the controller has just finished, without waiting for the file. The
    /// controller writes the log after it publishes `lastRecord`, so a reload at that instant can
    /// miss the newest line.
    public func include(_ record: DictationRecord?) {
        guard let record, bySecond[Self.second(record.startedAt)] == nil else { return }
        apply(records + [record])
    }

    /// The page's numbers for one period, computed once per period per load. Not observable
    /// state of its own: it is derived from `records`, which is, so a view reading it still
    /// re-renders when a dictation lands.
    @ObservationIgnored private var byPeriod: [StatsPeriod: UsageStats] = [:]
    @ObservationIgnored private var computedAt = Date()

    public func stats(for period: StatsPeriod, now: Date = Date()) -> UsageStats {
        _ = records
        // A cached period goes stale at midnight (and "today" on the hour): recompute when the
        // hour has turned since.
        let calendar = Calendar.current
        if let cached = byPeriod[period],
           calendar.isDate(computedAt, equalTo: now, toGranularity: .hour) {
            return cached
        }
        if !calendar.isDate(computedAt, equalTo: now, toGranularity: .hour) { byPeriod = [:] }
        computedAt = now
        let fresh = UsageStats(records: records, now: now, period: period)
        byPeriod[period] = fresh
        return fresh
    }

    /// Replace everything — for the snapshot harness and for tests.
    public func apply(_ newRecords: [DictationRecord], now: Date = Date()) {
        byPeriod = [:]
        computedAt = now
        records = newRecords
        var index: [Int: DictationRecord] = [:]
        for record in newRecords { index[Self.second(record.startedAt)] = record }
        bySecond = index
        stats = UsageStats(records: newRecords, now: now)
        loaded = true
    }

    /// The diagnostics record for a history entry. History stores `startedAt` to the
    /// sub-millisecond; the log's ISO-8601 dates keep whole seconds — so match on the second, and
    /// allow the one either side that a rounding difference could land in.
    public func record(for entry: HistoryEntry) -> DictationRecord? {
        // Two dictations inside one second are possible, so a neighbour only counts when it
        // carries the same text; the exact second is trusted on its own.
        let second = Self.second(entry.startedAt)
        if let exact = bySecond[second] { return exact }
        return [second - 1, second + 1].lazy
            .compactMap { self.bySecond[$0] }
            .first { $0.result == entry.result }
    }

    private static func second(_ date: Date) -> Int {
        Int(date.timeIntervalSince1970.rounded(.down))
    }
}
