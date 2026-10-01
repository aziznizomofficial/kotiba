import Charts
import KotibaCore
import SwiftUI

// Statistics, from `UsageStats` — which reads the diagnostics log and nothing else. The footnote
// says so: the log is a rolling window, so "all time" here means "all the log still holds".
//
// One period drives the page — Today, Week (the last 7 days), Month (the last 30) or All time —
// chosen at the top and remembered (`AppSettings.statsPeriod`). The totals, the splits, the
// timings and the chart all read it; the chart is cut to fit it: hourly bars for today with the
// current hour lit, days for a week or a month, weeks (months past half a year) for all time.
// Switching counts the tiles from the old numbers to the new and grows the chart in again, in
// place: nothing on the page changes height. The streak is the one tile that is not a period's —
// a run of days is a run of days — and neither is the footnote, which describes the whole log.

struct StatisticsPane: View {
    let usage: UsageModel
    let modes: ModeRegistry
    @Bindable var settings: AppSettings

    private var period: StatsPeriod { StatsPeriod.resolve(settings.statsPeriod) }

    private var periodBinding: Binding<StatsPeriod> {
        Binding(get: { period },
                set: { chosen in
                    withAnimation(Theme.Motion.smooth) { settings.statsPeriod = chosen.rawValue }
                    settings.save()
                })
    }

    var body: some View {
        let all = usage.stats
        let stats = usage.stats(for: period)
        Pane(title: L("section.statistics"), subtitle: coverage(all)) {
            HStack {
                AdaptivePicker(selection: periodBinding,
                               options: StatsPeriod.allCases.map { ($0, Self.name($0)) })
                    .fixedSize()
                Spacer(minLength: 0)
            }

            AdaptiveGrid(minimumColumnWidth: 138, maximumColumns: 4) {
                StatTile(title: L("stats.words"), value: Names.count(stats.words),
                         caption: Lp("stats.words.caption", stats.dictations),
                         systemImage: "text.word.spacing",
                         counting: .init(number: Double(stats.words), format: Names.countFormat()),
                         order: 0)
                StatTile(title: L("stats.saved"), value: Names.duration(stats.savedSeconds),
                         caption: L("stats.saved.caption", Int(UsageStats.typingWordsPerMinute)),
                         systemImage: "hourglass",
                         counting: .init(number: stats.savedSeconds,
                                         format: Names.durationFormat(toward: stats.savedSeconds)),
                         order: 1)
                StatTile(title: L("home.today.latency"),
                         value: Names.millis(stats.latencyMedianMillis),
                         caption: L("stats.latency.caption", Names.millis(stats.latencyP90Millis)),
                         systemImage: "bolt.fill",
                         counting: stats.latencyMedianMillis.map {
                             .init(number: $0, format: Names.millisFormat(toward: $0))
                         },
                         order: 2)
                StatTile(title: L("home.today.streak"), value: Names.count(all.streakDays),
                         caption: Lnoun("noun.dayInARow", all.streakDays),
                         systemImage: "flame.fill",
                         counting: .init(number: Double(all.streakDays), format: Names.countFormat()),
                         order: 3)
            }

            Card {
                HStack(spacing: Theme.Space.s) {
                    Image(systemName: "chart.bar.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Palette.accent)
                        .frame(width: 16)
                    Text(Self.chartTitle(stats.barUnit))
                        .font(Theme.Typeface.headline)
                        .foregroundStyle(Theme.Palette.text)
                        .lineLimit(1)
                        .contentTransition(.opacity)
                    Spacer(minLength: Theme.Space.s)
                }
                PeriodChart(bars: stats.bars, unit: stats.barUnit, empty: Self.empty(period))
                    .frame(height: 180)
                    // A new period is a new chart: it grows in again rather than morphing 24
                    // hourly bars into 7 daily ones.
                    .id(period)
                    .transition(.opacity)
            }

            AdaptiveGrid(minimumColumnWidth: 280) {
                Card(title: L("stats.byLanguage"), systemImage: "globe") {
                    ShareBars(shares: stats.byLanguage) { Names.language(code: $0) }
                        .id(period)
                }
                Card(title: L("stats.byMode"), systemImage: "wand.and.sparkles") {
                    ShareBars(shares: stats.byMode) { Names.mode($0, in: modes) }
                        .id(period)
                }
            }

            Card(title: L("stats.stages"), subtitle: L("stats.stages.subtitle"),
                 systemImage: "stopwatch.fill") {
                StageChart(stages: stats.stageMedians)
                    .frame(height: CGFloat(max(1, stats.stageMedians.count)) * 30 + 10)
                    .id(period)
            }

            Footnote(L("stats.footnote", Names.count(usage.records.count),
                       Names.count(all.heardNothing), Names.count(all.failed),
                       Int(UsageStats.typingWordsPerMinute)))
        }
        .animation(Theme.Motion.smooth, value: stats)
    }

    private func coverage(_ stats: UsageStats) -> String {
        guard let earliest = stats.earliest else {
            return usage.loaded ? L("stats.nothing") : L("stats.reading")
        }
        return L("stats.since", LocalFormat.date(earliest, .dateTime.day().month(.wide).year()))
    }

    static func name(_ period: StatsPeriod) -> String {
        switch period {
        case .today: return L("stats.period.today")
        case .week: return L("stats.period.week")
        case .month: return L("stats.period.month")
        case .all: return L("stats.period.all")
        }
    }

    static func chartTitle(_ unit: StatsBucketUnit) -> String {
        switch unit {
        case .hour: return L("stats.chart.hour")
        case .day: return L("stats.perDay")
        case .week: return L("stats.chart.week")
        case .month: return L("stats.chart.month")
        }
    }

    static func empty(_ period: StatsPeriod) -> String {
        switch period {
        case .today: return L("stats.empty.today")
        case .week: return L("stats.empty.week")
        case .month: return L("stats.empty.month")
        case .all: return L("stats.empty.all")
        }
    }
}

/// Whether a chart's marks have grown in yet. They start at zero and spring to their values the
/// first time the chart is on screen, on `Theme.Motion.count` — the same curve the tiles count up
/// on, so the page arrives as one motion. Reduce Motion draws them at their values at once.
private struct GrowIn: ViewModifier {
    @Binding var grown: Bool
    var delay: Double = 0.1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.onAppear {
            guard !grown else { return }
            if reduceMotion { grown = true } else {
                withAnimation(Theme.Motion.count.delay(delay)) { grown = true }
            }
        }
    }
}

