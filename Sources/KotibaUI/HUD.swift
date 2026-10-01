import KotibaCore
import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

// Task U-05, rebuilt for 1.0; moved to the bottom of the screen and cleared of labels on the
// owner's review of 2026-09-30.
//
// A black capsule, 160 × 36 points, that rises from the bottom of the screen — centred, above the
// Dock — while you talk. It carries one thing: the voice animation, across its whole width. The
// language code and the mode glyph that used to flank it are gone: nobody looks at a pill to read
// a two-letter code, and the menu, Home and History already say which language and mode ran. The
// rules the old HUD lived by all still hold:
//
//   * **It never takes focus.** The text lands in the app the user was already in. Enforced by
//     `HUDPanel`, below, not by the view.
//   * **It is purely observational.** It reads `status`, `level` and `lastRecord`, and writes
//     nothing the pipeline reads. The animation's physics run in the view's own frame clock; a
//     dropped frame here can never be a dropped word.
//
// States: listening is the live, level-driven animation (`PillAnimationStyle`, the user's choice in
// Settings); processing is the same animation settled and quieter; success is a check and the
// key-up-to-paste time, then the capsule sinks back down; "copied" says softly that there was no
// text field to paste into, so the words are on the clipboard; heard-nothing and failure turn
// amber and sink away.
//
// A message is a glance, not a report: a few words ("Couldn’t paste"), the reason on Home. The
// capsule still has to hold the longest of them in four languages, so it measures the words
// (`PillMessageLayout`) and grows to fit — wider first, up to 360 points or the screen less its
// margins, then onto a second line with the breaks balanced — on the same spring as every other
// change of shape. Nothing is cut mid-word and nothing spills past the capsule.

// MARK: - What the pill shows

/// The pill's state, as a value — so it can be rendered without a controller, by the snapshot
/// harness and by tests, and so the view can animate between two states rather than between two
/// controller readings.
public enum PillState: Equatable, Sendable {
    case listening
    /// A model loading, transcription, polish, paste — anything between key-up and text.
    case processing
    /// Pasted. `millis` is key-up to paste, when the record has it.
    case success(millis: Double?)
    /// Finished, but no text field had focus: the text is on the clipboard and in History. Not a
    /// failure and not amber — the words are safe, they are just not typed anywhere.
    case copied
    /// Heard nothing, or something failed. Amber either way; the message says which.
    case attention(String)
    /// Nothing to show: the capsule folds away.
    case hidden

    /// How long an outcome stays before folding away. `nil` means "until the state changes".
    var dwell: Duration? {
        switch self {
        case .success: return .milliseconds(900)
        case .copied, .attention: return .milliseconds(2200)
        default: return nil
        }
    }

    /// What the pill says when a dictation had nowhere to go. Short enough for one line.
    static var copiedMessage: String { L("pill.copied") }
}

extension PillState {
    /// The pill for a controller status. `copied` is `DictationController.lastWentToClipboard`.
    init(status: DictationController.Status, record: DictationRecord?, copied: Bool = false,
         quietMic: InputDeviceInfo? = nil) {
        switch status {
        case .listening: self = .listening
        case .preparing, .working: self = .processing
        case .succeeded: self = copied ? .copied : .success(millis: record?.releaseToPasteMillis)
        // A take that was a real hold and barely registered says which microphone instead —
        // `DictationController.quietMicForPill`, rate-limited to once per device per hour.
        case .heardNothing:
            self = .attention(quietMic.map { L("pill.quietMic", QuietMic.pillName($0.name)) }
                              ?? L("pill.heardNothing"))
        // The pill's few words, never the whole sentence: that is Home's.
        case .failed(_, let pill): self = .attention(pill ?? L("pill.failed.generic"))
        case .idle: self = .hidden
        }
    }
}

// MARK: - Presentation

/// Whether the panel is on screen, owned by `HUDPanel` and read by the view so the capsule can
/// spring up from the bottom edge on show and back down on hide.
@Observable
public final class PillPresence {
    public var presented = false
    /// How wide a message may push the capsule on the screen it is on: 360 points, or that
    /// screen's width less a margin each side when the screen is narrower.
    public var maxMessageWidth: CGFloat = PillView.maxMessageWidth
    public init() {}
}

