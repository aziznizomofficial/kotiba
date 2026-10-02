import AVFoundation
import Foundation
import KotibaCore
import KotibaObjC
import Synchronization
#if os(macOS)
import CoreAudio
#endif

// Tasks A-01 and A-06. The real capture path.
//
// ⚠️ HONESTY NOTE. The pure parts below — downmixing, the ring buffer, resampling, the
// warm-up state machine — are covered by tests. The AVAudioEngine glue is NOT: proving tap
// latency or device switching needs a real microphone and a TCC grant, which no test may take.
// Treat every latency claim in this file as unverified until it has been run on the Mac.
//
// Two decisions are load-bearing and both come from measurement:
//
// 1. `AVAudioSinkNode`, never `installTap`. `installTap` has a documented, enforced
//    [100, 400] ms buffer range — the floor is expressed in *time*, not frames, so asking for
//    64 frames yields 4800 (100 ms) anyway. That is a 100 ms tax on every dictation, and
//    WhisperKit's audio front-end pays it, which is why this does not copy it.
//
// 2. Resampling never happens in the callback. The render callback runs on a real-time thread
//    that must never allocate or wait; downmixing to mono there is a few additions per frame,
//    but resampling is not. So the ring holds mono at the hardware's own rate and a consumer on
//    an ordinary queue converts it to 16 kHz as it arrives — see `CapturePipeline`, which is
//    also what removed the 174.76 s ceiling the old whole-recording ring imposed.

/// Averaging N interleaved-by-buffer channels into mono. Extracted so it can be tested without
/// an audio device — this is the only arithmetic the real-time thread does.
enum Downmix {
    /// Average `channels` non-interleaved channel pointers into `out`. No allocation.
    static func toMono(
        channels: UnsafeBufferPointer<UnsafeMutablePointer<Float>>,
        frames: Int,
        into out: UnsafeMutablePointer<Float>
    ) {
        guard let first = channels.first else { return }
        if channels.count == 1 {
            out.update(from: first, count: frames)
            return
        }
        let scale = 1 / Float(channels.count)
        for f in 0..<frames {
            var sum: Float = 0
            for c in 0..<channels.count { sum += channels[c][f] }
            out[f] = sum * scale
        }
    }

    /// Same arithmetic, array-shaped, for tests.
    static func toMono(_ channels: [[Float]]) -> [Float] {
        guard let first = channels.first else { return [] }
        guard channels.count > 1 else { return first }
        let frames = channels.map(\.count).min() ?? 0
        let scale = 1 / Float(channels.count)
        return (0..<frames).map { f in
            channels.reduce(Float(0)) { $0 + $1[f] } * scale
        }
    }
}

public enum MicrophoneError: Error, Sendable {
    case engineFailedToStart(String)
    case noInputAvailable
    case conversionFailed(String)
    case permissionDenied

    public var reason: String {
        switch self {
        case .engineFailedToStart(let e): return "the audio engine would not start: \(e)"
        case .noInputAvailable: return "no input device is available"
        case .conversionFailed(let e): return "resampling to 16 kHz failed: \(e)"
        case .permissionDenied:
            return "microphone access has not been granted — System Settings › Privacy & "
                + "Security › Microphone"
        }
    }
}

