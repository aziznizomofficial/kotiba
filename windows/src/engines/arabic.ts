// Arabic on Windows — the owner's rule, built on C4's measurements.
//
//   COHERE BY DEFAULT. Cohere Transcribe Arabic through transcribe.cpp (Vulkan when the PC has a
//   GPU, the CPU otherwise) is the most accurate on-device Arabic measured: 7.0 % WER on MSA,
//   38 % on dialects, punctuation F1 73 (C4 §3.2).
//
//   A FIRST-RUN SPEED CHECK, AND AN AUTOMATIC FALLBACK. On a PC where Cohere's key-release cost
//   is too high it is the wrong engine however accurate it is: C4 §6 put it at ~0.6 s for a
//   3 s tail on this Mac's CPU and ~1–2 s on a 2020 laptop. So the first time Cohere loads, it
//   decodes a standard 3 s Arabic clip (a FLEURS ar_eg cut, shipped in the installer); if that
//   takes more than `DEFAULT_SPEED_THRESHOLD_MS`, Arabic switches itself to NVIDIA's 115 M
//   FastConformer (132 MB, ~20–90 ms on a CPU, whisper-turbo accuracy WITH punctuation — C4
//   §7.3.1), fetched then under the same consent that fetched Cohere. The verdict is stored,
//   so the check runs once per PC (and again only if the GPU setting changes what Cohere runs
//   on). The Languages page says which engine is active and why, and the user can override it.
//
//   STREAMED LIKE UZBEK. Neither engine streams natively, so the dictation runs through the
//   same `StreamingWhisperSession` the Uzbek engine uses — Silero pauses, commits behind the
//   speaker, a speculative decode at every pause and the release cut at the last one (C4 §8:
//   "the whisper session's policy with a different decoder") — with commits every 14–18 s so
//   no segment ever nears Cohere's 35 s window (C4 §3.3), and no carried prompt (neither
//   decoder takes one). Cohere on a CPU decodes slower than the pauses come, so there a pause
//   decode already running is never thrown away for a newer pause (`coalesceSpeculations`,
//   C4 §14.4); shorter commits were measured and cost Cohere accuracy (6 s: +1.1 WER) without
//   buying the CPU its release back.
//
//   THE DECODE-LOOP GUARD (C4 §3.2): a segment Cohere loops on until its generation cap is
//   re-decoded by the Arabic family's whisper turbo member (`attachFallback`) instead of pasting
//   nothing.
//
// The decoders live in their own OS process (`arabic-runtime.ts`, D-W22); this file is the
// policy: which one, when to fetch, when to switch, and how a recording is cut for it.

import {
  EngineFailure,
  SAMPLE_RATE,
  bundleBytes,
  engineError,
  BUNDLE_CATALOGUE,
  type ArabicEngineChoice,
  type AudioBuffer,
  type BundleId,
  type BundleState,
  type Language,
  type StreamingSttEngine,
  type SttEngine,
  type TranscriptionStream,
  type TranscriptResult,
} from '../contracts/index.js';
import { segmentCut, type StreamSegmenter } from '../core/stt/segmenter.js';
import { DEFAULT_SPEECH_SEGMENTER, joinSegments, type SpeechSegmenterConfiguration } from '../core/stt/speech-segmenter.js';

import {
  ARABIC_MAX_SEGMENT_SECONDS,
  ArabicAborted,
  loadArabicRuntime,
  startArabicProcess,
  type ArabicEngineKind,
  type ArabicRuntime,
  type ArabicRuntimeOptions,
} from './arabic-runtime.js';
import type { BundleStore } from './bundle-store.js';
import { CrashLimiter, EngineProcessExit, type EngineLauncher } from './engine-process.js';
import type { SegmentDecodingEngine } from './stt-engine.js';
import { StreamingWhisperSession, energyDetector, type AsyncSpeechDetector, type SegmentDecoder } from './streaming-whisper.js';


