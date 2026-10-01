import KotibaCore
import SwiftUI

#if os(macOS)
import AppKit
#endif

// The handful of building blocks every pane is made of. Custom rather than `Form(.grouped)`,
// because a grouped form paints its own grey plates and cannot sit on pure black — and because a
// switch, a chip row and a button that all move with the same spring are most of what makes the
// window feel like one thing.

// MARK: - Pane scaffold

/// A scrolling pane: a title, an optional one-line subtitle, then cards. Content is capped at a
/// readable width and centred, so a wide window gets black margins rather than 1,600-point lines.
struct Pane<Content: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.l) {
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    Text(title)
                        .font(Theme.Typeface.display)
                        .foregroundStyle(Theme.Palette.text)
                    if let subtitle {
                        Text(subtitle)
                            .font(Theme.Typeface.body)
                            .foregroundStyle(Theme.Palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.bottom, Theme.Space.xs)
                content
            }
            .frame(maxWidth: Theme.Breakpoint.readableWidth, alignment: .leading)
            .padding(.horizontal, Theme.Space.xl)
            .padding(.top, Theme.Space.xl + Theme.Space.s)
            .padding(.bottom, Theme.Space.xxl)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.automatic)
        .scrollContentBackground(.hidden)
        .background(Theme.Palette.background)
    }
}

// MARK: - Card

/// One idea per card. Lifted off black by a step of grey and a hairline, never by a shadow.
struct Card<Content: View>: View {
    var title: String?
    var subtitle: String?
    var systemImage: String?
    var padding: CGFloat = Theme.Space.l
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            if let title {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                    if let systemImage {
                        Image(systemName: systemImage)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.Palette.accent)
                            .frame(width: 16)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(Theme.Typeface.headline)
                            .foregroundStyle(Theme.Palette.text)
                        if let subtitle {
                            Text(subtitle)
                                .font(Theme.Typeface.caption)
                                .foregroundStyle(Theme.Palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            content
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Palette.surface,
                    in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 1))
    }
}

/// The hairline between rows inside a card.
struct Hairline: View {
    var body: some View {
        Rectangle().fill(Theme.Palette.hairline).frame(height: 1)
    }
}

// MARK: - Rows

/// A label on the left, a control on the right, an explanation under the label. The label wraps
/// rather than clipping when the window is narrow; the control keeps its size.
struct SettingRow<Control: View>: View {
    let title: String
    var detail: String?
    @ViewBuilder var control: Control

    var body: some View {
        HStack(alignment: .center, spacing: Theme.Space.l) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(Theme.Typeface.body)
                    .foregroundStyle(Theme.Palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(Theme.Typeface.caption)
                        .foregroundStyle(Theme.Palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            control
                .fixedSize()
        }
    }
}

/// A toggle row: the commonest thing in the window, so it gets its own spelling.
struct ToggleRow: View {
    let title: String
    var detail: String?
    @Binding var isOn: Bool

    var body: some View {
        SettingRow(title: title, detail: detail) {
            Toggle("", isOn: $isOn).labelsHidden().toggleStyle(KotibaSwitchStyle())
        }
    }
}

/// Explanatory small print under a control.
struct Footnote: View {
    let text: String
    var tint: Color = Theme.Palette.tertiary

    init(_ text: String, tint: Color = Theme.Palette.tertiary) {
        self.text = text
        self.tint = tint
    }

    var body: some View {
        Text(text)
            .font(Theme.Typeface.caption)
            .foregroundStyle(tint)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Switch

/// The accent switch. Drawn rather than borrowed so it is the icon's green, not the system
/// accent, and so its knob rides the same spring as every other control.
struct KotibaSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        SwitchBody(configuration: configuration)
    }

    private struct SwitchBody: View {
        let configuration: ToggleStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false