// MARK: - The controller-bound view

public struct HUDView: View {

    private let controller: DictationController
    private let presence: PillPresence
    /// Set when an outcome has been on screen for its dwell time. Cleared by any new state.
    @State private var folded = false

    public init(controller: DictationController, presence: PillPresence = PillPresence()) {
        self.controller = controller
        self.presence = presence
    }

    private var state: PillState {
        PillState(status: controller.status, record: controller.lastRecord,
                  copied: controller.lastWentToClipboard, quietMic: controller.quietMicForPill)
    }

    public var body: some View {
        PillView(state: state,
                 level: controller.level,
                 style: controller.settings.pillStyle,
                 maxMessageWidth: presence.maxMessageWidth,
                 visible: presence.presented && !folded && state != .hidden)
            .task(id: state) {
                folded = false
                guard let dwell = state.dwell else { return }
                try? await Task.sleep(for: dwell)
                guard !Task.isCancelled else { return }
                withAnimation(Theme.Motion.morph) { folded = true }
            }
            .onChange(of: presence.presented) { _, shown in
                if shown { folded = false }
            }
    }
}

// MARK: - The capsule

public struct PillView: View {
    public static let width: CGFloat = 160
    public static let height: CGFloat = 36
    /// How wide a message may push the capsule before it wraps.
    public static let maxMessageWidth: CGFloat = 360

    let state: PillState
    let level: Float
    let style: PillAnimationStyle
    let maxMessageWidth: CGFloat
    let visible: Bool

    public init(state: PillState, level: Float, style: PillAnimationStyle = .default,
                maxMessageWidth: CGFloat = PillView.maxMessageWidth, visible: Bool = true) {
        self.state = state
        self.level = level
        self.style = style
        self.maxMessageWidth = maxMessageWidth
        self.visible = visible
    }

    /// The message the capsule carries, if it carries one.
    private var message: (text: String, symbol: String, tint: Color)? {
        switch state {
        case .attention(let text):
            return (text, "exclamationmark.circle.fill", Theme.Palette.amber)
        case .copied:
            return (PillState.copiedMessage, "doc.on.clipboard.fill", Theme.Palette.accent.opacity(0.85))
        default:
            return nil
        }
    }

    /// The capsule's size for this state: the animation's 160 × 36, or whatever the message's
    /// words measure. An explicit size rather than the content's own, so the spring animates the
    /// capsule's width and height between two known numbers instead of guessing at a layout.
    private var layout: PillMessageLayout? {
        message.map { PillMessageLayout.fit($0.text, maxWidth: maxMessageWidth) }
    }

    private var capsuleSize: CGSize {
        layout?.size ?? CGSize(width: Self.width, height: Self.height)
    }

    public var body: some View {
        content
            .frame(width: capsuleSize.width, height: capsuleSize.height)
            .background(capsule)
            // Up from the bottom edge: scale about the bottom, so the capsule seems to rise out
            // of the space above the Dock rather than appear in mid-air.
            .scaleEffect(visible ? 1 : 0.35, anchor: .bottom)
            .offset(y: visible ? 0 : 10)
            .opacity(visible ? 1 : 0)
            // The shadow goes on last. Under a scale or blur it is rendered into the capsule's own
            // bounds and cut off in hard vertical lines at both ends — seen in the snapshots.
            .shadow(color: .black.opacity(visible ? 0.55 : 0), radius: 14, y: 6)
            .animation(Theme.Motion.pop, value: visible)
            .animation(Theme.Motion.morph, value: state)
            .environment(\.colorScheme, .dark)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
    }

    /// A capsule at every size: the corner radius is always half the height, so a two-line
    /// message is a taller capsule, never a rounded rectangle. Circular ends, not continuous: a
    /// continuous corner needs more room than half the height, so SwiftUI flattens the middle
    /// of each end into a short straight side, and the 1-point border drew it as a bright tick
    /// at both ends — visible in every snapshot of the pill until this.
    private var capsule: some View {
        Capsule(style: .circular)
            .fill(Color.black)
            .overlay(Capsule(style: .circular).strokeBorder(borderColor, lineWidth: 1))
    }

