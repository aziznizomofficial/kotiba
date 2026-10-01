import Foundation
#if os(macOS)
import CoreAudio

// Lower what is playing while the key is held; put it back on release.
//
// Three mechanisms were on the table, and the choice is by elimination:
//
//   * `AVAudioVoiceProcessingOtherAudioDuckingConfiguration` needs voice processing switched on
//     for the input node. That turns the input into VPIO: an aggregate device, a 3–9 channel
//     input format, AGC on by default, and a fixed −15 dB duck even at `.min` that also hits
//     other output devices. It fails outright with -10875 when the input and output are
//     different devices — which is exactly the Bluetooth-output, built-in-mic case below. It
//     would rebuild the capture path this app has spent months making reliable, for a duck
//     whose depth it cannot choose.
//   * Process taps / per-app volume (macOS 14.4+) lower one app by muting it and re-playing
//     its audio through a tap: a new TCC grant (system audio recording), a second audio path,
//     and added latency on someone's music, for a dictation that lasts seconds.
//   * The default output device's own volume. Every shipping analog does a version of this —
//     VoiceInk sets the device mute, Handy runs `set volume output muted`, Wispr Flow mutes and
//     falls back to volume 0 on devices without a mute — and it is the only one that can ramp
//     smoothly to a chosen level and back.
//
// So: the device volume, ramped, and only when some *other* process is actually running output
// (the HAL's per-process list, excluding this one). Nothing playing, nothing touched.
//
// Restore is exact and defers to the user. The level before the duck is remembered per element
// (the master, or each channel on devices that have no master), the level Kotiba last wrote is
// remembered too, and a difference between the two on release means the user moved the volume
// during the hold — their choice then stands and Kotiba does not overwrite it. A marker file says
// "ducked from X" for the length of the duck, so a crash or a force-quit mid-hold is repaired at
// the next launch instead of leaving someone's music at a quarter volume for good.

/// The HAL, reduced to what ducking needs. Real hardware in the app, a fake in the tests.
public protocol OutputVolumeBackend: Sendable {
    func defaultOutput() -> UInt32?
    func uid(_ device: UInt32) -> String?
    func device(forUID uid: String) -> UInt32?
    /// The elements whose volume may be moved — the master, or every channel if there is none.
    func elements(_ device: UInt32) -> [UInt32]
    func volume(_ device: UInt32, element: UInt32) -> Float?
    @discardableResult func setVolume(_ device: UInt32, element: UInt32, _ value: Float) -> Bool
    /// Some process other than this one is running output IO.
    func isPlaying(_ device: UInt32) -> Bool
}

public struct HALVolumeBackend: OutputVolumeBackend {
    public init() {}
    public func defaultOutput() -> UInt32? { AudioDevices.defaultOutput }
    public func uid(_ device: UInt32) -> String? { AudioDevices.uid(device) }
    public func device(forUID uid: String) -> UInt32? { AudioDevices.device(forUID: uid) }
    public func elements(_ device: UInt32) -> [UInt32] { AudioDevices.volumeElements(device) }
    public func volume(_ device: UInt32, element: UInt32) -> Float? {
        AudioDevices.volume(device, element: element)
    }
    public func setVolume(_ device: UInt32, element: UInt32, _ value: Float) -> Bool {
        AudioDevices.setVolume(device, element: element, value)
    }
    public func isPlaying(_ device: UInt32) -> Bool {
        // The per-process list is the precise signal: which processes are running output right
        // now, with this one — the start/stop chime — left out. Paused players that hold their
        // stream open still count, which costs nothing worse than lowering silence.
        if let playing = AudioDevices.processesRunningOutput() {
            let me = ProcessInfo.processInfo.processIdentifier
            return playing.contains { $0 != me }
        }
        return AudioDevices.isRunningSomewhere(device)
    }
}

public final class OutputDucker: @unchecked Sendable {

    /// What is written to disk while ducked. Enough to put the volume back from a fresh process.
    struct Marker: Codable, Equatable {
        var deviceUID: String
        /// Element → level before the duck.
        var prior: [UInt32: Float]
        /// Element → the ducked level. A device still sitting here at launch was left ducked.
        var target: [UInt32: Float]
    }

    private struct Ducked {
        var device: UInt32
        var marker: Marker
        /// Element → the last value Kotiba wrote. Anything else on the device is the user's doing.
        var lastSet: [UInt32: Float]
    }

