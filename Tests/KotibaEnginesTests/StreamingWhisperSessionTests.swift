import Foundation
import KotibaAudio
import KotibaCore
import Testing

@testable import KotibaEngines

private typealias AudioBuffer = KotibaCore.AudioBuffer

// C2. The streaming session's scheduling, checked without a model: a fake decoder answers with
// the length of what it was given and records every prompt, so the tests can say exactly which
// audio was decoded when, with what context, and what key-release had left to do.

private let rate = AudioBuffer.sampleRate

private func room(_ seconds: Double) -> [Float] {
    var state: UInt64 = 3
    return (0..<Int(seconds * Double(rate))).map { _ in
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return (Float(state >> 40) / Float(1 << 24) - 0.5) * 0.002
    }
}

/// Syllables over the room, as in SpeechSegmenterTests: 160 ms of tone, 40 ms of gap.
private func voice(_ seconds: Double) -> [Float] {
    var out = room(seconds)
    let period = rate / 5, on = rate * 4 / 25
    for i in out.indices where i % period < on {
        let phase = 2 * Float.pi * 220 * Float(i) / Float(rate)
        out[i] += 0.14 * sinf(phase)
    }
    return out
}

extension StreamingWhisperSession.Configuration {
    /// 3 s segments, so scheduling is exercised on seconds of audio. Production cuts at 20 s.
    static var short: Self {
        var configuration = Self()
        configuration.segmenter.minimumSegment = 3
        configuration.segmenter.relaxAfter = 8
        return configuration
    }
}

private actor FakeDecoder: SegmentDecoding {
    nonisolated let engineID = "fake"
    nonisolated let supportedLanguages: Set<Language> = [.uzbek]
    private(set) var batchCalls = 0
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        batchCalls += 1
        return Transcript(raw: "batch", language: language, engineID: engineID)
    }
    struct Call: Sendable { let seconds: Double; let prompt: String?; let beam: Int? }
    private(set) var calls: [Call] = []
    private(set) var aborted = 0
    var delay: Duration = .zero
    /// Answers for successive calls; after they run out, "w<n>" by call index.
    var scripted: [String] = []
    var failNext = 0

    func isReady() async -> Bool { true }
    func prepare() async throws {}
    var safeWindows = true
    func mixesWindowsSafely() async -> Bool { safeWindows }
    func setSafeWindows(_ v: Bool) { safeWindows = v }
    private(set) var windows: [WhisperEngine.AudioContext?] = []
    func setDelay(_ d: Duration) { delay = d }

    func script(_ answers: [String]) { scripted = answers }
    func fail(_ n: Int) { failNext = n }

    func decode(_ samples: [Float], language: Language, prompt: String?, beamSize: Int?,
                audioContext: WhisperEngine.AudioContext?,
                abort: WhisperAbort?) async throws -> WhisperEngine.Decode {
        let index = calls.count
        windows.append(audioContext)
        calls.append(Call(seconds: Double(samples.count) / Double(rate), prompt: prompt,
                          beam: beamSize))
        if delay > .zero {
            // Poll the abort flag the way whisper does between decoder steps.
            let steps = 10
            for _ in 0..<steps {
                try await Task.sleep(for: delay / steps)
                if abort?.isRaised == true {
                    aborted += 1
                    throw EngineFailure.transcriptionFailed("aborted")
                }
            }
        }
        if failNext > 0 {
            failNext -= 1
            throw EngineFailure.transcriptionFailed("scripted failure")
        }
        let text = index < scripted.count ? scripted[index] : "w\(index)"
        return .init(text: text, audioContext: 0, milliseconds: 1)
    }
}

/// Key-up with the recording the session was fed, as the pipeline hands it over.
private func release(_ session: StreamingWhisperSession) async throws -> Transcript {
    let count = await session.samplesReceived
    return try await session.finish(AudioBuffer(samples: [Float](repeating: 0, count: count)),
                                    language: .uzbek)
}

private func feed(_ session: StreamingWhisperSession, _ audio: [Float],
                  settle: Bool = true) async {
    var i = 0
    while i < audio.count {
        let end = min(i + 320, audio.count)
        await session.append(Array(audio[i..<end]))
        if settle { await session.settled() }
        i = end
    }
}

