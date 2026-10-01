import Foundation
import Testing

@testable import KotibaCore

// Band 1. The segmenter decides where a streaming decode may cut, and every rule it has exists
// because breaking it costs either words (a cut inside speech) or latency (no cut at all). These
// build the audio synthetically — a tone for speech, low noise for the room — so the expected
// cut points are known to the sample.

private let rate = AudioBuffer.sampleRate

/// `seconds` of "syllables": a 220 Hz tone at roughly -20 dBFS, 160 ms on and 40 ms off, over
/// the room. The 40 ms gaps matter — real speech has them between words, and they are what keep
/// the tracked noise floor down; a tone that never stops would eventually *become* the floor.
private func voice(_ seconds: Double) -> [Float] {
    let bed = room(seconds, seed: 11)
    return (0..<bed.count).map { i in
        let inSyllable = (i % (rate / 5)) < (rate * 4 / 25)
        return bed[i] + (inSyllable ? 0.14 * sinf(2 * .pi * 220 * Float(i) / Float(rate)) : 0)
    }
}

/// `seconds` of low noise around -60 dBFS: a quiet room, not digital silence.
private func room(_ seconds: Double, seed: UInt64 = 7) -> [Float] {
    var state = seed
    return (0..<Int(seconds * Double(rate))).map { _ in
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return (Float(state >> 40) / Float(1 << 24) - 0.5) * 0.002
    }
}

/// Short segments, so the cut rules are exercised on seconds of audio rather than minutes. The
/// production default (20 s minimum) is checked on its own below.
private let short: SpeechSegmenter.Configuration = {
    var configuration = SpeechSegmenter.Configuration()
    configuration.minimumSegment = 3
    configuration.relaxAfter = 8
    return configuration
}()

private func run(_ audio: [Float], chunk: Int = 320,
                 configuration: SpeechSegmenter.Configuration = short)
-> (events: [SpeechSegmenter.Event], segmenter: SpeechSegmenter) {
    var segmenter = SpeechSegmenter(configuration: configuration)
    var events: [SpeechSegmenter.Event] = []
    var i = 0
    while i < audio.count {
        let end = min(i + chunk, audio.count)
        events += segmenter.append(audio[i..<end])
        i = end
    }
    return (events, segmenter)
}

private func commits(_ events: [SpeechSegmenter.Event]) -> [SpeechSegmenter.Span] {
    events.compactMap { if case .commit(let span) = $0 { return span } else { return nil } }
}

private func pauses(_ events: [SpeechSegmenter.Event]) -> [SpeechSegmenter.Span] {
    events.compactMap { if case .pause(let span) = $0 { return span } else { return nil } }
}

private func seconds(_ sample: Int) -> Double { Double(sample) / Double(rate) }

@Suite("Speech segmenter — where a streaming decode may cut")
struct SpeechSegmenterTests {

    @Test("a quiet room is never speech, so release costs nothing and nothing is decoded")
    func roomOnly() {
        let (events, segmenter) = run(room(10))
        #expect(events.isEmpty)
        #expect(segmenter.tail() == nil)
    }

    @Test("a real pause after enough speech commits it, cut inside the pause")
    func commitsAtPause() throws {
        let (events, segmenter) = run(room(0.5) + voice(4) + room(0.8) + voice(2))
        let committed = commits(events)
        try #require(committed.count == 1)
        let span = committed[0]
        // Speech ran 0.5–4.46 s (the last 40 ms is a syllable gap); padding is 0.5 s before and
        // `trailingPadding` (0.1 s) after.
        let trailing = SpeechSegmenter.Configuration().trailingPadding
        #expect(abs(seconds(span.speech.lowerBound) - 0.0) < 0.03)
        #expect(abs(seconds(span.speech.upperBound) - (4.46 + trailing)) < 0.03)
        // The cut lands inside the 0.8 s pause, not at its edge and not in the next word.
        #expect(seconds(span.region.upperBound) > 4.5 && seconds(span.region.upperBound) < 5.3)

        // The second burst is the tail, and it starts where the commit ended.
        let tail = try #require(segmenter.tail())
        #expect(tail.region.lowerBound == span.region.upperBound)
        #expect(abs(seconds(tail.speech.lowerBound) - 4.8) < 0.03)
    }

    @Test("a short pause is a speculation, not a commit")
    func shortPauseSpeculates() throws {
        let (events, _) = run(voice(4) + room(0.3) + voice(1))
        #expect(commits(events).isEmpty)
        let pause = try #require(pauses(events).first)
        let trailing = SpeechSegmenter.Configuration().trailingPadding
        #expect(abs(seconds(pause.speech.upperBound) - (3.96 + trailing)) < 0.03)
    }

    @Test("a speculation reported at a pause equals the tail if the speaker says nothing more")
    func speculationMatchesTail() throws {
        // The session adopts a speculation only when its span is *equal* to the tail at release,
        // so the two must agree exactly — including the padding clamp.
        let (events, segmenter) = run(voice(2) + room(0.35))
        let pause = try #require(pauses(events).last)
        let tail = try #require(segmenter.tail())
        #expect(pause.speech == tail.speech)
    }

    @Test("with 512-sample frames too, a pause span equals the tail it will become")
    func speculationMatchesTailAtSileroFrames() throws {
        struct Frames512: SpeechFrameClassifier {
            var inner = EnergyFrameClassifier()
            let frameSamples = 512
            mutating func probabilities(_ samples: ArraySlice<Float>) -> [Float] {
                var out: [Float] = []
                var i = samples.startIndex
                while i + 512 <= samples.endIndex {
                    // 512 = 320 + 192: classify on the first 320 samples of each frame.
                    out.append(inner.probabilities(samples[i..<(i + 320)]).first ?? 0)
                    i += 512
                }
                return out
            }
            mutating func reset() { inner.reset() }
        }
        var segmenter = SpeechSegmenter(configuration: short, classifier: Frames512())
        var events: [SpeechSegmenter.Event] = []
        let audio = voice(2) + room(0.6)
        var i = 0
        while i < audio.count { events += segmenter.append(audio[i..<min(i + 512, audio.count)]); i += 512 }
        let pause = try #require(pauses(events).last)
        #expect(pause.speech == segmenter.tail()?.speech)
    }

