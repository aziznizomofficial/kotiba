import AVFoundation
import Foundation
import KotibaAudio
import KotibaCore
import KotibaEngines
import KotibaModels
import Speech

// `kotiba-probe bench` — the Swift half of Scripts/measure/en-ru. Runs one engine over a JSONL
// manifest ({id, wav, lang, ref, dur, set}) and writes one JSONL line per clip:
//
//   {id, engine, lang, set, dur, hyp, ms, tail_ms?, rss_mb, load1}
//
// `ms` is wall time for the engine call with the model already loaded and warmed — what
// key-release pays when the engine is resident. `tail_ms` (with --stream) is the time from the
// last sample arriving to the final text, after the audio was fed at real-time pace during
// the "hold" — the number that decides key-release → text for a streaming engine. `load1` is
// the 1-minute load average at that moment, because other work on the machine moves every
// latency figure and a number without it cannot be compared with anything.
//
// Scoring is `score.py`'s job; this file only transcribes and times.

enum Bench {

    struct Item: Decodable {
        var id: String
        var wav: String
        var lang: String
        var ref: String?
        var dur: Double?
        var set: String?
    }

    struct Row: Encodable {
        var id: String
        var engine: String
        var lang: String
        var set: String?
        var dur: Double
        var hyp: String
        var ms: Double
        var tail_ms: Double?
        var rss_mb: Double
        var load1: Double
        var error: String?
    }

