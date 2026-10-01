import CoreText
import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

// The Home dashboard's first panel: promo V19 "Globe", the owner's pick of 2026-10-02
// (kotib-lab/promo/kotiba-promo-set-d.html). A dotted Earth sits in the middle; the five language
// names orbit it and the globe turns to where each one is spoken (Tashkent, London, Moscow,
// Riyadh, Istanbul); the four modes orbit the other way; then the camera pulls back, the globe
// parks on the left, the hotkey goes down, the pill listens, ripples come from the city, and the
// result lands in that mode's form. 20 s, seamless, drawn live — no video.
//
// A faithful port of the web original's drawing code (setd.js `drawV19` and the shared helpers
// it calls), function for function, so the two can be compared frame by frame: the constants,
// timings and easings are the page's own. What differs is only what has to: the system font for
// Inter, SwiftUI's text (which shapes Arabic) for canvas text, offset copies for the black keyline
// canvas draws with `strokeText`, and the globe's ~600 visible land dots filled as a couple of
// dozen paths bucketed by brightness rather than one rectangle at a time.
//
// Cheap by construction: `TimelineView(.animation)` at most 60 Hz, paused whenever the panel
// cannot be seen (Home not showing, window hidden, minimised or occluded, panel scrolled away),
// and a still poster frame under Reduce Motion. Measured: ~0.7 ms of CPU per 2× frame offscreen (≈4 % of one core at 60 Hz); 0 frames while occluded.

struct PromoGlobePanel: View {
    /// The hotkey's own glyph for the keycap ("⌘", "⌥", "F13"), from `HotkeySpec.keycapLabels`.
    var hotkeyGlyph: String = "⌘"
    /// A fixed moment of the loop instead of the clock: the snapshot harness and tests.
    var time: Double?

    static let height: CGFloat = 190

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var onScreen = false
    @State private var windowVisible = true
    @State private var scrolledIntoView = true
    @State private var start = Date()

    private var playing: Bool {
        time == nil && !reduceMotion && onScreen && windowVisible && scrolledIntoView
    }

    var body: some View {
        let words = PromoGlobeWords(modes: [L("mode.raw"), L("mode.super"), L("mode.message"), L("mode.note")],
                                    hotkey: hotkeyGlyph)
        Group {
            if let time {
                canvas(words, at: time)
            } else if reduceMotion {
                canvas(words, at: GlobeScene.poster)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !playing)) { context in
                    canvas(words, at: context.date.timeIntervalSince(start))
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: Self.height)
        .background(Color.black)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
            .strokeBorder(Theme.Palette.hairline, lineWidth: 1))
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        .onScrollVisibilityChange(threshold: 0.02) { scrolledIntoView = $0 }
        #if os(macOS)
        .background(WindowVisibilityReader(visible: $windowVisible))
        #endif
        .accessibilityElement()
        .accessibilityAddTraits(.isImage)
        .accessibilityLabel(L("home.promo.label"))
    }

    private func canvas(_ words: PromoGlobeWords, at time: Double) -> some View {
        Canvas(opaque: true, rendersAsynchronously: false) { context, size in
            var ctx = context
            // The design is 190 pt tall at any width; a different height scales it whole.
            let k = size.height / GlobeScene.H
            ctx.scaleBy(x: k, y: k)
            GlobeScene(words: words).draw(&ctx, w: size.width / k, h: GlobeScene.H, t: time)
        }
    }
}

/// The on-screen words that are interface, not demonstration: the four mode names and the key.
/// The language names are endonyms and the sample sentences are in their own languages, on
/// purpose; neither is translated.
struct PromoGlobeWords: Equatable {
    var modes: [String]
    var hotkey: String
}

#if os(macOS)
/// Whether the hosting window can be seen at all: not occluded, not minimised, not closed.
/// `TimelineView` keeps ticking for a window nobody can see, so the panel asks.
private struct WindowVisibilityReader: NSViewRepresentable {
    @Binding var visible: Bool

    func makeNSView(context: Context) -> Probe {
        let probe = Probe()
        probe.report = { value in if visible != value { visible = value } }
        return probe
    }

    func updateNSView(_ probe: Probe, context: Context) {
        probe.report = { value in if visible != value { visible = value } }
    }

    final class Probe: NSView {
        var report: ((Bool) -> Void)?
        private var tokens: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            tokens.forEach(NotificationCenter.default.removeObserver)
            tokens = []
            guard let window else { report?(false); return }
            for name in [NSWindow.didChangeOcclusionStateNotification,
                         NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification] {
                tokens.append(NotificationCenter.default.addObserver(forName: name, object: window,
                                                                     queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.check() }
                })
            }
            check()
        }

        private func check() {
            guard let window else { report?(false); return }
            let value = window.occlusionState.contains(.visible) && !window.isMiniaturized
            DispatchQueue.main.async { [weak self] in self?.report?(value) }
        }
    }
}
#endif

// MARK: - The scene

/// Everything below follows setd.js / shared1.js / shared2.js / story.js line for line; the
/// names are theirs so a diff against the web original stays readable.
struct GlobeScene {
    static let H = 190.0
    static let loop = 20.0
    static let beat = 4.0
    /// The Reduce Motion still: Uzbek, the globe parked, the result landed.
    static let poster = 3.5

    let words: PromoGlobeWords

    // MARK: maths

    static let tau = Double.pi * 2

    @inline(__always) static func clamp(_ x: Double, _ a: Double = 0, _ b: Double = 1) -> Double { min(b, max(a, x)) }
    @inline(__always) static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
    @inline(__always) static func prog(_ t: Double, _ a: Double, _ b: Double) -> Double { clamp((t - a) / (b - a)) }
    @inline(__always) static func mod(_ a: Double, _ n: Double) -> Double { ((a.truncatingRemainder(dividingBy: n)) + n).truncatingRemainder(dividingBy: n) }
    @inline(__always) static func imod(_ a: Int, _ n: Int) -> Int { ((a % n) + n) % n }
    static func hash(_ n: Double) -> Double { let x = sin(n * 127.1 + 311.7) * 43758.5453; return x - floor(x) }
    /// JS `Math.round`: halves go up, also for negatives.
    @inline(__always) static func jsRound(_ x: Double) -> Int { Int(floor(x + 0.5)) }

    struct Bezier {
        let x1, y1, x2, y2: Double
        func callAsFunction(_ x: Double) -> Double {
            if x <= 0 { return 0 }
            if x >= 1 { return 1 }
            func b(_ u: Double, _ p1: Double, _ p2: Double) -> Double {
                3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u
            }
            var lo = 0.0, hi = 1.0, u = x
            for _ in 0..<22 { u = (lo + hi) / 2; if b(u, x1, x2) < x { lo = u } else { hi = u } }
            return b(u, y1, y2)
        }
    }
    // Material 3 emphasized tokens.
    static let eOut = Bezier(x1: 0.05, y1: 0.7, x2: 0.1, y2: 1)
    static let eAcc = Bezier(x1: 0.3, y1: 0, x2: 0.8, y2: 0.15)
    static let eIO = Bezier(x1: 0.2, y1: 0, x2: 0, y2: 1)
    static func spring(_ p: Double) -> Double { p <= 0 ? 0 : p >= 1 ? 1 : 1 - exp(-7 * p) * cos(10.5 * p) }
    static func smooth(_ p: Double) -> Double { p * p * (3 - 2 * p) }

