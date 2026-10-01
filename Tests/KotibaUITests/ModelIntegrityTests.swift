import Foundation
import Testing

@testable import KotibaCore
@testable import KotibaModels
@testable import KotibaUI

private func scratch() -> UserDefaults { UserDefaults(suiteName: UUID().uuidString)! }

/// Settings that cannot see this Mac's real models directory. `AppSettings` discovers models by
/// name now, so a test using the default directory finds the author's actual Uzbek model and
/// every readiness assertion silently inverts.
@MainActor
private func isolatedSettings() -> AppSettings {
    let empty = FileManager.default.temporaryDirectory
        .appendingPathComponent("kotiba-empty-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
    return AppSettings(store: scratch(), modelDirectory: empty, modelBundle: nil)
}

// The app asserted readiness for a 539 MB model it had never looked inside. `ModelStore` — the
// module that owns model integrity, and which had no callers anywhere — now answers the question.

@Suite("A model that cannot be used says so before it is loaded")
@MainActor
struct ModelIntegrityTests {

    @Test("a truncated model is rejected, and the blocker says why")
    func truncatedModelIsNamed() async throws {
        let stub = try ModelFixture.truncated()
        defer { try? FileManager.default.removeItem(atPath: stub) }

        let settings = isolatedSettings()
        settings.uzbekModelPath = stub
        let controller = DictationController(settings: settings, devices: .testing)
        await controller.refreshBlockers()

        let blocker = try #require(controller.blockers.first { $0.id == "uzbek-model" })
        #expect(blocker.detail.contains("cannot be used"),
                "reads as \"\(blocker.detail)\"")
        #expect(blocker.detail.contains("did not finish"),
                "and names the likely cause rather than saying the file is absent")
    }

    // The distinction that was lost: never choosing a model and choosing a bad one are different
    // situations, and the fix for each is different.
    @Test("no model chosen reads differently from a bad one")
    func absentIsNotCorrupt() async {
        let controller = DictationController(settings: isolatedSettings(), devices: .testing)
        await controller.refreshBlockers()

        let blocker = controller.blockers.first { $0.id == "uzbek-model" }
        #expect(blocker?.detail.contains("needs its speech model") == true)
        #expect(blocker?.detail.contains("cannot be used") != true)
    }

    @Test("a plausible model clears the blocker")
    func goodModelIsAccepted() async throws {
        let model = try ModelFixture.plausible()
        defer { try? FileManager.default.removeItem(atPath: model) }

        let settings = isolatedSettings()
        settings.uzbekModelPath = model
        let controller = DictationController(settings: settings, devices: .testing)
        await controller.refreshBlockers()

        #expect(controller.blockers.first { $0.id == "uzbek-model" } == nil)
    }

    // Rejection has to be cheap enough to sit in front of every readiness question — that is the
    // whole reason it is four bytes and a stat rather than a hash.
    @Test("rejecting a bad model costs nothing")
    func inspectionIsCheap() throws {
        let stub = try ModelFixture.plausible(bytes: 40 * 1024 * 1024)
        defer { try? FileManager.default.removeItem(atPath: stub) }

        let clock = ContinuousClock()
        let start = clock.now
        for _ in 0..<200 { _ = ModelFile.inspect(stub) }
        let elapsed = clock.now - start

        #expect(elapsed < .milliseconds(500),
                "200 inspections of a 40 MB file took \(elapsed) — it must not be reading it all")
    }
}