/**
 * Release→text on the standard 3 s clip above which Cohere is "too slow here". The owner's
 * number, tightened from 450 to 300 ms: the 3 s check does not see the backlog of decodes queued
 * during a hold, so a PC that just passed 450 ms still waited ~1 s on a 10 s dictation
 * (03-ENGINE-PARITY §16). For scale (C4 §4, §6 and this port's own probe): Metal 133–158 ms,
 * this Mac's CPU at 8 threads 314–364 ms, at 4 threads 560–615 ms — so only a PC with a usable
 * GPU (Vulkan) or very fast cores keeps Cohere, and every other one gets FastConformer.
 * Reconsidered with the CPU's pause decodes coalesced (C4 §14.4): a ~10 s dictation's release
 * is then ~1.9× this clip's time, so 300 ms still means about half a second — kept.
 */
export const DEFAULT_SPEED_THRESHOLD_MS = 300;

/** What one speed check found. Stored, so it runs once per PC. */
export interface ArabicSpeedCheck {
  /** The faster of two timed decodes of the standard clip, after a warm-up. */
  readonly milliseconds: number;
  readonly thresholdMs: number;
  readonly slow: boolean;
  /** What Cohere ran on: "Vulkan (…)" or "CPU". */
  readonly device: string;
  /** The backend REQUESTED (`auto`/`cpu`) — a verdict for one does not answer for the other. */
  readonly backend: 'auto' | 'cpu';
  readonly clipSeconds: number;
  readonly measuredAt: string;
}

export interface ArabicSpeedCheckStore {
  read(): Promise<ArabicSpeedCheck | null>;
  write(check: ArabicSpeedCheck): Promise<void>;
}

/** Why the active engine is the active engine — the Languages page's sentence. */
export type ArabicActiveReason = 'chosen' | 'speedCheckFast' | 'speedCheckSlow' | 'notChecked' | 'fallbackWhileLoading';

export interface ArabicEngineStatus {
  readonly choice: ArabicEngineChoice;
  /** The engine Arabic dictations go to once it is loaded. */
  readonly wanted: ArabicEngineKind;
  /** The engine actually serving right now, or `null` (whisper turbo serves until one loads). */
  readonly active: ArabicEngineKind | null;
  readonly reason: ArabicActiveReason;
  readonly device: string | null;
  readonly speedCheck: ArabicSpeedCheck | null;
  readonly cohere: BundleState;
  readonly fastConformer: BundleState;
}

/** The segmenter Arabic streams with: C4's 14 s commits, never near Cohere's 35 s window. */
export const ARABIC_SPEECH_SEGMENTER: SpeechSegmenterConfiguration = {
  ...DEFAULT_SPEECH_SEGMENTER,
  minimumSegment: 14,
  relaxAfter: 16,
  maximumSegment: 18,
};

/** How a batch recording is cut for these decoders: quietest 200 ms, pieces of 12–20 s. */
const BATCH_SEGMENTER: StreamSegmenter = {
  sampleRate: SAMPLE_RATE,
  commitAfter: 20,
  earliestCut: 12,
  frame: 0.02,
  quietRun: 0.2,
};

const BUNDLE_FOR: Readonly<Record<ArabicEngineKind, BundleId>> = { cohere: 'cohere_arabic', fastConformer: 'fastconformer_ar' };
const ENGINE_ID_FOR: Readonly<Record<ArabicEngineKind, string>> = {
  cohere: 'cohere-transcribe-arabic-07-2026-q5_k_m',
  fastConformer: 'fastconformer-ar-pcd-int8',
};

