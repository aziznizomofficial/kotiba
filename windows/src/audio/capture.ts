// The live microphone, as the session sees it.
//
// Port of Sources/KotibaAudio/MicrophoneSource.swift, with the capture itself moved into a
// hidden renderer (D-W6) and reached through `AudioHost`. Everything else — when warm-up
// runs, what makes a graph stale, what `start()` throws, what `stop()` returns — is the
// macOS behaviour, including the bugs it was shaped by.
//
// Uses Node timers. Never imports Electron: the hidden window belongs to `src/main`.

import {
  MicrophoneFailure,
  microphoneError,
  type AudioBuffer,
  type AudioCapture,
  type AudioTake,
  type AudioTakeOptions,
  type CreateAudioCapture,
  type InputDeviceInfo,
  type MicrophoneError,
} from '../contracts/index.js';
import { classifyTransport } from '../core/input-device/index.js';
import { CAPTURE_CEILING_SECONDS, CaptureAccumulator } from './accumulator.js';
import type { AudioHost, AudioHostEvent } from './host.js';
import { LevelMeter } from './levels.js';

/**
 * How long the microphone stream stays open after the key comes up.
 *
 * WINDOWS-ONLY, and a deliberate compromise rather than parity. On macOS `engine.stop()`
 * leaves the graph attached and prepared with nothing running, so the next press skips
 * device setup at no visible cost. `getUserMedia` has no such state: a live track lights
 * the Windows microphone indicator, and an indicator lit while the user is not dictating
 * reads as spyware — correctly, since it means the app can hear them.
 *
 * So the stream is held only across the gap between two presses of the same thought, and
 * then released. Two seconds covers "press, release, realise you left a word out, press
 * again" and nothing longer. `warmUp()` — which runs on every foreground — deliberately
 * does NOT open the stream, so the indicator is only ever lit while dictating or in this
 * window.
 */
export const WARM_HOLD_MS = 2_000;

/** The `AudioContext` rate the renderer must report. Anything else means D-W6 was not honoured. */
const REQUIRED_RATE = 16_000;

const EMPTY: AudioBuffer = { samples: new Float32Array(0), droppedSamples: 0 };

/**
 * The message the blocker UI shows verbatim after a device change.
 * Sources/KotibaAudio/MicrophoneSource.swift:226, with "audio graph" kept because it is
 * the phrase the empty-capture failure message also uses.
 */
export const DEVICE_CHANGED_MESSAGE =
  'the input device changed — the audio graph is rebuilt on the next press';

export interface MicrophoneCaptureOptions {
  /** One take's ceiling. Defaults to 30 minutes, the Mac's. */
  readonly ceilingSeconds?: number;
  /** The hidden renderer. Injected, so tests drive the whole state machine with no browser. */
  readonly host: AudioHost;
  /** Overridable so a test does not sleep for two real seconds. */
  readonly warmHoldMs?: number;
}

/** One take's state. Its samples arrive as `chunk` events tagged with its segment. */
class Take implements AudioTake {
  readonly #owner: MicrophoneCapture;
  readonly #options: AudioTakeOptions;
  readonly store: CaptureAccumulator;
  readonly #listeners = new Set<(samples: Float32Array) => void>();
  segment = 0;
  /** Samples that arrived for this take, counted before the ceiling. Checked against the source. */
  received = 0;
  started = false;
  stopped = false;
  /** The microphone this take started on, from the host's answer to `start`. */
  device: InputDeviceInfo | undefined;
  #limitReported = false;

  constructor(owner: MicrophoneCapture, ceilingSeconds: number, options: AudioTakeOptions) {
    this.#owner = owner;
    this.#options = options;
    this.store = new CaptureAccumulator(ceilingSeconds);
  }

