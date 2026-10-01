import Foundation
import KotibaCore

// The Band-2 harness. An `AudioSource` that replays a file deterministically, so the audio
// pipeline can be exercised end to end without a microphone.
//
// No test may ever open the real microphone: it needs a TCC grant that does not exist on a CI
// runner, and locally it pops a permission dialog in the middle of a test run. Every test that
// wants audio injects one of these instead.
//
// Deliberately hand-rolled rather than AVAudioFile: this must parse identically on a runner
// with no audio hardware at all, and a WAV header is 44 bytes of arithmetic.

public enum WAVError: Error, Sendable, Equatable {
    case notRIFF
    case notWAVE
    case missingChunk(String)
    case unsupportedFormat(code: Int)
    case unsupportedBitDepth(Int)
    case truncated

    public var reason: String {
        switch self {
        case .notRIFF: return "not a RIFF file"
        case .notWAVE: return "RIFF, but not WAVE"
        case .missingChunk(let c): return "no \(c) chunk"
        case .unsupportedFormat(let c): return "format code \(c) is not PCM (1) or float (3)"
        case .unsupportedBitDepth(let b): return "\(b)-bit samples are not supported"
        case .truncated: return "the file ends mid-sample"
        }
    }
}

public struct WAVFile: Sendable {
    public let samples: [Float]          // mono, in the file's own sample rate
    public let sampleRate: Int
    public let channels: Int

    /// Parse a WAV. Multi-channel input is averaged to mono, because every engine here takes
    /// mono and doing it once at the edge beats doing it in three places.
    public init(data: Data) throws {
        func u32(_ o: Int) throws -> Int {
            guard o + 4 <= data.count else { throw WAVError.truncated }
            return Int(data[o + 0]) | Int(data[o + 1]) << 8
                 | Int(data[o + 2]) << 16 | Int(data[o + 3]) << 24
        }
        func u16(_ o: Int) throws -> Int {
            guard o + 2 <= data.count else { throw WAVError.truncated }
            return Int(data[o + 0]) | Int(data[o + 1]) << 8
        }
        func tag(_ o: Int) -> String {
            guard o + 4 <= data.count else { return "" }
            return String(decoding: data[o..<(o + 4)], as: UTF8.self)
        }

        guard tag(0) == "RIFF" else { throw WAVError.notRIFF }
        guard tag(8) == "WAVE" else { throw WAVError.notWAVE }

        // Walk the chunks rather than assuming fmt is at 12 and data at 36 — real files carry
        // LIST and fact chunks, and a fixed offset quietly reads garbage when they do.
        var offset = 12
        var formatCode = 0, channels = 0, rate = 0, bits = 0
        var dataRange: Range<Int>?
        while offset + 8 <= data.count {
            let id = tag(offset)
            let size = try u32(offset + 4)
            let body = offset + 8
            switch id {
            case "fmt ":
                formatCode = try u16(body)
                channels = try u16(body + 2)
                rate = try u32(body + 4)
                bits = try u16(body + 14)
            case "data":
                dataRange = body..<min(body + size, data.count)
            default:
                break
            }
            offset = body + size + (size % 2)          // chunks are word-aligned
        }

        guard channels > 0, rate > 0 else { throw WAVError.missingChunk("fmt ") }
        guard let dataRange else { throw WAVError.missingChunk("data") }
        guard formatCode == 1 || formatCode == 3 else {
            throw WAVError.unsupportedFormat(code: formatCode)
        }

        var interleaved: [Float] = []
        switch (formatCode, bits) {
        case (1, 16):
            let count = dataRange.count / 2
            interleaved.reserveCapacity(count)
            for i in 0..<count {
                let o = dataRange.lowerBound + i * 2
                let raw = Int16(bitPattern: UInt16(data[o]) | UInt16(data[o + 1]) << 8)
                interleaved.append(Float(raw) / 32768.0)
            }
        case (3, 32):
            let count = dataRange.count / 4
            interleaved.reserveCapacity(count)
            for i in 0..<count {
                let o = dataRange.lowerBound + i * 4
                let bitsLE = UInt32(data[o]) | UInt32(data[o + 1]) << 8
                    | UInt32(data[o + 2]) << 16 | UInt32(data[o + 3]) << 24
                interleaved.append(Float(bitPattern: bitsLE))
            }
        default:
            throw WAVError.unsupportedBitDepth(bits)
        }

        if channels == 1 {
            samples = interleaved
        } else {
            var mono: [Float] = []
            mono.reserveCapacity(interleaved.count / channels)
            var i = 0
            while i + channels <= interleaved.count {
                var sum: Float = 0
                for c in 0..<channels { sum += interleaved[i + c] }
                mono.append(sum / Float(channels))
                i += channels
            }
            samples = mono
        }
        self.sampleRate = rate
        self.channels = channels
    }

    public init(contentsOf url: URL) throws {
        try self.init(data: Data(contentsOf: url))
    }

    /// Linear resample to Kotiba's 16 kHz. Crude on purpose: it exists so a 44.1 kHz fixture
    /// can be replayed, not to be a quality resampler. Real capture resamples with
    /// AVAudioConverter.
    public func resampledTo16k() -> [Float] {
        guard sampleRate != AudioBuffer.sampleRate, sampleRate > 0 else { return samples }
        let ratio = Double(AudioBuffer.sampleRate) / Double(sampleRate)
        let outCount = Int(Double(samples.count) * ratio)
        guard outCount > 0 else { return [] }
        return (0..<outCount).map { i in
            samples[min(samples.count - 1, Int(Double(i) / ratio))]
        }
    }
}

/// Replays a file as if it were the microphone. Deterministic: the same fixture always
/// produces the same buffer.
///
/// An actor rather than a lock-guarded class — `NSLock.lock()` is unavailable from async
/// contexts under Swift 6, and reaching for `@unchecked Sendable` here would waste the one
/// exemption this codebase allows itself on a test double.
public actor WAVFileSource: AudioSource {
    private let buffer: AudioBuffer
    private var started = false

    /// Counted so A-06 can assert warm-up happens on every foreground rather than once.
    public private(set) var warmUpCount = 0

    public init(_ file: WAVFile) {
        buffer = AudioBuffer(samples: file.resampledTo16k())
    }

    public init(contentsOf url: URL) throws {
        buffer = AudioBuffer(samples: try WAVFile(contentsOf: url).resampledTo16k())
    }

    public init(samples: [Float]) {
        buffer = AudioBuffer(samples: samples)
    }

    public func start() async throws { started = true }

    public func stop() async throws -> AudioBuffer {
        guard started else { return AudioBuffer(samples: []) }
        started = false
        return buffer
    }

    public func warmUp() async { warmUpCount += 1 }
}

// `"\(error)"` is this codebase's interchange format at the module boundaries — 23 sites convert
// that way — and for an `Error` enum without `CustomStringConvertible` it reflects the case name
// instead of the diagnosis. A denied microphone reached the user as
// `engineFailedToStart("permissionDenied")`, which appears verbatim in real diagnostics. Each of
// these types already writes the actionable sentence in `reason`; this is what makes the
// interchange format use it, with no call-site changes.

extension WAVError: CustomStringConvertible {
    public var description: String { reason }
}