export interface ArabicEngineOptions {
  readonly store: BundleStore;
  /** CPU threads for either decoder (`resolveOrtThreads` — physical cores, at most 8). */
  readonly threads: number;
  /** The user's choice, read at the moment of need (the Languages page writes it). */
  readonly choice?: () => ArabicEngineChoice;
  /** `auto` lets transcribe.cpp take Vulkan; `cpu` is `Settings.whisperUseGPU === false`. */
  readonly backend?: () => 'auto' | 'cpu';
  /**
   * Fetch on first use. A function asked at the moment of need: yes only while Arabic is on and
   * its download was accepted — 1.77 GB never starts behind someone who has not seen it.
   */
  readonly autoDownload?: boolean | (() => boolean);
  /** Where the speed-check verdict lives. In memory when absent (tests, `--check`). */
  readonly speedChecks?: ArabicSpeedCheckStore;
  /** The standard clip, 16 kHz mono. `null`: no check can run, and Cohere stays. */
  readonly speedClip?: () => Promise<Float32Array | null>;
  readonly speedThresholdMs?: number;
  /** `ggml-silero-v6.2.0.bin`, for the stream's pauses. Absent or null: the energy gate. */
  readonly speechDetectorPath?: () => Promise<string | null>;
  /** Run each decoder in its own OS process (D-W22). Absent: in this process. */
  readonly launcher?: EngineLauncher;
  readonly crashLimiter?: CrashLimiter;
  /** Injected by the tests. */
  readonly loadRuntime?: (options: ArabicRuntimeOptions) => Promise<ArabicRuntime>;
  /** Give the model back after this long unused (Cohere is ~2–3 GB resident). `null` never. */
  readonly idleUnloadMs?: number | null;
  /** How long `prepare()` waits on a load before the family's whisper member serves instead. */
  readonly loadBudgetMs?: number | null;
  readonly onNote?: (note: string) => void;
  readonly onStatus?: (status: ArabicEngineStatus) => void;
  readonly onBundleState?: (id: BundleId, state: BundleState) => void;
  readonly now?: () => number;
  /** The stream's commit lengths. Absent: `ARABIC_SPEECH_SEGMENTER`. For the measurements. */
  readonly segmenter?: SpeechSegmenterConfiguration;
  /**
   * Whether a running pause decode survives a newer pause (`coalesceSpeculations`). Absent:
   * yes exactly when Cohere runs on the CPU (C4 §14.4) — the one decoder here slower than
   * the pauses come.
   */
  readonly coalesceSpeculations?: boolean;
}

export const DEFAULT_ARABIC_IDLE_UNLOAD_MS = 15 * 60_000;
export const DEFAULT_ARABIC_LOAD_BUDGET_MS = 20_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function memoryStore(): ArabicSpeedCheckStore {
  let value: ArabicSpeedCheck | null = null;
  return {
    read: async () => value,
    write: async (check) => {
      value = check;
    },
  };
}

export class ArabicEngine implements StreamingSttEngine {
  readonly supportedLanguages: ReadonlySet<Language> = new Set<Language>(['ar']);

  private readonly options: ArabicEngineOptions;
  private readonly now: () => number;
  private readonly speedChecks: ArabicSpeedCheckStore;
  private readonly crashes: CrashLimiter;
  private runtime: ArabicRuntime | null = null;
  private loading: { readonly kind: ArabicEngineKind; readonly task: Promise<ArabicRuntime> } | null = null;
  private readonly downloads = new Map<ArabicEngineKind, Promise<void>>();
  private readonly bundleStates: Record<ArabicEngineKind, BundleState> = {
    cohere: { kind: 'notDownloaded' },
    fastConformer: { kind: 'notDownloaded' },
  };
  private lastError: string | null = null;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private lastUsedAt: number;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private processUnavailable = false;
  private verdict: ArabicSpeedCheck | null = null;
  private verdictRead: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  private fallback: SttEngine | null = null;

  constructor(options: ArabicEngineOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.lastUsedAt = this.now();
    this.speedChecks = options.speedChecks ?? memoryStore();
    this.crashes = options.crashLimiter ?? new CrashLimiter();
    const idle = options.idleUnloadMs === undefined ? DEFAULT_ARABIC_IDLE_UNLOAD_MS : options.idleUnloadMs;
    if (idle !== null) {
      this.idleTimer = setInterval(() => void this.sweepIdle(idle), Math.max(10_000, Math.floor(idle / 4)));
      this.idleTimer.unref?.();
    }
  }

