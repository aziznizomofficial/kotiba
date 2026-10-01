// Arabic's two decoders, and the process they run in (C4 §7.2, §7.3.1; the owner's Windows rule).
//
//   * COHERE — Cohere Transcribe Arabic 07-2026, Q5_K_M GGUF, through transcribe.cpp's npm binding
//     (`transcribe-cpp`, koffi FFI over `transcribe.dll` and its ggml DLLs). `backend: 'auto'`
//     lets ggml take Vulkan when the PC has a GPU and a driver for it, and the CPU otherwise;
//     `cpu` when the user turned GPU off (`Settings.whisperUseGPU`).
//   * FASTCONFORMER — NVIDIA's 115 M FastConformer-Hybrid Arabic, int8 ONNX, on onnxruntime-node
//     (already in the installer for Parakeet), with the NeMo front end and greedy CTC of
//     `src/core/stt/nemo-ctc.ts` — checked identical to onnx-asr's text on real FLEURS clips.
//
// Either one runs in its OWN OS PROCESS (`engine-host.js arabic`, an Electron utility process —
// D-W22's rule for native engines): a crash inside ggml, ONNX Runtime or koffi ends that process,
// not the app. The runtime is the same object in both carriers; the in-process path is for
// `--check`, the tests, and a machine where the process cannot start at all.
//
// THE DECODE-LOOP GUARD (C4 §3.2). Cohere looped on 2 of 200 dialect clips until transcribe.cpp's
// generation cap stopped it (`OutputTruncated`) and returned nothing. That is reported here as a
// FLAG, `truncated`, never as text: the engine above re-decodes the span with whisper turbo.
// And Cohere is hard-capped at a 35 s window (C4 §3.3), so nothing here is ever handed more than
// `ARABIC_MAX_SEGMENT_SECONDS` — the engine cuts before it gets that far.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { InferenceSession } from 'onnxruntime-node';

import { COHERE_ARABIC } from '../contracts/index.js';
import { ctcFramesFor, greedyCtc, nemoLogMel } from '../core/stt/nemo-ctc.js';
import { parseVocabulary, piecesToText } from '../core/stt/tdt.js';

import { EngineProcessExit, type EngineLauncher } from './engine-process.js';

export const ARABIC_ENGINE_KINDS = ['cohere', 'fastConformer'] as const;
export type ArabicEngineKind = (typeof ARABIC_ENGINE_KINDS)[number];

/** Never hand either decoder more than this: Cohere's window is 35 s and it decodes only that. */
export const ARABIC_MAX_SEGMENT_SECONDS = 28;

export interface ArabicRuntimeOptions {
  readonly kind: ArabicEngineKind;
  /** The bundle's directory (verified by the bundle store). */
  readonly directory: string;
  /** CPU threads for the heavy pass. */
  readonly threads: number;
  /** Cohere only: `auto` = Vulkan when there is a usable GPU, else the CPU. */
  readonly backend?: 'auto' | 'cpu';
}

export interface ArabicDecode {
  readonly text: string;
  /** Cohere hit its generation cap (a decode loop). `text` is then empty: re-decode elsewhere. */
  readonly truncated: boolean;
  /** Wall time of the decode inside the runtime. */
  readonly milliseconds: number;
}

/** What the engine needs from a decoder. Injectable, so the engine's logic is testable. */
export interface ArabicRuntime {
  readonly kind: ArabicEngineKind;
  /** What it runs on, for the Languages page and the diagnostics: "Vulkan: …", "CPU". */
  readonly device: string;
  /**
   * 16 kHz mono in. `signal` drops a decode that has not started and stops Cohere's that has
   * (transcribe.cpp polls it) — a streaming pause decode superseded by newer speech must not
   * hold the model while the tail waits behind it. Rejects with `ArabicAborted` when it fired.
   */
  transcribeSamples(samples: Float32Array, signal?: AbortSignal): Promise<ArabicDecode>;
  /** `false` once it can never answer again — a process that died. */
  alive?(): boolean;
  dispose(): Promise<void>;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A decode stopped by its signal. Not a failure of the model. */
export class ArabicAborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'ArabicAborted';
  }
}

const ABORTED_MESSAGE = 'aborted';

// ---------------------------------------------------------------------------------
// Cohere, through transcribe.cpp
// ---------------------------------------------------------------------------------

type TranscribeModule = typeof import('transcribe-cpp');

