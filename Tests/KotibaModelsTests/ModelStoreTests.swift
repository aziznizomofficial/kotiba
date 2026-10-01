import CryptoKit
import Foundation
import Testing

@testable import KotibaModels

private func tempRoot() -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("kotiba-models-\(UUID().uuidString)")
}

private func sha(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private struct FakeDownloader: ModelDownloader {
    var payload: Data
    var failure: (any Error)?
    let counter: Counter

    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var _n = 0
        var count: Int { lock.lock(); defer { lock.unlock() }; return _n }
        func bump() { lock.lock(); _n += 1; lock.unlock() }
    }

    func fetch(_ url: URL) async throws -> Data {
        counter.bump()
        if let failure { throw failure }
        return payload
    }
}

private func entry(_ data: Data, name: String = "test-model",
                   sha256: String? = nil) -> ModelEntry {
    ModelEntry(name: name, url: URL(string: "https://example.test/\(name).bin")!,
               sha256: sha256 ?? sha(data), destination: "\(name)/weights.bin")
}

@Suite("Model store")
struct ModelStoreTests {

    @Test("a model downloads, verifies and lands where it was asked to")
    func happyPath() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data("weights".utf8)
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: payload, counter: .init()))

        let url = try await store.ensure(entry(payload))
        #expect(FileManager.default.fileExists(atPath: url.path))
        #expect(try Data(contentsOf: url) == payload)
        #expect(await store.installedBytes() == payload.count)
    }

    @Test("an already-correct file is not re-downloaded")
    func idempotent() async throws {
        // Weights survive the weekly re-sign, so re-fetching 1.1 GB on a hunch is not free.
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data("weights".utf8)
        let counter = FakeDownloader.Counter()
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: payload, counter: counter))

        _ = try await store.ensure(entry(payload))
        _ = try await store.ensure(entry(payload))
        #expect(counter.count == 1, "the second call must not hit the network")
    }

    @Test("a corrupt download is rejected and not left on disk")
    func checksumMismatch() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: Data("wrong bytes".utf8),
                                                          counter: .init()))
        let e = entry(Data("expected bytes".utf8))

        do {
            _ = try await store.ensure(e)
            Issue.record("expected a checksum failure")
        } catch let failure as ModelStoreError {
            guard case .checksumMismatch = failure else {
                Issue.record("wrong error: \(failure)"); return
            }
            #expect(failure.reason.contains("arrived corrupt"))
        }
        #expect(await !store.isInstalled(e), "a corrupt file must not survive on disk")
    }

    @Test("a file on disk that no longer matches its checksum is refetched")
    func staleFileIsReplaced() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let good = Data("good weights".utf8)
        let counter = FakeDownloader.Counter()
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: good, counter: counter))
        let e = entry(good)

        // Plant a corrupted file where the model belongs.
        let path = await store.location(of: e)
        try FileManager.default.createDirectory(at: path.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data("truncated".utf8).write(to: path)

        _ = try await store.ensure(e)
        #expect(counter.count == 1, "the stale file must trigger a refetch")
        #expect(try Data(contentsOf: path) == good)
    }

    @Test("a download failure names the model and does not leave a partial file")
    func downloadFailure() async throws {
        struct Boom: Error {}
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: Data(), failure: Boom(),
                                                          counter: .init()))
        let e = entry(Data("x".utf8))
        do {
            _ = try await store.ensure(e)
            Issue.record("expected a failure")
        } catch let failure as ModelStoreError {
            #expect(failure.reason.contains("test-model"))
        }
        #expect(await !store.isInstalled(e))
    }

    @Test("a cancelled download is a pause, not a failure")
    func cancellationIsNotAFailure() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: Data(),
                                                          failure: CancellationError(),
                                                          counter: .init()))
        await #expect(throws: CancellationError.self) {
            _ = try await store.ensure(entry(Data("x".utf8)))
        }
    }

    @Test("every decision and refusal is recorded, because the alternative is a silent fallback")
    func notesAreKept() async throws {
        // The predecessor swallowed a directory failure by design, and every iOS dictation
        // silently ran on an engine 30x slower for weeks with nothing saying so.
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data("weights".utf8)
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: payload, counter: .init()))
        _ = try await store.ensure(entry(payload))

        let notes = await store.notes
        #expect(notes.contains { $0.contains("models root ready") })
        #expect(notes.contains { $0.contains("installed") })
        #expect(notes.contains { $0.contains(root.path) }, "which path won must be recorded")
    }

    @Test("an unwritable root fails loudly with the path and the underlying error")
    func unwritableRoot() async {
        // /dev/null/… cannot be a directory on any Unix.
        let store = ModelStore(root: URL(fileURLWithPath: "/dev/null/kotiba-models"),
                               downloader: FakeDownloader(payload: Data(), counter: .init()))
        do {
            _ = try await store.ensure(entry(Data("x".utf8)))
            Issue.record("expected a directory failure")
        } catch let failure as ModelStoreError {
            guard case .directoryUnavailable(let path, let errno) = failure else {
                Issue.record("wrong error: \(failure)"); return
            }
            #expect(path.contains("kotiba-models"))
            #expect(!errno.isEmpty, "the errno is the whole point of the message")
        } catch {
            Issue.record("wrong error type: \(error)")
        }
        let notes = await store.notes
        #expect(notes.contains { $0.contains("REFUSED") })
    }

    @Test("intermediate directories are created — the iOS installer does not make them")
    func createsIntermediates() async throws {
        // On the iPad this exact omission produced NSFileWriteNoPermissionError, which reads
        // like a permissions problem and is not one.
        let root = tempRoot().appendingPathComponent("deeply/nested/models")
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data("weights".utf8)
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: payload, counter: .init()))
        let url = try await store.ensure(entry(payload))
        #expect(FileManager.default.fileExists(atPath: url.path))
    }

    @Test("removing works, and removing something absent says so")
    func removal() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data("weights".utf8)
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: payload, counter: .init()))
        let e = entry(payload)
        _ = try await store.ensure(e)
        try await store.remove(e)
        #expect(await !store.isInstalled(e))

        do {
            try await store.remove(e)
            Issue.record("expected notInstalled")
        } catch let failure as ModelStoreError {
            #expect(failure == .notInstalled(name: "test-model"))
        }
    }

    @Test("an entry with no expected checksum installs but records the hash it got")
    func unknownChecksum() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data("weights".utf8)
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: payload, counter: .init()))
        _ = try await store.ensure(entry(payload, sha256: ""))
        let notes = await store.notes
        #expect(notes.contains { $0.contains("no expected sha256") })
        #expect(notes.contains { $0.contains(sha(payload)) },
                "so the manifest can be filled in from a real run")
    }

    @Test("streamed and in-memory hashing agree")
    func hashingAgrees() throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // Larger than the 1 MB streaming chunk, so the loop is genuinely exercised.
        let data = Data((0..<(3 * 1024 * 1024)).map { UInt8($0 % 251) })
        let file = root.appendingPathComponent("big.bin")
        try data.write(to: file)
        #expect(try ModelStore.sha256(of: file) == ModelStore.sha256(of: data))
    }
}

