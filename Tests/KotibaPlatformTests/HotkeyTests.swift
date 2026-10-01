import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaPlatform

// The hotkey's decisions, without an event tap. `PushToTalkMonitor` only turns `CGEvent`s into
// `HotkeyInput`s and feeds them here; everything that can go wrong in the *logic* — a chord read
// as a dictation, a held F-key typing, a lost key-up — is reachable from these tests.

private let rightCommandDown: UInt64 = 0x10_0000 | 0x10     // ⌘ family bit + right-⌘ device bit
private let leftCommandDown: UInt64 = 0x10_0000 | 0x08
private let none: UInt64 = 0

@Suite("Hold a modifier to talk")
struct ModifierHotkeyTests {

    @Test("right ⌘ alone: press, then release")
    func plainHold() {
        var t = HotkeyTracker(spec: .rightCommand)
        #expect(t.handle(.flags(rightCommandDown), now: 0).event == .pressed)
        #expect(t.handle(.flags(none), now: 5).event == .released)
    }

    @Test("left ⌘ is not right ⌘")
    func leftIsNotRight() {
        var t = HotkeyTracker(spec: .rightCommand)
        #expect(t.handle(.flags(leftCommandDown), now: 0).event == nil)
        #expect(t.handle(.flags(none), now: 1).event == nil)
    }

    @Test("right ⌘ then C is ⌘C: the dictation is cancelled and its release reports nothing")
    func chordCancels() {
        var t = HotkeyTracker(spec: .rightCommand)
        #expect(t.handle(.flags(rightCommandDown), now: 0).event == .pressed)
        let c = t.handle(.keyDown(code: 8, isRepeat: false, flags: rightCommandDown), now: 0.15)
        #expect(c.event == .cancelled)
        #expect(!c.swallow, "a listen-only tap never swallows the user's shortcut")
        // A second key in the same chord (⌘C ⌘V) says nothing more.
        #expect(t.handle(.keyDown(code: 9, isRepeat: false, flags: rightCommandDown),
                         now: 0.3).event == nil)
        #expect(t.handle(.flags(none), now: 0.5).event == nil)
        // And the next plain hold is a dictation again.
        #expect(t.handle(.flags(rightCommandDown), now: 2).event == .pressed)
        #expect(t.handle(.flags(none), now: 3).event == .released)
    }

    @Test("a key bumped a minute into a dictation does not throw the minute away")
    func lateKeyIsNotAChord() {
        var t = HotkeyTracker(spec: .rightCommand)
        _ = t.handle(.flags(rightCommandDown), now: 0)
        #expect(t.handle(.keyDown(code: 8, isRepeat: false, flags: rightCommandDown),
                         now: 60).event == nil)
        #expect(t.handle(.flags(none), now: 61).event == .released)
    }

    @Test("adding another modifier is not yet a chord, and the hold survives it")
    func otherModifierAlone() {
        var t = HotkeyTracker(spec: .rightCommand)
        _ = t.handle(.flags(rightCommandDown), now: 0)
        #expect(t.handle(.flags(rightCommandDown | 0x2_0000 | 0x02), now: 0.1).event == nil)
        #expect(t.handle(.flags(rightCommandDown), now: 0.2).event == nil)
        #expect(t.handle(.flags(none), now: 1).event == .released)
    }

    @Test("fn / Globe uses its own flag")
    func globe() {
        var t = HotkeyTracker(spec: .modifier(HotkeySpec.Code.function))
        #expect(t.handle(.flags(0x80_0000), now: 0).event == .pressed)
        #expect(t.handle(.flags(none), now: 1).event == .released)
    }

    @Test("right ⌥, right ⌃ and right ⇧ each answer only to themselves")
    func rightHandModifiers() {
        let cases: [(UInt16, UInt64)] = [
            (HotkeySpec.Code.rightOption, 0x8_0000 | 0x40),
            (HotkeySpec.Code.rightControl, 0x4_0000 | 0x2000),
            (HotkeySpec.Code.rightShift, 0x2_0000 | 0x04),
        ]
        for (code, flags) in cases {
            var t = HotkeyTracker(spec: .modifier(code))
            #expect(t.handle(.flags(rightCommandDown), now: 0).event == nil)
            _ = t.handle(.flags(none), now: 0.1)
            #expect(t.handle(.flags(flags), now: 1).event == .pressed, "\(code)")
            #expect(t.handle(.flags(none), now: 2).event == .released, "\(code)")
        }
    }

    @Test("a key already down when watching starts is adopted: no press, no release")
    func adoptedHold() {
        var t = HotkeyTracker(spec: .rightCommand)
        t.adopt(flags: rightCommandDown, now: 0)
        #expect(t.isHeld)
        #expect(t.handle(.keyDown(code: 8, isRepeat: false, flags: rightCommandDown), now: 0.1)
            .event == nil)
        #expect(t.handle(.flags(none), now: 0.3).event == nil)
        // The next hold is an ordinary one.
        #expect(t.handle(.flags(rightCommandDown), now: 1).event == .pressed)
        #expect(t.handle(.flags(none), now: 2).event == .released)

        var f = HotkeyTracker(spec: .key(HotkeySpec.Code.f13))
        f.adopt(flags: none, now: 0)
        #expect(!f.isHeld)
        #expect(f.handle(.keyUp(code: HotkeySpec.Code.f13), now: 0.1)
            == .init(event: nil, swallow: false))
        #expect(f.handle(.keyDown(code: HotkeySpec.Code.f13, isRepeat: false, flags: none),
                         now: 1).event == .pressed)
    }

    @Test("a resync that shows ⌘ down with no side bits does not end the hold")
    func resyncWithoutSideBits() {
        var t = HotkeyTracker(spec: .rightCommand)
        #expect(t.handle(.flags(rightCommandDown), now: 0).event == .pressed)
        #expect(t.resync(flags: 0x10_0000, keyIsDown: false, now: 0.25) == nil)
        #expect(t.isHeld)
        #expect(t.resync(flags: none, keyIsDown: false, now: 0.5) == .released)
        // The other side genuinely down, and this one up, is still this side's release.
        var u = HotkeyTracker(spec: .rightCommand)
        _ = u.handle(.flags(rightCommandDown), now: 0)
        #expect(u.resync(flags: leftCommandDown, keyIsDown: false, now: 0.25) == .released)
    }

    @Test("a lost key-up is recovered by resync, not left stuck")
    func resyncRecoversLostRelease() {
        var t = HotkeyTracker(spec: .rightCommand)
        _ = t.handle(.flags(rightCommandDown), now: 0)
        // The tap was disabled by timeout and the key-up happened inside that window.
        #expect(t.resync(flags: none, keyIsDown: false, now: 10) == .released)
        #expect(t.handle(.flags(rightCommandDown), now: 11).event == .pressed,
                "the next press must not be swallowed as a repeat")
    }

    @Test("a tap started with the key already down reports the press")
    func resyncCatchesHeldKey() {
        var t = HotkeyTracker(spec: .rightCommand)
        #expect(t.resync(flags: rightCommandDown, keyIsDown: false, now: 0) == .pressed)
        #expect(t.resync(flags: rightCommandDown, keyIsDown: false, now: 1) == nil)
    }
}

