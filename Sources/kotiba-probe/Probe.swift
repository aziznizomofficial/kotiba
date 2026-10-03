import Foundation
import KotibaAudio
import KotibaCore
import KotibaEngines
import KotibaTranscribe
import KotibaLLM
import KotibaModels

// A command-line harness for the engines. Not shipped with the app; it exists so an engine can
// be exercised against real audio on a real machine, which is the only kind of evidence this
// project accepts about latency and accuracy.
//
//   swift run kotiba-probe transcribe --engine apple --language en clip.wav
//   swift run kotiba-probe assets
//
// Every number the docs quote should be reproducible with a line like the first one.

@main
struct Probe {
    static func main() async {
        var args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else { usage(); exit(2) }
        args.removeFirst()

        do {
            switch command {
            case "transcribe": try await transcribe(args)
            case "stream": try await stream(args)
            case "bench": try await Bench.run(args)
            case "assets": try await assets()
            case "detect": try await detect(args)
            case "head": try await head(args)
            case "deliver": deliver(args)
            case "modes": try await modes(args)
            case "devices": devices()
            case "duck": await duck(args)
            case "capture": try await capture(args)
            case "e2e": try await e2e(args)
            case "route-eval": try routeEval(args)
            case "lid-features": try lidFeatures(args)
            case "ecapa": try await ecapa(args)
            case "vad": try vad(args)
            case "-h", "--help", "help": usage()
            default:
                FileHandle.standardError.write(Data("unknown command: \(command)\n".utf8))
                usage()
                exit(2)
            }
        } catch let error as EngineFailure {
            FileHandle.standardError.write(Data("failed: \(error.reason)\n".utf8))
            exit(1)
        } catch {
            FileHandle.standardError.write(Data("failed: \(error)\n".utf8))
            exit(1)
        }
    }

    static func usage() {
        print("""
        kotiba-probe — exercise the engines against real audio

          transcribe [--engine apple|parakeet|whisper|apple-st|apple-dt] [--language en|ru|uz]
                     [--variant ultra|v3|v2] [--models-root DIR] [--hint] [--locale ID]
                     [--model PATH] [--prompt TEXT] [--beam N] [--ac full|fit:M] [--no-fa]
                     [--repeat N] <file.wav>
          bench      <engine flags as above> --manifest M.jsonl --out O.jsonl
                     [--stream [--pace X]] [--limit N] [--warm N]
                                              one engine over a test set; see
                                              Scripts/measure/en-ru/README.md
          stream --model PATH [--realtime] [--whole] [--out DIR] [--jsonl FILE]
                 [--hint TEXT] [--carry N] [--beam N] [--tail-beam N] [--ac full|fit:M] [--commit-ac …]
                 [--commit-pause S] [--min-segment S] [--max-segment S] [--padding S]
                 [--no-speculate] [--fa] [--vad PATH|energy] [--onset P] [--release P]
                 [--speculative-pause S] [--trailing-padding S] [--cut-pause S]
                 [--chunk-ms N] [--trail-silence MS] <file.wav>…
                                              replay WAVs through the streaming Uzbek session
                                              and report key-release → text (C2)
          detect --model PATH <file.wav>      whisper's own language posterior
          head --model PATH [--windows full,fit:256] [--prefixes 5,8,0] [--list L] --jsonl O
                                              a whisper model's language head as the
                                              session asks it (`TurkishCheck`), per encoder
                                              window and prefix, with its cost (D-11)
          deliver [TEXT…]                     what an Uzbek transcript becomes on its way
                                              to the document (reads stdin if no TEXT)
          assets                              what the system already has installed
          route-eval rows.jsonl [--misses]   the key-up routing rule over {id, lang, tune, mass,
                                             pk, uz} rows (P2 §2)
          e2e --manifest M.jsonl --models DIR --out O.jsonl [--modes super,message,…]
              [--trail 0,300] [--uz-model P] [--ru-model P] [--detector P] [--pin xx]
              [--warm N] [--no-early] [--route-early] [--limit N]
                                              press → hold → release through the real
                                              DictationController, WAVs replayed in real
                                              time; reports release → insert per dictation
          modes --model GGUF --mode super|message|note --language en|ru|uz [--limit N]
                [--no-model] [--model-everywhere] <texts.json>
                                              run a mode sentence by sentence, as during
                                              capture, and report the post-release tail;
                                              texts.json is {"en": [..], "ru": [..], "uz": [..]}
        """ + platformUsage())
    }

    // MARK: transcribe