/** transcribe-cpp's platform package for this machine, as its own loader names it. */
const TRANSCRIBE_PACKAGE: Readonly<Record<string, { readonly name: string; readonly library: string }>> = {
  'win32-x64': { name: '@transcribe-cpp/win32-x64-cpu-vulkan', library: 'transcribe.dll' },
  'darwin-arm64': { name: '@transcribe-cpp/darwin-arm64-metal', library: 'libtranscribe.dylib' },
  'darwin-x64': { name: '@transcribe-cpp/darwin-x64-cpu', library: 'libtranscribe.dylib' },
  'linux-x64': { name: '@transcribe-cpp/linux-x64-cpu-vulkan', library: 'libtranscribe.so' },
};

/**
 * In the INSTALLED app the platform package resolves to a path inside `app.asar` — `existsSync`
 * says yes (Electron's archive support), and then `LoadLibrary` is handed a path Windows cannot
 * open. electron-builder unpacks the package (`asarUnpack`); this names the unpacked copy, for
 * `TRANSCRIBE_LIBRARY` (the loader's own override, which also makes its directory the one the
 * ggml backend DLLs are loaded from). `null` outside a packaged app: the loader's normal search.
 */
export function unpackedTranscribeLibrary(
  packageJson: string | null,
  exists: (path: string) => boolean = existsSync,
  key = `${process.platform}-${process.arch}`,
): string | null {
  const known = TRANSCRIBE_PACKAGE[key];
  if (packageJson === null || known === undefined) return null;
  // Split by hand on either separator: the path is the host OS's, and the test runs elsewhere.
  const cut = Math.max(packageJson.lastIndexOf('/'), packageJson.lastIndexOf('\\'));
  if (cut < 0) return null;
  const packed = packageJson.slice(0, cut);
  const unpacked = packed.replace(/app\.asar([\\/])/u, 'app.asar.unpacked$1');
  if (unpacked === packed) return null;
  const library = `${unpacked}${packageJson[cut] ?? '/'}${known.library}`;
  return exists(library) ? library : null;
}

function pinTranscribeLibrary(): void {
  if (process.env['TRANSCRIBE_LIBRARY'] !== undefined) return;
  const known = TRANSCRIBE_PACKAGE[`${process.platform}-${process.arch}`];
  if (known === undefined) return;
  let packageJson: string | null = null;
  try {
    packageJson = createRequire(import.meta.url).resolve(`${known.name}/package.json`);
  } catch {
    return; // not installed: the loader's own error says so, better than we could
  }
  const library = unpackedTranscribeLibrary(packageJson);
  if (library !== null) process.env['TRANSCRIBE_LIBRARY'] = library;
}

export async function loadCohereRuntime(options: ArabicRuntimeOptions): Promise<ArabicRuntime> {
  pinTranscribeLibrary();
  // Imported lazily: the module resolves and `dlopen`s the native library on first use, and only
  // an Arabic host should ever pay for that (or fail on it).
  const transcribe: TranscribeModule = await import('transcribe-cpp');
  const path = join(options.directory, COHERE_ARABIC.files[0]!.localName);
  const model = await transcribe.TranscribeModel.load(path, { backend: options.backend ?? 'auto' });
  const session = model.createSession({ nThreads: Math.max(1, options.threads) });
  const device = describeDevice(model.device);
  let disposed = false;

  return {
    kind: 'cohere',
    device,
    async transcribeSamples(samples, signal) {
      if (disposed) throw new Error('the Arabic model was released');
      if (signal?.aborted === true) throw new ArabicAborted();
      const started = performance.now();
      try {
        // The measured configuration (C4 §1: `session.run(samples, language='ar')`), plus the
        // cooperative abort.
        const result = await session.run(samples, { language: 'ar', ...(signal === undefined ? {} : { signal }) });
        const milliseconds = performance.now() - started;
        if (result.aborted) throw new ArabicAborted();
        if (result.truncated) return { text: '', truncated: true, milliseconds };
        return { text: result.text.trim(), truncated: false, milliseconds };
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'OutputTruncated') {
          return { text: '', truncated: true, milliseconds: performance.now() - started };
        }
        if (error instanceof Error && error.name === 'Aborted') throw new ArabicAborted();
        throw error;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      session.dispose();
      model.dispose();
    },
  };
}

/**
 * "Vulkan (AMD Radeon Graphics)", or "CPU". From the device the model LANDED on — `backend` is
 * the device's own name (`MTL0`, `Vulkan0`), which says nothing a user can read.
 */