public actor MicrophoneSource: AudioSource {

    /// AVFoundation re-exports CoreAudioTypes' own `AudioBuffer`, so ours needs qualifying
    /// throughout this file. Aliasing once beats sprinkling `KotibaCore.` everywhere.
    typealias Buffer = KotibaCore.AudioBuffer

    /// Replaceable, for one reason: an engine whose input node is a Bluetooth headset's
    /// microphone holds that headset in the hands-free profile for as long as the engine exists,
    /// warm or not. The only way to let go of an input node is to let go of the engine.
    ///
    /// Held in a slot rather than a stored `var` so that a source that goes away retires its
    /// engine too: a nonisolated `deinit` cannot touch a non-`Sendable` stored property, and
    /// `isolated deinit` cycles the whole-module optimiser (see `HistoryStore.Handle`).
    private var engine: AVAudioEngine { slot.engine }
    private let slot: EngineSlot

    /// Owns the live engine. Touched only from the actor, and from `deinit`, when nothing else
    /// can reach it — hence `@unchecked`.
    private final class EngineSlot: @unchecked Sendable {
        var engine = AVAudioEngine()
        let retirement: EngineRetirement
        init(retirement: EngineRetirement) { self.retirement = retirement }
        /// A source that is released hands its engine to the retirement, running or not, rather
        /// than freeing it wherever the last reference happens to drop. Tests release dozens of
        /// sources a run, several mid-dictation; the app releases one at quit.
        deinit { retirement.retire(engine) }
    }
    /// The render thread's hand-off queue and the consumer that turns it into takes.
    private let pipeline: CapturePipeline
    /// Preallocated so the render callback never allocates. Sized well above any plausible
    /// render quantum; a larger block is truncated rather than dropped.
    private let scratch: RealtimeScratch
    /// Preallocated channel-pointer table, so the render callback allocates nothing.
    private let channels = ChannelTable()
    private var sink: AVAudioSinkNode?
    private var hardwareFormat: AVAudioFormat?
    /// The engine is running on behalf of at least one take.
    private var isCapturing = false
    /// The take the hardware is currently feeding. At most one; an older one may still be
    /// waiting in the pipeline to be collected.
    private var currentTake: UInt64?
    /// When `currentTake` began receiving audio. See `stopTake`.
    private var currentTakeStarted: ContinuousClock.Instant?
    /// Starts are serialised: a start suspends inside warm-up, and a second press landing in
    /// that window must not build a second graph over the first.
    private var startChain: Task<Void, Never>?
    /// Keeps App Nap from stretching the 20 ms consumer timer while a take is open.
    private var activity: (any NSObjectProtocol)?

    /// Take ids come from here so a take can be made synchronously, from any isolation.
    private nonisolated let takeCounter = Atomic<UInt64>(0)
    /// `preferBuiltInMicWithBluetooth`, readable without hopping onto the actor. Off until the
    /// controller says otherwise: the default is whatever input the user selected in the system.
    private nonisolated let prefersBuiltInMic = Atomic<Bool>(false)

    #if os(macOS)
    /// The device the input unit is bound to, when Kotiba chose one. Compared on every start so
    /// a headset connecting between dictations is noticed without a notification.
    private var boundDevice: AudioDeviceID?
    private var boundIsBluetooth = false
    /// What the graph's input is, for the diagnostics record — refreshed whenever the graph is
    /// prepared, which is whenever the route could have changed (`performStart` re-checks it on
    /// every start from idle). Nil off macOS, and when there is no input device at all.
    private var currentInput: InputDeviceInfo?
    /// Where the routing rule reads the machine's inputs. The HAL in the app and the probe.
    private let devices: any InputDeviceDirectory
    /// The system default input, or the set of devices, changed since the graph was bound. Set by
    /// the HAL listener, cleared when the graph is rebound. Needed on top of comparing device IDs
    /// at the press because an unplugged-and-replugged device can come back under the same ID
    /// with a different format, and the engine only posts a configuration change while running.
    private var inputsMoved = false
    /// Counted so the listener is observable rather than asserted.
    public private(set) var inputChangeCount = 0
    /// Removes itself from the HAL when the source goes away.
    private var inputListener: HALPropertyListener?
    #endif
    /// The device each open take started on, so a take that outlives a device change still
    /// reports the device it actually heard. Emptied by `stopTake`.
    private var takeInputs: [UInt64: InputDeviceInfo] = [:]

    /// Live loudness for the HUD. Written by the render thread, read by the UI, never drained.
    public let meter = LevelMeter()

    /// Counted so A-06's requirement — warm up on *every* foreground, not once — is observable
    /// rather than asserted.
    public private(set) var warmUpCount = 0
    public private(set) var lastWarmUpError: String?
    /// The same failure with its type intact, so `start()` can rethrow a permission denial as a
    /// permission denial instead of flattening every cause into `engineFailedToStart`.
    private var lastWarmUpFailure: MicrophoneError?

    /// Set when the engine has been prepared successfully at least once since the last failure.
    private var graphWarm = false
    /// Warm-up deliberately left the engine cold because the input is a Bluetooth headset's
    /// microphone. Not a fault, and not to be reported as "the microphone is not ready".
    private var coldForBluetooth = false

    /// Whether the microphone is ready for a press: a prepared graph, or one deliberately left
    /// unbuilt so a headset is not held in HFP (the press builds it, at cold-start cost).
    public var isWarm: Bool { graphWarm || coldForBluetooth }

    /// Cold for a reason only the user can clear. A changed device or an empty take leaves
    /// `lastWarmUpFailure` alone (they are noted, not thrown), so they read as `false` here —
    /// which is right: the next warm-up or press rebuilds the graph by itself.
    public var warmUpNeedsTheUser: Bool {
        guard !isWarm else { return false }
        switch lastWarmUpFailure {
        case .permissionDenied, .noInputAvailable: return true
        default: return false
        }
    }

    /// The audio device changed under us, so the sink's connection no longer exists.
    ///
    /// Separate from `isWarm` because they answer different questions: `isWarm` is "may I start?",
    /// this is "does the graph need rebuilding first?". Both go true at once here, but a warm-up
    /// that fails for some other reason must not silently mark the graph clean.
    private var graphIsStale = false

    /// Counted so the reattachment is observable rather than asserted.
    public private(set) var configurationChangeCount = 0
    /// The ones that, checked, changed nothing — see `noteConfigurationChange`. Counted so the
    /// probe shows the filter working rather than a press time merely getting shorter.
    public private(set) var ignoredConfigurationChangeCount = 0

    private var configurationWatcher: (any NSObjectProtocol)?
    /// Which engine is the live one, readable from the notification's posting thread. A replaced
    /// engine posts a configuration change as it is torn down; that one is not news.
    private nonisolated let liveEngine = EngineIdentity()

    private final class EngineIdentity: Sendable {
        private let value = Mutex<ObjectIdentifier?>(nil)
        func set(_ id: ObjectIdentifier) { value.withLock { $0 = id } }
        func `is`(_ id: ObjectIdentifier) -> Bool { value.withLock { $0 == id } }
    }

    /// - Parameter ceilingSeconds: the longest a single take may run. Not a buffer size — capture
    ///   grows for as long as the key is held — but a deliberate limit, reported through the
    ///   take's `onLimit` rather than by dropping audio.
    public init(ceilingSeconds: Double = 30 * 60) {
        self.init(ceilingSeconds: ceilingSeconds, retirement: .shared)
    }

    /// The same, with a retirement of the caller's own for replaced engines to wait in — so a
    /// test can watch a source hand its engine over without sharing the process-wide one.
    init(ceilingSeconds: Double = 30 * 60, retirement: EngineRetirement) {
        slot = EngineSlot(retirement: retirement)
        #if os(macOS)
        devices = HALInputDevices()
        #endif
        // Deep enough for the fastest hardware rate this will plausibly meet, for as long as the
        // consumer could plausibly stall; 20 s at 48 kHz is 4 MB. The old ring was 32 MB and was
        // the whole recording.
        pipeline = CapturePipeline(ringSeconds: 20, maxHardwareRate: 48_000,
                                   ceilingSeconds: ceilingSeconds)
        scratch = RealtimeScratch(capacity: 16_384)
    }

    // MARK: Input device

    /// Record from the Mac's own microphone instead of a Bluetooth headset's. Opt-in; see
    /// `InputRoute`. Takes effect at the next warm-up or the next press; never mid-capture.
    public nonisolated func setPrefersBuiltInMicWithBluetooth(_ value: Bool) {
        prefersBuiltInMic.store(value, ordering: .relaxed)
    }

    #if os(macOS)
    /// Whether the input the next capture would use differs from the one the graph is built on.
    /// Cheap — a few HAL property reads and one AudioUnit property read, well under a
    /// millisecond — so it runs at every arming, the overlapping press included: the device a
    /// take records from is the one selected *at the moment of the press*.
    private func routeChanged()
        -> (changed: Bool, device: AudioDeviceID?, bluetooth: Bool, overrode: Bool) {
        let route = InputRoute.resolve(
            preferBuiltInWithBluetooth: prefersBuiltInMic.load(ordering: .relaxed),
            devices: devices)
        let changed = InputRoute.needsRebind(target: route.device, bound: boundDevice,
                                             unitReports: unitDevice(), stale: inputsMoved)
        return (changed, route.device, route.isBluetooth, route.overrode)
    }

    /// The device the input unit itself says it is on. Only asked of a built graph: reaching for
    /// `inputNode` on a released engine would create one — on a Bluetooth default, that alone is
    /// what holds a headset in HFP.
    private func unitDevice() -> AudioDeviceID? {
        guard sink != nil, let unit = engine.inputNode.audioUnit else { return nil }
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                   kAudioUnitScope_Global, 0, &id, &size) == noErr,
              id != kAudioObjectUnknown else { return nil }
        return id
    }

    /// Listen for the user picking another input, and for devices coming and going.
    ///
    /// The format comparison in `prepareGraph` cannot see a switch between two microphones that
    /// happen to share a format (built-in 48 kHz mono → a USB headset at 48 kHz mono), and
    /// `AVAudioEngineConfigurationChange` is only posted for a *running* engine — between
    /// dictations it is stopped. So the HAL itself is asked to say when the default input or the
    /// device list moves. The press re-checks the route anyway (`routeChanged`); this is what
    /// lets the rebuild happen while idle, off the press's critical path, and what lets go of a
    /// warm graph the moment the default becomes a Bluetooth headset.
    private func watchInputDevices() {
        guard inputListener == nil else { return }
        inputListener = HALPropertyListener(
            selectors: [kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDevices]
        ) { [weak self] in
            Task { await self?.noteInputsMoved() }
        }
    }

    /// The default input or the device list changed. Mark the binding stale, and — if nothing is
    /// recording — rebuild now, so the next press arms on the new device at warm cost. Under a
    /// running take nothing is touched: the take keeps the device it started on, and the next
    /// press's `routeChanged` moves to the new one.
    func noteInputsMoved() async {
        inputChangeCount += 1
        inputsMoved = true
        // Only once the app has warmed up at all: a source nobody has used has nothing to move.
        guard !isCapturing, warmUpCount > 0 else { return }
        await warmUp()
    }

    /// Point the input unit at `device`, for this process only.
    ///
    /// `kAudioOutputUnitProperty_CurrentDevice` on the input node's own AUHAL — never
    /// `kAudioHardwarePropertyDefaultInputDevice`, which would move every other app's microphone
    /// too. Only legal on a stopped engine, which is the only place this is called from.
    private func bind(_ device: AudioDeviceID?) throws {
        guard let device else { boundDevice = nil; return }
        guard let unit = engine.inputNode.audioUnit else {
            throw MicrophoneError.engineFailedToStart("the input node has no audio unit")
        }
        var id = device
        let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global, 0, &id,
                                          UInt32(MemoryLayout<AudioDeviceID>.size))
        guard status == noErr else {
            throw MicrophoneError.engineFailedToStart(
                "could not select \(AudioDevices.name(device)) as the input (\(status))")
        }
        boundDevice = device
    }
    #endif

    /// Let go of the engine and everything hanging off it, so no input node of ours exists.
    ///
    /// Order is load-bearing: stop, detach the sink, drop our reference to it, and only then
    /// replace the engine. Replacing the engine first let it tear its graph down with the sink
    /// still attached, and releasing the sink afterwards crashed in `objc_release` (SIGSEGV,
    /// reproduced by `SecondPressTests` on the first version of this function).
    ///
    /// The old engine is *retired*, not freed here. This is called exactly when the engine is
    /// most likely to have configuration changes in flight — the device just changed, or a
    /// Bluetooth take just stopped — and an engine that deallocates under one of AVFAudio's own
    /// configuration-change blocks is a use-after-free. See `EngineRetirement`.
    private func releaseEngine() {
        engine.stop()
        if let existing = sink {
            nonisolated(unsafe) let detaching = existing
            _ = KotibaCatchObjCException { engine.detach(detaching) }
        }
        sink = nil
        // The new engine is named live *before* the old one is retired, so the change the old
        // one posts from its own teardown is recognised as stale and ignored.
        let fresh = AVAudioEngine()
        liveEngine.set(ObjectIdentifier(fresh))
        slot.retirement.retire(engine)
        slot.engine = fresh
        hardwareFormat = nil
        graphIsStale = true
        graphWarm = false
        #if os(macOS)
        boundDevice = nil
        boundIsBluetooth = false
        currentInput = nil
        #endif
    }

    // MARK: A-06 — warm-up

    /// Prepare the graph so the first press is not the cold one.
    ///
    /// **Always attempts, even after a previous success, and especially after a previous
    /// failure.** v1 called warm-up exactly once from `init`, and because routing refuses to
    /// hand work to an engine whose `isReady` is false, one bad moment at launch disabled the
    /// Neural Engine for the entire life of the process — and a suspended-then-resumed app
    /// never runs `init` again. This is why the app calls it on every foreground.
    ///
    /// The one exception is a Bluetooth input: an idle warm engine on a headset microphone holds
    /// the headset in HFP between dictations, which is the "music sounds like a phone call all
    /// day" report. Then warm-up lets go of the engine instead, and the press pays the cold start.
    public func warmUp() async {
        guard !isCapturing else { return }       // never rebuild under a running take
        await prepareGraph(forCapture: false)
    }

    private func prepareGraph(forCapture: Bool) async {
        warmUpCount += 1
        coldForBluetooth = false
        do {
            // Ask for the microphone *before* touching `inputNode`.
            //
            // This ordering is not tidiness. `AVAudioEngine.inputNode` blocks — measured, in
            // this app, on a first launch — until the TCC decision is made, and the decision
            // needs a person to click a dialog. Reaching for it first stalls warm-up for as
            // long as the prompt sits unanswered, and anything sequenced behind warm-up never
            // runs at all. `requestAccess` is the async form of the same question and returns
            // the moment there is an answer, including immediately when one already exists.
            guard await Self.microphoneGranted() else {
                throw MicrophoneError.permissionDenied
            }
            // That await let the actor go, and a press may have started capturing meanwhile: the
            // check in `warmUp` is from before it. An idle warm-up has no business with a running
            // graph — on a Bluetooth input it would `releaseEngine()` under the take, and the
            // rest of the dictation would arrive nowhere. The capture has a graph; leave it be.
            if !forCapture, isCapturing { return }
            try configureSession()
            #if os(macOS)
            let route = routeChanged()
            coldForBluetooth = route.bluetooth && !forCapture
            if coldForBluetooth {
                // Nothing may sit on a headset microphone while idle. Not a failure: the next
                // press builds the graph, captures, and lets go again.
                releaseEngine()
                lastWarmUpError = nil
                lastWarmUpFailure = nil
                return
            }
            if route.changed || graphIsStale {
                inputsMoved = false
                // A different device is a different graph, and so is one the hardware moved
                // under. Rebuild from a fresh engine rather than re-pointing a connected one: the
                // old connection carries the old format, and an AUHAL whose device changed under
                // it can silently revert `CurrentDevice` or hand back empty buffers (VoiceInk
                // #956 is the same bug in another app). A fresh engine costs a few milliseconds,
                // once per device change.
                if sink != nil || boundDevice != nil { releaseEngine() }
                try bind(route.device)
                graphIsStale = true
            }
            boundIsBluetooth = route.bluetooth
            watchInputDevices()
            #endif
            let input = engine.inputNode
            // Read the *hardware* side of the input node, never its output side.
            //
            // `outputFormat(forBus: 0)` is the format of the connection we made last time, so
            // comparing it with `hardwareFormat` compared our own record with itself and never
            // came out stale. Meanwhile the engine's `start()` compares the connection against
            // `inputFormat(forBus: 0)` — the device as it is now — and raises "Input HW format
            // and tap format not matching" when they differ. That is exactly what eight
            // consecutive presses hit on 2026-09-19: the device had changed while the engine
            // was stopped between dictations (the configuration-change notification only fires
            // for a running engine), the raise was caught, and every warm-up after it re-checked
            // the wrong format, found nothing to rebuild, and handed the same broken graph back.
            let format = input.inputFormat(forBus: 0)
            guard format.channelCount > 0, format.sampleRate > 0 else {
                throw MicrophoneError.noInputAvailable
            }
            #if os(macOS)
            // Which microphone this graph records from, written down now — at the moment it is
            // bound — for every take that starts on it. The hardware's own rate, from the same
            // format the capture resamples from.
            currentInput = route.device.map {
                devices.inputInfo($0, sampleRate: format.sampleRate,
                                  overrodeDefault: route.overrode)
            }
            #endif
            // Rebuild the graph when it is stale, not merely when it was never built.
            //
            // This used to be `if sink == nil { attachSink(format: format) }`, and that single
            // condition is why 12 of 159 recorded activations produced nothing. AVAudioEngine
            // drops its I/O connections and stops itself on a configuration change — a device
            // switch, a sample-rate change, AirPods connecting — and the connections have to be
            // re-made. With `sink != nil` forever, warm-up skipped the reattachment forever, while
            // `engine.prepare()` kept succeeding and `isWarm` stayed true. So nothing reported a
            // broken microphone and nothing fixed it; only relaunching the app did.
            //
            // From this app's own diagnostics, one session on 2026-08-11: seven captures where
            // arming succeeded in 20–59 ms and zero samples arrived — reported to the user as
            // "heard nothing", because the silence gate cannot tell an empty buffer from a quiet
            // one — and then five consecutive `-10875
            // IsFormatSampleRateAndChannelCountValid(inputHWFormat)` failures starting four
            // seconds after the last of them. Four of the seven are inside forty seconds of each
            // other: someone pressing the key again and again while nothing came through.
            let stale = graphIsStale || sink == nil
                || (hardwareFormat.map { !$0.isEqual(format) } ?? true)
            if stale {
                if let existing = sink {
                    try caughtRaise { engine.detach(existing) }
                    sink = nil
                }
                hardwareFormat = format
                try attachSink(format: format)
                graphIsStale = false
            } else {
                hardwareFormat = format
            }
            watchConfigurationChanges()
            try caughtRaise { engine.prepare() }
            graphWarm = true
            lastWarmUpError = nil
            lastWarmUpFailure = nil
        } catch {
            // Recorded, never swallowed: an engine that will not warm up is exactly the
            // condition that must be visible in diagnostics and in the HUD.
            graphWarm = false
            lastWarmUpFailure = error as? MicrophoneError
            lastWarmUpError = "\(error)"
        }
    }

    /// Watch for the notification that says the graph we built no longer exists.
    ///
    /// Started from `warmUp` rather than `init` so it is not created for a source nobody uses, and
    /// guarded so repeated warm-ups do not stack observers. It lives for the process.
    private func watchConfigurationChanges() {
        liveEngine.set(ObjectIdentifier(engine))
        guard configurationWatcher == nil else { return }
        // A synchronous block observer, not `NotificationCenter.notifications(named:)`.
        //
        // The async sequence buffers each `Notification` — and with it the posting engine — and
        // releases it later on another thread. An engine that is being *deallocated* posts this
        // notification from its own teardown (Kotiba replaces engines now: see `releaseEngine`),
        // so the buffered reference outlived the object and the release crashed in
        // `objc_release` (SIGSEGV, `KERN_INVALID_ADDRESS`, reproduced in `SecondPressTests`).
        // The block runs inside the post and keeps nothing: it compares identities and returns.
        //
        // No `object:` filter, because the engine is replaced when a Bluetooth input is let go or
        // a device changes, and a filter on the first one would go deaf.
        let live = liveEngine
        configurationWatcher = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil
        ) { [weak self] note in
            guard let poster = note.object as AnyObject?,
                  live.is(ObjectIdentifier(poster)) else { return }
            Task { await self?.noteConfigurationChange() }
        }
    }

    /// The device changed. Mark the graph for rebuilding and say so — unless, looked at, nothing
    /// did.
    ///
    /// Deliberately does NOT clear `hardwareFormat` or `isCapturing`. A change arriving mid-
    /// dictation has already stopped the engine, so the recording is truncated — but the take
    /// still holds everything that arrived, converted at the old rate, and a truncated transcript
    /// beats an empty one. The next warm-up rebuilds against the new device.
    ///
    /// **Most of these are our own.** Measured on this Mac (M4 Pro, built-in microphone, nothing
    /// else touched, 2026-10-02): the engine posts one ~50 ms after the first `start()` of every
    /// freshly connected graph, with the engine still running, the same device on the unit and
    /// the same 48 kHz mono format. Believed blindly, that marked the graph stale, the next press
    /// rebuilt it, its start posted again — a loop in which every press after the first armed in
    /// 105–135 ms instead of ~34 ms, a first syllable at risk on every dictation but one. So the graph is checked before it is condemned: a change that moved the route,
    /// changed the hardware format, or stopped an engine a take is running on is news; one that
    /// left all three alone is not. Not a time window around our own stop/start — the post came
    /// 50 ms *after* the start returned, and a real change inside any such window would be lost.
    func noteConfigurationChange() {
        configurationChangeCount += 1
        #if os(macOS)
        // Only a built graph can be checked. Without a sink there is nothing to keep — and
        // reaching for `inputNode` on a released engine would create one, which on a Bluetooth
        // default is exactly what holds a headset in HFP.
        if sink != nil, let bound = hardwareFormat {
            let route = routeChanged()
            let now = engine.inputNode.inputFormat(forBus: 0)
            if !InputRoute.configurationChangeIsNews(
                routeChanged: route.changed, formatUnchanged: now.isEqual(bound),
                takeRunning: isCapturing, engineRunning: engine.isRunning) {
                ignoredConfigurationChangeCount += 1
                return
            }
        }
        #endif
        graphIsStale = true
        graphWarm = false
        lastWarmUpError = "the input device changed — the audio graph is rebuilt on the next press"
    }

    /// The microphone grant, as a question that can be awaited rather than one that blocks.
    ///
    /// `.notDetermined` is the only case that shows a dialog; the others answer instantly, so
    /// this is cheap to call on every foreground.
    static func microphoneGranted() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .denied, .restricted: return false
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        @unknown default: return await AVCaptureDevice.requestAccess(for: .audio)
        }
    }

    private func configureSession() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement,
                                options: [.duckOthers, .allowBluetooth])
        try session.setActive(true)
        #endif
    }

    /// Runs an AVFAudio call that reports failure by *raising*, and turns the raise into a
    /// thrown Swift error. The graph rebuild above closed most of the configuration-change
    /// hole, but the raise stayed fatal: three identical SIGABRT logs (Aug 18-23) end in
    /// `-[AVAudioEngine connect:to:format:]` raising over a format the hardware had already
    /// abandoned. A device can change between reading its format and using it, so the window
    /// is not closable, only catchable - and Swift cannot catch an NSException.
    private func caughtRaise(_ body: () -> Void) throws {
        if let error = KotibaCatchObjCException(body) {
            throw MicrophoneError.engineFailedToStart(error.localizedDescription)
        }
    }

    private func attachSink(format: AVAudioFormat) throws {
        let ring = pipeline.ring
        let scratch = self.scratch
        let meter = self.meter
        let channels = self.channels
        let node = AVAudioSinkNode { _, frameCount, audioBufferList in
            // Real-time thread. No allocation, no locks, no Objective-C, no waiting.
            let abl = UnsafeMutableAudioBufferListPointer(
                UnsafeMutablePointer(mutating: audioBufferList))
            let frames = Int(frameCount)
            guard frames > 0, abl.count > 0 else { return noErr }

            // Channel pointers are staged in preallocated memory, never in a Swift Array.
            //
            // An earlier version built `var pointers = [UnsafeMutablePointer<Float>]()` here and
            // appended per channel — a malloc and a free on every render quantum, roughly every
            // 5–10 ms, on the one thread where that is forbidden. malloc takes a lock; if a
            // lower-priority thread holds it — say, the one mapping a 539 MB whisper model while
            // the user is mid-sentence — the audio thread misses its deadline and Core Audio
            // drops buffers. The only trace would have been `ring.dropped`, reported as "the
            // consumer fell behind", which names the wrong culprit entirely.
            let count = min(abl.count, channels.capacity)
            guard count > 0 else { return noErr }
            for index in 0..<count {
                guard let data = abl[index].mData else { return noErr }
                channels.base[index] = data.assumingMemoryBound(to: Float.self)
            }
            let take = min(frames, scratch.count)
            Downmix.toMono(channels: UnsafeBufferPointer(start: channels.base, count: count),
                           frames: take, into: scratch.base)
            meter.publish(scratch.base, count: take)
            ring.write(UnsafeBufferPointer(start: scratch.base, count: take))
            return noErr
        }
        // The block runs synchronously on this actor - `caughtRaise` only forwards it to an
        // @try - but the region checker cannot see through the C call.
        nonisolated(unsafe) let attaching = node
        try caughtRaise {
            engine.attach(attaching)
            engine.connect(engine.inputNode, to: attaching, format: format)
        }
        sink = node
    }

    // MARK: A-01 — capture, as takes

    /// A handle for one dictation's audio. Cheap and synchronous, so a controller can make one
    /// at key-down without awaiting the actor.
    ///
    /// - Parameter onLimit: called once, off the main thread, if the take reaches the ceiling.
    public nonisolated func take(onLimit: (@Sendable () -> Void)? = nil) -> MicrophoneTake {
        let id = takeCounter.wrappingAdd(1, ordering: .relaxed).newValue
        return MicrophoneTake(source: self, id: id, onLimit: onLimit)
    }

    /// Begin feeding take `id`.
    ///
    /// With the engine already running for an older take — the user pressed again before the
    /// previous dictation reached its own `stop()` — this seals the older take at this sample and
    /// opens the new one on the same running engine. No restart, no gap, no audio shared.
    func startTake(_ id: UInt64, continuation: AsyncStream<[Float]>.Continuation?,
                   onLimit: (@Sendable () -> Void)?) async throws {
        let previous = startChain
        let result = ResultBox()
        let task = Task {
            await previous?.value
            do {
                try await self.performStart(id, continuation: continuation, onLimit: onLimit)
            } catch {
                result.error = error
            }
        }
        startChain = task
        await task.value
        if let error = result.error { throw error }
    }

    private final class ResultBox: @unchecked Sendable { var error: (any Error)? }

    private func performStart(_ id: UInt64, continuation: AsyncStream<[Float]>.Continuation?,
                              onLimit: (@Sendable () -> Void)?) async throws {
        guard currentTake != id else { return }       // "safe to call when already armed"

        #if os(macOS)
        // Asked before the fast path, not only from idle: a press overlapping a dictation used
        // to reuse the running graph even if the user had picked another microphone since.
        let moved = routeChanged().changed
        #else
        let moved = false
        #endif
        if isCapturing, !graphIsStale, !moved, let format = hardwareFormat {
            try pipeline.begin(take: id, sourceRate: format.sampleRate,
                               continuation: continuation, onLimit: onLimit)
            currentTake = id
            currentTakeStarted = .now
            rememberInput(for: id)
            return
        }
        // Either idle, or an older take whose engine a device change has already stopped. Its
        // audio is complete; `begin` below seals it before anything new can arrive.
        if isCapturing {
            engine.stop()
            isCapturing = false
        }
        if moved { graphWarm = false; graphIsStale = true }
        if !graphWarm { await prepareGraph(forCapture: true) }
        guard graphWarm, let format = hardwareFormat else {
            // Rethrow what warm-up actually hit, rather than re-wrapping its message. A denied
            // microphone is a permission problem all the way up; flattening it into
            // `engineFailedToStart` lost the one thing that says which System Settings pane to
            // open, and nested the reason inside another reason on the way.
            throw lastWarmUpFailure ?? .engineFailedToStart(lastWarmUpError ?? "not warm")
        }
        try pipeline.begin(take: id, sourceRate: format.sampleRate,
                           continuation: continuation, onLimit: onLimit)
        // The engine is stopped, so nothing new is in the ring; anything left there belonged to
        // the take `begin` just sealed, and it has been pumped into it.
        pipeline.resetRing()
        meter.reset()
        // `start()` both throws and - on a graph the hardware has moved under - raises, so it
        // needs both nets. A raise here was fatal to the whole process before `caughtRaise`.
        do {
            var startError: (any Error)?
            try caughtRaise {
                do { try engine.start() } catch { startError = error }
            }
            if let startError { throw startError }
        } catch {
            _ = pipeline.end(take: id)
            noteStartFailure()
            if let error = error as? MicrophoneError { throw error }
            throw MicrophoneError.engineFailedToStart("\(error)")
        }
        isCapturing = true
        currentTake = id
        currentTakeStarted = .now
        rememberInput(for: id)
        // One activity at a time. This path is also reached with an older take still current —
        // its engine stopped by a device change, see above — and that take's activity was never
        // ended: its own `stopTake` finds a newer `currentTake` and ends nothing. `.userInitiated`
        // includes `.idleSystemSleepDisabled`, so the leaked token kept the Mac awake for the life
        // of the process.
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .latencyCritical], reason: "Recording a dictation")
    }

    private func rememberInput(for id: UInt64) {
        #if os(macOS)
        takeInputs[id] = currentInput
        #endif
    }

    /// `pipeline.end(take:)`, with the take's microphone attached to what it hands back.
    private func sealTake(_ id: UInt64) -> CapturePipeline.Result {
        var result = pipeline.end(take: id)
        result.buffer = result.buffer.withDevice(takeInputs.removeValue(forKey: id))
        return result
    }

    /// End take `id` and hand back its audio.
    func stopTake(_ id: UInt64) -> CapturePipeline.Result {
        guard currentTake == id else {
            // Sealed already by a newer take, or never started. Either way the engine is not
            // this take's to stop.
            return sealTake(id)
        }
        // Hardware first, so the take's tail is complete when the pipeline seals it.
        let wasRunning = isCapturing
        if isCapturing { engine.stop() }
        isCapturing = false
        currentTake = nil
        let held = currentTakeStarted.map { ContinuousClock.now - $0 }
        currentTakeStarted = nil
        meter.reset()
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        activity = nil
        let result = sealTake(id)
        // A running engine that delivered not one sample in a real hold is a broken graph, not a
        // quiet room — the session reports it as "the microphone delivered no audio at all …
        // Kotiba rebuilds its audio graph on the next press", and until now nothing here did: the
        // rebuild waited on a configuration-change notification that a device changing while
        // the engine was stopped never posts (23 such records in the owner's diagnostics, four
        // of them back to back). A rebuild costs a few milliseconds on the next press; trusting
        // the graph costs every press until something else notices.
        if Self.deliveredNothing(samples: result.buffer.samples.count, engineRan: wasRunning,
                                 held: held) {
            noteDeliveredNothing()
        }
        #if os(macOS)
        // Let go of a headset microphone the moment the dictation is over. See `warmUp`.
        if boundIsBluetooth { releaseEngine() } else if wasRunning {
            // Re-prepare after the release, not during it: measured 15–19 ms, and `stopTake` is
            // on the release→text path. See `reprepareIfIdle`.
            Task { await self.reprepareIfIdle() }
        }
        #endif
        return result
    }

    /// Put a stopped, healthy graph back into the state warm-up leaves it in.
    ///
    /// `engine.stop()` deallocates what `prepare()` allocated, so a press after a stop paid for
    /// both in its `start()`: measured on this Mac, the first press after warm-up starts in ~34 ms
    /// and every later one in 43–60 ms; with this, 35–44 ms. It runs on the actor just after the
    /// release, so it costs only a press that lands in those ~17 ms — which then simply starts on
    /// a prepared graph. Not on a Bluetooth input (released instead, see `warmUp`), not on a graph
    /// already condemned (the next press rebuilds it), never under a take.
    private func reprepareIfIdle() {
        guard !isCapturing, graphWarm, !graphIsStale, sink != nil else { return }
        #if os(macOS)
        guard !boundIsBluetooth else { return }
        #endif
        if KotibaCatchObjCException({ engine.prepare() }) != nil { noteStartFailure() }
    }

    /// Whether a take's emptiness condemns the graph. A tap shorter than the first render quantum
    /// can end empty on a healthy graph, hence the floor; 300 ms is several times the first-buffer
    /// latency of a built-in or USB microphone. (A Bluetooth input is let go after every take
    /// anyway, so its slower start costs nothing here.)
    static func deliveredNothing(samples: Int, engineRan: Bool, held: Duration?) -> Bool {
        guard samples == 0, engineRan, let held else { return false }
        return held >= .milliseconds(300)
    }

    private func noteDeliveredNothing() {
        graphWarm = false
        graphIsStale = true
        lastWarmUpError = "the last recording delivered no audio — the audio graph is rebuilt "
            + "on the next press"
    }

    /// A start that failed is a graph that cannot be trusted. Marking it stale makes the next
    /// warm-up rebuild the connection unconditionally, instead of trusting a format comparison
    /// to notice — the comparison above is now correct, but this is the net under it: whatever
    /// the reason `start()` raised, a rebuild costs a few milliseconds and a stale graph costs
    /// every press until relaunch.
    private func noteStartFailure() {
        graphWarm = false
        graphIsStale = true
    }

    /// The current loudness, 0…1. Non-destructive: polling this never costs the transcription
    /// a sample.
    public nonisolated func currentPeak() -> Float { meter.level }

    // MARK: AudioSource, for callers that want one anonymous take at a time

    private var anonymousTake: UInt64?

    public func start() async throws {
        let id = takeCounter.wrappingAdd(1, ordering: .relaxed).newValue
        anonymousTake = id
        try await startTake(id, continuation: nil, onLimit: nil)
    }

    /// Ends whatever take the hardware is feeding. With takes this is only for callers that
    /// never overlap — the probe, and a cancel that does not know its take.
    public func stop() async throws -> KotibaCore.AudioBuffer {
        guard let id = currentTake ?? anonymousTake else { return Buffer(samples: []) }
        anonymousTake = nil
        return stopTake(id).buffer
    }
}

