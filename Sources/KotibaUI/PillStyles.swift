import SwiftUI

// The pill's voice animation — three of them, the user's choice in Settings.
//
// The owner reviewed forty candidates on the "Kotiba pill styles" page (artifact
// FL5k6kE9qtA3tcSiguvF67, drawn by its `drawStyle`) and kept three: #25 "Siri filled", #26 "Siri
// lobes" (the default) and #34 "Bars · glow". Each is ported here from that page constant for
// constant, all fed the same per-frame `VoiceFrame`; the Windows port has the same three under
// the same names (windows/src/renderer/pill-styles.ts), so the two stay one decision. The other
// candidates the review page carried were ported once while the owner chose, and are gone:
// nothing drew them.
//
// Which one runs is `AppSettings.pillStyle`, read live by every pill — the HUD, the Home hero,
// onboarding's demos and the picker's own previews.
//
// Coordinates are the page's: the whole 160 × 36 capsule is the canvas, `inset` is 0.6 of the
// height (the round ends), and everything else is a fraction of the height or of the span
// between the ends. The page counted the lobes' physics in 60 Hz frames; here those run as
// fixed 60 Hz ticks off the display clock, so a 120 Hz screen neither doubles a lobe's speed
// nor halves its life. The other two are pure functions of the clock and the level.

/// Which voice animation the pill draws while listening. The raw value is what `AppSettings`
/// stores (and the Windows settings file, under the same key), so a case is never renamed.
public enum PillAnimationStyle: String, CaseIterable, Identifiable, Sendable {
    /// "Siri filled" (#25): three filled wave shapes in green shades, blended additively over a
    /// faint centre line, calm at both ends and full in the middle.
    case sirifilled
    /// "Siri lobes" (#26): filled, glowing lobes appear at random spots along the pill, swell with
    /// the voice and fade, blended additively over a faint centre line. The default.
    case sirilobes
    /// "Bars · glow" (#34): mirrored bars, tallest in the centre, each with its own wobble, and a
    /// soft glow that grows with loudness.
    case barsglow

    /// What a fresh install, and a settings file from before the choice existed, runs.
    public static let `default`: PillAnimationStyle = .sirilobes

    public var id: String { rawValue }

    /// The name the picker shows, in the interface language.
    public var displayName: String {
        switch self {
        case .sirifilled: return L("settings.pill.sirifilled")
        case .sirilobes: return L("settings.pill.sirilobes")
        case .barsglow: return L("settings.pill.barsglow")
        }
    }

    /// Where the style sits while Reduce Motion is on: a still frame at a calm, legible level.
    /// Nothing moves, the voice included — a shape that jumps with each syllable is motion too.
    var stillLevel: Double {
        switch self {
        case .sirilobes: return 0.12
        case .sirifilled: return 0.3
        case .barsglow: return 0.35
        }
    }
}

/// Everything a style needs to draw one frame, as a value: the drawing is a pure function of
/// this and the canvas size, so a frame can be rendered without the engine that made it.
struct VoiceFrame {
    /// Seconds of animation clock. Frozen under Reduce Motion.
    var t: Double = 0
    /// The loudness envelope, 0…1 — fast attack, soft release.
    var level: Double = 0
    var processing = false
    /// The Siri lobes currently alive.
    var lobes: [Lobe] = []

    /// One Siri lobe: `x`/`w` are fractions of the span, `life` runs 0→1 (the swell is its sine),
    /// `speed` is the life gained per 60 Hz tick, `color` picks one of three greens.
    struct Lobe { var x: Double; var w: Double; var life: Double; var speed: Double; var color: Int }
}

/// The per-frame clock and physics. A reference type advanced from inside the timeline's body,
/// never observable — mutating it must not invalidate a view, or every frame would schedule
/// another.
final class VoiceAnimationEngine {
    private var frame = VoiceFrame()
    private var last: Date?
    private var tickDebt: Double = 0
    private var rng: SplitMix64

    /// `seed` makes the lobes' random positions reproducible (tests, snapshots); the app leaves it nil.
    init(seed: UInt64? = nil) { rng = SplitMix64(seed: seed ?? UInt64.random(in: 0...UInt64.max)) }

