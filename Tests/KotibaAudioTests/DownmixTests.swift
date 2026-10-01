import Foundation
import Testing

@testable import KotibaAudio

// The only arithmetic the real-time thread performs, so it is worth testing on its own —
// everything else in MicrophoneSource needs a microphone and cannot be proven here.

@Suite("Downmix — the render callback's only arithmetic")
struct DownmixTests {

    @Test("mono passes through untouched")
    func mono() {
        #expect(Downmix.toMono([[0.1, -0.2, 0.3]]) == [0.1, -0.2, 0.3])
    }

    @Test("stereo averages")
    func stereo() {
        let out = Downmix.toMono([[1.0, 0.0], [0.0, 1.0]])
        #expect(out.count == 2)
        for v in out { #expect(abs(v - 0.5) < 1e-6) }
    }

    @Test("out-of-phase channels cancel, which is the correct answer and a real recording case")
    func cancellation() {
        // A badly wired stereo pair really does do this; silently producing silence is right,
        // and the near-silence guard downstream is what tells the user about it.
        let out = Downmix.toMono([[1.0, -1.0], [-1.0, 1.0]])
        for v in out { #expect(abs(v) < 1e-6) }
    }

    @Test("more than two channels average correctly")
    func multichannel() {
        let out = Downmix.toMono([[1.0], [2.0], [3.0], [4.0]])
        #expect(abs(out[0] - 2.5) < 1e-6)
    }

    @Test("ragged channels use the shortest, rather than reading past the end")
    func ragged() {
        #expect(Downmix.toMono([[1.0, 1.0, 1.0], [1.0]]).count == 1)
    }

    @Test("no channels and empty channels are handled")
    func degenerate() {
        #expect(Downmix.toMono([]).isEmpty)
        #expect(Downmix.toMono([[]]).isEmpty)
    }

    @Test("the pointer path agrees with the array path")
    func pointerPathMatchesArrayPath() {
        // The pointer overload is what actually runs on the audio thread; the array overload is
        // what the tests above exercise. They must not drift apart.
        var left: [Float] = [0.2, 0.4, 0.6, 0.8]
        var right: [Float] = [0.0, 0.2, 0.4, 0.6]
        let expected = Downmix.toMono([left, right])

        let out = UnsafeMutableBufferPointer<Float>.allocate(capacity: 4)
        defer { out.deallocate() }
        left.withUnsafeMutableBufferPointer { l in
            right.withUnsafeMutableBufferPointer { r in
                let pointers = [l.baseAddress!, r.baseAddress!]
                pointers.withUnsafeBufferPointer { channels in
                    Downmix.toMono(channels: channels, frames: 4, into: out.baseAddress!)
                }
            }
        }
        for i in 0..<4 { #expect(abs(out[i] - expected[i]) < 1e-6) }
    }
}

@Suite("RealtimeScratch")
struct RealtimeScratchTests {

    @Test("allocates the requested size and hands back a usable base pointer")
    func allocation() {
        let s = RealtimeScratch(capacity: 128)
        #expect(s.count == 128)
        s.base[0] = 1.5
        s.base[127] = -1.5
        #expect(s.base[0] == 1.5)
        #expect(s.base[127] == -1.5)
    }

    @Test("starts zeroed, so a partial write never exposes stale audio")
    func zeroed() {
        let s = RealtimeScratch(capacity: 64)
        for i in 0..<64 { #expect(s.base[i] == 0) }
    }
}
