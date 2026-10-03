// English and Russian, one model, on ONNX Runtime — the Windows twin of `ParakeetEngine`
// (Sources/KotibaEngines/ParakeetEngine.swift). docs/research/C1-en-ru-engine-selection.md
// chose it; §8 is this file's recipe.
//
// What it is, in the facts that shaped it:
//
//   * THE SAME WEIGHTS AS THE MAC. Parakeet Ultra — moondream's post-training of NVIDIA
//     Parakeet-TDT-0.6B-v3 — in the int8 ONNX export `Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx`
//     pins, scored at 5.8 % en / 7.3 % ru on FLEURS. sherpa-onnx's own Parakeet v3 export is
//     3–4 points worse on the same sets and is deliberately NOT used.
//   * ONE MODEL DECIDES ENGLISH AGAINST RUSSIAN ITSELF. The vocabulary holds both scripts and
//     the decoder picks per token, so the transcript reports the language it was WRITTEN in
//     (`writtenLanguage`) and the session takes that over the router's en/ru guess.
//   * PUNCTUATION AND CAPITALS COME OUT OF THE DECODER.
//   * IT STREAMS. `openStream()` commits ~14 s windows while the key is held, cut in the
//     quietest 200 ms (`segmentCut`), so key-release is left with at most one window.
//   * FETCHED ON FIRST USE, pinned to one upstream commit, every file sha256-checked
//     (`bundle-store.ts`). Until it lands, the unified family's next member — the bundled
//     whisper large-v3-turbo — serves English and Russian; `prepare()` says "downloading"
//     by THROWING, which the family treats as "try the next member", exactly as the Mac's
//     `CompositeEngine` does.
//
// WHY onnxruntime-node, OFF THE MAIN THREAD, and not inside `kotiba-stt.exe`: linking ONNX
// Runtime into the C++ host would need new C++, a Windows toolchain build and a wire protocol
// for a model the host has no other reason to know about; nobody here can build or debug
// that on Windows, and it would buy nothing measurable. The thread is because ONNX Runtime
// LOADS synchronously — 760 ms of blocked event loop on this Mac for the encoder, against
// 6 ms from a worker (`parakeet-runtime.ts`). Since D-W22 the app runs the sessions in their
// own OS PROCESS (`parakeet-process.ts`, an Electron utility process): a native crash inside
// ONNX Runtime ends that process, not the app, and the next dictation starts a fresh one
// (`decode` notices, `loadDefaultRuntime` restarts, up to a limit). The worker thread remains
// for `--check`, the tests, and a machine where the process cannot start.

import {
  EngineFailure,
  bundleBytes,
  engineError,
  PARAKEET_ULTRA,
  SAMPLE_RATE,
  type AudioBuffer,
  type BundleState,
  type Language,
  type StreamingSttEngine,
  type TranscriptionStream,
  type TranscriptResult,
} from '../contracts/index.js';
import { DEFAULT_SEGMENTER, segmentCut, type StreamSegmenter } from '../core/stt/segmenter.js';
import { writtenLanguage, type WrittenLanguage } from '../core/stt/tdt.js';

import type { BundleStore } from './bundle-store.js';
import { CrashLimiter, EngineProcessExit, type EngineLauncher } from './engine-process.js';
import { startParakeetProcess } from './parakeet-process.js';
import { startParakeetWorker, type ParakeetRuntime } from './parakeet-runtime.js';

export { loadParakeetRuntime, startParakeetWorker, type ParakeetRuntime, type ParakeetRuntimeOptions } from './parakeet-runtime.js';

// ---------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------

