import Foundation
import KotibaCore
import Synchronization

// The seam between the controller and a microphone.
//
// `DictationController` used to own a `MicrophoneSource` outright, so every controller a test
// built made a real `AVAudioEngine` — about seventy per `swift test` — and every test that went
// through `start()` or `recheck()` warmed it, which opens the owner's microphone (the orange dot)
// and, on a machine without the TCC grant, a permission dialog in the middle of a test run. It was
// also the reason no harness could drive the controller's real press → release path with known
// audio: the only way in was a live room.
//
// So the controller takes one of these. The app hands it `MicrophoneSource`; tests hand it a
// `ReplayMicrophone` with nothing queued (silence, no hardware); `kotiba-probe e2e` hands it one
// loaded with WAVs, which it plays into each take at the hardware's own chunk cadence, on the
// wall clock — so everything that happens during a hold (streaming decodes, early routing,
// sentence polish) races the "speaker" exactly as it does in the app.

/// What the controller needs from a microphone. Everything a press, a warm-up and the HUD's
/// level meter touch — and nothing else, so a fake has nothing to pretend about.
public protocol DictationMicrophone: AnyObject, Sendable {
    /// A handle for one dictation's audio, made synchronously at key-down. See `MicrophoneTake`.
    nonisolated func liveTake(onLimit: (@Sendable () -> Void)?) -> any LiveAudioSource
    /// Prepare the graph without capturing. Called on every foreground.
    func warmUp() async
    /// Ready for a press.
    var isWarm: Bool { get async }
    /// Why warm-up last failed, in words.
    var lastWarmUpError: String? { get async }
    /// Whether that failure is one only the user can clear — the microphone grant, or no input
    /// device at all. Everything else a warm-up can hit is rebuilt by the next press, and is not
    /// something to put in front of the user as a problem.
    var warmUpNeedsTheUser: Bool { get async }
    /// The current loudness, 0…1, for the HUD's meter.
    nonisolated func currentPeak() -> Float
    /// Record from the Mac's own microphone instead of a Bluetooth headset's.
    nonisolated func setPrefersBuiltInMicWithBluetooth(_ value: Bool)
}

extension MicrophoneSource: DictationMicrophone {
    public nonisolated func liveTake(onLimit: (@Sendable () -> Void)?) -> any LiveAudioSource {
        take(onLimit: onLimit)
    }
}

// MARK: - A microphone that plays files

/// A microphone with no hardware behind it. Each take plays the next queued clip — followed by
/// silence for as long as the "key" is held — in `chunkMilliseconds` pieces on the wall clock,
/// and `stop()` returns exactly what was played. With nothing queued a take is silence.
///
/// Real time is the point, not a detail: the pipeline does work *during* the hold (streaming
/// decodes at pauses, early language detection, sentence-by-sentence polish), and whether that
/// work is finished by key-up is what key-up latency depends on. Feeding faster than real time
/// would measure a machine that does not exist.
public final class ReplayMicrophone: DictationMicrophone, @unchecked Sendable {

    private let state = Mutex<State>(State())
    private struct State {
        var queue: [[Float]] = []
        var level: Float = 0
        var started: ContinuousClock.Instant?
    }
    /// 20 ms: what `CapturePipeline` delivers from the real hardware (its consumer timer).
    public let chunkMilliseconds: Int
    /// Played at this multiple of real time. 1 in every measurement; tests may go faster.
    public let speed: Double

    public init(chunkMilliseconds: Int = 20, speed: Double = 1) {
        self.chunkMilliseconds = chunkMilliseconds
        self.speed = speed
    }

    /// The audio the next take plays, 16 kHz mono.
    public func enqueue(_ samples: [Float]) {
        state.withLock { $0.queue.append(samples) }
    }

    public nonisolated func liveTake(onLimit: (@Sendable () -> Void)?) -> any LiveAudioSource {
        let clip = state.withLock { s -> [Float] in
            s.started = nil
            return s.queue.isEmpty ? [] : s.queue.removeFirst()
        }
        return ReplayTake(clip: clip, chunk: max(1, AudioBuffer.sampleRate * chunkMilliseconds
                                                  / 1000),
                          speed: speed, owner: self)
    }

    public func warmUp() async {}
    public var isWarm: Bool { true }
    public var lastWarmUpError: String? { nil }
    public var warmUpNeedsTheUser: Bool { false }
    public nonisolated func currentPeak() -> Float { state.withLock { $0.level } }
    public nonisolated func setPrefersBuiltInMicWithBluetooth(_ value: Bool) {}

    fileprivate func setLevel(_ level: Float) { state.withLock { $0.level = level } }
    fileprivate func noteStart(_ instant: ContinuousClock.Instant) {
        state.withLock { $0.started = instant }
    }

    /// When the latest take began playing — what a harness times its key-up from.
    public var lastTakeStarted: ContinuousClock.Instant? { state.withLock { $0.started } }
}

/// One replayed take. `start()` begins playing; `stop()` ends it where it has got to.
private final class ReplayTake: LiveAudioSource, @unchecked Sendable {
    let chunks: AsyncStream<[Float]>
    private let continuation: AsyncStream<[Float]>.Continuation
    private let clip: [Float]
    private let chunk: Int
    private let speed: Double
    private weak var owner: ReplayMicrophone?
    private let played = Mutex<[Float]>([])
    private let feeder = Mutex<Task<Void, Never>?>(nil)

    init(clip: [Float], chunk: Int, speed: Double, owner: ReplayMicrophone) {
        self.clip = clip
        self.chunk = chunk
        self.speed = speed
        self.owner = owner
        (chunks, continuation) = AsyncStream<[Float]>.makeStream(bufferingPolicy: .unbounded)
    }

    func start() async throws {
        let task = Task { [clip, chunk, speed, continuation, weak owner, self] in
            let clock = ContinuousClock()
            let begun = clock.now
            owner?.noteStart(begun)
            var offset = 0
            while !Task.isCancelled {
                // Past the end of the clip the "room" is silent until the key comes up.
                let piece: [Float] = offset < clip.count
                    ? Array(clip[offset..<min(offset + chunk, clip.count)])
                    : [Float](repeating: 0, count: chunk)
                offset += piece.count
                self.played.withLock { $0.append(contentsOf: piece) }
                continuation.yield(piece)
                owner?.setLevel(piece.reduce(0) { max($0, abs($1)) })
                let due = begun + .milliseconds(Int(Double(offset) * 1000
                                                    / Double(AudioBuffer.sampleRate) / speed))
                try? await Task.sleep(until: due, clock: .continuous)
            }
        }
        feeder.withLock { $0 = task }
    }

    func stop() async throws -> AudioBuffer {
        let task = feeder.withLock { t -> Task<Void, Never>? in defer { t = nil }; return t }
        task?.cancel()
        await task?.value
        continuation.finish()
        owner?.setLevel(0)
        return AudioBuffer(samples: played.withLock { $0 })
    }

    func warmUp() async {}
}
