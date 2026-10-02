import Foundation
import Testing
#if os(macOS)
import CoreAudio
#endif

@testable import KotibaAudio
@testable import KotibaCore

// The capture path with the render thread replaced by a test thread, and nothing else replaced.
//
// The defect: `MicrophoneSource(bufferSeconds: 120)` rounded its ring to 2²³ samples, which at a
// 48 kHz device is 174.76 s, and the longest recording in the owner's diagnostics is exactly
// 174.7626875 s. Everything past it was dropped. These tests run ten minutes through the real
// ring, the real consumer and the real resampler and count every sample.

/// Writes `total` samples into the ring the way the render thread does — fixed-size quanta,
/// never blocking — except that it waits for room instead of dropping, which is what a consumer
/// that keeps up looks like from the producer's side. `value(i)` makes each sample identifiable.
private func produce(into ring: AudioRingBuffer, total: Int, quantum: Int = 512,
                     value: (Int) -> Float) {
    var block = [Float](repeating: 0, count: quantum)
    var written = 0
    while written < total {
        let n = min(quantum, total - written)
        for i in 0..<n { block[i] = value(written + i) }
        while ring.capacity - ring.available < n { usleep(200) }
        _ = block.withUnsafeBufferPointer { ring.write(UnsafeBufferPointer(rebasing: $0[0..<n])) }
        written += n
    }
}

@Suite("Capture has no length limit")
struct CapturePipelineTests {

    @Test("ten minutes at 16 kHz arrive exactly — nothing lost, nothing duplicated, in order")
    func tenMinutesExact() async throws {
        let pipeline = CapturePipeline(ringSeconds: 1, maxHardwareRate: 16_000,
                                       pumpInterval: .milliseconds(1))
        let total = 16_000 * 600                          // 9.6 M: every value exact in Float32
        let (stream, continuation) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .unbounded)
        try pipeline.begin(take: 1, sourceRate: 16_000, continuation: continuation)

        // A real second thread, racing the consumer's timer, as the render thread would.
        let producer = Thread {
            produce(into: pipeline.ring, total: total) { Float($0) }
        }
        producer.start()
        while !producer.isFinished { try await Task.sleep(for: .milliseconds(5)) }

        let result = pipeline.end(take: 1)
        let samples = result.buffer.samples
        #expect(samples.count == total, "got \(samples.count) of \(total)")
        #expect(result.buffer.droppedSamples == 0)
        #expect(!result.reachedLimit)
        let firstWrong = samples.indices.first { samples[$0] != Float($0) }
        #expect(firstWrong == nil, "sample \(firstWrong ?? -1) is out of place")

