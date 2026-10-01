import Foundation
import KotibaCore
import Testing

@testable import KotibaAudio

// Builds WAVs in memory rather than checking binaries into the repo: the encoder is right
// there in the test, so a failure points at the parser rather than at a mystery file.

private func makeWAV(samples: [Float], rate: Int = 16_000, channels: Int = 1,
                     float32: Bool = false, extraChunk: Bool = false) -> Data {
    var body = Data()
    if float32 {
        for s in samples { withUnsafeBytes(of: s.bitPattern.littleEndian) { body.append(contentsOf: $0) } }
    } else {
        for s in samples {
            let v = Int16(max(-32768, min(32767, s * 32767)))
            withUnsafeBytes(of: UInt16(bitPattern: v).littleEndian) { body.append(contentsOf: $0) }
        }
    }
    let bits = float32 ? 32 : 16
    let blockAlign = channels * bits / 8

    var fmt = Data()
    func u16(_ v: Int, into d: inout Data) { withUnsafeBytes(of: UInt16(v).littleEndian) { d.append(contentsOf: $0) } }
    func u32(_ v: Int, into d: inout Data) { withUnsafeBytes(of: UInt32(v).littleEndian) { d.append(contentsOf: $0) } }
    u16(float32 ? 3 : 1, into: &fmt)
    u16(channels, into: &fmt)
    u32(rate, into: &fmt)
    u32(rate * blockAlign, into: &fmt)
    u16(blockAlign, into: &fmt)
    u16(bits, into: &fmt)

    var chunks = Data()
    chunks.append("fmt ".data(using: .ascii)!)
    u32(fmt.count, into: &chunks)
    chunks.append(fmt)
    if extraChunk {
        // A LIST chunk between fmt and data — real files have these, and a parser that
        // assumes fixed offsets reads garbage when they appear.
        chunks.append("LIST".data(using: .ascii)!)
        u32(4, into: &chunks)
        chunks.append("INFO".data(using: .ascii)!)
    }
    chunks.append("data".data(using: .ascii)!)
    u32(body.count, into: &chunks)
    chunks.append(body)

    var out = Data("RIFF".data(using: .ascii)!)
    u32(4 + chunks.count, into: &out)
    out.append("WAVE".data(using: .ascii)!)
    out.append(chunks)
    return out
}

@Suite("WAV parsing")
struct WAVFileTests {

    @Test("16-bit mono round-trips within quantisation error")
    func pcm16Mono() throws {
        let input: [Float] = [0, 0.5, -0.5, 0.25, -1.0]
        let f = try WAVFile(data: makeWAV(samples: input))
        #expect(f.sampleRate == 16_000)
        #expect(f.channels == 1)
        #expect(f.samples.count == input.count)
        for (got, want) in zip(f.samples, input) { #expect(abs(got - want) < 0.001) }
    }

    @Test("32-bit float is exact")
    func float32() throws {
        let input: [Float] = [0, 0.123_456, -0.987_654]
        let f = try WAVFile(data: makeWAV(samples: input, float32: true))
        #expect(f.samples == input)
    }

    @Test("stereo is averaged to mono")
    func stereoDownmix() throws {
        // L=1.0, R=0.0 twice → 0.5, 0.5
        let f = try WAVFile(data: makeWAV(samples: [1.0, 0.0, 1.0, 0.0], channels: 2))
        #expect(f.channels == 2)
        #expect(f.samples.count == 2)
        for s in f.samples { #expect(abs(s - 0.5) < 0.001) }
    }

    @Test("a LIST chunk between fmt and data does not derail the parser")
    func extraChunks() throws {
        let f = try WAVFile(data: makeWAV(samples: [0.25, -0.25], extraChunk: true))
        #expect(f.samples.count == 2)
        #expect(abs(f.samples[0] - 0.25) < 0.001)
    }

    @Test("44.1 kHz resamples to Kotiba's 16 kHz")
    func resampling() throws {
        let f = try WAVFile(data: makeWAV(samples: Array(repeating: 0.5, count: 44_100), rate: 44_100))
        #expect(f.sampleRate == 44_100)
        let out = f.resampledTo16k()
        #expect(abs(out.count - 16_000) < 10, "one second in, one second out")
    }

    @Test("already 16 kHz is left alone rather than resampled through itself")
    func noPointlessResample() throws {
        let f = try WAVFile(data: makeWAV(samples: Array(repeating: 0.5, count: 1000)))
        #expect(f.resampledTo16k().count == 1000)
    }

    @Test("every malformed file fails loudly with a reason a human can read")
    func malformed() {
        #expect(throws: WAVError.notRIFF) { try WAVFile(data: Data("XXXXnope".utf8)) }

        var notWave = Data("RIFF".utf8)
        notWave.append(contentsOf: [0, 0, 0, 0])
        notWave.append(Data("AVI ".utf8))
        #expect(throws: WAVError.notWAVE) { try WAVFile(data: notWave) }

        #expect(WAVError.unsupportedFormat(code: 85).reason.contains("not PCM"))
        #expect(WAVError.missingChunk("data").reason.contains("data"))
    }
}

@Suite("WAVFileSource — the Band-2 microphone stand-in")
struct WAVFileSourceTests {

    @Test("replays the same buffer every time")
    func deterministic() async throws {
        let src = WAVFileSource(samples: [0.1, 0.2, 0.3])
        try await src.start()
        let first = try await src.stop()
        try await src.start()
        let second = try await src.stop()
        #expect(first.samples == second.samples)
        #expect(first.samples == [0.1, 0.2, 0.3])
    }

    @Test("stopping without starting yields nothing rather than stale audio")
    func stopWithoutStart() async throws {
        let src = WAVFileSource(samples: [0.1, 0.2])
        #expect(try await src.stop().samples.isEmpty)
    }

    @Test("warm-up is counted, so A-06 can assert it happens on every foreground")
    func warmUpIsObservable() async {
        let src = WAVFileSource(samples: [])
        #expect(await src.warmUpCount == 0)
        await src.warmUp()
        await src.warmUp()
        #expect(await src.warmUpCount == 2)
    }

    @Test("drives a whole dictation without a microphone anywhere in sight")
    func endToEnd() async throws {
        // The point of this type: a full session against a fixture, in milliseconds.
        let samples = (0..<16_000).map { 0.4 * Float(sin(Double($0) * 0.06)) }
        let src = WAVFileSource(samples: samples)
        try await src.start()
        let buffer = try await src.stop()
        #expect(abs(buffer.duration - 1.0) < 0.001)
        #expect(buffer.peakAmplitude > 0.3)
    }
}
