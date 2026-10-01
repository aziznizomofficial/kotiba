import Foundation
import KotibaCore
import KotibaModels
import Testing

@testable import KotibaEngines

// Everything about the Parakeet engine that can be settled without its 632 MB of weights: what
// it claims, what it refuses, how it behaves before the model exists, and the rule by which it
// names the language it wrote. The decode itself is measured by `kotiba-probe bench`
// (Scripts/measure/en-ru), not asserted here.

private typealias AudioBuffer = KotibaCore.AudioBuffer

private func tempRoot() -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("kotiba-parakeet-\(UUID().uuidString)")
}

/// Never answers until released, so "the download is running" can be observed.
private final class GateDownloader: ModelDownloader, @unchecked Sendable {
    let fail: Bool
    init(fail: Bool) { self.fail = fail }
    func fetch(_ url: URL) async throws -> Data {
        if fail {
            throw ModelStoreError.downloadFailed(name: url.lastPathComponent, reason: "offline")
        }
        try await Task.sleep(for: .seconds(3600))
        return Data()
    }
}

@Suite("Parakeet engine, without its weights")
struct ParakeetEngineTests {

    @Test("Ultra and v3 claim English and Russian; v2 only English; none claims Uzbek")
    func languages() {
        let root = tempRoot()
        #expect(ParakeetEngine(variant: .ultra, modelsRoot: root).supportedLanguages
                == [.english, .russian])
        #expect(ParakeetEngine(variant: .v3, modelsRoot: root).supportedLanguages
                == [.english, .russian])
        #expect(ParakeetEngine(variant: .v2, modelsRoot: root).supportedLanguages == [.english])
        #expect(ParakeetEngine(modelsRoot: root).engineID == "parakeet-ultra")
    }

    @Test("Uzbek is refused loudly, as a misroute, before anything is loaded")
    func refusesUzbek() async {
        let engine = ParakeetEngine(modelsRoot: tempRoot())
        await #expect(throws: EngineFailure.languageUnsupported(.uzbek,
                                                                engineID: "parakeet-ultra")) {
            try await engine.transcribe(AudioBuffer(samples: [0.1]), language: .uzbek)
        }
    }

    @Test("transcribing before prepare says not ready rather than returning nothing")
    func notReadyBeforePrepare() async {
        let engine = ParakeetEngine(modelsRoot: tempRoot())
        #expect(await engine.isReady() == false)
        await #expect(throws: EngineFailure.self) {
            try await engine.transcribe(AudioBuffer(samples: [0.1, 0.2]), language: .english)
        }
    }

    @Test("with no weights on disk, prepare starts the download and throws at once")
    func prepareDoesNotWaitForTheDownload() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = ParakeetEngine(modelsRoot: root, downloader: GateDownloader(fail: false))
        let started = ContinuousClock().now
        do {
            try await engine.prepare()
            Issue.record("prepare succeeded with no weights")
        } catch let failure as EngineFailure {
            #expect(failure.reason.contains("downloading"), "\(failure.reason)")
        }
        #expect(ContinuousClock().now - started < .seconds(2),
                "prepare waited for a 632 MB download")
        #expect(await engine.isDownloading())
        #expect(await engine.isReady() == false)
    }

    @Test("a failed download is kept as the reason, and the next prepare says so")
    func downloadFailureIsReadable() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = ParakeetEngine(modelsRoot: root, downloader: GateDownloader(fail: true))
        await #expect(throws: EngineFailure.self) { try await engine.download() }
        #expect(await engine.failureReason()?.contains("offline") == true)
        #expect(await engine.isDownloading() == false)
        do {
            try await engine.prepare()
            Issue.record("prepare succeeded with no weights")
        } catch let failure as EngineFailure {
            #expect(failure.reason.contains("offline"), "\(failure.reason)")
        }
    }

    @Test("a load that runs long gives up on this call after the budget, and keeps loading")
    func loadBudgetBoundsTheWait() async throws {
        // Every file present at its catalogue size — sparse, so this costs no disk — but none
        // verified, so the load re-hashes, finds them wrong, and sits on a download that never
        // answers: the shape of a first-ever Neural Engine compile, as far as `prepare` can tell.
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let bundle = ModelCatalogue.parakeetUltra
        for file in bundle.files {
            let url = root.appendingPathComponent(file.destination)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: url.path, contents: nil)
            let handle = try FileHandle(forWritingTo: url)
            try handle.truncate(atOffset: UInt64(file.expectedBytes ?? 0))
            try handle.close()
        }
        let engine = ParakeetEngine(modelsRoot: root, downloader: GateDownloader(fail: false),
                                    loadBudget: .milliseconds(300))
        let started = ContinuousClock().now
        do {
            try await engine.prepare()
            Issue.record("prepare succeeded on a load that cannot finish")
        } catch let failure as EngineFailure {
            #expect(failure.reason.contains("still loading"), "\(failure.reason)")
        }
        let waited = ContinuousClock().now - started
        #expect(waited < .seconds(5), "prepare waited \(waited) on a 300 ms budget")
        #expect(await engine.isReady() == false)
    }

    @Test("the language it wrote is the script with more letters")
    func writtenLanguage() {
        #expect(ParakeetEngine.writtenLanguage(of: "Привет, как дела?", else: .english)
                == .russian)
        #expect(ParakeetEngine.writtenLanguage(of: "Hello there.", else: .russian) == .english)
        // Russian carrying English terms is still Russian.
        #expect(ParakeetEngine.writtenLanguage(
            of: "Давай сделаем deploy сегодня вечером, после code review.", else: .english)
                == .russian)
        // Nothing to go on: keep what was asked for.
        #expect(ParakeetEngine.writtenLanguage(of: "123, 456.", else: .russian) == .russian)
    }
}

