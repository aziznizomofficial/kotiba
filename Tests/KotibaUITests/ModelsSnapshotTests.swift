#if os(macOS)
import AppKit
import Foundation
import KotibaModels
import SwiftUI
import Testing

@testable import KotibaUI

// Renders the models step and the Settings card to PNGs, offscreen, for a person to look at
// without launching the app. Opt-in: `KOTIBA_SNAPSHOTS=<dir> swift test --filter ModelsSnapshot`.

nonisolated private let snapshotDirectory = ProcessInfo.processInfo.environment["KOTIBA_SNAPSHOTS"]

@Suite("Snapshots of the models step (KOTIBA_SNAPSHOTS=<dir>)",
       .enabled(if: snapshotDirectory != nil))
@MainActor
struct ModelsSnapshotTests {

    private func render<V: View>(_ name: String, _ view: V, size: CGSize) throws {
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        let window = NSWindow(contentRect: CGRect(x: -20000, y: -20000, width: size.width,
                                                  height: size.height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = .black
        window.contentView = host
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(1.2))
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let data = try #require(rep.representation(using: .png, properties: [:]))
        try data.write(to: URL(fileURLWithPath: snapshotDirectory!).appendingPathComponent(name))
        window.orderOut(nil)
    }

    @Test("the onboarding step and the Settings card, on an empty models directory")
    func render() async throws {
        let settings = AppSettings.hermetic()
        let controller = DictationController(settings: settings, devices: .testing)
        await controller.models.refresh()
        try render("models-onboarding.png",
                   OnboardingView(controller: controller, finished: {},
                                  initialStep: .languages).kotibaWindowChrome(),
                   size: CGSize(width: 1000, height: 760))
        try render("models-settings.png",
                   Pane(title: "Languages", subtitle: nil) {
                       ModelsCard(downloads: controller.models)
                   }.kotibaWindowChrome(),
                   size: CGSize(width: 780, height: 560))
        // The core card, part-way: what a DMG install shows on the last page and on Home.
        for item in [ModelDownloads.Item.uzbek, .speechDetector, .languageDetector, .parakeet] {
            controller.models.states[item] = .installed
        }
        controller.models.runItems = [.parakeet, .modes]
        controller.models.running = true   // so the card's refresh leaves the rows be
        controller.models.states[.modes] = .downloading(400_000_000)
        try render("core-onboarding.png",
                   OnboardingView(controller: controller, finished: {},
                                  initialStep: .done).kotibaWindowChrome(),
                   size: CGSize(width: 1000, height: 760))
    }
}
#endif
