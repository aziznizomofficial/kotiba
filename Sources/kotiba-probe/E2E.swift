import Foundation
import KotibaAudio
import KotibaCore
import KotibaUI
import Synchronization

// `kotiba-probe e2e` — key-release → text inserted, through the app's own controller.
//
// Every other latency in the docs times one component: an engine's decode, a stream's tail, a
// mode's sentence. This times what the user waits for. It builds the real `DictationController`
// — the same engines, router, streams, early routing, sentence polish, normaliser, guards and
// ordered paste as the installed app — and swaps exactly two things: the microphone becomes a
// `ReplayMicrophone` that plays a WAV into the take at the hardware's own 20 ms cadence, on the
// wall clock, and the paste becomes a sink that records when it was called. Then it presses the
// key, waits for the clip to finish playing plus a release delay, releases, and times release →
// insert.
//
//   kotiba-probe e2e --manifest clips.jsonl --models DIR --modes super,message,note,transcription
//                   [--trail 0,300] [--uz-model P] [--ru-model P] [--detector P] [--pin xx]
//                   [--warm N] [--no-early] [--route-early] [--optional tr,ar] --out results.jsonl
//
// `--optional tr,ar` turns the optional dictation languages on (D-11) beside the core three;
// `--languages en,ru` sets exactly which languages are on (`AppSettings.enabledLanguages`), as the
// Languages pane's switches do. Cohere is found in `--models` by its file name like any model.
//
// The manifest is `{id, wav, lang}` per line (lang is the truth, used only for the report). The
// controller's diagnostics and history are OFF — nothing is written to the owner's Application
// Support — and its settings live in a scratch defaults suite that is deleted afterwards.
//
// Real time is load-bearing: work done during the hold is what key-up does not have to do, so a
// faster-than-real-time replay would measure a machine that does not exist. The 1-minute load
// average is recorded on every row, because this Mac is shared.

extension Probe {

    struct E2EItem: Decodable {
        var id: String
        var wav: String
        var lang: String
    }

