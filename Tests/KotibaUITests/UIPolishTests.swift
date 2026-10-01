import AppKit
import Foundation
import KotibaAudio
import KotibaCore
import KotibaPlatform
import SwiftUI
import Testing

@testable import KotibaUI

// The owner's review of 2026-09-30: the pill at the bottom with only its animation, nothing that
// heals itself shown as a problem, the words said to be on the clipboard when there was nowhere
// to paste, counts that count up, and the real icon as the brand mark.

/// A microphone that is cold, for a reason the test names.
final class ColdMicrophone: DictationMicrophone, @unchecked Sendable {
    let error: String
    let needsTheUser: Bool
    init(error: String, needsTheUser: Bool) {
        self.error = error
        self.needsTheUser = needsTheUser
    }
    func liveTake(onLimit: (@Sendable () -> Void)?) -> any LiveAudioSource {
        ReplayMicrophone(speed: 4).liveTake(onLimit: onLimit)
    }
    func warmUp() async {}
    var isWarm: Bool { false }
    var lastWarmUpError: String? { error }
    var warmUpNeedsTheUser: Bool { needsTheUser }
    func currentPeak() -> Float { 0 }
    func setPrefersBuiltInMicWithBluetooth(_ value: Bool) {}
}

@Suite("Only what needs the user is a blocker")
@MainActor
struct SelfHealingBlockerTests {

    @Test("a changed input device is rebuilt on the next press, so it is not a blocker")
    func deviceChangeIsNotABlocker() async {
        let mic = ColdMicrophone(
            error: "the input device changed — the audio graph is rebuilt on the next press",
            needsTheUser: false)
        let controller = DictationController(
            settings: .hermetic(),
            devices: .init(microphone: mic, sink: { NowhereSink() }))
        await controller.refreshBlockers()
        #expect(!controller.blockers.contains { $0.id == "microphone" },
                "\(controller.blockers.map(\.id))")
    }

    @Test("a denied microphone still is — that one only the user can fix")
    func deniedIsABlocker() async {
        let mic = ColdMicrophone(error: "microphone access has not been granted",
                                 needsTheUser: true)
        let controller = DictationController(
            settings: .hermetic(),
            devices: .init(microphone: mic, sink: { NowhereSink() }))
        await controller.refreshBlockers()
        #expect(controller.blockers.contains { $0.id == "microphone" })
    }

    @Test("a model that is downloading is not missing; one whose download failed is again")
    func downloadingHoldsTheRowBack() async {
        let controller = DictationController(settings: .hermetic(), devices: .testing)
        await controller.refreshBlockers()
        try? #require(controller.detectedBlockers.contains { $0.id == "uzbek-model" })

        controller.models.states[.uzbek] = .downloading(1_000)
        #expect(!controller.blockers.contains { $0.id == "uzbek-model" })
        controller.models.states[.uzbek] = .queued
        #expect(!controller.blockers.contains { $0.id == "uzbek-model" })
        controller.models.states[.uzbek] = .failed("offline")
        #expect(controller.blockers.contains { $0.id == "uzbek-model" })
    }

    @Test("the hero does not call a blocked app 'Needs attention' any more")
    func calmStatus() async {
        let controller = DictationController(settings: .hermetic(), devices: .testing)
        controller.recordHotkeyFailure("the tap was refused")
        await controller.refreshBlockers()
        let status = LiveStatus(controller: controller)
        #expect(status.title == "Almost ready")
        #expect(status.tone == .neutral)
    }
}

@Suite("The pill")
struct PillPolishTests {

