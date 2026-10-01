import Foundation
import Testing

@testable import KotibaModels

// Two copies of a URL and a hash is exactly how `ClusterMass.defaultThreshold` came to hold 0.5
// while the value the app actually shipped was 0.05 — measured, correct, and living somewhere
// else. `Scripts/Manifest.json` is what `make bootstrap` fetches from and what docs/RECOVERY.md
// cites; the Swift catalogue must agree with it, and this is what makes that true rather than
// hoped for.

@Suite("The catalogue and the manifest are the same list")
struct ModelCatalogueManifestTests {

    /// Walk up from this file to the repo root. The manifest is not a bundled resource — it is a
    /// build-time artefact — so the test reads it from source rather than from `Bundle.module`.
    private static var manifestURL: URL? {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = directory.appendingPathComponent("Scripts/Manifest.json")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            directory = directory.deletingLastPathComponent()
        }
        return nil
    }

    private struct Manifest: Decodable {
        struct Entry: Decodable {
            var name: String
            var dest: String
            var url: URL?
            var sha256: String
            var bytes: Int?
            var publicAsset: String?
            enum CodingKeys: String, CodingKey {
                case name, dest, url, sha256, bytes
                case publicAsset = "public_asset"
            }
        }
        var models: [Entry]
        var publicModelsBase: String?
        enum CodingKeys: String, CodingKey {
            case models, bundles
            case publicModelsBase = "public_models_base"
        }
        struct Bundle: Decodable {
            struct File: Decodable { var path: String; var sha256: String; var bytes: Int }
            var name: String
            var directory: String
            var repo: String
            var revision: String
            var bootstrap: Bool
            var files: [File]
        }
        var bundles: [Bundle]
    }

    private func manifest() throws -> Manifest {
        let url = try #require(Self.manifestURL, "Scripts/Manifest.json not found from #filePath")
        return try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: url))
    }

    @Test("every downloadable entry matches the manifest byte for byte")
    func catalogueMatchesManifest() throws {
        let manifest = try manifest()
        for entry in ModelCatalogue.downloadable {
            let match = try #require(manifest.models.first { $0.dest == entry.destination },
                                     "\(entry.destination) is not in Scripts/Manifest.json")
            #expect(entry.sha256 == match.sha256, "\(entry.name): sha256 has drifted")
            // An entry published through public_models_base carries no url of its own.
            let url = match.url ?? manifest.publicModelsBase.flatMap {
                URL(string: $0 + (match.publicAsset ?? ""))
            }
            #expect(entry.url == url, "\(entry.name): url has drifted")
            #expect(entry.expectedBytes == match.bytes, "\(entry.name): size has drifted")
            #expect(entry.name == match.name, "\(entry.name): name has drifted")
        }
    }

    @Test("every Core ML bundle matches the manifest file for file, and Ultra is bootstrapped")
    func bundlesMatchManifest() throws {
        let manifest = try manifest()
        for bundle in [ModelCatalogue.parakeetUltra, ModelCatalogue.parakeetV3,
                       ModelCatalogue.parakeetV2] {
            let match = try #require(manifest.bundles.first { $0.directory == bundle.directory },
                                     "\(bundle.directory) is not in Scripts/Manifest.json")
            #expect(match.name == bundle.name)
            #expect(match.revision == bundle.revision)
            #expect(match.files.count == bundle.files.count, "\(bundle.name): file list drifted")
            for (file, entry) in zip(match.files, bundle.files) {
                #expect(entry.destination == "\(bundle.directory)/\(file.path)")
                #expect(entry.sha256 == file.sha256, "\(file.path): sha256 drifted")
                #expect(entry.expectedBytes == file.bytes, "\(file.path): size drifted")
                #expect(entry.url.absoluteString == "https://huggingface.co/\(match.repo)/resolve/"
                        + "\(match.revision)/\(file.path)")
            }
        }
        #expect(manifest.bundles.first { $0.directory == ModelCatalogue.parakeetUltra.directory }?
            .bootstrap == true, "the shipped engine must be restorable with `make bootstrap`")
    }

    // C2. The Uzbek engine has a catalogue entry now, ready for the day the repository is public,
    // and it must agree with the manifest `make bootstrap` fetches from exactly as the others do —
    // including while it is held back from `downloadable`.
    @Test("the Uzbek engine's entry matches the manifest, and is offered only once public")
    func uzbekEngineEntry() throws {
        let manifest = try manifest()
        let entry = ModelCatalogue.uzbekEngine
        let match = try #require(manifest.models.first { $0.dest == entry.destination })
        #expect(entry.sha256 == match.sha256)
        let base = try #require(manifest.publicModelsBase)
        #expect(ModelCatalogue.publicModelsBase.absoluteString == base,
                "the one public-models constant has drifted from Scripts/Manifest.json")
        #expect(match.url == nil && match.publicAsset != nil,
                "the Uzbek build must resolve through public_models_base, not its own url")
        #expect(entry.url.absoluteString == base + (match.publicAsset ?? ""))
        #expect(entry.expectedBytes == match.bytes)
        #expect(entry.name == match.name)
        #expect(ModelCatalogue.settingKey(for: entry) == .uzbekModel)
        #expect(ModelCatalogue.downloadable.contains(entry) == ModelCatalogue.uzbekEngineIsPublic)
    }

    @Test("the Silero speech detector's entry matches the manifest")
    func speechDetectorEntry() throws {
        let manifest = try manifest()
        let entry = ModelCatalogue.speechDetector
        let match = try #require(manifest.models.first { $0.dest == entry.destination })
        #expect(entry.sha256 == match.sha256)
        #expect(entry.url == match.url)
        #expect(entry.expectedBytes == match.bytes)
        #expect(entry.name == match.name)
    }

    @Test("no shipped model comes from a private route only: the navoi build is gone")
    func nothingPrivateOnly() throws {
        let manifest = try manifest()
        #expect(!manifest.models.contains { $0.dest == "ggml-navoi-medium-q5_0.bin" })
        for entry in manifest.models {
            #expect(entry.url != nil || entry.publicAsset != nil,
                    "\(entry.name) has no public route")
        }
    }

    @Test("every downloadable entry is routed to a setting")
    func everyEntryHasAHome() {
        for entry in ModelCatalogue.downloadable {
            #expect(ModelCatalogue.settingKey(for: entry) != nil,
                    "\(entry.name) would download and then be forgotten")
        }
    }

    @Test("hashes are full-length lowercase hex, so a truncated paste cannot pass")
    func hashesAreWellFormed() {
        for entry in ModelCatalogue.downloadable {
            #expect(entry.sha256.count == 64, "\(entry.name): \(entry.sha256)")
            #expect(entry.sha256 == entry.sha256.lowercased())
            #expect(entry.sha256.allSatisfy { $0.isHexDigit })
        }
    }
}
