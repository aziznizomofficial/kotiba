import AVFoundation
import Foundation
import KotibaAudio
import KotibaCore

// The platform slice's hardware checks. Each touches real hardware for a second or two and puts
// back exactly what it found — they exist because the HAL calls under ducking and device choice
// cannot be proven any other way.
//
//   swift run kotiba-probe devices              every device, which is default, which is Bluetooth,
//                                              and which microphone Kotiba would record from
//   swift run kotiba-probe duck [--level 0.25] [--hold 0.5] [--force]
//                                              duck the default output and restore it, printing
//                                              the level before, at the bottom, and after
//   swift run kotiba-probe capture [--seconds 3] record through MicrophoneSource's take API and
//                                              count what the live stream and the take delivered

extension Probe {

    static func platformUsage() -> String {
        """
          devices                             audio devices, defaults, Bluetooth, and the
                                              microphone Kotiba would pick
          duck [--level F] [--hold S] [--force]
                                              lower the default output, hold, restore; prints
                                              before / ducked / after (≤ ~1.5 s). --force ducks
                                              even when nothing is playing
          capture [--seconds S]               record S seconds (default 3) through the take
                                              API; never asks for microphone access
        """
    }

    // MARK: devices

    static func devices() {
        let defaultIn = AudioDevices.defaultInput
        let defaultOut = AudioDevices.defaultOutput
        for device in AudioDevices.all {
            var marks: [String] = []
            if device == defaultIn { marks.append("default-in") }
            if device == defaultOut { marks.append("default-out") }
            if AudioDevices.isBluetooth(device) { marks.append("bluetooth") }
            let elements = AudioDevices.volumeElements(device)
            let volumes = elements.compactMap { e in
                AudioDevices.volume(device, element: e).map { "e\(e)=\(String(format: "%.4f", $0))" }
            }
            print(String(format: "%5d  %@", device, AudioDevices.name(device)),
                  "in:\(AudioDevices.inputChannels(device)) out:\(AudioDevices.outputChannels(device))",
                  "running:\(AudioDevices.isRunningSomewhere(device))",
                  volumes.isEmpty ? "" : "vol[\(volumes.joined(separator: " "))]",
                  marks.isEmpty ? "" : "<\(marks.joined(separator: ","))>")
        }
        for prefer in [true, false] {
            let route = InputRoute.resolve(preferBuiltInWithBluetooth: prefer)
            print("preferBuiltInMicWithBluetooth=\(prefer) → records from",
                  route.device.map(AudioDevices.name) ?? "nothing",
                  route.isBluetooth ? "(Bluetooth: engine released when idle)" : "")
        }
        let playing = AudioDevices.processesRunningOutput()
        print("processes running output:", playing.map { "\($0)" } ?? "unavailable")
    }

    // MARK: duck

    /// Makes `isPlaying` true so the ramp can be watched on a quiet machine.
    struct ForcedPlaying: OutputVolumeBackend {
        let base = HALVolumeBackend()
        func defaultOutput() -> UInt32? { base.defaultOutput() }
        func uid(_ device: UInt32) -> String? { base.uid(device) }
        func device(forUID uid: String) -> UInt32? { base.device(forUID: uid) }
        func elements(_ device: UInt32) -> [UInt32] { base.elements(device) }
        func volume(_ device: UInt32, element: UInt32) -> Float? { base.volume(device, element: element) }
        func setVolume(_ device: UInt32, element: UInt32, _ value: Float) -> Bool {
            base.setVolume(device, element: element, value)
        }
        func isPlaying(_ device: UInt32) -> Bool { true }
    }

    static func duck(_ args: [String]) async {
        var level = 0.25
        var hold = 0.5
        var force = false
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--level": i += 1; level = Double(args[safe: i] ?? "") ?? level
            case "--hold": i += 1; hold = min(1.0, Double(args[safe: i] ?? "") ?? hold)
            case "--force": force = true
            default: break
            }
            i += 1
        }
        guard let device = AudioDevices.defaultOutput else { print("no default output"); return }
        let elements = AudioDevices.volumeElements(device)
        func levels() -> String {
            elements.map { e in
                "e\(e)=" + (AudioDevices.volume(device, element: e).map { String(format: "%.6f", $0) } ?? "?")
            }.joined(separator: " ")
        }
        let before = elements.map { AudioDevices.volume(device, element: $0) }
        print("device:", AudioDevices.name(device), "elements:", elements)
        print("before: ", levels())

        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-probe-duck-\(UUID().uuidString).json")
        let backend: any OutputVolumeBackend = force ? ForcedPlaying() : HALVolumeBackend()
        let ducker = OutputDucker(backend: backend, markerURL: marker,
                                  timing: .init(startDelay: .zero, ramp: .milliseconds(160), steps: 12))
        let t0 = ContinuousClock.now
        ducker.duck(to: level)
        try? await Task.sleep(for: .milliseconds(220))
        ducker.settle()
        print("ducked: ", levels(), " decision:", ducker.decision,
              " (\(t0.duration(to: .now)) after duck())")
        try? await Task.sleep(for: .seconds(max(0, hold - 0.22)))
        ducker.restore()
        try? await Task.sleep(for: .milliseconds(260))
        ducker.settle()
        let after = elements.map { AudioDevices.volume(device, element: $0) }
        print("after:  ", levels(), " decision:", ducker.decision)
        print(after == before ? "restored exactly" : "NOT RESTORED EXACTLY")
        // Belt and braces for a probe that touched someone's volume.
        if after != before {
            for (e, v) in zip(elements, before) { if let v { AudioDevices.setVolume(device, element: e, v) } }
            print("forced back:", levels())
        }
        try? FileManager.default.removeItem(at: marker)
    }

    // MARK: capture

    static func capture(_ args: [String]) async throws {
        var seconds = 3.0
        if let i = args.firstIndex(of: "--seconds") { seconds = min(10, Double(args[safe: i + 1] ?? "") ?? 3) }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            print("microphone access is not granted to this process — not asking; skipped")
            return
        }
        let mic = MicrophoneSource()
        await mic.warmUp()
        print("warm:", await mic.isWarm, await mic.lastWarmUpError ?? "")
        let take = mic.take()
        let t0 = ContinuousClock.now
        try await take.start()
        print("armed in", t0.duration(to: .now))
        let counter = Task {
            var chunks = 0, samples = 0
            for await chunk in take.chunks { chunks += 1; samples += chunk.count }
            return (chunks, samples)
        }
        try? await Task.sleep(for: .seconds(seconds))
        let t1 = ContinuousClock.now
        let buffer = try await take.stop()
        print("stop took", t1.duration(to: .now))
        let (chunks, streamed) = await counter.value
        print(String(format: "take: %.3f s, %d samples, dropped %d, peak %.4f",
                     buffer.duration, buffer.samples.count, buffer.droppedSamples, buffer.peakAmplitude))
        print("stream: \(chunks) chunks, \(streamed) samples —",
              streamed == buffer.samples.count ? "identical count" : "MISMATCH")
    }
}
