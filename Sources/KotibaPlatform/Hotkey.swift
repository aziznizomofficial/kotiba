#if os(macOS)
import AppKit
import ApplicationServices
import KotibaCore
import Synchronization

// Task I-03. Hold a key to talk — right ⌘ unless the user picked another (`HotkeySpec`).
//
// ⚠️ UNVERIFIED ON DEVICE. Needs Input Monitoring (and Accessibility for an ordinary key), which
// no test can grant. The decisions — what is a press, a release, a chord, what to swallow — live
// in `HotkeyTracker` and are tested; this file is only the tap that feeds it.
//
// A session event tap rather than `RegisterEventHotKey`, and the reason is specific: Carbon's
// hotkey API registers a key *combination*, and a bare modifier held on its own is not one.
// Whether `RegisterEventHotKey(keycode 54, mods 0)` ever fires at all is an open question in
// the research that two passes could not settle. A `flagsChanged` tap sidesteps it entirely.
//
// Two kinds of tap, by spec:
//
//   * A modifier gets a *listen-only* tap on `flagsChanged` and `keyDown`. Listen-only because the
//     modifier must keep working in every other app; `keyDown` because a key pressed while the
//     modifier is held is a shortcut (⌘C), and the dictation it started must be cancelled.
//   * An ordinary key (F13, F5…) gets an *active* tap on `keyDown`/`keyUp` that returns nil for
//     that key, so holding it types nothing and its autorepeat never reaches an app. macOS only
//     lets a tap drop events with Accessibility granted; Input Monitoring alone is listen-only.
//
// The tap runs on its own thread with its own run loop, not the main one. A tap whose callback
// is late is disabled by the system (`tapDisabledByTimeout`), and the main thread is exactly the
// one that is busy when it matters — SwiftUI laying out the settings window, a model loading.
// An active tap stalled behind the main thread also stalls *every keystroke on the machine*.

/// Watches for the push-to-talk gesture. The handler is called on the tap's own thread; hop to
/// wherever the work belongs.
public final class PushToTalkMonitor: @unchecked Sendable {

    public let spec: HotkeySpec
    private let handler: @Sendable (HotkeyEvent) -> Void
    /// Touched by the tap thread and by `start`/`stop`/`resyncHeld` on the caller's.
    private let tracker: Mutex<HotkeyTracker>

    /// Re-reads the hardware four times a second while a hold is active — see `watchHold`.
    private let holdWatchQueue = DispatchQueue(label: "uz.kotiba.hotkey.hold", qos: .userInteractive)
    private let holdWatch = Mutex<DispatchSourceTimer?>(nil)

    // Owned by `start`/`stop`, which the app calls from the main thread.
    private var tap: CFMachPort?
    private var thread: Thread?
    private var runLoop: CFRunLoop?

    /// While true every monitor passes everything through and reports nothing — the hotkey
    /// recorder needs to see the current hotkey pressed without it starting a dictation.
    private static let suspended = Atomic<Bool>(false)

    public static var isSuspended: Bool {
        get { suspended.load(ordering: .relaxed) }
        set { suspended.store(newValue, ordering: .relaxed) }
    }

    public init(spec: HotkeySpec = .default, handler: @escaping @Sendable (HotkeyEvent) -> Void) {
        self.spec = spec
        self.handler = handler
        tracker = Mutex(HotkeyTracker(spec: spec))
    }

    /// True when Input Monitoring has been granted. Checked before installing so the app can
    /// explain the problem rather than silently never responding to the key.
    public static var isPermitted: Bool {
        CGPreflightListenEventAccess()
    }

    /// Asks for Input Monitoring. The system shows its prompt once per app version; after a
    /// refusal the user must go to System Settings, which the UI has to explain.
    @discardableResult
    public static func requestPermission() -> Bool {
        CGRequestListenEventAccess()
    }

    /// Whether `spec` can be watched with what has been granted.
    public static func isPermitted(for spec: HotkeySpec) -> Bool {
        spec.kind == .modifier ? isPermitted : (isPermitted && AXIsProcessTrusted())
    }

    public enum StartFailure: Error, Sendable {
        case notPermitted
        case needsAccessibility
        case tapRefused

