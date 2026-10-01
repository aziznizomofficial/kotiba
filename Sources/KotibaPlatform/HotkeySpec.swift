import Foundation

// Which key is the push-to-talk key, and the decisions about it that need no event tap.
//
// Everything here is pure so it can be tested without Input Monitoring: the spec itself, the
// state machine that turns raw key events into press / release / cancel, the recorder that turns
// a key the user pressed into a spec, and the warnings about a spec that will fight the system.
// `PushToTalkMonitor` (Hotkey.swift) is only the tap that feeds `HotkeyTracker`.

/// A push-to-talk key. Two shapes:
///
///   * `.modifier` — one modifier held on its own: right ⌘ (the default), right ⌥, right ⌃,
///     right ⇧, their left twins, or fn/Globe. Watched with a listen-only tap, so the modifier
///     still works normally in every other app.
///   * `.key` — any ordinary key held down, e.g. F13–F19 or F5. Watched with an *active* tap that
///     swallows the key's down, up and autorepeat, so holding it never types anything.
///
/// Codable as `{"kind":"modifier","keyCode":54}`. Key codes are the macOS virtual key codes
/// (`kVK_*`), which is what both the tap and `NSEvent.keyCode` report.
public struct HotkeySpec: Codable, Hashable, Sendable {

    public enum Kind: String, Codable, Sendable {
        case modifier
        case key
    }

    public var kind: Kind
    public var keyCode: UInt16

    public init(kind: Kind, keyCode: UInt16) {
        self.kind = kind
        self.keyCode = keyCode
    }

    public static func modifier(_ code: UInt16) -> HotkeySpec { HotkeySpec(kind: .modifier, keyCode: code) }
    public static func key(_ code: UInt16) -> HotkeySpec { HotkeySpec(kind: .key, keyCode: code) }

    // The virtual key codes of the modifiers. Apple exports these as `kVK_*` in Carbon, which
    // this module does not otherwise need; the values are fixed hardware facts.
    public enum Code {
        public static let rightCommand: UInt16 = 54
        public static let leftCommand: UInt16 = 55
        public static let leftShift: UInt16 = 56
        public static let leftOption: UInt16 = 58
        public static let leftControl: UInt16 = 59
        public static let rightShift: UInt16 = 60
        public static let rightOption: UInt16 = 61
        public static let rightControl: UInt16 = 62
        public static let function: UInt16 = 63
        public static let f13: UInt16 = 105, f14: UInt16 = 107, f15: UInt16 = 113, f16: UInt16 = 106
        public static let f17: UInt16 = 64, f18: UInt16 = 79, f19: UInt16 = 80, f20: UInt16 = 90
        public static let f5: UInt16 = 96
    }

    public static let rightCommand = modifier(Code.rightCommand)
    /// What a missing or unreadable setting means. Right ⌘ has been the key since v1, and the
    /// owner's hands know it; a migration that changed it would be a regression, not a default.
    public static let `default` = rightCommand

    /// Offered in the pane, best first.
    public static let presets: [HotkeySpec] = [
        rightCommand, modifier(Code.rightOption), modifier(Code.rightControl),
        modifier(Code.rightShift), modifier(Code.function),
        key(Code.f13), key(Code.f14), key(Code.f15), key(Code.f16),
        key(Code.f17), key(Code.f18), key(Code.f19),
    ]

    // MARK: Modifier flags

    /// Device-dependent flag bits (`NX_DEVICE*KEYMASK`), which is what tells left from right.
    /// Apple does not export them to Swift. fn has no left/right, so it uses the
    /// device-independent `NX_SECONDARYFNMASK`.
    static let deviceMasks: [UInt16: UInt64] = [
        Code.leftControl: 0x0001, Code.leftShift: 0x0002, Code.rightShift: 0x0004,
        Code.leftCommand: 0x0008, Code.rightCommand: 0x0010,
        Code.leftOption: 0x0020, Code.rightOption: 0x0040, Code.rightControl: 0x2000,
        Code.function: 0x80_0000,
    ]