export function describeDevice(device: { readonly kind: string; readonly deviceType: string; readonly name: string; readonly description: string }): string {
  if (device.deviceType === 'cpu' || device.kind.toLowerCase() === 'cpu') return 'CPU';
  const kind = device.kind.toLowerCase();
  const label = kind === 'vulkan' ? 'Vulkan' : kind === 'metal' ? 'Metal' : kind === 'cuda' ? 'CUDA' : device.kind;
  return `${label} (${device.description || device.name})`;
}

// ---------------------------------------------------------------------------------
// FastConformer, on ONNX Runtime
// ---------------------------------------------------------------------------------

type OrtModule = typeof import('onnxruntime-node');

async function loadOrt(): Promise<OrtModule> {
  const module = (await import('onnxruntime-node')) as unknown as Partial<OrtModule> & { default?: OrtModule };
  return (module.InferenceSession !== undefined ? module : module.default) as OrtModule;
}

export async function loadFastConformerRuntime(options: ArabicRuntimeOptions): Promise<ArabicRuntime> {
  const ort = await loadOrt();
  const sessionOptions: InferenceSession.SessionOptions = {
    executionProviders: ['cpu'],
    intraOpNumThreads: Math.max(1, options.threads),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    // As Parakeet's: no pool spinning after a run on a laptop battery.
    extra: { session: { intra_op: { allow_spinning: '0' } } },
  };
  const [session, vocabText, configText] = await Promise.all([
    ort.InferenceSession.create(join(options.directory, 'model.int8.onnx'), sessionOptions),
    readFile(join(options.directory, 'vocab.txt'), 'utf8'),
    readFile(join(options.directory, 'config.json'), 'utf8'),
  ]);
  const config = JSON.parse(configText) as { features_size?: number; subsampling_factor?: number };
  const mels = config.features_size ?? 80;
  const subsampling = config.subsampling_factor ?? 8;
  const vocabulary = parseVocabulary(vocabText);

  return {
    kind: 'fastConformer',
    device: 'CPU',
    async transcribeSamples(samples, signal) {
      // ~20 ms for a 3 s tail on a CPU: nothing worth stopping half-way, only a queued one.
      if (signal?.aborted === true) throw new ArabicAborted();
      const started = performance.now();
      const features = nemoLogMel(samples, mels);
      const outputs = await session.run({
        audio_signal: new ort.Tensor('float32', features.data, [1, mels, features.frames]),
        length: new ort.Tensor('int64', BigInt64Array.from([BigInt(features.length)]), [1]),
      });
      const logprobs = outputs.logprobs!;
      const [, frames, vocab] = logprobs.dims as [number, number, number];
      const tokens = greedyCtc(logprobs.data as Float32Array, frames, vocab, vocabulary.blank, ctcFramesFor(features.length, subsampling));
      return { text: piecesToText(tokens, vocabulary).trim(), truncated: false, milliseconds: performance.now() - started };
    },
    async dispose() {
      await session.release();
    },
  };
}

export function loadArabicRuntime(options: ArabicRuntimeOptions): Promise<ArabicRuntime> {
  return options.kind === 'cohere' ? loadCohereRuntime(options) : loadFastConformerRuntime(options);
}

// ---------------------------------------------------------------------------------
// The host's side of the conversation
// ---------------------------------------------------------------------------------

/** Main → host. */
export type ArabicRequest =
  | { readonly kind: 'load'; readonly options: ArabicRuntimeOptions }
  | { readonly kind: 'transcribe'; readonly id: number; readonly samples: Float32Array }
  /** Handled the moment it arrives, not in the queue: drop or stop decode `id`. */
  | { readonly kind: 'abort'; readonly id: number }
  | { readonly kind: 'dispose' };

/** Host → main. */
export type ArabicReply =
  | { readonly kind: 'loaded'; readonly device: string }
  | { readonly kind: 'decoded'; readonly id: number; readonly decode: ArabicDecode }
  | { readonly kind: 'error'; readonly id: number | null; readonly message: string };

