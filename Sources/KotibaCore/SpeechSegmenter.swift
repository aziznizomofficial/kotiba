import Foundation

// C2. Where a streaming decoder may cut the audio while the user is still talking.
//
// Uzbek runs on a Whisper-medium fine-tune, and a whole-utterance decode of it costs ~430 ms for
// 2.8 s of audio and seconds for a minute. None of that has to happen after the key comes up: the
// audio before the speaker's last pause is already final, so it can be transcribed while they are
// still talking, and key-release only has to pay for what came after that pause. This type
// decides where those pauses are. It is pure — samples in, sample indices out — so the decision is
// testable in Band 1 and the Windows port can re-implement it against the same fixtures.
//
// Three rules, each measured on the 344-clip Uzbek harness (docs/research/C2-uzbek-latency.md):
//
//   * **Only cut in a real pause.** A cut inside a word costs WER in both halves; a cut in a
//     half-second silence costs nothing measurable once the previous text rides along as the
//     decoder prompt. So a commit needs `commitPause` of continuous non-speech, and the cut goes
//     `padding` after the last speech frame, never at it.
//   * **Do not cut too early.** Whisper conditions on everything in its window, and every cut
//     costs accuracy on both sides of it. `minimumSegment` (20 s) keeps typical dictations whole.
//   * **Never let a segment outgrow one Whisper window.** Past `maximumSegment` the cut is forced
//     into the quietest stretch of the last few seconds, because Whisper would otherwise split it
//     itself at an arbitrary 30 s boundary with no idea where the words are.
//
// What counts as speech is a `SpeechFrameClassifier`'s call, frame by frame and causally. The
// production one is Silero (KotibaEngines, through whisper.cpp's own VAD); `EnergyFrameClassifier`
// here is the fallback when that 885 KB model is absent, and what Band 1 runs on. The difference
// is not academic: on the harness the energy gate read the first 2.3 s of a sermon over music as
// silence and the segment lost six words (C2 §4), because a word mistaken for silence is trimmed
// out of the decode. Silero's hysteresis thresholds are the ones its authors ship.

/// Says, frame by frame, how likely each stretch of audio is to be speech.
public protocol SpeechFrameClassifier: Sendable {
    /// Samples per frame at 16 kHz. Silero: 512 (32 ms). Energy: 320 (20 ms).
    var frameSamples: Int { get }
    /// One probability per frame, for consecutive frames; `samples.count` is a whole number of
    /// frames. State (a noise floor, an LSTM) carries over from the previous call.
    mutating func probabilities(_ samples: ArraySlice<Float>) -> [Float]
    /// A new utterance: forget what came before.
    mutating func reset()
}

/// A causal energy gate: level above a tracked noise floor, mapped onto 0…1 so it can share the
/// segmenter's thresholds with Silero. 12 dB over the floor is 0.5.
public struct EnergyFrameClassifier: SpeechFrameClassifier {
    public let frameSamples = 320
    /// Below this absolute level nothing is speech. -55 dBFS is well under the quietest real
    /// dictation on record (peak 0.05 ≈ -26 dBFS).
    public var absoluteFloorDB: Float = -55
    /// How fast the noise floor may rise, per second. It falls instantly, so a word never raises
    /// it much but a fan switching on is absorbed within a few seconds.
    public var floorRiseDBPerSecond: Float = 3
    private var floorDB: Float?

    public init() {}

    public mutating func probabilities(_ samples: ArraySlice<Float>) -> [Float] {
        var out: [Float] = []
        var i = samples.startIndex
        while i + frameSamples <= samples.endIndex {
            var sum: Float = 0
            for v in samples[i..<(i + frameSamples)] { sum += v * v }
            i += frameSamples
            let db = 20 * log10(max((sum / Float(frameSamples)).squareRoot(), 1e-7))
            let rise = floorRiseDBPerSecond * Float(frameSamples) / Float(AudioBuffer.sampleRate)
            let floor = floorDB.map { db < $0 ? db : $0 + rise } ?? db
            floorDB = floor
            out.append(db < absoluteFloorDB ? 0 : min(1, max(0, (db - floor - 2) / 20)))
        }
        return out
    }