        // The stream carried the same audio, in the same order, while it was being captured.
        var streamed: [Float] = []
        streamed.reserveCapacity(total)
        for await chunk in stream { streamed.append(contentsOf: chunk) }
        #expect(streamed == samples)
    }

    @Test("ten minutes at 48 kHz come out as ten minutes at 16 kHz, with nothing dropped")
    func tenMinutesResampled() async throws {
        let pipeline = CapturePipeline(ringSeconds: 1, maxHardwareRate: 48_000,
                                       pumpInterval: .milliseconds(1))
        let total = 48_000 * 600
        try pipeline.begin(take: 7, sourceRate: 48_000)
        let producer = Thread {
            // 440 Hz, well inside the passband, so the output can be checked for level too.
            produce(into: pipeline.ring, total: total) { sinf(Float($0) * 2 * .pi * 440 / 48_000) * 0.5 }
        }
        producer.start()
        while !producer.isFinished { try await Task.sleep(for: .milliseconds(5)) }

        let result = pipeline.end(take: 7)
        // The converter's filter holds a few samples back until the stream ends; `end` flushes
        // them, so the count is the exact ratio give or take the edge.
        #expect(abs(result.buffer.samples.count - total / 3) <= 2,
                "got \(result.buffer.samples.count), expected \(total / 3)")
        #expect(result.buffer.droppedSamples == 0)
        let tail = result.buffer.samples.suffix(16_000)
        let peak = tail.map(abs).max() ?? 0
        #expect(abs(peak - 0.5) < 0.01, "the last second came out at peak \(peak)")
    }

    @Test("chunking does not change the resampled audio")
    func chunkedEqualsWhole() throws {
        let input: [Float] = (0..<48_000 * 5).map { (i: Int) -> Float in
            let t = Float(i)
            let low: Float = sinf(t * 0.013) * 0.3
            let high: Float = sinf(t * 0.41) * 0.2
            return low + high
        }
        let whole = try StreamingResampler(sourceRate: 48_000)
        var expected = try input.withUnsafeBufferPointer { try whole.process($0) }
        expected += try whole.finish()

        let chunked = try StreamingResampler(sourceRate: 48_000)
        var got: [Float] = []
        var offset = 0
        var sizes = [441, 960, 17, 4800, 1, 2048]           // render quanta vary; so do stalls
        while offset < input.count {
            let n = min(sizes[0], input.count - offset)
            sizes.append(sizes.removeFirst())
            got += try input[offset..<offset + n].withUnsafeBufferPointer { try chunked.process($0) }
            offset += n
        }
        got += try chunked.finish()

        #expect(got.count == expected.count)
        let worst = zip(got, expected).map { abs($0 - $1) }.max() ?? 0
        #expect(worst < 1e-5, "chunked output differs by up to \(worst)")
    }

    // The quality measurement the old `resampleTo16k` comment quoted, re-run through the streaming
    // path so the Mastering setting cannot silently go missing.
    @Test("speech band intact and the alias band rejected at 48 kHz → 16 kHz")
    func frequencyResponse() throws {
        func rms(_ x: ArraySlice<Float>) -> Float { sqrtf(x.reduce(0) { $0 + $1 * $1 } / Float(x.count)) }
        func throughput(_ hz: Float) throws -> Float {
            let input = (0..<48_000).map { sinf(Float($0) * 2 * .pi * hz / 48_000) }
            let r = try StreamingResampler(sourceRate: 48_000)
            let out = try input.withUnsafeBufferPointer { try r.process($0) } + (try r.finish())
            return 20 * log10f(rms(out[2000..<14_000]) / rms(input[6000..<42_000]))
        }
        #expect(abs(try throughput(6_000)) < 0.1)
        #expect(try throughput(8_500) < -55)
    }

    @Test("a new take seals the open one at that sample — the seam loses and shares nothing")
    func overlappingTakes() throws {
        let pipeline = CapturePipeline(ringSeconds: 1, maxHardwareRate: 16_000,
                                       pumpInterval: .seconds(3600))    // pumped by hand
        try pipeline.begin(take: 1, sourceRate: 16_000)
        pipeline.ring.write((0..<3000).map(Float.init))
        // Take 2 opens before take 1's owner has called stop — the second key-down.
        try pipeline.begin(take: 2, sourceRate: 16_000)
        pipeline.ring.write((3000..<5000).map(Float.init))
        pipeline.pump()

        let first = pipeline.end(take: 1)
        let second = pipeline.end(take: 2)
        #expect(first.buffer.samples == (0..<3000).map(Float.init))
        #expect(second.buffer.samples == (3000..<5000).map(Float.init))
        #expect(!pipeline.hasOpenTake)
        // Collected once; a second collection is empty rather than a replay.
        #expect(pipeline.end(take: 1).buffer.samples.isEmpty)
    }

    @Test("the ceiling is reported, once, and keeps everything up to it")
    func ceilingIsAnnounced() throws {
        let pipeline = CapturePipeline(ringSeconds: 1, maxHardwareRate: 16_000,
                                       ceilingSeconds: 0.5, pumpInterval: .seconds(3600))
        final class Count: @unchecked Sendable { var n = 0 }
        let count = Count()
        try pipeline.begin(take: 3, sourceRate: 16_000, onLimit: { count.n += 1 })
        for _ in 0..<4 {
            pipeline.ring.write([Float](repeating: 0.1, count: 4000))
            pipeline.pump()
        }
        let result = pipeline.end(take: 3)
        #expect(result.reachedLimit)
        #expect(count.n == 1)
        #expect(result.buffer.samples.count == 8000)
        // Past the ceiling is a stated limit, not a capture fault; it must not read as one.
        #expect(result.buffer.droppedSamples == 0)
    }

    @Test("a consumer that falls behind still says how much was lost, at the 16 kHz scale")
    func overflowIsCounted() throws {
        let pipeline = CapturePipeline(ringSeconds: 0.1, maxHardwareRate: 48_000,
                                       pumpInterval: .seconds(3600))
        try pipeline.begin(take: 4, sourceRate: 48_000)
        let capacity = pipeline.ring.capacity
        pipeline.ring.write([Float](repeating: 0, count: capacity + 4800))
        let result = pipeline.end(take: 4)
        #expect(result.buffer.droppedSamples == 1600)       // 4800 at 48 kHz
    }

    @Test("the block store joins back exactly across its block boundaries")
    func sampleChunks() {
        var store = SampleChunks()
        var expected: [Float] = []
        var next: Float = 0
        for size in [1, SampleChunks.blockSize - 1, 5, SampleChunks.blockSize * 2 + 3, 0, 7] {
            let piece = (0..<size).map { _ in defer { next += 1 }; return next }
            store.append(piece)
            expected += piece
        }
        #expect(store.count == expected.count)
        #expect(store.joined() == expected)
    }
}