        public var reason: String {
            switch self {
            case .notPermitted:
                return "Input Monitoring has not been granted — System Settings › Privacy & "
                    + "Security › Input Monitoring, then add Kotiba"
            case .needsAccessibility:
                return "an ordinary key as the dictation key needs Accessibility, so Kotiba can stop "
                    + "it typing — System Settings › Privacy & Security › Accessibility"
            case .tapRefused:
                return "macOS refused the event tap"
            }
        }
    }

    public func start() throws {
        guard Self.isPermitted else { throw StartFailure.notPermitted }
        if spec.kind == .key, !AXIsProcessTrusted() { throw StartFailure.needsAccessibility }
        guard tap == nil else { return }

        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon else { return Unmanaged.passUnretained(event) }
            let monitor = Unmanaged<PushToTalkMonitor>.fromOpaque(refcon).takeUnretainedValue()
            return monitor.handle(type: type, event: event)
        }

        var mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        mask |= spec.kind == .modifier
            ? CGEventMask(1 << CGEventType.flagsChanged.rawValue)
            : CGEventMask(1 << CGEventType.keyUp.rawValue)

        // The tap owns a reference to this monitor for as long as its thread can call back.
        //
        // It used to be handed `passUnretained(self)`, and the callback turned that pointer back
        // into a monitor with `takeUnretainedValue()` — a reference nobody held. Whoever dropped
        // the last real reference (the app replacing its monitor when the hotkey setting changes)
        // then ran `deinit` on its own thread while the tap thread could be inside `handle`, or
        // about to enter it with a pointer to freed memory. Now the reference is retained here and
        // released by the tap thread itself, *after* its run loop has exited — the one point at
        // which no callback can be running or pending — so `deinit` can only ever happen once the
        // tap is gone. `stop()` ends the run loop; it does not release anything itself.
        let retained = Unmanaged.passRetained(self)
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: spec.kind == .modifier ? .listenOnly : .defaultTap,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: retained.toOpaque()
        ) else {
            retained.release()
            throw StartFailure.tapRefused
        }
        self.tap = tap

        // The tap's own thread. The semaphore makes `start` return only once the run loop exists,
        // so a `stop` right after cannot miss it.
        let ready = DispatchSemaphore(value: 0)
        nonisolated(unsafe) let port = tap
        let owner = retained
        let box = RunLoopBox()
        let thread = Thread {
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
            let loop = CFRunLoopGetCurrent()!
            CFRunLoopAddSource(loop, source, .commonModes)
            box.loop = loop
            ready.signal()
            CFRunLoopRun()
            CFRunLoopRemoveSource(loop, source, .commonModes)
            // No callback can run past this line: the source is off the only run loop that
            // served it. The tap's reference goes last.
            CFMachPortInvalidate(port)
            owner.release()
        }
        thread.name = "uz.kotiba.hotkey"
        thread.qualityOfService = .userInteractive
        thread.start()
        ready.wait()
        self.thread = thread
        runLoop = box.loop
        CGEvent.tapEnable(tap: tap, enable: true)
        // A tap started while the key is already down would otherwise wait for an edge that has
        // already happened, and the first thing it would see is the key-up. That hold is adopted,
        // not reported: see `HotkeyTracker.adopt` for the phantom dictation reporting it caused.
        let flags = CGEventSource.flagsState(.combinedSessionState).rawValue
        let now = ProcessInfo.processInfo.systemUptime
        tracker.withLock { $0.adopt(flags: flags, now: now) }
    }

    private final class RunLoopBox: @unchecked Sendable { var loop: CFRunLoop? }

    public func stop() {
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let runLoop { CFRunLoopStop(runLoop) }
        tap = nil
        thread = nil
        runLoop = nil
        tracker.withLock { $0.reset() }
        holdWatch.withLock { $0?.cancel(); $0 = nil }
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        // macOS disables a tap that takes too long or is interrupted. Silently never firing
        // again is exactly the failure mode this project keeps meeting, so re-enable it.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            // Re-enabling is not enough on its own. Every edge during the disabled window is
            // gone, and a key-up lost there leaves the hold stuck: `.released` is never delivered,
            // the microphone stays open, and the next press is swallowed as a repeat. The hotkey
            // is dead until relaunch. Resample the hardware instead of trusting the edge history.
            resyncHeld()
            return Unmanaged.passUnretained(event)
        }
        guard !Self.isSuspended else { return Unmanaged.passUnretained(event) }

        let input: HotkeyInput
        switch type {
        case .flagsChanged:
            input = .flags(event.flags.rawValue)
        case .keyDown:
            input = .keyDown(code: UInt16(event.getIntegerValueField(.keyboardEventKeycode)),
                             isRepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0,
                             flags: event.flags.rawValue)
        case .keyUp:
            input = .keyUp(code: UInt16(event.getIntegerValueField(.keyboardEventKeycode)))
        default:
            return Unmanaged.passUnretained(event)
        }
        let now = ProcessInfo.processInfo.systemUptime
        let outcome = tracker.withLock { $0.handle(input, now: now) }
        if let fired = outcome.event { deliver(fired) }
        return outcome.swallow ? nil : Unmanaged.passUnretained(event)
    }

    private func deliver(_ event: HotkeyEvent) {
        watchHold(tracker.withLock { $0.isHeld })
        handler(event)
    }

    /// While the key is held, resample it four times a second.
    ///
    /// The edges are not guaranteed to arrive. A timeout-disabled tap is announced and resynced
    /// in `handle`, but Secure Event Input — a password field, Terminal's Secure Keyboard Entry,
    /// a password manager's window — silently withholds key events from every tap without
    /// disabling it. A key-up lost that way used to leave a dictation recording until the next
    /// press: with capture no longer capped at three minutes, that is a microphone open for as
    /// long as nobody touches the key again. Polling only during a hold costs nothing at idle.
    private func watchHold(_ held: Bool) {
        holdWatch.withLock { timer in
            if held, timer == nil {
                let source = DispatchSource.makeTimerSource(queue: holdWatchQueue)
                source.schedule(deadline: .now() + 0.25, repeating: 0.25, leeway: .milliseconds(50))
                source.setEventHandler { [weak self] in self?.resyncHeld() }
                source.resume()
                timer = source
            } else if !held, let running = timer {
                running.cancel()
                timer = nil
            }
        }
    }

    /// Reconcile the tracker against the key state the hardware actually reports, and emit
    /// whatever edge was missed.
    public func resyncHeld() {
        let flags = CGEventSource.flagsState(.combinedSessionState).rawValue
        let keyDown = spec.kind == .key
            && CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(spec.keyCode))
        let now = ProcessInfo.processInfo.systemUptime
        if let fired = tracker.withLock({ $0.resync(flags: flags, keyIsDown: keyDown, now: now) }) {
            deliver(fired)
        }
    }

    /// Only reachable once the tap thread has let go (see `start`), or for a monitor that was
    /// never started — so there is no tap left to stop, and nothing to race.
    deinit {
        holdWatch.withLock { $0?.cancel(); $0 = nil }
    }
}

// MARK: - Focus

/// Which application the text will land in. Read at hotkey-down for the mode decision and
/// again after transcription for the prompt, which is the split the architecture describes.
public enum Focus {
    public static var frontmostBundleID: String? {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }

    public static var frontmostName: String? {
        NSWorkspace.shared.frontmostApplication?.localizedName
    }

    /// Whether Kotiba itself is frontmost — a dictation triggered while its own settings window
    /// has focus should not try to paste into that window.
    public static var isSelfFrontmost: Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
    }
}
#endif

// `"\(error)"` is this codebase's interchange format at the module boundaries — 23 sites convert
// that way — and for an `Error` enum without `CustomStringConvertible` it reflects the case name
// instead of the diagnosis. A denied microphone reached the user as
// `engineFailedToStart("permissionDenied")`, which appears verbatim in real diagnostics. Each of
// these types already writes the actionable sentence in `reason`; this is what makes the
// interchange format use it, with no call-site changes.

extension PushToTalkMonitor.StartFailure: CustomStringConvertible {
    public var description: String { reason }
}
