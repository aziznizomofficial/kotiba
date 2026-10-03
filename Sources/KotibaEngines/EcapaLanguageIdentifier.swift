@preconcurrency import CoreML
import Foundation
import KotibaCore

// The language-ID model (P4 §2, D-14): SpeechBrain's VoxLingua107 ECAPA-TDNN
// (`speechbrain/lang-id-voxlingua107-ecapa`, Apache-2.0), 107 spoken languages — Uzbek, Turkish,
// Arabic, English and Russian each a class of its own — exported by `Scripts/export-ecapa.py` as
// one Core ML graph from the waveform to the 107 log-posteriors: the STFT as a strided
// convolution, SpeechBrain's own 60-band filterbank, sentence mean normalisation, the
// ECAPA-TDNN and its classifier. Float16 weights, 42.9 MB, one file.
//
// Why it replaced whisper base as the detector: whisper has heard little Uzbek and answers it as
// Turkish (`tr 0.63 / az 0.17 / uz 0.00` — hence `ClusterMass`); this model has an Uzbek class.
// On the 745 real Uzbek clips of P2 it names Uzbek on its own for 720, every FLEURS Turkish,
// Arabic, English and Russian clip of the C4 sets for its own language, and 97.5 % of the
// Casablanca dialect clips (whisper base: 44–48 %). Measured P4 §2.
//
// It runs on the CPU (`computeUnits = .cpuOnly`): ~48 ms for a 5–10 s dictation, ~190 ms for
// 30 s, and never on the GPU beside the Uzbek engine's tail decode — the contention that made
// whisper base's ~35 ms detection cost the Uzbek tail ~150 ms when the two shared it (P1).

public actor EcapaLanguageIdentifier: AcousticClassifier {

    /// `MLModel` is not `Sendable`; the actor hands it to one detached prediction at a time
    /// (`inFlight` chains them), which is the use Core ML supports.
    final class Loaded: @unchecked Sendable {
        let model: MLModel
        init(_ model: MLModel) { self.model = model }
    }

    /// The class order of the model's output.
    public static let labels: [String] = [
        "ab", "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs", "ca", "ceb",
        "cs", "cy", "da", "de", "el", "en", "eo", "es", "et", "eu", "fa", "fi", "fo", "fr", "gl",
        "gn", "gu", "gv", "ha", "haw", "hi", "hr", "ht", "hu", "hy", "ia", "id", "is", "it", "iw",
        "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb", "ln", "lo", "lt", "lv", "mg", "mi",
        "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps",
        "pt", "ro", "ru", "sa", "sco", "sd", "si", "sk", "sl", "sn", "so", "sq", "sr", "su", "sv",
        "sw", "ta", "te", "tg", "th", "tk", "tl", "tr", "tt", "uk", "ur", "uz", "vi", "war", "yi",
        "yo", "zh",
    ]

    /// The shortest and longest input the graph was exported for: 0.25 s and 30 s.
    public static let minimumSamples = 4_000
    public static let maximumSamples = 480_000

    public nonisolated let modelURL: URL
    private var model: Loaded?
    private var loading: Task<Loaded, any Error>?
    private var inFlight: Task<[String: Double], Never>?

    public init(modelURL: URL) {
        self.modelURL = modelURL
    }

    public func isReady() -> Bool { model != nil }

    /// Compiles the `.mlmodel` once (beside it, as `<name>c`, reused on later launches when it is
    /// newer than the model) and loads it for the CPU. Idempotent and deduplicated.
    public func prepare() async throws {
        if model != nil { return }
        guard FileManager.default.fileExists(atPath: modelURL.path) else {
            throw EngineFailure.modelMissing(path: modelURL.path)
        }
        let task: Task<Loaded, any Error>
        if let existing = loading {
            task = existing
        } else {
            let url = modelURL
            task = Task.detached(priority: .userInitiated) { Loaded(try await Self.load(url)) }
            loading = task
        }
        defer { loading = nil }
        let loaded = try await task.value
        if model == nil { model = loaded }
    }

    private static func load(_ url: URL) async throws -> MLModel {
        let fm = FileManager.default
        let compiled = url.deletingPathExtension().appendingPathExtension("mlmodelc")
        let stale: Bool = {
            guard let built = (try? fm.attributesOfItem(atPath: compiled.path))?[.modificationDate]
                    as? Date,
                  let source = (try? fm.attributesOfItem(atPath: url.path))?[.modificationDate]
                    as? Date else { return true }
            return built < source
        }()
        if stale {
            let temporary = try await MLModel.compileModel(at: url)
            try? fm.removeItem(at: compiled)
            do {
                try fm.moveItem(at: temporary, to: compiled)
            } catch {
                // A read-only models directory (a DMG's): run from the temporary copy.
                return try MLModel(contentsOf: temporary, configuration: configuration)
            }
        }
        return try MLModel(contentsOf: compiled, configuration: configuration)
    }

    private static var configuration: MLModelConfiguration {
        let c = MLModelConfiguration()
        c.computeUnits = .cpuOnly
        return c
    }

    public func unload() { model = nil }

    /// The posterior over all 107 languages, summing to 1. Empty on any failure — the router
    /// treats that as "no opinion", never as a reason to block a dictation.
    public func posterior(for audio: AudioBuffer) async -> [String: Double] {
        if model == nil { try? await prepare() }
        guard let model, !audio.samples.isEmpty else { return [:] }
        var samples = audio.samples
        if samples.count > Self.maximumSamples { samples = Array(samples.prefix(Self.maximumSamples)) }
        if samples.count < Self.minimumSamples {
            samples += [Float](repeating: 0, count: Self.minimumSamples - samples.count)
        }
        let input = samples
        let previous = inFlight
        let task = Task.detached(priority: .userInitiated) { () -> [String: Double] in
            _ = await previous?.value
            return Self.run(model.model, input)
        }
        inFlight = task
        return await task.value
    }

    nonisolated static func run(_ model: MLModel, _ samples: [Float]) -> [String: Double] {
        guard let array = try? MLMultiArray(shape: [1, NSNumber(value: samples.count)],
                                            dataType: .float32) else { return [:] }
        samples.withUnsafeBufferPointer { source in
            array.withUnsafeMutableBytes { raw, _ in
                raw.baseAddress?.copyMemory(from: source.baseAddress!,
                                            byteCount: samples.count * MemoryLayout<Float>.size)
            }
        }
        guard let provider = try? MLDictionaryFeatureProvider(dictionary: ["audio": array]),
              let out = try? model.prediction(from: provider),
              let logp = out.featureValue(for: "logp")?.multiArrayValue,
              logp.count == labels.count else { return [:] }
        var values = [Double](repeating: 0, count: labels.count)
        for i in 0..<labels.count { values[i] = logp[i].doubleValue }
        // The graph ends in a log-softmax; exponentiate against the maximum for stability.
        let top = values.max() ?? 0
        let exps = values.map { exp($0 - top) }
        let z = exps.reduce(0, +)
        var posterior: [String: Double] = [:]
        for (i, label) in labels.enumerated() { posterior[label] = exps[i] / z }
        return posterior
    }
}
