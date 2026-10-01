# Kotiba 1.0 UI — references and the winner per area

Researched 2026-09-29. Rule applied: take a dependency only if it is MIT/BSD/Apache, maintained,
small and SwiftPM, *and* it does not take over something Kotiba must keep control of. None
cleared the last bar, so every winner below is an idea re-implemented in `Sources/KotibaUI`, with
zero new packages. GPL projects (VoiceInk, boring.notch) were looked at, never copied.

## Recording indicator (the pill)

- **Winner: Wispr Flow's "Flow Bar" language, re-implemented.** A black capsule, symmetric
  centre-weighted bars that swell with the live level and rest as dots in silence; the same
  capsule shimmers while processing. Specs gleaned from an MIT clone of it (softmaxe/whisper
  PR #73: 84×30 capsule, ten centre-weighted bars) and from elizaOS #20483 ("a flat waveform
  while listening should mean the mic is dead" — so the idle breath is tiny and never fakes speech).
  https://docs.wisprflow.ai/articles/1790396454-move-and-dock-the-flow-bar-on-desktop ·
  https://github.com/softmaxe/whisper/pull/73 · https://github.com/elizaOS/eliza/issues/20483
- **Notch geometry: NotchDrop (MIT, © Lakr Aream) / DynamicNotchKit (MIT, MrKai77).** Idea taken:
  notch height = `NSScreen.safeAreaInsets.top`, notch width = screen width minus the two
  `auxiliaryTop{Left,Right}Area` widths; fall back to "just under the menu bar" when both are
  absent. Not taken as a dependency: DynamicNotchKit owns its own window, and Kotiba's panel must
  stay `.nonactivatingPanel` + `orderFrontRegardless` (the focus rule is the product).
  https://github.com/Lakr233/NotchDrop · https://github.com/MrKai77/DynamicNotchKit
- **Rendering: `TimelineView(.animation)` + `Canvas`**, with a per-bar critically damped
  spring integrated every frame (so a 20 Hz level feed reads as 120 Hz motion without implicit
  animations piling up — the CPU trap Create with Swift warns about with `.smooth`).
  https://www.createwithswift.com/creating-a-live-audio-waveform-in-swiftui/ ·
  https://swiftcrafted.dev/article/swiftui-canvas-timelineview-custom-drawings-animated-graphics-ios-26
- Considered and rejected: DSWaveformImage (MIT, but a sample-history waveform, heavier than a
  level-driven meter needs), VoiceInk mini/notch recorder (GPL-3.0), boring.notch (GPL-3.0).

## App window

- **Winner: Raycast / Wispr Flow "Hub" layout** — a quiet custom sidebar (icon + label, one
  accent selection capsule that slides between rows with `matchedGeometryEffect`), content as
  stacked dark cards on pure black, one idea per card, stat tiles on top of Statistics.
  A custom sidebar rather than `NavigationSplitView` because macOS 26's split view paints a
  Liquid-Glass sidebar that cannot be made `#000000`, and the brief asks for pure black.
  https://manual.raycast.com/ · https://docs.wisprflow.ai/articles/5096240724-navigating-the-wispr-flow-app-desktop-ios-and-android
- **Charts: Swift Charts** (system framework, no dependency) — `BarMark` per day, accent fill,
  hairline grid, as in Apple's "Swift Charts: Raise the bar" (WWDC23).
  https://developer.apple.com/documentation/charts
- VoiceInk's dashboard (words dictated, time saved, WPM) inspired the Statistics tiles — GPL, so
  only the idea; our "time saved" is computed against a stated 40 wpm typing speed.

## Motion

- **Winner: Apple's WWDC23 "Animate with springs" guidance** — choose duration first, then
  bounce; bounce 0 for most UI, ~0.15–0.3 only for moments that deserve character. Kotiba names
  five springs in `Theme.swift` (`snappy`, `smooth`, `pop`, `morph`, `section`) and nothing uses an
  anonymous curve. https://developer.apple.com/videos/play/wwdc2023/10158/ ·
  https://github.com/GetStream/swiftui-spring-animations
- `phaseAnimator` for the success check and processing shimmer; `matchedGeometryEffect` for the
  sidebar selection and segmented controls; `.contentTransition(.numericText())` for stats.