#if os(macOS)
@Suite("Which microphone, with a Bluetooth headset connected")
struct InputRouteTests {
    @Test("a Bluetooth default input is swapped for the built-in microphone")
    func swapsBluetooth() {
        #expect(InputRoute.preferredDevice(defaultInput: 90, defaultIsBluetooth: true,
                                           builtIn: 70, preferBuiltInWithBluetooth: true) == 70)
    }

    @Test("everything else follows the system default")
    func followsDefault() {
        // Not Bluetooth: the user's choice stands, whatever it is.
        #expect(InputRoute.preferredDevice(defaultInput: 90, defaultIsBluetooth: false,
                                           builtIn: 70, preferBuiltInWithBluetooth: true) == nil)
        // Switched off: the headset mic is what they asked for.
        #expect(InputRoute.preferredDevice(defaultInput: 90, defaultIsBluetooth: true,
                                           builtIn: 70, preferBuiltInWithBluetooth: false) == nil)
        // A Mac mini has no built-in microphone to prefer.
        #expect(InputRoute.preferredDevice(defaultInput: 90, defaultIsBluetooth: true,
                                           builtIn: nil, preferBuiltInWithBluetooth: true) == nil)
    }
}
#endif

#if os(macOS)
/// A machine with whatever inputs a test says it has. The default input is mutable, as the user's
/// System Settings choice is.
final class FakeInputs: InputDeviceDirectory, @unchecked Sendable {
    struct Device { let name: String; let transport: UInt32 }
    var table: [AudioDeviceID: Device]
    var defaultInput: AudioDeviceID?
    init(_ table: [AudioDeviceID: Device], default: AudioDeviceID?) {
        self.table = table
        defaultInput = `default`
    }
    var builtInInput: AudioDeviceID? {
        table.first { $0.value.transport == kAudioDeviceTransportTypeBuiltIn }?.key
    }
    func name(_ device: AudioDeviceID) -> String { table[device]?.name ?? "?" }
    func transportCode(_ device: AudioDeviceID) -> UInt32 { table[device]?.transport ?? 0 }

    static let builtIn: AudioDeviceID = 70, usbHeadset: AudioDeviceID = 80, airPods: AudioDeviceID = 90
    static func laptop(default: AudioDeviceID) -> FakeInputs {
        FakeInputs([builtIn: Device(name: "MacBook Pro Microphone",
                                    transport: kAudioDeviceTransportTypeBuiltIn),
                    usbHeadset: Device(name: "Gaming Headset", transport: kAudioDeviceTransportTypeUSB),
                    airPods: Device(name: "AirPods", transport: kAudioDeviceTransportTypeBluetooth)],
                   default: `default`)
    }
}