    private var borderColor: Color {
        switch state {
        case .attention: return Theme.Palette.amber.opacity(0.35)
        case .listening: return Theme.Palette.accent.opacity(0.18)
        default: return Color.white.opacity(0.10)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let message, let layout {
            messageRow(message.text, symbol: message.symbol, tint: message.tint, layout: layout)
        } else if case .success(let millis) = state {
            HStack(spacing: 7) {
                CheckMark()
                    .frame(width: 18, height: 18)
                if let millis {
                    Text(L("unit.millis", Names.number(millis, digits: 0)))
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Color.white.opacity(0.85))
                }
            }
            .frame(width: Self.width)
            .transition(.opacity.combined(with: .scale(scale: 0.85)))
        } else {
            // The whole capsule is the canvas: the style draws edge to edge, clipped to the
            // capsule's own shape, so its round ends are part of the animation rather than a
            // frame around it.
            VoiceAnimation(level: level, processing: state != .listening, style: style,
                           paused: !visible)
                .frame(width: Self.width, height: Self.height)
                .clipShape(Capsule(style: .circular))
                .transition(.opacity)
        }
    }

    private func messageRow(_ text: String, symbol: String, tint: Color,
                            layout: PillMessageLayout) -> some View {
        HStack(spacing: PillMessageLayout.spacing) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint)
                .symbolEffect(.bounce, value: text)
                .frame(width: PillMessageLayout.iconWidth)
            // Exactly the measured width: the words break where the measurement broke them —
            // balanced, never mid-word — and the text is centred in its lines.
            Text(text)
                .font(Font(PillMessageLayout.font))
                .foregroundStyle(Color.white.opacity(0.92))
                .multilineTextAlignment(.center)
                .lineLimit(PillMessageLayout.maxLines)
                .frame(width: layout.textWidth)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(width: layout.size.width, height: layout.size.height)
        .transition(.opacity.combined(with: .scale(scale: 0.9)))
    }

    private var accessibilityText: String {
        switch state {
        case .listening: return L("pill.a11y.listening")
        case .processing: return L("pill.a11y.working")
        case .success: return L("pill.a11y.pasted")
        case .copied: return PillState.copiedMessage
        case .attention(let message): return message
        case .hidden: return ""
        }
    }
}

// MARK: - Fitting a message

/// How a message fits the capsule: the capsule's size, the width its words wrap at, and how many
/// lines that makes. Pure arithmetic over a Core Text measurement, so a test can hold every
/// message in every language to it without drawing anything.
///
/// The rule, in order: one line at its natural width when that fits (the capsule never narrower
/// than the animation's 160); else two lines at the NARROWEST width that still holds the words in
/// two — which is what balances them, so a message breaks roughly in half instead of leaving one
/// word alone on the second line; else — no shipped message, `PillMessageTests` holds them to it —
/// a third line rather than a cut.
struct PillMessageLayout: Equatable {
    var size: CGSize
    var textWidth: CGFloat
    var lines: Int

    #if os(macOS)
    static let font = NSFont.systemFont(ofSize: 12, weight: .medium)
    #else
    static let font = UIFont.systemFont(ofSize: 12, weight: .medium)
    #endif
    static let iconWidth: CGFloat = 16
    static let spacing: CGFloat = 8
    static let horizontalPadding: CGFloat = 14
    static let verticalPadding: CGFloat = 9
    /// Two is the design; the third is the safety net for a string no test has seen.
    static let maxLines = 3
    /// Everything in the capsule that is not the words.
    static var chrome: CGFloat { horizontalPadding * 2 + iconWidth + spacing }
    /// Core Text and SwiftUI agree on where a line breaks to within a fraction of a point; the
    /// slack keeps a rounding difference from ever turning two lines into three.
    static let slack: CGFloat = 2