@Suite("Streaming Whisper session — scheduling, without a model")
struct StreamingWhisperSessionTests {

    @Test("speech, a pause, speech: one commit behind the speaker, one tail at release")
    func commitThenTail() async throws {
        let decoder = FakeDecoder()
        var configuration = StreamingWhisperSession.Configuration.short
        configuration.speculate = false
        configuration.hint = "Hint."
        let session = StreamingWhisperSession(engine: decoder, configuration: configuration)
        await feed(session, voice(4) + room(0.8))
        // Committed and decoded before release.
        #expect(await decoder.calls.count == 1)
        await feed(session, voice(2))
        let transcript = try await release(session)
        #expect(transcript.raw == "w0 w1")
        let calls = await decoder.calls
        #expect(calls.count == 2)
        // The tail's prompt carries the hint first, then what was already transcribed.
        #expect(calls[0].prompt == "Hint.")
        #expect(calls[1].prompt == "Hint. w0")
        let report = await session.report
        #expect(report.tail == "decoded")
        #expect(report.count(.commit) == 1)
    }

    @Test("stop talking, wait, let go: the speculation is the tail and release decodes nothing")
    func speculationBecomesTail() async throws {
        let decoder = FakeDecoder()
        let session = StreamingWhisperSession(engine: decoder, configuration: .short)
        await feed(session, voice(2) + room(0.35))
        #expect(await decoder.calls.count == 1)
        let transcript = try await release(session)
        #expect(transcript.raw == "w0")
        #expect(await decoder.calls.count == 1)   // nothing decoded after release
        #expect(await session.report.tail == "speculation")
        #expect(await session.report.tailSeconds == 0)
    }

    @Test("a commit over audio already speculated adopts it instead of decoding twice")
    func commitAdoptsSpeculation() async throws {
        let decoder = FakeDecoder()
        let session = StreamingWhisperSession(engine: decoder, configuration: .short)
        await feed(session, voice(4) + room(0.8) + voice(1) + room(0.3))
        let transcript = try await release(session)
        #expect(transcript.raw == "w0 w1")
        // Two decodes for two segments: the first speculation was adopted by its commit.
        #expect(await decoder.calls.count == 2)
        #expect(await session.report.adopted == 1)
    }

