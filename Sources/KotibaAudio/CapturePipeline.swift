import AVFoundation
import Foundation
import KotibaCore

// Capture with no length limit.
//
// Until this file the whole recording lived in one fixed ring: `MicrophoneSource(bufferSeconds:
// 120)` asked for 16 000 × 3 × 120 samples, the ring rounded that up to 2²³, and at the 48 kHz
// this Mac's microphones actually run at, 2²³ samples is **174.76 s**. The longest `audioSeconds`
// in the owner's diagnostics is 174.7626875 — exactly that, to the sample. The ring refuses a
// write when it is full, so everything said after minute three was counted in `droppedSamples`
// and never transcribed: the "long holds forget what I said" report, measured.
//
// The shape now:
//
//     render thread ──(lock-free SPSC ring, a few seconds deep)──▶ capture queue ──▶ take
//                                                                   every 20 ms    │
//                                        16 kHz, append-only, grows ◀── resample ──┘
//                                                                   └──▶ AsyncStream of chunks
//
// The render thread's contract is unchanged — preallocated memory and two atomics, never a lock
// or a malloc — so the ring stays exactly what it was, only much smaller: it is now a hand-off
// queue, not the recording. A consumer on an ordinary serial queue drains it every 20 ms,
// resamples to 16 kHz *during* speech, and appends to a store that grows. That moves the
// resampler off the key-up path as a bonus: a ten-minute hold used to be resampled in `stop()`,
// in front of the transcript.
//
// The ceiling is a deliberate limit, not a buffer size: `ceilingSeconds` (30 min) of 16 kHz
// audio is 115 MB, and the take says so through `onLimit` instead of dropping audio quietly.

/// Mono Float32 at any rate in, 16 kHz out, one chunk at a time.
///
/// One `AVAudioConverter` per take, fed incrementally. The converter keeps its filter state
/// between calls, so chunking does not change the output — `CapturePipelineTests` holds it to
/// that against a single whole-buffer conversion.
final class StreamingResampler {

    let sourceRate: Double
    private let converter: AVAudioConverter?
    private let inFormat: AVAudioFormat?
    private let outFormat: AVAudioFormat?
    private var inBuffer: AVAudioPCMBuffer?
    private var outBuffer: AVAudioPCMBuffer?
    private var finished = false