    @Test("segments shorter than the minimum are not committed, however long the pause")
    func minimumSegment() {
        let (events, _) = run(voice(1) + room(1) + voice(0.5) + room(0.4))
        #expect(commits(events).isEmpty)
    }

    @Test("speech that never pauses is force-cut before it outgrows one Whisper window")
    func maximumSegment() throws {
        let (events, segmenter) = run(voice(40))
        let committed = commits(events)
        try #require(!committed.isEmpty)
        for span in committed {
            #expect(seconds(span.region.count) <= 24.01)
        }
        // And nothing is lost: the commits and the tail together cover all of it.
        let tail = try #require(segmenter.tail())
        #expect(committed.first?.region.lowerBound == 0)
        #expect(zip(committed, committed.dropFirst()).allSatisfy {
            $0.region.upperBound == $1.region.lowerBound
        })
        #expect(committed.last?.region.upperBound == tail.region.lowerBound)
    }

    @Test("a long pending region commits at a shorter pause, so the tail stays short")
    func relaxedPause() {
        // 9 s of speech, then a 0.3 s gap: under `commitPause` (0.5) but over the relaxed 0.25.
        let (events, _) = run(voice(9) + room(0.3) + voice(2))
        #expect(commits(events).count == 1)
    }

    @Test("by default a typical dictation stays whole and a long hold is still cut")
    func productionDefault() {
        var typical: [Float] = []
        for _ in 0..<5 { typical += voice(3) + room(0.7) }        // 18.5 s, five real pauses
        let (short, shortSegmenter) = run(typical, configuration: .init())
        #expect(commits(short).isEmpty)
        #expect(shortSegmenter.tail() != nil)

        var long: [Float] = []
        for _ in 0..<20 { long += voice(3) + room(0.7) }         // 74 s
        let (events, _) = run(long, configuration: .init())
        let cuts = commits(events)
        #expect(cuts.count >= 2)
        for span in cuts { #expect(seconds(span.region.count) >= 20 && seconds(span.region.count) <= 24.01) }
    }

    @Test("a click is not a word")
    func clickIsNotSpeech() {
        let (events, segmenter) = run(room(1) + voice(0.02) + room(1))
        #expect(events.isEmpty)
        #expect(segmenter.tail() == nil)
    }

    @Test("the decision does not depend on how capture chunks the audio")
    func chunkingInvariance() {
        let audio = room(0.4) + voice(3.5) + room(0.7) + voice(2) + room(0.3) + voice(1)
        let a = run(audio, chunk: 1)
        let b = run(audio, chunk: 4_096)
        let c = run(audio, chunk: 160)
        #expect(a.events == b.events)
        #expect(a.events == c.events)
        #expect(a.segmenter.tail() == b.segmenter.tail())
    }

    @Test("a steady noise that starts loud is absorbed into the floor, not read as speech")
    func steadyNoise() {
        let hum = (0..<(rate * 6)).map { 0.02 * sinf(2 * .pi * 50 * Float($0) / Float(rate)) }
        let (events, segmenter) = run(hum)
        #expect(events.isEmpty)
        #expect(segmenter.tail() == nil)
    }
}

@Suite("Segment text — joining, prompting and loop detection")
struct SegmentTextTests {

    @Test("segments join with one space and empties vanish")
    func join() {
        #expect(SegmentText.join(["salom, ", "", "  qalaysiz?"]) == "salom, qalaysiz?")
        #expect(SegmentText.join([]) == "")
    }

    @Test("the hint goes first and the carried text is cut at a word boundary")
    func prompt() {
        let previous = "birinchi gap. ikkinchi gap juda uzun bo'ldi"
        let prompt = SegmentText.prompt(hint: "Bu yerda.", previous: previous, carry: 20)
        #expect(prompt == "Bu yerda. gap juda uzun bo'ldi")
        #expect(SegmentText.prompt(hint: nil, previous: "", carry: 200) == nil)
        #expect(SegmentText.prompt(hint: "Bu.", previous: "abc", carry: 0) == "Bu.")
    }

    @Test("a phrase repeated three times is a loop; a real 'ha ha ha' is not")
    func selfRepetition() {
        #expect(SegmentText.looksLikeALoop("men bordim men bordim men bordim", previous: ""))
        #expect(SegmentText.looksLikeALoop("rahmat rahmat rahmat rahmat rahmat", previous: ""))
        #expect(!SegmentText.looksLikeALoop("ha ha ha, tushundim", previous: ""))
        #expect(!SegmentText.looksLikeALoop("bugun havo juda yaxshi", previous: ""))
    }

    @Test("a segment that just re-reads the end of its prompt is a loop")
    func promptEcho() {
        let previous = "biz ertaga ertalab soat to'qqizda uchrashamiz, keyin ishga boramiz."
        #expect(SegmentText.looksLikeALoop("keyin ishga boramiz, ertalab soat", previous: previous)
                == false)
        #expect(SegmentText.looksLikeALoop("soat to'qqizda uchrashamiz, keyin ishga",
                                           previous: previous))
        // Short segments are never judged this way: "ha, mayli" legitimately recurs.
        #expect(!SegmentText.looksLikeALoop("keyin ishga", previous: previous))
    }
}