        var body: some View {
            HStack(spacing: Theme.Space.s) {
                configuration.label
                ZStack(alignment: configuration.isOn ? .trailing : .leading) {
                    Capsule()
                        .fill(configuration.isOn ? Theme.Palette.accent : Theme.Palette.elevated)
                        .overlay(Capsule().strokeBorder(
                            configuration.isOn ? .clear : Theme.Palette.hairlineStrong,
                            lineWidth: 1))
                    Circle()
                        .fill(configuration.isOn ? Theme.Palette.accentInk : Color.white.opacity(0.85))
                        .padding(3)
                        .shadow(color: .black.opacity(0.35), radius: 1.5, y: 1)
                }
                .frame(width: 36, height: 21)
                .overlay(Capsule().fill(Color.white.opacity(hovering ? 0.06 : 0)))
                .opacity(isEnabled ? 1 : 0.4)
                .contentShape(Capsule())
                .onTapGesture {
                    withAnimation(Theme.Motion.snappy) { configuration.isOn.toggle() }
                }
                .onHover { hovering = $0 }
                .animation(Theme.Motion.snappy, value: configuration.isOn)
                .accessibilityElement()
                .accessibilityAddTraits(.isButton)
                .accessibilityValue(configuration.isOn ? L("common.on") : L("common.off"))
            }
        }
    }
}

// MARK: - Chips

/// A segmented control that slides a single accent capsule between options. Falls back to a
/// menu when the options do not fit the width they are given — see `AdaptivePicker`.
struct ChipPicker<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(value: Value, label: String)]
    /// Options that exist but cannot be chosen right now (a language with no model).
    var disabled: Set<Value> = []
    @Namespace private var namespace

    var body: some View {
        HStack(spacing: 2) {
            // Keyed by value, not position, so a reordered list (the language pickers) glides
            // each chip to its new place instead of rewriting them in place.
            ForEach(options, id: \.value) { option in
                let selected = option.value == selection
                let isDisabled = disabled.contains(option.value)
                Button {
                    withAnimation(Theme.Motion.snappy) { selection = option.value }
                } label: {
                    Text(option.label)
                        .font(.system(size: 12, weight: selected ? .semibold : .medium))
                        .lineLimit(1)
                        .foregroundStyle(selected ? Theme.Palette.accentInk
                                         : isDisabled ? Theme.Palette.tertiary
                                         : Theme.Palette.secondary)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 5)
                        .background {
                            if selected {
                                Capsule()
                                    .fill(Theme.Palette.accent)
                                    .matchedGeometryEffect(id: "chip", in: namespace)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isDisabled)
            }
        }
        .animation(Theme.Motion.smooth, value: options.map(\.value))
        .padding(3)
        .background(Theme.Palette.raised, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.Palette.hairline, lineWidth: 1))
    }
}

/// Chips when they fit, a menu when they do not. The window is resizable down to 720 points, and
/// a four-option chip row clipped at the edge is the failure this exists to avoid.
struct AdaptivePicker<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(value: Value, label: String)]
    var disabled: Set<Value> = []

    var body: some View {
        ViewThatFits(in: .horizontal) {
            ChipPicker(selection: $selection, options: options, disabled: disabled)
            MenuPicker(selection: $selection, options: options, disabled: disabled)
        }
    }
}

/// A compact dropdown, styled to sit on black.
struct MenuPicker<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(value: Value, label: String)]
    var disabled: Set<Value> = []

    var body: some View {
        Menu {
            ForEach(options.indices, id: \.self) { index in
                let option = options[index]
                Button {
                    withAnimation(Theme.Motion.snappy) { selection = option.value }
                } label: {
                    if option.value == selection {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Text(option.label)
                    }
                }
                .disabled(disabled.contains(option.value))
            }
        } label: {
            HStack(spacing: 6) {
                Text(options.first { $0.value == selection }?.label ?? "—")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.Palette.text)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.Palette.secondary)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .background(Theme.Palette.raised, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.Palette.hairline, lineWidth: 1))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