/// Serves `payload`, but the first attempt dies after `cut` bytes — a quit, a sleep, a dropped
/// connection — and a resumed attempt continues from the file's length, as a range request does.
private final class FlakyDownloader: ModelDownloader, @unchecked Sendable {
    let payload: Data
    let cut: Int
    private let lock = NSLock()
    private var attempts: [Bool] = []
    var resumedFlags: [Bool] { lock.withLock { attempts } }

    init(payload: Data, cut: Int) {
        self.payload = payload
        self.cut = cut
    }

    func fetch(_ url: URL) async throws -> Data { payload }

    func download(_ url: URL, to file: URL, resuming: Bool,
                  progress: DownloadProgress?) async throws {
        let first = lock.withLock { () -> Bool in
            attempts.append(resuming)
            return attempts.count == 1
        }
        if first {
            try payload.prefix(cut).write(to: file)
            progress?(Int64(cut))
            throw URLError(.networkConnectionLost)
        }
        let have = (try? Data(contentsOf: file)) ?? Data()
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: payload.dropFirst(have.count))
        try handle.close()
        progress?(Int64(payload.count))
    }
}

@Suite("Model store — interrupted downloads resume")
struct ModelStoreResumeTests {

    @Test("a download that died half way continues from where it stopped, then verifies")
    func resumes() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data((0..<4096).map { UInt8($0 % 251) })
        let downloader = FlakyDownloader(payload: payload, cut: 1500)
        let store = ModelStore(root: root, downloader: downloader)
        let model = entry(payload)