    @Test("a speculation still running at release is aborted, so the tail never queues behind it")
    func staleSpeculationIsAborted() async throws {
        let decoder = FakeDecoder()
        await decoder.setDelay(.milliseconds(400))
        let session = StreamingWhisperSession(engine: decoder, configuration: .short)
        // Not settled: the speaker resumes and lets go while the pause decode is still running.
        await feed(session, voice(2) + room(0.25), settle: false)
        try await Task.sleep(for: .milliseconds(50))
        await feed(session, voice(1), settle: false)
        await decoder.setDelay(.zero)
        let transcript = try await release(session)
        // The fake polls its flag every 40 ms, like whisper between decoder steps.
        for _ in 0..<50 where await decoder.aborted == 0 {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(await decoder.aborted == 1)
        #expect(await session.report.tail == "decoded")
        // The aborted speculation contributed nothing; the tail is the whole utterance.
        #expect(transcript.raw == "w1")
    }

    @Test("pause, more speech, let go: the pause decode is kept and only the rest is decoded")
    func prefixAtRelease() async throws {
        let decoder = FakeDecoder()
        var configuration = StreamingWhisperSession.Configuration()   // 20 s: no commit here
        configuration.hint = "Hint."
        let session = StreamingWhisperSession(engine: decoder, configuration: configuration)
        await feed(session, voice(3) + room(0.35) + voice(1.5))
        let transcript = try await release(session)
        #expect(transcript.raw == "w0 w1")
        let calls = await decoder.calls
        #expect(calls.count == 2)
        #expect(calls[1].prompt == "Hint. w0")
        // Only the audio after the pause was decoded after release.
        #expect(calls[1].seconds < 2.2)
        #expect(await session.report.tail == "prefix")
    }

    @Test("release cuts at a pause decode only where the pause lasted cutPause")
    func cutsOnlyAtLongPauses() async throws {
        // 0.12 s of silence is decoded (speculativePause 0.1) but is no cut: release decodes the
        // whole region. 0.35 s is a cut: release keeps the pause decode and decodes the rest.
        for (pause, expected) in [(0.12, "decoded"), (0.35, "prefix")] {
            let decoder = FakeDecoder()
            let session = StreamingWhisperSession(engine: decoder,
                                                  configuration: .init())
            await feed(session, voice(3) + room(pause) + voice(1.5))
            _ = try await release(session)
            #expect(await session.report.tail == expected, "pause \(pause) s")
        }
        // A short pause after a long one: the cut is still at the long one.
        let decoder = FakeDecoder()
        let session = StreamingWhisperSession(engine: decoder, configuration: .init())
        await feed(session, voice(3) + room(0.35) + voice(1.5) + room(0.12) + voice(1))
        let transcript = try await release(session)
        #expect(await session.report.tail == "prefix")
        let calls = await decoder.calls
        // Pause decodes of 3 s and 4.9 s, then only the ~2.7 s after the long pause.
        #expect(transcript.raw.hasPrefix("w0 "))
        #expect(calls.count == 3 && calls[2].seconds > 2.4 && calls[2].seconds < 3.2)
    }

    @Test("with the prefix cut off, the whole region is decoded at release")
    func noPrefixCut() async throws {
        let decoder = FakeDecoder()
        var configuration = StreamingWhisperSession.Configuration()
        configuration.cutAtLastPause = false
        let session = StreamingWhisperSession(engine: decoder, configuration: configuration)
        await feed(session, voice(3) + room(0.35) + voice(1.5))
        let transcript = try await release(session)
        #expect(transcript.raw == "w1")
        #expect(await session.report.tail == "decoded")
    }

    @Test("a segment that echoes its prompt is re-decoded without the carried text")
    func loopRecovery() async throws {
        let decoder = FakeDecoder()
        await decoder.script(["biz ertaga ertalab uchrashamiz va ishga boramiz",
                              "uchrashamiz va ishga boramiz", "keyin dam olamiz"])
        var configuration = StreamingWhisperSession.Configuration.short
        configuration.speculate = false
        configuration.hint = "Hint."
        let session = StreamingWhisperSession(engine: decoder, configuration: configuration)
        await feed(session, voice(4) + room(0.8) + voice(2))
        let transcript = try await release(session)
        #expect(transcript.raw == "biz ertaga ertalab uchrashamiz va ishga boramiz keyin dam olamiz")
        let calls = await decoder.calls
        #expect(calls.count == 3)
        #expect(calls[2].prompt == "Hint.")   // the retry drops the carried text
        #expect(await session.report.retries == 1)
    }

    @Test("one retry recovers a transient failure")
    func transientFailure() async throws {
        let decoder = FakeDecoder()
        await decoder.fail(1)
        var configuration = StreamingWhisperSession.Configuration.short
        configuration.speculate = false
        let session = StreamingWhisperSession(engine: decoder, configuration: configuration)
        await feed(session, voice(4) + room(0.8) + voice(2))
        let transcript = try await release(session)
        #expect(transcript.raw == "w1 w2")
    }

    @Test("silence only: release returns an empty transcript and decodes nothing")
    func silenceOnly() async throws {
        let decoder = FakeDecoder()
        let session = StreamingWhisperSession(engine: decoder, configuration: .short)
        await feed(session, room(3))
        let transcript = try await release(session)
        #expect(transcript.raw.isEmpty)
        #expect(await decoder.calls.isEmpty)
        #expect(await session.report.tail == "none")
    }

    @Test("cancel ends the stream: nothing it decoded can reach a later finish")
    func cancelEnds() async throws {
        let decoder = FakeDecoder()
        var configuration = StreamingWhisperSession.Configuration.short
        configuration.speculate = false
        let session = StreamingWhisperSession(engine: decoder, configuration: configuration)
        await feed(session, voice(4) + room(0.8))
        await session.cancel()
        await #expect(throws: EngineFailure.self) { _ = try await release(session) }
    }

    @Test("the recording is authoritative: what the stream did not see is appended at key-up")
    func finishAppendsTheRest() async throws {
        let decoder = FakeDecoder()
        let session = StreamingWhisperSession(engine: decoder, configuration: .short)
        let audio = voice(2) + room(0.4)
        await feed(session, Array(audio[..<16_000]))              // capture lagged by 1.4 s
        let transcript = try await session.finish(AudioBuffer(samples: audio), language: .uzbek)
        #expect(transcript.raw == "w0")
        #expect(await decoder.batchCalls == 0)
        #expect(await session.samplesReceived == audio.count)
    }

    @Test("another language, lost samples, or a stream never fed all fall back to batch")
    func batchFallbacks() async throws {
        for scenario in 0..<3 {
            let decoder = FakeDecoder()
            let session = StreamingWhisperSession(engine: decoder, configuration: .short)
            let audio = voice(2)
            if scenario != 2 { await feed(session, audio) }
            let buffer = scenario == 1 ? AudioBuffer(samples: audio, droppedSamples: 320)
                                       : AudioBuffer(samples: audio)
            let language: Language = scenario == 0 ? .russian : .uzbek
            let transcript = try await session.finish(buffer, language: language)
            #expect(transcript.raw == "batch", "scenario \(scenario)")
            #expect(await session.report.tail == "batch")
        }
    }

    @Test("a segment that fails twice sends the whole recording to batch, never a hole")
    func failureFallsBackToBatch() async throws {
        let decoder = FakeDecoder()
        await decoder.fail(2)
        var configuration = StreamingWhisperSession.Configuration.short
        configuration.speculate = false
        let session = StreamingWhisperSession(engine: decoder, configuration: configuration)
        await feed(session, voice(4) + room(0.8) + voice(2))
        #expect(try await release(session).raw == "batch")
    }

    @Test("a tail that fails to decode sends the recording to batch — never commits with a hole")
    func tailFailureFallsBackToBatch() async throws {
        // The commit decodes; the tail fails twice (the first attempt and its retry).
        let decoder = FakeDecoder()
        await decoder.script(["w0"])
        var configuration = StreamingWhisperSession.Configuration.short
        configuration.speculate = false
        let session = StreamingWhisperSession(engine: decoder, configuration: configuration)
        await feed(session, voice(4) + room(0.8))
        await decoder.fail(2)
        await feed(session, voice(2))
        #expect(try await release(session).raw == "batch")
        #expect(await session.report.tail == "batch")
    }

    @Test("a failed pause decode at release is decoded again, not pasted as nothing")
    func failedSpeculationIsRedecoded() async throws {
        let decoder = FakeDecoder()
        await decoder.fail(1)
        let session = StreamingWhisperSession(engine: decoder, configuration: .short)
        await feed(session, voice(2) + room(0.35))
        let transcript = try await release(session)
        #expect(transcript.raw == "w1")
        #expect(await session.report.tail == "decoded")
    }

    @Test("background decodes and the tail take their own beam widths")
    func beamWidths() async throws {
        let decoder = FakeDecoder()
        var configuration = StreamingWhisperSession.Configuration.short
        configuration.speculate = false
        configuration.backgroundBeamSize = 5
        configuration.tailBeamSize = 1
        let session = StreamingWhisperSession(engine: decoder, configuration: configuration)
        await feed(session, voice(4) + room(0.8) + voice(2))
        _ = try await release(session)
        let beams = await decoder.calls.map(\.beam)
        #expect(beams == [5, 1])
    }

    @Test("commits take the full window, the tail a fitted one — unless the engine cannot mix")
    func windows() async throws {
        for safe in [true, false] {
            let decoder = FakeDecoder()
            await decoder.setSafeWindows(safe)
            var configuration = StreamingWhisperSession.Configuration.short
            configuration.speculate = false
            let session = StreamingWhisperSession(engine: decoder, configuration: configuration)
                await feed(session, voice(4) + room(0.8) + voice(2))
            _ = try await release(session)
            let used = await decoder.windows
            #expect(used == (safe ? [.full, .fitted(margin: 256)] : [.full, .full]))
        }
    }

    @Test("a capture stream is consumed chunk by chunk")
    func consumesAStream() async throws {
        let decoder = FakeDecoder()
        let session = StreamingWhisperSession(engine: decoder, configuration: .short)
        let audio = voice(2) + room(0.5)
        let stream = AsyncStream<[Float]> { continuation in
            var i = 0
            while i < audio.count {
                continuation.yield(Array(audio[i..<min(i + 1_600, audio.count)]))
                i += 1_600
            }
            continuation.finish()
        }
        for await chunk in stream { await session.append(chunk) }
        let transcript = try await release(session)
        #expect(transcript.raw == "w0")
    }
}

@Suite("Whisper encoder window")
struct AudioContextTests {