    func advance(to date: Date, level: Float, processing: Bool, style: PillAnimationStyle,
                 reduceMotion: Bool) -> VoiceFrame {
        let dt = min(1.0 / 30, max(0, date.timeIntervalSince(last ?? date)))
        last = date
        frame.processing = processing

        if reduceMotion {
            // A static, calm frame: the clock parked, the level fixed, and for the lobes three
            // caught mid-swell at fixed places.
            frame.t = 2.2
            frame.level = style.stillLevel
            frame.lobes = style == .sirilobes
                ? [.init(x: 0.28, w: 0.2, life: 0.5, speed: 0, color: 0),
                   .init(x: 0.52, w: 0.16, life: 0.5, speed: 0, color: 2),
                   .init(x: 0.74, w: 0.22, life: 0.5, speed: 0, color: 1)]
                : []
            return frame
        }

        frame.t += dt
        // Square-root loudness with a small gate, attack 28/s, release 7/s: a linear level reads
        // as dead until someone shouts, and the gate keeps room tone from twitching the shapes.
        let gated = max(0, Double(level) - 0.004)
        // Processing has no voice to follow: the style idles at a low, steady level instead.
        let loud = processing ? 0.12 : min(1, sqrt(gated) * 2)
        let attack = loud > frame.level ? 28.0 : 7.0
        frame.level += (loud - frame.level) * min(1, attack * dt)

        guard style == .sirilobes else {
            if !frame.lobes.isEmpty { frame.lobes = [] }
            return frame
        }
        tickDebt += dt * 60
        while tickDebt >= 1 {
            tickDebt -= 1
            tickLobes()
        }
        return frame
    }

    /// One 60 Hz step of the lobes, in the page's order: maybe spawn (up to 4 at once), drop the
    /// finished, age the rest.
    private func tickLobes() {
        let lvl = frame.level
        if frame.lobes.count < 4, rng.unit() < 0.04 + lvl * 0.2 {
            frame.lobes.append(.init(x: 0.2 + rng.unit() * 0.6, w: 0.12 + rng.unit() * 0.2, life: 0,
                                     speed: 0.01 + rng.unit() * 0.015, color: Int(rng.unit() * 3) % 3))
        }
        frame.lobes.removeAll { $0.life >= 1 }
        for i in frame.lobes.indices { frame.lobes[i].life += frame.lobes[i].speed }
    }
}

/// A tiny seedable generator (SplitMix64) so the lobes' randomness can be pinned in tests.
struct SplitMix64 {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    /// Uniform in 0..<1.
    mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
}

/// A speech-like level for a pill nobody is talking into — the picker's previews. The review
/// page's `rawLevel`: syllable bursts inside phrases, with pauses between them. Returned in the
/// microphone's own units (the page's envelope, squared back through the engine's square-root
/// curve), so it goes through exactly the path a real voice does.
enum SimulatedVoice {
    static func level(at t: Double) -> Float {
        let phrase = (sin(t * 0.9) + sin(t * 0.37 + 1)) > -0.6 ? 1.0 : 0.08
        let syllable = pow(abs(sin(t * 7.3) * sin(t * 3.1 + 0.5)), 0.7)
        let envelope = min(1, phrase * (0.08 + 0.55 * syllable) + 0.02)
        return Float(pow(envelope / 2, 2) + 0.004)
    }
}

/// The drawing functions — one per style, each a port of the review page's `drawStyle` case.
enum PillStyleRenderer {

    static let accentRGB = (126.0 / 255, 240.0 / 255, 200.0 / 255)

    static func accent(_ alpha: Double) -> Color {
        Color(.sRGB, red: accentRGB.0, green: accentRGB.1, blue: accentRGB.2,
              opacity: min(1, max(0, alpha)))
    }

    static func rgb(_ r: Double, _ g: Double, _ b: Double, _ a: Double) -> Color {
        Color(.sRGB, red: r / 255, green: g / 255, blue: b / 255, opacity: a)
    }

    /// The classic Siri attenuation: calm at both ends of `x` ∈ -2…2, full in the middle.
    static func attenuation(_ x: Double, _ k: Double = 2) -> Double {
        pow(k / (k + pow(x, 4)), k)
    }

    /// The page's `bars` helper's shape: 1 at the centre bar, falling to 0 at the ends.
    static func barShape(_ i: Int, _ n: Int) -> (shape: Double, distance: Double) {
        let d = abs(Double(i) - Double(n - 1) / 2) / (Double(n - 1) / 2)
        return (pow(cos(d * .pi / 2), 1.4), d)
    }

