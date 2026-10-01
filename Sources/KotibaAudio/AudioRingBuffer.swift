import Synchronization

// Task A-02. Single-producer, single-consumer, lock-free.
//
// This file holds the audio-thread uses of `@unchecked Sendable` — the ring buffer, the scratch
// block and the channel table below, all of which are memory the render callback writes into.
//
// They are not the only ones in the codebase. The others are `WhisperContext` and
// `HistoryStore.Handle`, and both exist for a different reason: they own a C pointer that must
// be freed exactly once, on the last reference. Anywhere the annotation appears for any third
// reason is a bug. The reason it is needed *here* is that the producer is a
// Core Audio render callback: a real-time thread that must never allocate, never take a lock, never call into
// Objective-C and never wait. Anything that blocks it produces an audible glitch, and the
// compiler has no way to express "this is safe because exactly one thread writes and exactly
// one reads".
//
// Three properties are load-bearing:
//
//   1. **No allocation after init.** Storage is claimed once. `write` touches only preallocated
//      memory and two atomics.
//   2. **Overflow drops and says so.** A full buffer discards the incoming samples and counts
//      them. It must never block the audio thread, and it must never lose the *fact* that it
//      lost data — a silently short recording is exactly the class of failure this project
//      keeps being bitten by.
//   3. **The reader never sees a partial write.** The write index is published with release
//      ordering after the samples land, and read with acquire ordering before they are taken.

public final class AudioRingBuffer: @unchecked Sendable {

    private let storage: UnsafeMutableBufferPointer<Float>
    private let mask: Int

    /// Total samples ever written. Monotonic; wraps only at Int.max, which at 16 kHz is
    /// roughly eighteen million years.
    private let writeIndex = Atomic<Int>(0)
    private let readIndex = Atomic<Int>(0)
    private let droppedCount = Atomic<Int>(0)

    /// Capacity is rounded up to a power of two so the wrap is a mask rather than a modulo —
    /// integer division on the audio thread is not worth the elegance.
    public init(minimumCapacity: Int) {
        precondition(minimumCapacity > 0, "a ring buffer needs room for at least one sample")
        var capacity = 1
        while capacity < minimumCapacity { capacity <<= 1 }
        storage = UnsafeMutableBufferPointer<Float>.allocate(capacity: capacity)
        storage.initialize(repeating: 0)
        mask = capacity - 1
    }

    deinit {
        storage.deinitialize()
        storage.deallocate()
    }

    public var capacity: Int { storage.count }

    /// Samples written but not yet read.
    public var available: Int {
        writeIndex.load(ordering: .acquiring) - readIndex.load(ordering: .acquiring)
    }

    /// Samples discarded because the consumer fell behind. Never resets on its own; a non-zero
    /// value here is what a diagnostics record reports rather than quietly delivering a short
    /// recording.
    public var dropped: Int { droppedCount.load(ordering: .relaxed) }

    // MARK: Producer — audio render thread only

    /// Append samples. Returns the number actually stored; anything less means the rest were
    /// dropped, and `dropped` has been incremented by the difference.
    ///
    /// Callable only from the single producer. No allocation, no locks, no waiting.
    @discardableResult
    public func write(_ samples: UnsafeBufferPointer<Float>) -> Int {
        let w = writeIndex.load(ordering: .relaxed)          // only this thread writes it
        let r = readIndex.load(ordering: .acquiring)
        let room = storage.count - (w - r)
        guard room > 0 else {
            droppedCount.wrappingAdd(samples.count, ordering: .relaxed)
            return 0
        }
        let take = min(room, samples.count)
        for i in 0..<take {
            storage[(w &+ i) & mask] = samples[i]
        }
        writeIndex.store(w &+ take, ordering: .releasing)     // publish after the data lands
        if take < samples.count {
            droppedCount.wrappingAdd(samples.count - take, ordering: .relaxed)
        }
        return take
    }

    @discardableResult
    public func write(_ samples: [Float]) -> Int {
        samples.withUnsafeBufferPointer { write($0) }
    }

    // MARK: Consumer

    /// Take everything currently available.
    public func drain() -> [Float] {
        let w = writeIndex.load(ordering: .acquiring)
        let r = readIndex.load(ordering: .relaxed)            // only this thread writes it
        let count = w - r
        guard count > 0 else { return [] }
        var out = [Float]()
        out.reserveCapacity(count)
        for i in 0..<count {
            out.append(storage[(r &+ i) & mask])
        }
        readIndex.store(w, ordering: .releasing)
        return out
    }

    /// Discard everything and reset the drop counter. Called between dictations, never during.
    public func reset() {
        let w = writeIndex.load(ordering: .acquiring)
        readIndex.store(w, ordering: .releasing)
        droppedCount.store(0, ordering: .relaxed)
    }
}


/// A preallocated block the render callback downmixes into before handing samples to the ring
/// buffer. Same justification as the buffer above, and it lives here rather than inside
/// `MicrophoneSource` for a concrete reason: an actor's `deinit` is nonisolated and may not
/// touch a non-Sendable stored property, so the allocation needs an owner that can free it.
public final class RealtimeScratch: @unchecked Sendable {
    public let storage: UnsafeMutableBufferPointer<Float>

    public init(capacity: Int) {
        storage = UnsafeMutableBufferPointer<Float>.allocate(capacity: capacity)
        storage.initialize(repeating: 0)
    }

    deinit {
        storage.deinitialize()
        storage.deallocate()
    }

    public var count: Int { storage.count }
    public var base: UnsafeMutablePointer<Float> { storage.baseAddress! }
}

/// Preallocated room for one channel-pointer table, for exactly the same reason as
/// `RealtimeScratch`: the render callback needs somewhere to stage the pointers it reads out of
/// the `AudioBufferList`, and building a Swift `Array` there is a malloc on the audio thread.
///
/// Sized for far more channels than any real input device has; a device with more is truncated
/// rather than allowed to write past the end.
public final class ChannelTable: @unchecked Sendable {
    private let storage: UnsafeMutableBufferPointer<UnsafeMutablePointer<Float>?>

    public init(capacity: Int = 32) {
        storage = UnsafeMutableBufferPointer<UnsafeMutablePointer<Float>?>
            .allocate(capacity: capacity)
        storage.initialize(repeating: nil)
    }

    deinit {
        storage.deinitialize()
        storage.deallocate()
    }

    public var capacity: Int { storage.count }

    /// Non-optional, because `Downmix.toMono` takes a buffer of plain pointers and the callback
    /// fills every slot it declares before reading any of them.
    public var base: UnsafeMutablePointer<UnsafeMutablePointer<Float>> {
        UnsafeMutableRawPointer(storage.baseAddress!)
            .assumingMemoryBound(to: UnsafeMutablePointer<Float>.self)
    }
}