/// The routing decision `MicrophoneSource` makes at every arming, driven through the same
/// functions with fake devices, and checked against the diagnostics record a take carries.
@Suite("The microphone selected in the system is the one recorded")
struct FollowDefaultInputTests {
    /// What `MicrophoneSource.routeChanged` + `prepareGraph` do at a press, minus the engine:
    /// resolve, decide whether to rebind, and write down the take's device.
    struct Arming {
        var bound: AudioDeviceID?
        var stale = false
        mutating func press(_ devices: FakeInputs, preferBuiltIn: Bool,
                            unitReports: AudioDeviceID? = nil) -> (rebound: Bool, take: InputDeviceInfo?) {
            let route = InputRoute.resolve(preferBuiltInWithBluetooth: preferBuiltIn, devices: devices)
            let rebind = InputRoute.needsRebind(target: route.device, bound: bound,
                                                unitReports: unitReports ?? bound, stale: stale)
            if rebind { bound = route.device; stale = false }
            return (rebind, bound.map { devices.inputInfo($0, sampleRate: 48_000,
                                                           overrodeDefault: route.overrode) })
        }
    }

    @Test("a default changed while idle is the device the next take records from")
    func defaultChangeWhileIdle() {
        let machine = FakeInputs.laptop(default: FakeInputs.builtIn)
        var arming = Arming()
        let first = arming.press(machine, preferBuiltIn: false)
        #expect(first.take?.transport == .builtIn)
        // Idle, same format, warm graph — the user picks the headset in System Settings.
        machine.defaultInput = FakeInputs.usbHeadset
        let second = arming.press(machine, preferBuiltIn: false)
        #expect(second.rebound)
        #expect(second.take == InputDeviceInfo(name: "Gaming Headset", transport: .usb,
                                               sampleRate: 48_000, overrodeDefault: false))
        // And nothing is rebuilt when nothing moved.
        #expect(!arming.press(machine, preferBuiltIn: false).rebound)
    }

    @Test("with the switch off (the default), a Bluetooth default input is recorded from")
    func bluetoothFollowedByDefault() {
        let machine = FakeInputs.laptop(default: FakeInputs.airPods)
        var arming = Arming()
        let take = arming.press(machine, preferBuiltIn: false).take
        #expect(take?.name == "AirPods")
        #expect(take?.transport == .bluetooth)
        #expect(take?.overrodeDefault == false)
    }

    @Test("with the switch on, a Bluetooth default input is swapped for the built-in mic")
    func bluetoothSwappedWhenOptedIn() {
        let machine = FakeInputs.laptop(default: FakeInputs.airPods)
        var arming = Arming()
        let take = arming.press(machine, preferBuiltIn: true).take
        #expect(take?.transport == .builtIn)
        #expect(take?.overrodeDefault == true)
        // The switch never touches a non-Bluetooth choice.
        machine.defaultInput = FakeInputs.usbHeadset
        #expect(arming.press(machine, preferBuiltIn: true).take?.name == "Gaming Headset")
    }

    @Test("an input unit that drifted off the bound device, or a heard change, forces a rebind")
    func driftAndStaleRebind() {
        #expect(InputRoute.needsRebind(target: 80, bound: 80, unitReports: 70, stale: false))
        #expect(InputRoute.needsRebind(target: 80, bound: 80, unitReports: 80, stale: true))
        #expect(!InputRoute.needsRebind(target: 80, bound: 80, unitReports: 80, stale: false))
        // No graph to ask: the bound ID is all there is.
        #expect(!InputRoute.needsRebind(target: 80, bound: 80, unitReports: nil, stale: false))
        #expect(InputRoute.needsRebind(target: 80, bound: nil, unitReports: nil, stale: false))
    }

    /// What `MicrophoneSource.noteConfigurationChange` decides when the live engine posts, minus
    /// the engine: re-resolve the route against the (fake) machine, compare the input unit and
    /// the hardware format with what the graph was built on, and look at whether the engine kept
    /// running under an open take.
    struct Graph {
        var bound: AudioDeviceID?
        var format = (rate: 48_000.0, channels: 1)
        var takeRunning = false
        func isNews(_ devices: FakeInputs, preferBuiltIn: Bool = false,
                    unitReports: AudioDeviceID? = nil, formatNow: (rate: Double, channels: Int)? = nil,
                    engineRunning: Bool? = nil, heardHAL: Bool = false) -> Bool {
            let route = InputRoute.resolve(preferBuiltInWithBluetooth: preferBuiltIn, devices: devices)
            let moved = InputRoute.needsRebind(target: route.device, bound: bound,
                                               unitReports: unitReports ?? bound, stale: heardHAL)
            let now = formatNow ?? format
            return InputRoute.configurationChangeIsNews(
                routeChanged: moved, formatUnchanged: now == format,
                takeRunning: takeRunning, engineRunning: engineRunning ?? takeRunning)
        }
    }

    @Test("a configuration change our own start posted — nothing moved — keeps the warm graph")
    func selfCausedChangeIgnored() {
        // The measured case: built-in mic, default untouched, the engine posts ~50 ms after its
        // start and is still running on the same device in the same 48 kHz mono format.
        let machine = FakeInputs.laptop(default: FakeInputs.builtIn)
        var graph = Graph(bound: FakeInputs.builtIn, takeRunning: true)
        #expect(!graph.isNews(machine))
        // The same post arriving after the release, the engine stopped by us: still nothing.
        graph.takeRunning = false
        #expect(!graph.isNews(machine, engineRunning: false))
        // With the Bluetooth switch on and AirPods as the default, the graph is on the built-in
        // microphone by Kotiba's own choice — that is not a moved route either.
        let headset = FakeInputs.laptop(default: FakeInputs.airPods)
        #expect(!Graph(bound: FakeInputs.builtIn).isNews(headset, preferBuiltIn: true))
    }

    @Test("a real default-input change, format change or engine stop is still honoured")
    func realChangeHonoured() {
        let machine = FakeInputs.laptop(default: FakeInputs.builtIn)
        let graph = Graph(bound: FakeInputs.builtIn, takeRunning: true)
        // The user picks the USB headset — same 48 kHz mono, so only the route says so.
        machine.defaultInput = FakeInputs.usbHeadset
        #expect(graph.isNews(machine))
        machine.defaultInput = FakeInputs.builtIn
        // Same device, the hardware moved to 44.1 kHz stereo under the connection.
        #expect(graph.isNews(machine, formatNow: (44_100, 2)))
        // The engine stopped itself under an open take: its I/O is gone.
        #expect(graph.isNews(machine, engineRunning: false))
        // The unit drifted off the bound device (VoiceInk #956), or the HAL listener heard the
        // default move before this post arrived.
        #expect(graph.isNews(machine, unitReports: FakeInputs.usbHeadset))
        #expect(graph.isNews(machine, heardHAL: true))
        // And with nothing moved, the same graph is not news — the two tests agree on the line.
        #expect(!graph.isNews(machine))
    }
}
#endif