    init(sourceRate: Double) throws {
        self.sourceRate = sourceRate
        let target = Double(KotibaCore.AudioBuffer.sampleRate)
        guard sourceRate > 0 else {
            throw MicrophoneError.conversionFailed("the input reports a sample rate of \(sourceRate)")
        }
        guard sourceRate != target else {
            // 16 kHz hardware: nothing to do, and nothing a converter could add but latency.
            converter = nil; inFormat = nil; outFormat = nil
            return
        }
        guard
            let inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sourceRate,
                                         channels: 1, interleaved: false),
            let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: target,
                                          channels: 1, interleaved: false),
            let converter = AVAudioConverter(from: inFormat, to: outFormat)
        else {
            throw MicrophoneError.conversionFailed("could not build a converter for \(sourceRate) Hz")
        }
        // AVAudioConverter's defaults are not good enough to hand to an ASR front end. Probed on
        // this Mac they come out as quality 64 (`AVAudioQuality.medium`) and
        // `AVSampleRateConverterAlgorithm_Normal`, and measured with a 48 kHz sine sweep in and
        // the RMS of the 16 kHz output:
        //
        //   tone      default (q64/Normal)   q127/Mastering
        //   6.0 kHz        −2.13 dB             −0.00 dB
        //   7.0 kHz        −5.17 dB             −0.04 dB
        //   8.5 kHz     alias at −14 dB        −63 dB rejection
        //
        // So the default rolls off real speech from about 6 kHz and folds content above Nyquist
        // back down into the top mel bins. Those bins are where Uzbek keeps its sibilants and
        // affricates — sh, ch, q, x, gʻ — which is the worst possible place to lose 2–10 dB and
        // gain an alias image. Mastering is what soxr does for the training data, and streaming
        // it costs nothing on the key-up path: it runs every 20 ms, during speech, off the audio
        // thread. `CapturePipelineTests` re-measures the 6 kHz and 8.5 kHz rows through this type.
        converter.sampleRateConverterAlgorithm = AVSampleRateConverterAlgorithm_Mastering
        converter.sampleRateConverterQuality = AVAudioQuality.max.rawValue
        self.converter = converter
        self.inFormat = inFormat
        self.outFormat = outFormat
    }

    /// Resample one chunk. Returns whatever 16 kHz output the converter can produce so far; a few
    /// milliseconds are held back as filter state and come out of the next call or of `finish()`.
    func process(_ samples: UnsafeBufferPointer<Float>) throws -> [Float] {
        guard !samples.isEmpty, !finished else { return [] }
        guard let converter, let inFormat else { return Array(samples) }
        let input = try buffer(&inBuffer, format: inFormat, frames: samples.count)
        input.frameLength = AVAudioFrameCount(samples.count)
        input.floatChannelData![0].update(from: samples.baseAddress!, count: samples.count)
        return try drain(converter, supplying: input, thenEnd: false)
    }

    /// Flush the filter tail. The converter is spent afterwards; a take makes a new one.
    func finish() throws -> [Float] {
        guard !finished else { return [] }
        finished = true
        guard let converter else { return [] }
        return try drain(converter, supplying: nil, thenEnd: true)
    }

    private func drain(_ converter: AVAudioConverter, supplying input: AVAudioPCMBuffer?,
                       thenEnd: Bool) throws -> [Float] {
        guard let outFormat else { return [] }
        let expected = Int(Double(input.map { Int($0.frameLength) } ?? 0)
                           * outFormat.sampleRate / sourceRate) + 2048
        let output = try buffer(&outBuffer, format: outFormat, frames: expected)

        // `convert(to:error:withInputFrom:)` calls the block synchronously on this thread. The
        // box is how "hand the chunk over once, then say there is no more for now" is expressed
        // to a block the compiler must treat as escaping.
        final class Once: @unchecked Sendable { var supplied = false }
        let once = Once()
        nonisolated(unsafe) let chunk = input
        var out: [Float] = []
        out.reserveCapacity(expected)
        while true {
            output.frameLength = 0
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, status in
                if let chunk, !once.supplied {
                    once.supplied = true
                    status.pointee = .haveData
                    return chunk
                }
                // `.noDataNow` keeps the stream open: the converter returns what it has and waits
                // for the next chunk. `.endOfStream` flushes the filter's tail.
                status.pointee = thenEnd ? .endOfStream : .noDataNow
                return nil
            }
            if let error { throw MicrophoneError.conversionFailed(error.localizedDescription) }
            let produced = Int(output.frameLength)
            if produced > 0, let channel = output.floatChannelData?[0] {
                out.append(contentsOf: UnsafeBufferPointer(start: channel, count: produced))
            }
            switch status {
            case .haveData: continue            // the output filled; there is more
            case .inputRanDry, .endOfStream: return out
            case .error: throw MicrophoneError.conversionFailed("the converter reported an error")
            @unknown default: return out
            }
        }
    }

    /// Reuse the buffer when it is big enough. Growth is rare — a chunk is 20 ms of audio unless
    /// the consumer stalled — and it happens here, on the capture queue, never on the audio thread.
    private func buffer(_ slot: inout AVAudioPCMBuffer?, format: AVAudioFormat,
                        frames: Int) throws -> AVAudioPCMBuffer {
        if let existing = slot, Int(existing.frameCapacity) >= frames { return existing }
        guard let fresh = AVAudioPCMBuffer(pcmFormat: format,
                                           frameCapacity: AVAudioFrameCount(max(frames, 4096)))
        else { throw MicrophoneError.conversionFailed("could not allocate a \(frames)-frame buffer") }
        slot = fresh
        return fresh
    }
}

/// An append-only 16 kHz store that grows in fixed blocks.
///
/// Blocks rather than one array so a long hold never reallocates-and-copies a 100 MB array while
/// the user is still talking; the one contiguous copy happens once, at the end, because that is
/// the shape `AudioBuffer` and every engine want.
struct SampleChunks {
    static let blockSize = 1 << 16          // ~4 s at 16 kHz