    // MARK: colour

    typealias RGB = (Double, Double, Double)
    static let ACC: RGB = (126, 240, 200)
    static let WHITE: RGB = (242, 245, 244)
    static func rgba(_ c: RGB, _ a: Double) -> Color {
        Color(.sRGB, red: c.0 / 255, green: c.1 / 255, blue: c.2 / 255, opacity: clamp(a))
    }
    static func acc(_ a: Double) -> Color { rgba(ACC, a) }
    static func wht(_ a: Double) -> Color { Color(.sRGB, white: 1, opacity: clamp(a)) }
    static func mix(_ c1: RGB, _ c2: RGB, _ t: Double, _ a: Double = 1) -> Color {
        // The page rounds each channel to an integer; so does this.
        rgba((lerp(c1.0, c2.0, t).rounded(), lerp(c1.1, c2.1, t).rounded(), lerp(c1.2, c2.2, t).rounded()), a)
    }

    // MARK: text

    /// A canvas font, `f(size, weight, style)` or the Arabic face (`AFONT`).
    struct Face: Hashable {
        var size: Double
        var weight: Int = 500
        var italic = false
        var font: Font {
            let w: Font.Weight = weight >= 700 ? .bold : weight >= 600 ? .semibold : weight >= 500 ? .medium : .regular
            let base = Font.system(size: size, weight: w)
            return italic ? base.italic() : base
        }
    }
    static func f(_ size: Double, _ weight: Int = 500, italic: Bool = false) -> Face { Face(size: size, weight: weight, italic: italic) }
    // The page sizes the Arabic face up a little next to Inter; the system's Arabic needs the same.
    static func tFont(_ L: Stop, _ fs: Double, _ wt: Int = 600) -> Face { L.rtl ? f((fs * 1.06 * 10).rounded() / 10, wt) : f(fs, wt) }
    static func nameFont(_ L: Stop, _ px: Double, _ wt: Int = 700) -> Face { L.rtl ? f(px * 1.02, wt) : f(px, wt) }

    /// Right-to-left text is wrapped in an embedding so its base direction is RTL whatever the
    /// window's: the full stop of «…صباحًا.» belongs at the left end.
    static func shaped(_ s: String, rtl: Bool) -> String { rtl ? "\u{202B}" + s + "\u{202C}" : s }

    // Sizes snap to half a point. The orbit labels change size every frame as they swing round,
    // and every new size is a new set of glyph bitmaps to rasterise; snapped, the glyph cache
    // hits and a frame costs about half as much (measured, see the header).
    static func snap(_ size: Double) -> Double { (size * 2).rounded() / 2 }

    func resolve(_ ctx: GraphicsContext, _ s: String, _ face: Face, rtl: Bool = false) -> GraphicsContext.ResolvedText {
        var face = face
        face.size = Self.snap(face.size)
        return ctx.resolve(Text(Self.shaped(s, rtl: rtl)).font(face.font))
    }

    /// Widths, measured once per string and size: the header, the result box and the keycap ask
    /// for the same few every frame.
    static var widths: [Face: [String: Double]] = [:]

    func width(_ ctx: GraphicsContext, _ s: String, _ face: Face, rtl: Bool = false) -> Double {
        var face = face
        face.size = Self.snap(face.size)
        if let known = Self.widths[face]?[s] { return known }
        let measured = resolve(ctx, s, face, rtl: rtl).measure(in: CGSize(width: CGFloat.infinity, height: .infinity)).width
        if Self.widths.count > 400 { Self.widths = [:] } // a bound, not a policy: ~60 are ever used
        Self.widths[face, default: [:]][s] = Double(measured)
        return Double(measured)
    }

    /// `txt`: one run at (x, y), vertically centred; `keyline` is `textOut`'s black outline width.
    func txt(_ ctx: inout GraphicsContext, _ s: String, _ x: Double, _ y: Double, _ face: Face, _ fill: Color,
             rtl: Bool = false, anchor: UnitPoint = .center, keyline: Double = 0) {
        var r = resolve(ctx, s, face, rtl: rtl)
        if keyline > 0.3 {
            r.shading = .color(.black)
            let d = keyline / 2
            for k in 0..<8 {
                let a = Double(k) * Self.tau / 8
                ctx.draw(r, at: CGPoint(x: x + cos(a) * d, y: y + sin(a) * d), anchor: anchor)
            }
        }
        r.shading = .color(fill)
        ctx.draw(r, at: CGPoint(x: x, y: y), anchor: anchor)
    }

    /// A label's outline at 100 pt, made once with Core Text (which shapes and orders Arabic)
    /// and then filled — and stroked for the keyline — at any size by a scale. Drawing a label as
    /// laid-out text costs a typesetting pass per draw, and the orbit draws each label up to
    /// fifteen times a frame (the keyline's copies and the motion trail): as an outline it is one
    /// stroke and one fill per copy, and the sizes are exact rather than snapped.
    struct Outline {
        let path: Path
        let width: Double
        /// From the baseline to the middle of the em box: canvas `textBaseline = "middle"`.
        let middle: Double
    }
    static let outlineUnit = 100.0
    static var outlines: [String: Outline] = [:]

    static func outline(_ s: String, weight: Int) -> Outline {
        let key = "\(weight)|\(s)"
        if let known = outlines[key] { return known }
        #if os(macOS)
        let w: NSFont.Weight = weight >= 700 ? .bold : weight >= 600 ? .semibold : weight >= 500 ? .medium : .regular
        let font = NSFont.systemFont(ofSize: outlineUnit, weight: w) as CTFont
        #else
        let w: UIFont.Weight = weight >= 700 ? .bold : weight >= 600 ? .semibold : weight >= 500 ? .medium : .regular
        let font = UIFont.systemFont(ofSize: outlineUnit, weight: w) as CTFont
        #endif
        let attributed = NSAttributedString(string: s, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
        let line = CTLineCreateWithAttributedString(attributed)
        var path = Path()
        for run in (CTLineGetGlyphRuns(line) as? [CTRun]) ?? [] {
            let attributes = CTRunGetAttributes(run) as NSDictionary
            let runFont = attributes[kCTFontAttributeName as String].map { $0 as! CTFont } ?? font // swiftlint:disable:this force_cast
            let count = CTRunGetGlyphCount(run)
            var glyphs = [CGGlyph](repeating: 0, count: count), positions = [CGPoint](repeating: .zero, count: count)
            CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
            CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
            for (glyph, at) in zip(glyphs, positions) {
                // Core Text is y-up; the canvas is y-down with the baseline at 0.
                var flip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: at.x, ty: -at.y)
                if let outline = CTFontCreatePathForGlyph(runFont, glyph, &flip) { path.addPath(Path(outline)) }
            }
        }
        let width = CTLineGetTypographicBounds(line, nil, nil, nil)
        let made = Outline(path: path, width: width, middle: (CTFontGetAscent(font) - CTFontGetDescent(font)) / 2)
        if outlines.count > 200 { outlines = [:] } // a bound, not a policy: ~25 are ever used
        outlines[key] = made
        return made
    }