/// The period's bars: one per hour, day, week or month. Categorical on the x axis, labelled in
/// the interface language — hours as 00–23 (every third shown), days and weeks by their date,
/// months by month and year — so no label depends on ICU guessing an axis stride.
struct PeriodChart: View {
    let bars: [UsageStats.Bar]
    let unit: StatsBucketUnit
    /// Said over the axes, calmly, when the period has no dictation at all.
    let empty: String
    @State private var grown = false

    /// A fixed top for the y axis. Left automatic, the axis would rescale with every frame of the
    /// grow-in — the bars would sit at full height while the gridlines slid under them.
    private var top: Int {
        let peak = max(1, bars.map(\.dictations).max() ?? 1)
        let raw = Double(peak) / 4
        let magnitude = pow(10, floor(log10(max(raw, 0.25))))
        let step = [1, 2, 2.5, 5, 10].map { $0 * magnitude }.first { $0 >= raw } ?? raw
        return max(1, Int((ceil(Double(peak) / step) * step).rounded()))
    }

    /// The label under one bar. Unique within a chart: a categorical axis merges equal labels.
    static func label(_ bar: UsageStats.Bar, unit: StatsBucketUnit) -> String {
        switch unit {
        case .hour: return String(format: "%02d", bar.index)
        case .day, .week: return LocalFormat.date(bar.start, .dateTime.day().month(.abbreviated))
        case .month: return LocalFormat.date(bar.start, .dateTime.month(.abbreviated).year(.twoDigits))
        }
    }

    /// Which labels the axis prints: every third hour; for dates about six, counted back from
    /// the latest, which is always shown.
    static func shownLabels(_ bars: [UsageStats.Bar], unit: StatsBucketUnit) -> [String] {
        let every = unit == .hour ? 3 : max(1, Int((Double(bars.count) / 6).rounded(.up)))
        return bars.filter { unit == .hour ? $0.index % every == 0 : (bars.count - 1 - $0.index) % every == 0 }
            .map { label($0, unit: unit) }
    }

    private var isEmpty: Bool { bars.allSatisfy { $0.dictations == 0 } }

