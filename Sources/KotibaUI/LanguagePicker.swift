import SwiftUI

// The interface-language choice: four cards on the first page of onboarding, and the same four,
// smaller, on the Settings page. A click applies the language at once — every word on screen
// re-renders through `Localizer` — and persists it through the controller.
//
// The flags are drawn, not emoji. Emoji flags do not exist on Windows at all (Segoe UI Emoji shows
// two letters), and the port draws the same shapes from SVG; drawing them here too keeps the two
// apps looking like one product, and a drawn flag sits in a rounded tile the way an emoji cannot.

// MARK: - Onboarding page

struct LanguageStep: View {
    let controller: DictationController

    var body: some View {
        let current = Localizer.shared.language
        VStack(spacing: Theme.Space.xl) {
            VStack(spacing: Theme.Space.s) {
                Image(systemName: "globe")
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Theme.Palette.accent)
                    .shadow(color: Theme.Palette.accentGlow, radius: 14)
                    .padding(.bottom, Theme.Space.xs)
                Text(L("onboarding.language.title"))
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(Theme.Palette.text)
                    .contentTransition(.opacity)
                Text(L("onboarding.language.detail"))
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Palette.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .contentTransition(.opacity)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: Theme.Space.m),
                                GridItem(.flexible(), spacing: Theme.Space.m)],
                      spacing: Theme.Space.m) {
                ForEach(AppLanguage.allCases) { language in
                    LanguageCard(language: language, selected: language == current) {
                        controller.setAppLanguage(language)
                    }
                }
            }
            Footnote(L("onboarding.language.later"))
                .contentTransition(.opacity)
        }
        .animation(Theme.Motion.smooth, value: current)
    }
}

/// One language, large: the flag, its name in its own script, a line in that language, and a
/// check that springs in when chosen.
struct LanguageCard: View {
    let language: AppLanguage
    let selected: Bool
    let choose: () -> Void
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: choose) {
            HStack(spacing: Theme.Space.m) {
                FlagView(flag: language.flag)
                    .frame(width: 44, height: 30)
                    .shadow(color: .black.opacity(0.5), radius: 3, y: 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(language.nativeName)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.Palette.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(language.nativeCaption)
                        .font(Theme.Typeface.caption)
                        .foregroundStyle(selected ? Theme.Palette.accent : Theme.Palette.tertiary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Spacer(minLength: 0)
                ZStack {
                    Circle()
                        .strokeBorder(selected ? Color.clear : Theme.Palette.hairlineStrong,
                                      lineWidth: 1.5)
                    Circle()
                        .fill(Theme.Palette.accent)
                        .scaleEffect(selected ? 1 : 0.2)
                        .opacity(selected ? 1 : 0)
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundStyle(Theme.Palette.accentInk)
                        .scaleEffect(selected ? 1 : 0.4)
                        .opacity(selected ? 1 : 0)
                }
                .frame(width: 20, height: 20)
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.vertical, Theme.Space.l)
            .frame(maxWidth: .infinity, minHeight: 74)
            .background {
                RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                    .fill(selected ? Theme.Palette.raised
                          : hovering ? Theme.Palette.raised : Theme.Palette.surface)
                RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                    .fill(RadialGradient(colors: [Theme.Palette.accent.opacity(0.16), .clear],
                                         center: .leading, startRadius: 0, endRadius: 220))
                    .opacity(selected ? 1 : 0)
            }
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                    .strokeBorder(selected ? Theme.Palette.accent.opacity(0.9)
                                  : hovering ? Theme.Palette.hairlineStrong : Theme.Palette.hairline,
                                  lineWidth: selected ? 1.5 : 1))
            .shadow(color: selected ? Theme.Palette.accentGlow.opacity(0.6) : .clear, radius: 14)
            .scaleEffect(reduceMotion ? 1 : selected ? 1.015 : hovering ? 1.005 : 1)
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        }
        .buttonStyle(PressScaleStyle())
        .onHover { hovering = $0 }
        .animation(Theme.Motion.pop, value: selected)
        .animation(Theme.Motion.snappy, value: hovering)
        .accessibilityLabel(language.nativeName)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct PressScaleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(Theme.Motion.snappy, value: configuration.isPressed)
    }
}