    /// The device-independent bit each modifier also sets. Requiring both guards against a stale
    /// device bit some keyboards leave behind.
    static let familyMasks: [UInt16: UInt64] = [
        Code.leftControl: 0x4_0000, Code.rightControl: 0x4_0000,
        Code.leftShift: 0x2_0000, Code.rightShift: 0x2_0000,
        Code.leftCommand: 0x10_0000, Code.rightCommand: 0x10_0000,
        Code.leftOption: 0x8_0000, Code.rightOption: 0x8_0000,
        Code.function: 0x80_0000,
    ]

    /// ⌘, ⌥ and ⌃ held: an ordinary key pressed under these is a shortcut, not the hotkey.
    static let shortcutMask: UInt64 = 0x10_0000 | 0x8_0000 | 0x4_0000

    public static func isModifierCode(_ code: UInt16) -> Bool { deviceMasks[code] != nil }

    /// Whether `flags` (a `CGEventFlags` raw value) show this modifier down.
    public func isHeld(inFlags flags: UInt64) -> Bool {
        guard kind == .modifier, let device = Self.deviceMasks[keyCode],
              let family = Self.familyMasks[keyCode] else { return false }
        return flags & device != 0 && flags & family != 0
    }

    /// Every left/right bit above, and nothing else.
    static let sideMask: UInt64 = 0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0020 | 0x0040
        | 0x2000

    /// This modifier's family is down and the flags carry no left/right bit at all — a reading
    /// that cannot say which side is held, and so cannot say that this side is up.
    func sideUnknown(inFlags flags: UInt64) -> Bool {
        guard kind == .modifier, keyCode != Code.function,
              let family = Self.familyMasks[keyCode] else { return false }
        return flags & family != 0 && flags & Self.sideMask == 0
    }

    // MARK: Names

    public var displayName: String { Self.name(of: keyCode) }

    /// The name inside a sentence: "Hold right ⌘ to dictate", "Hold F13 to dictate".
    public var inlineName: String {
        let name = displayName
        guard name.hasPrefix("Right ") || name.hasPrefix("Left ") else { return name }
        return name.prefix(1).lowercased() + name.dropFirst()
    }

    /// One label per key cap to draw: "right" "⌘", or a single "F13".
    public var keycapLabels: [String] {
        let name = displayName
        if let space = name.firstIndex(of: " "), name.hasPrefix("Right ") || name.hasPrefix("Left ") {
            return [name[..<space].lowercased(), String(name[name.index(after: space)...])]
        }
        return keyCode == Code.function ? ["fn"] : [name]
    }

    public static func name(of code: UInt16) -> String {
        switch code {
        case Code.rightCommand: return "Right ⌘"
        case Code.leftCommand: return "Left ⌘"
        case Code.rightOption: return "Right ⌥"
        case Code.leftOption: return "Left ⌥"
        case Code.rightControl: return "Right ⌃"
        case Code.leftControl: return "Left ⌃"
        case Code.rightShift: return "Right ⇧"
        case Code.leftShift: return "Left ⇧"
        case Code.function: return "fn / 🌐"
        default:
            if let f = functionKeys[code] { return "F\(f)" }
            return namedKeys[code] ?? "Key \(code)"
        }
    }

    static let functionKeys: [UInt16: Int] = [
        122: 1, 120: 2, 99: 3, 118: 4, 96: 5, 97: 6, 98: 7, 100: 8, 101: 9, 109: 10, 103: 11,
        111: 12, 105: 13, 107: 14, 113: 15, 106: 16, 64: 17, 79: 18, 80: 19, 90: 20,
    ]

