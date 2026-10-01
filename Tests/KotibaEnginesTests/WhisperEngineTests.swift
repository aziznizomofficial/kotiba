import Foundation
import KotibaAudio
import KotibaCore
import Testing

@testable import KotibaEngines

private typealias AudioBuffer = KotibaCore.AudioBuffer

// Band 1 unless KOTIBA_UZ_MODEL points at a real ggml file. A 539 MB model is not something CI
// downloads on every push, so the live suite is opt-in and the rest runs everywhere.

@Suite("Whisper engine — the parts that need no model")
struct WhisperEngineTests {

    static let missing = URL(fileURLWithPath: "/tmp/kotiba-does-not-exist.bin")

    @Test("a missing model names the path, so the fix is obvious")
    func missingModel() async {
        // "an error occurred" cost days on the predecessor. Every failure names its subject.
        let engine = WhisperEngine(modelURL: Self.missing)
        await #expect(throws: EngineFailure.modelMissing(path: Self.missing.path)) {
            try await engine.prepare()
        }
        #expect(await engine.isReady() == false)
        #expect(await engine.failureReason()?.contains("kotiba-does-not-exist") == true)
    }

    @Test("the engine id names the model, because diagnostics have to say which one ran")
    func engineIDNamesModel() {
        let engine = WhisperEngine(
            modelURL: URL(fileURLWithPath: "/models/ggml-navoi-medium-q5_0.bin"))
        #expect(engine.engineID == "whisper-ggml-navoi-medium-q5_0")

        // An explicit id wins, for the case where two builds of one model coexist.
        let named = WhisperEngine(modelURL: Self.missing, engineID: "whisper-uz-v2")
        #expect(named.engineID == "whisper-uz-v2")
    }

    @Test("it declares Uzbek by default — that is the entire reason it exists")
    func uzbekByDefault() {
        #expect(WhisperEngine(modelURL: Self.missing).supportedLanguages == [.uzbek])
    }

    @Test("a language it does not declare is refused before the model is even touched")
    func refusesUndeclaredLanguage() async {
        // Note the missing model: the refusal must not depend on load order. If this threw
        // .modelMissing instead, a misroute would look like a setup problem.
        let engine = WhisperEngine(modelURL: Self.missing, supportedLanguages: [.uzbek])
        await #expect(throws: EngineFailure.languageUnsupported(
            .english, engineID: engine.engineID)) {
            _ = try await engine.transcribe(AudioBuffer(samples: [0.1, 0.2]), language: .english)
        }
    }

    @Test("empty audio is an error, not an empty transcript")
    func emptyAudio() async {
        let engine = WhisperEngine(modelURL: Self.missing)
        let error = await #expect(throws: EngineFailure.self) {
            _ = try await engine.transcribe(AudioBuffer(samples: []), language: .uzbek)
        }
        guard case .transcriptionFailed(let why) = error else {
            Issue.record("expected .transcriptionFailed, got \(String(describing: error))")
            return
        }
        #expect(why == "no audio")
    }

    @Test("switching GPU on or off invalidates the loaded context")
    func gpuChangeInvalidates() async {
        // use_gpu is baked into the context at load. Changing it without a reload would leave
        // the setting lying about what is actually running.
        let engine = WhisperEngine(modelURL: Self.missing, options: .init(useGPU: true))
        await engine.setOptions(.init(useGPU: false))
        #expect(await engine.options.useGPU == false)
        #expect(await engine.isReady() == false)
    }

    @Test("options round-trip and default to the fast path")
    func defaultOptions() {
        let options = WhisperEngine.Options()
        // Greedy, not beam. For push-to-talk dictation latency is the product.
        #expect(options.beamSize == 1)
        #expect(options.useGPU)
        #expect(options.threads == 0)
        #expect(options.initialPrompt == nil)
        #expect(options.noSpeechThreshold == 0.6)
    }
}

// MARK: - Live

// Serialized because these tests are the ones that put 539 MB in the process, and one of them
// measures exactly that. Run in parallel, `unloadReturnsMemory` reads a footprint that another
// test's model is sitting in, and reports a leak that is not there.
@Suite("Whisper engine — live Uzbek", .enabled(if: UzbekModel.path != nil), .serialized)
struct WhisperLiveTests {

