// The language-ID model as the router's classifier (P4, D-14) — the Windows twin of the Mac's
// `EcapaLanguageIdentifier`. The ONNX session and why it is shaped as it is: language-id-runtime.ts.
//
// IN ITS OWN PROCESS when the app gave a launcher (`engine-host.js lid`, D-W22): ONNX Runtime is
// native code, and a crash there must cost one dictation's acoustic route — the fallback language,
// or whisper base's detector at the next rebuild — never the app. The load is small (86 MB, ~60 ms
// measured) but it is synchronous inside `InferenceSession.create`, which is the other reason it is
// not loaded on the main thread of the app. Without a launcher (plain Node: `--check`, the headless
// measurements, the tests) it runs in this thread.
//
// NON-THROWING, like whisper base's `createAcousticClassifier`: every failure is an EMPTY map —
// "no opinion" — and the language-ID router then routes to the fallback language. Being unsure
// must never be louder than being right, and it must never block a dictation.

import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ECAPA_LID, type AcousticClassifier, type AudioBuffer, type LanguagePosterior, type Settings } from '../contracts/index.js';

import type { BundleStore } from './bundle-store.js';

import { CrashLimiter, EngineProcessExit, type EngineLauncher } from './engine-process.js';
import {
  loadLanguageIDRuntime,
  posteriorFromLogp,
  type LanguageIDReply,
  type LanguageIDRequest,
  type LanguageIDRuntime,
  type LanguageIDRuntimeOptions,
} from './language-id-runtime.js';

export {
  ECAPA_LABELS,
  ECAPA_MAXIMUM_SAMPLES,
  ECAPA_MINIMUM_SAMPLES,
  ecapaInput,
  loadLanguageIDRuntime,
  posteriorFromLogp,
  type LanguageIDRuntime,
} from './language-id-runtime.js';

/** Intra-op threads for the pass (language-id-runtime.ts has the measurement). */
export const LANGUAGE_ID_THREADS = 2;

/**
 * Start `engine-host.js lid`, load the model in it, resolve once it is loaded. Rejects with
 * `EngineProcessExit` when the process dies — `beforeReady` when it never said hello (the launcher
 * failing, not the model). The same shape as `startParakeetProcess`.
 */
export function startLanguageIDProcess(
  modelPath: string,
  options: LanguageIDRuntimeOptions,
  launcher: EngineLauncher,
  onExit?: (exit: EngineProcessExit) => void,
): Promise<LanguageIDRuntime> {
  const channel = launcher('lid');
  let dead: EngineProcessExit | null = null;
  let hello = false;
  let loaded = false;
  let disposing = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (logp: Float32Array) => void; reject: (error: Error) => void }>();

  return new Promise<LanguageIDRuntime>((resolveLoad, rejectLoad) => {
    channel.onExit((code) => {
      if (dead !== null) return;
      dead = new EngineProcessExit('lid', code, !hello);
      for (const [, waiter] of pending) waiter.reject(dead);
      pending.clear();
      if (!loaded) rejectLoad(dead);
      else if (!disposing) onExit?.(dead);
    });
    channel.onMessage((message) => {
      const reply = message as LanguageIDReply | { readonly kind: 'hello' };
      if (reply.kind === 'hello') {
        hello = true;
        return;
      }
      if (reply.kind === 'loaded') {
        loaded = true;
        resolveLoad(runtime);
        return;
      }
      if (reply.kind === 'error' && reply.id === null) {
        if (!loaded) {
          rejectLoad(new Error(reply.message));
          channel.kill();
        }
        return;
      }
      if (reply.id === null) return;
      const waiter = pending.get(reply.id);
      if (waiter === undefined) return;
      pending.delete(reply.id);
      if (reply.kind === 'logp') waiter.resolve(reply.logp);
      else waiter.reject(new Error(reply.message));
    });

    const runtime: LanguageIDRuntime = {
      logPosterior(samples) {
        if (dead !== null) return Promise.reject(dead);
        const id = nextId;
        nextId += 1;
        return new Promise<Float32Array>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          channel.postMessage({ kind: 'identify', id, samples } satisfies LanguageIDRequest);
        });
      },
      alive: () => dead === null,
      async dispose() {
        if (dead !== null) return;
        disposing = true;
        const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));
        channel.postMessage({ kind: 'dispose' } satisfies LanguageIDRequest);
        const timer = setTimeout(() => channel.kill(), 2000);
        await exited;
        clearTimeout(timer);
      },
    };
    channel.postMessage({ kind: 'load', modelPath, options } satisfies LanguageIDRequest);
  });
}

export interface LanguageIdentifierOptions {
  readonly modelPath: string;
  /** The app's utility-process launcher. Absent: the session loads in this thread. */
  readonly launcher?: EngineLauncher;
  readonly threads?: number;
  readonly onNote?: (note: string) => void;
  /** Injected by the tests: a runtime instead of ONNX Runtime. */
  readonly loadRuntime?: (modelPath: string, options: LanguageIDRuntimeOptions) => Promise<LanguageIDRuntime>;
}

/** The classifier the language-ID router reads, plus its lifecycle. */
export interface LanguageIdentifier extends AcousticClassifier {
  readonly modelPath: string;
  /** Load now (the manager calls it when it builds the router, so key-up never pays the load). */
  prepare(): Promise<void>;
  isReady(): boolean;
  dispose(): Promise<void>;
}