// MARK: - Buttons

struct KotibaButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, ghost, destructive }
    var kind: Kind = .secondary
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        StyledButton(configuration: configuration, kind: kind, compact: compact)
    }

    private struct StyledButton: View {
        let configuration: ButtonStyleConfiguration
        let kind: Kind
        let compact: Bool
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(.system(size: compact ? 11 : 12, weight: .semibold))
                .lineLimit(1)
                .foregroundStyle(foreground)
                .padding(.horizontal, compact ? 10 : 14)
                .padding(.vertical, compact ? 4 : 7)
                .background(background, in: Capsule())
                // A white wash for hover rather than `.brightness`: that modifier rasterises the
                // button into its own bounds and shaved the stroke off both ends.
                .background(Color.white.opacity(hovering && isEnabled ? 0.07 : 0), in: Capsule())
                .overlay(Capsule().strokeBorder(border, lineWidth: 1))
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .opacity(isEnabled ? 1 : 0.4)
                .contentShape(Capsule())
                .onHover { hovering = $0 }
                .animation(Theme.Motion.snappy, value: configuration.isPressed)
                .animation(Theme.Motion.snappy, value: hovering)
        }

        private var foreground: Color {
            switch kind {
            case .primary: return Theme.Palette.accentInk
            case .secondary: return Theme.Palette.text
            case .ghost: return Theme.Palette.secondary
            case .destructive: return Theme.Palette.danger
            }
        }

        private var background: Color {
            switch kind {
            case .primary: return Theme.Palette.accent
            case .secondary: return Theme.Palette.elevated
            case .ghost: return .clear
            case .destructive: return Theme.Palette.dangerSoft
            }
        }

        private var border: Color {
            switch kind {
            case .primary: return .clear
            case .secondary: return Theme.Palette.hairlineStrong
            case .ghost: return Theme.Palette.hairline
            case .destructive: return .clear
            }
        }
    }
}

extension ButtonStyle where Self == KotibaButtonStyle {
    static var kotibaPrimary: KotibaButtonStyle { KotibaButtonStyle(kind: .primary) }
    static var kotiba: KotibaButtonStyle { KotibaButtonStyle(kind: .secondary) }
    static var kotibaGhost: KotibaButtonStyle { KotibaButtonStyle(kind: .ghost) }
    static var kotibaDestructive: KotibaButtonStyle { KotibaButtonStyle(kind: .destructive) }
    static var kotibaSmall: KotibaButtonStyle { KotibaButtonStyle(kind: .secondary, compact: true) }
}

/// A round icon button — copy, delete, reveal.
struct IconButton: View {
    let systemImage: String
    var help: String
    var tint: Color = Theme.Palette.secondary
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(hovering ? Theme.Palette.text : tint)
                .frame(width: 26, height: 26)
                .background(hovering ? Theme.Palette.elevated : Theme.Palette.raised, in: Circle())
                .overlay(Circle().strokeBorder(Theme.Palette.hairline, lineWidth: 1))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(help)
        .onHover { hovering = $0 }
        .animation(Theme.Motion.snappy, value: hovering)
    }
}

// MARK: - Badges and status

struct Badge: View {
    let text: String
    var tint: Color = Theme.Palette.secondary
    var filled = false

    var body: some View {
        Text(text)
            .font(Theme.Typeface.micro)
            .tracking(0.3)
            .lineLimit(1)
            .foregroundStyle(filled ? Theme.Palette.accentInk : tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(filled ? tint : tint.opacity(0.13), in: Capsule())
    }
}

/// A coloured dot with a label: "Ready", "Missing", "Loaded".
struct StatusDot: View {
    enum Tone { case good, warning, bad, neutral }
    let text: String
    let tone: Tone
    var pulsing = false

