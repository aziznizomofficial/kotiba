import Foundation
import Testing

@testable import KotibaCore

// Clipping is recorded, never fatal. Measured on a real utterance at peak 1.24 — well past full
// scale — and a flattened waveform transcribes badly, so this is the first thing worth knowing
// when someone asks why a dictation came out as nonsense.

@Suite("Clipping is noticed and never fatal")
struct ClippingTests {

    private func session(peak: Float, engine: any TranscriptionEngine) -> DictationSession {
        // A square wave at the requested amplitude: every sample at full magnitude, which is
        // what a clipped signal actually looks like.
        let samples = (0..<16_000).map { $0.isMultiple(of: 2) ? peak : -peak }
        return DictationSession(
            audio: WAVFileSourceStub(samples: samples),
            router: TieredRouter(fallback: .english),
            engines: [.unified: engine],
            sink: RecordingSink())
    }

    @Test("a clipped recording still transcribes, and says it was clipped")
    func clippedIsNotedButSucceeds() async {
        let session = session(peak: 1.0, engine: EchoEngine(text: "hello"))
        await session.arm()
        let record = await session.finish(pin: .english)

        // Not a failure. The user still gets their text.
        #expect(await session.state == .done)
        #expect(record.outcome == "done")
        #expect(record.result == "hello")

        let note = record.errors.first { $0.contains("clipping") }
        #expect(note != nil, "a full-scale recording produced no clipping note")
        // It must say what to do about it, not merely that it happened.
        #expect(note?.contains("input volume") == true)
        #expect(note?.contains("1.00") == true, "the note should carry the measured peak")
    }

    @Test("ordinary levels are not flagged")
    func normalLevelIsQuiet() async {
        // 0.147 is a real measured peak from a good Uzbek dictation.
        let session = session(peak: 0.147, engine: EchoEngine(text: "salom"))
        await session.arm()
        let record = await session.finish(pin: .english)

        #expect(record.outcome == "done")
        #expect(record.errors.isEmpty, "a healthy level was flagged: \(record.errors)")
    }

    @Test("the threshold sits just under full scale, not above it")
    func thresholdIsSane() {
        // Above 1.0 it could never fire — Float samples are clamped at full scale by the
        // hardware, so a threshold of exactly 1.0 would miss anything the converter rounded
        // down. Just under is the only value that catches real clipping.
        #expect(DictationSession.clippingThreshold < 1.0)
        #expect(DictationSession.clippingThreshold > 0.9)
    }

    // Loud and flattened are different conditions costing different amounts, and the peak alone
    // cannot separate them: a float peak above 1.0 happens both when the ADC flattened the wave
    // and when it was merely gained hot, and the resampler adds up to +1.15 dB of overshoot on its
    // own. Measured on the 344-clip Uzbek set:
    //
    //     0 % of samples flattened   25.19 % WER
    //     1.1 %                      25.20 %   — indistinguishable from clean
    //     8.3 %                      26.77 %   — 1.58 points
    //
    // So the old warning fired on a condition that costs nothing, including on cases this app's
    // own resampler created.

    /// A clean sine with a brief excursion past full scale: hot, not flattened.
    private func hotSession(engine: any TranscriptionEngine) -> DictationSession {
        var samples = (0..<16_000).map { 0.6 * sin(Float($0) * 0.05) }
        for i in 0..<40 { samples[8_000 + i] = i.isMultiple(of: 2) ? 1.4 : -1.4 }
        return DictationSession(
            audio: WAVFileSourceStub(samples: samples),
            router: TieredRouter(fallback: .english),
            engines: [.unified: engine],
            sink: RecordingSink())
    }

    @Test("a hot recording is recorded as hot, not warned about as clipping")
    func hotIsNotFlattened() async {
        let session = hotSession(engine: EchoEngine(text: "hello"))
        await session.arm()
        let record = await session.finish(pin: .english)

        #expect(record.outcome == "done")
        let joined = record.errors.joined()
        #expect(joined.contains("input is hot"), "40 of 16000 samples is 0.25%, which costs nothing")
        #expect(!joined.contains("input is clipping"))
        #expect(joined.contains("cost nothing"))
    }

    @Test("a genuinely flattened recording keeps the warning, with the share and the cost")
    func flattenedStillWarns() async {
        let session = session(peak: 1.0, engine: EchoEngine(text: "hello"))
        await session.arm()
        let record = await session.finish(pin: .english)

        let joined = record.errors.joined()
        #expect(joined.contains("input is clipping"))
        #expect(joined.contains("100.0% of samples"), "the share is what predicts the damage")
        #expect(joined.contains("word error"))
    }

    @Test("the flattening threshold sits between the two measured points")
    func flatteningThresholdIsDerived() {
        #expect(DictationSession.flatteningFraction > 0.011, "1.1% measured as costing nothing")
        #expect(DictationSession.flatteningFraction < 0.083, "8.3% measured as costing 1.58 points")
    }
}

// MARK: - Doubles

private struct RecordingSink: TextSink {
    func insert(_ text: String) async throws -> InsertionOutcome { .inserted }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        .inserted
    }
}

private struct EchoEngine: TranscriptionEngine {
    let text: String
    var engineID: String { "echo" }
    var supportedLanguages: Set<Language> { Set(Language.allCases) }
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        Transcript(raw: text, language: language, engineID: engineID)
    }
}

/// A source that hands back a fixed buffer. Named for what it stands in for; no file involved,
/// because KotibaCore may not read one.
private actor WAVFileSourceStub: AudioSource {
    private let samples: [Float]
    init(samples: [Float]) { self.samples = samples }
    func start() async throws {}
    func stop() async throws -> AudioBuffer { AudioBuffer(samples: samples) }
    func warmUp() async {}
}