  /** The engine serving, as the diagnostics record it. Changes when the engine does. */
  get engineId(): string {
    return ENGINE_ID_FOR[this.runtime?.kind ?? this.wantedKind()];
  }

  private note(text: string): void {
    this.options.onNote?.(`arabic: ${text}`);
  }

  // ---- which engine ------------------------------------------------------------------

  private choice(): ArabicEngineChoice {
    return this.options.choice?.() ?? 'auto';
  }

  private backend(): 'auto' | 'cpu' {
    return this.options.backend?.() ?? 'auto';
  }

  /** The stored verdict, if it answers for the backend Cohere would run on now. */
  private applicableVerdict(): ArabicSpeedCheck | null {
    const verdict = this.verdict;
    return verdict !== null && verdict.backend === this.backend() ? verdict : null;
  }

  /** The engine Arabic should be on, given the choice and the speed check. */
  wantedKind(): ArabicEngineKind {
    const choice = this.choice();
    if (choice !== 'auto') return choice;
    return this.applicableVerdict()?.slow === true ? 'fastConformer' : 'cohere';
  }

  private reason(): ArabicActiveReason {
    if (this.choice() !== 'auto') return 'chosen';
    const verdict = this.applicableVerdict();
    if (this.runtime !== null && this.runtime.kind !== this.wantedKind()) return 'fallbackWhileLoading';
    if (verdict === null) return 'notChecked';
    return verdict.slow ? 'speedCheckSlow' : 'speedCheckFast';
  }

  /** What the Languages page shows. */
  status(): ArabicEngineStatus {
    return {
      choice: this.choice(),
      wanted: this.wantedKind(),
      active: this.runtime?.kind ?? null,
      reason: this.reason(),
      device: this.runtime?.device ?? null,
      speedCheck: this.verdict,
      cohere: this.bundleStates.cohere,
      fastConformer: this.bundleStates.fastConformer,
    };
  }

  private publish(): void {
    this.options.onStatus?.(this.status());
  }

  private setBundleState(kind: ArabicEngineKind, state: BundleState): void {
    this.bundleStates[kind] = state;
    this.options.onBundleState?.(BUNDLE_FOR[kind], state);
    this.publish();
  }

  private readVerdict(): Promise<void> {
    this.verdictRead ??= this.speedChecks.read().then(
      (verdict) => {
        this.verdict = verdict;
      },
      () => undefined,
    );
    return this.verdictRead;
  }

  /** Re-read what is on disk (launch, or after the Languages page changed something). */
  async refreshState(): Promise<ArabicEngineStatus> {
    await this.readVerdict();
    for (const kind of ['cohere', 'fastConformer'] as const) {
      if (this.downloads.has(kind)) continue;
      if (this.runtime?.kind === kind) this.bundleStates[kind] = { kind: 'loaded' };
      else if (await this.options.store.isInstalled(BUNDLE_FOR[kind])) this.bundleStates[kind] = { kind: 'downloaded' };
      else if (this.bundleStates[kind].kind !== 'failed') this.bundleStates[kind] = { kind: 'notDownloaded' };
      this.options.onBundleState?.(BUNDLE_FOR[kind], this.bundleStates[kind]);
    }
    this.publish();
    return this.status();
  }

  /**
   * The Arabic family's whisper member, handed over by the engine manager. Two uses: the
   * decode-loop guard re-decodes a truncated segment with it, and its `kotiba-stt` host runs
   * Silero for the stream's pauses — no model load needed for that (`vad_open` is model-free).
   */
  attachFallback(engine: SttEngine | null): void {
    this.fallback = engine;
  }

  // ---- lifecycle ---------------------------------------------------------------------

  async isReady(): Promise<boolean> {
    return this.liveRuntime() !== null;
  }

  private liveRuntime(): ArabicRuntime | null {
    if (this.runtime !== null && this.runtime.alive?.() === false) {
      this.note('the engine process stopped; it will be reloaded on the next dictation');
      const kind = this.runtime.kind;
      this.runtime = null;
      this.setBundleState(kind, { kind: 'downloaded' });
    }
    return this.runtime;
  }

