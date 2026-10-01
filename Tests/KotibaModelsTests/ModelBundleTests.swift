import CryptoKit
import Foundation
import Testing

@testable import KotibaModels

// A Core ML model is a directory of files. These are the properties that make fetching one safe:
// every file hashed on arrival, nothing re-hashed on every load once verified, and a stamp that
// can never vouch for a bundle that is not all there.

private func sha(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// Serves a fixed body per URL and counts requests. `corrupt` makes one URL serve wrong bytes.
private final class MapDownloader: ModelDownloader, @unchecked Sendable {
    private let lock = NSLock()
    private let bodies: [URL: Data]
    private var _requests: [URL] = []
    var corrupt: URL?

    init(_ bodies: [URL: Data]) { self.bodies = bodies }

    var requests: [URL] { lock.lock(); defer { lock.unlock() }; return _requests }

    func fetch(_ url: URL) async throws -> Data {
        let bad = lock.withLock { () -> Bool in
            _requests.append(url)
            return corrupt == url
        }
        guard let body = bodies[url] else {
            throw ModelStoreError.downloadFailed(name: url.lastPathComponent, reason: "HTTP 404")
        }
        return bad ? Data("garbage".utf8) : body
    }
}

private func makeBundle(_ files: [String: Data], revision: String = "abc123")
    -> (ModelBundle, [URL: Data]) {
    var bodies: [URL: Data] = [:]
    let bundle = ModelBundle.huggingFace(
        name: "test", repo: "org/model", revision: revision, directory: "model-coreml",
        files: files.sorted { $0.key < $1.key }.map { path, data in
            (path: path, sha256: sha(data), bytes: data.count)
        })
    for entry in bundle.files {
        bodies[entry.url] = files[String(entry.destination.dropFirst("model-coreml/".count))]
    }
    return (bundle, bodies)
}

private func tempRoot() -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("kotiba-bundle-\(UUID().uuidString)")
}

@Suite("Model bundles")
struct ModelBundleTests {

    let files = [
        "Encoder.mlmodelc/weights/weight.bin": Data(repeating: 7, count: 4096),
        "Encoder.mlmodelc/model.mil": Data("program".utf8),
        "vocab.json": Data("{}".utf8),
    ]

    @Test("every file lands in upstream's layout under the bundle's directory")
    func layout() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let (bundle, bodies) = makeBundle(files)
        let store = ModelStore(root: root, downloader: MapDownloader(bodies))

        let directory = try await store.ensure(bundle)
        #expect(directory.lastPathComponent == "model-coreml")
        for (path, data) in files {
            #expect(try Data(contentsOf: directory.appendingPathComponent(path)) == data)
        }
        #expect(await store.isInstalled(bundle))
    }

    @Test("URLs are pinned to the revision, never to main")
    func pinned() {
        let (bundle, _) = makeBundle(files, revision: "deadbeef")
        for entry in bundle.files {
            #expect(entry.url.absoluteString.contains("/resolve/deadbeef/"))
        }
    }

    @Test("a verified bundle is not downloaded again, and not re-hashed either")
    func stampShortCircuits() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let (bundle, bodies) = makeBundle(files)
        let downloader = MapDownloader(bodies)
        let store = ModelStore(root: root, downloader: downloader)

        try await store.ensure(bundle)
        #expect(downloader.requests.count == files.count)
        try await store.ensure(bundle)
        #expect(downloader.requests.count == files.count, "second ensure fetched again")
        #expect(await store.notes.last?.contains("present, verified") == true)
    }

    @Test("a file that changes size behind the stamp's back is re-verified and replaced")
    func truncationIsNoticed() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let (bundle, bodies) = makeBundle(files)
        let downloader = MapDownloader(bodies)
        let store = ModelStore(root: root, downloader: downloader)
        let directory = try await store.ensure(bundle)

        let weights = directory.appendingPathComponent("Encoder.mlmodelc/weights/weight.bin")
        try Data(repeating: 7, count: 100).write(to: weights)
        try await store.ensure(bundle)
        #expect(try Data(contentsOf: weights) == files["Encoder.mlmodelc/weights/weight.bin"])
        #expect(downloader.requests.count == files.count + 1, "only the damaged file refetched")
    }

    @Test("one corrupt file fails the bundle, and no stamp is written for it")
    func corruptFileFailsWithoutStamp() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let (bundle, bodies) = makeBundle(files)
        let downloader = MapDownloader(bodies)
        downloader.corrupt = bundle.files[1].url
        let store = ModelStore(root: root, downloader: downloader)

        await #expect(throws: ModelStoreError.self) { try await store.ensure(bundle) }
        let stamp = await store.location(of: bundle).appendingPathComponent(ModelBundle.stampName)
        #expect(!FileManager.default.fileExists(atPath: stamp.path))
        #expect(!FileManager.default.fileExists(
            atPath: await store.location(of: bundle.files[1]).path),
            "the corrupt file was installed")

        // And recovery works once the source is good again.
        downloader.corrupt = nil
        try await store.ensure(bundle)
        #expect(await store.isInstalled(bundle))
    }

    @Test("a new upstream revision re-verifies instead of trusting the old stamp")
    func revisionChangeReverifies() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let (old, oldBodies) = makeBundle(files, revision: "one")
        try await ModelStore(root: root, downloader: MapDownloader(oldBodies)).ensure(old)

        var changed = files
        changed["vocab.json"] = Data("{\"a\":1}".utf8)
        let (new, newBodies) = makeBundle(changed, revision: "two")
        let downloader = MapDownloader(newBodies)
        let store = ModelStore(root: root, downloader: downloader)
        try await store.ensure(new)
        #expect(downloader.requests.map(\.lastPathComponent) == ["vocab.json"],
                "unchanged files were hashed and kept; only the changed one was fetched")
    }

    @Test("the shipped Parakeet bundle is complete enough for FluidAudio to load")
    func shippedBundleShape() {
        let bundle = ModelCatalogue.parakeetUltra
        let paths = Set(bundle.files.map { String($0.destination.dropFirst(bundle.directory.count + 1)) })
        for component in ["Preprocessor", "Encoder", "Decoder", "JointDecisionv3"] {
            #expect(paths.contains("\(component).mlmodelc/coremldata.bin"), "\(component)")
            #expect(paths.contains("\(component).mlmodelc/weights/weight.bin"), "\(component)")
        }
        #expect(paths.contains("parakeet_vocab.json"))
        #expect(bundle.files.allSatisfy { $0.sha256.count == 64 && $0.expectedBytes != nil })
        #expect(bundle.revision.count == 40, "pinned to a full commit hash")
    }
}