    static func fit(_ text: String, maxWidth: CGFloat = PillView.maxMessageWidth) -> PillMessageLayout {
        let room = max(40, maxWidth - chrome)
        let natural = measure(text, width: .greatestFiniteMagnitude)
        var width: CGFloat
        var lines: Int
        if natural.width + slack <= room {
            width = natural.width + slack
            lines = 1
        } else {
            lines = measure(text, width: room - slack).lines
            if lines < 2 { lines = 2 }
            let target = min(lines, maxLines)
            // The narrowest whole-point width that keeps `target` lines: bisection, since the
            // line count only grows as the width shrinks.
            var low = floor(room / CGFloat(target + 1)), high = room - slack
            while high - low > 0.5 {
                let mid = ((low + high) / 2).rounded()
                if mid == high || mid == low { break }
                if measure(text, width: mid).lines <= target { high = mid } else { low = mid }
            }
            width = high + slack
            lines = measure(text, width: high).lines
        }
        let lineHeight = ceil(font.ascender - font.descender + font.leading)
        let height = max(PillView.height, CGFloat(min(lines, maxLines)) * lineHeight + verticalPadding * 2)
        return PillMessageLayout(size: CGSize(width: max(PillView.width, ceil(width + chrome)),
                                              height: ceil(height)),
                                 textWidth: ceil(width), lines: lines)
    }

    /// The text's laid-out width and line count at a wrap width, by Core Text — the engine under
    /// SwiftUI's own `Text`.
    static func measure(_ text: String, width: CGFloat) -> (width: CGFloat, lines: Int) {
        let attributed = NSAttributedString(string: text, attributes: [.font: font])
        let setter = CTFramesetterCreateWithAttributedString(attributed)
        let path = CGPath(rect: CGRect(x: 0, y: 0, width: width, height: 10_000), transform: nil)
        let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil)
        let lines = (CTFrameGetLines(frame) as? [CTLine]) ?? []
        var widest: CGFloat = 0
        for line in lines {
            let bounds = CTLineGetTypographicBounds(line, nil, nil, nil)
            let trailing = CTLineGetTrailingWhitespaceWidth(line)
            widest = max(widest, CGFloat(bounds - trailing))
        }
        return (ceil(widest), max(1, lines.count))
    }

    /// The widest single word — what no wrap width may go below without breaking a word.
    static func widestWord(_ text: String) -> CGFloat {
        text.split(whereSeparator: \.isWhitespace)
            .map { measure(String($0), width: .greatestFiniteMagnitude).width }
            .max() ?? 0
    }
}

/// A check that draws itself in, in the accent.
struct CheckMark: View {
    @State private var drawn: CGFloat = 0

    var body: some View {
        ZStack {
            Circle().fill(Theme.Palette.accent)
            CheckShape()
                .trim(from: 0, to: drawn)
                .stroke(Theme.Palette.accentInk,
                        style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                .padding(5)
        }
        .onAppear { withAnimation(Theme.Motion.pop.delay(0.05)) { drawn = 1 } }
    }

    struct CheckShape: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX + rect.width * 0.08, y: rect.midY + rect.height * 0.02))
            path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.40, y: rect.maxY - rect.height * 0.12))
            path.addLine(to: CGPoint(x: rect.maxX - rect.width * 0.04, y: rect.minY + rect.height * 0.14))
            return path
        }
    }
}

// MARK: - The window

#if os(macOS)
/// A panel that shows without stealing focus.
///
/// This is the single most important property in the app. Dictation inserts text into whatever
/// the user was already typing in; a window that takes key focus would move the insertion point
/// to itself and the product would not work at all. `.nonactivatingPanel` plus
/// `becomesKeyOnlyIfNeeded` plus never calling `makeKey` is what buys that.
///
/// Moved here from the app shell so the pill and the window that carries it change together:
/// the panel is a fixed, transparent, click-through canvas a little larger than the biggest
/// capsule, pinned at the bottom centre of the screen, and the capsule animates inside it.
/// Resizing the window per state would put AppKit layout on the path of every state change.
@MainActor
public final class HUDPanel {

    private let panel: NSPanel
    private let presence = PillPresence()
    /// Bumped by every show and hide, so a hide's delayed `orderOut` never removes a panel a
    /// newer show has put back.
    private var generation = 0

    /// Room for the widest message plus its shadow; the capsule sits at the bottom centre.
    static let canvas = NSSize(width: 400, height: 110)
    /// Transparent canvas kept *below* the capsule, so its shadow (radius 14, 6 down) is drawn
    /// rather than cut off by the window's edge.
    static let shadowRoom: CGFloat = 24