    static func transcribe(_ args: [String]) async throws {
        var options = EngineOptions()
        var languageCode = "en"
        var repeats = 1
        var path: String?

        var i = 0
        while i < args.count {
            switch args[i] {
            case "--language": i += 1; languageCode = args[safe: i] ?? languageCode
            case "--repeat": i += 1; repeats = Int(args[safe: i] ?? "1") ?? 1
            default:
                if !options.consume(args, &i) { path = args[i] }
            }
            i += 1
        }

        guard let path else { throw ProbeError.usage("no input file") }
        guard let language = Language(rawValue: languageCode) else {
            throw ProbeError.usage("unknown language \(languageCode)")
        }
        let engine = try options.makeEngine()

        let url = URL(fileURLWithPath: path)
        let file = try WAVFile(contentsOf: url)
        let samples = file.resampledTo16k()
        let audio = AudioBuffer(samples: samples)
        let seconds = Double(samples.count) / Double(AudioBuffer.sampleRate)
        print("input     \(url.lastPathComponent) — \(String(format: "%.2f", seconds)) s, "
              + "\(file.sampleRate) Hz → 16 kHz, \(file.channels) ch")

        var clock = ContinuousClock().now
        try await engine.prepare()
        let prepared = ContinuousClock().now - clock
        print("prepare   \(ms(prepared))")

        for pass in 1...max(1, repeats) {
            clock = ContinuousClock().now
            let transcript = try await engine.transcribe(audio, language: language)
            let elapsed = ContinuousClock().now - clock
            let factor = seconds > 0
                ? String(format: " (%.1f× realtime)",
                         seconds / (Double(elapsed.components.attoseconds) / 1e18
                                    + Double(elapsed.components.seconds)))
                : ""
            print("pass \(pass)    \(ms(elapsed))\(factor)  [\(transcript.engineID)]")
            print("          \(transcript.raw)")
        }
    }

    // MARK: stream