// MARK: - Settings row

/// The same four, as a compact list for the Settings page. Each row is a flag and the native name;
/// the chosen one carries the accent.
struct LanguageList: View {
    let controller: DictationController

    var body: some View {
        let current = Localizer.shared.language
        // Two by two, whatever the width: four across clips "Ўзбекча (Кирилл)" in a narrow
        // window, and three and a lone fourth reads as a mistake.
        LazyVGrid(columns: [GridItem(.flexible(), spacing: Theme.Space.s),
                            GridItem(.flexible(), spacing: Theme.Space.s)],
                  spacing: Theme.Space.s) {
            ForEach(AppLanguage.allCases) { language in
                let selected = language == current
                Button {
                    controller.setAppLanguage(language)
                } label: {
                    HStack(spacing: Theme.Space.s) {
                        FlagView(flag: language.flag)
                            .frame(width: 24, height: 16)
                        Text(language.nativeName)
                            .font(Theme.Typeface.body.weight(selected ? .semibold : .regular))
                            .foregroundStyle(selected ? Theme.Palette.text : Theme.Palette.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(Theme.Palette.accent)
                            .opacity(selected ? 1 : 0)
                            .scaleEffect(selected ? 1 : 0.5)
                    }
                    .padding(.horizontal, Theme.Space.m)
                    .frame(height: 36)
                    .background(selected ? Theme.Palette.accentSoft : Theme.Palette.raised,
                                in: RoundedRectangle(cornerRadius: Theme.Radius.control,
                                                     style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                            .strokeBorder(selected ? Theme.Palette.accent.opacity(0.7)
                                          : Theme.Palette.hairline, lineWidth: 1))
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel(language.nativeName)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .animation(Theme.Motion.pop, value: current)
    }
}

// MARK: - Flags

enum Flag: Sendable {
    case unitedKingdom, russia, uzbekistan
}

extension AppLanguage {
    var flag: Flag {
        switch self {
        case .english: return .unitedKingdom
        case .russian: return .russia
        case .uzbekLatin, .uzbekCyrillic: return .uzbekistan
        }
    }
}

/// A flag drawn to its box, in a rounded tile with a hairline edge. The colours are the flags'
/// own, not the theme's — the one place in the window allowed colours Theme does not define.
struct FlagView: View {
    let flag: Flag

    var body: some View {
        Canvas { context, size in
            let rect = CGRect(origin: .zero, size: size)
            switch flag {
            case .russia: Self.russia(&context, rect)
            case .uzbekistan: Self.uzbekistan(&context, rect)
            case .unitedKingdom: Self.unitedKingdom(&context, rect)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous)
            .strokeBorder(Color.white.opacity(0.18), lineWidth: 0.75))
        .accessibilityHidden(true)
    }

    private static func band(_ context: inout GraphicsContext, _ rect: CGRect,
                             from top: CGFloat, to bottom: CGFloat, _ color: Color) {
        context.fill(Path(CGRect(x: rect.minX, y: rect.minY + rect.height * top,
                                 width: rect.width, height: rect.height * (bottom - top))),
                     with: .color(color))
    }

    static func russia(_ context: inout GraphicsContext, _ rect: CGRect) {
        band(&context, rect, from: 0, to: 1 / 3, .white)
        band(&context, rect, from: 1 / 3, to: 2 / 3, Color(hex: 0x0039A6))
        band(&context, rect, from: 2 / 3, to: 1, Color(hex: 0xD52B1E))
    }

    /// Blue, white and green with thin red fimbriations; a white crescent and twelve stars in
    /// three rows (3, 4, 5) at the hoist.
    static func uzbekistan(_ context: inout GraphicsContext, _ rect: CGRect) {
        let blue = Color(hex: 0x0099B5), green = Color(hex: 0x1EB53A), red = Color(hex: 0xCE1126)
        band(&context, rect, from: 0, to: 0.33, blue)
        band(&context, rect, from: 0.33, to: 0.35, red)
        band(&context, rect, from: 0.35, to: 0.65, .white)
        band(&context, rect, from: 0.65, to: 0.67, red)
        band(&context, rect, from: 0.67, to: 1, green)

        let h = rect.height, w = rect.width
        let radius = h * 0.12
        let centre = CGPoint(x: w * 0.15, y: h * 0.165)
        context.fill(Path(ellipseIn: CGRect(x: centre.x - radius, y: centre.y - radius,
                                            width: radius * 2, height: radius * 2)),
                     with: .color(.white))
        let bite = radius * 0.86
        let biteCentre = CGPoint(x: centre.x + radius * 0.38, y: centre.y)
        context.fill(Path(ellipseIn: CGRect(x: biteCentre.x - bite, y: biteCentre.y - bite,
                                            width: bite * 2, height: bite * 2)),
                     with: .color(blue))

        let star = h * 0.034
        let step = h * 0.078
        let startX = w * 0.25
        let rows: [(y: CGFloat, count: Int, skip: Int)] = [
            (h * 0.07, 3, 2), (h * 0.155, 4, 1), (h * 0.24, 5, 0),
        ]
        for row in rows {
            for index in 0..<row.count {
                let x = startX + CGFloat(index + row.skip) * step
                context.fill(starPath(CGPoint(x: x, y: row.y), radius: star), with: .color(.white))
            }
        }
    }

    static func unitedKingdom(_ context: inout GraphicsContext, _ rect: CGRect) {
        let navy = Color(hex: 0x012169), red = Color(hex: 0xC8102E)
        context.fill(Path(rect), with: .color(navy))
        let w = rect.width, h = rect.height
        let unit = h / 30          // the Union Flag is specified on a 30-unit height
        func diagonal(_ width: CGFloat, _ color: Color) {
            var path = Path()
            path.move(to: CGPoint(x: 0, y: 0)); path.addLine(to: CGPoint(x: w, y: h))
            path.move(to: CGPoint(x: w, y: 0)); path.addLine(to: CGPoint(x: 0, y: h))
            context.stroke(path, with: .color(color), lineWidth: width)
        }
        diagonal(unit * 6, .white)
        // The red saltire is counterchanged: each half-stripe sits clockwise of the diagonal.
        let offset = unit * 1
        var red1 = Path()
        red1.move(to: CGPoint(x: 0, y: offset)); red1.addLine(to: CGPoint(x: w / 2, y: h / 2 + offset))
        red1.move(to: CGPoint(x: w, y: h - offset)); red1.addLine(to: CGPoint(x: w / 2, y: h / 2 - offset))
        red1.move(to: CGPoint(x: w - offset * 2, y: 0)); red1.addLine(to: CGPoint(x: w / 2 - offset, y: h / 2))
        red1.move(to: CGPoint(x: offset * 2, y: h)); red1.addLine(to: CGPoint(x: w / 2 + offset, y: h / 2))
        context.stroke(red1, with: .color(red), lineWidth: unit * 2)
        context.fill(Path(CGRect(x: w / 2 - unit * 5, y: 0, width: unit * 10, height: h)),
                     with: .color(.white))
        context.fill(Path(CGRect(x: 0, y: h / 2 - unit * 5, width: w, height: unit * 10)),
                     with: .color(.white))
        context.fill(Path(CGRect(x: w / 2 - unit * 3, y: 0, width: unit * 6, height: h)),
                     with: .color(red))
        context.fill(Path(CGRect(x: 0, y: h / 2 - unit * 3, width: w, height: unit * 6)),
                     with: .color(red))
    }

    static func starPath(_ centre: CGPoint, radius: CGFloat) -> Path {
        var path = Path()
        for index in 0..<10 {
            let r = index.isMultiple(of: 2) ? radius : radius * 0.42
            let angle = -CGFloat.pi / 2 + CGFloat(index) * .pi / 5
            let point = CGPoint(x: centre.x + cos(angle) * r, y: centre.y + sin(angle) * r)
            index == 0 ? path.move(to: point) : path.addLine(to: point)
        }
        path.closeSubpath()
        return path
    }
}