    static let namedKeys: [UInt16: String] = [
        49: "Space", 36: "Return", 48: "Tab", 51: "Delete", 53: "Escape", 117: "Forward Delete",
        115: "Home", 119: "End", 116: "Page Up", 121: "Page Down", 114: "Help",
        123: "←", 124: "→", 125: "↓", 126: "↑", 71: "Clear", 76: "Enter",
        10: "§", 50: "`",
    ]

    /// Keys that type text or edit it. Holding one as a hotkey would stop that character working
    /// everywhere for as long as Kotiba runs, so the recorder refuses them outright.
    public static func isTypingKey(_ code: UInt16) -> Bool {
        if functionKeys[code] != nil { return false }
        if [115, 119, 116, 121, 114, 71].contains(code) { return false }   // navigation, Help
        return true
    }
}

// MARK: - The state machine

/// What the tap reports, abstracted from `CGEvent` so the decisions can be tested.
public enum HotkeyInput: Sendable, Equatable {
    /// A `flagsChanged` event: the full modifier flags after the change.
    case flags(UInt64)
    case keyDown(code: UInt16, isRepeat: Bool, flags: UInt64)
    case keyUp(code: UInt16)
}

public enum HotkeyEvent: Sendable, Equatable {
    case pressed
    case released
    /// The hold turned out to be the start of a keyboard shortcut. The dictation it started must
    /// be discarded — nothing inserted, nothing ducked, the HUD gone.
    case cancelled
}

/// Turns key events into press / release / cancel for one `HotkeySpec`, and says which events to
/// swallow. Not thread-safe; the monitor owns one and feeds it from the tap thread.
public struct HotkeyTracker: Sendable {

    public let spec: HotkeySpec
    public private(set) var isHeld = false
    /// A chord was seen during this hold, so its release is not a dictation.
    private var chorded = false
    private var heldSince: TimeInterval = 0

    /// How long after a modifier goes down a key press still reads as a shortcut.
    ///
    /// Shortcuts are fast: ⌘C is the modifier and the letter inside a few hundred milliseconds. A
    /// key pressed a minute into a dictation is not the user changing their mind about the whole
    /// minute — cancelling there would throw away everything they said because they bumped a key.
    /// Past the window the key goes through to the app as usual and the dictation carries on.
    public static let chordWindow: TimeInterval = 1.5

    public init(spec: HotkeySpec) {
        self.spec = spec
    }

    public struct Outcome: Equatable, Sendable {
        public var event: HotkeyEvent?
        /// Drop the event instead of passing it on. Only ever true for a `.key` spec.
        public var swallow: Bool
    }

    public mutating func handle(_ input: HotkeyInput, now: TimeInterval) -> Outcome {
        switch spec.kind {
        case .modifier: return handleModifier(input, now: now)
        case .key: return handleKey(input)
        }
    }

    private mutating func handleModifier(_ input: HotkeyInput, now: TimeInterval) -> Outcome {
        switch input {
        case .flags(let flags):
            let held = spec.isHeld(inFlags: flags)
            if held && !isHeld {
                isHeld = true
                chorded = false
                heldSince = now
                return Outcome(event: .pressed, swallow: false)
            }
            if !held && isHeld {
                isHeld = false
                let wasChord = chorded
                chorded = false
                return Outcome(event: wasChord ? nil : .released, swallow: false)
            }
            return Outcome(event: nil, swallow: false)
        case .keyDown(_, let isRepeat, _):
            // Right ⌘ then C is ⌘C. Say so once, and let the key through: it is the user's
            // shortcut, and a listen-only tap could not stop it anyway.
            guard isHeld, !chorded, !isRepeat, now - heldSince <= Self.chordWindow else {
                return Outcome(event: nil, swallow: false)
            }
            chorded = true
            return Outcome(event: .cancelled, swallow: false)
        case .keyUp:
            return Outcome(event: nil, swallow: false)
        }
    }

