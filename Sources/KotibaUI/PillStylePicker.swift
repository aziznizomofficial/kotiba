import SwiftUI

// Settings › Recording pill: the three voice animations the owner kept, side by side, each one
// moving. A name is no way to choose an animation, so every card carries the style itself at the
// pill's real size — speaking a simulated voice while nobody is dictating, and the real one while
// somebody is (the settings window can be open under a dictation). A click writes
// `AppSettings.pillStyle`, which every pill reads live; the highlight springs across to the chosen
// card.

struct PillStylePicker: View {
    let controller: DictationController
    @Namespace private var selection

    var body: some View {
        // Three across when the pane is wide enough, stacked when it is not — the window's
        // minimum width cannot fit three real-size pills and their margins in a row.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Space.s) { cards }
            VStack(spacing: Theme.Space.s) { cards }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("settings.pill.title"))
    }

    @ViewBuilder
    private var cards: some View {
        ForEach(PillAnimationStyle.allCases) { style in
            card(style)
        }
    }

    private func card(_ style: PillAnimationStyle) -> some View {
        let settings = controller.settings
        let chosen = settings.pillStyle == style
        // The live voice only while it is really listening; otherwise each preview talks to itself.
        let dictating = controller.status == .listening
        return Button {
            guard !chosen else { return }
            withAnimation(Theme.Motion.pop) { settings.pillStyle = style }
            settings.save()
        } label: {
            VStack(spacing: Theme.Space.s + 2) {
                VoiceAnimation(level: dictating ? controller.level : 0, processing: false,
                               style: style, simulated: !dictating)
                    .frame(width: PillView.width, height: PillView.height)
                    .background(Color.black)
                    .clipShape(Capsule(style: .circular))
                    .overlay(Capsule(style: .circular)
                        .strokeBorder(Theme.Palette.accent.opacity(chosen ? 0.35 : 0.14), lineWidth: 1))
                HStack(spacing: 6) {
                    ZStack {
                        Circle()
                            .strokeBorder(chosen ? Theme.Palette.accent : Theme.Palette.tertiary,
                                          lineWidth: 1.5)
                        if chosen {
                            Circle()
                                .fill(Theme.Palette.accent)
                                .padding(3.5)
                                .transition(.scale(scale: 0.2).combined(with: .opacity))
                        }
                    }
                    .frame(width: 14, height: 14)
                    Text(style.displayName)
                        .font(Theme.Typeface.callout.weight(chosen ? .semibold : .regular))
                        .foregroundStyle(chosen ? Theme.Palette.text : Theme.Palette.secondary)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .padding(.vertical, Theme.Space.m)
            .padding(.horizontal, Theme.Space.m)
            .frame(maxWidth: .infinity)
            .background {
                ZStack {
                    RoundedRectangle(cornerRadius: Theme.Radius.control + 2, style: .continuous)
                        .fill(Theme.Palette.background)
                    if chosen {
                        // One highlight, handed from card to card on the spring.
                        RoundedRectangle(cornerRadius: Theme.Radius.control + 2, style: .continuous)
                            .fill(Theme.Palette.accent.opacity(0.07))
                            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control + 2,
                                                      style: .continuous)
                                .strokeBorder(Theme.Palette.accent.opacity(0.55), lineWidth: 1.5))
                            .matchedGeometryEffect(id: "chosen", in: selection)
                    }
                }
            }
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control + 2, style: .continuous)
                .strokeBorder(Theme.Palette.hairline, lineWidth: chosen ? 0 : 1))
            .scaleEffect(chosen ? 1 : 0.98)
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.control + 2, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(style.displayName)
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
    }
}