    static func run(_ args: [String]) async throws {
        var options = EngineOptions()
        var manifest: String?
        var out: String?
        var stream = false
        var pace = 1.0
        var limit = Int.max
        var warm = 2

        var i = 0
        while i < args.count {
            switch args[i] {
            case "--manifest": i += 1; manifest = args[safe: i]
            case "--out": i += 1; out = args[safe: i]
            case "--stream": stream = true
            case "--pace": i += 1; pace = Double(args[safe: i] ?? "1") ?? 1
            case "--limit": i += 1; limit = Int(args[safe: i] ?? "") ?? limit
            case "--warm": i += 1; warm = Int(args[safe: i] ?? "2") ?? 2
            default:
                if !options.consume(args, &i) {
                    throw ProbeError.usage("bench: unknown argument \(args[i])")
                }
            }
            i += 1
        }
        guard let manifest, let out else {
            throw ProbeError.usage("bench needs --manifest M.jsonl --out O.jsonl")
        }

        let lines = try String(contentsOfFile: manifest, encoding: .utf8).split(separator: "\n")
        var items: [Item] = []
        for line in lines.prefix(limit) {
            items.append(try JSONDecoder().decode(Item.self, from: Data(line.utf8)))
        }
        guard let first = items.first else { throw ProbeError.usage("empty manifest") }

        let engine = try options.makeEngine()
        let label = options.label
        let rssBefore = Memory.footprintMB()
        var clock = ContinuousClock().now
        try await engine.prepare()
        let prepared = ContinuousClock().now - clock
        let rssLoaded = Memory.footprintMB()
        let loadedLine = "\(label): prepare \(Probe.ms(prepared)), footprint "
            + "\(Int(rssBefore)) → \(Int(rssLoaded)) MB, load1 \(Memory.load1())\n"
        FileHandle.standardError.write(Data(loadedLine.utf8))

        // Warm-up on the first clip, discarded. The first inference after a load pays for the
        // Neural Engine's plan build or Apple's daemon wake; the table reports warm numbers
        // and the cold ones separately.
        let warmAudio = try load(first.wav)
        let warmLanguage = Language(rawValue: first.lang) ?? .english
        for pass in 0..<warm {
            clock = ContinuousClock().now
            _ = try? await engine.transcribe(warmAudio, language: warmLanguage)
            FileHandle.standardError.write(Data(
                "\(label): warm-up \(pass + 1) \(Probe.ms(ContinuousClock().now - clock))\n".utf8))
        }

        FileManager.default.createFile(atPath: out, contents: nil)
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: out))
        defer { try? handle.close() }

        for (index, item) in items.enumerated() {
            let audio = try load(item.wav)
            let language = Language(rawValue: item.lang) ?? .english
            var row = Row(id: item.id, engine: label, lang: item.lang, set: item.set,
                          dur: audio.duration, hyp: "", ms: 0, rss_mb: 0,
                          load1: Memory.load1())
            do {
                if stream {
                    let (text, total, tail) = try await streamed(engine, audio, language, pace)
                    row.hyp = text
                    row.ms = total
                    row.tail_ms = tail
                } else {
                    clock = ContinuousClock().now
                    let transcript = try await engine.transcribe(audio, language: language)
                    row.ms = millis(ContinuousClock().now - clock)
                    row.hyp = transcript.raw
                }
            } catch {
                row.error = "\(error)"
            }
            row.rss_mb = Memory.footprintMB()
            var line = try JSONEncoder().encode(row)
            line.append(0x0A)
            handle.write(line)
            if index % 20 == 0 || stream {
                let tail = row.tail_ms.map { " (tail \(Int($0)) ms)" } ?? ""
                let failure = row.error.map { " ERROR \($0)" } ?? ""
                let seconds = String(format: "%.1f", audio.duration)
                let progress = "\(label) [\(index + 1)/\(items.count)] \(item.id) \(seconds)s → "
                    + "\(Int(row.ms)) ms\(tail)\(failure)\n"
                FileHandle.standardError.write(Data(progress.utf8))
            }
        }
        FileHandle.standardError.write(Data(
            "\(label): done, peak footprint \(Int(Memory.footprintMB())) MB\n".utf8))
    }

    /// Feed `audio` in 100 ms pieces at `pace` × real time, as a microphone would during a hold,
    /// then time `finish`. Returns (text, total wall ms, tail ms after the last sample).
    static func streamed(_ engine: any TranscriptionEngine, _ audio: KotibaCore.AudioBuffer,
                         _ language: Language, _ pace: Double)
        async throws -> (String, Double, Double) {
        let piece = KotibaCore.AudioBuffer.sampleRate / 10
        let started = ContinuousClock().now
        if let apple = engine as? AppleProbeEngine {
            return try await apple.streamed(audio, language: language, pace: pace)
        }
        guard let streaming = engine as? any StreamingTranscriptionEngine else {
            // Not a streaming engine: the whole decode happens after key-up.
            try await pacedWait(audio, pace)
            let clock = ContinuousClock().now
            let text = try await engine.transcribe(audio, language: language).raw
            let tail = millis(ContinuousClock().now - clock)
            return (text, millis(ContinuousClock().now - started), tail)
        }
        let stream = await streaming.openStream()
        var offset = 0
        let pieceDuration = Duration.milliseconds(Int(100 / pace))
        var next = ContinuousClock().now
        while offset < audio.samples.count {
            let end = min(offset + piece, audio.samples.count)
            await stream.append(Array(audio.samples[offset..<end]))
            offset = end
            next = next.advanced(by: pieceDuration)
            try await Task.sleep(until: next, clock: .continuous)
        }
        let clock = ContinuousClock().now
        let text = try await stream.finish(audio, language: language).raw
        let tail = millis(ContinuousClock().now - clock)
        return (text, millis(ContinuousClock().now - started), tail)
    }

    static func pacedWait(_ audio: KotibaCore.AudioBuffer, _ pace: Double) async throws {
        try await Task.sleep(for: .seconds(audio.duration / pace))
    }

    static func load(_ path: String) throws -> KotibaCore.AudioBuffer {
        let file = try WAVFile(contentsOf: URL(fileURLWithPath: path))
        return KotibaCore.AudioBuffer(samples: file.resampledTo16k())
    }

    static func millis(_ duration: Duration) -> Double {
        Double(duration.components.seconds) * 1000
            + Double(duration.components.attoseconds) / 1e15
    }
}

// MARK: - Engine construction, shared by `transcribe` and `bench`