export interface ParakeetEngineOptions {
  readonly store: BundleStore;
  /** Encoder threads. See `resolveOrtThreads`. */
  readonly threads: number;
  /**
   * How long `prepare()` waits for a load before giving up on THIS call (the load goes on).
   * The Mac waits 1 s because a first load there compiles a Neural Engine plan for 19.6 s;
   * on ONNX Runtime a load is the same ~1 s every time (1.1 s measured on this Mac's CPU),
   * so Windows waits for it rather than falling back to a whisper model that is slower to
   * load AND to run. The budget only guards a pathological disk. `null` waits forever.
   */
  readonly loadBudgetMs?: number | null;
  /**
   * Give the ~700 MB back after this long unused. A Windows ADDITION — the Mac unloads only
   * under memory pressure — and a cheap one: the reload is ~1 s and the key-down preload
   * starts it while the user is still speaking. `null` never unloads.
   */
  readonly idleUnloadMs?: number | null;
  /**
   * Fetch the bundle on first use. Off in tests and `--check`, which must not download 668 MB.
   * A function is asked at the moment of need: the app says yes only once the user has
   * accepted the download (onboarding's Download models step, or a Download button) — a
   * 668 MB fetch never starts behind someone who has not seen what it is.
   */
  readonly autoDownload?: boolean | (() => boolean);
  readonly segmenter?: StreamSegmenter;
  readonly loadRuntime?: (directory: string) => Promise<ParakeetRuntime>;
  /**
   * Run the sessions in their own OS process (D-W22) — the app passes Electron's
   * `utilityProcess`. Absent: a worker thread of this process, as before (`--check`, tests).
   */
  readonly launcher?: EngineLauncher;
  /** How many crashes of that process, and in what window, before it stays down. Tests. */
  readonly crashLimiter?: CrashLimiter;
  readonly onNote?: (note: string) => void;
  /** Told whenever what the UI should say about this engine changes. */
  readonly onStateChange?: (state: BundleState) => void;
  readonly now?: () => number;
}

export const PARAKEET_ENGINE_ID = 'parakeet-ultra';
export const DEFAULT_PARAKEET_LOAD_BUDGET_MS = 15_000;
export const DEFAULT_PARAKEET_IDLE_UNLOAD_MS = 15 * 60_000;

/**
 * Encoder threads for a machine with `logicalProcessors`. The physical-core estimate the
 * whisper path uses (`resolveDecodeCores`: halve anything over two logical processors, for
 * SMT and E-cores), capped at 8 — NOT the whisper formula's "minus two", because at
 * key-release the encoder is the only thing running for English and Russian.
 */
export function resolveOrtThreads(logicalProcessors: number): number {
  const logical = Number.isFinite(logicalProcessors) && logicalProcessors > 0 ? Math.floor(logicalProcessors) : 4;
  const cores = logical <= 2 ? logical : Math.floor(logical / 2);
  return Math.max(1, Math.min(8, cores));
}

export class ParakeetEngine implements StreamingSttEngine {
  readonly engineId = PARAKEET_ENGINE_ID;
  readonly supportedLanguages: ReadonlySet<Language> = new Set<Language>(['en', 'ru']);

  private readonly options: ParakeetEngineOptions;
  private readonly segmenter: StreamSegmenter;
  private readonly now: () => number;
  private runtime: ParakeetRuntime | null = null;
  private loading: Promise<ParakeetRuntime> | null = null;
  private downloading: Promise<void> | null = null;
  /** Bumped by `unload()`, so a load already running does not resurrect what was given back. */
  private generation = 0;
  private lastError: string | null = null;
  /** The tail of the decode queue. See `serialised`. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastUsedAt: number;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private state: BundleState = { kind: 'notDownloaded' };
  private disposed = false;
  private readonly crashes: CrashLimiter;
  /** Set when the engine process could not even start: the worker thread serves instead. */
  private processUnavailable = false;

  constructor(options: ParakeetEngineOptions) {
    this.options = options;
    this.segmenter = options.segmenter ?? DEFAULT_SEGMENTER;
    this.now = options.now ?? (() => Date.now());
    this.lastUsedAt = this.now();
    this.crashes = options.crashLimiter ?? new CrashLimiter();
    const idle = options.idleUnloadMs === undefined ? DEFAULT_PARAKEET_IDLE_UNLOAD_MS : options.idleUnloadMs;
    if (idle !== null) {
      this.idleTimer = setInterval(() => void this.sweepIdle(idle), Math.max(10_000, Math.floor(idle / 4)));
      this.idleTimer.unref?.();
    }
  }

  private note(text: string): void {
    this.options.onNote?.(`parakeet: ${text}`);
  }

  private setState(next: BundleState): void {
    this.state = next;
    this.options.onStateChange?.(next);
  }