    static func e2e(_ args: [String]) async throws {
        var manifest: String?
        var out: String?
        var models: String?
        var modes = ["super"]
        var trails = [0, 300]
        var uzModel: String?
        var ruModel: String?
        var detector: String?
        var pin: Language?
        var warm = 1
        var early = true
        var routeEarly = false
        var limit = Int.max
        var memory = false
        var optional: [Language] = []
        var tunings: [@Sendable (inout DictationSession.Config) -> Void] = []
        var turboSegment: Double?
        var arabicSegment: Double?
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--manifest": i += 1; manifest = args[safe: i]
            case "--out": i += 1; out = args[safe: i]
            case "--models": i += 1; models = args[safe: i]
            case "--modes":
                i += 1
                modes = (args[safe: i] ?? "").split(separator: ",").map(String.init)
            case "--trail":
                i += 1
                trails = (args[safe: i] ?? "").split(separator: ",").compactMap { Int($0) }
            case "--uz-model": i += 1; uzModel = args[safe: i]
            case "--ru-model": i += 1; ruModel = args[safe: i]
            case "--detector": i += 1; detector = args[safe: i]
            case "--pin": i += 1; pin = Language(rawValue: args[safe: i] ?? "")
            case "--optional":
                i += 1
                optional = Array(Language.core) + (args[safe: i] ?? "").split(separator: ",")
                    .compactMap { Language(rawValue: String($0)) }
            case "--languages":
                i += 1
                optional = (args[safe: i] ?? "").split(separator: ",")
                    .compactMap { Language(rawValue: String($0)) }
            case "--warm": i += 1; warm = Int(args[safe: i] ?? "1") ?? 1
            case "--limit": i += 1; limit = Int(args[safe: i] ?? "") ?? limit
            case "--no-early": early = false
            case "--route-early": routeEarly = true
            // Footprint at each residency step instead of latency; see `memoryRun`.
            case "--memory": memory = true
            // Pipeline variants, for measuring them against each other.
            case "--no-uz-pause-detect": tunings.append { $0.detectAtPauseOnUzbek = false }
            case "--no-uz-prime": tunings.append { $0.primeOnUzbek = false }
            // `--turbo-segment MIN`: turbo's commit length (min, max = min + 4, relax = min + 2),
            // for the Turkish commit-length measurement (C4 §13). 20 is the shipped default.
            // Every dictation as a user who has never dictated Turkish (the controller counts
            // the run's own Turkish dictations otherwise, from the warm-up on).
            case "--turkish-unfamiliar": tunings.append { $0.turkishFamiliar = false }
            case "--arabic-familiar": tunings.append { $0.arabicFamiliar = true }
            case "--turbo-segment":
                i += 1
                turboSegment = Double(args[safe: i] ?? "")
            // `--arabic-segment MIN`: Arabic's commit length, the same way (C4 §14.4).
            case "--arabic-segment":
                i += 1
                arabicSegment = Double(args[safe: i] ?? "")
            case "--arabic-unfamiliar": tunings.append { $0.arabicFamiliar = false }
            case "--no-ar-prime-last": tunings.append { $0.primeLastOnArabic = false }
            default: throw ProbeError.usage("e2e: unknown argument \(args[i])")
            }
            i += 1
        }
        guard let manifest, let out, let models else {
            throw ProbeError.usage("e2e needs --manifest M.jsonl --models DIR --out O.jsonl")
        }
        let items = try String(contentsOfFile: manifest, encoding: .utf8)
            .split(separator: "\n").prefix(limit)
            .map { try JSONDecoder().decode(E2EItem.self, from: Data($0.utf8)) }
        FileManager.default.createFile(atPath: out, contents: nil)
        guard let output = FileHandle(forWritingAtPath: out) else {
            throw ProbeError.usage("cannot write \(out)")
        }

        let suite = "kotiba-probe-e2e-\(ProcessInfo.processInfo.processIdentifier)"
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        try await MainActor.run {
            try Self.runE2E(items: items, output: output, models: models, modes: modes,
                            trails: trails, uzModel: uzModel, ruModel: ruModel,
                            detector: detector, pin: pin, warm: warm, early: early,
                            routeEarly: routeEarly, suite: suite, memory: memory,
                            optional: optional, tunings: tunings, turboSegment: turboSegment,
                            arabicSegment: arabicSegment)
        }
        await E2ERun.shared.wait()
        try output.close()
        // ggml's Metal devices assert in their static destructors if anything is still loaded;
        // the app leaves with `_exit` for the same reason (AppDelegate.applicationWillTerminate).
        _exit(0)
    }

    @MainActor
    private static func runE2E(items: [E2EItem], output: FileHandle, models: String,
                               modes: [String], trails: [Int], uzModel: String?,
                               ruModel: String?, detector: String?, pin: Language?, warm: Int,
                               early: Bool, routeEarly: Bool, suite: String,
                               memory: Bool = false, optional: [Language] = [],
                               tunings: [@Sendable (inout DictationSession.Config) -> Void] = [],
                               turboSegment: Double? = nil,
                               arabicSegment: Double? = nil
    ) throws {
        guard let store = UserDefaults(suiteName: suite) else {
            throw ProbeError.usage("no scratch defaults")
        }
        let settings = AppSettings(store: store, modelDirectory: URL(fileURLWithPath: models),
                                   modelBundle: nil)
        settings.keepHistory = false
        settings.diagnosticsEnabled = false
        settings.soundFeedback = false
        settings.duckingEnabled = false
        settings.modeFollowsApp = false
        settings.hasCompletedOnboarding = true
        settings.autoDownloadModels = false
        settings.cloudPolish = false
        settings.preloadAllLanguages = true
        settings.pinnedLanguage = pin
        // Empty (no flag): the shipped default, the core three.
        if !optional.isEmpty { settings.enabledLanguages = LanguageSubset(optional).ordered }
        if let uzModel { settings.uzbekModelPath = uzModel }
        if let ruModel { settings.russianModelPath = ruModel }
        if let detector { settings.detectorModelPath = detector }

        let microphone = ReplayMicrophone()
        let sink = TimingSink()
        let controller = DictationController(
            settings: settings,
            devices: .init(microphone: microphone, sink: { sink }))
        controller.sessionTuning = { config in
            if !early { config.earlyRouting = nil }
            if routeEarly { config.earlyRouting?.detectAtRelease = false }
            for tune in tunings { tune(&config) }
        }
        if let arabicSegment {
            controller.arabicStreamingTuning = { streaming in
                streaming.segmenter.minimumSegment = arabicSegment
                streaming.segmenter.maximumSegment = arabicSegment + 4
                streaming.segmenter.relaxAfter = arabicSegment + 2
            }
        }
        if let turboSegment {
            controller.turboStreamingTuning = { streaming in
                streaming.segmenter.minimumSegment = turboSegment
                streaming.segmenter.maximumSegment = turboSegment + 4
                streaming.segmenter.relaxAfter = turboSegment + 2
            }
        }
        let run = E2ERun.shared
        if memory {
            run.task = Task { @MainActor in
                await memoryRun(controller, microphone, sink, items: items, output: output)
            }
            return
        }
        run.task = Task { @MainActor in
            await controller.start()
            try? FileHandle.standardError.write(contentsOf: Data(
                "e2e: controller started; blockers: \(controller.blockers.map(\.id))\n".utf8))
            for mode in modes {
                controller.setMode(mode)
                for trail in trails {
                    var warmed: Set<String> = []
                    for item in items {
                        var samples: [Float]
                        do {
                            samples = try WAVFile(contentsOf: URL(fileURLWithPath: item.wav))
                                .resampledTo16k()
                            // FLEURS English is recorded at peaks of 0.004–0.03, under the
                            // session's 0.012 silence gate; a real dictation peaks near 0.13 (the
                            // app's own diagnostics). Every clip is brought to a 0.3 peak, which
                            // no engine here is sensitive to and the gate needs.
                            let peak = samples.reduce(Float(0)) { max($0, abs($1)) }
                            if peak > 0 { samples = samples.map { $0 * (0.3 / peak) } }
                            // And cut where the speech ends, so `--trail N` means exactly "let go
                            // N ms after the last word" — FLEURS clips carry 0.3–1 s of silence
                            // of their own, which made every release a paused one.
                            samples = Self.trimTrailingSilence(samples)
                        } catch {
                            try? FileHandle.standardError.write(contentsOf: Data("skip \(item.id): \(error)\n".utf8))
                            continue
                        }
                        // The first clips of each language load and compile what they touch;
                        // they are run and not reported.
                        while warmed.filter({ $0.hasPrefix(item.lang + ":") }).count < warm {
                            warmed.insert("\(item.lang):\(warmed.count)")
                            let w = await dictate(controller, microphone, sink, samples,
                                                  trail: trail)
                            try? FileHandle.standardError.write(contentsOf: Data(
                                "warm \(item.id): \(w.record?.outcome ?? "?") \(w.releaseMillis ?? -1) ms\n".utf8))
                        }
                        let row = await dictate(controller, microphone, sink, samples, trail: trail)
                        var line: [String: Any] = [
                            "id": item.id, "lang": item.lang, "mode": mode, "trail": trail,
                            "early": early, "route_early": routeEarly,
                            "dur": Double(samples.count) / 16_000,
                            "release_ms": row.releaseMillis ?? -1,
                            "load1": Memory.load1(), "text": row.text ?? "",
                        ]
                        if let record = row.record {
                            line["record_release_ms"] = record.releaseToInsertMillis ?? -1
                            line["stages"] = record.stageMillis
                            line["tail"] = record.tail ?? ""
                            line["route"] = record.route?.language.rawValue ?? ""
                            line["route_source"] = record.route?.source.rawValue ?? ""
                            line["unified_doubt"] = record.unifiedDoubt ?? ""
                            line["mass"] = record.route?.turkicMass ?? -1
                            line["early_route"] = record.earlyRoute?.language.rawValue ?? ""
                            line["early_s"] = record.earlyRouteSeconds ?? 0
                            line["live_sentences"] = record.liveSentences ?? -1
                            line["outcome"] = record.outcome
                            line["errors"] = record.errors
                            line["engine"] = record.engineID ?? ""
                            line["turkish_share"] = record.route?.turkishShare ?? -1
                            line["arabic_share"] = record.route?.arabicShare ?? -1
                            line["turkish_verified"] = record.route?.turkishVerified ?? -1
                            line["arabic_verified"] = record.route?.arabicVerified ?? -1
                            line["turkish_wait_ms"] = record.turkishCheckWaitMillis ?? 0
                        }
                        if let data = try? JSONSerialization.data(withJSONObject: line,
                                                                  options: [.sortedKeys]) {
                            // `write(_:)` raises an Objective-C exception on a full disk, which
                            // ends the run; this one throws, and the row is retried once.
                            if (try? output.write(contentsOf: data + Data("\n".utf8))) == nil {
                                try? await Task.sleep(for: .seconds(5))
                                try? output.write(contentsOf: data + Data("\n".utf8))
                            }
                        }
                        try? FileHandle.standardError.write(contentsOf: Data(String(
                            format: "%@ %@ %@ t%d  %.1fs  release→insert %.0f ms  tail=%@\n",
                            item.lang, mode, item.id, trail, Double(samples.count) / 16_000,
                            row.releaseMillis ?? -1, row.record?.tail ?? "-").utf8))
                    }
                }
            }
        }
    }

    /// One press → hold → release, returning release → insert and the record.
    @MainActor
    private static func dictate(_ controller: DictationController, _ microphone: ReplayMicrophone,
                                _ sink: TimingSink, _ samples: [Float],
                                trail: Int) async -> (releaseMillis: Double?, text: String?,
                                                      record: DictationRecord?) {
        microphone.enqueue(samples)
        sink.reset()
        let before = controller.lastRecord?.startedAt
        controller.press()
        // Wait for the take to start playing, then for the clip and the release delay.
        let clock = ContinuousClock()
        for _ in 0..<2000 where microphone.lastTakeStarted == nil {
            try? await Task.sleep(for: .milliseconds(1))
        }
        let started = microphone.lastTakeStarted ?? clock.now
        let hold = Double(samples.count) / 16_000 + Double(trail) / 1000
        try? await Task.sleep(until: started + .milliseconds(Int(hold * 1000)), clock: .continuous)
        let released = clock.now
        controller.release()
        // Until the dictation has settled — pasted or not.
        for _ in 0..<6000 where controller.isRunning {
            try? await Task.sleep(for: .milliseconds(1))
        }
        let inserted = sink.inserted
        let record = controller.lastRecord?.startedAt == before ? nil : controller.lastRecord
        let millis = inserted.map { Double(($0.at - released).components.attoseconds) / 1e15
            + Double(($0.at - released).components.seconds) * 1000 }
        // Let the machine breathe between dictations the way a person does.
        try? await Task.sleep(for: .milliseconds(300))
        return (millis, inserted?.text, record)
    }
}

