import KotibaCore
import SwiftUI

// History: everything dictated, searchable in every language (FTS5 with `unicode61`, so Uzbek
// suffixes are not stemmed away — see History.swift). Ported from the old History tab: the search,
// the "Keep history" switch, copy and delete. New: each row carries its mode and its key-up-to-paste
// time, joined from the diagnostics log by start time (`UsageModel.record(for:)`).

struct HistoryPane: View {
    let controller: DictationController
    let usage: UsageModel
    @State private var query = ""
    @State private var results: [HistoryEntry] = []

    private var shown: [HistoryEntry] { query.isEmpty ? controller.history : results }

    var body: some View {
        Pane(title: L("section.history"),
             subtitle: Lp("history.subtitle", controller.history.count)) {
            HStack(spacing: Theme.Space.m) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.Palette.tertiary)
                    TextField(L("history.search"), text: $query)
                        .textFieldStyle(.plain)
                        .font(Theme.Typeface.body)
                    if !query.isEmpty {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(Theme.Palette.tertiary)
                        }
                        .buttonStyle(.plain)
                        .transition(.opacity)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Theme.Palette.surface, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.Palette.hairline, lineWidth: 1))

                Toggle(L("settings.keepHistory"), isOn: controller.settings.bound(\.keepHistory))
                    .toggleStyle(KotibaSwitchStyle())
                    .font(Theme.Typeface.callout)
                    .foregroundStyle(Theme.Palette.secondary)
                    .fixedSize()
            }

            if shown.isEmpty {
                empty
            } else {
                LazyVStack(spacing: Theme.Space.s) {
                    ForEach(shown) { entry in
                        HistoryRow(entry: entry, record: usage.record(for: entry),
                                   modes: controller.modes) {
                            Task {
                                await controller.deleteHistory(id: entry.id)
                                // Search results are a copy: a row deleted from them used to stay
                                // on screen, already gone from the database.
                                results.removeAll { $0.id == entry.id }
                            }
                        }
                        .transition(.asymmetric(insertion: .opacity.combined(with: .move(edge: .top)),
                                                removal: .opacity.combined(with: .scale(scale: 0.96))))
                    }
                }
                .animation(Theme.Motion.smooth, value: shown.map(\.id))
            }
        }
        .onChange(of: query) { _, new in
            Task {
                let found = await controller.searchHistory(new)
                // One search per keystroke, and they can finish out of order: only the answer to
                // what is in the field now may land.
                if query == new { results = found }
            }
        }
    }

    private var empty: some View {
        VStack(spacing: Theme.Space.m) {
            Image(systemName: query.isEmpty ? "text.quote" : "magnifyingglass")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(Theme.Palette.tertiary)
            Text(query.isEmpty ? L("history.empty") : L("history.noMatches"))
                .font(Theme.Typeface.headline)
                .foregroundStyle(Theme.Palette.text)
            Text(query.isEmpty
                 ? (controller.settings.keepHistory
                    ? L("history.empty.hint", Names.hotkey(controller.settings))
                    : L("history.off"))
                 : L("history.search.hint"))
                .font(Theme.Typeface.callout)
                .foregroundStyle(Theme.Palette.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }
}

struct HistoryRow: View {
    let entry: HistoryEntry
    let record: DictationRecord?
    let modes: ModeRegistry
    let delete: () -> Void
    @State private var hovering = false
    @State private var copied = false
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(entry.final)
                .font(Theme.Typeface.body)
                .foregroundStyle(Theme.Palette.text)
                .lineSpacing(2)
                .lineLimit(expanded ? nil : 3)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .transcriptDirection(entry.final)
                .onTapGesture(count: 2) {
                    withAnimation(Theme.Motion.smooth) { expanded.toggle() }
                }

            HStack(spacing: 6) {
                Text(LocalFormat.date(entry.startedAt,
                                      .dateTime.day().month(.abbreviated).hour().minute()))
                    .font(Theme.Typeface.caption)
                    .foregroundStyle(Theme.Palette.tertiary)
                    .lineLimit(1)
                Badge(text: Names.languageCode(entry.language))
                if let mode = record?.modeKey {
                    Badge(text: Names.mode(mode, in: modes).uppercased())
                }
                if let millis = record?.releaseToPasteMillis {
                    Badge(text: Names.millis(millis), tint: Theme.Palette.accent)
                        .help(L("history.latency.help"))
                }
                Text(L("history.spoken", Names.number(entry.audioSeconds, digits: 1)))
                    .font(Theme.Typeface.caption)
                    .foregroundStyle(Theme.Palette.tertiary)
                    .lineLimit(1)
                    .layoutPriority(-1)
                Spacer(minLength: 0)
                HStack(spacing: 6) {
                    IconButton(systemImage: copied ? "checkmark" : "doc.on.doc", help: L("common.copy"),
                               tint: copied ? Theme.Palette.accent : Theme.Palette.secondary) {
                        Clipboard.copy(entry.final)
                        withAnimation(Theme.Motion.snappy) { copied = true }
                        Task {
                            try? await Task.sleep(for: .seconds(1.2))
                            withAnimation(Theme.Motion.snappy) { copied = false }
                        }
                    }
                    IconButton(systemImage: "trash", help: L("common.delete"), tint: Theme.Palette.danger,
                               action: delete)
                }
                .opacity(hovering || copied ? 1 : 0.35)
            }
        }
        .padding(Theme.Space.m + 2)
        .background(hovering ? Theme.Palette.raised : Theme.Palette.surface,
                    in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 1))
        .onHover { hovering = $0 }
        .animation(Theme.Motion.snappy, value: hovering)
        .contextMenu {
            Button(L("common.copy")) { Clipboard.copy(entry.final) }
            if entry.polished != nil {
                Button(L("history.copyRaw")) { Clipboard.copy(entry.result) }
            }
            Divider()
            Button(L("common.delete"), role: .destructive, action: delete)
        }
    }
}
