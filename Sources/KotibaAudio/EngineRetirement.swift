import AVFoundation
import Foundation
import KotibaObjC
import Synchronization

// Where an `AVAudioEngine` Kotiba has finished with goes to die — later, and on a queue of ours.
//
// The defect this exists for: `swift test` died with SIGSEGV in roughly one full run in four
// (5 of 36 on 2026-09-29). Every crash report had the same faulting thread — a
// `com.apple.root.default-qos` worker in `objc_release`, called from
// `_dispatch_call_block_and_release`, with `x9` pointing at the invocation function for the block
// in `AVAudioEngineImpl::IOUnitConfigurationChanged()` — and in every one, other global-queue
// workers were at that moment inside `-[AVAudioEngine dealloc]`, tearing down the input unit.
//
// What happens, as far as it can be seen from outside AVFAudio:
//
// * Pointing an engine's input unit at a device (`kAudioOutputUnitProperty_CurrentDevice`, which
//   `MicrophoneSource.bind` does on every graph build) starts a stream of configuration changes.
//   Measured in a stand-alone harness: one engine alone gets none, but with a few engines on the
//   same device every engine gets its own `AVAudioEngineConfigurationChange`, delivered
//   asynchronously from a block AVFAudio dispatches to a global queue. The test suite builds ~70
//   engines per run and sees ~270 of these notifications.
// * That block holds the engine only as long as it runs. When Kotiba lets go of an engine while
//   such a block is in flight, the block's release is the last one, and the engine deallocates
//   on the global queue (instrumented: 5-9 engines per run died that way). Tearing down the input
//   unit is slow — it waits on the HAL — and a second configuration-change block for the same
//   engine that starts in that window gets hold of an object that is already deallocating, which
//   `objc_retain` does not keep alive. When it finishes, it releases freed memory.
//
// Nothing outside AVFAudio can stop it from dispatching those blocks. What can be controlled is
// *when* the engine dies: not while its own configuration traffic is still arriving. So an engine
// Kotiba has finished with is stopped, has its sink detached, and is parked here, held strongly,
// until it has gone `quiet` without a configuration change of its own; then it is released on
// this queue. `ceiling` is the backstop: an engine bound to a Bluetooth headset's microphone holds
// the headset in its phone-call profile for as long as it exists (see `MicrophoneSource.warmUp`),
// so a device that never stops chattering must not keep one alive for ever.
//
// This is a production path, not only a test one. The app replaces its engine exactly when
// configuration traffic is most likely — the input device has just changed, or a Bluetooth
// dictation has just stopped and the headset is switching profiles — and until this file it freed
// the old engine at once, in the middle of that traffic.
final class EngineRetirement: Sendable {

    static let shared = EngineRetirement()

    /// How long a retired engine must go without a configuration change of its own before it is
    /// released.
    let quiet: Duration
    /// The longest any engine is held, however much it is still hearing.
    let ceiling: Duration

    /// `AVAudioEngine` is not `Sendable`. Nothing reads through this reference — it exists only
    /// to be the strong reference that keeps the engine alive — so there is nothing to race on.
    private final class Held: @unchecked Sendable {
        let object: AnyObject
        init(_ object: AnyObject) { self.object = object }
    }

    private struct Retiree: Sendable {
        let held: Held
        let retiredAt: ContinuousClock.Instant
        var lastHeard: ContinuousClock.Instant
    }

    private let clock = ContinuousClock()
    private let queue = DispatchQueue(label: "uz.kotiba.engine-retirement", qos: .utility)
    private let state = Mutex<(retirees: [ObjectIdentifier: Retiree], sweepScheduled: Bool)>(
        ([:], false))
    /// For tests: how many engines have been parked here, and how many released, so far.
    private let heldTotal = Atomic<Int>(0)
    private let releasedCount = Atomic<Int>(0)
    nonisolated(unsafe) private var observer: (any NSObjectProtocol)?

    init(quiet: Duration = .milliseconds(500), ceiling: Duration = .seconds(5)) {
        self.quiet = quiet
        self.ceiling = ceiling
        // A synchronous block observer that keeps nothing, for the reason spelled out on
        // `MicrophoneSource.watchConfigurationChanges`: the async sequence buffers each
        // notification, and with it the posting engine.
        //
        // `unowned` because the shared instance lives for the process and a test's instance
        // removes this observer in `deinit` before it goes.
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil
        ) { [unowned self] note in
            guard let poster = note.object as AnyObject? else { return }
            self.heard(from: ObjectIdentifier(poster))
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    /// Stop `engine`, detach anything Kotiba attached, and hold it until it is safe to free.
    ///
    /// Stopping and detaching happen here, on the caller's thread, so the engine is inert before
    /// it is parked: a retired engine never renders into a ring that has moved on. The sink is
    /// detached before the engine is released — see `MicrophoneSource.releaseEngine` for the
    /// crash that ordering once fixed.
    func retire(_ engine: AVAudioEngine) {
        _ = KotibaCatchObjCException {
            engine.stop()
            for node in engine.attachedNodes where node is AVAudioSinkNode {
                engine.detach(node)
            }
        }
        hold(engine)
    }

    /// The parking itself, separated from `retire` so it can be tested without an audio engine.
    func hold(_ object: AnyObject) {
        let now = clock.now
        let held = Held(object)
        heldTotal.add(1, ordering: .relaxed)
        let schedule = state.withLock { state -> Bool in
            state.retirees[ObjectIdentifier(object)] = Retiree(held: held, retiredAt: now,
                                                              lastHeard: now)
            if state.sweepScheduled { return false }
            state.sweepScheduled = true
            return true
        }
        if schedule { scheduleSweep(after: quiet) }
    }

    /// A configuration change arrived for `id`. Pushes its release back if it is retired here;
    /// ignored otherwise (the live engine's changes are `MicrophoneSource`'s business).
    func heard(from id: ObjectIdentifier) {
        let now = clock.now
        state.withLock { state in
            state.retirees[id]?.lastHeard = now
        }
    }

    /// Engines parked here right now.
    var heldCount: Int { state.withLock { $0.retirees.count } }
    /// Engines ever parked here.
    var retired: Int { heldTotal.load(ordering: .relaxed) }
    /// Engines released from here since this instance was made.
    var released: Int { releasedCount.load(ordering: .relaxed) }

    private func scheduleSweep(after delay: Duration) {
        let nanos = max(1, Int(delay / .nanoseconds(1)))
        queue.asyncAfter(deadline: .now() + .nanoseconds(nanos)) { [self] in sweep() }
    }

    private func sweep() {
        let now = clock.now
        let (due, next) = state.withLock { state -> ([Held], Duration?) in
            var due: [Held] = []
            var next: Duration?
            for (id, retiree) in state.retirees {
                let quietAt = retiree.lastHeard + quiet
                let ceilingAt = retiree.retiredAt + ceiling
                let releaseAt = min(quietAt, ceilingAt)
                if releaseAt <= now {
                    due.append(retiree.held)
                    state.retirees[id] = nil
                } else {
                    let wait = releaseAt - now
                    next = next.map { min($0, wait) } ?? wait
                }
            }
            state.sweepScheduled = next != nil
            return (due, next)
        }
        // The engines' last references go here, outside the lock and on this queue — the whole
        // point: never inside a block AVFAudio dispatched, never mid-traffic.
        releasedCount.add(due.count, ordering: .relaxed)
        if let next { scheduleSweep(after: next) }
    }
}
