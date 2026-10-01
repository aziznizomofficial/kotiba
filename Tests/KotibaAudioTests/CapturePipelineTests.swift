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
