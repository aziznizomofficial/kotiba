import AVFoundation
import Foundation
import Synchronization
import Testing

@testable import KotibaAudio

// `swift test` crashed in about one full run in four: an AVFAudio configuration-change block
// released an `AVAudioEngine` that had been freed under it, because Kotiba dropped engines while
// their configuration traffic was still arriving (the full account is on `EngineRetirement`).
// The crash itself needs real audio hardware and dozens of engines on one device, so it is not
// reproducible here; what is provable without a microphone is the contract the fix rests on — a
// retired engine outlives its own configuration traffic, and dies on the retirement's queue.

private final class Record: Sendable {
    let log = Mutex<(freed: Bool, onRetirementQueue: Bool)>((false, false))
    var freed: Bool { log.withLock { $0.freed } }
    var onRetirementQueue: Bool { log.withLock { $0.onRetirementQueue } }
}

/// Stands in for an engine, and records whether — and on which queue — it was freed.
private final class Tombstone: NSObject, @unchecked Sendable {
    let record: Record
    init(_ record: Record) { self.record = record }
    deinit {
        let label = String(cString: __dispatch_queue_get_label(nil))
        record.log.withLock { $0 = (true, label == "uz.kotiba.engine-retirement") }
    }
}

private final class WeakBox: @unchecked Sendable {
    weak var object: Tombstone?
}

/// Parks a fresh `Tombstone`. The only strong reference is handed to the retirement; the caller
/// gets its record, its identity and a weak handle, none of which keeps it alive.
private func park(in retirement: EngineRetirement) -> (Record, ObjectIdentifier, WeakBox) {
    let record = Record()
    let stone = Tombstone(record)
    let handle = WeakBox()
    handle.object = stone
    retirement.hold(stone)
    return (record, ObjectIdentifier(stone), handle)
}

private func waitUntil(_ limit: Duration, _ condition: () -> Bool) async {
    let clock = ContinuousClock()
    let deadline = clock.now + limit
    while !condition(), clock.now < deadline {
        try? await Task.sleep(for: .milliseconds(10))
    }
}

/// Calls `beat` every 25 ms for `span`, on a thread of its own.
///
/// Not from a task: the rest of the suite blocks cooperative threads for seconds at a time
/// (measured: a 50 ms sleep coming back after 2.97 s), and a heartbeat that stalls for longer than
/// the quiet period would make the retirement look wrong when it is the heart that stopped.
private func chatter(for span: Duration, _ beat: @escaping @Sendable () -> Void) async {
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        Thread.detachNewThread {
            let clock = ContinuousClock()
            let start = clock.now
            while clock.now - start < span {
                beat()
                Thread.sleep(forTimeInterval: 0.025)
            }
            done.resume()
        }
    }
}

@Suite("A replaced audio engine is freed later, and on a queue of ours")
struct EngineRetirementTests {

    @Test("a retired engine is held until it has been quiet, then freed on the retirement queue")
    func heldThenFreed() async {
        let retirement = EngineRetirement(quiet: .seconds(1), ceiling: .seconds(30))
        let (record, _, _) = park(in: retirement)
        #expect(!record.freed, "freed the moment it was retired: that is the defect")
        #expect(retirement.heldCount == 1)

        await waitUntil(.seconds(15)) { record.freed }
        #expect(record.freed)
        // Not inside whichever block happened to drop the last reference.
        #expect(record.onRetirementQueue)
        #expect(retirement.heldCount == 0)
        #expect(retirement.released == 1)
    }

    @Test("a configuration change for a retired engine pushes its release back")
    func trafficDefersRelease() async {
        let retirement = EngineRetirement(quiet: .milliseconds(500), ceiling: .seconds(30))
        let (record, id, _) = park(in: retirement)
        let early = Record()
        // Chatter for four quiet periods: without the push-back it would be freed in the first.
        await chatter(for: .seconds(2)) {
            retirement.heard(from: id)
            if record.freed { early.log.withLock { $0.freed = true } }
        }
        #expect(!early.freed, "freed while its configuration traffic was still arriving")
        await waitUntil(.seconds(15)) { record.freed }
        #expect(record.freed, "never freed once the traffic stopped")
    }

    @Test("the notification AVFAudio posts is what counts as traffic")
    func observesTheRealNotification() async {
        let retirement = EngineRetirement(quiet: .milliseconds(500), ceiling: .seconds(30))
        // The handle is weak, so the retirement's is the only strong reference: the test must not
        // be what keeps the object alive.
        let (record, _, poster) = park(in: retirement)
        let early = Record()
        await chatter(for: .seconds(2)) {
            // Posted with the retired object itself, as the engine posts it. Other observers in
            // the process compare the poster with their own engine and ignore it.
            NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange,
                                            object: poster.object)
            if record.freed { early.log.withLock { $0.freed = true } }
        }
        #expect(!early.freed, "the observer did not register AVFAudio's notification as traffic")
        await waitUntil(.seconds(15)) { record.freed }
        #expect(record.freed)
    }

    @Test("a device that never stops chattering cannot keep an engine alive for ever")
    func ceilingBoundsTheHold() async {
        // The ceiling matters: an engine on a Bluetooth headset's microphone holds the headset in
        // its phone-call profile for as long as the engine exists.
        let retirement = EngineRetirement(quiet: .milliseconds(500), ceiling: .seconds(1))
        let (record, id, _) = park(in: retirement)
        let freedMidTraffic = Record()
        await chatter(for: .seconds(4)) {
            retirement.heard(from: id)
            if record.freed { freedMidTraffic.log.withLock { $0.freed = true } }
        }
        #expect(freedMidTraffic.freed, "held for as long as the traffic lasted")
    }

    @Test("a microphone source that goes away retires its engine instead of freeing it")
    func sourceRetiresOnDeinit() async {
        // No input node is touched, so no device and no microphone grant are involved: an
        // `AVAudioEngine` that has never been asked for its input is inert.
        let retirement = EngineRetirement(quiet: .milliseconds(100), ceiling: .seconds(30))
        var source: MicrophoneSource? = MicrophoneSource(retirement: retirement)
        _ = source
        source = nil
        #expect(retirement.retired == 1, "the source's engine was freed where it fell")
        await waitUntil(.seconds(15)) { retirement.released == 1 }
        #expect(retirement.released == 1)
    }
}