    private var blocks: [[Float]] = []
    private var current: [Float] = []
    private(set) var count = 0

    mutating func append(_ samples: [Float]) {
        var rest = samples[...]
        while !rest.isEmpty {
            if current.capacity < Self.blockSize { current.reserveCapacity(Self.blockSize) }
            let room = Self.blockSize - current.count
            let take = rest.prefix(room)
            current.append(contentsOf: take)
            rest = rest.dropFirst(take.count)
            if current.count == Self.blockSize {
                blocks.append(current)
                current = []
            }
        }
        count += samples.count
    }

    func joined() -> [Float] {
        var out = [Float]()
        out.reserveCapacity(count)
        for block in blocks { out.append(contentsOf: block) }
        out.append(contentsOf: current)
        return out
    }
}

/// The consumer half: drains the ring into whichever take is open.
///
/// A *take* is one dictation's audio. There is at most one open at a time, but a finished one can
/// be waiting to be collected — that is what lets the next key-down start capturing while the
/// previous dictation has not yet called `stop()`: opening take N+1 seals N at that exact sample,
/// and N's own `stop()` later collects it. Nothing is restarted and nothing is lost at the seam.
///
/// All state below the ring is confined to `queue`; every public entry point hops onto it. That is
/// the whole of the `@unchecked Sendable` justification, and it is the second of the two reasons
/// the annotation is allowed in this module (the first being the audio-thread memory in
/// `AudioRingBuffer.swift`).
public final class CapturePipeline: @unchecked Sendable {

    /// What one take produced.
    public struct Result: Sendable {
        public var buffer: KotibaCore.AudioBuffer
        /// The take hit `ceilingSeconds`. Audio after that point was not kept, and the owner of
        /// the take was told through `onLimit` when it happened.
        public var reachedLimit: Bool
    }

    /// The single-producer ring the render thread writes into. Seconds deep, not minutes: it only
    /// has to cover the consumer being late, never the whole recording.
    public let ring: AudioRingBuffer
    public let ceilingSeconds: Double
    private let pumpInterval: DispatchTimeInterval
    private let queue = DispatchQueue(label: "uz.kotiba.capture", qos: .userInteractive)

    private final class Take {
        let id: UInt64
        let resampler: StreamingResampler
        var store = SampleChunks()
        let ceiling: Int
        var reachedLimit = false
        /// Samples at the hardware rate the ring could not hold, scaled at the end.
        var nativeDropped = 0
        var conversionError: String?
        let continuation: AsyncStream<[Float]>.Continuation?
        let onLimit: (@Sendable () -> Void)?

        init(id: UInt64, resampler: StreamingResampler, ceiling: Int,
             continuation: AsyncStream<[Float]>.Continuation?, onLimit: (@Sendable () -> Void)?) {
            self.id = id
            self.resampler = resampler
            self.ceiling = ceiling
            self.continuation = continuation
            self.onLimit = onLimit
        }

        func accept(_ samples: [Float]) {
            guard !samples.isEmpty, !reachedLimit else { return }
            let room = ceiling - store.count
            let kept = samples.count <= room ? samples : Array(samples.prefix(max(0, room)))
            if !kept.isEmpty {
                store.append(kept)
                continuation?.yield(kept)
            }
            if kept.count < samples.count {
                reachedLimit = true
                onLimit?()
            }
        }
    }

    private var open: Take?
    /// Takes sealed by a newer one before their own `stop()` arrived. Bounded: a take whose owner
    /// never collects it (a cancelled session that raced) must not pin 100 MB for the process.
    private var sealed: [(id: UInt64, result: Result)] = []
    private static let sealedLimit = 4
    private var lastRingDropped = 0
    private var timer: DispatchSourceTimer?

    public init(ringSeconds: Double = 20, maxHardwareRate: Double = 48_000,
                ceilingSeconds: Double = 30 * 60, pumpInterval: DispatchTimeInterval = .milliseconds(20)) {
        ring = AudioRingBuffer(minimumCapacity: Int(ringSeconds * maxHardwareRate))
        self.ceilingSeconds = ceilingSeconds
        self.pumpInterval = pumpInterval
    }