    public init(controller: DictationController) {
        panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.canvas),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false)

        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false            // the SwiftUI view draws its own
        panel.ignoresMouseEvents = true    // it is a readout, not a control
        Self.raise(panel)

        let root = HUDView(controller: controller, presence: presence)
            .padding(.bottom, Self.shadowRoom)
            .frame(width: Self.canvas.width, height: Self.canvas.height, alignment: .bottom)
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(origin: .zero, size: Self.canvas)
        panel.contentView = host
    }

    /// Above everything the user can be looking at, on every Space.
    ///
    /// `.statusBar` (25) was not enough: the owner saw the pill missing "over some apps" — video
    /// players, Picture in Picture, other overlays and floating utilities sit at or above it. The
    /// assistive-technology level is the one macOS reserves for exactly this kind of always-visible
    /// readout, above screen-saver-level overlays and menus. Applied again on every show, because
    /// switching the app between `.regular` (window open) and `.accessory` can leave a panel's
    /// level and Space behaviour as they were when it was created.
    static func raise(_ panel: NSPanel) {
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.assistiveTechHighWindow)))
        // Visible over full-screen apps and on every Space: dictation happens wherever the user
        // already is, and a HUD that vanishes in full screen is a HUD nobody trusts.
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary,
                                    .ignoresCycle]
    }

    public func show() {
        generation += 1
        Self.raise(panel)
        position()
        // orderFrontRegardless, never makeKeyAndOrderFront. The second one takes focus.
        panel.orderFrontRegardless()
        presence.presented = true
    }

    public func hide() {
        generation += 1
        let mine = generation
        presence.presented = false
        // Let the capsule sink back down before the window goes.
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(450))
            guard let self, self.generation == mine else { return }
            self.panel.orderOut(nil)
        }
    }

    /// Bottom centre of whichever screen has the mouse — the screen the user is working on —
    /// above the Dock. It hung under the notch until the owner's review of 2026-09-30 moved it here.
    private func position() {
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })
            ?? NSScreen.main else { return }
        panel.setFrameOrigin(Self.origin(frame: screen.frame, visibleFrame: screen.visibleFrame,
                                         notch: screen.safeAreaInsets.top, canvas: Self.canvas))
        presence.maxMessageWidth = Self.maxMessageWidth(visibleWidth: screen.visibleFrame.width)
    }

    /// How wide a message may make the capsule on a screen this wide: 360 points, less on a
    /// screen too narrow to keep a margin of 24 each side (and the shadow's room inside the canvas).
    static func maxMessageWidth(visibleWidth: CGFloat) -> CGFloat {
        min(PillView.maxMessageWidth, canvas.width - 40, max(PillView.width, visibleWidth - 48))
    }

    /// Where the canvas goes on a screen. Pure, so the arithmetic is testable without a display.
    ///
    /// `visibleFrame` is the screen minus the menu bar and the Dock, so its bottom edge is the top
    /// of a visible Dock (or the screen's own edge when the Dock hides) — the pill never sits on
    /// the Dock. It is centred on the visible frame, which also moves it clear of a Dock pinned
    /// left or right.
    static func origin(frame: NSRect, visibleFrame: NSRect, notch: CGFloat, canvas: NSSize) -> NSPoint {
        let gap = bottomGap(frame: frame, visibleFrame: visibleFrame, notch: notch)
        return NSPoint(x: (visibleFrame.midX - canvas.width / 2).rounded(),
                       y: visibleFrame.minY + gap - shadowRoom)
    }

    /// The capsule's distance from the bottom of the visible frame: a little more than its old
    /// distance from the top edge, which was the notch (or the menu bar) plus 6 points. "Slightly
    /// more, so it does not feel too low", in the owner's words — the eye reads a gap at the bottom
    /// of a screen as smaller than the same gap at the top. With an auto-hidden menu bar the old
    /// distance collapses to 6, so it is floored at a menu bar's worth.
    static func bottomGap(frame: NSRect, visibleFrame: NSRect, notch: CGFloat) -> CGFloat {
        let menuBar = frame.maxY - visibleFrame.maxY
        let formerTopDistance = max(notch, menuBar, 24) + 6
        return formerTopDistance + 8
    }
}
#endif