struct EngineOptions {
    var engine = "apple"
    var variant = ParakeetEngine.Variant.ultra
    var modelsRoot: String?
    var modelPath: String?
    var prompt: String?
    var beamSize = 1
    var hint = false
    var locale: String?
    /// whisper only: the encoder window, `full` or `fit:MARGIN` (C2), and flash attention.
    var audioContext = WhisperEngine.AudioContext.full
    var flashAttention = true
    /// whisper only: CPU threads (0 = the engine's own choice, min(8, cores − 2)).
    var threads = 0

    /// Consumes one engine flag at `args[i]` (advancing `i` past its value), or returns false.
    mutating func consume(_ args: [String], _ i: inout Int) -> Bool {
        switch args[i] {
        case "--engine": i += 1; engine = args[safe: i] ?? engine
        case "--variant":
            i += 1
            variant = ParakeetEngine.Variant(rawValue: args[safe: i] ?? "") ?? variant
        case "--models-root": i += 1; modelsRoot = args[safe: i]
        case "--model": i += 1; modelPath = args[safe: i]
        case "--prompt": i += 1; prompt = args[safe: i]
        case "--beam": i += 1; beamSize = Int(args[safe: i] ?? "1") ?? 1
        case "--hint": hint = true
        case "--locale": i += 1; locale = args[safe: i]
        case "--ac": i += 1; audioContext = Probe.parseAudioContext(args[safe: i] ?? "full")
        case "--no-fa": flashAttention = false
        case "--threads": i += 1; threads = Int(args[safe: i] ?? "0") ?? 0
        default: return false
        }
        return true
    }

    var label: String {
        switch engine {
        case "parakeet": return "parakeet-\(variant.rawValue)\(hint ? "+hint" : "")"
        case "whisper": return "whisper-\(URL(fileURLWithPath: modelPath ?? "?").lastPathComponent)"
        case "apple-dt", "apple-st": return "\(engine)-\(locale ?? "?")"
        default: return engine
        }
    }

    /// Where the Parakeet bundle is fetched to. The app's own models directory by default, so a
    /// probe run and the app share one download; `--models-root` for anywhere else.
    var resolvedModelsRoot: URL {
        if let modelsRoot { return URL(fileURLWithPath: modelsRoot) }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Kotiba/models")
    }

    func makeEngine() throws -> any TranscriptionEngine {
        switch engine {
        case "apple":
            return AppleSpeechEngine()
        case "apple-st", "apple-dt":
            guard let locale else { throw ProbeError.usage("--engine \(engine) needs --locale") }
            return AppleProbeEngine(dictation: engine == "apple-dt",
                                    locale: Locale(identifier: locale))
        case "parakeet":
            return ParakeetEngine(variant: variant, modelsRoot: resolvedModelsRoot,
                                  waitForDownload: true, loadBudget: nil, languageHint: hint)
        case "whisper":
            guard let modelPath else {
                throw ProbeError.usage("--engine whisper needs --model <ggml-*.bin>")
            }
            return WhisperEngine(
                modelURL: URL(fileURLWithPath: modelPath),
                supportedLanguages: Set(Language.allCases),
                options: .init(threads: threads, beamSize: beamSize, initialPrompt: prompt,
                               audioContext: audioContext, flashAttention: flashAttention))
        default:
            throw ProbeError.usage("unknown engine \(engine)")
        }
    }
}

// MARK: - Apple, any locale, both modules — measurement only