    private mutating func handleKey(_ input: HotkeyInput) -> Outcome {
        switch input {
        case .keyDown(let code, let isRepeat, let flags) where code == spec.keyCode:
            if isHeld || isRepeat {
                // Autorepeat, every 30-ish ms for as long as the key is down. Swallowed, or a held
                // F-key would fire its system action forty times a second.
                return Outcome(event: nil, swallow: isHeld)
            }
            // ⌘F5 is VoiceOver; ⌃F2 focuses the menu bar. A combination is the system's, not ours.
            guard flags & HotkeySpec.shortcutMask == 0 else { return Outcome(event: nil, swallow: false) }
            isHeld = true
            return Outcome(event: .pressed, swallow: true)
        case .keyUp(let code) where code == spec.keyCode:
            guard isHeld else { return Outcome(event: nil, swallow: false) }
            isHeld = false
            return Outcome(event: .released, swallow: true)
        default:
            return Outcome(event: nil, swallow: false)
        }
    }

    /// Reconcile with what the hardware reports now, after events may have been lost — a tap
    /// disabled by timeout, or one started while the key was already down.
    ///
    /// `isHeld` is derived purely from edges, so any lost event desynchronises it permanently and
    /// nothing downstream can recover: `SessionState` has no ceiling on `.capturing`, so a lost
    /// key-up leaves the microphone open and the next press swallowed. This resamples instead.
    public mutating func resync(flags: UInt64, keyIsDown: Bool, now: TimeInterval) -> HotkeyEvent? {
        let down = spec.kind == .modifier ? spec.isHeld(inFlags: flags) : keyIsDown
        guard down != isHeld else { return nil }
        // Resync now runs four times a second through every hold (`PushToTalkMonitor.watchHold`),
        // so it must never end one on a reading it cannot interpret. The tap's own events always
        // carry the left/right bits; if the polled state ever arrives without them, "⌘ is down,
        // side unknown" is not a key-up — cutting there would end every dictation at 250 ms. The
        // real key-up still clears the family bit, and that is released as usual.
        if !down, spec.sideUnknown(inFlags: flags) { return nil }
        isHeld = down
        if down {
            chorded = false
            heldSince = now
            return .pressed
        }
        let wasChord = chorded
        chorded = false
        return wasChord ? nil : .released
    }

    /// Start watching with the key possibly already down, which is not a press this tracker saw
    /// begin — so it starts nothing, and its release ends nothing.
    ///
    /// The commonest way to be here is recording a new hotkey: an ordinary key (F13) is recorded
    /// on its key-down, the new monitor starts a moment later with the key still under the
    /// finger, and reporting it as `.pressed` — which the start used to do — began a dictation
    /// the user never asked for and ended it on the key-up: sounds, a "Listening" HUD and a "did
    /// not hear anything". A modifier is adopted as a chord, so its release is swallowed and the
    /// next press is a press; an ordinary key is simply left unheld, and its key-up goes through
    /// like its key-down did before the tap existed.
    public mutating func adopt(flags: UInt64, now: TimeInterval) {
        guard spec.kind == .modifier else { return }
        let down = spec.isHeld(inFlags: flags)
        isHeld = down
        chorded = down
        heldSince = now
    }

    /// Forget the current hold without reporting it — the monitor is being suspended or re-keyed.
    public mutating func reset() {
        isHeld = false
        chorded = false
    }
}

// MARK: - Recording a new key

/// Turns what the user presses in the "Record new" field into a spec.
///
/// A modifier becomes the spec when it goes down and comes back up with nothing else pressed in
/// between — the gesture the user will actually make. An ordinary key becomes the spec the moment
/// it goes down. Escape abandons recording.
public struct HotkeyRecorder: Sendable {

    public enum Result: Equatable, Sendable {
        case recording
        case recorded(HotkeySpec)
        case cancelled
        case rejected(Rejection)
    }

    /// Why a key cannot be the hotkey. A value rather than a sentence, so the window can say it
    /// in the interface language; `text` is the English.
    public enum Rejection: Equatable, Sendable {
        /// More than one key held at once.
        case combination
        /// A key that types a character, by key code.
        case typingKey(UInt16)