#if os(macOS)
@Suite("Input device classification (no hardware)")
struct InputTransportTests {
    @Test("CoreAudio transport codes map to the diagnostics vocabulary")
    func codes() {
        let cases: [(UInt32, String, InputTransport)] = [
            (kAudioDeviceTransportTypeBuiltIn, "MacBook Pro Microphone", .builtIn),
            (kAudioDeviceTransportTypeBluetooth, "AirPods", .bluetooth),
            (kAudioDeviceTransportTypeBluetoothLE, "Headset", .bluetooth),
            (kAudioDeviceTransportTypeUSB, "Blue Yeti", .usb),
            (kAudioDeviceTransportTypeContinuityCaptureWired, "Test iPhone Microphone", .continuity),
            (kAudioDeviceTransportTypeContinuityCaptureWireless, "Test iPhone Microphone", .continuity),
            (kAudioDeviceTransportTypeVirtual, "Loopback", .virtual),
            (kAudioDeviceTransportTypeAggregate, "Aggregate Device", .virtual),
            (kAudioDeviceTransportTypeThunderbolt, "Dock", .other),
            (0, "mystery", .other),
            // A phone that did not announce itself by transport is still caught by name.
            (kAudioDeviceTransportTypeUSB, "Test iPhone Microphone", .continuity),
        ]
        for (code, name, expected) in cases {
            #expect(AudioDevices.inputTransport(code: code, name: name) == expected, "\(name)")
        }
    }
}
#endif