@Suite("Hold an ordinary key to talk")
struct KeyHotkeyTests {

    private let f13 = HotkeySpec.key(HotkeySpec.Code.f13)

    @Test("F13: down presses, up releases, and both are swallowed")
    func holdSwallowed() {
        var t = HotkeyTracker(spec: f13)
        let down = t.handle(.keyDown(code: 105, isRepeat: false, flags: none), now: 0)
        #expect(down == .init(event: .pressed, swallow: true))
        let up = t.handle(.keyUp(code: 105), now: 3)
        #expect(up == .init(event: .released, swallow: true))
    }

    @Test("autorepeat while held is swallowed and reports nothing")
    func autorepeat() {
        var t = HotkeyTracker(spec: f13)
        _ = t.handle(.keyDown(code: 105, isRepeat: false, flags: none), now: 0)
        for i in 1...40 {
            let r = t.handle(.keyDown(code: 105, isRepeat: true, flags: none), now: Double(i) * 0.03)
            #expect(r == .init(event: nil, swallow: true))
        }
        #expect(t.handle(.keyUp(code: 105), now: 2).event == .released)
    }

    @Test("other keys pass through untouched while the hotkey is held")
    func otherKeysPass() {
        var t = HotkeyTracker(spec: f13)
        _ = t.handle(.keyDown(code: 105, isRepeat: false, flags: none), now: 0)
        #expect(t.handle(.keyDown(code: 0, isRepeat: false, flags: none), now: 0.5)
                == .init(event: nil, swallow: false))
        #expect(t.handle(.keyUp(code: 0), now: 0.6) == .init(event: nil, swallow: false))
    }

    @Test("⌘F5 stays the system's — VoiceOver is not a dictation")
    func combinationIsNotOurs() {
        var t = HotkeyTracker(spec: .key(HotkeySpec.Code.f5))
        let down = t.handle(.keyDown(code: 96, isRepeat: false, flags: 0x10_0000), now: 0)
        #expect(down == .init(event: nil, swallow: false))
        #expect(t.handle(.keyUp(code: 96), now: 0.2) == .init(event: nil, swallow: false),
                "a key-up we never claimed the down of must pass through")
    }

    @Test("resync reads the key's own state")
    func resyncKey() {
        var t = HotkeyTracker(spec: f13)
        _ = t.handle(.keyDown(code: 105, isRepeat: false, flags: none), now: 0)
        #expect(t.resync(flags: none, keyIsDown: false, now: 5) == .released)
    }
}

