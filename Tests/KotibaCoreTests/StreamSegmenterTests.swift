import Foundation
import Testing

@testable import KotibaCore

// The cut policy that decides where a long hold is committed while the key is still down. The
// thing it must never do is cut through speech when a pause was available, and the thing it must
// always do is keep a committed stretch inside one 15 s Parakeet window.

private let rate = 16_000

/// `seconds` of "speech" — a loud 220 Hz tone — with silent gaps at the given offsets.
private func speech(_ seconds: Double, gaps: [(start: Double, length: Double)] = []) -> [Float] {
    var samples = (0..<Int(seconds * Double(rate))).map {
        Float(0.3 * sin(2 * Double.pi * 220 * Double($0) / Double(rate)))
    }
    for gap in gaps {
        let from = Int(gap.start * Double(rate))
        let to = min(samples.count, Int((gap.start + gap.length) * Double(rate)))
        for index in from..<to { samples[index] = 0 }
    }
    return samples
}

@Suite("Where a long dictation is cut while the key is held")
struct StreamSegmenterTests {

    let segmenter = StreamSegmenter()

    @Test("nothing is committed until 14 s are pending")
    func waitsForAWindow() {
        #expect(segmenter.cut(speech(13.9)) == nil)
        #expect(segmenter.cut(speech(14.0)) != nil)
    }

    @Test("the cut lands in the pause, not in the speech around it")
    func cutsInThePause() throws {
        let audio = speech(16, gaps: [(start: 9.0, length: 0.4)])
        let cut = try #require(segmenter.cut(audio))
        let seconds = Double(cut) / Double(rate)
        #expect(seconds > 9.0 && seconds < 9.4, "cut at \(seconds) s")
    }

    @Test("of two pauses the quieter wins, whichever comes first")
    func quieterPauseWins() throws {
        var audio = speech(16, gaps: [(start: 7.0, length: 0.3), (start: 12.0, length: 0.3)])
        // The later gap is not silent, only quieter than speech: room noise, not a stop.
        for index in Int(12.0 * Double(rate))..<Int(12.3 * Double(rate)) {
            audio[index] = 0.01
        }
        let cut = try #require(segmenter.cut(audio))
        let seconds = Double(cut) / Double(rate)
        #expect(seconds > 7.0 && seconds < 7.3, "cut at \(seconds) s")
    }

    @Test("two equally silent pauses: the later one, so what is left at key-up is shortest")
    func laterOfEqualPausesWins() throws {
        let audio = speech(16, gaps: [(start: 7.0, length: 0.3), (start: 12.0, length: 0.3)])
        let cut = try #require(segmenter.cut(audio))
        let seconds = Double(cut) / Double(rate)
        #expect(seconds > 12.0 && seconds < 12.3, "cut at \(seconds) s")
    }

    @Test("a pause after 14 s is out of reach: the committed stretch must fit one window")
    func neverPastTheWindow() throws {
        let audio = speech(20, gaps: [(start: 16.0, length: 1.0)])
        let cut = try #require(segmenter.cut(audio))
        #expect(cut <= 14 * rate)
        #expect(cut >= 6 * rate)
    }

    @Test("a pause before 6 s is too early to be worth a window of its own")
    func neverTooEarly() throws {
        let audio = speech(15, gaps: [(start: 2.0, length: 1.0)])
        let cut = try #require(segmenter.cut(audio))
        #expect(cut >= 6 * rate)
    }

    @Test("works on a slice that does not start at index zero")
    func acceptsSlices() throws {
        let audio = speech(30, gaps: [(start: 20.0, length: 0.4)])
        let tail = audio[(10 * rate)...]
        let cut = try #require(segmenter.cut(tail))
        let seconds = Double(cut) / Double(rate)
        #expect(seconds > 10.0 && seconds < 10.4, "cut at \(seconds) s into the slice")
    }
}
