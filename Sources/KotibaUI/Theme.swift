import SwiftUI

// Every colour, radius, gap, type size and spring the app window and the pill use — and nothing
// outside this file is allowed to invent one. The references behind these choices are in
// docs/design/UI-REFERENCES.md.
//
// Pure black is a product decision, not a default: the brief asks for `#000000` behind everything
// in the window, with the icon's own green as the only colour that means something. Surfaces are
// therefore *lifted* off black in small steps (#0B0B0C → #141416 → #1C1C1F) rather than tinted,
// and hairlines do the work a grey background would do in a light theme.

public enum Theme {

    // MARK: Colour

    public enum Palette {
        /// The window, the sidebar, the pill. Exactly `#000000`.
        public static let background = Color.black
        /// A card resting on the background.
        public static let surface = Color(hex: 0x0B0B0C)
        /// A control or an inset well inside a card.
        public static let raised = Color(hex: 0x141416)
        /// Hover and pressed states, and the selected row in the sidebar when it is not accented.
        public static let elevated = Color(hex: 0x1C1C1F)

        public static let hairline = Color.white.opacity(0.08)
        public static let hairlineStrong = Color.white.opacity(0.14)

        public static let text = Color.white.opacity(0.94)
        public static let secondary = Color.white.opacity(0.60)
        public static let tertiary = Color.white.opacity(0.38)

        /// The icon's green, measured from `AppIcon.appiconset`. The only colour that means "on",
        /// "live" or "yours".
        public static let accent = Color(hex: 0x7EF0C8)
        /// Text and glyphs drawn *on* the accent.
        public static let accentInk = Color(hex: 0x03140D)
        public static let accentSoft = Color(hex: 0x7EF0C8).opacity(0.14)
        public static let accentGlow = Color(hex: 0x7EF0C8).opacity(0.35)

        /// Heard nothing, needs attention. Amber rather than red: nothing is broken.
        public static let amber = Color(hex: 0xFFC061)
        public static let amberSoft = Color(hex: 0xFFC061).opacity(0.14)
        /// Something is actually wrong, or will be lost.
        public static let danger = Color(hex: 0xFF6E6E)
        public static let dangerSoft = Color(hex: 0xFF6E6E).opacity(0.14)

        /// A fixed set for the per-language and per-mode splits, in the accent's family so the
        /// chart reads as one system. Order is the order series appear in.
        public static let series: [Color] = [
            Color(hex: 0x7EF0C8), Color(hex: 0x5FB3F5), Color(hex: 0xC9A6FF), Color(hex: 0xFFC061),
        ]
    }

    // MARK: Shape

    public enum Radius {
        public static let small: CGFloat = 6
        public static let control: CGFloat = 9
        public static let card: CGFloat = 14
        public static let panel: CGFloat = 20
    }

    public enum Space {
        public static let xxs: CGFloat = 2
        public static let xs: CGFloat = 4
        public static let s: CGFloat = 8
        public static let m: CGFloat = 12
        public static let l: CGFloat = 16
        public static let xl: CGFloat = 24
        public static let xxl: CGFloat = 32
    }

    /// Widths the layout switches on. Measured against the window, not the screen.
    public enum Breakpoint {
        /// Below this the sidebar folds to an icon rail on its own.
        public static let railBelow: CGFloat = 860
        /// Below this, two-column card grids become one column.
        public static let singleColumnBelow: CGFloat = 620
        /// Content never grows wider than this; the rest is black margin.
        public static let readableWidth: CGFloat = 860
    }

    // MARK: Type

    public enum Typeface {
        public static let display = Font.system(size: 28, weight: .semibold)
        public static let title = Font.system(size: 20, weight: .semibold)
        public static let headline = Font.system(size: 13, weight: .semibold)
        public static let body = Font.system(size: 13)
        public static let callout = Font.system(size: 12)
        public static let caption = Font.system(size: 11)
        public static let micro = Font.system(size: 10, weight: .semibold)
        public static let metric = Font.system(size: 26, weight: .semibold, design: .rounded)
        public static let mono = Font.system(size: 11, design: .monospaced)
    }

    // MARK: Motion

    /// The six springs. Apple's WWDC23 rule: pick the duration first, then add bounce only where
    /// the motion should have character. Nothing in the UI uses an anonymous curve.
    public enum Motion {
        /// Controls: a switch, a chip, a hover. Quick, a hint of overshoot.
        public static let snappy = Animation.spring(duration: 0.26, bounce: 0.12)
        /// Content changing in place: a list filtering, a card appearing. No overshoot.
        public static let smooth = Animation.spring(duration: 0.40, bounce: 0)
        /// The pill rising from the bottom of the screen, the success check. The one place with real
        /// bounce.
        public static let pop = Animation.spring(duration: 0.42, bounce: 0.30)
        /// A shape changing size — the pill widening for a message, the sidebar folding.
        public static let morph = Animation.spring(duration: 0.48, bounce: 0.16)
        /// Moving between sidebar sections and onboarding steps.
        public static let section = Animation.spring(duration: 0.34, bounce: 0.04)
        /// A number counting up to its value, a chart's bars growing in: long enough to read as a
        /// count, eased out so it lands softly. A curve rather than a spring on purpose: a spring's
        /// tail keeps the last digit ticking for half a second after the number looks finished,
        /// and this one ends exactly at 0.85 s.
        public static let count = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.85)
    }
}

extension Color {
    /// `0xRRGGBB`, sRGB.
    public init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: opacity)
    }
}