        public var text: String {
            switch self {
            case .combination:
                return "Combinations are not supported — hold a single key or a single modifier."
            case .typingKey(let code):
                return "\(HotkeySpec.name(of: code)) types text — holding it for Kotiba would "
                    + "stop it working everywhere. Pick a function key or a modifier."
            }
        }
    }

    private var candidate: UInt16?
    /// Modifiers currently down, by key code.
    private var down: Set<UInt16> = []

    public init() {}

    /// A `flagsChanged` for `code`, with the modifier now down or up.
    public mutating func modifier(_ code: UInt16, isDown: Bool) -> Result {
        guard HotkeySpec.isModifierCode(code) else { return .recording }
        if isDown {
            candidate = down.isEmpty ? code : nil     // a second modifier makes it a combination
            down.insert(code)
            return .recording
        }
        down.remove(code)
        if let c = candidate, c == code, down.isEmpty {
            candidate = nil
            return .recorded(.modifier(code))
        }
        return .recording
    }

    public mutating func key(_ code: UInt16) -> Result {
        if code == 53 { return .cancelled }                            // Escape
        candidate = nil
        guard down.isEmpty else {
            return .rejected(.combination)
        }
        guard !HotkeySpec.isTypingKey(code) else { return .rejected(.typingKey(code)) }
        return .recorded(.key(code))
    }
}

// MARK: - Conflicts

extension HotkeySpec {

    /// What this key will fight with, as values the window words in the interface language.
    /// Empty is the normal case.
    public enum Advice: Hashable, Sendable {
        /// A left-hand modifier, which most shortcuts use. Carries the symbol ("⌘").
        case leftHandShortcuts(String)
        case globeKey
        case rightOptionAccents
        case shiftCapitals
        case needsAccessibility
        case mediaKeys

        public var text: String {
            switch self {
            case .leftHandShortcuts(let symbol):
                return "Most shortcuts use the left \(symbol). Every shortcut starts a dictation "
                    + "that is cancelled a moment later — the right-hand key avoids that."
            case .globeKey:
                return "macOS also uses 🌐. Set System Settings › Keyboard › “Press 🌐 key to” "
                    + "to “Do Nothing”, or the emoji picker or Apple Dictation will open too."
            case .rightOptionAccents:
                return "On some keyboard layouts right ⌥ types accented letters; those stop "
                    + "working while it is the dictation key."
            case .shiftCapitals:
                return "⇧ is held while typing capitals. A capital letter typed within 1.5 s of "
                    + "pressing ⇧ cancels the dictation it started."
            case .needsAccessibility:
                return "Needs Accessibility as well as Input Monitoring: Kotiba has to swallow the "
                    + "key so holding it types nothing."
            case .mediaKeys:
                return "F1–F12 are media keys on Mac keyboards unless “Use F1, F2, etc. keys "
                    + "as standard function keys” is on; held with fn they always work."
            }
        }
    }

    public var advice: [Advice] {
        var out: [Advice] = []
        switch (kind, keyCode) {
        case (.modifier, Code.leftCommand), (.modifier, Code.leftOption),
             (.modifier, Code.leftControl), (.modifier, Code.leftShift):
            out.append(.leftHandShortcuts(String(displayName.dropFirst(5))))
        case (.modifier, Code.function):
            out.append(.globeKey)
        case (.modifier, Code.rightOption):
            out.append(.rightOptionAccents)
        case (.modifier, Code.leftShift), (.modifier, Code.rightShift):
            out.append(.shiftCapitals)
        default: break
        }
        if kind == .key {
            out.append(.needsAccessibility)
            if let f = Self.functionKeys[keyCode], f <= 12 { out.append(.mediaKeys) }
        }
        return out
    }

    /// The advice in English.
    public var warnings: [String] { advice.map(\.text) }
}
