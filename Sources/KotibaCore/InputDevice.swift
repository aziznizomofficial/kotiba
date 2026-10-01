import Foundation

// Which microphone a dictation was recorded from, and what to say when it barely heard anything.
//
// Real use on 2026-10-01: a burst of twelve dictations came back "heard nothing" at peaks of
// 0.005–0.016 (normal speech here peaks 0.14–0.70), while the Mac listed an iPhone Continuity
// microphone as an input. Nothing in `diagnostics.jsonl` said which device had been used, so the
// cause could be suspected and not proven. This file is the record of it, and the gate on the
// hint that tells the person — once, calmly — instead of twelve silent failures.
//
// Pure on purpose: the Mac fills `InputDeviceInfo` from CoreAudio (`MicrophoneSource`), Windows
// from the capture host, and both are tested with invented devices. Nothing here opens audio.

/// What kind of input it is. Raw values are what the JSONL carries, and what the Windows port
/// writes for the same field — keep them in step (`windows/src/core/input-device.ts`).
public enum InputTransport: String, Sendable, Codable, CaseIterable {
    case builtIn, bluetooth, usb
    /// An iPhone or iPad used as a microphone (Continuity), wired or wireless.
    case continuity
    /// A software device — a loopback driver, a meeting app's virtual microphone.
    case virtual
    case other

    /// Name-based refinement of what the hardware reported: Continuity announces itself with its
    /// own transport type on recent macOS, but a phone used through another route (a Windows
    /// "Phone Link" input, an older macOS) only shows in its name.
    public static func classify(_ reported: InputTransport, name: String) -> InputTransport {
        guard reported != .builtIn, reported != .continuity else { return reported }
        let lower = name.lowercased()
        return lower.contains("iphone") || lower.contains("ipad") ? .continuity : reported
    }
}

/// The input device a take was recorded from. All of it optional-by-decoding on the record, so a
/// line written before this existed — and a line from a newer build — both read.
public struct InputDeviceInfo: Sendable, Codable, Equatable {
    /// The name the system shows. May be personal ("Aziz’s iPhone Microphone"), so it is kept
    /// out of the plain-text summary that is pasted into bug reports.
    public var name: String
    public var transport: InputTransport
    /// The hardware's own rate in Hz, before the capture resampled to 16 kHz. Nil when unknown.
    public var sampleRate: Double?
    /// Whether Kotiba chose this device itself instead of following the system default — the
    /// Bluetooth rule, which records from the Mac's own microphone while a headset is the
    /// default. Nil when not applicable or not known.
    public var overrodeDefault: Bool?

    public init(name: String, transport: InputTransport, sampleRate: Double? = nil,
                overrodeDefault: Bool? = nil) {
        self.name = name
        self.transport = transport
        self.sampleRate = sampleRate
        self.overrodeDefault = overrodeDefault
    }

    /// What the plain-text diagnostics summary may say: everything but the name.
    public var redactedDescription: String {
        var parts = [transport.rawValue]
        if let sampleRate { parts.append("\(Int(sampleRate.rounded())) Hz") }
        if overrodeDefault == true { parts.append("overrode system default") }
        return parts.joined(separator: ", ")
    }
}

// MARK: - The quiet-microphone hint

/// When a heard-nothing take says "your microphone is very quiet" instead of "I didn't catch
/// that", and how often it may.
public enum QuietMic {
    /// A take at least this long was a real hold, not a tap.
    public static let minSeconds: Double = 1.5
    /// …whose peak stayed under this. Normal speech here peaks 0.14–0.70 and the silence gate is
    /// 0.012; the twelve failures were 0.005–0.016. Above 0.03 a person was audibly speaking and
    /// "quiet" would be the wrong diagnosis.
    public static let peakBelow: Float = 0.03
    /// Once per device per hour, so a person who keeps trying is not nagged on every attempt.
    public static let cooldown: TimeInterval = 3600

    /// The device to blame, when `record` is a heard-nothing take that fits the pattern.
    /// Nil for anything else — including a quiet take whose device is not known, because the hint
    /// names the device and a hint without one is just a worse "didn't catch that".
    public static func suspect(_ record: DictationRecord) -> InputDeviceInfo? {
        guard record.outcome == "heardNothing",
              record.audioSeconds >= minSeconds,
              record.peakAmplitude < peakBelow,
              let device = record.inputDevice else { return nil }
        return device
    }

    /// How the device is named in the pill: short enough for a 160-pt capsule. Drops the generic
    /// tail ("Microphone", "Mic", "Input"), keeps at most two words, cuts at 14 characters.
    public static func pillName(_ name: String) -> String {
        let generic: Set<String> = ["microphone", "mic", "input", "микрофон"]
        var words = name.split(whereSeparator: \.isWhitespace).map(String.init)
        while words.count > 1, let last = words.last, generic.contains(last.lowercased()) {
            words.removeLast()
        }
        let short = words.prefix(2).joined(separator: " ")
        return short.count <= 14 ? short : String(short.prefix(13)) + "…"
    }

    /// Which sentence explains the device: the Continuity one, the "not the Mac's own" one, or
    /// the built-in one (where the fix is the input level).
    public enum Kind: Sendable, Equatable { case continuity, external, builtIn }

    public static func kind(of device: InputDeviceInfo) -> Kind {
        switch InputTransport.classify(device.transport, name: device.name) {
        case .continuity: return .continuity
        case .builtIn: return .builtIn
        default: return .external
        }
    }
}

/// Remembers when each device was last complained about. A value type the controller owns; tests
/// drive it with a clock of their own.
public struct QuietMicLimiter: Sendable, Equatable {
    private var lastShown: [String: Date] = [:]

    public init() {}

    /// True — and the device is marked — when `device` has not been reported within the cooldown.
    public mutating func admit(_ device: InputDeviceInfo, now: Date = Date()) -> Bool {
        let key = device.name
        if let last = lastShown[key], now.timeIntervalSince(last) < QuietMic.cooldown { return false }
        lastShown[key] = now
        return true
    }
}