    public mutating func reset() { floorDB = nil }
}

public struct SpeechSegmenter: Sendable {

    public struct Configuration: Sendable, Equatable {
        /// A frame becomes speech above this probability…
        public var onsetProbability: Float = 0.5
        /// …and stays speech until it falls below this one. Silero's own defaults (threshold and
        /// threshold − 0.15). Hysteresis is what keeps the soft tail of a word from reading as a
        /// pause.
        public var releaseProbability: Float = 0.35
        /// Silence needed before a segment is committed for good.
        public var commitPause: Double = 0.5
        /// Once the pending region is this long, a shorter pause is enough to commit, so a speaker
        /// who never pauses for half a second is still cut before `maximumSegment` forces it.
        public var relaxAfter: Double = 22.0
        public var relaxedCommitPause: Double = 0.25
        /// Silence after which the pending audio is worth a speculative decode — the speaker may
        /// be about to let go of the key. Must be shorter than `commitPause` to be of any use.
        ///
        /// 0.1 s, down from 0.2 (P2 §3): a release 300 ms after the last word used to find the
        /// decode 100 ms old; it now finds it 200 ms old, which took the 5–12 s bucket's p50 from
        /// 122 to 31 ms on the tuning clips, at the same WER (21.95 %). A pause this short is
        /// often a stop inside a word, so the session decodes there but does not *cut* there —
        /// see `StreamingWhisperSession.Configuration.cutPause`.
        public var speculativePause: Double = 0.1
        /// A committed segment is at least this long — and this is the accuracy knob. Every cut
        /// costs the decoder the acoustic and textual context across it, however good the
        /// carried prompt: on the 344-clip harness 3 s cost 1.28 WER points against the
        /// whole-utterance decode, 8 s cost 0.82, 12 s 0.83, and 20 s 0.09 (C2 §4). 20 s keeps
        /// ~90% of this owner's Uzbek dictations in one piece and still cuts a ten-minute hold
        /// into Whisper-sized segments, so the model hears what it was measured on; latency
        /// comes from the fitted window and the speculation instead.
        public var minimumSegment: Double = 20.0
        /// No segment is longer than this; past it the cut is forced.
        public var maximumSegment: Double = 24.0
        /// Kept before detected speech when a span is handed to the decoder. Trimming close to
        /// the first frame Silero calls speech clips the word: at 0.2 s the harness lost "o'n"
        /// from "o'n ming beraman", and short clips alone cost 1.4 WER points (C2 §4).
        public var padding: Double = 0.5
        /// Kept after speech. Shorter than `padding` for a reason: a span's end is only known once
        /// this much silence has been *captured*, so it bounds how soon a speculation can start,
        /// and it must not exceed `speculativePause` or the speculation would never match the tail.
        /// 0.1 with it (was 0.2): the fitted window adds ~5 s of encoded silence after the span
        /// anyway, and the harness scored the same at release + 300 ms.
        public var trailingPadding: Double = 0.1
        /// Less speech than this in a region is a click or a breath, not a word, and is not worth
        /// a decode — which is also the cheapest hallucination guard there is: whisper cannot
        /// invent "do you like?" over audio it is never given.
        public var minimumSpeech: Double = 0.1

        public init() {}
    }

    /// A stretch of audio the decoder should see, as absolute sample indices since `start`.
    public struct Span: Sendable, Equatable, CustomStringConvertible {
        /// The whole region this span was cut from — what the next span starts after.
        public let region: Range<Int>
        /// The padded speech inside it. This is what is decoded.
        public let speech: Range<Int>

        public init(region: Range<Int>, speech: Range<Int>) {
            self.region = region
            self.speech = speech
        }

        public var description: String {
            let s = { (i: Int) in String(format: "%.2f", Double(i) / Double(AudioBuffer.sampleRate)) }
            return "[\(s(speech.lowerBound))–\(s(speech.upperBound)) s]"
        }
    }

    public enum Event: Sendable, Equatable {
        /// Final: everything in `span.region` is settled and will never be re-cut.
        case commit(Span)
        /// Provisional: the speaker has gone quiet, and if they let go now this is the tail.
        case pause(Span)
    }

    public let configuration: Configuration

