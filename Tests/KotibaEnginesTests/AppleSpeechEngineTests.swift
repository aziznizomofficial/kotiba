import AVFoundation
import Foundation
import KotibaAudio
import KotibaCore
import Testing

@testable import KotibaEngines

// AVFoundation exports its own `AudioBuffer` from CoreAudioTypes, and it wins nothing here.
private typealias AudioBuffer = KotibaCore.AudioBuffer

// Band 1: everything here runs on a machine with no speech assets, no microphone and no
// network. The one test that needs a real model is gated behind KOTIBA_LIVE and is the only
// place a CI runner could ever be slow.

@Suite("Apple SpeechTranscriber engine — refusals")
struct AppleSpeechRefusalTests {

    @Test("it declares English and only English")
    func declaresEnglishOnly() {
        // Not a preference. `AssetInventory.reserve(locale: uz-UZ)` throws SFSpeechErrorDomain
        // Code=15, and Russian exists only on DictationTranscriber, which emits no punctuation
        // and no final result until end of input. Both are measured, both are disqualifying.
        let engine = AppleSpeechEngine()
        #expect(engine.supportedLanguages == [.english])
        #expect(engine.engineID == "apple-speech-transcriber")
    }

    @Test("Uzbek is refused loudly, never served badly", arguments: [Language.uzbek, .russian])
    func refusesUnsupportedLanguages(_ language: Language) async {
        // The whole project exists because the predecessor silently served Uzbek from a model
        // that could not do it. A misroute must throw, not degrade.
        let engine = AppleSpeechEngine()
        await #expect(throws: EngineFailure.languageUnsupported(
            language, engineID: "apple-speech-transcriber")) {
            _ = try await engine.transcribe(AudioBuffer(samples: [0, 0, 0]), language: language)
        }
    }

    @Test("transcribing before prepare() reports not-ready rather than crashing")
    func notReadyBeforePrepare() async throws {
        let engine = AppleSpeechEngine()
        #expect(await engine.isReady() == false)
        let error = await #expect(throws: EngineFailure.self) {
            _ = try await engine.transcribe(AudioBuffer(samples: [0.1, 0.2]), language: .english)
        }
        guard case .notReady = error else {
            Issue.record("expected .notReady, got \(String(describing: error))")
            return
        }
    }

    @Test("empty audio is an error, not an empty transcript")
    func emptyAudioThrows() async throws {
        // An empty string returned here reads downstream as a successful silent dictation —
        // v1's worst bug. The engine has to be as loud as the session guard above it.
        let engine = AppleSpeechEngine()
        guard await engine.prepareIfPossible() else { return }  // no assets on this machine
        let error = await #expect(throws: EngineFailure.self) {
            _ = try await engine.transcribe(AudioBuffer(samples: []), language: .english)
        }
        guard case .transcriptionFailed = error else {
            Issue.record("expected .transcriptionFailed, got \(String(describing: error))")
            return
        }
    }
}

@Suite("Audio conversion into the analyzer's format")
struct PCMConversionTests {

    @Test("16 kHz mono passes through untouched")
    func identityFormat() throws {
        let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                                sampleRate: 16_000, channels: 1,
                                                interleaved: false))
        let samples: [Float] = (0..<1600).map { sinf(Float($0) * 0.05) }
        let buffer = try #require(AppleSpeechEngine.pcmBuffer(
            from: AudioBuffer(samples: samples), format: format))

        #expect(buffer.frameLength == 1600)
        let channel = try #require(buffer.floatChannelData)
        for i in stride(from: 0, to: 1600, by: 97) {
            #expect(abs(channel[0][i] - samples[i]) < 1e-6)
        }
    }

    @Test("resampling upward preserves the signal's duration and its energy")
    func resamples() throws {
        // 48 kHz is what SpeechAnalyzer usually asks for on this hardware.
        let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                                sampleRate: 48_000, channels: 1,
                                                interleaved: false))
        let samples: [Float] = (0..<16_000).map { sinf(Float($0) * 0.01) }
        let buffer = try #require(AppleSpeechEngine.pcmBuffer(
            from: AudioBuffer(samples: samples), format: format))

        // One second in must be about one second out. Converters carry latency, so this checks
        // the ratio rather than an exact count.
        let outSeconds = Double(buffer.frameLength) / 48_000
        #expect(abs(outSeconds - 1.0) < 0.05, "1 s became \(outSeconds) s")

        let channel = try #require(buffer.floatChannelData)
        var peak: Float = 0
        for i in 0..<Int(buffer.frameLength) { peak = max(peak, abs(channel[0][i])) }
        #expect(peak > 0.5, "a full-scale sine came out at peak \(peak)")
    }

    @Test("an empty buffer converts to an empty buffer rather than trapping")
    func emptyConverts() throws {
        let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                                sampleRate: 16_000, channels: 1,
                                                interleaved: false))
        // AVAudioPCMBuffer accepts frameCapacity 0 and hands back a zero-length buffer, so
        // conversion cannot be the place empty audio is caught. `transcribe` rejects it first;
        // this test exists to pin the fact that the conversion itself does not crash.
        let buffer = try #require(AppleSpeechEngine.pcmBuffer(from: AudioBuffer(samples: []),
                                                             format: format))
        #expect(buffer.frameLength == 0)
    }
}