  private mayDownload(): boolean {
    const allowed = this.options.autoDownload ?? true;
    return typeof allowed === 'function' ? allowed() : allowed;
  }

  /** What the Languages pane says. Refreshed from disk by `refreshState`. */
  bundleState(): BundleState {
    return this.state;
  }

  /** Re-read whether the bundle is on disk, for a state that may be stale (launch). */
  async refreshState(): Promise<BundleState> {
    if (this.runtime !== null) this.setState({ kind: 'loaded' });
    else if (this.downloading === null && (await this.options.store.isInstalled('parakeet_ultra'))) {
      this.setState({ kind: 'downloaded' });
    } else if (this.downloading === null && this.lastError === null) {
      this.setState({ kind: 'notDownloaded' });
    }
    return this.state;
  }

  async isReady(): Promise<boolean> {
    return this.liveRuntime() !== null;
  }

  /**
   * The runtime, or `null` once its process has died. ASKED BY `isReady` AND `prepare` TOO,
   * not only by `decode`: the family trusts `isReady()` and calls `transcribe` without a
   * catch, so a "Kotiba speech engine" ended in Task Manager (or crashed while idle) used to
   * read as ready, fail the next dictation with "prepare() has not run", and `prepare()`
   * returned early for the same stale reference — the dead process was never reloaded.
   */
  private liveRuntime(): ParakeetRuntime | null {
    if (this.runtime !== null && this.runtime.alive?.() === false) {
      // A native crash in ONNX Runtime, say. Forget it: the next prepare loads a fresh one,
      // and until then the family's whisper member serves.
      this.note('the runtime stopped; it will be reloaded on the next dictation');
      this.runtime = null;
      this.setState({ kind: 'downloaded' });
    }
    return this.runtime;
  }