/// One dictation's audio, as an `AudioSource` a session can own.
///
/// The session calls `start()` at key-down and `stop()` at key-up exactly as it always has; what
/// changed is that two sessions can now be alive at once — the second key-down no longer has to
/// wait for the first dictation to finish — and each gets its own audio rather than a share of
/// one buffer.
public struct MicrophoneTake: AudioSource {
    public let id: UInt64
    private let source: MicrophoneSource
    private let onLimit: (@Sendable () -> Void)?
    private let continuation: AsyncStream<[Float]>.Continuation

    /// Every 16 kHz mono chunk of this take, in order, delivered while the key is held — roughly
    /// every 20 ms. Finished when the take ends. Unbounded buffering, so a consumer that starts
    /// late misses nothing. The seam for transcribing during speech.
    public let chunks: AsyncStream<[Float]>

    init(source: MicrophoneSource, id: UInt64, onLimit: (@Sendable () -> Void)?) {
        self.source = source
        self.id = id
        self.onLimit = onLimit
        (chunks, continuation) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .unbounded)
    }

    public func start() async throws {
        try await source.startTake(id, continuation: continuation, onLimit: onLimit)
    }

    public func stop() async throws -> KotibaCore.AudioBuffer {
        await source.stopTake(id).buffer
    }

    public func warmUp() async { await source.warmUp() }
}

// `"\(error)"` is this codebase's interchange format at the module boundaries — 23 sites convert
// that way — and for an `Error` enum without `CustomStringConvertible` it reflects the case name
// instead of the diagnosis. A denied microphone reached the user as
// `engineFailedToStart("permissionDenied")`, which appears verbatim in real diagnostics. Each of
// these types already writes the actionable sentence in `reason`; this is what makes the
// interchange format use it, with no call-site changes.

extension MicrophoneError: CustomStringConvertible {
    public var description: String { reason }
}

// A take already publishes its 16 kHz audio while the key is held; this is what lets the session
// hand it to a streaming engine (`DictationSession.openLiveStream`) without knowing it is a
// microphone.
extension MicrophoneTake: LiveAudioSource {}
