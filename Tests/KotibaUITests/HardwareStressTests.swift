import Foundation
import Testing

@testable import KotibaAudio
@testable import KotibaCore
@testable import KotibaUI

// The one place the test suite still touches real audio hardware, and only when asked:
//
//     KOTIBA_HARDWARE_TESTS=1 swift test --filter HardwareStress
//
// Every other controller test runs on `Devices.testing` — a silent `ReplayMicrophone` and a sink
// that pastes nowhere — because the suite used to build ~70 real `AVAudioEngine`s per run and
// open the owner's microphone from a dozen tests. That same churn was the only thing that ever
// caught the SIGSEGV `EngineRetirement` fixes (one full run in four died in `objc_release` inside
// AVFAudio's configuration-change block, 2026-09-29), so it is kept here on purpose, as a stress
// band: many real microphones bound to the device at once, warmed, recording, and dropped while
// their configuration traffic is still arriving.
//
// It opens the microphone for a few seconds (the orange dot) and pastes nothing.

nonisolated private let hardware = ProcessInfo.processInfo.environment["KOTIBA_HARDWARE_TESTS"] == "1"

@Suite("Real microphones, many at once (KOTIBA_HARDWARE_TESTS=1)", .serialized,
       .enabled(if: hardware))
@MainActor
struct HardwareStressTests {

    private func live() -> DictationController.Devices {
        DictationController.Devices(microphone: MicrophoneSource(), sink: { NowhereSink() })
    }

    @Test("twenty controllers warm, record and go away; every engine is retired and released")
    func churn() async throws {
        let retirement = EngineRetirement.shared
        let retiredBefore = retirement.retired
        var controllers: [DictationController] = []
        for _ in 0..<20 {
            let settings = AppSettings.hermetic()
            settings.polishEnabled = false
            settings.soundFeedback = false
            settings.duckingEnabled = false
            let controller = DictationController(settings: settings, devices: live())
            controllers.append(controller)
        }
        // Warm every one — binding each input unit to the device, which is what starts the
        // configuration traffic across engines.
        // All at once: each `recheck` suspends in its own microphone's warm-up.
        let warming = controllers.map { controller in Task { await controller.recheck() } }
        for task in warming { await task.value }
        // A short real dictation on a few of them: take, stream, stop.
        for controller in controllers.prefix(5) {
            controller.press()
            try await Task.sleep(for: .milliseconds(300))
            controller.release()
            for _ in 0..<500 where controller.isRunning {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(!controller.isRunning)
        }
        // And one cancelled mid-hold, while its take is live.
        controllers[5].press()
        try await Task.sleep(for: .milliseconds(150))
        controllers[5].cancel()

        controllers.removeAll()
        // Released while traffic may still be arriving: the retirement holds each engine until
        // it has gone quiet, then lets go on its own queue.
        for _ in 0..<600 where retirement.released < retirement.retired {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(retirement.retired - retiredBefore >= 20, "not every engine was retired")
        #expect(retirement.released == retirement.retired, "some engines were never released")
    }

    @Test("one real microphone, fifty takes back to back, each streaming its chunks")
    func takes() async throws {
        let microphone = MicrophoneSource()
        await microphone.warmUp()
        guard await microphone.isWarm else {
            Issue.record("the microphone would not warm: \(await microphone.lastWarmUpError ?? "?")")
            return
        }
        for _ in 0..<50 {
            let take = microphone.take()
            try await take.start()
            let counter = Task {
                var samples = 0
                for await chunk in take.chunks { samples += chunk.count }
                return samples
            }
            try await Task.sleep(for: .milliseconds(40))
            let buffer = try await take.stop()
            let streamed = await counter.value
            #expect(streamed == buffer.samples.count,
                    "the take streamed \(streamed) samples and returned \(buffer.samples.count)")
        }
    }
}