  /**
   * Verify (fetching on first use when allowed), load, and warm. Idempotent and cheap once
   * loaded. Throws `notReady` while downloading or past the load budget — "not yet", which
   * the family treats as "the next member serves this one".
   */
  async prepare(): Promise<void> {
    if (this.disposed) throw new EngineFailure(engineError.notReady('the engine was shut down'));
    this.lastUsedAt = this.now();
    if (this.liveRuntime() !== null) return;
    if (this.loading === null) {
      const directory = await this.options.store.locate('parakeet_ultra');
      if (this.runtime !== null) return;
      if (directory === null) {
        if (this.mayDownload()) this.startDownload();
        const why =
          this.lastError !== null
            ? `the last attempt failed: ${this.lastError}`
            : `${Math.round(bundleBytes(PARAKEET_ULTRA) / 1_000_000)} MB, fetched once`;
        throw new EngineFailure(
          engineError.notReady(
            this.downloading !== null
              ? `${PARAKEET_ULTRA.name} is still downloading (${why})`
              : `${PARAKEET_ULTRA.name} is not downloaded (${why})`,
          ),
        );
      }
      if (this.loading === null) this.startLoad(directory);
    }
    const task = this.loading;
    if (task === null) return;

    const budget = this.options.loadBudgetMs === undefined ? DEFAULT_PARAKEET_LOAD_BUDGET_MS : this.options.loadBudgetMs;
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
      if (!finished) {
        throw new EngineFailure(engineError.notReady(`${PARAKEET_ULTRA.name} is still loading`));
      }
    }
    try {
      await task;
    } catch (error: unknown) {
      if (error instanceof EngineFailure) throw error;
      throw new EngineFailure(engineError.notReady(`${PARAKEET_ULTRA.name}: ${describe(error)}`));
    }
  }

  private startLoad(directory: string): void {
    const started = this.generation;
    const load = this.options.loadRuntime ?? ((dir: string) => this.loadDefaultRuntime(dir));
    const t0 = this.now();
    this.loading = (async () => {
      const runtime = await load(directory);
      // Warm: the first run of a fresh session pays allocator and kernel set-up once.
      await runtime.transcribeSamples(new Float32Array(SAMPLE_RATE)).catch(() => '');
      if (this.generation !== started || this.disposed) {
        await runtime.dispose();
        throw new EngineFailure(engineError.notReady('the model was unloaded while it was loading'));
      }
      this.runtime = runtime;
      this.loading = null;
      this.lastError = null;
      this.lastUsedAt = this.now();
      this.note(`loaded in ${Math.round(this.now() - t0)} ms (${this.options.threads} encoder threads)`);
      this.setState({ kind: 'loaded' });
      return runtime;
    })();
    this.loading.catch((error: unknown) => {
      if (this.generation !== started) return;
      this.loading = null;
      if (error instanceof EngineFailure && error.failure.kind === 'notReady') return;
      this.lastError = describe(error);
      this.note(`load failed: ${this.lastError}`);
      this.setState({ kind: 'failed', reason: this.lastError });
    });
  }

  /** Fetch now, on the caller's schedule — the Languages pane's button. */
  async download(): Promise<void> {
    this.startDownload();
    await this.downloading;
    if (!(await this.options.store.isInstalled('parakeet_ultra'))) {
      throw new EngineFailure(engineError.notReady(`${PARAKEET_ULTRA.name}: ${this.lastError ?? 'the download did not finish'}`));
    }
  }

  private startDownload(): void {
    if (this.downloading !== null || this.disposed) return;
    const total = bundleBytes(PARAKEET_ULTRA);
    this.setState({ kind: 'downloading', receivedBytes: 0, totalBytes: total });
    this.note(`downloading ${Math.round(total / 1_000_000)} MB`);
    this.downloading = this.options.store
      .ensure('parakeet_ultra', (progress) => {
        this.setState({ kind: 'downloading', receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes });
      })
      .then(
        () => {
          this.downloading = null;
          this.lastError = null;
          this.setState({ kind: 'downloaded' });
          // Load as soon as the weights land, rather than at the next dictation.
          void this.prepare().catch(() => undefined);
        },
        (error: unknown) => {
          this.downloading = null;
          this.lastError = describe(error);
          this.note(`download failed: ${this.lastError}`);
          this.setState({ kind: 'failed', reason: this.lastError });
        },
      );
  }

  /** Give the weights back. A decode already running finishes; the next prepare reloads. */
  async unload(): Promise<void> {
    this.generation += 1;
    this.loading = null;
    const old = this.runtime;
    if (old === null) return;
    this.runtime = null;
    await this.queue.catch(() => undefined);
    await old.dispose();
    this.setState({ kind: 'downloaded' });
  }

  private async sweepIdle(afterMs: number): Promise<void> {
    if (this.runtime === null || this.now() - this.lastUsedAt < afterMs) return;
    this.note(`unloaded after ${Math.round(afterMs / 1000)} s idle`);
    await this.unload();
  }

  async transcribe(audio: AudioBuffer, language: Language): Promise<TranscriptResult> {
    if (!this.supportedLanguages.has(language)) {
      throw new EngineFailure(engineError.languageUnsupported(language, this.engineId));
    }
    if (audio.samples.length === 0) throw new EngineFailure(engineError.transcriptionFailed('no audio'));
    const raw = await this.decode(audio.samples);
    return { raw, language: writtenLanguage(raw, language), engineId: this.engineId };
  }

  /**
   * The language decision's respelling (P4): the same audio, the greedy decoder held to English's
   * or Russian's letters (`scriptSuppression` in src/core/stt/tdt.ts — the twin of FluidAudio's
   * token-language filter on the Mac). Loads first if it has to, like the Mac's.
   */
  async transcribeWrittenIn(audio: AudioBuffer, language: Language): Promise<TranscriptResult> {
    if (language !== 'en' && language !== 'ru') {
      throw new EngineFailure(engineError.languageUnsupported(language, this.engineId));
    }
    if (audio.samples.length === 0) throw new EngineFailure(engineError.transcriptionFailed('no audio'));
    if (this.liveRuntime() === null) await this.prepare();
    const raw = await this.decode(audio.samples, language);
    return { raw, language: writtenLanguage(raw, language), engineId: this.engineId };
  }

  openStream(): TranscriptionStream {
    return new ParakeetStream(this, this.segmenter);
  }

  /**
   * One decode, serialised behind every other decode on this engine. A stream commit
   * racing the key-up decode would otherwise interleave two passes over the same sessions;
   * nothing promises that is safe, so it never happens. Assigned before the first
   * suspension point, so two callers cannot read the same predecessor.
   */
  decode(samples: Float32Array, script: WrittenLanguage | null = null): Promise<string> {
    const runtime = this.liveRuntime();
    if (runtime === null) {
      return Promise.reject(new EngineFailure(engineError.notReady(this.lastError ?? 'prepare() has not run')));
    }
    // A tap of the key is a legitimate dictation of nothing: pad to one second, as the
    // Mac does, rather than refuse.
    let input = samples;
    if (input.length < SAMPLE_RATE) {
      input = new Float32Array(SAMPLE_RATE);
      input.set(samples);
    }
    const job = this.queue.then(
      () => runtime.transcribeSamples(input, script),
      () => runtime.transcribeSamples(input, script),
    );
    this.queue = job.catch(() => undefined);
    this.lastUsedAt = this.now();
    return job.then(
      (text) => {
        this.lastUsedAt = this.now();
        return text;
      },
      (error: unknown) => {
        throw new EngineFailure(engineError.transcriptionFailed(describe(error)));
      },
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
    await this.unload();
  }

  /**
   * The app's runtime: the three sessions in their own process when a launcher was given, and
   * in a worker thread otherwise — or when that process cannot start at all, which is a
   * packaging fault worth a note but not worth English and Russian's fast engine.
   *
   * A process that CRASHES is restarted by the next `prepare` (the decode that saw it die
   * dropped the runtime), up to `CRASH_LIMIT` times in `CRASH_WINDOW_MS`; past that, loading
   * refuses, and whisper serves English and Russian until Kotiba restarts.
   */
  private async loadDefaultRuntime(directory: string): Promise<ParakeetRuntime> {
    const options = { threads: this.options.threads };
    const launcher = this.options.launcher;
    if (launcher === undefined || this.processUnavailable) return startParakeetWorker(directory, options);
    if (!this.crashes.mayStart()) {
      throw new Error(
        `the engine process crashed ${this.crashes.recent()} times in the last few minutes; ` +
          'whisper serves English and Russian until Kotiba restarts',
      );
    }
    try {
      return await startParakeetProcess(directory, options, launcher, (exit) => {
        this.crashes.crashed();
        this.note(`${exit.message} — restarting on the next dictation`);
      });
    } catch (error: unknown) {
      if (error instanceof EngineProcessExit && error.beforeReady) {
        this.processUnavailable = true;
        this.note(`${error.message}; running in a thread of the app instead`);
        return startParakeetWorker(directory, options);
      }
      if (error instanceof EngineProcessExit) this.crashes.crashed();
      throw error;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------------

/**
 * A dictation in progress. Commits whole windows while the key is held, so key-up is left
 * with at most one. `ParakeetStream` in the Swift, line for line.
 *
 * The stream must never change WHICH audio was transcribed. So `finish` throws the
 * committed text away and decodes the whole recording in batch whenever the two could
 * disagree: a commit failed, the recording lost samples, or it is shorter than what the
 * stream already committed.
 */
export class ParakeetStream implements TranscriptionStream {
  private readonly engine: ParakeetEngine;
  private readonly segmenter: StreamSegmenter;
  /** Samples not yet committed, starting at `committedSamples` into the recording. */
  private pending: Float32Array = new Float32Array(SAMPLE_RATE * 16);
  private pendingLength = 0;
  private committedSamples = 0;
  private committedText: string[] = [];
  private inFlight: Promise<void> | null = null;
  private broken = false;
  private cancelled = false;
  /**
   * Set first thing in `finish`. From then on nothing starts a window of its own: the commit
   * that lands while key-up waits used to start the next one (`committed` → `commitIfDue`),
   * advance `committedSamples` past it and leave `finish` holding the text without it — up
   * to 14 s of speech missing from the paste, and nothing said (core review 2026-09-30).
   */
  private finishing = false;
  /** `pendingLength` below which no commit is attempted. See `commitIfDue`. */
  private retryAt = 0;
  private readonly listeners = new Set<(text: string) => void>();

  constructor(engine: ParakeetEngine, segmenter: StreamSegmenter) {
    this.engine = engine;
    this.segmenter = segmenter;
  }

  onCommit(listener: (text: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  append(samples: Float32Array): void {
    if (this.cancelled) return;
    this.push(samples);
    this.commitIfDue();
  }

  private push(samples: Float32Array): void {
    const needed = this.pendingLength + samples.length;
    if (needed > this.pending.length) {
      const grown = new Float32Array(Math.max(needed, this.pending.length * 2));
      grown.set(this.pending.subarray(0, this.pendingLength));
      this.pending = grown;
    }
    this.pending.set(samples, this.pendingLength);
    this.pendingLength = needed;
  }

  private commitIfDue(): void {
    if (this.inFlight !== null || this.broken || this.cancelled || this.finishing) return;
    // After a cold engine sent a piece back, ask again only once another two seconds have
    // piled up — not on every 100 ms chunk, each of which would re-read the bundle's stamp.
    if (this.pendingLength < this.retryAt) return;
    const cut = segmentCut(this.pending.subarray(0, this.pendingLength), this.segmenter);
    if (cut === null) return;
    const piece = this.pending.slice(0, cut);
    this.pending.copyWithin(0, cut, this.pendingLength);
    this.pendingLength -= cut;
    this.committedSamples += cut;
    const engine = this.engine;
    this.inFlight = (async () => {
      // The first commit of a cold engine loads it here — behind the user's speech, the
      // cheapest place a load can happen. Not loaded YET (downloading, over budget) is not
      // a failure: the piece goes back and the next append asks again.
      try {
        await engine.prepare();
      } catch {
        this.requeue(piece);
        return;
      }
      try {
        this.committed(await engine.decode(piece));
      } catch {
        this.broken = true;
        this.inFlight = null;
      }
    })();
  }

  private requeue(piece: Float32Array): void {
    const rest = this.pending.slice(0, this.pendingLength);
    this.pendingLength = 0;
    this.push(piece);
    this.push(rest);
    this.committedSamples -= piece.length;
    this.retryAt = this.pendingLength + 2 * this.segmenter.sampleRate;
    this.inFlight = null;
  }

  private committed(text: string): void {
    // A decode landed, so the engine is serving: the backlog drains at the normal cadence
    // again. `requeue`'s gate is for an engine that is NOT ready yet (the model landing
    // mid-hold); left standing, every later commit waited for the backlog to regrow past a
    // stale mark, and a 60 s hold left ~30 s for key-up. The Swift stream has no such gate.
    this.retryAt = 0;
    if (text !== '') {
      this.committedText.push(text);
      for (const listener of [...this.listeners]) {
        try {
          listener(text);
        } catch {
          // A listener must never cost the stream its text.
        }
      }
    }
    this.inFlight = null;
    this.commitIfDue();
  }

  async finish(audio: AudioBuffer, language: Language): Promise<TranscriptResult> {
    this.finishing = true;
    // A loop, not one await: a window already under way when `finishing` was set may be
    // followed by none, but never waited for only in part.
    while (this.inFlight !== null) await this.inFlight;
    // Cancelled — the route went elsewhere while this was the speculative finish. Batch was
    // the answer to that too (`usable` below is false), which decoded the whole recording
    // for nobody and queued the next dictation's windows behind it.
    if (this.cancelled) throw new EngineFailure(engineError.transcriptionFailed('the stream was cancelled'));
    await this.engine.prepare();
    const usable =
      !this.broken && !this.cancelled && audio.droppedSamples === 0 && this.committedSamples <= audio.samples.length;
    if (!usable || this.committedSamples === 0) return this.engine.transcribe(audio, language);

    const parts = [...this.committedText];
    const rest = audio.samples.subarray(this.committedSamples);
    // Under 0.3 s of tail is a breath or the key's own click, not speech.
    if (rest.length >= Math.floor((this.segmenter.sampleRate * 3) / 10)) {
      const text = await this.engine.decode(rest);
      if (text !== '') parts.push(text);
    }
    const raw = parts.join(' ');
    return { raw, language: writtenLanguage(raw, language), engineId: this.engine.engineId };
  }

  cancel(): void {
    this.cancelled = true;
    this.pendingLength = 0;
    this.listeners.clear();
  }
}
