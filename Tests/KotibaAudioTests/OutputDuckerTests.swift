#if os(macOS)
import Foundation
import Synchronization
import Testing

@testable import KotibaAudio

// Ducking against a fake HAL. Nothing here touches this Mac's real volume — which is not a
// nicety: the first version built the real ducker inside the controller, and a UI test that
// pressed without releasing lowered whatever was playing. `PlaybackDucking.inert` is the
// default for exactly that reason.

private final class FakeHAL: OutputVolumeBackend, @unchecked Sendable {
    private let lock = Mutex<[UInt32: Float]>([:])
    let elementList: [UInt32]
    let playing: Bool
    private let writes = Mutex(0)

    init(levels: [UInt32: Float], playing: Bool = true) {
        lock.withLock { $0 = levels }
        elementList = levels.keys.sorted()
        self.playing = playing
    }

    var writeCount: Int { writes.withLock { $0 } }
    func level(_ element: UInt32) -> Float { lock.withLock { $0[element] ?? -1 } }
    /// The user pressing a volume key.
    func userSets(_ element: UInt32, _ value: Float) { lock.withLock { $0[element] = value } }

    func defaultOutput() -> UInt32? { 42 }
    func uid(_ device: UInt32) -> String? { "fake-\(device)" }
    func device(forUID uid: String) -> UInt32? { uid == "fake-42" ? 42 : nil }
    func elements(_ device: UInt32) -> [UInt32] { elementList }
    func volume(_ device: UInt32, element: UInt32) -> Float? { lock.withLock { $0[element] } }
    func setVolume(_ device: UInt32, element: UInt32, _ value: Float) -> Bool {
        writes.withLock { $0 += 1 }
        lock.withLock { $0[element] = value }
        return true
    }
    func isPlaying(_ device: UInt32) -> Bool { playing }
}

private let fast = OutputDucker.Timing(startDelay: .milliseconds(0), ramp: .milliseconds(20), steps: 4)

private func marker() -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("kotiba-duck-\(UUID().uuidString)/ducking.json")
}

private func settle(_ d: OutputDucker, for ms: Int = 80) async {
    try? await Task.sleep(for: .milliseconds(ms))
    d.settle()
}

@Suite("Ducking what is playing while the key is held")
struct OutputDuckerTests {

    @Test("down to the chosen fraction, then back to exactly where it was")
    func duckAndRestoreExactly() async {
        let hal = FakeHAL(levels: [0: 0.6180339])
        let d = OutputDucker(backend: hal, markerURL: marker(), timing: fast)
        d.duck(to: 0.25)
        await settle(d)
        #expect(abs(hal.level(0) - 0.6180339 * 0.25) < 1e-6)
        d.restore()
        await settle(d)
        #expect(hal.level(0) == 0.6180339, "restored to \(hal.level(0))")
    }

    @Test("nothing playing, nothing touched")
    func silentDeviceUntouched() async {
        let hal = FakeHAL(levels: [0: 0.5], playing: false)
        let d = OutputDucker(backend: hal, markerURL: marker(), timing: fast)
        d.duck(to: 0.25)
        await settle(d)
        d.restore()
        await settle(d)
        #expect(hal.writeCount == 0)
        #expect(d.decision == "nothing playing")
    }

    @Test("a device with no master volume is ducked channel by channel")
    func perChannel() async {
        let hal = FakeHAL(levels: [1: 0.8, 2: 0.4])
        let d = OutputDucker(backend: hal, markerURL: marker(), timing: fast)
        d.duck(to: 0.5)
        await settle(d)
        #expect(abs(hal.level(1) - 0.4) < 1e-6 && abs(hal.level(2) - 0.2) < 1e-6)
        d.restore()
        await settle(d)
        #expect(hal.level(1) == 0.8 && hal.level(2) == 0.4, "the balance must come back too")
    }

    @Test("a volume the user sets during the hold is theirs, and is left alone")
    func userChangeWins() async {
        let hal = FakeHAL(levels: [0: 0.5])
        let d = OutputDucker(backend: hal, markerURL: marker(), timing: fast)
        d.duck(to: 0.25)
        await settle(d)
        hal.userSets(0, 0.9)
        d.restore()
        await settle(d)
        #expect(hal.level(0) == 0.9)
        #expect(d.decision == "left the user's volume alone")
    }