/// Apple's SpeechTranscriber or DictationTranscriber at an arbitrary locale. Not shipped: the
/// shipped Apple engine is `AppleSpeechEngine`, English only. This exists to answer "could
/// Apple do Russian?" by measurement rather than by reading the locale list.
actor AppleProbeEngine: TranscriptionEngine {
    nonisolated let engineID: String
    nonisolated let supportedLanguages: Set<Language> = Set(Language.allCases)
    let dictation: Bool
    let locale: Locale

    init(dictation: Bool, locale: Locale) {
        self.dictation = dictation
        self.locale = locale
        self.engineID = (dictation ? "apple-dt-" : "apple-st-") + locale.identifier
    }

    func isReady() async -> Bool { true }

    func prepare() async throws {
        let module = makeModule()
        switch await AssetInventory.status(forModules: [module]) {
        case .installed: break
        case .unsupported: throw EngineFailure.localeUnsupported(locale.identifier)
        default:
            if let request = try await AssetInventory.assetInstallationRequest(
                supporting: [module]) {
                try await request.downloadAndInstall()
            }
        }
    }

    private func makeModule() -> any SpeechModule {
        if dictation {
            // Punctuation is an *option* here, off unless asked for — which is why an earlier
            // measurement (A4) found DictationTranscriber "returns no punctuation".
            return DictationTranscriber(locale: locale, contentHints: [],
                                        transcriptionOptions: [.punctuation],
                                        reportingOptions: [], attributeOptions: [])
        }
        return SpeechTranscriber(locale: locale, preset: .transcription)
    }

    func transcribe(_ audio: KotibaCore.AudioBuffer, language: Language) async throws -> Transcript {
        let (text, _, _) = try await run(audio, pace: nil)
        return Transcript(raw: text, language: language, engineID: engineID)
    }

    func streamed(_ audio: KotibaCore.AudioBuffer, language: Language,
                  pace: Double) async throws -> (String, Double, Double) {
        try await run(audio, pace: pace)
    }

    /// One analyzer run. With `pace`, input arrives in 100 ms buffers at that multiple of real
    /// time and the tail is timed from the last buffer; without, it arrives as one buffer.
    private func run(_ audio: KotibaCore.AudioBuffer, pace: Double?) async throws -> (String, Double, Double) {
        let module = makeModule()
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module])
        else { throw EngineFailure.assetsUnavailable("no compatible audio format") }

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        let analyzer = SpeechAnalyzer(modules: [module])
        let started = ContinuousClock().now
        try await analyzer.start(inputSequence: stream)

        let collector: Task<String, any Error>
        if let transcriber = module as? SpeechTranscriber {
            collector = Task {
                var text = AttributedString()
                for try await result in transcriber.results where result.isFinal {
                    text.append(result.text)
                }
                return String(text.characters)
            }
        } else if let transcriber = module as? DictationTranscriber {
            collector = Task {
                var text = AttributedString()
                for try await result in transcriber.results where result.isFinal {
                    text.append(result.text)
                }
                return String(text.characters)
            }
        } else {
            throw EngineFailure.assetsUnavailable("unknown module")
        }

        let piece = pace == nil ? audio.samples.count : KotibaCore.AudioBuffer.sampleRate / 10
        var offset = 0
        var next = ContinuousClock().now
        while offset < audio.samples.count {
            let end = min(offset + piece, audio.samples.count)
            let slice = KotibaCore.AudioBuffer(samples: Array(audio.samples[offset..<end]))
            guard let buffer = AppleSpeechEngine.pcmBuffer(from: slice, format: format) else {
                throw EngineFailure.transcriptionFailed("could not convert audio to \(format)")
            }
            continuation.yield(AnalyzerInput(buffer: buffer))
            offset = end
            if let pace {
                next = next.advanced(by: .milliseconds(Int(100 / pace)))
                try await Task.sleep(until: next, clock: .continuous)
            }
        }
        let released = ContinuousClock().now
        continuation.finish()
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        let text = try await collector.value
        let done = ContinuousClock().now
        return (text.trimmingCharacters(in: .whitespacesAndNewlines),
                Bench.millis(done - started), Bench.millis(done - released))
    }
}

// MARK: - Process measurements

enum Memory {
    /// `phys_footprint` — what Activity Monitor's "Memory" column shows, and what jetsam uses.
    static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
    }

    static func load1() -> Double {
        var loads = [Double](repeating: 0, count: 3)
        return getloadavg(&loads, 3) > 0 ? (loads[0] * 100).rounded() / 100 : -1
    }
}