@Suite("Recording a new hotkey")
struct HotkeyRecorderTests {

    @Test("a modifier pressed and released alone becomes the hotkey")
    func modifierAlone() {
        var r = HotkeyRecorder()
        #expect(r.modifier(HotkeySpec.Code.rightOption, isDown: true) == .recording)
        #expect(r.modifier(HotkeySpec.Code.rightOption, isDown: false)
                == .recorded(.modifier(HotkeySpec.Code.rightOption)))
    }

    @Test("two modifiers together are a combination and record nothing")
    func twoModifiers() {
        var r = HotkeyRecorder()
        _ = r.modifier(HotkeySpec.Code.rightCommand, isDown: true)
        _ = r.modifier(HotkeySpec.Code.rightShift, isDown: true)
        #expect(r.modifier(HotkeySpec.Code.rightShift, isDown: false) == .recording)
        #expect(r.modifier(HotkeySpec.Code.rightCommand, isDown: false) == .recording)
    }

    @Test("a function key records at once")
    func functionKey() {
        var r = HotkeyRecorder()
        #expect(r.key(HotkeySpec.Code.f18) == .recorded(.key(HotkeySpec.Code.f18)))
    }

    @Test("a letter is refused — it would stop typing everywhere")
    func letterRefused() {
        var r = HotkeyRecorder()
        guard case .rejected = r.key(0) else { Issue.record("A was accepted"); return }
    }

    @Test("a modifier with a key is refused as a combination")
    func combination() {
        var r = HotkeyRecorder()
        _ = r.modifier(HotkeySpec.Code.leftCommand, isDown: true)
        guard case .rejected = r.key(HotkeySpec.Code.f13) else {
            Issue.record("⌘F13 was accepted")
            return
        }
    }

    @Test("Escape abandons recording")
    func escape() {
        var r = HotkeyRecorder()
        #expect(r.key(53) == .cancelled)
    }
}

@Suite("The hotkey setting")
struct HotkeySpecTests {

    @Test("round-trips through JSON in the shape the settings blob stores")
    func codable() throws {
        for spec in HotkeySpec.presets {
            let data = try JSONEncoder().encode(spec)
            #expect(try JSONDecoder().decode(HotkeySpec.self, from: data) == spec)
        }
        let stored = #"{"kind":"modifier","keyCode":54}"#.data(using: .utf8)!
        #expect(try JSONDecoder().decode(HotkeySpec.self, from: stored) == .rightCommand)
    }

    @Test("the default is right ⌘, the key every earlier build used")
    func defaultIsRightCommand() {
        #expect(HotkeySpec.default == .modifier(54))
        #expect(HotkeySpec.default.displayName == "Right ⌘")
    }

    @Test("keys that fight the system say so; right ⌘ does not")
    func warnings() {
        #expect(HotkeySpec.rightCommand.warnings.isEmpty)
        #expect(!HotkeySpec.modifier(HotkeySpec.Code.function).warnings.isEmpty)
        #expect(!HotkeySpec.modifier(HotkeySpec.Code.leftCommand).warnings.isEmpty)
        #expect(HotkeySpec.key(HotkeySpec.Code.f13).warnings.contains { $0.contains("Accessibility") })
        #expect(HotkeySpec.key(HotkeySpec.Code.f5).warnings.contains { $0.contains("F1–F12") })
    }

    @Test("the name inside a sentence, and the caps to draw")
    func inlineAndCaps() {
        #expect(HotkeySpec.rightCommand.inlineName == "right ⌘")
        #expect(HotkeySpec.rightCommand.keycapLabels == ["right", "⌘"])
        #expect(HotkeySpec.key(HotkeySpec.Code.f13).inlineName == "F13")
        #expect(HotkeySpec.key(HotkeySpec.Code.f13).keycapLabels == ["F13"])
        #expect(HotkeySpec.modifier(HotkeySpec.Code.function).keycapLabels == ["fn"])
    }

    @Test("names for every preset")
    func names() {
        #expect(HotkeySpec.key(HotkeySpec.Code.f13).displayName == "F13")
        #expect(HotkeySpec.modifier(HotkeySpec.Code.rightOption).displayName == "Right ⌥")
        for spec in HotkeySpec.presets { #expect(!spec.displayName.hasPrefix("Key ")) }
    }
}
