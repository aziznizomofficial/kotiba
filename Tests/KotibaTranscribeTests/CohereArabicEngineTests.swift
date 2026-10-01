import Foundation
import KotibaCore
import Testing
@testable import KotibaTranscribe

// Band 1 — no model. The 1.77 GB GGUF is exercised by `kotiba-probe stream --cohere` and
// `kotiba-probe e2e`; what can be checked without it is the part that decides what the model is
// ever handed: nothing over its 35 s ceiling (C4 §3.3), cut where the speaker was quiet.

@Suite("Cohere is never handed more than it can decode")
struct CohereSegmentsTests {

    private func speech(_ seconds: Double, level: Float = 0.3) -> [Float] {
        (0..<Int(seconds * 16_000)).map { level * sin(Float($0) * 0.05) }
    }

    @Test("a recording within the limit is one segment, untouched")
    func shortIsOne() {
        let samples = speech(20)
        #expect(CohereArabicEngine.segments(of: samples) == [0..<samples.count])
        #expect(CohereArabicEngine.segments(of: []) == [])
    }

    @Test("a long recording is cut into segments of at most 28 s that tile it exactly")
    func longIsTiled() {
        let samples = speech(95)
        let ranges = CohereArabicEngine.segments(of: samples)
        #expect(ranges.count >= 4)
        #expect(ranges.first?.lowerBound == 0)
        #expect(ranges.last?.upperBound == samples.count)
        for (a, b) in zip(ranges, ranges.dropFirst()) { #expect(a.upperBound == b.lowerBound) }
        for range in ranges {
            #expect(range.count <= Int(CohereArabicEngine.maximumSegment * 16_000))
        }
    }

    @Test("the cut lands in the silence the speaker left, not mid-word")
    func cutsAtThePause() {
        // 25 s of speech, 0.6 s of silence, 15 s of speech: 40.6 s, over the limit once.
        let samples = speech(25) + [Float](repeating: 0, count: 9_600) + speech(15)
        let ranges = CohereArabicEngine.segments(of: samples)
        #expect(ranges.count == 2)
        let cut = ranges[0].upperBound
        #expect(cut > 25 * 16_000 && cut < 25 * 16_000 + 9_600)
    }

    @Test("an abort that follows another flag is raised when that one is")
    func abortFollows() {
        final class Flag: @unchecked Sendable { var raised = false }
        let flag = Flag()
        let abort = TranscribeAbort(following: { flag.raised })
        #expect(!abort.isRaised)
        flag.raised = true
        #expect(abort.isRaised)
        let own = TranscribeAbort()
        own.raise()
        #expect(own.isRaised)
    }

    @Test("a missing model is a failure that names the path, not a crash")
    func missingModel() async {
        let engine = CohereArabicEngine(modelURL: URL(fileURLWithPath: "/nonexistent/cohere.gguf"))
        #expect(await engine.isReady() == false)
        let outcome = await engine.decode([Float](repeating: 0.1, count: 16_000))
        guard case .failed(let why) = outcome else {
            Issue.record("expected a failure, got \(outcome)")
            return
        }
        #expect(why.contains("/nonexistent/cohere.gguf"))
    }
}
