import KotibaCore
import SwiftUI

// Settings › Languages: every model Kotiba fetches, one row each — what it is for, its size, its
// state and, while it downloads, its progress — with a button per missing one. It used to be the
// onboarding's "Download models" checklist as well; the checklist is gone (the core is no longer
// a choice), and what onboarding and Home show instead is `CoreReadyCard` below.

struct ModelsCard: View {
    let downloads: ModelDownloads
    /// The dictation languages that are on. A language's model row is listed only while a
    /// language it serves is on.
    var languages: LanguageSubset = .all

    private var items: [ModelDownloads.Item] {
        ModelDownloads.Item.displayOrder.filter { $0.isWanted(by: languages) }
    }

    var body: some View {
        Card(padding: Theme.Space.m) {
            ForEach(Array(items.enumerated()), id: \.element) { index, item in
                if index > 0 { Hairline() }
                row(item)
            }
            footer
        }
        .task {
            // Downloads also land from elsewhere — a first-use fetch, the other card — so the
            // state is re-read while the card is on screen.
            while !Task.isCancelled {
                await downloads.refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    @ViewBuilder
    private func row(_ item: ModelDownloads.Item) -> some View {
        let state = downloads.state(item)
        HStack(spacing: Theme.Space.m) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(item.title)
                        .font(Theme.Typeface.body.weight(.semibold))
                        .foregroundStyle(Theme.Palette.text)
                    Text("\(item.model) · \(Self.size(item.bytes))")
                        .font(Theme.Typeface.caption)
                        .foregroundStyle(Theme.Palette.tertiary)
                }
                Text(detail(item, state))
                    .font(Theme.Typeface.caption)
                    .foregroundStyle(tint(state))
                    .fixedSize(horizontal: false, vertical: true)
                if case .downloading(let bytes) = state {
                    ProgressView(value: Double(bytes), total: Double(max(1, item.bytes)))
                        .tint(Theme.Palette.accent)
                }
            }
            Spacer(minLength: Theme.Space.s)
            trailing(item, state)
        }
        .padding(.vertical, 2)
        .animation(Theme.Motion.snappy, value: state)
    }

    @ViewBuilder
    private func trailing(_ item: ModelDownloads.Item, _ state: ModelDownloads.State) -> some View {
        switch state {
        case .installed:
            StatusDot(text: L("models.installed"), tone: .good)
        case .queued:
            StatusDot(text: L("models.waiting"), tone: .neutral)
        case .downloading(let bytes):
            Text("\(Int(Double(bytes) / Double(max(1, item.bytes)) * 100))%")
                .font(Theme.Typeface.caption.monospacedDigit())
                .foregroundStyle(Theme.Palette.secondary)
        case .unavailable:
            StatusDot(text: L("models.notDownloadable"), tone: .warning)
        case .missing, .failed:
            Button(downloads.state(item) == .missing ? L("common.download") : L("common.retry")) {
                downloads.download([item])
            }
            .buttonStyle(KotibaButtonStyle(kind: .primary, compact: true))
        }
    }

    @ViewBuilder
    private var footer: some View {
        if downloads.running {
            HStack {
                // The run's own items are what is downloading.
                ProgressView(value: downloads.runFraction)
                    .tint(Theme.Palette.accent)
                Button(L("common.pause")) { downloads.cancel() }
                    .buttonStyle(.kotibaSmall)
            }
            Footnote(L("models.footer.running"))
        }
    }

    private func detail(_ item: ModelDownloads.Item, _ state: ModelDownloads.State) -> String {
        switch state {
        case .failed(let why): return why
        case .unavailable(let why): return why
        case .installed: return purpose(item)
        default: return purpose(item) + " " + item.without
        }
    }

    private func purpose(_ item: ModelDownloads.Item) -> String {
        switch item {
        case .parakeet: return L("models.purpose.parakeet")
        case .uzbek: return L("models.purpose.uzbek")
        case .speechDetector: return L("models.purpose.speechDetector")
        case .languageDetector: return L("models.purpose.languageDetector")
        case .modes: return L("models.purpose.modes")
        case .turkish: return L("models.purpose.turkish")
        case .arabic: return L("models.purpose.arabic")
        case .arabicModes: return L("models.purpose.arabicModes")
        }
    }

    private func tint(_ state: ModelDownloads.State) -> Color {
        switch state {
        case .failed: return Theme.Palette.danger
        default: return Theme.Palette.secondary
        }
    }

    static func size(_ bytes: Int64) -> String {
        bytes >= 1_000_000_000
            ? L("unit.gb", Names.number(Double(bytes) / 1e9, digits: 2))
            : bytes >= 1_000_000 ? L("unit.mb", Names.number(Double(bytes / 1_000_000), digits: 0))
            : L("unit.kb", Names.number(Double(max(1, bytes / 1000)), digits: 0))
    }
}


/// "Getting Kotiba ready — 1.9 GB": the core download as one calm bar (owner, 2026-10-02).
///
/// No list and no checkboxes — the core is what every user gets. It is on onboarding's last page
/// and on Home for as long as any of the core (for the languages that are on) is missing, and
/// vanishes when the last file lands. The bar runs over `ModelDownloads.total(of:)`, the files
/// still to come plus those this run has fetched, so neither the figure nor the bar jumps back as
/// rows finish. A launch resumes it by itself (`resumeRecommendedDownloads`); the button is for a
/// failure, or a run paused in Settings.
struct CoreReadyCard: View {
    let controller: DictationController

    private var core: Set<ModelDownloads.Item> {
        ModelDownloads.Item.core(for: controller.settings.languageSubset)
    }

    var body: some View {
        let models = controller.models!
        VStack(spacing: 0) {
            if models.checked, !models.allInstalled(core) {
                card(models)
                    .transition(.opacity.combined(with: .offset(y: -6)))
            }
        }
        .animation(Theme.Motion.smooth, value: models.allInstalled(core))
        .task {
            // Rows land from elsewhere too (a Settings button, a launch resume), so the state is
            // re-read while the card could be on screen.
            while !Task.isCancelled {
                await models.refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func card(_ models: ModelDownloads) -> some View {
        let fraction = models.fraction(of: core)
        let failure = models.failure(in: core)
        return Card(padding: Theme.Space.l) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                Image(systemName: "arrow.down.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Palette.accent)
                Text(L("core.title", ModelsCard.size(models.total(of: core))))
                    .font(Theme.Typeface.headline)
                    .foregroundStyle(Theme.Palette.text)
                Spacer(minLength: Theme.Space.s)
                Text("\(Int(fraction * 100))%")
                    .font(Theme.Typeface.caption.monospacedDigit())
                    .foregroundStyle(Theme.Palette.secondary)
            }
            ProgressView(value: fraction)
                .tint(Theme.Palette.accent)
                .animation(Theme.Motion.smooth, value: fraction)
            if let failure {
                Footnote(L("core.failed", failure), tint: Theme.Palette.danger)
            }
            HStack(alignment: .top, spacing: Theme.Space.m) {
                Footnote(L("core.detail"))
                if !models.running {
                    Spacer(minLength: 0)
                    Button(failure == nil ? L("core.resume") : L("common.retry")) {
                        models.download(core)
                    }
                    .buttonStyle(KotibaButtonStyle(kind: .primary, compact: true))
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}