    @Test("a finished dictation with nowhere to paste reads as copied, softly, not as a failure")
    func copiedState() {
        #expect(PillState(status: .succeeded("hi"), record: nil, copied: true) == .copied)
        #expect(PillState(status: .succeeded("hi"), record: nil, copied: false)
                == .success(millis: nil))
        // Only an outcome can be "copied": a live dictation is never relabelled.
        #expect(PillState(status: .listening, record: nil, copied: true) == .listening)
        #expect(PillState.copied.dwell != nil)
    }

    @Test("three styles, the owner's picks, and Siri lobes unless the user chose otherwise")
    func styleChoice() {
        #expect(PillAnimationStyle.allCases == [.sirifilled, .sirilobes, .barsglow])
        #expect(PillAnimationStyle.default == .sirilobes)
        #expect(AppSettings.hermetic().pillStyle == .sirilobes)
        // Every style has a name of its own in the picker.
        #expect(Set(PillAnimationStyle.allCases.map(\.displayName)).count == 3)
    }

    @Test("every style draws a frame without trapping, listening and processing")
    @MainActor
    func everyStyleDraws() {
        for style in PillAnimationStyle.allCases {
            let engine = VoiceAnimationEngine(seed: 7)
            var date = Date()
            for step in 0..<90 {
                date += 1.0 / 60
                let frame = engine.advance(to: date, level: step < 60 ? 0.2 : 0,
                                           processing: step >= 60, style: style, reduceMotion: false)
                let renderer = ImageRenderer(content: Canvas { context, size in
                    PillStyleRenderer.draw(style, frame, in: &context, size: size)
                }.frame(width: PillView.width, height: PillView.height))
                if step % 30 == 29 { #expect(renderer.cgImage != nil, "\(style)") }
            }
        }
    }

    @Test("the animation follows the clock, not the frame rate: 60 Hz and 120 Hz land in the same place")
    func frameRateIndependent() {
        for style in PillAnimationStyle.allCases {
            let slow = VoiceAnimationEngine(seed: 3), fast = VoiceAnimationEngine(seed: 3)
            let start = Date()
            var a = VoiceFrame(), b = VoiceFrame()
            for step in 0...120 {
                a = slow.advance(to: start + Double(step) / 60, level: 0.1, processing: false,
                                 style: style, reduceMotion: false)
            }
            for step in 0...240 {
                b = fast.advance(to: start + Double(step) / 120, level: 0.1, processing: false,
                                 style: style, reduceMotion: false)
            }
            #expect(abs(a.t - b.t) < 1e-9, "\(style)")
            #expect(abs(a.level - b.level) < 0.02, "\(style): \(a.level) vs \(b.level)")
            // The lobes tick at 60 Hz whatever the display does: the same seed spawns the same
            // ones, give or take one whose spawn roll landed on a level a hair different.
            #expect(abs(a.lobes.count - b.lobes.count) <= 1, "\(style)")
        }
    }

    @Test("Reduce Motion is one still frame, whatever the voice does")
    func reduceMotionIsStill() {
        for style in PillAnimationStyle.allCases {
            let engine = VoiceAnimationEngine(seed: 1)
            let start = Date()
            let first = engine.advance(to: start, level: 0.3, processing: false, style: style,
                                       reduceMotion: true)
            let later = engine.advance(to: start + 1.3, level: 0.01, processing: false, style: style,
                                       reduceMotion: true)
            #expect(first.t == later.t && first.level == later.level, "\(style)")
            #expect(first.level == style.stillLevel)
            #expect(later.lobes.count == (style == .sirilobes ? 3 : 0))
        }
    }

    @Test("the previews' simulated voice speaks in phrases and pauses, in the microphone's units")
    func simulatedVoice() {
        let samples = stride(from: 0.0, to: 20, by: 0.05).map { SimulatedVoice.level(at: $0) }
        #expect(samples.allSatisfy { $0 > 0 && $0 < 0.3 })
        // Through the engine's square-root curve it reaches a real speaking level, and rests.
        let envelopes = samples.map { min(1, sqrt(Double($0) - 0.004) * 2) }
        #expect(envelopes.max()! > 0.5)
        #expect(envelopes.min()! < 0.15)
    }

    #if os(macOS)
    @Test("bottom centre, above the Dock, a little further from the edge than it was from the top")
    func bottomPlacement() {
        // A 14-inch MacBook: 32-point notch, 37-point menu bar, a 70-point Dock at the bottom.
        let frame = NSRect(x: 0, y: 0, width: 1512, height: 982)
        let visible = NSRect(x: 0, y: 70, width: 1512, height: 982 - 70 - 37)
        let gap = HUDPanel.bottomGap(frame: frame, visibleFrame: visible, notch: 32)
        let formerTop: CGFloat = 37 + 6
        #expect(gap > formerTop && gap <= formerTop + 12, "\(gap)")

        let canvas = HUDPanel.canvas
        let origin = HUDPanel.origin(frame: frame, visibleFrame: visible, notch: 32, canvas: canvas)
        // The capsule's bottom edge is the canvas origin plus the shadow room.
        #expect(origin.y + HUDPanel.shadowRoom == visible.minY + gap)
        #expect(origin.y + HUDPanel.shadowRoom > visible.minY, "on the Dock")
        #expect(origin.x + canvas.width / 2 == visible.midX)

        // An auto-hidden menu bar used to put the pill 6 points from the edge; it is floored.
        let bare = NSRect(x: 0, y: 0, width: 1920, height: 1080)
        #expect(HUDPanel.bottomGap(frame: bare, visibleFrame: bare, notch: 0) >= 30)
    }
    #endif
}

@Suite("Counting up")
struct CountUpFormatTests {

    @Test("a count-up stays in its final unit the whole way")
    func unitIsLocked() {
        let latency = Names.millisFormat(toward: 2_100)
        #expect(latency(850) == "0.8 s")
        #expect(latency(2_100) == Names.millis(2_100))
        let fast = Names.millisFormat(toward: 184)
        #expect(fast(92) == "92 ms")
        #expect(fast(184) == Names.millis(184))

        let saved = Names.durationFormat(toward: 25_200)
        #expect(saved(90) == "0.0 h")
        #expect(saved(25_200) == Names.duration(25_200))
        let minutes = Names.durationFormat(toward: 1_800)
        #expect(minutes(1_800) == Names.duration(1_800))
        #expect(Names.countFormat()(34_741) == Names.count(34_741))
    }
}

@Suite("The brand mark is the app icon")
struct BrandMarkTests {

    @Test("the bundled mark is the same pixels as the AppIcon asset")
    func sameAsAppIcon() throws {
        let bundled = try #require(BrandMark.resourceURL)
        let icon = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Apps/macOS/Assets.xcassets/AppIcon.appiconset/icon_256x256.png")
        #expect(try Data(contentsOf: bundled) == Data(contentsOf: icon),
                "Sources/KotibaUI/Resources/BrandMark.png has drifted from the app icon")
    }

    @Test("it loads")
    @MainActor
    func loads() {
        #expect(BrandMark.image != nil)
    }
}