@Suite("Engine failures name what broke")
struct EngineFailureTests {

    @Test("every case produces a reason a user could act on")
    func reasonsAreUseful() {
        let cases: [EngineFailure] = [
            .notReady("prepare() has not run"),
            .languageUnsupported(.uzbek, engineID: "apple-speech-transcriber"),
            .localeUnsupported("uz-UZ"),
            .assetsUnavailable("no network"),
            .modelMissing(path: "/tmp/nope.bin"),
            .transcriptionFailed("no audio"),
        ]
        for failure in cases {
            #expect(!failure.reason.isEmpty)
            // The predecessor's errors said "an error occurred" and cost days. Every reason
            // must name the thing that broke.
            #expect(failure.reason.count > 10, "\(failure) is too vague to act on")
        }
        #expect(EngineFailure.modelMissing(path: "/tmp/nope.bin").reason.contains("/tmp/nope.bin"))
        #expect(EngineFailure.languageUnsupported(.uzbek, engineID: "e").reason.contains("uz"))
    }
}

// MARK: - Live

@Suite("Apple SpeechTranscriber — live", .enabled(if: ProcessInfo.liveEnginesEnabled))
struct AppleSpeechLiveTests {

    @Test("it transcribes real speech, and says something recognisable")
    func transcribesRealSpeech() async throws {
        let engine = AppleSpeechEngine()
        try await engine.prepare()
        #expect(await engine.isReady())

        let audio = try TestAudio.spokenEnglish()
        let transcript = try await engine.transcribe(audio, language: .english)
        let lowered = transcript.raw.lowercased()

        #expect(!transcript.raw.isEmpty)
        #expect(lowered.contains("hello"), "got: \(transcript.raw)")
        #expect(lowered.contains("tuesday"), "got: \(transcript.raw)")
        #expect(transcript.language == .english)
        #expect(transcript.engineID == "apple-speech-transcriber")
    }

    @Test("prepare() is idempotent — calling it twice does not break the engine")
    func prepareTwice() async throws {
        // A one-shot warm-up that latches failure is how the predecessor disabled itself for a
        // process lifetime. This must survive repetition.
        let engine = AppleSpeechEngine()
        try await engine.prepare()
        try await engine.prepare()
        #expect(await engine.isReady())
    }
}

// MARK: - Helpers

extension AppleSpeechEngine {
    /// Prepares, and reports whether it worked, so a Band-1 test can skip cleanly on a machine
    /// with no assets instead of failing for an unrelated reason.
    func prepareIfPossible() async -> Bool {
        do { try await prepare(); return true } catch { return false }
    }
}

extension ProcessInfo {
    static var liveEnginesEnabled: Bool {
        ProcessInfo.processInfo.environment["KOTIBA_LIVE"] == "1"
    }
}

enum TestAudio {
    /// Synthesises a clip with `say`. Deliberately generated rather than committed: a WAV of
    /// speech is a large binary that would bloat the repository forever, and the system voice
    /// is present on every machine that can run these tests at all.
    static func spokenEnglish() throws -> KotibaCore.AudioBuffer {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-tests", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let wav = directory.appendingPathComponent("en.wav")

        if !FileManager.default.fileExists(atPath: wav.path) {
            let aiff = directory.appendingPathComponent("en.aiff")
            try run("/usr/bin/say", ["-o", aiff.path,
                                     "Hello, this is a test. Schedule the meeting for Tuesday."])
            try run("/usr/bin/afconvert",
                    ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff.path, wav.path])
        }
        return AudioBuffer(samples: try WAVFile(contentsOf: wav).resampledTo16k())
    }

    private static func run(_ tool: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw EngineFailure.transcriptionFailed("\(tool) exited \(process.terminationStatus)")
        }
    }
}