    private var color: Color {
        switch tone {
        case .good: return Theme.Palette.accent
        case .warning: return Theme.Palette.amber
        case .bad: return Theme.Palette.danger
        case .neutral: return Theme.Palette.tertiary
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
                .shadow(color: tone == .good ? Theme.Palette.accentGlow : .clear, radius: 4)
                .phaseAnimator(pulsing ? [0.35, 1.0] : [1.0]) { dot, phase in
                    dot.opacity(phase)
                } animation: { _ in .easeInOut(duration: 0.8) }
            Text(text)
                .font(Theme.Typeface.callout.weight(.medium))
                .foregroundStyle(color == Theme.Palette.tertiary ? Theme.Palette.secondary : color)
                .lineLimit(1)
        }
    }
}

/// A keyboard key, drawn. Used wherever the hotkey is named.
struct Keycap: View {
    let label: String
    var large = false

    var body: some View {
        Text(label)
            .font(.system(size: large ? 22 : 12, weight: .semibold, design: .rounded))
            .foregroundStyle(Theme.Palette.text)
            .padding(.horizontal, large ? 18 : 8)
            .padding(.vertical, large ? 12 : 4)
            .frame(minWidth: large ? 64 : 26)
            .background(
                RoundedRectangle(cornerRadius: large ? 12 : 6, style: .continuous)
                    .fill(LinearGradient(colors: [Theme.Palette.elevated, Theme.Palette.raised],
                                         startPoint: .top, endPoint: .bottom)))
            .overlay(
                RoundedRectangle(cornerRadius: large ? 12 : 6, style: .continuous)
                    .strokeBorder(Theme.Palette.hairlineStrong, lineWidth: 1))
            .shadow(color: .black.opacity(0.6), radius: 0, y: large ? 3 : 2)
    }
}

/// A big number with a label.
///
/// When it is given the number behind the text, it counts up to it the first time it appears —
/// soft, ~0.8 s, eased, and staggered by `order` so a row of tiles fills left to right — and fades
/// and rises into place with it. Afterwards a changed count glides from the old value to the new.
/// The text is a fixed height and `monospacedDigit`, so nothing around it moves while it counts.
/// Reduce Motion shows the number at once.
struct StatTile: View {
    let title: String
    let value: String
    var caption: String?
    var systemImage: String?
    /// The number `value` shows, and how to format any value on the way to it.
    var counting: Counting?
    /// Position in its row, for the stagger.
    var order = 0

    struct Counting {
        let number: Double
        let format: (Double) -> String
    }

    @State private var appeared = false
    @State private var shown: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.Palette.accent)
                }
                Text(title.uppercased())
                    .font(Theme.Typeface.micro)
                    .tracking(0.6)
                    .foregroundStyle(Theme.Palette.tertiary)
                    .lineLimit(1)
            }
            Group {
                if let counting {
                    CountingText(value: shown, format: counting.format)
                } else {
                    Text(value).contentTransition(.numericText())
                }
            }
            .font(Theme.Typeface.metric)
            .monospacedDigit()
            .foregroundStyle(Theme.Palette.text)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            if let caption {
                Text(caption)
                    .font(Theme.Typeface.caption)
                    .foregroundStyle(Theme.Palette.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Theme.Space.l)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Theme.Palette.surface,
                    in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 1))
        .opacity(appeared || reduceMotion ? 1 : 0)
        .offset(y: appeared || reduceMotion ? 0 : 8)
        .onAppear {
            let target = counting?.number ?? 0
            guard !reduceMotion else { shown = target; appeared = true; return }
            let delay = Double(order) * 0.07
            withAnimation(Theme.Motion.smooth.delay(delay)) { appeared = true }
            withAnimation(Theme.Motion.count.delay(delay + 0.05)) { shown = target }
        }
        .onChange(of: counting?.number) { _, number in
            guard let number else { return }
            if reduceMotion { shown = number } else {
                withAnimation(Theme.Motion.count) { shown = number }
            }
        }
    }
}