    /// Replays WAVs through `StreamingWhisperSession` the way capture would feed it, then
    /// "releases the key" at the end of the file and times `finish()`.
    ///
    /// Two timing models, and the difference matters:
    ///
    ///   * `--realtime` feeds chunks on the wall clock, so background decodes race the speaker
    ///     exactly as they would in the app. This is the latency to quote.
    ///   * default (accelerated) feeds as fast as possible but lets background work settle
    ///     after every chunk — "the machine kept up". The text is identical to real time whenever
    ///     the machine does keep up (segmentation depends only on the audio), so this is how the
    ///     344-clip WER is measured in minutes rather than an hour. Its latency is a floor.
    ///
    /// `--whole` runs the batch path with the same options instead, as the control.
    /// `--out DIR` writes `<name>.txt` per file in the layout `Scripts/measure/sweep.py` scores.
    static func stream(_ args: [String]) async throws {
        var modelPath: String?
        var paths: [String] = []
        var realtime = false
        var whole = false
        var outDir: String?
        var jsonlPath: String?
        var chunkMillis = 20
        var trailMillis = 0
        var beam = 1
        var vadPath: String?
        // Off by default: the streaming engine mixes encoder windows, which flash attention in
        // whisper.cpp v1.9.2 cannot do safely (WhisperEngine.Options.flashAttention). `--fa` turns
        // it on, and the session then falls back to the full window for every decode.
        var flashAttention = false
        var config = StreamingWhisperSession.Configuration()
        config.hint = "Bu yerda ismlar to\u{02BB}g\u{02BB}ri yozilgan."
        // `--language tr|ar`: the same session on another language's whisper model (turbo for
        // Turkish, and for Arabic's fallback). The hint follows the language unless `--hint`
        // sets one: `Vocabulary.hint(for:)` with no terms, exactly what the app sends.
        var language = Language.uzbek
        var hintGiven = false
        // `--cohere GGUF`: Arabic through the app's Arabic family — Cohere via transcribe.cpp in
        // the streaming session, with `--model` (turbo) behind it (`ArabicSegmentDecoder`).
        var coherePath: String?
        // `--cohere-pnc on|off`, `--cohere-itn on|off`, `--cohere-spec K`: transcribe.cpp's run
        // knobs for Cohere (`CohereArabicEngine.Options`); absent, the family default.
        var cohereOptions = CohereArabicEngine.Options()

        func seconds(_ i: inout Int) -> Double { i += 1; return Double(args[safe: i] ?? "") ?? 0 }
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--model": i += 1; modelPath = args[safe: i]
            case "--realtime": realtime = true
            case "--whole": whole = true
            case "--out": i += 1; outDir = args[safe: i]
            case "--jsonl": i += 1; jsonlPath = args[safe: i]
            case "--hint":
                i += 1
                config.hint = args[safe: i].flatMap { $0.isEmpty ? nil : $0 }
                hintGiven = true
            case "--language":
                i += 1
                guard let code = args[safe: i], let parsed = Language(rawValue: code) else {
                    throw ProbeError.usage("--language en|ru|uz|tr|ar")
                }
                language = parsed
            case "--cohere": i += 1; coherePath = args[safe: i]
            case "--cohere-pnc": i += 1; cohereOptions.punctuation = args[safe: i] == "on"
            case "--cohere-itn": i += 1; cohereOptions.inverseNormalisation = args[safe: i] == "on"
            case "--cohere-spec": i += 1; cohereOptions.speculativeDrafts = Int(args[safe: i] ?? "")
            case "--carry": i += 1; config.carryCharacters = Int(args[safe: i] ?? "") ?? 200
            case "--beam": i += 1; beam = Int(args[safe: i] ?? "") ?? 1
            case "--tail-beam": i += 1; config.tailBeamSize = Int(args[safe: i] ?? "")
            case "--ac": i += 1; config.audioContext = parseAudioContext(args[safe: i] ?? "full")
            case "--commit-ac":
                i += 1
                config.commitAudioContext = parseAudioContext(args[safe: i] ?? "full")
            case "--commit-pause": config.segmenter.commitPause = seconds(&i)
            case "--min-segment": config.segmenter.minimumSegment = seconds(&i)
            case "--max-segment": config.segmenter.maximumSegment = seconds(&i)
            case "--padding": config.segmenter.padding = seconds(&i)
            case "--trailing-padding": config.segmenter.trailingPadding = seconds(&i)
            case "--relax-after": config.segmenter.relaxAfter = seconds(&i)
            case "--relaxed-pause": config.segmenter.relaxedCommitPause = seconds(&i)
            case "--speculative-pause": config.segmenter.speculativePause = seconds(&i)
            case "--no-speculate": config.speculate = false
            case "--cut-pause": config.cutPause = seconds(&i)
            case "--vad": i += 1; vadPath = args[safe: i]
            case "--fa": flashAttention = true
            case "--onset": i += 1; config.segmenter.onsetProbability = Float(args[safe: i] ?? "") ?? 0.5
            case "--release": i += 1; config.segmenter.releaseProbability = Float(args[safe: i] ?? "") ?? 0.35
            case "--min-speech": config.segmenter.minimumSpeech = seconds(&i)
            case "--chunk-ms": i += 1; chunkMillis = Int(args[safe: i] ?? "") ?? 20
            case "--trail-silence": i += 1; trailMillis = Int(args[safe: i] ?? "") ?? 0
            default: paths.append(args[i])
            }
            i += 1
        }
        guard let modelPath else { throw ProbeError.usage("stream needs --model <ggml-*.bin>") }
        guard !paths.isEmpty else { throw ProbeError.usage("no input files") }
        if !hintGiven { config.hint = Vocabulary().hint(for: language) }
        if let outDir {
            try FileManager.default.createDirectory(atPath: outDir,
                                                    withIntermediateDirectories: true)
        }
        var jsonl: FileHandle?
        if let jsonlPath {
            FileManager.default.createFile(atPath: jsonlPath, contents: nil)
            jsonl = FileHandle(forWritingAtPath: jsonlPath)
        }

        let engine = WhisperEngine(
            modelURL: URL(fileURLWithPath: modelPath), supportedLanguages: [language],
            options: .init(beamSize: beam, initialPrompt: config.hint,
                           audioContext: config.audioContext, flashAttention: flashAttention))
        let arabic: ArabicSegmentDecoder? = coherePath.map {
            ArabicSegmentDecoder(cohere: CohereArabicEngine(modelURL: URL(fileURLWithPath: $0),
                                                            options: cohereOptions),
                                 fallback: engine)
        }
        var clock = ContinuousClock.now
        try await engine.prepare()
        if let arabic {
            try await arabic.prepare()
            print("prepare   \(ms(ContinuousClock.now - clock))  cohere + turbo in one process")
            _ = try await arabic.transcribe(
                AudioBuffer(samples: [Float](repeating: 0, count: 16_000)), language: .arabic)
            clock = ContinuousClock.now
        }
        print("prepare   \(ms(ContinuousClock.now - clock))  "
              + (whole ? "whole-utterance" : realtime ? "realtime replay" : "accelerated replay"))
        // One throwaway decode so the first file does not carry Metal's pipeline compile.
        _ = try await engine.transcribe(AudioBuffer(samples: [Float](repeating: 0, count: 16_000)),
                                        language: language)

        // `--vad energy` forces the fallback; otherwise Silero from --vad, or from beside the model.
        // The streams come from `StreamingWhisperEngine.openStream()` — the production path.
        let vadURL: URL? = vadPath == "energy" ? nil
            : vadPath.map { URL(fileURLWithPath: $0) }
                ?? URL(fileURLWithPath: modelPath).deletingLastPathComponent()
                    .appendingPathComponent(SileroSpeechDetector.fileName)
        let silero = vadURL.flatMap { SileroSpeechDetector(modelURL: $0) } != nil
        print("vad       " + (silero ? "silero \(vadURL!.lastPathComponent)" : "energy"))
        let streaming: any StreamingTranscriptionEngine = arabic.map {
            StreamingArabicEngine(decoder: $0, configuration: config,
                                  speechDetectorURL: silero ? vadURL : nil)
        } ?? StreamingWhisperEngine(whisper: engine, language: language,
                                    configuration: config,
                                    speechDetectorURL: silero ? vadURL : nil)
        let chunk = max(1, AudioBuffer.sampleRate * chunkMillis / 1000)
        for path in paths {
            let url = URL(fileURLWithPath: path)
            var samples = try WAVFile(contentsOf: url).resampledTo16k()
            samples.append(contentsOf: repeatElement(0, count: 16 * trailMillis))
            let audioSeconds = Double(samples.count) / Double(AudioBuffer.sampleRate)
            let name = url.deletingPathExtension().lastPathComponent

            let text: String
            let releaseMillis: Double
            var report = StreamingWhisperSession.Report()
            if whole {
                clock = ContinuousClock.now
                text = try await (arabic.map { $0 as any TranscriptionEngine } ?? engine)
                    .transcribe(AudioBuffer(samples: samples), language: language).raw
                releaseMillis = msValue(ContinuousClock.now - clock)
            } else {
                guard let session = await streaming.openStream() as? StreamingWhisperSession else {
                    throw ProbeError.usage("not a whisper stream")
                }
                let begun = ContinuousClock.now
                var offset = 0
                while offset < samples.count {
                    let end = min(offset + chunk, samples.count)
                    await session.append(Array(samples[offset..<end]))
                    offset = end
                    if realtime {
                        let due = begun + .milliseconds(offset * 1000 / AudioBuffer.sampleRate)
                        try await Task.sleep(until: due, clock: .continuous)
                    } else {
                        await session.settled()
                    }
                }
                clock = ContinuousClock.now
                text = try await session.finish(AudioBuffer(samples: samples),
                                                language: language).raw
                releaseMillis = msValue(ContinuousClock.now - clock)
                report = await session.report
            }

            let tailSeconds = report.tailSeconds > 0
                ? " " + String(format: "%.2f", report.tailSeconds) + " s" : ""
            let commits = report.count(.commit)
            let speculations = report.count(.speculation)
            print("\(name)  " + String(format: "%.2f", audioSeconds) + " s  release→text "
                  + String(format: "%.0f", releaseMillis) + " ms  tail=\(report.tail)"
                  + tailSeconds + "  segments=\(commits) spec=\(speculations)"
                  + " aborted=\(report.aborted)")
            print("          \(text)")
            if let outDir {
                try (text + "\n").write(toFile: "\(outDir)/\(name).wav.txt", atomically: true,
                                        encoding: .utf8)
            }
            if let jsonl {
                let decodes: [[String: Any]] = report.entries.map {
                    ["kind": $0.kind.rawValue, "s": $0.seconds, "ac": $0.audioContext,
                     "ms": $0.milliseconds, "at": $0.start, "text": $0.text]
                }
                let row: [String: Any] = [
                    "name": name, "audio": audioSeconds, "release_ms": releaseMillis,
                    "tail": report.tail, "tail_s": report.tailSeconds,
                    "commits": commits, "adopted": report.adopted,
                    "speculations": speculations, "aborted": report.aborted,
                    "retries": report.retries, "background_ms": report.backgroundMilliseconds,
                    "decodes": decodes, "text": text,
                ]
                let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
                jsonl.write(data + Data("\n".utf8))
            }
        }
        try jsonl?.close()
    }

    // MARK: head

    /// `WhisperEngine.languagePosterior` — the Turkish check's own call, on the engine the app
    /// builds for turbo (flash attention off, so windows mix) — over every clip, once per encoder
    /// window and prefix. One JSON line per clip: `{path, dur, load1, rows: [{window, prefix,
    /// seconds, tr, ms, posterior}]}`. Windows are interleaved per clip, so load drifts hit them
    /// alike.
    static func head(_ args: [String]) async throws {
        var modelPath: String?
        var paths: [String] = []
        var prefixes: [Double] = [0]
        var windows = ["full"]
        var jsonlPath: String?
        // `--trim-pad MS`: cut each clip where its speech ends and add MS of silence — what the
        // session hears at key-up (`e2e --trail`) or at the pause before it — rather than the
        // FLEURS file's own 0.3–1 s of trailing silence.
        var trimPad: Int?
        var cpuThreads: Int?
        var peakTo: Float?
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--model": i += 1; modelPath = args[safe: i]
            case "--trim-pad": i += 1; trimPad = Int(args[safe: i] ?? "")
            // `--cpu N`: the head on the CPU with N threads, no Metal — the Windows floor for
            // the key-up check (C4 §14.4).
            case "--cpu": i += 1; cpuThreads = Int(args[safe: i] ?? "")
            // `--peak P`: scale each clip to this peak first, as `e2e` does (0.3).
            case "--peak": i += 1; peakTo = Float(args[safe: i] ?? "")
            case "--prefixes":
                i += 1
                prefixes = (args[safe: i] ?? "").split(separator: ",").compactMap { Double($0) }
            case "--windows":
                i += 1
                windows = (args[safe: i] ?? "").split(separator: ",").map(String.init)
            case "--jsonl": i += 1; jsonlPath = args[safe: i]
            case "--list":
                i += 1
                paths += try String(contentsOfFile: args[safe: i] ?? "", encoding: .utf8)
                    .split(separator: "\n").map(String.init).filter { !$0.isEmpty }
            default: paths.append(args[i])
            }
            i += 1
        }
        guard let modelPath else { throw ProbeError.usage("head needs --model <ggml-*.bin>") }
        let engine = WhisperEngine(modelURL: URL(fileURLWithPath: modelPath),
                                   supportedLanguages: [.turkish],
                                   options: .init(useGPU: cpuThreads == nil,
                                                  threads: cpuThreads ?? 0,
                                                  flashAttention: false))
        try await engine.prepare()
        FileManager.default.createFile(atPath: jsonlPath ?? "/dev/stdout", contents: nil)
        let out = jsonlPath.flatMap { FileHandle(forWritingAtPath: $0) } ?? FileHandle.standardOutput
        for window in windows {   // warm every window's graph once
            _ = await engine.languagePosterior([Float](repeating: 0, count: 16_000),
                                               window: parseAudioContext(window))
        }
        for path in paths {
            var samples = try WAVFile(contentsOf: URL(fileURLWithPath: path)).resampledTo16k()
            if let peakTo {
                let peak = samples.reduce(Float(0)) { max($0, abs($1)) }
                if peak > 0 { samples = samples.map { $0 * (peakTo / peak) } }
            }
            if let trimPad {
                samples = trimTrailingSilence(samples)
                    + [Float](repeating: 0, count: trimPad * AudioBuffer.sampleRate / 1000)
            }
            var rows: [[String: Any]] = []
            var done: Set<Int> = []
            for prefix in prefixes {
                let count = prefix <= 0 ? samples.count
                    : min(samples.count, Int(prefix * Double(AudioBuffer.sampleRate)))
                // A prefix past the clip's end is the whole clip again: asked once.
                guard done.insert(count).inserted else { continue }
                for window in windows {
                    let clock = ContinuousClock().now
                    let posterior = await engine.languagePosterior(
                        Array(samples.prefix(count)), window: parseAudioContext(window))
                    rows.append([
                        "window": window, "prefix": prefix, "seconds": Double(count) / 16_000,
                        "tr": OptionalLanguageRules.share("tr", of: posterior),
                        "ms": msValue(ContinuousClock().now - clock), "posterior": posterior,
                    ])
                }
            }
            let row: [String: Any] = ["path": path, "dur": Double(samples.count) / 16_000,
                                      "rows": rows, "load1": Memory.load1()]
            let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            out.write(data + Data("\n".utf8))
        }
    }

    // MARK: detect

    /// Whisper's own language posterior, and the Turkic cluster mass over it. This is the
    /// measurement that decides whether automatic routing can work at all: Uzbek never wins on
    /// argmax, so the only question that matters is whether the cluster clears the threshold.
    static func detect(_ args: [String]) async throws {
        var modelPath: String?
        var paths: [String] = []
        var prefixes: [Double] = []
        var jsonlPath: String?
        var listPath: String?
        var full = false
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--model": i += 1; modelPath = args[safe: i]
            // `--prefixes 1,2,3,0`: the posterior over the first N seconds of each clip (0 = the
            // whole clip) — the question early routing asks during the hold (see
            // `DictationSession.Config.earlyRoute`).
            case "--prefixes":
                i += 1
                prefixes = (args[safe: i] ?? "").split(separator: ",").compactMap { Double($0) }
            case "--jsonl": i += 1; jsonlPath = args[safe: i]
            case "--list": i += 1; listPath = args[safe: i]
            case "--full": full = true
            default: paths.append(args[i])
            }
            i += 1
        }
        if let listPath {
            paths += try String(contentsOfFile: listPath, encoding: .utf8)
                .split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        }
        let terse = ProcessInfo.processInfo.environment["KOTIBA_TERSE"] == "1"
        guard let modelPath else { throw ProbeError.usage("detect needs --model <ggml-*.bin>") }
        guard !paths.isEmpty else { throw ProbeError.usage("no input files") }

        let detector = WhisperLanguageDetector(modelURL: URL(fileURLWithPath: modelPath))
        var clock = ContinuousClock().now
        try await detector.prepare()
        let name = URL(fileURLWithPath: modelPath).lastPathComponent
        print("load      \(ms(ContinuousClock().now - clock))  \(name)")

        let cluster = ClusterMass()
        if !prefixes.isEmpty {
            // One JSON line per clip: mass and en/ru posterior per prefix, and what each cost.
            FileManager.default.createFile(atPath: jsonlPath ?? "/dev/stdout", contents: nil)
            let out = jsonlPath.flatMap { FileHandle(forWritingAtPath: $0) }
                ?? FileHandle.standardOutput
            _ = await detector.posterior(for: AudioBuffer(samples: [Float](repeating: 0,
                                                                              count: 16_000)))
            for path in paths {
                let samples = try WAVFile(contentsOf: URL(fileURLWithPath: path)).resampledTo16k()
                var rows: [[String: Any]] = []
                for prefix in prefixes {
                    let count = prefix <= 0 ? samples.count
                        : min(samples.count, Int(prefix * Double(AudioBuffer.sampleRate)))
                    clock = ContinuousClock().now
                    let posterior = await detector.posterior(
                        for: AudioBuffer(samples: Array(samples.prefix(count))))
                    var entry: [String: Any] = [
                        "prefix": prefix, "seconds": Double(count) / 16_000,
                        "mass": cluster.mass(posterior), "en": posterior["en"] ?? 0,
                        "ru": posterior["ru"] ?? 0, "ms": msValue(ContinuousClock().now - clock),
                    ]
                    // `--full`: the whole posterior (every code over 0.001), for designing a
                    // rule over more than the cluster sum — Turkish against Uzbek, Arabic.
                    if full { entry["posterior"] = posterior }
                    rows.append(entry)
                }
                let row: [String: Any] = [
                    "path": path, "dur": Double(samples.count) / 16_000, "prefixes": rows,
                    "load1": Memory.load1(),
                ]
                let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
                out.write(data + Data("\n".utf8))
            }
            return
        }
        for path in paths {
            let url = URL(fileURLWithPath: path)
            let samples = try WAVFile(contentsOf: url).resampledTo16k()
            let audio = AudioBuffer(samples: samples)
            clock = ContinuousClock().now
            let posterior = await detector.posterior(for: audio)
            let elapsed = ContinuousClock().now - clock

            let mass = cluster.mass(posterior)
            let top = posterior.sorted { $0.value > $1.value }.prefix(6)
            let seconds = Double(samples.count) / Double(AudioBuffer.sampleRate)
            print("\(url.lastPathComponent)  \(String(format: "%.2f", seconds))s  \(ms(elapsed))")
            print("   top:    " + top.map { "\($0.key) \(String(format: "%.3f", $0.value))" }
                .joined(separator: "  "))
            print("   turkic mass: \(String(format: "%.3f", mass))  ->  "
                  + (cluster.isUzbek(posterior) ? "UZBEK" : "not uzbek"))
            if terse {
                FileHandle.standardError.write(Data(
                    "MASS\t\(url.lastPathComponent)\t\(seconds)\t\(mass)\n".utf8))
            }
        }
    }

    // MARK: deliver

    /// What an Uzbek transcript becomes between the engine and the document.
    ///
    /// The delivery path had no way to be exercised without a microphone, which is how it shipped
    /// running `UzbekNormaliser.clean` — the leaderboard's normaliser, which deletes every
    /// punctuation mark — on text bound for the user's document. This runs exactly what
    /// `DictationController.makeSession` runs, minus the user's own replacement rules, so the
    /// answer can be checked against a real engine's output on a machine with no mic grant.
    static func deliver(_ args: [String]) {
        let input: String
        if args.isEmpty {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            input = String(decoding: data, as: UTF8.self)
        } else {
            input = args.joined(separator: " ")
        }

        let capitaliser = Capitaliser()
        for line in input.split(separator: "\n", omittingEmptySubsequences: false) {
            let raw = String(line)
            guard !raw.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            let delivered = capitaliser.restore(UzbekNormaliser.forDelivery(raw))
            // Shown alongside so the difference is visible rather than asserted.
            let scored = UzbekNormaliser.clean(raw)
            print("raw       \(raw)")
            print("delivered \(delivered)")
            print("(clean)   \(scored)")
            print("")
        }
    }

    // MARK: assets

    static func assets() async throws {
        print("apple SpeechTranscriber available: \(AppleSpeechEngine.isAvailable)")
        let engine = AppleSpeechEngine()
        do {
            try await engine.prepare()
            print("  en-US ready")
        } catch {
            print("  en-US unavailable — \(error)")
        }
    }

    // MARK: helpers

    /// `full`, or `fit:MARGIN` in encoder positions (50 per second of audio); the window is
    /// always rounded up to a multiple of 256 (see `WhisperEngine.AudioContext`).
    static func parseAudioContext(_ spec: String) -> WhisperEngine.AudioContext {
        guard spec != "full" else { return .full }
        let parts = spec.split(separator: ":").compactMap { Int($0) }
        return .fitted(margin: parts[safe: 0] ?? 64)
    }

    static func msValue(_ duration: Duration) -> Double {
        Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
    }

    static func ms(_ duration: Duration) -> String {
        let value = Double(duration.components.seconds) * 1000
            + Double(duration.components.attoseconds) / 1e15
        return String(format: "%.0f ms", value)
    }
}