    private var classifier: any SpeechFrameClassifier
    private let frameSamples: Int
    private var pending: [Float] = []
    /// Per-frame decision and probability, from sample 0. Ten minutes is ~19 000 Silero frames.
    private var speechFrames: [Bool] = []
    private var levels: [Float] = []
    private var inSpeech = false
    /// First frame of the region not yet committed.
    private var regionStartFrame = 0
    /// Consecutive non-speech frames at the end, and whether this pause has already been reported.
    private var silentRun = 0
    private var pauseReported = false
    /// Speech inside the uncommitted region, kept incrementally so a frame costs O(1).
    private var regionSpeechFrames = 0
    private var regionFirstSpeech: Int?
    private var regionLastSpeech: Int?

    /// The classifier is reset here, so one Silero instance can serve every utterance.
    public init(configuration: Configuration = Configuration(),
                classifier: any SpeechFrameClassifier = EnergyFrameClassifier()) {
        self.configuration = configuration
        var classifier = classifier
        classifier.reset()
        self.classifier = classifier
        self.frameSamples = max(1, classifier.frameSamples)
    }

    /// Samples consumed so far, including a partial frame not yet analysed.
    public private(set) var sampleCount = 0

    /// Where the last frame classified as speech ends, in samples; 0 before any speech.
    public private(set) var lastSpeechEnd = 0

    /// Where the uncommitted region starts.
    public var committedUpTo: Int { regionStartFrame * frameSamples }

    private func frames(_ seconds: Double) -> Int {
        Int((seconds * Double(AudioBuffer.sampleRate) / Double(frameSamples)).rounded())
    }

    /// Feed captured audio. Returns what became decidable because of it, in order.
    public mutating func append(_ samples: some Collection<Float>) -> [Event] {
        sampleCount += samples.count
        pending.append(contentsOf: samples)
        let whole = (pending.count / frameSamples) * frameSamples
        guard whole > 0 else { return [] }
        let probabilities = classifier.probabilities(pending[0..<whole])
        pending.removeFirst(whole)
        var events: [Event] = []
        for probability in probabilities {
            if let event = analyse(probability) { events.append(event) }
        }
        return events
    }

    /// The uncommitted remainder, as the tail to decode at key-release — or nil when there is no
    /// speech in it at all, which is the case that should cost nothing. Does not commit it.
    public func tail() -> Span? {
        let end = sampleCount
        guard let speech = regionSpeech(sampleEnd: end) else { return nil }
        return Span(region: committedUpTo..<end, speech: speech)
    }

    // MARK: Frame analysis

    private mutating func analyse(_ probability: Float) -> Event? {
        levels.append(probability)
        let threshold = inSpeech ? configuration.releaseProbability
                                 : configuration.onsetProbability
        let speech = probability >= threshold
        inSpeech = speech
        speechFrames.append(speech)

        if speech {
            silentRun = 0
            pauseReported = false
            let index = speechFrames.count - 1
            lastSpeechEnd = (index + 1) * frameSamples
            regionSpeechFrames += 1
            if regionFirstSpeech == nil { regionFirstSpeech = index }
            regionLastSpeech = index
        } else {
            silentRun += 1
        }
        return decide()
    }

    private mutating func decide() -> Event? {
        let now = speechFrames.count
        let regionLength = now - regionStartFrame
        let hasSpeech = regionSpeechFrames >= frames(configuration.minimumSpeech)

        let pauseNeeded = regionLength >= frames(configuration.relaxAfter)
            ? configuration.relaxedCommitPause : configuration.commitPause
        if hasSpeech, silentRun >= frames(pauseNeeded),
           regionLength >= frames(configuration.minimumSegment) {
            // Cut `padding` after the last speech frame, but never past the middle of the pause:
            // the next segment's onset gets the other half.
            let lastSpeech = now - silentRun
            let cut = lastSpeech + min(frames(configuration.trailingPadding), silentRun / 2)
            return commit(upTo: cut, now: now)
        }

        if regionLength >= frames(configuration.maximumSegment) {
            // A long stretch with no speech is let go without a decode, so the tail stays short
            // even when the speaker says nothing for a minute.
            if !hasSpeech { _ = commit(upTo: now, now: now); return nil }
            return commit(upTo: forcedCut(now: now), now: now)
        }

        // Not before the trailing padding has been captured, either: the span reported here must
        // equal the one `tail()` gives at release, or the session cannot adopt the decode. With
        // Silero's 32 ms frames, 0.2 s rounds to 192 ms — 128 samples short of the padding —
        // and every speculation silently failed to match until this `max` (C2 §4).
        let trailFrames = Int((configuration.trailingPadding * Double(AudioBuffer.sampleRate)
                               / Double(frameSamples)).rounded(.up))
        if hasSpeech, !pauseReported,
           silentRun >= max(frames(configuration.speculativePause), trailFrames) {
            pauseReported = true
            let end = now * frameSamples
            if let speech = regionSpeech(sampleEnd: end) {
                return .pause(Span(region: committedUpTo..<end, speech: speech))
            }
        }
        return nil
    }