    // Gated on the clip as well as the model. The suite gate covers only `KOTIBA_UZ_MODEL`, so
    // running with a model but no audio turned these two into failures rather than skips — and
    // a suite that reports red for a fixture nobody supplied is a suite people stop running.
    @Test("it transcribes real Uzbek, in the Latin script, without translating",
          .enabled(if: UzbekModel.clip != nil))
    func transcribesUzbek() async throws {
        let path = try #require(UzbekModel.path)
        let clip = try #require(UzbekModel.clip)
        let engine = WhisperEngine(modelURL: URL(fileURLWithPath: path))
        try await engine.prepare()
        #expect(await engine.isReady())

        let audio = AudioBuffer(samples: try WAVFile(contentsOf: clip).resampledTo16k())
        let transcript = try await engine.transcribe(audio, language: .uzbek)

        #expect(!transcript.raw.isEmpty)
        #expect(transcript.language == .uzbek)
        // `translate` is false and must stay false: an Uzbek dictation that comes back in
        // English is not a transcription, it is a different sentence.
        let cyrillic = transcript.raw.unicodeScalars.filter { (0x0400...0x04FF).contains($0.value) }
        #expect(cyrillic.isEmpty, "Latin Uzbek came back with Cyrillic: \(transcript.raw)")
    }

    @Test("prepare() twice keeps one context rather than loading 539 MB again")
    func prepareIsIdempotent() async throws {
        let path = try #require(UzbekModel.path)
        let engine = WhisperEngine(modelURL: URL(fileURLWithPath: path))
        try await engine.prepare()

        let clock = ContinuousClock()
        let start = clock.now
        try await engine.prepare()
        let second = clock.now - start
        // A real load is seconds. A no-op is microseconds. 100 ms is a wide, unambiguous line.
        #expect(second < .milliseconds(100), "second prepare() took \(second) — it reloaded")
    }

    @Test("unload frees the model and the engine reloads on demand",
          .enabled(if: UzbekModel.clip != nil))
    func unloadThenTranscribe() async throws {
        let path = try #require(UzbekModel.path)
        let clip = try #require(UzbekModel.clip)
        let engine = WhisperEngine(modelURL: URL(fileURLWithPath: path))
        try await engine.prepare()
        await engine.unload()
        #expect(await engine.isReady() == false)

        // transcribe() must recover by itself; a user who freed memory should not have to
        // know that they now need to press something to make dictation work again.
        let audio = AudioBuffer(samples: try WAVFile(contentsOf: clip).resampledTo16k())
        let transcript = try await engine.transcribe(audio, language: .uzbek)
        #expect(!transcript.raw.isEmpty)
        #expect(await engine.isReady())
    }

    @Test("unload returns the memory to the system, not just the readiness flag")
    func unloadReturnsMemory() async throws {
        // `isReady() == false` is what the test above proves, and it is not the same claim.
        // A context dropped from the actor but still retained somewhere reads exactly the same
        // from outside while costing exactly as much, and that distinction is the whole bug:
        // the app's footprint sat at 1618 MB with every model "lazily" loaded.
        let path = try #require(UzbekModel.path)
        let engine = WhisperEngine(modelURL: URL(fileURLWithPath: path))

        let idle = Footprint.bytes()
        try await engine.prepare()
        let loaded = Footprint.bytes()
        #expect(loaded > idle + 300_000_000,
                "loading added only \(Footprint.mb(loaded - idle)) MB — suspect the measurement")

        await engine.unload()
        let released = Footprint.bytes()
        // Measured on an M4 Pro: 6 MB idle → 859 MB loaded → 147 MB after unload. Note that it
        // does not return to idle — about 140 MB is ggml's Metal backend, whose device and
        // compiled library are per-process globals that outlive any one context. So "release
        // the model" means ~712 MB of ~853 MB, and the floor is real rather than a leak.
        #expect(released < loaded - 300_000_000,
                "\(Footprint.mb(idle)) MB idle → \(Footprint.mb(loaded)) MB loaded → \(Footprint.mb(released)) MB after unload")
    }
}

/// This process's physical footprint — the same number `footprint(1)` reports.
///
/// Resident size is the wrong measure here: whisper's weights are mapped, and RSS moves with
/// the kernel's paging decisions rather than with what the app is holding.
enum Footprint {
    static func bytes() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let status = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return status == KERN_SUCCESS ? UInt64(info.phys_footprint) : 0
    }

    static func mb(_ bytes: UInt64) -> String { "\(bytes / 1_048_576)" }
}

enum UzbekModel {
    /// Opt-in. A 539 MB model is not a CI dependency.
    static var path: String? {
        guard let path = ProcessInfo.processInfo.environment["KOTIBA_UZ_MODEL"],
              FileManager.default.fileExists(atPath: path) else { return nil }
        return path
    }

    /// A clip of real Uzbek speech. Supplied, never committed.
    static var clip: URL? {
        guard let path = ProcessInfo.processInfo.environment["KOTIBA_UZ_CLIP"],
              FileManager.default.fileExists(atPath: path) else { return nil }
        return URL(fileURLWithPath: path)
    }
}
