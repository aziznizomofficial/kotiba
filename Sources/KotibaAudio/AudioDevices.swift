#if os(macOS)
import CoreAudio
import Foundation
import KotibaCore

// The Core Audio HAL, as the handful of questions Kotiba actually asks it.
//
// Two features need this and nothing else in the app does: choosing which microphone Kotiba
// records from without touching the system default (the Bluetooth trap, below), and lowering the
// output while the key is held (`OutputDucker`). Both are property reads and writes on
// `AudioObjectID`s; wrapping them once keeps the `AudioObjectPropertyAddress` boilerplate out of
// the two places that have real decisions to make.
//
// ⚠️ Talks to real hardware. The pure decisions built on top — which device to pick, what level
// to restore — are tested with plain values; these calls are exercised by `kotiba-probe devices`
// and `kotiba-probe duck`, which is the only honest way to see them work.

public typealias AudioDeviceID = AudioObjectID

public enum AudioDevices {

    // MARK: Which devices

    public static var defaultInput: AudioDeviceID? {
        systemDevice(kAudioHardwarePropertyDefaultInputDevice)
    }

    public static var defaultOutput: AudioDeviceID? {
        systemDevice(kAudioHardwarePropertyDefaultOutputDevice)
    }

    public static var all: [AudioDeviceID] {
        var address = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr,
              size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else {
            return []
        }
        return ids
    }

    /// The Mac's own microphone, if it has one. A Mac mini or a Mac Pro does not, which is why
    /// every caller has to handle nil.
    public static var builtInInput: AudioDeviceID? {
        all.first { transport($0) == kAudioDeviceTransportTypeBuiltIn && inputChannels($0) > 0 }
    }

    // MARK: About one device

    public static func name(_ device: AudioDeviceID) -> String {
        string(device, kAudioObjectPropertyName) ?? "device \(device)"
    }

    public static func uid(_ device: AudioDeviceID) -> String? {
        string(device, kAudioDevicePropertyDeviceUID)
    }

    public static func device(forUID uid: String) -> AudioDeviceID? {
        all.first { self.uid($0) == uid }
    }

    public static func transport(_ device: AudioDeviceID) -> UInt32 {
        var value: UInt32 = 0
        var address = address(kAudioDevicePropertyTransportType)
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr else {
            return 0
        }
        return value
    }

    /// Classic and LE both. A headset's microphone over either one drags its output into the
    /// hands-free profile.
    public static func isBluetooth(_ device: AudioDeviceID) -> Bool {
        let t = transport(device)
        return t == kAudioDeviceTransportTypeBluetooth || t == kAudioDeviceTransportTypeBluetoothLE
    }

    /// The transport code as the vocabulary the diagnostics record and the quiet-microphone hint
    /// use. Pure — a code in, a kind out — so the mapping is tested without a device. An iPhone
    /// used as a microphone reports one of the three Continuity Capture codes on recent macOS;
    /// on anything that does not, `InputTransport.classify` catches it by name.
    public static func inputTransport(code: UInt32, name: String) -> InputTransport {
        let reported: InputTransport
        switch code {
        case kAudioDeviceTransportTypeBuiltIn: reported = .builtIn
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE:
            reported = .bluetooth
        case kAudioDeviceTransportTypeUSB: reported = .usb
        case kAudioDeviceTransportTypeContinuityCaptureWired,
             kAudioDeviceTransportTypeContinuityCaptureWireless,
             kAudioDeviceTransportTypeContinuityCapture:
            reported = .continuity
        case kAudioDeviceTransportTypeVirtual, kAudioDeviceTransportTypeAggregate,
             kAudioDeviceTransportTypeAutoAggregate:
            reported = .virtual
        default: reported = .other
        }
        return InputTransport.classify(reported, name: name)
    }

    public static func inputChannels(_ device: AudioDeviceID) -> Int {
        channelCount(device, scope: kAudioObjectPropertyScopeInput)
    }

    public static func outputChannels(_ device: AudioDeviceID) -> Int {
        channelCount(device, scope: kAudioObjectPropertyScopeOutput)
    }