  /** One chunk from the stream. The ONLY way samples reach the store. */
  accept(samples: Float32Array): void {
    this.received += samples.length;
    // AT THE CEILING, KEEP WHAT FITS AND STOP — the Mac's `CapturePipeline.Take.accept`
    // (`reachedLimit`). Audio past the ceiling is not "lost": the take is over, and the
    // session stops it. It used to reach the live stream anyway and be counted as dropped
    // by the store, and a non-zero drop or a stream longer than the recording makes BOTH
    // streams' `finish()` throw away everything decoded during a 30-minute hold and
    // re-decode it in one batch — for Uzbek one whisper request that cannot finish.
    const room = this.store.capacity - this.store.length;
    if (room <= 0) return;
    const kept = samples.length <= room ? samples : samples.subarray(0, room);
    for (const listener of [...this.#listeners]) {
      try {
        listener(kept);
      } catch {
        // A consumer of the live stream must never cost the take its audio.
      }
    }
    this.store.write(kept);
    if (this.store.isFull && !this.#limitReported) {
      this.#limitReported = true;
      this.#options.onLimit?.();
    }
  }

  start(): Promise<void> {
    return this.#owner.startTake(this);
  }

  stop(): Promise<AudioBuffer> {
    return this.#owner.stopTake(this);
  }

  onChunk(listener: (samples: Float32Array) => void): () => void {
    // A LATE SUBSCRIBER GETS WHAT IS ALREADY HERE FIRST. The take starts at key-down, the
    // live stream subscribes once the mode is resolved — the chunks in between must reach
    // it, or its sample count falls behind the recording and Parakeet's
    // `subarray(committedSamples)` seam is offset (words duplicated or dropped).
    if (this.store.length > 0) {
      try {
        listener(this.store.drain().samples);
      } catch {
        // A consumer of the live stream must never cost the take its audio.
      }
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

class MicrophoneCapture implements AudioCapture {
  readonly #host: AudioHost;
  readonly #warmHoldMs: number;
  readonly #ceilingSeconds: number;
  readonly #meter = new LevelMeter();
  readonly #unsubscribe: () => void;

  #warm = false;
  #lastWarmUpError: string | null = null;
  #lastWarmUpFailure: MicrophoneError | null = null;
  /**
   * Separate from `#warm` on purpose. A warm-up that fails for a NON-staleness reason —
   * a denied permission, say — must not clear staleness, or the graph is never rebuilt
   * once the real reason is fixed. This is why macOS carries `graphIsStale` beside
   * `isWarm` rather than folding them into one flag.
   */
  #stale = true;
  #streamOpen = false;
  #releaseTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  /** Observability, and the signature of the stale-graph bug: many warm-ups, no audio. */
  #warmUpCount = 0;
  #configurationChangeCount = 0;
  /** Every take that has started and not yet stopped, by segment. */
  readonly #takes = new Map<number, Take>();
  #nextSegment = 1;
  /** The take `start()`/`stop()` drive, for callers that never overlap. */
  #single: Take | null = null;

  constructor(options: MicrophoneCaptureOptions) {
    this.#host = options.host;
    this.#warmHoldMs = options.warmHoldMs ?? WARM_HOLD_MS;
    this.#ceilingSeconds = options.ceilingSeconds ?? CAPTURE_CEILING_SECONDS;
    this.#unsubscribe = this.#host.onEvent((event) => {
      this.#handle(event);
    });
  }

  get isWarm(): boolean {
    return this.#warm;
  }

  get lastWarmUpError(): string | null {
    return this.#lastWarmUpError;
  }

  /**
   * Cold for a reason only the user can clear. A device change or an ended stream does not
   * touch `#lastWarmUpFailure` (they are noted, not failed), so they read as `false` — the
   * next warm-up or press rebuilds the graph by itself.
   */
  get warmUpNeedsTheUser(): boolean {
    if (this.#warm) return false;
    const kind = this.#lastWarmUpFailure?.kind;
    return kind === 'permissionDenied' || kind === 'noInputAvailable';
  }

  get warmUpCount(): number {
    return this.#warmUpCount;
  }

  get configurationChangeCount(): number {
    return this.#configurationChangeCount;
  }

  /** Whether the microphone indicator is lit right now. Asserted by the warm-hold test. */
  get isStreamOpen(): boolean {
    return this.#streamOpen;
  }

  /** How many takes are open. More than one means a seal is pending its stop. */
  get openTakes(): number {
    return this.#takes.size;
  }

  #handle(event: AudioHostEvent): void {
    switch (event.kind) {
      case 'level':
        this.#meter.publishPeak(event.peak);
        return;
      case 'chunk':
        // Routed by segment, never by "whichever take is newest": a chunk still in flight
        // from the take a new press just sealed belongs to that take, and delivering it to
        // the new one would put the end of one dictation at the start of the next.
        this.#takes.get(event.segment)?.accept(event.samples);
        return;
      case 'deviceChanged':
      case 'streamEnded':
        // The macOS `noteConfigurationChange()`, verbatim in effect: count it, mark the
        // graph stale, drop `isWarm`, and record the sentence the blocker UI shows. It
        // deliberately does NOT end a take — a change arriving mid-dictation truncates the
        // recording, and `stop()` still returns what did arrive, because a truncated
        // transcript beats an empty one.
        this.#configurationChangeCount += 1;
        this.#stale = true;
        this.#warm = false;
        // `#streamOpen` is NOT cleared: `devicechange` fires for any device — headphones
        // connecting — while the page's track is still live, and a stream this module
        // thinks is closed is a stream it never releases: the microphone light stays on.
        // The release after the last take always goes out; releasing a closed stream is
        // a no-op in the page.
        this.#lastWarmUpError = DEVICE_CHANGED_MESSAGE;
        return;
    }
  }

  /**
   * Prepare without capturing. Never throws — a warm-up failure is reported through
   * `isWarm` / `lastWarmUpError`, which is what `AudioSource.warmUp()` promises on macOS.
   *
   * ALWAYS ATTEMPTS, even after a previous success and especially after a previous
   * failure, and it runs on every foreground rather than once. Doing it once is the exact
   * defect this replaced: the sink was attached once forever, so after a device change
   * the graph had dropped its connections while `prepare()` kept succeeding and `isWarm`
   * stayed true. Twelve of 159 activations captured zero samples and the user was told
   * "I did not hear anything".
   */
  async warmUp(): Promise<void> {
    if (this.#disposed) return;
    this.#warmUpCount += 1;
    const reply = await this.#host.send({ kind: 'warmUp' });
    if (reply.kind === 'error') {
      this.#warm = false;
      this.#lastWarmUpFailure = reply.error;
      this.#lastWarmUpError = reply.error.reason;
      return;
    }
    if (reply.kind !== 'warmedUp') {
      this.#warm = false;
      this.#lastWarmUpFailure = microphoneError.engineFailedToStart(
        `the capture window answered ${reply.kind} to a warm-up`,
      );
      this.#lastWarmUpError = this.#lastWarmUpFailure.reason;
      return;
    }
    if (reply.sampleRate !== REQUIRED_RATE) {
      // D-W6 is not advisory. If the context is not at 16 kHz then either the browser
      // refused the rate or somebody built the context elsewhere, and in both cases
      // something downstream would have to resample — which is the defect this whole
      // decision exists to prevent.
      this.#warm = false;
      this.#lastWarmUpFailure = microphoneError.conversionFailed(
        `the capture window is running at ${reply.sampleRate} Hz, not ${REQUIRED_RATE} Hz`,
      );
      this.#lastWarmUpError = this.#lastWarmUpFailure.reason;
      return;
    }
    this.#stale = false;
    this.#warm = true;
    this.#lastWarmUpError = null;
    this.#lastWarmUpFailure = null;
  }

  openTake(options: AudioTakeOptions = {}): AudioTake {
    return new Take(this, this.#ceilingSeconds, options);
  }

  /**
   * Open the microphone for one take. Driven by key-down; until it returns the take is
   * not recording.
   *
   * There is NO pre-roll. A take's store starts empty and receives only chunks tagged
   * with its own segment, which the renderer starts tagging when this command arrives —
   * exactly as macOS `start()` throws away anything that arrived earlier. A port that
   * keeps a hot stream and a pre-roll puts audio from before the key press into the
   * transcript.
   */
  async startTake(take: Take): Promise<void> {
    if (this.#disposed) throw new MicrophoneFailure(microphoneError.engineFailedToStart('disposed'));
    if (take.started) return; // `guard !isCapturing else { return }`
    this.#cancelRelease();

    if (this.#takes.size === 0 && (!this.#warm || this.#stale)) await this.warmUp();
    if (!this.#warm && this.#takes.size === 0) {
      // Rethrow the typed warm-up failure UNWRAPPED, so a permission denial stays a
      // permission denial. Wrapping it is how a denied microphone once reached users as
      // engineFailedToStart("permissionDenied").
      throw new MicrophoneFailure(
        this.#lastWarmUpFailure ??
          microphoneError.engineFailedToStart(this.#lastWarmUpError ?? 'not warm'),
      );
    }

    take.segment = this.#nextSegment;
    this.#nextSegment += 1;
    // Registered BEFORE the command goes out: the first chunk can arrive before the reply.
    this.#takes.set(take.segment, take);
    take.started = true;
    if (this.#takes.size === 1) this.#meter.reset();

    const reply = await this.#host.send({ kind: 'start', segment: take.segment });
    if (reply.kind === 'error') {
      this.#takes.delete(take.segment);
      take.started = false;
      this.#warm = false;
      this.#lastWarmUpFailure = reply.error;
      this.#lastWarmUpError = reply.error.reason;
      throw new MicrophoneFailure(reply.error);
    }
    this.#streamOpen = true;
    // Which microphone this take is listening to. Kept per take: a device change between two
    // takes must not relabel the earlier one.
    if (reply.kind === 'ok' && reply.device !== undefined) {
      const { label, sampleRate } = reply.device;
      take.device = {
        name: label === '' ? 'unnamed input' : label,
        transport: classifyTransport(label),
        ...(sampleRate === null ? {} : { sampleRate }),
        // Only the `default` device is ever requested, so this is always the system default.
        overrodeDefault: false,
      };
    }
  }

  /**
   * Everything the take captured. Empty when it never started — not an error, exactly as
   * on macOS, because a stray key-up must not become a failure the user sees.
   *
   * The stream is NOT closed here; a timer closes it `warmHoldMs` after the LAST take
   * stops. See WARM_HOLD_MS.
   */
  async stopTake(take: Take): Promise<AudioBuffer> {
    if (!take.started || take.stopped) {
      return take.stopped ? take.store.drain() : EMPTY;
    }
    take.stopped = true;

    const reply = await this.#host.send({ kind: 'stop', segment: take.segment });
    this.#takes.delete(take.segment);
    if (this.#takes.size === 0) {
      this.#meter.reset();
      this.#scheduleRelease();
    }

    if (reply.kind === 'error') {
      this.#warm = false;
      this.#lastWarmUpFailure = reply.error;
      this.#lastWarmUpError = reply.error.reason;
      // NOT a throw. A failed stop still hands the session what did arrive, and the
      // session's own rule — empty capture is a broken microphone, never the user's
      // silence — is what turns an empty one into the right message.
    }

    const drained = take.store.drain();
    // AUDIO LOST IN TRANSIT IS COUNTED, NOT MISSING. The renderer counted every sample it
    // streamed for this segment; every chunk crosses the same pipe as the reply and
    // strictly before it, so anything short of that count never arrived.
    let lost = 0;
    if (reply.kind === 'stopped' && reply.totalSamples >= 0 && reply.totalSamples > take.received) {
      lost = reply.totalSamples - take.received;
    }
    const rendererDropped = reply.kind === 'stopped' ? reply.droppedSamples : 0;
    return {
      samples: drained.samples,
      droppedSamples: drained.droppedSamples + rendererDropped + lost,
      ...(take.device === undefined ? {} : { device: take.device }),
    };
  }

  /** One take, for callers that never overlap. */
  async start(): Promise<void> {
    if (this.#single !== null && this.#single.started && !this.#single.stopped) return;
    const take = new Take(this, this.#ceilingSeconds, {});
    this.#single = take;
    try {
      await this.startTake(take);
    } catch (error: unknown) {
      this.#single = null;
      throw error;
    }
  }

  async stop(): Promise<AudioBuffer> {
    const take = this.#single;
    if (take === null) return EMPTY;
    this.#single = null;
    return this.stopTake(take);
  }

  /** Cheap, synchronous, called on a 50 ms timer. Never consumes a sample. */
  currentPeak(): number {
    return this.#meter.level;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelRelease();
    this.#unsubscribe();
    this.#takes.clear();
    this.#streamOpen = false;
    this.#warm = false;
    await this.#host.send({ kind: 'dispose' });
  }

  #scheduleRelease(): void {
    this.#cancelRelease();
    if (!this.#streamOpen) return;
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = null;
      if (this.#takes.size > 0) return; // a take opened since; the stream is in use
      this.#streamOpen = false;
      void this.#host.send({ kind: 'release' }).catch(() => {
        // A release that fails leaves the indicator lit, which the next warm-up fixes.
        // It is not worth failing a finished dictation over.
      });
    }, this.#warmHoldMs);
    // Do not hold the process open for the sake of putting an indicator out.
    this.#releaseTimer.unref?.();
  }

  #cancelRelease(): void {
    if (this.#releaseTimer !== null) {
      clearTimeout(this.#releaseTimer);
      this.#releaseTimer = null;
    }
  }
}

/**
 * The live microphone. `src/main` builds the hidden window and passes it in as `host`.
 *
 * Satisfies `CreateAudioCapture`, which only names `ceilingSeconds` — the host is an
 * additional, required option, and a caller that omits it is told so rather than getting
 * a capture object that fails on the first press.
 */
export const createAudioCapture: CreateAudioCapture = (options): AudioCapture => {
  const full = options as MicrophoneCaptureOptions;
  if (full.host === undefined) {
    throw new MicrophoneFailure(
      microphoneError.engineFailedToStart(
        'createAudioCapture was called without a capture window — src/main owns the hidden ' +
          'renderer and must pass it as `host`',
      ),
    );
  }
  return new MicrophoneCapture(full);
};

/** Exposed for the tests, which need the concrete type's observability fields. */
export function createMicrophoneCapture(options: MicrophoneCaptureOptions): MicrophoneCapture {
  return new MicrophoneCapture(options);
}

export type { MicrophoneCapture };