    deinit { timer?.cancel() }

    /// Whether a take is open. For the microphone's own bookkeeping and for tests.
    public var hasOpenTake: Bool { queue.sync { open != nil } }

    /// Discard whatever the ring holds and zero its loss counter. Only between takes, with the
    /// engine stopped — the ring's own contract.
    public func resetRing() {
        queue.sync {
            ring.reset()
            lastRingDropped = 0
        }
    }

    /// Open a take. Seals the one already open, at this exact point in the stream.
    ///
    /// - Parameters:
    ///   - continuation: receives every 16 kHz chunk as it is produced, and is finished when the
    ///     take ends. The seam for transcribing during speech.
    ///   - onLimit: called once, on the capture queue, when the take reaches `ceilingSeconds`.
    public func begin(take id: UInt64, sourceRate: Double,
                      continuation: AsyncStream<[Float]>.Continuation? = nil,
                      onLimit: (@Sendable () -> Void)? = nil) throws {
        let resampler = try StreamingResampler(sourceRate: sourceRate)
        queue.sync {
            if open != nil { sealOpenTake() }
            open = Take(id: id, resampler: resampler,
                        ceiling: Int(ceilingSeconds * Double(KotibaCore.AudioBuffer.sampleRate)),
                        continuation: continuation, onLimit: onLimit)
            startTimerIfNeeded()
        }
    }

    /// Close a take and hand back its audio. A take that was already sealed is collected; an
    /// unknown id gets an empty buffer — the same answer `stop()` has always given when nothing
    /// was being captured.
    public func end(take id: UInt64) -> Result {
        queue.sync {
            if let open, open.id == id {
                sealOpenTake()
                stopTimer()
            }
            guard let index = sealed.firstIndex(where: { $0.id == id }) else {
                return Result(buffer: KotibaCore.AudioBuffer(samples: []), reachedLimit: false)
            }
            return sealed.remove(at: index).result
        }
    }

    /// Drain the ring into the open take. Runs on the timer; callable directly by tests.
    public func pump() {
        queue.sync { pumpLocked() }
    }

    // MARK: Queue-confined

    private func pumpLocked() {
        let samples = ring.drain()
        let dropped = ring.dropped
        let lost = dropped - lastRingDropped
        lastRingDropped = dropped
        guard let take = open else { return }       // nothing open: the audio belongs to no one
        take.nativeDropped += max(0, lost)
        guard !samples.isEmpty, take.conversionError == nil else { return }
        do {
            let out = try samples.withUnsafeBufferPointer { try take.resampler.process($0) }
            take.accept(out)
        } catch {
            take.conversionError = "\(error)"
        }
    }

    private func sealOpenTake() {
        guard let take = open else { return }
        pumpLocked()                                  // everything up to this instant is theirs
        if take.conversionError == nil {
            do { take.accept(try take.resampler.finish()) } catch {
                take.conversionError = "\(error)"
            }
        }
        take.continuation?.finish()
        open = nil
        let rate = take.resampler.sourceRate
        let scaledDrop = rate > 0
            ? Int((Double(take.nativeDropped) * Double(KotibaCore.AudioBuffer.sampleRate) / rate)
                  .rounded())
            : take.nativeDropped
        // A converter failure mid-take still returns what was converted before it, with the rest
        // counted as lost: a truncated transcript said out loud beats an empty one.
        let result = Result(
            buffer: KotibaCore.AudioBuffer(samples: take.store.joined(), droppedSamples: scaledDrop),
            reachedLimit: take.reachedLimit)
        sealed.append((take.id, result))
        if sealed.count > Self.sealedLimit { sealed.removeFirst(sealed.count - Self.sealedLimit) }
    }

    private func startTimerIfNeeded() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + pumpInterval, repeating: pumpInterval,
                       leeway: .milliseconds(5))
        timer.setEventHandler { [weak self] in self?.pumpLocked() }
        timer.resume()
        self.timer = timer
    }

    private func stopTimer() {
        timer?.cancel()
        timer = nil
    }
}