    public struct Timing: Sendable {
        /// Wait this long after key-down before lowering anything. A right-⌘ that turns into ⌘C
        /// is cancelled inside it, so a keyboard shortcut never dips the music.
        public var startDelay: Duration
        public var ramp: Duration
        public var steps: Int
        public init(startDelay: Duration = .milliseconds(200), ramp: Duration = .milliseconds(160),
                    steps: Int = 12) {
            self.startDelay = startDelay
            self.ramp = ramp
            self.steps = max(1, steps)
        }
    }

    /// Tolerance for "the user moved it". Some drivers quantise the scalar to their own steps and
    /// read back a hair off what was written; a volume key moves it by 1/16.
    static let userChangeTolerance: Float = 0.02

    private let backend: any OutputVolumeBackend
    private let markerURL: URL?
    private let timing: Timing
    private let queue = DispatchQueue(label: "uz.kotiba.ducker", qos: .userInitiated)

    // Confined to `queue`.
    private var ducked: Ducked?
    /// Bumped by every duck and restore; a ramp step from an older one sees the change and stops.
    private var generation = 0

    /// What the last duck or restore decided, in words. For tests and for the probe.
    private var lastDecision = "none"
    public var decision: String { queue.sync { lastDecision } }

    public init(backend: any OutputVolumeBackend = HALVolumeBackend(), markerURL: URL?,
                timing: Timing = Timing()) {
        self.backend = backend
        self.markerURL = markerURL
        self.timing = timing
    }

    /// Where the app keeps its marker.
    public static func defaultMarkerURL(in directory: URL) -> URL {
        directory.appendingPathComponent("ducking.json")
    }

    // MARK: Key down / key up

    /// Lower the output to `level` (0…1 of what it is now), if something is playing.
    public func duck(to level: Double) {
        queue.async { [self] in
            generation += 1
            let generation = self.generation
            queue.asyncAfter(deadline: .now() + timing.startDelay.timeInterval) { [self] in
                guard generation == self.generation else { return }
                beginDuck(level: Float(min(1, max(0, level))), generation: generation)
            }
        }
    }

    /// Put back what `duck` took. Ramped, unless the user has moved the volume in the meantime.
    public func restore() {
        queue.async { [self] in
            generation += 1
            beginRestore(generation: generation)
        }
    }

    /// The terminate path: no ramp, no waiting, done when this returns.
    public func restoreImmediately() {
        queue.sync {
            generation += 1
            guard let ducked else { return }
            if !userMoved(ducked) {
                for (element, value) in ducked.marker.prior {
                    backend.setVolume(ducked.device, element: element, value)
                }
            }
            finish()
        }
    }

    /// A marker left by a process that died while ducked. Restores the device if it is still
    /// sitting at the ducked level, and forgets the marker either way.
    public func recoverFromCrash() {
        queue.sync {
            guard let markerURL, let data = try? Data(contentsOf: markerURL) else { return }
            defer { try? FileManager.default.removeItem(at: markerURL) }
            guard let marker = try? JSONDecoder().decode(Marker.self, from: data),
                  let device = backend.device(forUID: marker.deviceUID) else {
                lastDecision = "stale marker discarded"
                return
            }
            var restored = false
            for (element, target) in marker.target {
                guard let now = backend.volume(device, element: element),
                      abs(now - target) <= Self.userChangeTolerance,
                      let prior = marker.prior[element] else { continue }
                backend.setVolume(device, element: element, prior)
                restored = true
            }
            lastDecision = restored ? "restored after a crash" : "user had changed it since"
        }
    }

    /// Waits for queued work. For tests and the probe.
    public func settle() { queue.sync {} }

    // MARK: Queue-confined

    private func beginDuck(level: Float, generation: Int) {
        if var current = ducked {
            // Pressed again while the last release was still ramping back up: go back down from
            // wherever it got to, towards the same target — the prior level is still the truth.
            if userMoved(current) {
                finish()
            } else {
                current.marker.target = current.marker.prior.mapValues { $0 * level }
                ducked = current
                ramp(to: current.marker.target, generation: generation, then: nil)
                lastDecision = "re-ducked"
                return
            }
        }
        guard let device = backend.defaultOutput() else { lastDecision = "no output"; return }
        guard backend.isPlaying(device) else { lastDecision = "nothing playing"; return }
        let elements = backend.elements(device)
        var prior: [UInt32: Float] = [:]
        for element in elements {
            if let v = backend.volume(device, element: element) { prior[element] = v }
        }
        guard !prior.isEmpty else { lastDecision = "no settable volume"; return }
        guard prior.values.contains(where: { $0 > 0.001 }) else { lastDecision = "already silent"; return }
        let marker = Marker(deviceUID: backend.uid(device) ?? "", prior: prior,
                            target: prior.mapValues { $0 * level })
        ducked = Ducked(device: device, marker: marker, lastSet: prior)
        writeMarker(marker)
        lastDecision = "ducked"
        ramp(to: marker.target, generation: generation, then: nil)
    }