    /// Whether any process has IO running on the device. The fallback "is something playing"
    /// signal; `OutputActivity` prefers the per-process one.
    public static func isRunningSomewhere(_ device: AudioDeviceID) -> Bool {
        var value: UInt32 = 0
        var address = address(kAudioDevicePropertyDeviceIsRunningSomewhere)
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr else {
            return false
        }
        return value != 0
    }

    // MARK: Volume

    /// Output volume, 0…1, on one element. Element 0 is the master; 1…n are the channels.
    public static func volume(_ device: AudioDeviceID, element: UInt32) -> Float? {
        var address = address(kAudioDevicePropertyVolumeScalar, scope: kAudioObjectPropertyScopeOutput,
                              element: element)
        guard AudioObjectHasProperty(device, &address) else { return nil }
        var value: Float32 = 0
        var size = UInt32(MemoryLayout<Float32>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr else {
            return nil
        }
        return value
    }

    @discardableResult
    public static func setVolume(_ device: AudioDeviceID, element: UInt32, _ value: Float) -> Bool {
        var address = address(kAudioDevicePropertyVolumeScalar, scope: kAudioObjectPropertyScopeOutput,
                              element: element)
        var settable: DarwinBoolean = false
        guard AudioObjectHasProperty(device, &address),
              AudioObjectIsPropertySettable(device, &address, &settable) == noErr,
              settable.boolValue else { return false }
        var v = Float32(min(1, max(0, value)))
        return AudioObjectSetPropertyData(device, &address, 0, nil,
                                          UInt32(MemoryLayout<Float32>.size), &v) == noErr
    }

    /// The elements whose volume Kotiba may move: the master when the device has a settable one,
    /// otherwise every output channel that does. Many USB interfaces and some HDMI sinks have no
    /// master at all, and ducking only element 0 on those does nothing.
    public static func volumeElements(_ device: AudioDeviceID) -> [UInt32] {
        if isVolumeSettable(device, element: kAudioObjectPropertyElementMain) {
            return [kAudioObjectPropertyElementMain]
        }
        let channels = outputChannels(device)
        guard channels > 0 else { return [] }
        return (1...UInt32(channels)).filter { isVolumeSettable(device, element: $0) }
    }

    static func isVolumeSettable(_ device: AudioDeviceID, element: UInt32) -> Bool {
        var address = address(kAudioDevicePropertyVolumeScalar, scope: kAudioObjectPropertyScopeOutput,
                              element: element)
        var settable: DarwinBoolean = false
        return AudioObjectHasProperty(device, &address)
            && AudioObjectIsPropertySettable(device, &address, &settable) == noErr
            && settable.boolValue
    }

    // MARK: Processes playing audio (macOS 14.4+)

    /// PIDs of processes currently running *output* IO, from the HAL's process objects.
    ///
    /// The precise answer to "is anything playing?". `isRunningSomewhere` is true for a device
    /// any process has started, including one that is merely holding it open, and including this
    /// process. Nil when the HAL does not publish the list, so the caller can fall back.
    public static func processesRunningOutput() -> [pid_t]? {
        var address = address(kAudioHardwarePropertyProcessObjectList)
        let system = AudioObjectID(kAudioObjectSystemObject)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else {
            return nil
        }
        guard size > 0 else { return [] }
        var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &objects) == noErr else {
            return nil
        }
        return objects.compactMap { object -> pid_t? in
            var running: UInt32 = 0
            var runningAddress = self.address(kAudioProcessPropertyIsRunningOutput)
            var runningSize = UInt32(MemoryLayout<UInt32>.size)
            guard AudioObjectGetPropertyData(object, &runningAddress, 0, nil, &runningSize,
                                             &running) == noErr, running != 0 else { return nil }
            var pid: pid_t = 0
            var pidAddress = self.address(kAudioProcessPropertyPID)
            var pidSize = UInt32(MemoryLayout<pid_t>.size)
            guard AudioObjectGetPropertyData(object, &pidAddress, 0, nil, &pidSize, &pid) == noErr
            else { return nil }
            return pid
        }
    }

    // MARK: Plumbing

