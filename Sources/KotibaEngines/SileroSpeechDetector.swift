import Foundation
import KotibaCore
import KotibaModels
import whisper

// C2. Silero VAD, through the copy whisper.cpp already carries.
//
// The streaming Uzbek session cuts audio at pauses and trims silence before each decode, so its
// speech detector decides which audio the model ever hears. The energy gate in KotibaCore cannot
// tell a quiet word from a noisy room, and on the 344-clip harness that cost whole phrases: a
// sermon over music had its first 2.3 s classified as silence and trimmed away (C2 §4). Silero is
// a 885 KB LSTM trained for exactly this distinction, MIT-licensed, and whisper.cpp v1.9.2 — the
// xcframework this app already links — exposes it (`whisper_vad_*`), so it costs no new dependency.
//
// One instance per dictation. The LSTM state is the whole point of running it causally, so two
// overlapping dictations sharing one context would each corrupt the other's speech decisions.
// Loading one is a 885 KB read and a graph allocation — a few milliseconds, paid at key-down.

public final class SileroSpeechDetector: SpeechFrameClassifier, @unchecked Sendable {

    /// The file name `ModelCatalogue.speechDetector` installs under the models root — read from
    /// the catalogue, so the two cannot disagree.
    public static let fileName = ModelCatalogue.speechDetector.destination

    /// 512 samples at 16 kHz: the window Silero v5+ is trained on.
    public let frameSamples: Int

    private let context: OpaquePointer

    /// nil when the file is missing or not a Silero ggml model; the caller falls back to energy.
    public init?(modelURL: URL) {
        guard FileManager.default.fileExists(atPath: modelURL.path) else { return nil }
        WhisperContext.silenceLogging()
        var params = whisper_vad_default_context_params()
        // CPU on purpose. It is tiny, and the GPU is where the Uzbek decoder is working.
        params.use_gpu = false
        params.n_threads = 1
        guard let context = whisper_vad_init_from_file_with_params(modelURL.path, params) else {
            return nil
        }
        self.context = context
        self.frameSamples = 512
    }

    deinit { whisper_vad_free(context) }

    /// Where the detector is, if it is anywhere: the models root, then the app bundle's models.
    public static func locate(in directories: [URL]) -> URL? {
        directories.map { $0.appendingPathComponent(fileName) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    public func probabilities(_ samples: ArraySlice<Float>) -> [Float] {
        guard !samples.isEmpty else { return [] }
        let ok = samples.withContiguousStorageIfAvailable { buffer in
            whisper_vad_detect_speech_no_reset(context, buffer.baseAddress, Int32(buffer.count))
        } ?? Array(samples).withUnsafeBufferPointer { buffer in
            whisper_vad_detect_speech_no_reset(context, buffer.baseAddress, Int32(buffer.count))
        }
        let expected = samples.count / frameSamples
        // A failed graph allocation must not read as silence — that would trim words. It reads
        // as speech, which only delays a cut.
        guard ok, let probs = whisper_vad_probs(context) else {
            return [Float](repeating: 1, count: expected)
        }
        let count = Int(whisper_vad_n_probs(context))
        return Array(UnsafeBufferPointer(start: probs, count: min(count, expected)))
            + [Float](repeating: 1, count: max(0, expected - count))
    }

    public func reset() {
        whisper_vad_reset_state(context)
    }
}