    var body: some View {
        Chart(bars) { bar in
            BarMark(x: .value("Bucket", Self.label(bar, unit: unit)),
                    y: .value("Dictations", grown ? bar.dictations : 0),
                    width: .ratio(0.62))
                .foregroundStyle(
                    LinearGradient(colors: bar.isCurrent
                                   ? [Theme.Palette.accent, Theme.Palette.accent.opacity(0.7)]
                                   : [Theme.Palette.accent.opacity(0.78), Theme.Palette.accent.opacity(0.38)],
                                   startPoint: .top, endPoint: .bottom))
                .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Theme.Palette.hairline)
                AxisValueLabel()
                    .foregroundStyle(Theme.Palette.tertiary)
                    .font(Theme.Typeface.caption)
            }
        }
        .chartXAxis {
            AxisMarks(values: Self.shownLabels(bars, unit: unit)) { value in
                // The latest bar sits at the plot's right edge: its label hangs left from the
                // bar rather than centring on it, or the edge cuts it to "30…".
                let latest = value.as(String.self) == lastLabel && unit != .hour
                AxisValueLabel(centered: false, anchor: latest ? .topTrailing : .top) {
                    if let text = value.as(String.self) {
                        Text(text)
                            .foregroundStyle(currentLabel == text ? Theme.Palette.accent
                                             : Theme.Palette.tertiary)
                    }
                }
                .font(Theme.Typeface.caption)
            }
        }
        .chartYScale(domain: 0...top)
        .overlay {
            if isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "chart.bar")
                        .font(.system(size: 20, weight: .light))
                        .foregroundStyle(Theme.Palette.tertiary)
                    Text(empty)
                        .font(Theme.Typeface.callout)
                        .foregroundStyle(Theme.Palette.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.bottom, 16)
                .transition(.opacity)
            }
        }
        .modifier(GrowIn(grown: $grown))
    }

    private var lastLabel: String? { bars.last.map { Self.label($0, unit: unit) } }

    private var currentLabel: String? {
        bars.first(where: \.isCurrent).map { Self.label($0, unit: unit) }
    }
}

/// A horizontal proportion bar per key: label, bar, percentage. Reads faster than a pie at a
/// glance, and stays legible at 720 points.
private struct ShareBars: View {
    let shares: [UsageStats.Share]
    let name: (String) -> String
    @State private var grown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if shares.isEmpty {
            Footnote(L("stats.noDictations"))
        } else {
            VStack(spacing: 10) {
                ForEach(Array(shares.prefix(5).enumerated()), id: \.element.id) { index, share in
                    let tint = Theme.Palette.series[index % Theme.Palette.series.count]
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(name(share.key))
                                .font(Theme.Typeface.callout.weight(.medium))
                                .foregroundStyle(Theme.Palette.text)
                            Spacer()
                            Text(Names.count(share.count) + " · "
                                 + share.fraction.formatted(.percent.precision(.fractionLength(0))
                                    .locale(Localizer.shared.locale)))
                                .font(Theme.Typeface.caption.monospacedDigit())
                                .foregroundStyle(Theme.Palette.secondary)
                        }
                        GeometryReader { proxy in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Theme.Palette.raised)
                                Capsule().fill(tint)
                                    .frame(width: max(4, proxy.size.width
                                                      * (grown ? share.fraction : 0)))
                                    // One after another, top to bottom.
                                    .animation(reduceMotion ? nil
                                               : Theme.Motion.count.delay(0.15 + Double(index) * 0.06),
                                               value: grown)
                            }
                        }
                        .frame(height: 6)
                    }
                }
            }
            .onAppear { grown = true }
        }
    }
}

private struct StageChart: View {
    let stages: [UsageStats.StageTime]
    @State private var grown = false

    var body: some View {
        if stages.isEmpty {
            Footnote(L("stats.noTimings"))
        } else {
            Chart(stages) { stage in
                BarMark(x: .value("Milliseconds", grown ? stage.medianMillis : 0),
                        y: .value("Stage", Names.stage(stage.stage)),
                        height: .fixed(14))
                    .foregroundStyle(stage.stage == "polishing"
                                     ? Theme.Palette.series[2] : Theme.Palette.accent)
                    .clipShape(Capsule())
                    .annotation(position: .trailing, spacing: 6) {
                        Text(Names.millis(stage.medianMillis))
                            .font(Theme.Typeface.caption.monospacedDigit())
                            .foregroundStyle(Theme.Palette.secondary)
                    }
            }
            .chartXAxis(.hidden)
            // Fixed, for the same reason as the per-day chart; the headroom is the annotation's.
            .chartXScale(domain: 0...max(1, (stages.map(\.medianMillis).max() ?? 1) * 1.18))
            .modifier(GrowIn(grown: $grown, delay: 0.2))
            .chartYAxis {
                AxisMarks { _ in
                    AxisValueLabel()
                        .foregroundStyle(Theme.Palette.secondary)
                        .font(Theme.Typeface.callout)
                }
            }
        }
    }
}