  private mayDownload(): boolean {
    const allowed = this.options.autoDownload ?? true;
    return typeof allowed === 'function' ? allowed() : allowed;
  }

  /**
   * Load the wanted engine — fetching it first when allowed — and wait for it within the load
   * budget. A runtime of the OTHER kind that is already loaded keeps serving while the wanted
   * one downloads or loads (Cohere while FastConformer arrives after a slow verdict), so a
   * switch never costs a dictation. Throws `notReady` when nothing can serve yet, which the
   * family reads as "the next member serves this one" (whisper turbo with the Arabic prompt).
   */
  async prepare(): Promise<void> {
    if (this.disposed) throw new EngineFailure(engineError.notReady('the engine was shut down'));
    this.lastUsedAt = this.now();
    await this.readVerdict();
    const wanted = this.wantedKind();
    const live = this.liveRuntime();
    if (live !== null && live.kind === wanted) return;

    const bundle = BUNDLE_FOR[wanted];
    const spec = BUNDLE_CATALOGUE[bundle];
    if (this.loading === null || this.loading.kind !== wanted) {
      const directory = await this.options.store.locate(bundle);
      if (directory === null) {
        if (this.mayDownload()) this.startDownload(wanted);
        if (live !== null) return; // the other engine serves meanwhile
        const why =
          this.lastError !== null
            ? `the last attempt failed: ${this.lastError}`
            : `${Math.round(bundleBytes(spec) / 1_000_000)} MB, fetched once`;
        throw new EngineFailure(
          engineError.notReady(
            this.downloads.has(wanted) ? `${spec.name} is still downloading (${why})` : `${spec.name} is not downloaded (${why})`,
          ),
        );
      }
      if (this.liveRuntime()?.kind === wanted) return;
      if (this.loading === null || this.loading.kind !== wanted) this.startLoad(wanted, directory);
    }
    if (live !== null) return; // switching in the background; the loaded one serves meanwhile
    const task = this.loading?.task;
    if (task === undefined) return;

    const budget = this.options.loadBudgetMs === undefined ? DEFAULT_ARABIC_LOAD_BUDGET_MS : this.options.loadBudgetMs;
    if (budget !== null) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finished = await Promise.race([
        task.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), budget);
        }),
      ]);
      if (timer !== null) clearTimeout(timer);
      if (!finished) throw new EngineFailure(engineError.notReady(`${spec.name} is still loading`));
    }
    try {
      await task;
    } catch (error: unknown) {
      if (error instanceof EngineFailure) throw error;
      throw new EngineFailure(engineError.notReady(`${spec.name}: ${describe(error)}`));
    }
  }

  private startLoad(kind: ArabicEngineKind, directory: string): void {
    const started = this.generation;
    const t0 = this.now();
    const task = (async () => {
      const runtime = await this.loadRuntime(kind, directory);
      // Warm: the first run of a fresh model pays allocator and kernel set-up once.
      await runtime.transcribeSamples(new Float32Array(SAMPLE_RATE)).catch(() => undefined);
      if (this.generation !== started || this.disposed) {
        await runtime.dispose();
        throw new EngineFailure(engineError.notReady('the model was unloaded while it was loading'));
      }
      const previous = this.runtime;
      this.runtime = runtime;
      if (this.loading?.kind === kind) this.loading = null;
      this.lastError = null;
      this.lastUsedAt = this.now();
      this.note(`${kind} loaded in ${Math.round(this.now() - t0)} ms on ${runtime.device} (${this.options.threads} threads)`);
      this.setBundleState(kind, { kind: 'loaded' });
      if (previous !== null && previous !== runtime) {
        // The switch is done: the old engine finishes whatever it was decoding, then goes.
        const queued = this.queue.catch(() => undefined);
        void queued.then(() => previous.dispose());
        this.setBundleState(previous.kind, { kind: 'downloaded' });
      }
      if (kind === 'cohere') this.checkSpeedIfDue(runtime);
      return runtime;
    })();
    this.loading = { kind, task };
    task.catch((error: unknown) => {
      if (this.loading?.task === task) this.loading = null;
      if (this.generation !== started) return;
      if (error instanceof EngineFailure && error.failure.kind === 'notReady') return;
      this.lastError = describe(error);
      this.note(`${kind} load failed: ${this.lastError}`);
      this.setBundleState(kind, { kind: 'failed', reason: this.lastError });
    });
  }

  /** Fetch now, on the caller's schedule — the Languages page's button, or onboarding. */
  async download(kind: ArabicEngineKind = this.wantedKind()): Promise<void> {
    this.startDownload(kind);
    await this.downloads.get(kind);
    if (!(await this.options.store.isInstalled(BUNDLE_FOR[kind]))) {
      throw new EngineFailure(engineError.notReady(`${BUNDLE_CATALOGUE[BUNDLE_FOR[kind]].name}: ${this.lastError ?? 'the download did not finish'}`));
    }
  }

  private startDownload(kind: ArabicEngineKind): void {
    if (this.downloads.has(kind) || this.disposed) return;
    const bundle = BUNDLE_FOR[kind];
    const total = bundleBytes(BUNDLE_CATALOGUE[bundle]);
    this.setBundleState(kind, { kind: 'downloading', receivedBytes: 0, totalBytes: total });
    this.note(`downloading ${kind} (${Math.round(total / 1_000_000)} MB)`);
    const task = this.options.store
      .ensure(bundle, (progress) => {
        this.setBundleState(kind, { kind: 'downloading', receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes });
      })
      .then(
        () => {
          this.downloads.delete(kind);
          this.lastError = null;
          this.setBundleState(kind, { kind: 'downloaded' });
          // Load as soon as the weights land, if this is still the engine Arabic wants.
          if (this.wantedKind() === kind) void this.prepare().catch(() => undefined);
        },
        (error: unknown) => {
          this.downloads.delete(kind);
          this.lastError = describe(error);
          this.note(`${kind} download failed: ${this.lastError}`);
          this.setBundleState(kind, { kind: 'failed', reason: this.lastError });
        },
      );
    this.downloads.set(kind, task);
  }

  // ---- the speed check ---------------------------------------------------------------

  private checkSpeedIfDue(runtime: ArabicRuntime): void {
    if (this.choice() !== 'auto' || this.applicableVerdict() !== null || this.checking !== null) return;
    this.checking = this.checkSpeed(runtime).finally(() => {
      this.checking = null;
    });
  }

  /** Run the check now (the Languages page's "Check again"). Resolves with the verdict. */
  async recheckSpeed(): Promise<ArabicSpeedCheck | null> {
    await this.readVerdict();
    this.verdict = null;
    const runtime = this.liveRuntime();
    if (runtime === null || runtime.kind !== 'cohere') {
      // The check needs Cohere loaded; the next load runs it.
      this.publish();
      return null;
    }
    await this.checkSpeed(runtime);
    return this.verdict;
  }

  private async checkSpeed(runtime: ArabicRuntime): Promise<void> {
    const clip = await this.options.speedClip?.().catch(() => null);
    if (clip === null || clip === undefined || clip.length === 0) {
      this.note('speed check skipped: the standard clip is not installed — Cohere stays');
      return;
    }
    const times: number[] = [];
    for (let run = 0; run < 2; run += 1) {
      const started = this.now();
      try {
        await this.serialised(() => runtime.transcribeSamples(clip));
      } catch (error: unknown) {
        this.note(`speed check failed: ${describe(error)} — Cohere stays`);
        return;
      }
      times.push(this.now() - started);
    }
    // The FASTER of two: demoting Cohere should need the PC to be slow twice, not once while
    // something else happened to be running.
    const milliseconds = Math.round(Math.min(...times));
    const thresholdMs = this.options.speedThresholdMs ?? DEFAULT_SPEED_THRESHOLD_MS;
    const verdict: ArabicSpeedCheck = {
      milliseconds,
      thresholdMs,
      slow: milliseconds > thresholdMs,
      device: runtime.device,
      backend: this.backend(),
      clipSeconds: Math.round((clip.length / SAMPLE_RATE) * 10) / 10,
      measuredAt: new Date(this.now()).toISOString(),
    };
    this.verdict = verdict;
    await this.speedChecks.write(verdict).catch((error: unknown) => this.note(`speed check not saved: ${describe(error)}`));
    this.note(
      `speed check: ${milliseconds} ms for ${verdict.clipSeconds} s on ${verdict.device} ` +
        `(threshold ${thresholdMs} ms) — ${verdict.slow ? 'too slow here, switching to FastConformer' : 'Cohere stays'}`,
    );
    this.publish();
    // Slow: bring FastConformer in behind the Cohere that keeps serving until it lands.
    if (verdict.slow && this.choice() === 'auto') void this.prepare().catch(() => undefined);
  }

  // ---- decoding ----------------------------------------------------------------------

  /** One decode at a time on the runtime, in order — transcribe.cpp refuses overlap anyway. */
  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const job = this.queue.then(work, work);
    this.queue = job.catch(() => undefined);
    return job;
  }

  /**
   * One span (≤ `ARABIC_MAX_SEGMENT_SECONDS`), through the loaded runtime. A Cohere decode loop
   * goes to the whisper fallback; with none attached it is an empty segment, said out loud.
   */
  private async decodeSpan(samples: Float32Array, signal?: AbortSignal): Promise<string> {
    await this.prepare();
    const runtime = this.liveRuntime();
    if (runtime === null) throw new EngineFailure(engineError.notReady(this.lastError ?? 'no Arabic engine is loaded'));
    let input = samples;
    if (input.length < SAMPLE_RATE) {
      // A tap is a legitimate dictation of nothing; pad to a second rather than refuse.
      input = new Float32Array(SAMPLE_RATE);
      input.set(samples);
    }
    this.lastUsedAt = this.now();
    let decode;
    try {
      decode = await this.serialised(() => runtime.transcribeSamples(input, signal));
    } catch (error: unknown) {
      if (error instanceof ArabicAborted) throw new EngineFailure(engineError.transcriptionFailed('aborted'));
      if (error instanceof EngineProcessExit) this.crashes.crashed();
      throw new EngineFailure(engineError.transcriptionFailed(describe(error)));
    }
    this.lastUsedAt = this.now();
    if (!decode.truncated) return decode.text;

    const seconds = (samples.length / SAMPLE_RATE).toFixed(1);
    const fallback = this.fallback;
    if (fallback === null || !fallback.supportedLanguages.has('ar')) {
      this.note(`${runtime.kind} looped on a ${seconds} s segment and no whisper fallback is installed — it is empty`);
      return '';
    }
    this.note(`${runtime.kind} looped on a ${seconds} s segment (generation cap) — re-decoding it with ${fallback.engineId}`);
    const again = await fallback.transcribe({ samples, droppedSamples: 0 }, 'ar', signal);
    return again.raw.trim();
  }

  /** A whole recording: cut at its quietest points into pieces the decoders can take. */
  async transcribe(audio: AudioBuffer, language: Language, signal?: AbortSignal): Promise<TranscriptResult> {
    if (!this.supportedLanguages.has(language)) {
      throw new EngineFailure(engineError.languageUnsupported(language, this.engineId));
    }
    if (audio.samples.length === 0) throw new EngineFailure(engineError.transcriptionFailed('no audio'));
    const parts: string[] = [];
    let rest = audio.samples;
    const limit = ARABIC_MAX_SEGMENT_SECONDS * SAMPLE_RATE;
    while (rest.length > limit) {
      const cut = segmentCut(rest, BATCH_SEGMENTER) ?? Math.trunc(BATCH_SEGMENTER.commitAfter * SAMPLE_RATE);
      parts.push(await this.decodeSpan(rest.subarray(0, cut), signal));
      rest = rest.subarray(cut);
    }
    parts.push(await this.decodeSpan(rest, signal));
    return { raw: joinSegments(parts), language: 'ar', engineId: this.engineId };
  }

  /** The stream the session drives while the key is held. Cheap; loads nothing itself. */
  openStream(): TranscriptionStream {
    const decoder: SegmentDecoder = {
      engineId: this.engineId,
      // The session's fitted-window arithmetic is whisper's; these decoders take the span as is.
      mixesWindowsSafely: () => false,
      decodeSegment: async (samples, options) => {
        const started = this.now();
        const text = await this.decodeSpan(samples, options.signal);
        return { text, audioContext: 0, milliseconds: this.now() - started };
      },
      transcribe: (audio, language) => this.transcribe(audio, language),
    };
    return new StreamingWhisperSession({
      engine: decoder,
      language: 'ar',
      configuration: {
        segmenter: this.options.segmenter ?? ARABIC_SPEECH_SEGMENTER,
        hint: null,
        carryCharacters: 0,
        coalesceSpeculations: this.options.coalesceSpeculations ?? this.slowDecoder(),
      },
      detector: this.openDetector(),
    });
  }

  /** Cohere on the CPU: its pause decodes cannot keep up with the pauses (C4 §14.4). */
  private slowDecoder(): boolean {
    const runtime = this.liveRuntime();
    const kind = runtime?.kind ?? this.wantedKind();
    const device = runtime?.device ?? (this.backend() === 'cpu' ? 'CPU' : null);
    return kind === 'cohere' && device === 'CPU';
  }

  private async openDetector(): Promise<AsyncSpeechDetector> {
    const path = (await this.options.speechDetectorPath?.().catch(() => null)) ?? null;
    const host = this.fallback as Partial<SegmentDecodingEngine> | null;
    if (path === null || host === null || typeof host.openSpeechDetector !== 'function') return energyDetector();
    return host.openSpeechDetector(path);
  }

  // ---- memory ------------------------------------------------------------------------

  /** Give the weights back. A decode already running finishes; the next prepare reloads. */
  async unload(): Promise<void> {
    this.generation += 1;
    this.loading = null;
    const old = this.runtime;
    if (old === null) return;
    this.runtime = null;
    await this.queue.catch(() => undefined);
    await old.dispose();
    this.setBundleState(old.kind, { kind: 'downloaded' });
  }

  private async sweepIdle(afterMs: number): Promise<void> {
    if (this.runtime === null || this.now() - this.lastUsedAt < afterMs) return;
    this.note(`unloaded after ${Math.round(afterMs / 1000)} s idle`);
    await this.unload();
  }

  /** The user changed the choice or the GPU setting: load what is wanted now, in the background. */
  reconsider(): void {
    this.publish();
    const wanted = this.wantedKind();
    if (this.runtime !== null && this.runtime.kind !== wanted) void this.prepare().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
    await this.unload();
  }

  private async loadRuntime(kind: ArabicEngineKind, directory: string): Promise<ArabicRuntime> {
    const options: ArabicRuntimeOptions = { kind, directory, threads: this.options.threads, backend: this.backend() };
    if (this.options.loadRuntime !== undefined) return this.options.loadRuntime(options);
    const launcher = this.options.launcher;
    if (launcher === undefined || this.processUnavailable) return loadArabicRuntime(options);
    if (!this.crashes.mayStart()) {
      throw new Error(
        `the Arabic engine process crashed ${this.crashes.recent()} times in the last few minutes; ` +
          'whisper serves Arabic until Kotiba restarts',
      );
    }
    try {
      return await startArabicProcess(options, launcher, (exit) => {
        this.crashes.crashed();
        this.note(`${exit.message} — restarting on the next dictation`);
      });
    } catch (error: unknown) {
      if (error instanceof EngineProcessExit && error.beforeReady) {
        // A packaging fault, not the model: run it here rather than lose Arabic's engine.
        this.processUnavailable = true;
        this.note(`${error.message}; running in the app's own process instead`);
        return loadArabicRuntime(options);
      }
      if (error instanceof EngineProcessExit) this.crashes.crashed();
      throw error;
    }
  }
}