    @Test("a fitted window is always a multiple of 256 — whisper.cpp does not mask the pad")
    func quantised() {
        let fit = WhisperEngine.AudioContext.fitted(margin: 64)
        #expect(fit.positions(for: 2 * 16_000) == 256)      // 100 + 64 → 256
        #expect(fit.positions(for: 10 * 16_000) == 768)     // 500 + 64 → 768
        #expect(fit.positions(for: 20 * 16_000) == 1_280)   // 1000 + 64 → 1280
        for seconds in stride(from: 0.5, through: 27, by: 0.37) {
            let n = fit.positions(for: Int(seconds * 16_000))
            #expect(n == 0 || n % 256 == 0, "\(seconds) s → \(n)")
        }
    }

    @Test("past the model's window it falls back to the full one, never beyond it")
    func capped() {
        #expect(WhisperEngine.AudioContext.fitted(margin: 64).positions(for: 26 * 16_000) == 0)
        #expect(WhisperEngine.AudioContext.full.positions(for: 16_000) == 0)
    }
}

// MARK: - Live

@Suite("Streaming Whisper session — live Uzbek", .enabled(if: UzbekModel.path != nil),
       .serialized)
struct StreamingWhisperSessionLiveTests {

    /// The committed 17.2 s harness fixture, unless `KOTIBA_UZ_CLIP` names another.
    static var clip: URL? {
        if let supplied = UzbekModel.clip { return supplied }
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<5 {
            let candidate = directory.appendingPathComponent("Scripts/measure/fixtures/0002.wav")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            directory = directory.deletingLastPathComponent()
        }
        return nil
    }