    /// `textOut` for a label: centred on (x, y), with an optional black keyline of width `keyline`.
    func label(_ ctx: inout GraphicsContext, _ s: String, _ x: Double, _ y: Double, size: Double, weight: Int,
               _ fill: Color, keyline: Double = 0) {
        let o = Self.outline(s, weight: weight), k = size / Self.outlineUnit
        var g = ctx
        g.translateBy(x: x - o.width * k / 2, y: y + o.middle * k)
        g.scaleBy(x: k, y: k)
        if keyline > 0.3 {
            g.stroke(o.path, with: .color(.black), style: StrokeStyle(lineWidth: keyline / k, lineJoin: .round))
        }
        g.fill(o.path, with: .color(fill))
    }

    static func labelWidth(_ s: String, size: Double, weight: Int) -> Double {
        outline(s, weight: weight).width * size / outlineUnit
    }

    // MARK: story

    struct Stop {
        let code: String
        let name: String
        let mode: Int // 0 Raw, 1 Super, 2 Message, 3 Note
        let raw: String
        let out: [String]
        var rtl = false
    }
    // The demonstration content, in its own languages (story.js `SEQ`), in the owner's order.
    static let SEQ: [Stop] = [
        Stop(code: "UZ", name: "Oʻzbekcha", mode: 2, raw: "ee salom ertaga oʻsha joyda uchrashamizmi",
             out: ["Salom! Ertaga oʻsha joyda uchrashamizmi?"]),
        Stop(code: "EN", name: "English", mode: 3, raw: "um so tomorrow I need to buy milk and bread and uh call mom",
             out: ["Buy milk and bread", "Call Mom"]),
        Stop(code: "RU", name: "Русский", mode: 0, raw: "ну короче я буду минут через десять",
             out: ["ну короче я буду минут через десять"]),
        Stop(code: "AR", name: "العربية", mode: 1, raw: "يعني سأرسل التقرير غدًا صباحًا",
             out: ["سأرسل التقرير غدًا صباحًا."], rtl: true),
        Stop(code: "TR", name: "Türkçe", mode: 1, raw: "şey yarın İstanbul'a dönüyorum çay içelim mi",
             out: ["Yarın İstanbul'a dönüyorum, çay içelim mi?"]),
    ]
    static let REG: [String: (Double, Double)] = [
        "UZ": (41.3, 69.2), "EN": (51.5, -0.1), "RU": (55.75, 37.6), "AR": (24.7, 46.7), "TR": (41.0, 29.0),
    ]
    func modeName(_ m: Int) -> String { words.modes.indices.contains(m) ? words.modes[m] : "" }

    struct Beat { let kd, pin, sa, sb, ku, res: Double }
    static let B19 = Beat(kd: 1.94, pin: 1.74, sa: 2.04, sb: 2.66, ku: 2.76, res: 2.9)

    static func beatOf(_ t: Double) -> (n: Int, tau: Double) {
        let n = Int(floor(t / beat))
        return (n, t - Double(n) * beat)
    }
    // Every stop spins through the WHOLE list: languages +6 (all five, then one more), modes +4…+5.
    static func langBase(_ n: Int) -> Double { Double(6 * n) }
    static func modeBase(_ n: Int) -> Double {
        Double(24 * Int(floor(Double(n) / 5)) + [2, 7, 12, 17, 21][imod(n, 5)])
    }
    // Momentum spin: quartic deceleration + a small overshoot that settles back.
    static func spin(_ t: Double, _ base: (Int) -> Double, _ a: Double, _ b: Double) -> Double {
        let (n, tau) = beatOf(t)
        let p0 = base(n - 1), p1 = base(n), u = prog(tau, a, b), v = prog(u, 0.7, 1)
        return p0 + (p1 - p0) * (1 - pow(1 - u, 4)) + 0.26 * sin(Double.pi * v) * (1 - v)
    }
    static func spinVel(_ t: Double, _ base: (Int) -> Double, _ a: Double, _ b: Double) -> Double {
        (spin(t, base, a, b) - spin(t - 1.0 / 120, base, a, b)) * 120
    }
    static func langFrac(_ t: Double, _ a: Double, _ b: Double) -> Double {
        let n = beatOf(t).n
        return (spin(t, langBase, a, b) - langBase(n - 1)) / (langBase(n) - langBase(n - 1))
    }

    static func keyPress(_ tau: Double, _ b: Beat) -> Double {
        eOut(prog(tau, b.kd, b.kd + 0.12)) * (1 - eOut(prog(tau, b.ku, b.ku + 0.12)))
    }
    static func voice(_ tau: Double, _ seed: Double, _ b: Beat) -> Double {
        let env = prog(tau, b.sa, b.sa + 0.15) * (1 - prog(tau, b.sb - 0.1, b.sb + 0.05))
        if env <= 0 { return 0 }
        let syl = 0.5 + 0.5 * sin(tau * Self.tau * 3.1 + seed * 2.1)
        let word = 0.55 + 0.45 * sin(tau * Self.tau * 0.9 + seed)
        return clamp(env * (0.25 + 0.75 * syl) * word * (0.75 + 0.25 * sin(tau * 23 + seed * 5)) * 1.15)
    }
    static func spokenSoFar(_ raw: String, _ tau: Double, _ b: Beat, _ maxWords: Int) -> (s: String, fresh: Double, more: Bool)? {
        let ws = raw.split(separator: " ").map(String.init), n = ws.count, span = b.sb - b.sa - 0.12
        let k = min(n, Int(floor((tau - b.sa - 0.04) / span * Double(n))) + 1)
        if k <= 0 { return nil }
        let at = b.sa + 0.04 + (Double(k - 1) / Double(n)) * span
        return (ws[max(0, k - maxWords)..<k].joined(separator: " "), eOut(prog(tau, at, at + 0.22)), k > maxWords)
    }

    // MARK: shapes