        await #expect(throws: (any Error).self) { try await store.ensure(model) }
        // The half-written body is kept: it is the resume point, not garbage.
        let partial = ModelStore.partialLocation(of: await store.location(of: model))
        #expect(FileManager.default.fileExists(atPath: partial.path))

        let progress = ProgressLog()
        let url = try await store.ensure(model, progress: { progress.add($0) })
        #expect(try Data(contentsOf: url) == payload)
        #expect(downloader.resumedFlags == [false, true], "the second attempt did not resume")
        #expect(progress.values.last == Int64(payload.count))
        #expect(!FileManager.default.fileExists(atPath: partial.path))
    }

    @Test("a resumed body that does not verify is discarded, partial and all")
    func corruptResumeIsDiscarded() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data((0..<2048).map { UInt8($0 % 13) })
        let store = ModelStore(root: root, downloader: FlakyDownloader(payload: payload, cut: 100))
        let model = entry(Data("something else entirely".utf8))
        await #expect(throws: (any Error).self) { try await store.ensure(model) }
        await #expect(throws: ModelStoreError.self) { try await store.ensure(model) }
        let partial = ModelStore.partialLocation(of: await store.location(of: model))
        #expect(!FileManager.default.fileExists(atPath: partial.path))
    }

    @Test("two callers asking for one file share one transfer")
    func sharedTransfer() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data("weights".utf8)
        let counter = FakeDownloader.Counter()
        let store = ModelStore(root: root,
                               downloader: FakeDownloader(payload: payload, counter: counter))
        let model = entry(payload)
        async let a = store.ensure(model)
        async let b = store.ensure(model)
        _ = try await (a, b)
        #expect(counter.count == 1)
    }
}

private final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var log: [Int64] = []
    var values: [Int64] { lock.withLock { log } }
    func add(_ value: Int64) { lock.withLock { log.append(value) } }
}

/// Against the real host, once, on request: `KOTIBA_NETWORK_TESTS=1 swift test --filter RealResume`.
/// Hugging Face redirects to its CDN; the range request has to survive the redirect and come
/// back 206, or the resume silently restarts (still correct, but not resumable).
@Suite("Model store — resuming against the real host",
       .enabled(if: ProcessInfo.processInfo.environment["KOTIBA_NETWORK_TESTS"] == "1"))
struct RealResumeTests {

    @Test("Silero VAD (885 KB): a third on disk, the rest by range request, sha256 matches")
    func resumesSilero() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let model = ModelCatalogue.speechDetector
        let whole = try await ModelStore(root: root.appendingPathComponent("a")).ensure(model)
        let bytes = try Data(contentsOf: whole)

        let store = ModelStore(root: root.appendingPathComponent("b"))
        let destination = await store.location(of: model)
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try bytes.prefix(bytes.count / 3).write(to: ModelStore.partialLocation(of: destination))
        let progress = ProgressLog()
        let url = try await store.ensure(model, progress: { progress.add($0) })
        #expect(try Data(contentsOf: url) == bytes)
        // The first report is where the transfer started: past the third already on disk.
        #expect((progress.values.first ?? 0) >= Int64(bytes.count / 3))
        #expect(await store.notes.contains { $0.contains("resuming") })
    }
}