    private func beginRestore(generation: Int) {
        guard let current = ducked else { return }
        if userMoved(current) {
            // The user set a volume while Kotiba held the key. That is the level they want now.
            lastDecision = "left the user's volume alone"
            finish()
            return
        }
        lastDecision = "restoring"
        ramp(to: current.marker.prior, generation: generation) { [self] in
            lastDecision = "restored"
            finish()
        }
    }

    /// Step every element from where it is to `target`, smoothly, on the queue.
    private func ramp(to target: [UInt32: Float], generation: Int, then done: (() -> Void)?) {
        guard let start = ducked else { return }
        let from = start.lastSet
        let steps = timing.steps
        let interval = timing.ramp.timeInterval / Double(steps)
        func step(_ i: Int) {
            guard generation == self.generation, var current = ducked else { return }
            if userMoved(current) {
                lastDecision = "left the user's volume alone"
                finish()
                return
            }
            // Smoothstep rather than linear: no audible corner at either end of the ramp.
            let t = Float(i) / Float(steps)
            let eased = t * t * (3 - 2 * t)
            for (element, goal) in target {
                let origin = from[element] ?? goal
                // The last step writes the goal itself. `origin + (goal - origin) * 1` is not
                // `goal` in Float arithmetic for every origin: a restore that started from a
                // part-way ramp came back to 0.8000001 over a prior of 0.8 (OutputDuckerTests,
                // 1 of 25 full runs on 2026-09-29), so the user's level was not quite given back.
                let value = i == steps ? goal : origin + (goal - origin) * eased
                backend.setVolume(current.device, element: element, value)
                // Read back, not assumed: drivers quantise, and comparing against what the
                // hardware says is what keeps a quantised write from looking like the user.
                current.lastSet[element] = backend.volume(current.device, element: element) ?? value
            }
            ducked = current
            if i < steps {
                queue.asyncAfter(deadline: .now() + interval) { step(i + 1) }
            } else {
                done?()
            }
        }
        step(1)
    }

    private func userMoved(_ state: Ducked) -> Bool {
        state.lastSet.contains { element, written in
            guard let now = backend.volume(state.device, element: element) else { return false }
            return abs(now - written) > Self.userChangeTolerance
        }
    }

    private func finish() {
        ducked = nil
        if let markerURL { try? FileManager.default.removeItem(at: markerURL) }
    }

    private func writeMarker(_ marker: Marker) {
        guard let markerURL, let data = try? JSONEncoder().encode(marker) else { return }
        try? FileManager.default.createDirectory(at: markerURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? data.write(to: markerURL, options: .atomic)
    }
}

extension Duration {
    var timeInterval: TimeInterval {
        let (seconds, attoseconds) = components
        return Double(seconds) + Double(attoseconds) / 1e18
    }
}
#endif

// MARK: - The app's handle

/// The ducker as the controller holds it: one per process, a no-op where there is no HAL to
/// duck with. Keeps `#if os(macOS)` out of the controller.
///
/// `inert` is the default everywhere and the app installs the real one. That is deliberate and
/// was learned the hard way: the first version built the real ducker inside the controller, so
/// every test that constructs a controller and presses without releasing lowered the volume of
/// whatever this Mac was playing through — and left a marker in the real support directory.
public final class PlaybackDucking: Sendable {
    #if os(macOS)
    private let ducker: OutputDucker?
    #endif

    /// Does nothing, ever.
    public static let inert = PlaybackDucking(markerDirectory: nil)

    /// - Parameter markerDirectory: where the "ducked from X" marker lives while ducked; nil
    ///   makes an inert handle.
    public init(markerDirectory: URL?) {
        #if os(macOS)
        ducker = markerDirectory.map {
            OutputDucker(markerURL: OutputDucker.defaultMarkerURL(in: $0))
        }
        #endif
    }

    public func duck(to level: Double) {
        #if os(macOS)
        ducker?.duck(to: level)
        #endif
    }

    public func restore() {
        #if os(macOS)
        ducker?.restore()
        #endif
    }

    public func restoreImmediately() {
        #if os(macOS)
        ducker?.restoreImmediately()
        #endif
    }

    public func recoverFromCrash() {
        #if os(macOS)
        ducker?.recoverFromCrash()
        #endif
    }
}
