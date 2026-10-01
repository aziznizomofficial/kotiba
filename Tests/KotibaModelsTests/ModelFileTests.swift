import Foundation
import Testing

@testable import KotibaModels

// The app's only check on a 539 MB model was `FileManager.fileExists`. A half-finished download,
// or the wrong `.bin` entirely, passed it: readiness went true, the "No Uzbek model" blocker
// disappeared, and the settings row showed a green tick for a file nothing had ever opened. The
// only feedback was whisper.cpp's own guess — "the file may be truncated or not a ggml model" —
// 7.8 s into a load attempt, once per launch, forever.

@Suite("A model file is checked, not merely counted")
struct ModelFileTests {

    /// A file whose first four bytes are whisper's magic, padded to a plausible size.
    private func write(magic: UInt32?, bytes: Int) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-modelfile-\(UUID().uuidString).bin")
        var data = Data()
        if let magic {
            withUnsafeBytes(of: magic.littleEndian) { data.append(contentsOf: $0) }
        }
        data.append(Data(count: max(0, bytes - data.count)))
        try data.write(to: url)
        return url
    }

    @Test("a real ggml header at a real size is usable")
    func goodFile() throws {
        let url = try write(magic: ModelFile.ggmlMagic, bytes: 16 * 1024 * 1024)
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(ModelFile.inspect(url.path) == .usable)
        #expect(ModelFile.inspect(url.path).reason == nil)
    }

    // The case the existence check waved through, and the likeliest one in practice.
    @Test("a truncated download is named as one, not as a missing file")
    func truncated() throws {
        let url = try write(magic: ModelFile.ggmlMagic, bytes: 2 * 1024 * 1024)
        defer { try? FileManager.default.removeItem(at: url) }

        let verdict = ModelFile.inspect(url.path)
        #expect(verdict == .tooSmall(bytes: 2 * 1024 * 1024))
        #expect(verdict.reason?.contains("did not finish") == true, "\(verdict.reason ?? "nil")")
        #expect(!verdict.isUsable)
    }

    @Test("a large file that is not ggml is rejected")
    func wrongFormat() throws {
        let url = try write(magic: 0xDEAD_BEEF, bytes: 16 * 1024 * 1024)
        defer { try? FileManager.default.removeItem(at: url) }

        let verdict = ModelFile.inspect(url.path)
        #expect(verdict == .notGGML)
        #expect(verdict.reason?.contains("ggml") == true)
    }

    @Test("an absent path and an empty one are both missing, not malformed")
    func absent() {
        #expect(ModelFile.inspect("/definitely/not/here.bin") == .missing)
        #expect(ModelFile.inspect("") == .missing)
    }

    @Test("a directory is not a model")
    func directory() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-dir-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(!ModelFile.inspect(url.path).isUsable)
    }

    // Pinned against the real files this app loads: all four begin 6c 6d 67 67, which is
    // 0x67676d6c read little-endian.
    @Test("the magic is the one whisper.cpp actually writes")
    func magicIsCorrect() {
        #expect(ModelFile.ggmlMagic == 0x6767_6d6c)
        var bytes: [UInt8] = []
        withUnsafeBytes(of: ModelFile.ggmlMagic.littleEndian) { bytes.append(contentsOf: $0) }
        #expect(bytes == [0x6c, 0x6d, 0x67, 0x67])
    }
}