/// Text for a number that is animating: SwiftUI interpolates `value` and the text is re-drawn
/// for each step, formatted exactly as the final value will be.
struct CountingText: View, Animatable {
    var value: Double
    let format: (Double) -> String

    var animatableData: Double {
        get { value }
        set { value = newValue }
    }

    var body: some View {
        Text(format(value))
    }
}

// MARK: - Brand

/// Kotiba's own icon — the split nib on dark teal — rounded the way the Dock rounds it. Used at
/// the top of the sidebar, in onboarding and in About, where a generic waveform tile used to be.
struct BrandMark: View {
    var size: CGFloat = 30

    var body: some View {
        Group {
            if let image = Self.image {
                image.resizable().interpolation(.high).aspectRatio(contentMode: .fill)
            } else {
                Theme.Palette.accent
            }
        }
        .frame(width: size, height: size)
        // The Dock's continuous corner: 22.5% of the side.
        .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        .shadow(color: Theme.Palette.accentGlow.opacity(0.6), radius: size * 0.22)
        .accessibilityLabel("Kotiba")
    }

    /// The icon file. See the note on the resource in Package.swift.
    static var resourceURL: URL? { Bundle.module.url(forResource: "BrandMark", withExtension: "png") }

    /// Loaded once.
    static let image: Image? = {
        guard let url = resourceURL else { return nil }
        #if os(macOS)
        return NSImage(contentsOf: url).map { Image(nsImage: $0) }
        #else
        return UIImage(contentsOfFile: url.path).map { Image(uiImage: $0) }
        #endif
    }()
}

// MARK: - Notices

/// Something the user has to do, said small and calm: an icon, a sentence, the detail under it
/// (two lines, the rest on a click), and the one button that fixes it. Replaces the "Needs your
/// attention" panel; see `DictationController.blockers` for what may be one of these.
struct NoticeRow: View {
    let blocker: DictationController.Blocker
    var onGrant: () -> Void = {}
    /// A section of the window that fixes it, when that is where the fix is (a missing model).
    var open: (() -> Void)?
    /// The button's words when "Open" is not enough to say where it goes ("Open Sound settings").
    var actionTitle: String?
    /// A small ✕ for a notice that is advice rather than a blocker: the person may send it away.
    var dismiss: (() -> Void)?
    @State private var expanded = false
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.m) {
            Image(systemName: Self.symbol(for: blocker.id))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.Palette.amber.opacity(0.9))
                .frame(width: 24, height: 24)
                .background(Theme.Palette.amberSoft, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(blocker.title)
                    .font(Theme.Typeface.callout.weight(.semibold))
                    .foregroundStyle(Theme.Palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text(blocker.detail)
                    .font(Theme.Typeface.caption)
                    .foregroundStyle(Theme.Palette.secondary)
                    .lineLimit(expanded ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .onTapGesture { withAnimation(Theme.Motion.smooth) { expanded.toggle() } }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            action
            if let dismiss {
                Button(action: dismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.Palette.tertiary)
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("common.dismiss"))
            }
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, 10)
        .background(hovering ? Theme.Palette.raised : Theme.Palette.surface,
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 1))
        .onHover { hovering = $0 }
        .animation(Theme.Motion.snappy, value: hovering)
    }

    @ViewBuilder
    private var action: some View {
        #if os(macOS)
        if let urlString = blocker.settingsURL, let url = URL(string: urlString) {
            Button(RenameNotice.permissionBlockerIDs.contains(blocker.id)
                   || blocker.id == "renamed-regrant" ? L("onboarding.permissions.allow")
                   : actionTitle ?? L("common.open")) {
                // Ask first. The system dialog registers Kotiba in the list, so the pane that
                // opens behind it has a switch to flip rather than nothing at all.
                onGrant()
                NSWorkspace.shared.open(url)
            }
            .buttonStyle(.kotibaSmall)
        } else if let open {
            Button(L("common.open"), action: open).buttonStyle(.kotibaSmall)
        }
        #endif
    }

    static func symbol(for id: String) -> String {
        switch id {
        case "microphone": return "mic.fill"
        case "quiet-mic": return "mic.slash.fill"
        case "accessibility": return "accessibility"
        case "input-monitoring", "hotkey-tap": return "keyboard"
        case "renamed-regrant", "renamed-legacy-running": return "arrow.triangle.2.circlepath"
        case "uzbek-model", "russian-model": return "globe"
        case "no-polisher": return "wand.and.sparkles"
        default: return "exclamationmark"
        }
    }
}