extension Probe {
    /// Drops trailing 20 ms frames whose RMS is under 3 % of the clip's peak — room tone — and
    /// keeps 60 ms after the last loud one, the decay of the final consonant.
    static func trimTrailingSilence(_ samples: [Float]) -> [Float] {
        let frame = 320
        let peak = samples.reduce(Float(0)) { max($0, abs($1)) }
        guard peak > 0, samples.count > frame else { return samples }
        var end = samples.count
        while end > frame {
            let slice = samples[(end - frame)..<end]
            let rms = (slice.reduce(Float(0)) { $0 + $1 * $1 } / Float(frame)).squareRoot()
            if rms >= 0.03 * peak { break }
            end -= frame
        }
        return Array(samples.prefix(min(samples.count, end + 3 * frame)))
    }
}

extension Probe {
    /// Memory at each step of the residency policy, through the real controller: launch (the
    /// detector and Parakeet resident), after an English dictation, after an Uzbek one (the
    /// Uzbek whisper model and a Silero instance), after a Message dictation (the modes model),
    /// and after the idle release. Each step records the process's `phys_footprint`, what
    /// `footprint` and `vmmap --summary` say about it, and system-wide wired memory — Parakeet's
    /// weights live on the Neural Engine, wired outside the footprint (C1 §6).
    @MainActor
    static func memoryRun(_ controller: DictationController, _ microphone: ReplayMicrophone,
                          _ sink: TimingSink, items: [E2EItem], output: FileHandle) async {
        func step(_ name: String) async {
            try? await Task.sleep(for: .seconds(2))
            let pid = ProcessInfo.processInfo.processIdentifier
            let row: [String: Any] = [
                "step": name, "phys_footprint_mb": Memory.footprintMB(),
                "footprint": run("/usr/bin/footprint", ["-p", "\(pid)"])
                    .split(separator: "\n").filter { $0.contains("Footprint") || $0.contains("phys") }
                    .map(String.init),
                "vmmap": run("/usr/bin/vmmap", ["--summary", "\(pid)"])
                    .split(separator: "\n").filter { $0.contains("Physical footprint") }
                    .map(String.init),
                "wired_mb": wiredMB(), "load1": Memory.load1(),
            ]
            if let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) {
                try? output.write(contentsOf: data + Data("\n".utf8))
            }
            try? FileHandle.standardError.write(contentsOf: Data(
                "memory \(name): \(Int(Memory.footprintMB())) MB footprint, wired \(Int(wiredMB())) MB\n".utf8))
        }
        func clip(_ lang: String) -> [Float] {
            guard let item = items.first(where: { $0.lang == lang }),
                  var samples = try? WAVFile(contentsOf: URL(fileURLWithPath: item.wav))
                      .resampledTo16k() else { return [] }
            let peak = samples.reduce(Float(0)) { max($0, abs($1)) }
            if peak > 0 { samples = samples.map { $0 * (0.3 / peak) } }
            return samples
        }
        // The shipped default, not the latency harness's warm start: whisper loads on demand.
        controller.settings.preloadAllLanguages = false
        await step("before start")
        await controller.start()
        for _ in 0..<600 where await !controller.unifiedEngineStatus().ready {
            try? await Task.sleep(for: .milliseconds(100))
        }
        await step("launched: detector + Parakeet resident")
        controller.setMode("super")
        _ = await dictate(controller, microphone, sink, clip("en"), trail: 300)
        await step("after an English dictation")
        _ = await dictate(controller, microphone, sink, clip("uz"), trail: 300)
        await step("after an Uzbek dictation (+ Uzbek whisper)")
        controller.setMode("message")
        _ = await dictate(controller, microphone, sink, clip("en"), trail: 300)
        await step("after a Message dictation (+ Qwen)")
        await controller.releaseModels()
        await step("idle release (whisper + Qwen given back; Parakeet + detector kept)")
    }

    static func run(_ tool: String, _ arguments: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do { try process.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    /// System-wide wired memory, from `vm_stat`.
    static func wiredMB() -> Double {
        let text = run("/usr/bin/vm_stat", [])
        let pageSize = Double(getpagesize())
        for line in text.split(separator: "\n") where line.hasPrefix("Pages wired down") {
            let digits = line.filter(\.isNumber)
            return (Double(digits) ?? 0) * pageSize / 1_048_576
        }
        return -1
    }
}

/// Keeps the run alive past `MainActor.run`, which cannot await.
final class E2ERun: @unchecked Sendable {
    static let shared = E2ERun()
    var task: Task<Void, Never>?
    func wait() async {
        // `task` is set on the main actor before `MainActor.run` returns.
        await task?.value
    }
}

/// Records when, and what, the controller pasted.
final class TimingSink: TextSink, @unchecked Sendable {
    private let state = Mutex<(at: ContinuousClock.Instant, text: String)?>(nil)
    var inserted: (at: ContinuousClock.Instant, text: String)? { state.withLock { $0 } }
    func reset() { state.withLock { $0 = nil } }
    func insert(_ text: String) async throws -> InsertionOutcome {
        let now = ContinuousClock.now
        state.withLock { $0 = (now, text) }
        return .inserted
    }
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        .inserted
    }
}