    static func draw(_ style: PillAnimationStyle, _ f: VoiceFrame, in ctx: inout GraphicsContext,
                     size: CGSize) {
        let w = size.width, h = size.height
        let cy = h / 2, inset = h * 0.6, span = w - inset * 2
        let t = f.t, lvl = f.level
        // Processing: the style idles at a low level, drawn quieter so it reads as "working".
        if f.processing { ctx.opacity = 0.55 }

        func centreLine(alpha: Double, width: CGFloat) {
            var line = Path()
            line.move(to: CGPoint(x: inset, y: cy))
            line.addLine(to: CGPoint(x: inset + span, y: cy))
            ctx.stroke(line, with: .color(accent(alpha)), lineWidth: max(1, width))
        }

        switch style {
        case .sirifilled:
            // Three |sin| waves under the Siri attenuation, each filled top and bottom about the
            // centre line at its own frequency, speed and phase; additive, so where they cross
            // the greens brighten toward white.
            let waves: [(color: Color, freq: Double, speed: Double, phase: Double)] = [
                (rgb(126, 240, 200, 0.55), 5, 4, 0),
                (rgb(60, 190, 170, 0.5), 4, 5.5, 1.3),
                (rgb(190, 255, 230, 0.4), 6.5, 3.2, 2.6),
            ]
            let steps = max(40, Int(span / 1.5))
            var add = ctx
            add.blendMode = .plusLighter
            for wave in waves {
                var amplitudes: [(x: CGFloat, a: CGFloat)] = []
                amplitudes.reserveCapacity(steps + 1)
                for k in 0...steps {
                    let u = Double(k) / Double(steps), x = u * 4 - 2
                    let a = attenuation(x) * abs(sin(wave.freq * x - t * wave.speed + wave.phase))
                        * h * 0.42 * (0.05 + lvl)
                    amplitudes.append((inset + span * u, a))
                }
                var path = Path()
                path.move(to: CGPoint(x: inset, y: cy))
                for p in amplitudes { path.addLine(to: CGPoint(x: p.x, y: cy - p.a)) }
                for p in amplitudes.reversed() { path.addLine(to: CGPoint(x: p.x, y: cy + p.a)) }
                path.closeSubpath()
                add.fill(path, with: .color(wave.color))
            }
            centreLine(alpha: 0.35, width: h * 0.02)

        case .sirilobes:
            // Each lobe is a two-sided swell (sin² across its width) filled in one of three greens,
            // blended additively so overlaps brighten; a blurred copy underneath is the soft glow.
            let palette = [rgb(126, 240, 200, 0.55), rgb(70, 200, 180, 0.55), rgb(200, 255, 235, 0.55)]
            var add = ctx
            add.blendMode = .plusLighter
            var glow = add
            glow.addFilter(.blur(radius: h * 0.16))
            for lobe in f.lobes {
                let a = sin(lobe.life * .pi) * (0.1 + lvl)
                let lx = inset + span * lobe.x, lw = span * lobe.w
                var path = Path()
                for k in 0...40 {
                    let u = Double(k) / 40
                    let p = CGPoint(x: lx - lw + 2 * lw * u, y: cy - pow(sin(u * .pi), 2) * h * 0.4 * a)
                    if k == 0 { path.move(to: p) } else { path.addLine(to: p) }
                }
                for k in stride(from: 40, through: 0, by: -1) {
                    let u = Double(k) / 40
                    path.addLine(to: CGPoint(x: lx - lw + 2 * lw * u, y: cy + pow(sin(u * .pi), 2) * h * 0.4 * a))
                }
                path.closeSubpath()
                glow.fill(path, with: .color(palette[lobe.color].opacity(0.5)))
                add.fill(path, with: .color(palette[lobe.color]))
            }
            centreLine(alpha: 0.3, width: h * 0.018)

        case .barsglow:
            // 21 mirrored bars, taller toward the centre, each wobbling at its own phase; the
            // glow (a canvas shadow on the page, blur h × (0.1 + 0.5 × level)) grows with the
            // voice. A SwiftUI shadow's radius is half a canvas blur, hence the halving.
            let n = 21, gap = span / CGFloat(n), bw = gap * 0.42
            var glow = ctx
            glow.addFilter(.shadow(color: accent(1), radius: h * (0.1 + 0.5 * lvl) / 2))
            for i in 0..<n {
                let shape = barShape(i, n).shape
                let wobble = 0.65 + 0.35 * sin(t * 9 + Double(i) * 1.7)
                let bh = max(bw, h * 0.72 * shape * lvl * wobble)
                let x = inset + gap * (CGFloat(i) + 0.5)
                glow.fill(Path(roundedRect: CGRect(x: x - bw / 2, y: cy - bh / 2, width: bw, height: bh),
                               cornerRadius: min(bw, bh) / 2),
                          with: .color(accent(0.55 + 0.45 * shape)))
            }
        }
    }
}

/// The capsule's voice animation: the chosen style, drawn every display frame.
///
/// The controller publishes `level` at 20 Hz. Animating each reading with a SwiftUI animation
/// stacks transactions and stutters; drawing the raw value looks like a 20 fps flip-book. So the
/// engine integrates toward the level per frame inside `TimelineView(.animation)` → `Canvas`, and
/// a 20 Hz feed reads as display-rate motion with no animation system involved. When the capsule
/// is folded away the timeline pauses: an idle HUD costs nothing.
struct VoiceAnimation: View {
    let level: Float
    let processing: Bool
    var style: PillAnimationStyle = .default
    /// No frames while the capsule is folded away.
    var paused = false
    /// Ignore `level` and follow `SimulatedVoice` instead — the picker's previews, which show
    /// each style speaking while nobody is.
    var simulated = false

    @State private var engine = VoiceAnimationEngine()
    @State private var epoch = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: paused)) { timeline in
            let input = simulated
                ? SimulatedVoice.level(at: timeline.date.timeIntervalSince(epoch)) : level
            let frame = engine.advance(to: timeline.date, level: input, processing: processing,
                                       style: style, reduceMotion: reduceMotion)
            Canvas { context, size in
                PillStyleRenderer.draw(style, frame, in: &context, size: size)
            }
        }
    }
}