// MARK: - Text input

/// A text field in an inset well.
struct WellField: View {
    let placeholder: String
    @Binding var text: String
    var secure = false
    var monospaced = false

    var body: some View {
        Group {
            if secure {
                SecureField(placeholder, text: $text)
            } else {
                TextField(placeholder, text: $text)
            }
        }
        .textFieldStyle(.plain)
        .font(monospaced ? Theme.Typeface.mono : Theme.Typeface.body)
        .foregroundStyle(Theme.Palette.text)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Theme.Palette.raised,
                    in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: 1))
    }
}

// MARK: - Grid

/// Two columns when there is room, one when there is not. Cards keep equal widths either way.
struct AdaptiveGrid<Content: View>: View {
    var minimumColumnWidth: CGFloat = 260
    var spacing: CGFloat = Theme.Space.m
    /// For a row of a known number of items — the four stat tiles. `.adaptive` alone makes as
    /// many columns as fit, and at the default 1000-pt window with overlay scroll bars five
    /// 138-pt columns fit: four tiles, an empty fifth column, and "KEY-UP TO TE…" truncated.
    /// With this set the grid uses the widest column count that divides it and fits (4, then 2,
    /// then 1), so the row always fills its width and never ends in a lone item.
    var maximumColumns: Int?
    @ViewBuilder var content: Content
    @State private var width: CGFloat = 0

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: spacing) {
            content
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private var columns: [GridItem] {
        guard let maximumColumns, width > 0 else {
            return [GridItem(.adaptive(minimum: minimumColumnWidth), spacing: spacing,
                             alignment: .top)]
        }
        let count = Self.columnCount(width: width, minimum: minimumColumnWidth,
                                     spacing: spacing, maximum: maximumColumns)
        return Array(repeating: GridItem(.flexible(), spacing: spacing, alignment: .top),
                     count: count)
    }

    /// The largest divisor of `maximum` whose columns are each at least `minimum` wide.
    static func columnCount(width: CGFloat, minimum: CGFloat, spacing: CGFloat,
                            maximum: Int) -> Int {
        let fitting = Int(((width + spacing) / (minimum + spacing)).rounded(.down))
        return (1...max(1, maximum)).last { maximum % $0 == 0 && $0 <= fitting } ?? 1
    }
}

// MARK: - Clipboard

enum Clipboard {
    static func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

extension View {
    /// The appearance every view in the window shares: pure black, forced dark.
    func kotibaWindowChrome() -> some View {
        self
            .background(Theme.Palette.background)
            .preferredColorScheme(.dark)
            .tint(Theme.Palette.accent)
    }
}

// MARK: - Transcript direction

extension View {
    /// An Arabic transcript is laid out right to left — right-aligned, its punctuation at the
    /// right end — inside the otherwise left-to-right window (D-11, C4 §9.5). Only the display:
    /// the text itself never carries a bidi control mark, since those are invisible, survive into
    /// the user's documents and break search. "Arabic" is most of its letters being Arabic, so a
    /// Latin name inside an Arabic sentence does not flip it, and neither does an Arabic word in
    /// an English one.
    func transcriptDirection(_ text: String) -> some View {
        environment(\.layoutDirection,
                    ScriptCheck.arabicShare(text) >= 0.5 ? .rightToLeft : .leftToRight)
    }
}