    static func address(_ selector: AudioObjectPropertySelector,
                        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                        element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain)
        -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    }

    private static func systemDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var address = address(selector)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil,
                                         &size, &id) == noErr,
              id != kAudioObjectUnknown else { return nil }
        return id
    }

    private static func string(_ device: AudioDeviceID,
                               _ selector: AudioObjectPropertySelector) -> String? {
        var address = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr,
              let value else { return nil }
        return value.takeRetainedValue() as String
    }

    private static func channelCount(_ device: AudioDeviceID, scope: AudioObjectPropertyScope) -> Int {
        var address = address(kAudioDevicePropertyStreamConfiguration, scope: scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr,
              size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else {
            return 0
        }
        let list = UnsafeMutableAudioBufferListPointer(
            raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }
}

// MARK: - Listening to the HAL

/// A block listener on system-object properties, removed when this is released. The block runs
/// on a private serial queue and must only hand the news on (it does: one `Task`).
public final class HALPropertyListener: @unchecked Sendable {
    private let addresses: [AudioObjectPropertyAddress]
    private let queue = DispatchQueue(label: "kotiba.hal-listener")
    private let block: AudioObjectPropertyListenerBlock

    public init(selectors: [AudioObjectPropertySelector], onChange: @escaping @Sendable () -> Void) {
        addresses = selectors.map { AudioDevices.address($0) }
        block = { _, _ in onChange() }
        let system = AudioObjectID(kAudioObjectSystemObject)
        for var address in addresses {
            AudioObjectAddPropertyListenerBlock(system, &address, queue, block)
        }
    }

    deinit {
        let system = AudioObjectID(kAudioObjectSystemObject)
        for var address in addresses {
            AudioObjectRemovePropertyListenerBlock(system, &address, queue, block)
        }
    }
}

// MARK: - Which microphone

/// The handful of facts about the machine's inputs that the routing rule reads. A protocol so the
/// rule — and the diagnostics record each take carries — can be driven by fake devices in tests;
/// the app and the probe read the HAL (`HALInputDevices`).
public protocol InputDeviceDirectory: Sendable {
    /// The input selected in System Settings › Sound › Input, right now.
    var defaultInput: AudioDeviceID? { get }
    /// The Mac's own microphone, if it has one.
    var builtInInput: AudioDeviceID? { get }
    func name(_ device: AudioDeviceID) -> String
    /// The Core Audio transport code (`kAudioDeviceTransportType…`).
    func transportCode(_ device: AudioDeviceID) -> UInt32
}

extension InputDeviceDirectory {
    public func isBluetooth(_ device: AudioDeviceID) -> Bool {
        let t = transportCode(device)
        return t == kAudioDeviceTransportTypeBluetooth || t == kAudioDeviceTransportTypeBluetoothLE
    }

    /// What the diagnostics record says about `device` as an input.
    public func inputInfo(_ device: AudioDeviceID, sampleRate: Double?,
                          overrodeDefault: Bool?) -> InputDeviceInfo {
        let name = name(device)
        return InputDeviceInfo(name: name,
                               transport: AudioDevices.inputTransport(code: transportCode(device),
                                                                      name: name),
                               sampleRate: sampleRate, overrodeDefault: overrodeDefault)
    }
}

/// The live answers, read from the HAL on every call — never cached, because the whole point is
/// to follow what the user selected *at the moment of the press*.
public struct HALInputDevices: InputDeviceDirectory {
    public init() {}
    public var defaultInput: AudioDeviceID? { AudioDevices.defaultInput }
    public var builtInInput: AudioDeviceID? { AudioDevices.builtInInput }
    public func name(_ device: AudioDeviceID) -> String { AudioDevices.name(device) }
    public func transportCode(_ device: AudioDeviceID) -> UInt32 { AudioDevices.transport(device) }
}

/// Which microphone Kotiba records from. Pure over an `InputDeviceDirectory`, so the rule is
/// tested without hardware.
///
/// **The default is the system's choice, whatever it is** — built-in, wired, USB, a gaming
/// headset, Bluetooth, an iPhone over Continuity. Until 1.0 the Bluetooth exception below was on
/// by default, so anyone who picked their headset in System Settings got the laptop's microphone
/// from across the room instead, with nothing on screen saying so (the owner's report,
/// 2026-10-02). It is now an opt-in.
///
/// The exception, when switched on: macOS moves a Bluetooth headset into the hands-free profile
/// (HFP/SCO — 16 kHz mono, the "phone call" sound) the moment its microphone is in use. Measured
/// on this Mac with WH-1000XM4 and AirPods: output drops from 44.1/48 kHz stereo to 16 or 24 kHz
/// for as long as anything holds that input. With the switch on Kotiba records from the built-in
/// microphone instead and the music keeps its quality.
///
/// The choice is per-app — the input unit's own `CurrentDevice` — and never the system default,
/// which belongs to the user and to Zoom.
public enum InputRoute {
    /// Nil means "follow the system default input".
    public static func preferredDevice(defaultInput: AudioDeviceID?,
                                       defaultIsBluetooth: Bool,
                                       builtIn: AudioDeviceID?,
                                       preferBuiltInWithBluetooth: Bool) -> AudioDeviceID? {
        guard preferBuiltInWithBluetooth, defaultInput != nil, defaultIsBluetooth,
              let builtIn else { return nil }
        return builtIn
    }

    /// The device Kotiba will record from, and whether it is a Bluetooth one. `overrode` is true
    /// when that device is not the system default — Kotiba chose it, because the default is a
    /// Bluetooth headset and the user asked for the built-in microphone in that case.
    public static func resolve(preferBuiltInWithBluetooth: Bool,
                               devices: some InputDeviceDirectory = HALInputDevices())
        -> (device: AudioDeviceID?, isBluetooth: Bool, overrode: Bool) {
        let defaultInput = devices.defaultInput
        let defaultIsBluetooth = defaultInput.map(devices.isBluetooth) ?? false
        let chosen = preferredDevice(defaultInput: defaultInput,
                                     defaultIsBluetooth: defaultIsBluetooth,
                                     builtIn: devices.builtInInput,
                                     preferBuiltInWithBluetooth: preferBuiltInWithBluetooth)
        let effective = chosen ?? defaultInput
        return (effective, effective.map(devices.isBluetooth) ?? false,
                chosen != nil && chosen != defaultInput)
    }

    /// Whether the graph must be rebuilt before the next capture, checked at every arming.
    ///
    /// - `target`: what `resolve` says the press should record from, read just now.
    /// - `bound`: what Kotiba last bound the input unit to.
    /// - `unitReports`: what the input unit itself says it is on, when a graph exists to ask.
    ///   An AUHAL whose device changed under it can silently revert `CurrentDevice` (VoiceInk
    ///   #956 is the same bug in another app), so trusting `bound` alone could keep recording the
    ///   old microphone while every record here claimed the new one.
    /// - `stale`: a default-input or device-list change, or a configuration change, was heard.
    public static func needsRebind(target: AudioDeviceID?, bound: AudioDeviceID?,
                                   unitReports: AudioDeviceID?, stale: Bool) -> Bool {
        if stale || target != bound { return true }
        if let unitReports, let target, unitReports != target { return true }
        return false
    }

    /// Whether an `AVAudioEngineConfigurationChange` from the live engine means the graph is gone.
    ///
    /// The engine posts one shortly after every `start()` on this Mac with nothing having moved
    /// (see `MicrophoneSource.noteConfigurationChange`), so the notification alone is not news.
    /// It is when, checked on arrival:
    /// - `routeChanged`: the press would now record from another device, or the unit drifted off
    ///   the bound one, or the HAL listener already heard the default move (`needsRebind`);
    /// - `!formatUnchanged`: the hardware side of the input node no longer matches the format the
    ///   sink was connected with — `start()` would raise "Input HW format and tap format not
    ///   matching" on it;
    /// - `takeRunning && !engineRunning`: a take is open and the engine stopped itself, which is
    ///   what AVAudioEngine does to a graph whose I/O it has torn down.
    /// Any one rebuilds. None of them: the graph is the one we built, still on the device we
    /// chose, and rebuilding it would only cost the next press ~100 ms.
    public static func configurationChangeIsNews(routeChanged: Bool, formatUnchanged: Bool,
                                                 takeRunning: Bool, engineRunning: Bool) -> Bool {
        routeChanged || !formatUnchanged || (takeRunning && !engineRunning)
    }
}
#endif