    /// Moves the region start to `cutFrame` and reports what was cut off, if it held speech.
    private mutating func commit(upTo cutFrame: Int, now: Int) -> Event? {
        let cut = min(now, max(regionStartFrame + 1, cutFrame))
        let region = committedUpTo..<(cut * frameSamples)
        let speech = regionSpeechFrames >= frames(configuration.minimumSpeech)
            ? speechSpan(fromFrame: regionStartFrame, toFrame: cut, sampleEnd: region.upperBound)
            : nil
        regionStartFrame = cut
        // What remains after the cut is re-counted: a forced cut can leave speech on both sides.
        regionSpeechFrames = 0
        regionFirstSpeech = nil
        regionLastSpeech = nil
        for i in cut..<now where speechFrames[i] {
            regionSpeechFrames += 1
            if regionFirstSpeech == nil { regionFirstSpeech = i }
            regionLastSpeech = i
        }
        // The pause that produced this cut is spent; the next one must be a new pause.
        pauseReported = regionSpeechFrames == 0
        guard let speech else { return nil }
        return .commit(Span(region: region, speech: speech))
    }

    /// Where to cut a segment that has run too long: the middle of the longest pause in its last
    /// third, or failing any pause, its least speech-like frame.
    private func forcedCut(now: Int) -> Int {
        let window = max(1, (now - regionStartFrame) / 3)
        let lower = now - window
        var bestStart = -1, bestLength = 0, runStart = -1
        for i in lower..<now {
            if !speechFrames[i] {
                if runStart < 0 { runStart = i }
                let length = i - runStart + 1
                if length > bestLength { bestLength = length; bestStart = runStart }
            } else {
                runStart = -1
            }
        }
        if bestLength >= 3 { return bestStart + bestLength / 2 }
        var quietest = lower
        for i in lower..<now where levels[i] < levels[quietest] { quietest = i }
        return quietest + 1
    }

    /// The padded speech in the uncommitted region, from the incremental counters.
    private func regionSpeech(sampleEnd: Int) -> Range<Int>? {
        guard regionSpeechFrames >= frames(configuration.minimumSpeech),
              let first = regionFirstSpeech, let last = regionLastSpeech else { return nil }
        return padded(first: first, last: last, regionStart: committedUpTo, sampleEnd: sampleEnd)
    }

    /// The padded speech between two frames, clamped to the region and to `sampleEnd`.
    private func speechSpan(fromFrame lower: Int, toFrame upper: Int,
                            sampleEnd: Int) -> Range<Int>? {
        guard lower < upper,
              let first = (lower..<upper).first(where: { speechFrames[$0] }),
              let last = (lower..<upper).last(where: { speechFrames[$0] }) else { return nil }
        return padded(first: first, last: last, regionStart: lower * frameSamples,
                      sampleEnd: sampleEnd)
    }

    private func padded(first: Int, last: Int, regionStart: Int, sampleEnd: Int) -> Range<Int>? {
        let lead = Int(configuration.padding * Double(AudioBuffer.sampleRate))
        let trail = Int(configuration.trailingPadding * Double(AudioBuffer.sampleRate))
        let start = max(regionStart, first * frameSamples - lead)
        let end = min(sampleEnd, (last + 1) * frameSamples + trail)
        return start < end ? start..<end : nil
    }
}