// MARK: - The composite's stream

private actor Calls {
    var finished = 0
    var cancelled = 0
    var batch: [String] = []
    func finish() { finished += 1 }
    func cancel() { cancelled += 1 }
    func record(_ id: String) { batch.append(id) }
}

private struct InnerStream: TranscriptionStream {
    let calls: Calls
    let fails: Bool
    func append(_ samples: [Float]) async {}
    func finish(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        await calls.finish()
        if fails { throw EngineFailure.notReady("still downloading") }
        return Transcript(raw: "streamed", language: language, engineID: "streamer")
    }
    func cancel() async { await calls.cancel() }
}

private struct Streamer: StreamingTranscriptionEngine {
    let calls: Calls
    var fails = false
    var ready = true
    let engineID = "streamer"
    let supportedLanguages: Set<Language> = [.english, .russian]
    func isReady() async -> Bool { ready }
    func prepare() async throws {
        if !ready { throw EngineFailure.assetsUnavailable("still downloading") }
    }
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        await calls.record(engineID)
        return Transcript(raw: "batch", language: language, engineID: engineID)
    }
    func openStream() async -> any TranscriptionStream { InnerStream(calls: calls, fails: fails) }
}

private struct Plain: TranscriptionEngine {
    let calls: Calls
    let engineID: String
    let supportedLanguages: Set<Language>
    func isReady() async -> Bool { true }
    func prepare() async throws {}
    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript {
        await calls.record(engineID)
        return Transcript(raw: "from \(engineID)", language: language, engineID: engineID)
    }
}

@Suite("A family slot that streams")
struct CompositeStreamTests {
    let audio = KotibaCore.AudioBuffer(samples: [Float](repeating: 0.2, count: 16_000))

    @Test("the streaming member's stream answers when it can do the language")
    func streamingMemberAnswers() async throws {
        let calls = Calls()
        let composite = CompositeEngine([Streamer(calls: calls),
                                         Plain(calls: calls, engineID: "apple",
                                               supportedLanguages: [.english])])
        let stream = await composite.openStream()
        let transcript = try await stream.finish(audio, language: .english)
        #expect(transcript.raw == "streamed")
        #expect(await calls.batch.isEmpty)
    }

    @Test("a stream that cannot finish (model still downloading) falls back to the next member")
    func fallsBackWhenTheStreamFails() async throws {
        let calls = Calls()
        let composite = CompositeEngine([Streamer(calls: calls, fails: true, ready: false),
                                         Plain(calls: calls, engineID: "apple",
                                               supportedLanguages: [.english])])
        let stream = await composite.openStream()
        let transcript = try await stream.finish(audio, language: .english)
        #expect(transcript.engineID == "apple")
        #expect(await calls.finished == 1)
    }

    @Test("a language the streaming member cannot do cancels its stream and goes batch")
    func otherLanguageCancels() async throws {
        let calls = Calls()
        let composite = CompositeEngine([Streamer(calls: calls),
                                         Plain(calls: calls, engineID: "whisper-uz",
                                               supportedLanguages: [.uzbek])])
        let stream = await composite.openStream()
        let transcript = try await stream.finish(audio, language: .uzbek)
        #expect(transcript.engineID == "whisper-uz")
        #expect(await calls.cancelled == 1)
        #expect(await calls.finished == 0)
    }

    @Test("with no streaming member, the stream is batch in disguise")
    func noStreamingMember() async throws {
        let calls = Calls()
        let composite = CompositeEngine([Plain(calls: calls, engineID: "apple",
                                               supportedLanguages: [.english])])
        let stream = await composite.openStream()
        await stream.append([0.1, 0.2])
        let transcript = try await stream.finish(audio, language: .english)
        #expect(transcript.engineID == "apple")
    }
}