/** Strictly in order, so two decodes never overlap on one model (transcribe.cpp refuses that). */
export function serveArabic(port: {
  readonly onMessage: (listener: (request: ArabicRequest) => void) => void;
  readonly postMessage: (reply: ArabicReply) => void;
  readonly close: () => void;
}): void {
  let runtime: ArabicRuntime | null = null;
  let queue: Promise<void> = Promise.resolve();
  /** One per decode queued or running, so an `abort` can reach it wherever it is. */
  const aborts = new Map<number, AbortController>();

  async function handle(request: ArabicRequest): Promise<void> {
    switch (request.kind) {
      case 'load':
        try {
          runtime = await loadArabicRuntime(request.options);
          port.postMessage({ kind: 'loaded', device: runtime.device });
        } catch (error: unknown) {
          port.postMessage({ kind: 'error', id: null, message: describe(error) });
        }
        return;
      case 'transcribe':
        if (runtime === null) {
          port.postMessage({ kind: 'error', id: request.id, message: 'the model is not loaded' });
          return;
        }
        try {
          const signal = aborts.get(request.id)?.signal;
          port.postMessage({ kind: 'decoded', id: request.id, decode: await runtime.transcribeSamples(request.samples, signal) });
        } catch (error: unknown) {
          port.postMessage({ kind: 'error', id: request.id, message: error instanceof ArabicAborted ? ABORTED_MESSAGE : describe(error) });
        } finally {
          aborts.delete(request.id);
        }
        return;
      case 'abort':
        return;
      case 'dispose':
        await runtime?.dispose().catch(() => undefined);
        runtime = null;
        port.close();
        return;
    }
  }

  port.onMessage((request) => {
    if (request.kind === 'abort') {
      aborts.get(request.id)?.abort();
      return;
    }
    if (request.kind === 'transcribe') aborts.set(request.id, new AbortController());
    queue = queue.then(() => handle(request));
  });
}

/** What the host says first, before any model is touched. */
interface HostHello {
  readonly kind: 'hello';
  readonly pid: number;
}

/**
 * Start `engine-host.js arabic`, load the chosen decoder in it, resolve once it answers `loaded`.
 * Rejects with `EngineProcessExit` when the process dies — `beforeReady` when it never said hello,
 * which is the launcher failing rather than the model. `parakeet-process.ts`, for this engine.
 */
export function startArabicProcess(
  options: ArabicRuntimeOptions,
  launcher: EngineLauncher,
  onExit?: (exit: EngineProcessExit) => void,
): Promise<ArabicRuntime> {
  const channel = launcher('arabic');
  let dead: EngineProcessExit | null = null;
  let hello = false;
  let loaded = false;
  let disposing = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (decode: ArabicDecode) => void; reject: (error: Error) => void }>();

  return new Promise<ArabicRuntime>((resolveLoad, rejectLoad) => {
    channel.onExit((code) => {
      if (dead !== null) return;
      dead = new EngineProcessExit('arabic', code, !hello);
      for (const [, waiter] of pending) waiter.reject(dead);
      pending.clear();
      if (!loaded) rejectLoad(dead);
      else if (!disposing) onExit?.(dead);
    });
    let device = 'CPU';
    channel.onMessage((message) => {
      const reply = message as ArabicReply | HostHello;
      if (reply.kind === 'hello') {
        hello = true;
        return;
      }
      if (reply.kind === 'loaded') {
        loaded = true;
        device = reply.device;
        resolveLoad(runtime());
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
      if (reply.kind === 'decoded') waiter.resolve(reply.decode);
      else waiter.reject(reply.message === ABORTED_MESSAGE ? new ArabicAborted() : new Error(reply.message));
    });

    const runtime = (): ArabicRuntime => ({
      kind: options.kind,
      device,
      transcribeSamples(samples, signal) {
        if (dead !== null) return Promise.reject(dead);
        if (signal?.aborted === true) return Promise.reject(new ArabicAborted());
        const id = nextId;
        nextId += 1;
        return new Promise<ArabicDecode>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          signal?.addEventListener(
            'abort',
            () => {
              if (pending.has(id)) channel.postMessage({ kind: 'abort', id } satisfies ArabicRequest);
            },
            { once: true },
          );
          channel.postMessage({ kind: 'transcribe', id, samples } satisfies ArabicRequest);
        });
      },
      alive: () => dead === null,
      async dispose() {
        if (dead !== null) return;
        disposing = true;
        const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));
        channel.postMessage({ kind: 'dispose' } satisfies ArabicRequest);
        const timer = setTimeout(() => channel.kill(), 2000);
        await exited;
        clearTimeout(timer);
      },
    });
    channel.postMessage({ kind: 'load', options } satisfies ArabicRequest);
  });
}