    @Test("streamed Uzbek matches the whole-utterance decode closely, and release is cheap",
          .enabled(if: clip != nil))
    func streamedMatchesWhole() async throws {
        let path = try #require(UzbekModel.path)
        let clip = try #require(Self.clip)
        let engine = WhisperEngine(modelURL: URL(fileURLWithPath: path),
                                   options: .init(flashAttention: false))
        try await engine.prepare()
        #expect(await engine.mixesWindowsSafely())
        let samples = try WAVFile(contentsOf: clip).resampledTo16k()

        let whole = try await engine.transcribe(AudioBuffer(samples: samples), language: .uzbek)

        // The production path: the slot's engine opens the stream, Silero if it is installed.
        let streaming = StreamingWhisperEngine(whisper: engine, speechDetectorURL: SileroModel.url)
        let stream = await streaming.openStream()
        let recording = samples + room(0.4)
        for start in stride(from: 0, to: recording.count, by: 320) {
            await stream.append(Array(recording[start..<min(start + 320, recording.count)]))
            await (stream as? StreamingWhisperSession)?.settled()
        }
        let clock = ContinuousClock.now
        let streamed = try await stream.finish(AudioBuffer(samples: recording), language: .uzbek)
        let elapsed = ContinuousClock.now - clock

        #expect(!streamed.raw.isEmpty)
        let a = Set(whole.raw.lowercased().split(separator: " "))
        let b = Set(streamed.raw.lowercased().split(separator: " "))
        let overlap = Double(a.intersection(b).count) / Double(max(a.count, 1))
        #expect(overlap > 0.7, "streamed: \(streamed.raw)\nwhole: \(whole.raw)")
        // The speaker paused before letting go, so the tail was speculated: release is a join.
        #expect(elapsed < .milliseconds(100), "release took \(elapsed)")
    }
}

// MARK: - Silero

/// Opt-in, like the Uzbek model: `KOTIBA_VAD_MODEL` names `ggml-silero-v6.2.0.bin`.
enum SileroModel {
    static var url: URL? {
        guard let path = ProcessInfo.processInfo.environment["KOTIBA_VAD_MODEL"],
              FileManager.default.fileExists(atPath: path) else { return nil }
        return URL(fileURLWithPath: path)
    }
}

@Suite("Silero speech detector — live", .enabled(if: SileroModel.url != nil))
struct SileroSpeechDetectorTests {