    static func roundRect(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ r: Double) -> Path {
        Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: min(r, w / 2, h / 2), style: .circular)
    }
    static func circle(_ x: Double, _ y: Double, _ r: Double) -> Path {
        Path(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
    }
    static func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect { CGRect(x: x, y: y, width: w, height: h) }
    static func radial(_ stops: [(Double, Color)], _ x: Double, _ y: Double, _ r0: Double, _ r1: Double) -> GraphicsContext.Shading {
        .radialGradient(Gradient(stops: stops.map { Gradient.Stop(color: $0.1, location: $0.0) }),
                        center: CGPoint(x: x, y: y), startRadius: r0, endRadius: r1)
    }

    func glowAt(_ ctx: inout GraphicsContext, _ x: Double, _ y: Double, _ r: Double, _ a: Double) {
        if a <= 0 { return }
        ctx.fill(Path(Self.rect(x - r, y - r, 2 * r, 2 * r)), with: Self.radial([(0, Self.acc(a)), (1, Self.acc(0))], x, y, 0, r))
    }

    // Particles: a deterministic spark burst.
    func burst(_ c: inout GraphicsContext, _ x: Double, _ y: Double, _ age: Double, _ seed: Double,
               _ n: Int = 16, _ radius: Double = 70, _ life: Double = 0.55) {
        if age < 0 || age > life { return }
        let p = age / life, e = Self.eOut(p)
        var ctx = c
        ctx.blendMode = .plusLighter
        for k in 0..<n {
            let kd = Double(k)
            let a = (kd / Double(n)) * Self.tau + Self.hash(seed * 7 + kd) * 0.6
            let d = radius * (0.5 + 0.6 * Self.hash(seed + kd * 3.1)) * e
            let r = (1.2 + 1.8 * Self.hash(kd + seed)) * (1 - p)
            ctx.fill(Self.circle(x + cos(a) * d, y + sin(a) * d * 0.7, r), with: .color(Self.acc(0.9 * (1 - p))))
        }
        glowAt(&ctx, x, y, radius * 0.9, 0.22 * (1 - p))
    }

    // MARK: pill · key · lobes

    static let LCOL: [RGB] = [(126, 240, 200), (70, 200, 180), (200, 255, 235)]

    func lobes(_ c: inout GraphicsContext, _ x0: Double, _ span: Double, _ cy: Double, _ h: Double,
               _ t: Double, _ lvl: Double, _ alpha: Double, _ glow: Double) {
        var ctx = c
        ctx.blendMode = .plusLighter
        if glow > 0 { ctx.addFilter(.shadow(color: Self.acc(0.55 * alpha), radius: glow / 2)) }
        for k in 0..<4 {
            let kd = Double(k)
            let P = 0.625 + 0.25 * kd, u = t / P + kd * 0.31, n = floor(u), life = u - n // periods divide 20 s
            let r1 = Self.hash(kd * 13.7 + n * 1.93), r2 = Self.hash(kd * 7.1 + n * 3.7 + 1), r3 = Self.hash(kd * 5.3 + n * 9.1 + 2)
            let a = sin(life * Double.pi) * (0.1 + lvl), lw = span * (0.1 + 0.16 * r2)
            let lx = x0 + lw + (span - 2 * lw) * (0.15 + 0.7 * r1)
            var path = Path()
            for j in 0...28 {
                let q = Double(j) / 28, s = pow(sin(q * Double.pi), 2)
                let pt = CGPoint(x: lx - lw + 2 * lw * q, y: cy - s * h * 0.4 * a)
                if j == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
            }
            for j in stride(from: 28, through: 0, by: -1) {
                let q = Double(j) / 28, s = pow(sin(q * Double.pi), 2)
                path.addLine(to: CGPoint(x: lx - lw + 2 * lw * q, y: cy + s * h * 0.4 * a))
            }
            let col = Self.LCOL[min(2, Int(floor(r3 * 3)))]
            ctx.fill(path, with: .color(Self.rgba(col, 0.55 * alpha)))
        }
    }

    func pill(_ c: inout GraphicsContext, _ cx: Double, _ cy: Double, _ s: Double, _ t: Double,
              _ lvl: Double, _ appear: Double, _ proc: Double) {
        if appear <= 0.001 { return }
        let ph = 36 * s, pw = Self.lerp(36, 160, Self.clamp(appear, 0, 1.2)) * s, a = Self.clamp(appear * 2.5)
        var ctx = c
        ctx.opacity *= a
        let shape = Self.roundRect(cx - pw / 2, cy - ph / 2, pw, ph, ph / 2)
        var shadowed = ctx
        shadowed.addFilter(.shadow(color: Self.acc(0.22), radius: 22 * s / 2))
        shadowed.fill(shape, with: .color(.black))
        ctx.stroke(shape, with: .color(Self.acc(0.22)), lineWidth: 1)
        ctx.clip(to: shape)
        let inset = ph * 0.6, span = pw - inset * 2, inner = Self.clamp((appear - 0.45) * 2.2)
        if span > 2 && inner > 0 {
            ctx.opacity *= inner
            var line = Path()
            line.move(to: CGPoint(x: cx - span / 2, y: cy)); line.addLine(to: CGPoint(x: cx + span / 2, y: cy))
            ctx.stroke(line, with: .color(Self.acc(0.3)), lineWidth: max(1, ph * 0.03))
            lobes(&ctx, cx - span / 2, span, cy, ph, t, lvl * (1 - proc), 1, ph * 0.35)
            if proc > 0 {
                let sx = cx - span / 2 + span * Self.mod(t * 2, 1)
                ctx.fill(Path(Self.rect(sx - ph, cy - ph, ph * 2, ph * 2)),
                         with: Self.radial([(0, Self.acc(0.55 * proc)), (1, Self.acc(0))], sx, cy, 0, ph * 0.55))
            }
        }
    }

    func keycap(_ c: inout GraphicsContext, _ x: Double, _ y: Double, _ kw: Double, _ kh: Double,
                press: Double, r: Double, depth: Double) {
        let glow = press, dy = press * depth * 0.8
        var ctx = c
        ctx.fill(Self.roundRect(x, y + depth, kw, kh, r), with: .color(Color(.sRGB, red: 2 / 255, green: 3 / 255, blue: 3 / 255)))
        ctx.fill(Self.roundRect(x + 0.5, y + depth * 0.55 + dy * 0.4, kw - 1, kh, r),
                 with: .color(Color(.sRGB, red: 11 / 255, green: 13 / 255, blue: 12 / 255)))
        let face = Self.roundRect(x, y + dy, kw, kh, r)
        let grad = GraphicsContext.Shading.linearGradient(
            Gradient(colors: [Self.mix((34, 38, 37), (22, 34, 30), press), Self.mix((19, 21, 20), (12, 18, 16), press)]),
            startPoint: CGPoint(x: 0, y: y + dy), endPoint: CGPoint(x: 0, y: y + dy + kh))
        if glow > 0 {
            var lit = ctx
            lit.addFilter(.shadow(color: Self.acc(0.6 * glow), radius: kh * 0.45 * glow / 2))
            lit.fill(face, with: grad)
        } else {
            ctx.fill(face, with: grad)
        }
        ctx.stroke(face, with: .color(glow > 0 ? Self.acc(0.12 + 0.6 * glow) : Self.wht(0.075)), lineWidth: 1)
        let sheen = Path(roundedRect: Self.rect(x + 1, y + dy + 1, kw - 2, kh * 0.5),
                         cornerRadii: RectangleCornerRadii(topLeading: r - 1, bottomLeading: 0, bottomTrailing: 0, topTrailing: r - 1))
        ctx.fill(sheen, with: .linearGradient(Gradient(colors: [Self.wht(0.06 * (1 - press * 0.6)), Self.wht(0)]),
                                              startPoint: CGPoint(x: 0, y: y + dy), endPoint: CGPoint(x: 0, y: y + dy + kh * 0.5)))
        // The user's own key: ⌘ by default, its glyph or name otherwise, shrunk to fit the cap.
        let glyph = words.hotkey.isEmpty ? "⌘" : words.hotkey
        var size = kh * 0.44
        let fit = kw * 0.78, wide = width(ctx, glyph, Self.f(size, 500))
        if wide > fit { size *= fit / wide }
        txt(&ctx, glyph, x + kw / 2, y + dy + kh / 2 + 0.5, Self.f(size, 500), Self.mix(Self.WHITE, Self.ACC, glow, 0.88))
    }

    // Squash-and-stretch pop: returns [sx, sy].
    static func pop(_ p: Double) -> (Double, Double) {
        let s = spring(p), q = sin(Double.pi * clamp(p * 1.6)) * (1 - p) * 0.22
        return (s * (1 + q), s * (1 - q))
    }

    func keyAndPill(_ c: inout GraphicsContext, _ cx: Double, _ cy: Double, _ sc: Double, _ t: Double,
                    _ tau: Double, _ b: Beat, _ seed: Double, _ appearP: Double) {
        if appearP <= 0.001 { return }
        let press = Self.keyPress(tau, b), lvl = Self.voice(tau, seed, b)
        let proc = Self.prog(tau, b.ku, b.ku + 0.05) * (1 - Self.prog(tau, b.res, b.res + 0.15))
        let (sx, sy) = Self.pop(appearP)
        var ctx = c
        ctx.translateBy(x: cx, y: cy)
        ctx.scaleBy(x: sx * sc, y: sy * sc)
        let kw = 46.0, gap = 18.0, pw = 160.0, tot = kw + gap + pw, kx = -tot / 2
        glowAt(&ctx, kx + kw / 2, 0, 70, 0.16 * press)
        keycap(&ctx, kx, -24, kw, 44, press: press, r: 10, depth: 5)
        var link = Path()
        link.move(to: CGPoint(x: kx + kw + 3, y: 0)); link.addLine(to: CGPoint(x: kx + kw + gap - 3, y: 0))
        ctx.stroke(link, with: .color(Self.acc(0.12 + 0.35 * press)), lineWidth: 1)
        glowAt(&ctx, kx + kw + gap + pw / 2, 0, 110, 0.12 * max(press, proc))
        pill(&ctx, kx + kw + gap + pw / 2, 0, 1, t, lvl, 1, proc)
    }

    // MARK: result

    struct Box { var w: Double; var h: Double; var face: Face; var tw: Double }

    func resultBox(_ ctx: GraphicsContext, _ L: Stop, _ fs: Double) -> Box {
        if L.mode == 3 {
            let nf = Self.tFont(L, fs * 0.9, 500)
            let mw = L.out.map { width(ctx, $0, nf, rtl: L.rtl) }.max() ?? 0
            return Box(w: mw + fs * 1.15, h: fs * 1.5 * Double(L.out.count), face: nf, tw: mw)
        }
        let tf = Self.tFont(L, fs, L.mode == 0 ? 500 : 600), tw = width(ctx, L.out[0], tf, rtl: L.rtl)
        if L.mode == 2 { return Box(w: tw + fs * 1.3, h: fs * 1.8, face: tf, tw: tw) }
        return Box(w: tw, h: fs * 1.3, face: tf, tw: tw)
    }

    func fitFs(_ ctx: GraphicsContext, _ L: Stop, _ fsMax: Double, _ maxW: Double) -> Double {
        let b = resultBox(ctx, L, fsMax)
        return b.w <= maxW ? fsMax : floor(fsMax * maxW / b.w * 2) / 2
    }

    /// Which characters Super added — punctuation, digits, and the capital of a word that was
    /// said in lower case — as the page's `drawResult` decides it.
    static func superAdded(_ L: Stop) -> [Bool] {
        let out = Array(L.out[0])
        if L.rtl { return out.indices.map { $0 == out.count - 1 && out[$0] == "." } }
        let rawWords = Set(L.raw.split(separator: " ").map(String.init))
        var flags = [Bool](repeating: false, count: out.count), wordStart = 0
        for i in out.indices {
            let ch = out[i]
            if ch == " " { wordStart = i + 1; continue }
            var added = "0123456789!?.,:—".contains(ch)
            if !added && i == wordStart && String(ch) != String(ch).lowercased() {
                let rest = String(out[i...])
                let word = rest.split(whereSeparator: { " ,.!?:".contains($0) }).first.map(String.init) ?? rest
                added = rawWords.contains(word.lowercased())
            }
            flags[i] = added
        }
        return flags
    }

    // The mode-specific result, centred: x = left of its box, cy = vertical centre.
    func drawResult(_ c: inout GraphicsContext, _ L: Stop, _ x: Double, _ cy: Double, _ fs: Double, _ age: Double) {
        if age < 0 { return }
        let b = resultBox(c, L, fs)
        var ctx = c
        func clipTo(_ g: inout GraphicsContext, _ bx: Double, _ bw: Double, _ p: Double) {
            g.clip(to: Path(Self.rect(bx + bw * (1 - p) / 2 - 3, cy - 300, bw * p + 6, 600)))
        }
        switch L.mode {
        case 3: // Note: a checklist, line by line
            for (li, s) in L.out.enumerated() {
                let la = Self.eOut(Self.clamp((age - Double(li) * 0.16) / 0.42))
                if la <= 0 { continue }
                let ly = cy - b.h / 2 + fs * 1.5 * (Double(li) + 0.5) + (1 - la) * fs * 0.3, bs = fs * 0.6
                var g = ctx
                g.opacity *= la
                let bx = L.rtl ? x + b.w - bs : x
                g.stroke(Self.roundRect(bx, ly - bs / 2, bs, bs, bs * 0.3), with: .color(Self.acc(0.95)),
                         lineWidth: max(1.2, fs * 0.075))
                if L.rtl {
                    txt(&g, s, x + b.w - fs * 1.15, ly + 0.5, b.face, Self.wht(0.94), rtl: true, anchor: .trailing)
                } else {
                    txt(&g, s, x + fs * 1.15, ly + 0.5, b.face, Self.wht(0.94), anchor: .leading)
                }
            }
        case 2: // Message: a sent bubble
            let s = Self.lerp(0.82, 1, Self.spring(Self.clamp(age / 0.5))), a = Self.clamp(age / 0.12)
            let ox = L.rtl ? x : x + b.w, oy = cy + b.h / 2
            ctx.translateBy(x: ox, y: oy); ctx.scaleBy(x: s, y: s); ctx.translateBy(x: -ox, y: -oy)
            ctx.opacity *= a
            let r = b.h / 2
            let radii = L.rtl
                ? RectangleCornerRadii(topLeading: r, bottomLeading: 5, bottomTrailing: r, topTrailing: r)
                : RectangleCornerRadii(topLeading: r, bottomLeading: r, bottomTrailing: 5, topTrailing: r)
            ctx.fill(Path(roundedRect: Self.rect(x, cy - b.h / 2, b.w, b.h), cornerRadii: radii), with: .color(Self.acc(1)))
            let tp = Self.eOut(Self.clamp((age - 0.08) / 0.36))
            var g = ctx
            clipTo(&g, x + fs * 0.65, b.tw, tp)
            txt(&g, L.out[0], x + fs * 0.65, cy + 0.5, b.face, Color(.sRGB, red: 3 / 255, green: 20 / 255, blue: 14 / 255),
                rtl: L.rtl, anchor: .leading)
        default: // Raw grey and as spoken; Super white with green on what it added
            let p = Self.eOut(Self.clamp(age / 0.38))
            var g = ctx
            clipTo(&g, x, b.tw, p)
            if L.mode == 1 {
                let flags = Self.superAdded(L)
                var attributed = AttributedString()
                for (ch, added) in zip(L.out[0], flags) {
                    var run = AttributedString(String(ch))
                    run.foregroundColor = added ? Self.acc(1) : Self.wht(0.96)
                    attributed += run
                }
                if L.rtl {
                    attributed = AttributedString("\u{202B}") + attributed + AttributedString("\u{202C}")
                }
                var face = b.face
                face.size = Self.snap(face.size)
                let r = g.resolve(Text(attributed).font(face.font))
                g.draw(r, at: CGPoint(x: x, y: cy + 0.5), anchor: .leading)
            } else {
                txt(&g, L.out[0], x, cy + 0.5, b.face, Self.wht(0.6), rtl: L.rtl, anchor: .leading)
            }
        }
    }

    // Little sparks off the characters Super added.
    func burstAdded(_ ctx: inout GraphicsContext, _ L: Stop, _ x: Double, _ cy: Double, _ fs: Double, _ age: Double) {
        if age > 0.5 { return }
        if L.rtl { burst(&ctx, x + 3, cy, age, 9, 8, 22, 0.5); return }
        let tf = Self.tFont(L, fs, 600), out = Array(L.out[0]), flags = Self.superAdded(L)
        for i in out.indices where flags[i] && !"—".contains(out[i]) && !out[i].isNumber {
            let a = width(ctx, String(out[..<i]), tf), b = width(ctx, String(out[...i]), tf)
            burst(&ctx, x + (a + b) / 2, cy, age, Double(i + 3), 7, 18, 0.5)
        }
    }

    func result(_ ctx: inout GraphicsContext, _ L: Stop, _ cx: Double, _ cy: Double, _ fs: Double, _ age: Double) {
        let b = resultBox(ctx, L, fs)
        drawResult(&ctx, L, cx - b.w / 2, cy, fs, age)
        if L.mode == 1 && age > 0.25 { burstAdded(&ctx, L, cx - b.w / 2, cy, fs, age - 0.25) }
    }

    // Grey "what you said" line, growing word by word (large, centred).
    func saidLine(_ c: inout GraphicsContext, _ L: Stop, _ tau: Double, _ b: Beat, _ x: Double, _ y: Double,
                  _ px: Double, _ alpha: Double) {
        guard let sp = Self.spokenSoFar(L.raw, tau, b, 7), alpha > 0 else { return }
        var ctx = c
        ctx.opacity = alpha
        let s = L.rtl ? sp.s + (sp.more ? " …" : "") : (sp.more ? "… " : "") + sp.s
        let face = L.rtl ? Self.f(px * 1.05, 400) : Self.f(px, 400, italic: true)
        txt(&ctx, s, x, y + (1 - sp.fresh) * 3, face, Self.wht(0.5), rtl: L.rtl)
    }

    static func resFs(_ L: Stop, _ narrow: Bool) -> Double { L.mode == 3 ? (narrow ? 21 : 24) : (narrow ? 24 : 30) }

    // The said line → result (centre x, y).
    func speakAndLand(_ c: inout GraphicsContext, _ L: Stop, _ tau: Double, _ b: Beat, _ t: Double,
                      _ x: Double, _ y: Double, _ narrow: Bool, _ maxW: Double, _ a: Double) {
        if a <= 0 { return }
        var ctx = c
        ctx.opacity *= a
        saidLine(&ctx, L, tau, b, x, y, narrow ? 17 : 20, Self.prog(tau, b.sa, b.sa + 0.12) * (1 - Self.prog(tau, b.ku, b.ku + 0.15)))
        if tau >= b.res {
            let fs = fitFs(ctx, L, Self.resFs(L, narrow), maxW), age = tau - b.res
            var g = ctx
            g.translateBy(x: x, y: y)
            let s = Self.lerp(0.94, 1, Self.eOut(Self.prog(age, 0, 0.4)))
            g.scaleBy(x: s, y: s)
            result(&g, L, 0, 0, fs, age)
        }
    }

    // MARK: globe

    /// Natural Earth 110 m land (public domain), sampled every 3° in equal-area rows, one bit per
    /// sample: 529 bytes in Resources/GlobeLand.bin, unpacked once to ~1,200 unit vectors.
    static let land: [SIMD3<Double>] = {
        guard let url = Bundle.module.url(forResource: "GlobeLand", withExtension: "bin"),
              let raw = try? Data(contentsOf: url) else { return [] }
        let bytes = [UInt8](raw)
        var pts: [SIMD3<Double>] = [], i = 0
        for lat in stride(from: -57, to: 82, by: 3) {
            let la: Double = Double(lat) * Double.pi / 180
            let n = max(6, jsRound(120 * cos(la)))
            for j in 0..<n {
                defer { i += 1 }
                guard i >> 3 < bytes.count, (bytes[i >> 3] >> (i & 7)) & 1 == 1 else { continue }
                let step: Double = 360 / Double(n)
                let deg: Double = -180 + (Double(j) + 0.5) * step
                let lo: Double = deg * Double.pi / 180
                let cl: Double = cos(la)
                pts.append(SIMD3<Double>(cl * sin(lo), sin(la), cl * cos(lo)))
            }
        }
        return pts
    }()

    static func unit(_ lat: Double, _ lon: Double) -> SIMD3<Double> {
        let la = lat * .pi / 180, lo = lon * .pi / 180
        return SIMD3(cos(la) * sin(lo), sin(la), cos(la) * cos(lo))
    }

    func globe(_ c: inout GraphicsContext, _ gx: Double, _ gy: Double, _ R: Double, _ lat0: Double, _ lon0: Double,
               _ hiCode: String, _ hiA: Double, _ t: Double, _ pinA: Double) -> (x: Double, y: Double, z: Double) {
        let cl = cos(lon0), sl = sin(lon0), cp = cos(lat0), sp = sin(lat0)
        func P(_ v: SIMD3<Double>) -> SIMD3<Double> {
            let x1 = v.x * cl - v.z * sl, z1 = v.x * sl + v.z * cl
            return SIMD3(x1, v.y * cp - z1 * sp, v.y * sp + z1 * cp)
        }
        var ctx = c
        ctx.fill(Path(Self.rect(gx - R * 1.5, gy - R * 1.5, R * 3, R * 3)),
                 with: Self.radial([(0, Self.acc(0.13)), (0.35, Self.acc(0.04)), (1, Self.acc(0))], gx, gy, R * 0.92, R * 1.5))
        let disc = Self.circle(gx, gy, R)
        ctx.fill(disc, with: .color(.black))
        ctx.fill(disc, with: .radialGradient(Gradient(colors: [Self.acc(0.075), Self.acc(0.01)]),
                                             center: CGPoint(x: gx - R * 0.4, y: gy - R * 0.45), startRadius: 0, endRadius: R * 1.05))
        ctx.stroke(disc, with: .color(Self.acc(0.28)), lineWidth: 1)
        let hi = Self.REG[hiCode] ?? (0, 0)
        let hv = Self.unit(hi.0, hi.1), ds = max(1.1, R / 40)
        // The dots, bucketed by brightness: one fill per bucket instead of one per dot.
        var buckets = [Path](repeating: Path(), count: 41)
        for v in Self.land {
            let q = P(v)
            if q.z <= 0.03 { continue }
            let near = Self.clamp(((v * hv).sum() - 0.975) / 0.02) * hiA, s = ds * (0.65 + 0.45 * q.z)
            let r = Self.rect(gx + q.x * R - s / 2, gy - q.y * R - s / 2, s, s)
            if near > 0.02 {
                ctx.fill(Path(r), with: .color(Self.mix((150, 175, 168), Self.ACC, near, 0.35 + 0.6 * q.z)))
            } else {
                buckets[min(40, Self.jsRound((0.12 + 0.5 * q.z) * 40))].addRect(r)
            }
        }
        for (k, path) in buckets.enumerated() where !path.isEmpty {
            ctx.fill(path, with: .color(Self.rgba((150, 175, 168), Double(k) / 40)))
        }
        // the five speaking regions
        for code in ["UZ", "EN", "RU", "AR", "TR"] {
            guard let reg = Self.REG[code] else { continue }
            let q = P(Self.unit(reg.0, reg.1))
            if q.z <= 0.05 { continue }
            let isHi = code == hiCode, px = gx + q.x * R, py = gy - q.y * R
            if isHi && pinA > 0 {
                glowAt(&ctx, px, py, R * 0.45, 0.35 * pinA * q.z)
                for k in 0..<2 {
                    let ph = Self.mod(t * 1.25 + Double(k) * 0.5, 1)
                    ctx.stroke(Self.circle(px, py, 3 + ph * R * 0.32), with: .color(Self.acc(0.6 * (1 - ph) * pinA * q.z)), lineWidth: 1.2)
                }
            }
            let fill = isHi ? Self.mix(Self.WHITE, Self.ACC, pinA, 0.55 + 0.45 * q.z) : Self.acc(0.45 * q.z)
            ctx.fill(Self.circle(px, py, (isHi ? Self.lerp(1.8, 3.4, pinA) : 1.7) * max(0.8, R / 60)), with: .color(fill))
        }
        let q = P(hv)
        return (gx + q.x * R, gy - q.y * R, q.z)
    }

    // Labels riding an orbit round the globe. front=false draws the far half (call before the globe).
    struct Orbit {
        var gx, gy, rx, ry, pos, vel: Double
        var count: Int
        var dir: Double
        var item: (Int) -> (text: String, rtl: Bool)
        var px, alpha, hot: Double
        var skip: Bool
    }

    static func halfEllipse(_ gx: Double, _ gy: Double, _ rx: Double, _ ry: Double, front: Bool) -> Path {
        var p = Path()
        let a0 = front ? 0 : Double.pi
        for j in 0...48 {
            let a = a0 + Double.pi * Double(j) / 48
            let pt = CGPoint(x: gx + cos(a) * rx, y: gy + sin(a) * ry)
            if j == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        return p
    }

    func orbitRing(_ c: inout GraphicsContext, _ o: Orbit, front: Bool) {
        if o.alpha <= 0.003 { return }
        var ctx = c
        ctx.stroke(Self.halfEllipse(o.gx, o.gy, o.rx, o.ry, front: front), with: .color(Self.acc(0.13 * o.alpha)), lineWidth: 1)
        let base = Self.jsRound(o.pos), h0 = o.count / 2
        var its: [(k: Int, d: Double, a: Double, q: Double)] = []
        for j in -h0..<(o.count - h0) {
            let k = base + j, d = Double(k) - o.pos, a = Double.pi / 2 + o.dir * d * Self.tau / Double(o.count)
            if (sin(a) >= 0) != front { continue }
            its.append((k, d, a, (1 + sin(a)) / 2))
        }
        its.sort { $0.q < $1.q }
        for it in its {
            let chosen = abs(it.d) < 0.5
            if o.skip && chosen { continue }
            let I = o.item(it.k)
            let size = o.px * Self.lerp(0.42, 1, pow(it.q, 1.3)), a2 = o.alpha * Self.lerp(0.1, 1, pow(it.q, 2.4))
            let lsize = I.rtl ? size * 1.02 : size
            if abs(o.vel) > 1.5 { // motion trail back along the orbit
                for g in stride(from: 6, through: 1, by: -1) {
                    let ang = it.a + o.dir * o.vel * 0.0055 * Double(g) * Self.tau / Double(o.count)
                    label(&ctx, I.text, o.gx + cos(ang) * o.rx, o.gy + sin(ang) * o.ry, size: lsize, weight: 700,
                          Self.wht(a2 * 0.07 * (1 - Double(g) / 7)))
                }
            }
            var g = ctx
            g.opacity = a2
            label(&g, I.text, o.gx + cos(it.a) * o.rx, o.gy + sin(it.a) * o.ry, size: lsize, weight: 700,
                  chosen && o.hot > 0 ? Self.mix(Self.WHITE, Self.ACC, o.hot) : Self.wht(1), keyline: size * 0.28)
        }
    }

    // Header "Oʻzbekcha · Message": the two slot centres the chosen labels fly into.
    func headerSlots(_ ctx: GraphicsContext, _ L: Stop, _ cx: Double, _ px: Double) -> (lx: Double, mx: Double, dot: Double) {
        let lw = Self.labelWidth(L.name, size: Self.nameFont(L, px, 700).size, weight: 700)
        let mw = Self.labelWidth(modeName(L.mode), size: px, weight: 600), gap = px * 1.5
        let x0 = cx - (lw + gap + mw) / 2
        return (x0 + lw / 2, x0 + lw + gap + mw / 2, x0 + lw + gap / 2)
    }

    func vignette(_ ctx: inout GraphicsContext, _ w: Double, _ h: Double) {
        let e = min(0.12, 90 / w), black = { (a: Double) in Color(.sRGB, white: 0, opacity: a) }
        ctx.fill(Path(Self.rect(0, 0, w, h)), with: .linearGradient(
            Gradient(stops: [.init(color: black(0.9), location: 0), .init(color: black(0), location: e),
                             .init(color: black(0), location: 1 - e), .init(color: black(0.9), location: 1)]),
            startPoint: .zero, endPoint: CGPoint(x: w, y: 0)))
        ctx.fill(Path(Self.rect(0, 0, w, h)), with: .linearGradient(
            Gradient(stops: [.init(color: black(0.55), location: 0), .init(color: black(0), location: 0.2),
                             .init(color: black(0), location: 0.8), .init(color: black(0.55), location: 1)]),
            startPoint: .zero, endPoint: CGPoint(x: 0, y: h)))
    }

    // MARK: V19

    func draw(_ ctx: inout GraphicsContext, w: Double, h: Double, t rawT: Double) {
        let t = Self.mod(rawT, Self.loop)
        let (n, tau) = Self.beatOf(t), i = Self.imod(n, 5)
        let L = Self.SEQ[i], P = Self.SEQ[Self.imod(n - 1, 5)], narrow = w < 760
        ctx.fill(Path(Self.rect(0, 0, w, h)), with: .color(.black))
        // camera: select (globe centred, big) → work (globe parked left, small) → back
        let cam = Self.eIO(Self.prog(tau, 1.66, 2.02)) * (1 - Self.eIO(Self.prog(tau, 3.66, 4.0)))
        let Rs = narrow ? 50.0 : 60, Rw = narrow ? 27.0 : 36, GXw = narrow ? 50.0 : 104
        let gx = Self.lerp(w / 2, GXw, cam), gy = Self.lerp(96, 95, cam), R = Self.lerp(Rs, Rw, cam)
        let lb = GXw + Rw + 24, rb = w - (narrow ? 28 : 44), XC = Self.lerp(w / 2, (lb + rb) / 2, cam), maxW = rb - lb
        // facing: spin from the previous language's region to this one (with an extra turn), synced to the ring
        let fr = Self.langFrac(t, 0, 0.95)
        let (la0, lo0) = Self.REG[P.code] ?? (0, 0), (la1, lo1) = Self.REG[L.code] ?? (0, 0)
        let lon = (lo0 - (Self.mod(lo0 - lo1, 360) + 360) * fr) * .pi / 180
        let lat = Self.lerp(la0, la1, Self.smooth(Self.clamp(fr))) * 0.72 * .pi / 180
        let rx = narrow ? 228 : min(w * 0.36, 350), ry = narrow ? 40.0 : 44, px = narrow ? 25.0 : 30
        let lp = Self.spin(t, Self.langBase, 0, 0.95), lv = Self.spinVel(t, Self.langBase, 0, 0.95)
        let mp = Self.spin(t, Self.modeBase, 1.04, 1.62), mv = Self.spinVel(t, Self.modeBase, 1.04, 1.62)
        let lHot = Self.prog(tau, 0.86, 0.96), mHot = Self.prog(tau, 1.52, 1.62)
        let LR = Orbit(gx: gx, gy: gy, rx: rx, ry: ry, pos: lp, vel: lv, count: 5, dir: 1,
                       item: { k in let S = Self.SEQ[Self.imod(k, 5)]; return (S.name, S.rtl) },
                       px: px, alpha: Self.prog(tau, 0, 0.16) * (1 - Self.prog(tau, 0.98, 1.14)), hot: lHot, skip: tau >= 0.98)
        let names = words.modes
        let MR = Orbit(gx: gx, gy: gy, rx: rx * 0.88, ry: ry * 0.95, pos: mp, vel: mv, count: 4, dir: -1,
                       item: { k in (names.indices.contains(Self.imod(k, 4)) ? names[Self.imod(k, 4)] : "", false) },
                       px: px * 0.92, alpha: Self.prog(tau, 1.0, 1.16) * (1 - Self.prog(tau, 1.62, 1.76)), hot: mHot, skip: tau >= 1.62)
        orbitRing(&ctx, LR, front: false)
        orbitRing(&ctx, MR, front: false)
        let pinA = Self.prog(tau, 0.9, 1.1) * (1 - Self.prog(tau, 3.7, 3.95))
        let pin = globe(&ctx, gx, gy, R, lat, lon, L.code, Self.prog(tau, 0.8, 1.0) * (1 - Self.prog(tau, 3.7, 3.95)), t, pinA)
        burst(&ctx, gx, gy + ry, tau - 0.94, Double(n * 3 + 1), 16, narrow ? 110 : 150)
        burst(&ctx, gx, gy + ry * 0.95, tau - 1.6, Double(n * 3 + 2), 12, 100)
        orbitRing(&ctx, LR, front: true)
        orbitRing(&ctx, MR, front: true)
        // chosen labels fly up into the header
        let endA = 1 - Self.prog(tau, 3.68, 3.86), hpx = narrow ? 15.0 : 16, hy = 20.0
        let hs = headerSlots(ctx, L, XC, hpx)
        if tau >= 0.98 && endA > 0 {
            let p = Self.eIO(Self.prog(tau, 0.98, 1.32)), size = Self.lerp(px, hpx, p)
            var g = ctx
            g.opacity = endA
            label(&g, L.name, Self.lerp(gx, hs.lx, p), Self.lerp(gy + ry, hy, p) - sin(Double.pi * p) * 10,
                  size: Self.nameFont(L, size, 700).size, weight: 700, Self.acc(1), keyline: size * 0.28 * (1 - p))
        }
        if tau >= 1.62 && endA > 0 {
            let p = Self.eIO(Self.prog(tau, 1.62, 1.94))
            var g = ctx
            g.opacity = endA
            label(&g, modeName(L.mode), Self.lerp(gx, hs.mx, p), Self.lerp(gy + ry * 0.95, hy, p) - sin(Double.pi * p) * 10,
                  size: Self.lerp(px * 0.92, hpx, p), weight: p < 0.5 ? 700 : 600, Self.mix(Self.ACC, Self.WHITE, p * 0.9),
                  keyline: px * 0.26 * (1 - p))
            txt(&g, "·", hs.dot, hy, Self.f(hpx, 700), Self.wht(0.35 * Self.prog(tau, 1.85, 1.95)))
        }
        // a quiet radio ripple from the region while you speak
        if cam > 0.9 && pin.z > 0 {
            let lvl = Self.voice(tau, Double(i) * 1.3, Self.B19)
            for k in 0..<3 {
                let ph = Self.mod(t * 1.6 + Double(k) / 3, 1), r = 6 + ph * 34
                var arc = Path()
                arc.addArc(center: CGPoint(x: pin.x, y: pin.y), radius: r, startAngle: .radians(-0.7), endAngle: .radians(0.7), clockwise: false)
                ctx.stroke(arc, with: .color(Self.acc(0.5 * (1 - ph) * Self.clamp(lvl * 1.6) * endA)), lineWidth: 1.2)
            }
        }
        var g = ctx
        g.opacity = endA
        keyAndPill(&g, XC, 153, narrow ? 0.78 : 0.85, t, tau, Self.B19, Double(i) * 1.3, Self.prog(tau, 1.76, 2.2))
        speakAndLand(&ctx, L, tau, Self.B19, t, XC, 86, narrow, maxW, endA)
        vignette(&ctx, w, h)
    }
}
