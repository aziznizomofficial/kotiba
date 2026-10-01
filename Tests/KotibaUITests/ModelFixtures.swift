import Foundation
import KotibaModels

// Model stand-ins for tests.
//
// These used to be `Data("x".utf8)` — nineteen bytes standing in for 539 MB — which worked only
// because the app's readiness check was `FileManager.fileExists`. Now that a configured model is
// actually inspected, a stub has to look like one: whisper's magic in the first four bytes and a
// plausible size. That is the point of the change, so the fixtures move rather than the rule.

enum ModelFixture {

    /// A file that passes `ModelFile.inspect` — right magic, plausible size — and that
    /// whisper.cpp will still refuse to load, because everything after the header is zeros.
    /// Exactly the shape of a corrupt or half-converted model.
    static func plausible(bytes: Int = 9 * 1024 * 1024) throws -> String {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-fixture-\(UUID().uuidString).bin")
        var data = Data()
        withUnsafeBytes(of: ModelFile.ggmlMagic.littleEndian) { data.append(contentsOf: $0) }
        data.append(Data(count: max(0, bytes - data.count)))
        try data.write(to: url)
        return url.path
    }

    /// Write a plausible model to an exact path. Model *discovery* tests care about where a file
    /// is, not what is in it — but readiness now inspects the file, so a stand-in has to look like
    /// one: whisper's magic in the first four bytes and a size above the floor.
    static func writeStub(to url: URL, bytes: Int = 9 * 1024 * 1024) throws {
        var data = Data()
        withUnsafeBytes(of: ModelFile.ggmlMagic.littleEndian) { data.append(contentsOf: $0) }
        data.append(Data(count: max(0, bytes - data.count)))
        try data.write(to: url)
    }

    /// A file that does not survive inspection: real, but far too small to be a model. The case
    /// an interrupted download leaves behind.
    static func truncated() throws -> String {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-truncated-\(UUID().uuidString).bin")
        try Data("this is not a model".utf8).write(to: url)
        return url.path
    }
}