    @Test("a missing model is nil, so the caller can fall back to energy")
    func missingModel() {
        #expect(SileroSpeechDetector(modelURL: URL(fileURLWithPath: "/tmp/no-silero.bin")) == nil)
    }

    @Test("room tone is not speech, real Uzbek is, and one frame is 512 samples",
          .enabled(if: StreamingWhisperSessionLiveTests.clip != nil))
    func separatesSpeechFromRoom() throws {
        let url = try #require(SileroModel.url)
        let detector = try #require(SileroSpeechDetector(modelURL: url))
        #expect(detector.frameSamples == 512)

        let quiet = detector.probabilities(room(2)[0..<(512 * 60)])
        #expect(quiet.count == 60)
        #expect(quiet.allSatisfy { $0 < 0.35 }, "room read as speech: \(quiet.max() ?? 0)")

        detector.reset()
        let clip = try #require(StreamingWhisperSessionLiveTests.clip)
        let speech = try WAVFile(contentsOf: clip).resampledTo16k()
        let whole = (speech.count / 512) * 512
        let probabilities = detector.probabilities(speech[0..<whole])
        let voiced = probabilities.filter { $0 >= 0.5 }.count
        #expect(Double(voiced) / Double(probabilities.count) > 0.5)
    }
}

/// While routing says "not Uzbek", the session stops paying for the GPU — and still finishes
/// correctly if the route comes back to it.
@Suite("Streaming Whisper session — standing down when the audio is not Uzbek")
struct StreamingWhisperStandDownTests {

    @Test("unlikely: no speculation, commits deferred; key-up still decodes everything, in order")
    func standsDownAndCatchesUp() async throws {
        let decoder = FakeDecoder()
        let session = StreamingWhisperSession(engine: decoder, configuration: .short)
        await session.setLikely(false)
        await feed(session, voice(4) + room(0.8) + voice(2) + room(0.5))
        #expect(await decoder.calls.isEmpty, "a stood-down session decoded during the hold")
        let transcript = try await release(session)
        // The deferred commit first, then the tail — the same two pieces a likely session makes.
        #expect(transcript.raw == "w0 w1")
        #expect(await decoder.calls.count == 2)
    }

    @Test("standing back up decodes what was deferred straight away, and speculates again")
    func standsBackUp() async throws {
        let decoder = FakeDecoder()
        let session = StreamingWhisperSession(engine: decoder, configuration: .short)
        await session.setLikely(false)
        await feed(session, voice(4) + room(0.8))
        #expect(await decoder.calls.isEmpty)
        await session.setLikely(true)
        await session.settled()
        #expect(await decoder.calls.count == 1, "the deferred commit was not decoded")
        // Under the 0.5 s a commit needs, over the 0.2 s a speculation needs.
        await feed(session, voice(2) + room(0.35))
        let transcript = try await release(session)
        #expect(transcript.raw == "w0 w1")
        let report = await session.report
        #expect(report.tail == "speculation", "settled as \(report.tail): \(report.entries.map(\.kind))")
    }

    @Test("progress is the committed text and the newest pause decode, and says where speech ended")
    func progress() async throws {
        let decoder = FakeDecoder()
        let session = StreamingWhisperSession(engine: decoder, configuration: .short)
        await feed(session, voice(2) + room(0.5))
        let progress = await session.progress()
        #expect(progress?.committed == "")
        #expect(progress?.provisional == "w0")
        #expect(progress?.language == .uzbek)
        #expect((progress?.speechEnd ?? 0) > 0)
        #expect(await session.lastSpeechEnd() ?? 0 > 0)
    }
}
