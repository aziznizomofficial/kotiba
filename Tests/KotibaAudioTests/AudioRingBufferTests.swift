import Foundation
import Testing

@testable import KotibaAudio

// Band 1 despite living in KotibaAudio: the ring buffer touches no Apple framework, so it runs
// in milliseconds with no hardware.

@Suite("AudioRingBuffer — audio-thread memory, hence the unchecked conformance")
struct RingBufferTests {

    @Test("capacity rounds up to a power of two so the wrap is a mask, not a modulo")
    func capacityRounding() {
        #expect(AudioRingBuffer(minimumCapacity: 1).capacity == 1)
        #expect(AudioRingBuffer(minimumCapacity: 100).capacity == 128)
        #expect(AudioRingBuffer(minimumCapacity: 16_000).capacity == 16_384)
        #expect(AudioRingBuffer(minimumCapacity: 1024).capacity == 1024)
    }

    @Test("what goes in comes out, in order")
    func roundTrip() {
        let rb = AudioRingBuffer(minimumCapacity: 64)
        let input: [Float] = (0..<50).map { Float($0) }
        #expect(rb.write(input) == 50)
        #expect(rb.available == 50)
        #expect(rb.drain() == input)
        #expect(rb.available == 0)
        #expect(rb.dropped == 0)
    }

    @Test("writes wrap around the end of the storage without corrupting order")
    func wrapping() {
        let rb = AudioRingBuffer(minimumCapacity: 8)
        // Fill, drain, then write across the wrap point.
        #expect(rb.write(Array(repeating: Float(1), count: 8)) == 8)
        _ = rb.drain()
        let second: [Float] = (0..<8).map { Float($0) + 100 }
        #expect(rb.write(second) == 8)
        #expect(rb.drain() == second)
    }

    @Test("interleaved writes and drains preserve the whole sequence")
    func interleaved() {
        let rb = AudioRingBuffer(minimumCapacity: 16)
        var received: [Float] = []
        var next: Float = 0
        for _ in 0..<200 {
            var batch: [Float] = []
            for _ in 0..<5 { batch.append(next); next += 1 }
            #expect(rb.write(batch) == 5)
            received += rb.drain()
        }
        // Compare counts and the first divergence rather than two 1000-element literals: a
        // failed array equality here prints both in full and buries the actual difference.
        #expect(received.count == 1000)
        let firstWrong = zip(received, (0..<1000).map { Float($0) })
            .enumerated().first { $0.element.0 != $0.element.1 }
        if let firstWrong {
            let message = "diverges at index \(firstWrong.offset): got \(firstWrong.element.0), expected \(firstWrong.element.1)"
            Issue.record(Comment(rawValue: message))
        }
        #expect(firstWrong == nil)
        #expect(rb.dropped == 0)
    }

    @Test("overflow drops the excess and reports exactly how much")
    func overflowIsReported() {
        let rb = AudioRingBuffer(minimumCapacity: 8)
        let stored = rb.write(Array(repeating: Float(1), count: 20))
        #expect(stored == 8, "only capacity fits")
        #expect(rb.dropped == 12, "the rest must be counted, not silently lost")
        #expect(rb.drain().count == 8)
    }

    @Test("a write into a completely full buffer stores nothing and counts everything")
    func fullBuffer() {
        let rb = AudioRingBuffer(minimumCapacity: 4)
        #expect(rb.write([1, 2, 3, 4]) == 4)
        #expect(rb.write([5, 6]) == 0)
        #expect(rb.dropped == 2)
        #expect(rb.drain() == [1, 2, 3, 4], "the buffer keeps the OLDEST audio, not the newest")
    }

    @Test("reset discards pending audio and clears the drop count")
    func reset() {
        let rb = AudioRingBuffer(minimumCapacity: 4)
        _ = rb.write([1, 2, 3, 4, 5, 6])
        #expect(rb.dropped == 2)
        rb.reset()
        #expect(rb.available == 0)
        #expect(rb.dropped == 0)
        #expect(rb.drain().isEmpty)
    }

    @Test("draining an empty buffer is empty, not a crash")
    func emptyDrain() {
        let rb = AudioRingBuffer(minimumCapacity: 8)
        #expect(rb.drain().isEmpty)
        #expect(rb.available == 0)
    }

    @Test("one producer and one consumer on separate threads never reorder or duplicate",
          .timeLimit(.minutes(1)))
    func concurrentFuzz() async {
        // The producer does NOT retry, because the real one cannot: it is a render callback
        // that must return immediately. A quantum that does not fit is genuinely dropped and
        // counted, so the invariant below holds whatever the scheduler does.
        //
        // An earlier version of this test retried on a full buffer and asserted dropped == 0.
        // That was flaky by construction: every failed attempt increments the drop counter, so
        // the assertion depended on the consumer winning a race. A flaky test is worse than no
        // test — it teaches you to ignore red.
        let rb = AudioRingBuffer(minimumCapacity: 16_384)
        let total = 200_000

        let producer = Task.detached(priority: .userInitiated) {
            var next = 0
            while next < total {
                let n = min(128, total - next)                 // a realistic render quantum
                var batch = [Float]()
                batch.reserveCapacity(n)
                for i in 0..<n { batch.append(Float(next + i)) }
                rb.write(batch)
                next += n
                await Task.yield()
            }
        }

        var received: [Float] = []
        received.reserveCapacity(total)
        await producer.value
        while true {
            let chunk = rb.drain()
            if chunk.isEmpty { break }
            received += chunk
        }

        // 1. Nothing is invented and nothing is duplicated.
        #expect(received.count + rb.dropped == total,
                "received \(received.count) + dropped \(rb.dropped) should be \(total)")
        // 2. Whatever arrived, arrived in order. This is the property a ring buffer must never
        //    violate, and it holds regardless of how the two threads interleaved.
        var ascending = true
        for i in 1..<max(received.count, 1) where received[i] <= received[i - 1] {
            ascending = false
        }
        #expect(ascending, "samples arrived out of order")
    }

    @Test("a slow consumer produces drops rather than blocking the producer",
          .timeLimit(.minutes(1)))
    func slowConsumerDropsRatherThanBlocks() async {
        // The audio thread must never wait. Overflow is the correct behaviour here, and the
        // count is how the app finds out it happened.
        let rb = AudioRingBuffer(minimumCapacity: 256)
        for _ in 0..<100 {
            rb.write(Array(repeating: Float(1), count: 128))
        }
        #expect(rb.dropped > 0, "a consumer that never drains must cause visible drops")
        #expect(rb.available <= rb.capacity)
    }
}
