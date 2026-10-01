import Foundation
import KotibaCore
import Testing

@testable import KotibaEngines

// Parakeet's stream, scheduled against a fake window decoder: commits every 14 s, a decode at
// each pause, and a key-up that adopts the pause decode only when nothing was said after it.

private typealias AudioBuffer = KotibaCore.AudioBuffer
private let rate = AudioBuffer.sampleRate

private func room(_ seconds: Double) -> [Float] {
    var state: UInt64 = 7
    return (0..<Int(seconds * Double(rate))).map { _ in
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return (Float(state >> 40) / Float(1 << 24) - 0.5) * 0.002
    }
}

private func voice(_ seconds: Double) -> [Float] {
    var out = room(seconds)
    let period = rate / 5, on = rate * 4 / 25
    for i in out.indices where i % period < on {
        out[i] += 0.14 * sinf(2 * Float.pi * 220 * Float(i) / Float(rate))
    }
    return out
}

private actor FakeWindows: WindowDecoding {
    nonisolated let engineID = "fake-parakeet"
    private(set) var decoded: [Double] = []
    private(set) var batches = 0
    var ready = true
    var delay: Duration = .zero
    var installed = true
    private(set) var prepares = 0
    func setReady(_ value: Bool) { ready = value }
    func setDelay(_ value: Duration) { delay = value }
    func setInstalled(_ value: Bool) { installed = value }
    func prepare() async throws {
        prepares += 1
        if !installed { throw EngineFailure.notReady("not downloaded") }
    }
    func isReady() async -> Bool { ready }
    func decode(_ samples: [Float], language: Language?) async throws -> String {
        decoded.append(Double(samples.count) / Double(rate))
        let name = "d\(decoded.count - 1)."
        if delay > .zero { try await Task.sleep(for: delay) }
        return name
    }
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        batches += 1
        return Transcript(raw: "batch.", language: language, engineID: engineID)
    }
}

private func feed(_ stream: ParakeetStream, _ audio: [Float]) async {
    var i = 0
    while i < audio.count {
        let end = min(i + 320, audio.count)
        await stream.append(Array(audio[i..<end]))
        // Let any decode it started land before the next chunk: the machine keeps up.
        try? await Task.sleep(for: .milliseconds(1))
        i = end
    }
}

private func finish(_ stream: ParakeetStream, _ audio: [Float]) async throws -> Transcript {
    try await stream.finish(AudioBuffer(samples: audio), language: .english)
}

@Suite("Parakeet stream — decoding at pauses")
struct ParakeetStreamTests {

    @Test("speech then a pause: the pause decode is adopted, and key-up decodes nothing")
    func adoptsThePauseDecode() async throws {
        let decoder = FakeWindows()
        let stream = ParakeetStream(engine: decoder, segmenter: StreamSegmenter())
        let audio = voice(3) + room(0.6)
        await feed(stream, audio)
        try await Task.sleep(for: .milliseconds(50))
        #expect(await decoder.decoded.count == 1, "no decode at the pause")
        let progress = await stream.progress()
        #expect(progress?.provisional == "d0.")
        let transcript = try await finish(stream, audio)
        #expect(transcript.raw == "d0.")
        #expect(await decoder.decoded.count == 1, "key-up decoded again")
        #expect(await decoder.batches == 0)
        #expect(await stream.settlement() == "speculation")
    }

    @Test("speech after the pause: key-up decodes it, and the pause decode is not pasted")
    func speechAfterThePause() async throws {
        let decoder = FakeWindows()
        let stream = ParakeetStream(engine: decoder, segmenter: StreamSegmenter())
        let audio = voice(3) + room(0.6) + voice(1)
        await feed(stream, audio)
        let transcript = try await finish(stream, audio)
        // Nothing committed yet (under 14 s), so the whole recording is decoded — exactly the
        // batch answer — rather than the stale pause decode.
        #expect(transcript.raw == "batch.")
        #expect(await stream.settlement() == "decoded")
    }

    @Test("a cold engine is never loaded by a speculation")
    func coldEngineDoesNotSpeculate() async throws {
        let decoder = FakeWindows()
        await decoder.setReady(false)
        let stream = ParakeetStream(engine: decoder, segmenter: StreamSegmenter())
        let audio = voice(2) + room(0.6)
        await feed(stream, audio)
        try await Task.sleep(for: .milliseconds(30))
        #expect(await decoder.decoded.isEmpty)
    }

    @Test("a long hold commits a window, and key-up adopts the pause decode of the rest")
    func commitsThenAdopts() async throws {
        let decoder = FakeWindows()
        let stream = ParakeetStream(engine: decoder, segmenter: StreamSegmenter())
        let audio = voice(15) + room(0.6)
        await feed(stream, audio)
        try await Task.sleep(for: .milliseconds(50))
        let transcript = try await finish(stream, audio)
        #expect(await decoder.batches == 0)
        #expect(transcript.raw.hasPrefix("d0."))
        #expect(await stream.settlement() == "speculation")
    }

    @Test("a commit that starts while key-up waits is waited for too — never a hole in the text")
    func keyUpWaitsForEveryCommit() async throws {
        // A backlog: the engine answered slowly (a first Neural Engine compile, a reload after
        // memory pressure) while 30 s were spoken, so a second window is due the moment the first
        // one lands — which is while key-up is waiting on it.
        let decoder = FakeWindows()
        await decoder.setDelay(.milliseconds(300))
        let stream = ParakeetStream(engine: decoder, segmenter: StreamSegmenter())
        let audio = voice(30)
        var i = 0
        while i < audio.count {
            let end = min(i + 320, audio.count)
            await stream.append(Array(audio[i..<end]))
            i = end
        }
        let transcript = try await finish(stream, audio)
        let decoded = await decoder.decoded
        // Every window decoded, and every one of them in the text, in order.
        #expect(await decoder.batches == 0)
        #expect(transcript.raw == (0..<decoded.count).map { "d\($0)." }.joined(separator: " "),
                "\(transcript.raw) from \(decoded.count) decodes")
        #expect(decoded.reduce(0, +) >= 29.5, "audio missing from the decodes: \(decoded)")
    }

    @Test("a cancelled stream's finish decodes nothing — not even the batch it used to fall back to")
    func cancelledFinishDecodesNothing() async throws {
        let decoder = FakeWindows()
        let stream = ParakeetStream(engine: decoder, segmenter: StreamSegmenter())
        let audio = voice(3) + room(0.1) + voice(2)
        await feed(stream, audio)
        await stream.cancel()
        await #expect(throws: CancellationError.self) { _ = try await finish(stream, audio) }
        #expect(await decoder.batches == 0)
    }

    @Test("with the engine absent, a long hold asks for it once a second, not at every chunk")
    func absentEngineIsNotAskedAtEveryChunk() async throws {
        // Parakeet not downloaded (declined, failed, still coming): each chunk past 14 s used to
        // cut the whole backlog out, fail to prepare, and splice it back — two copies of the
        // recording per 20 ms, which outran the microphone on a long hold.
        let decoder = FakeWindows()
        await decoder.setInstalled(false)
        let stream = ParakeetStream(engine: decoder, segmenter: StreamSegmenter())
        await feed(stream, voice(60))
        let prepares = await decoder.prepares
        #expect(prepares <= 60, "prepare asked \(prepares) times in a 60 s hold")
        #expect(prepares >= 10, "and still asked: an engine that arrives mid-hold is used")
    }
}
