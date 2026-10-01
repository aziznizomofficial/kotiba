import Synchronization

// What the HUD's bars are made of.
//
// The ring buffer cannot answer "how loud is it right now": it is single-producer,
// single-consumer, and reading it to draw a meter would consume the samples the transcription
// needs. So the render callback publishes a peak here as it passes, and the UI polls it.
//
// `Atomic<UInt32>` holding a bit pattern rather than a plain `var Float`, because a benign race
// is still a data race under Swift 6 and this is the one place a lock is genuinely forbidden —
// the writer is a Core Audio render thread. A relaxed atomic store costs nothing there.

public final class LevelMeter: Sendable {

    private let bits = Atomic<UInt32>(0)

    public init() {}

    /// Called on the real-time thread. No allocation, no locks, no waiting.
    @inline(__always)
    public func publish(_ samples: UnsafePointer<Float>, count: Int) {
        var peak: Float = 0
        for index in 0..<count {
            let magnitude = abs(samples[index])
            if magnitude > peak { peak = magnitude }
        }
        // Decay towards the new value rather than replacing it, so a 50 ms poll cannot land
        // between syllables and render silence in the middle of a sentence.
        let previous = Float(bitPattern: bits.load(ordering: .relaxed))
        let smoothed = peak > previous ? peak : previous * 0.8 + peak * 0.2
        bits.store(smoothed.bitPattern, ordering: .relaxed)
    }

    /// 0…1. Read from anywhere.
    public var level: Float {
        min(1, max(0, Float(bitPattern: bits.load(ordering: .relaxed))))
    }

    public func reset() {
        bits.store(Float(0).bitPattern, ordering: .relaxed)
    }
}