enum ProbeError: Error, CustomStringConvertible {
    case usage(String)
    var description: String {
        switch self { case .usage(let why): return why }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

// MARK: modes

extension Probe {

    /// The measured path for docs/research/C3-on-device-modes.md: every text is cleaned as the
    /// session would clean it, all but its last sentence are committed and allowed to finish (the
    /// user is still speaking the last one), then `finish` is timed — that is the tail the user
    /// waits for after key-release. One JSON object per text on stdout.
    static func modes(_ args: [String]) async throws {
        var modelPath: String?
        var modeName = "super"
        var languageCode = "en"
        var limit = Int.max
        var file: String?
        var useModel = true
        var everywhere = false
        // Both ggml copies resident and used in one process, as in the app: whisper transcribes
        // the clip once before the modes run, and once more after them.
        var whisperModel: String?
        var whisperAudio: String?
        var rawOnly = false
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--model": i += 1; modelPath = args[safe: i]
            case "--mode": i += 1; modeName = args[safe: i] ?? modeName
            case "--language": i += 1; languageCode = args[safe: i] ?? languageCode
            case "--limit": i += 1; limit = Int(args[safe: i] ?? "") ?? limit
            case "--no-model": useModel = false
            case "--model-everywhere": everywhere = true
            case "--with-whisper": i += 1; whisperModel = args[safe: i]
            case "--whisper-audio": i += 1; whisperAudio = args[safe: i]
            // `--raw`: Message only — every sentence's model output BEFORE the guard, with the
            // guard's verdict, instead of the session's result (for judging rewrites, C4 §14.5).
            case "--raw": rawOnly = true
            default: file = args[i]
            }
            i += 1
        }
        guard let file, let behaviour = ModeBehaviour(rawValue: modeName),
              let language = Language(rawValue: languageCode) else { usage(); exit(2) }
        let corpus = try JSONDecoder().decode([String: [String]].self,
                                              from: Data(contentsOf: URL(fileURLWithPath: file)))
        let texts = (corpus[languageCode] ?? []).prefix(limit)

        let engine: LlamaPolisher? = useModel ? modelPath.map { LlamaPolisher(modelPath: $0) } : nil
        var whisper: WhisperEngine?
        var clip: AudioBuffer?
        if let whisperModel, let whisperAudio {
            let loaded = WhisperEngine(modelURL: URL(fileURLWithPath: whisperModel),
                                       supportedLanguages: Set(Language.allCases))
            try await loaded.prepare()
            let audio = AudioBuffer(samples: try WAVFile(
                contentsOf: URL(fileURLWithPath: whisperAudio)).resampledTo16k())
            let heard = try await loaded.transcribe(audio, language: .english)
            FileHandle.standardError.write(Data("whisper before: \(heard.raw)\n".utf8))
            whisper = loaded
            clip = audio
        }
        if rawOnly, let engine {
            let prompt = OnDeviceModes.messagePrompt(language)
            for raw in texts {
                var cleaned = Orthography.forDelivery(raw, language: language)
                cleaned = DictationCleanup(language: language).apply(cleaned)
                let (sentences, _) = SentenceSplitter.split(cleaned, keepIncompleteTail: false)
                for sentence in sentences {
                    let output = (try? await engine.polish(
                        sentence, language: language, prompt: prompt,
                        maxOutputTokens: SentenceSplitter.tokenBudget(for: sentence)))?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let verdict = SentenceGuard.checkRewrite(
                        output, against: sentence, language: language, prompt: prompt,
                        mayDrop: OnDeviceModes.droppable[language] ?? [])
                    let row: [String: Any] = ["in": sentence, "model": output,
                                              "refused": verdict ?? ""]
                    let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
                    print(String(decoding: data, as: UTF8.self))
                }
            }
            await LlamaEngine.releaseAll()
            return
        }
        let capitaliser = Capitaliser()
        let clock = ContinuousClock()
        var tails: [Double] = []
        var firstLoad = true

        for raw in texts {
            // As the session's normaliser does it: orthography, clean-up, the language-aware
            // capitaliser (a no-op for Arabic; `İ` for Turkish).
            var cleaned = Orthography.forDelivery(raw, language: language)
            cleaned = DictationCleanup(language: language).apply(cleaned)
            cleaned = capitaliser.restore(cleaned, language: language)

            let session = IncrementalPolish(
                behaviour: behaviour, language: language, engine: engine,
                superModelLanguages: everywhere ? Set(Language.allCases)
                    : OnDeviceModes.superModelLanguages)
            let prepareStart = clock.now
            await session.prepare()
            let prepareMs = LlamaEngine.ms(clock.now - prepareStart)
            let (sentences, _) = SentenceSplitter.split(cleaned, keepIncompleteTail: false)
            let head = sentences.dropLast().joined(separator: " ")
            let tail = (sentences.count > 1 ? " " : "") + (sentences.last ?? "")
            let backgroundStart = clock.now
            if !head.isEmpty { await session.commit(head + " ") }
            await session.idle()
            let backgroundMs = LlamaEngine.ms(clock.now - backgroundStart)
            let outcome = await session.finish(tail: tail, deadline: .seconds(10))
            tails.append(outcome.tailMilliseconds)
            let run = await engine?.lastRun()
            let row: [String: Any] = [
                "raw": raw, "cleaned": cleaned, "output": outcome.text,
                "sentences": outcome.sentences, "modelSentences": outcome.modelSentences,
                "tailMs": outcome.tailMilliseconds, "backgroundMs": backgroundMs,
                "prepareMs": firstLoad ? prepareMs : 0, "notes": outcome.notes,
                "lastPrefilled": run?.prefilled ?? 0, "lastGenerated": run?.generated ?? 0,
                "lastPasses": run?.forwardPasses ?? 0,
                "lastPrefillMs": run?.prefillMs ?? 0, "lastGenerateMs": run?.generateMs ?? 0,
            ]
            firstLoad = false
            let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            print(String(decoding: data, as: UTF8.self))
        }
        if let whisper, let clip {
            let heard = try await whisper.transcribe(clip, language: .english)
            FileHandle.standardError.write(Data("whisper after: \(heard.raw)\n".utf8))
        }
        await LlamaEngine.releaseAll()
        let sorted = tails.sorted()
        if !sorted.isEmpty {
            FileHandle.standardError.write(Data(String(
                format: "%@ %@: n=%d tail p50 %.0f ms p90 %.0f ms max %.0f ms\n",
                modeName, languageCode, sorted.count, sorted[sorted.count / 2],
                sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.9))],
                sorted.last ?? 0).utf8))
        }
    }
}