    @Test("releasing inside the start delay — a shortcut, not a dictation — never dips")
    func shortcutNeverDips() async {
        let hal = FakeHAL(levels: [0: 0.5])
        // A long delay and no sleep before the release: the parallel test run starves timers,
        // and this must be about ordering, not about the scheduler's mood.
        let d = OutputDucker(backend: hal, markerURL: marker(),
                             timing: .init(startDelay: .milliseconds(600), ramp: .milliseconds(20), steps: 4))
        d.duck(to: 0.25)
        d.restore()
        await settle(d, for: 900)
        #expect(hal.writeCount == 0)
        #expect(hal.level(0) == 0.5)
    }

    @Test("pressing again during the restore ramp goes back down from the same prior")
    func reDuckKeepsPrior() async {
        let hal = FakeHAL(levels: [0: 0.8])
        let d = OutputDucker(backend: hal, markerURL: marker(),
                             timing: .init(startDelay: .zero, ramp: .milliseconds(200), steps: 20))
        d.duck(to: 0.25)
        await settle(d, for: 300)
        d.restore()
        try? await Task.sleep(for: .milliseconds(60))       // part-way back up
        d.duck(to: 0.25)
        await settle(d, for: 300)
        #expect(abs(hal.level(0) - 0.2) < 1e-6, "re-ducked to \(hal.level(0))")
        d.restore()
        await settle(d, for: 300)
        #expect(hal.level(0) == 0.8)
    }

    @Test("a restore gives back the prior exactly, whatever level the ramp starts from")
    func restoreIsExact() async {
        // Ducked to 0.8 × 0.28 = 0.224, and `0.224 + (0.8 - 0.224)` is 0.8000001 in Float: the
        // arithmetic, not the scheduler, decided whether a restore was exact.
        let ducked: Float = 0.8 * 0.28
        #expect(ducked + (0.8 - ducked) != 0.8, "the level no longer exposes the rounding")
        let hal = FakeHAL(levels: [0: 0.8])
        let d = OutputDucker(backend: hal, markerURL: marker(),
                             timing: .init(startDelay: .zero, ramp: .milliseconds(10), steps: 1))
        d.duck(to: 0.28)
        await settle(d, for: 100)
        #expect(hal.level(0) == ducked)
        d.restore()
        await settle(d, for: 100)
        #expect(hal.level(0) == 0.8)
    }

    @Test("quitting mid-duck restores at once")
    func terminateRestores() async {
        let hal = FakeHAL(levels: [0: 0.7])
        let url = marker()
        let d = OutputDucker(backend: hal, markerURL: url, timing: fast)
        d.duck(to: 0.25)
        await settle(d)
        #expect(FileManager.default.fileExists(atPath: url.path), "no marker while ducked")
        d.restoreImmediately()
        #expect(hal.level(0) == 0.7)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test("a crash mid-duck is repaired by the next launch")
    func crashRecovery() async {
        let hal = FakeHAL(levels: [0: 0.7])
        let url = marker()
        do {
            let crashed = OutputDucker(backend: hal, markerURL: url, timing: fast)
            crashed.duck(to: 0.25)
            await settle(crashed)
            // …and the process dies here: no restore.
        }
        #expect(abs(hal.level(0) - 0.175) < 1e-6)
        let next = OutputDucker(backend: hal, markerURL: url, timing: fast)
        next.recoverFromCrash()
        #expect(hal.level(0) == 0.7)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test("a marker is not obeyed if the user has since set a volume")
    func staleMarkerIgnored() async {
        let hal = FakeHAL(levels: [0: 0.7])
        let url = marker()
        let crashed = OutputDucker(backend: hal, markerURL: url, timing: fast)
        crashed.duck(to: 0.25)
        await settle(crashed)
        hal.userSets(0, 0.4)
        OutputDucker(backend: hal, markerURL: url, timing: fast).recoverFromCrash()
        #expect(hal.level(0) == 0.4)
    }

    @Test("the inert handle does nothing at all")
    func inert() {
        // No backend to observe — the assertion is that this compiles to no HAL call and does
        // not crash. It is what every controller outside the app holds.
        PlaybackDucking.inert.duck(to: 0.1)
        PlaybackDucking.inert.restore()
        PlaybackDucking.inert.restoreImmediately()
        PlaybackDucking.inert.recoverFromCrash()
    }
}
#endif