export function createLanguageIdentifier(options: LanguageIdentifierOptions): LanguageIdentifier {
  const note = options.onNote ?? (() => {});
  const runtimeOptions: LanguageIDRuntimeOptions = { threads: options.threads ?? LANGUAGE_ID_THREADS };
  const crashes = new CrashLimiter();
  let runtime: LanguageIDRuntime | null = null;
  let loading: Promise<LanguageIDRuntime> | null = null;
  let processUnavailable = false;
  let disposed = false;
  /** One pass at a time, in order: the host serves them so anyway, and the in-thread session is not re-entrant. */
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<LanguageIDRuntime> {
    if (options.loadRuntime !== undefined) return options.loadRuntime(options.modelPath, runtimeOptions);
    const launcher = options.launcher;
    if (launcher === undefined || processUnavailable) return loadLanguageIDRuntime(options.modelPath, runtimeOptions);
    if (!crashes.mayStart()) {
      throw new Error(`the language-ID process crashed ${crashes.recent()} times in the last few minutes`);
    }
    try {
      return await startLanguageIDProcess(options.modelPath, runtimeOptions, launcher, (exit) => {
        crashes.crashed();
        runtime = null;
        note(`language ID: ${exit.message} — restarting on the next dictation`);
      });
    } catch (error: unknown) {
      if (error instanceof EngineProcessExit && error.beforeReady) {
        processUnavailable = true;
        note(`language ID: ${error.message}; running in the app instead`);
        return loadLanguageIDRuntime(options.modelPath, runtimeOptions);
      }
      if (error instanceof EngineProcessExit) crashes.crashed();
      throw error;
    }
  }

  async function prepare(): Promise<void> {
    if (disposed) throw new Error('the language-ID model was disposed');
    if (runtime !== null && runtime.alive?.() !== false) return;
    loading ??= load().finally(() => {
      loading = null;
    });
    const loaded = await loading;
    if (disposed) {
      await loaded.dispose();
      throw new Error('the language-ID model was disposed');
    }
    runtime = loaded;
    note(`language ID: loaded ${options.modelPath}`);
  }

  async function posterior(audio: AudioBuffer): Promise<LanguagePosterior> {
    if (audio.samples.length === 0 || disposed) return {};
    try {
      await prepare();
      const ready = runtime;
      if (ready === null) return {};
      const pass = queue.then(
        () => ready.logPosterior(audio.samples),
        () => ready.logPosterior(audio.samples),
      );
      queue = pass.catch(() => undefined);
      const answer = posteriorFromLogp(await pass);
      if (Object.keys(answer).length === 0) note('language ID: no opinion — the model answered the wrong shape');
      return answer;
    } catch (error: unknown) {
      // A process that died mid-pass is dropped, and the next press starts a fresh one.
      if (runtime !== null && runtime.alive?.() === false) runtime = null;
      note(`language ID: no opinion — ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  return {
    modelPath: options.modelPath,
    posterior,
    prepare,
    isReady: () => runtime !== null && runtime.alive?.() !== false,
    async dispose() {
      disposed = true;
      const current = runtime;
      runtime = null;
      await current?.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------
// Where the model is
// ---------------------------------------------------------------------------------

/** The file, wherever it lives — the bundle's one file, and the name a user may drop in by hand. */
export const LANGUAGE_ID_MODEL_FILE = ECAPA_LID.files[0]!.localName;

/**
 * Below this a file cannot be the model: 86 MB as shipped. A size floor, not a hash — what the
 * Mac's `resolvedLanguageIDPath` asks of a path it did not verify itself (the ggml magic bytes
 * `inspectModelFile` checks do not apply to ONNX). The bundle store's copies ARE hash-verified.
 */
export const LANGUAGE_ID_MINIMUM_BYTES = 40_000_000;

async function largeEnough(path: string): Promise<boolean> {
  if (path === '') return false;
  try {
    const info = await stat(path);
    return info.isFile() && info.size >= LANGUAGE_ID_MINIMUM_BYTES;
  } catch {
    return false;
  }
}

/**
 * The language-ID model's path, or `null` — the Mac's `resolvedLanguageIDPath`, in the Windows
 * resolution order: (1) the explicit setting, when a file of the right size is there; (2) the
 * bundle store's verified copy — the installer's `resources/models/ecapa-voxlingua107-lid/`
 * (stamped by `fetch-models.mjs`) or one the Languages page downloaded; (3) the bare file in the
 * models directory, for a user handed it by hand. Never writes the setting.
 */
export async function resolveLanguageIDPath(
  settings: Pick<Settings, 'languageIDModelPath'>,
  bundles: Pick<BundleStore, 'locate' | 'directoryFor'> | null,
): Promise<string | null> {
  if (await largeEnough(settings.languageIDModelPath)) return settings.languageIDModelPath;
  if (bundles === null) return null;
  const directory = await bundles.locate('ecapa_lid');
  if (directory !== null) return join(directory, LANGUAGE_ID_MODEL_FILE);
  const loose = join(dirname(bundles.directoryFor('ecapa_lid')), LANGUAGE_ID_MODEL_FILE);
  return (await largeEnough(loose)) ? loose : null;
}
