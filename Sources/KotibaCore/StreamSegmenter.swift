import Foundation

// Where a streaming engine may cut the recording while the user is still speaking.
//
// Parakeet reads audio in fixed 15 s windows: anything up to 15 s costs one encoder pass
// (~100 ms on the M4 Pro's Neural Engine), and longer audio costs one pass per window plus a
// stitch between them. So the cheapest possible key-release is one where at most one window is
// left undecoded — which means that during a long hold, every time 14 s has piled up, some of it
// has to be decoded and *committed*.
//
// The only question is where to cut, and the answer is: in the quietest stretch available. A cut
// through a word loses the word on both sides; a cut through a breath loses nothing. So this
// searches the part of the pending audio between `earliestCut` and `commitAfter` for the
// lowest-energy `quietRun` and cuts at its middle. It never looks past `commitAfter`, so the
// committed stretch always fits one window.
//
// Pure arithmetic over samples, no platform types — it lives in KotibaCore so the policy is
// tested in Band 1 with synthetic audio rather than inferred from a model's output.

public struct StreamSegmenter: Sendable, Equatable {
    public var sampleRate: Int
    /// Commit once this many seconds are pending. Below 15 so the committed stretch is exactly
    /// one Parakeet window, with a margin for the window's own edge handling.
    public var commitAfter: Double
    /// Never cut before this far into the pending audio: a committed stretch has to be long
    /// enough to carry its own context, and cutting at 1 s would decode a window for 1 s of speech.
    public var earliestCut: Double
    /// Energy is measured over frames this long.
    public var frame: Double
    /// The width of the quiet stretch looked for. 200 ms is shorter than any sentence pause and
    /// longer than the gaps inside a word, which is the distinction that matters.
    public var quietRun: Double

    public init(sampleRate: Int = AudioBuffer.sampleRate, commitAfter: Double = 14,
                earliestCut: Double = 6, frame: Double = 0.02, quietRun: Double = 0.2) {
        self.sampleRate = sampleRate
        self.commitAfter = commitAfter
        self.earliestCut = earliestCut
        self.frame = frame
        self.quietRun = quietRun
    }

    /// Where to cut `pending`, as an offset from its start — or nil while it is shorter than
    /// `commitAfter` and nothing needs committing yet.
    public func cut<C: RandomAccessCollection>(_ pending: C) -> Int?
    where C.Element == Float, C.Index == Int {
        let limit = Int(commitAfter * Double(sampleRate))
        guard pending.count >= limit else { return nil }

        let frameLength = max(1, Int(frame * Double(sampleRate)))
        let first = Int(earliestCut * Double(sampleRate)) / frameLength
        let last = limit / frameLength                       // exclusive
        let run = max(1, Int((quietRun / frame).rounded()))
        guard last - first >= run else { return first * frameLength }

        // Mean square per frame across the search range.
        var energy = [Double](repeating: 0, count: last - first)
        let base = pending.startIndex
        for index in 0..<energy.count {
            let start = base + (first + index) * frameLength
            var sum = 0.0
            for offset in 0..<frameLength {
                let sample = Double(pending[start + offset])
                sum += sample * sample
            }
            energy[index] = sum / Double(frameLength)
        }

        // Sliding sum over `run` frames; the quietest window wins, and on a tie the *latest* one,
        // so the committed stretch is as long as it can be and the remainder as short.
        var window = energy[0..<run].reduce(0, +)
        var best = window
        var bestStart = 0
        for start in 1...(energy.count - run) {
            window += energy[start + run - 1] - energy[start - 1]
            if window <= best {
                best = window
                bestStart = start
            }
        }
        return (first + bestStart + run / 2) * frameLength
    }
}
