// Parakeet's three ONNX sessions and the decoder loop — and the worker thread they live in.
//
// WHY A WORKER THREAD. `InferenceSession.run` is asynchronous in onnxruntime-node (measured:
// the longest event-loop stall during a 200 ms encoder pass was 6.7 ms), but LOADING is not:
// the binding's `loadModel` runs synchronously inside `InferenceSession.create`, and for the
// 650 MB encoder that stalled this Mac's event loop for 760 ms — on a Windows laptop, likely
// seconds. In the Electron main process that is the hotkey's key-up, the paste of the
// previous dictation and every IPC message waiting behind a model load, which the key-down
// preload triggers while the user is speaking. In a worker the same load stalled the main
// loop for 6 ms. The decoder's few hundred small calls per utterance move off the main
// thread with it.
//
// A worker thread and not `utilityProcess`: it runs under plain Node too, so the headless
// FLEURS measurement exercises exactly this path, and a thread needs no new process to
// supervise. Not `kotiba-stt.exe`: see D-W18.
//
// The worker's whole module graph is this file, `src/core/stt/tdt.ts` and onnxruntime-node,
// and electron-builder UNPACKS all of it (`asarUnpack`), so the thread never has to load a
// script out of `app.asar`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { InferenceSession, Tensor } from 'onnxruntime-node';

import { greedyTdt, parseVocabulary, piecesToText, type Vocabulary } from '../core/stt/tdt.js';

/** What the engine needs from ONNX Runtime. Injectable, so the engine's logic is testable. */
export interface ParakeetRuntime {
  /** 16 kHz mono in, text out (trimmed). */
  transcribeSamples(samples: Float32Array): Promise<string>;
  /** `false` once the runtime can never answer again — a worker that died. */
  alive?(): boolean;
  dispose(): Promise<void>;
}

/** How the sessions are run. Recorded in 03-ENGINE-PARITY.md §10. */
export interface ParakeetRuntimeOptions {
  /** Encoder threads — the one heavy pass. */
  readonly threads: number;
  /** `cpu` everywhere; `dml` (DirectML) is an execution-provider switch, unmeasured. */
  readonly executionProvider?: 'cpu' | 'dml';
}

type OrtModule = typeof import('onnxruntime-node');

async function loadOrt(): Promise<OrtModule> {
  // A CommonJS package: under ESM the named exports may or may not be lifted onto the
  // namespace, depending on the loader. Take whichever carries the session class.
  const module = (await import('onnxruntime-node')) as unknown as Partial<OrtModule> & { default?: OrtModule };
  return (module.InferenceSession !== undefined ? module : module.default) as OrtModule;
}

/**
 * Loads the bundle's three sessions IN THIS THREAD: `nemo128.onnx` (the 128-bin log-mel
 * front end the export ships), the int8 encoder (subsampling ×8), the int8 decoder-joint.
 * The worker calls this; so does a test that wants no thread.
 */
export async function loadParakeetRuntime(directory: string, options: ParakeetRuntimeOptions): Promise<ParakeetRuntime> {
  const ort = await loadOrt();
  const provider = options.executionProvider ?? 'cpu';
  const heavy: InferenceSession.SessionOptions = {
    executionProviders: [provider],
    intraOpNumThreads: Math.max(1, options.threads),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    // ONNX Runtime's pool spins after a run by default, burning a core per thread for a
    // while after every dictation. This is a background app on a laptop battery; one
    // encoder pass per window is the whole workload, so the spin buys nothing.
    extra: { session: { intra_op: { allow_spinning: '0' } } },
  };
  // The decoder-joint is a few hundred small calls per utterance, each microseconds of
  // arithmetic: one thread, because waking a pool per call costs more than the call.
  const light: InferenceSession.SessionOptions = {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  };
  const [preprocessor, encoder, decoder, vocabText] = await Promise.all([
    ort.InferenceSession.create(join(directory, 'nemo128.onnx'), light),
    ort.InferenceSession.create(join(directory, 'encoder-model.int8.onnx'), heavy),
    ort.InferenceSession.create(join(directory, 'decoder_joint-model.int8.onnx'), light),
    readFile(join(directory, 'vocab.txt'), 'utf8'),
  ]);
  const vocabulary: Vocabulary = parseVocabulary(vocabText);
  const stateShape = decoderStateShape(decoder);

  async function transcribeSamples(input: Float32Array): Promise<string> {
    const n = input.length;
    const features = await preprocessor.run({
      waveforms: new ort.Tensor('float32', input, [1, n]),
      waveforms_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(n)]), [1]),
    });
    const encoded = await encoder.run({ audio_signal: features.features!, length: features.features_lens! });
    const outputs = encoded.outputs!;
    const [, hidden, frames] = outputs.dims as [number, number, number];
    const valid = Number((encoded.encoded_lengths!.data as BigInt64Array)[0] ?? BigInt(frames));
    const data = outputs.data as Float32Array;
    // `[1, 1024, T]` → one frame's 1024 values, as onnx-asr's `encoder_out[None, :, None]`.
    const column = (t: number): Float32Array => {
      const out = new Float32Array(hidden);
      for (let d = 0; d < hidden; d += 1) out[d] = data[d * frames + t]!;
      return out;
    };
    const zeros = (): Tensor => new ort.Tensor('float32', new Float32Array(stateShape[0] * stateShape[2]), [...stateShape]);

    const tokens = await greedyTdt<{ readonly s1: Tensor; readonly s2: Tensor }>({
      frames: Math.min(valid, frames),
      vocabSize: vocabulary.size,
      blank: vocabulary.blank,
      initialState: () => ({ s1: zeros(), s2: zeros() }),
      step: async (t, previous, state) => {
        const result = await decoder.run(
          {
            encoder_outputs: new ort.Tensor('float32', column(t), [1, hidden, 1]),
            targets: new ort.Tensor('int32', Int32Array.from([previous]), [1, 1]),
            target_length: new ort.Tensor('int32', Int32Array.from([1]), [1]),
            input_states_1: state.s1,
            input_states_2: state.s2,
          },
          ['outputs', 'output_states_1', 'output_states_2'],
        );
        return {
          output: result.outputs!.data as Float32Array,
          state: { s1: result.output_states_1!, s2: result.output_states_2! },
        };
      },
    });
    return piecesToText(tokens, vocabulary).trim();
  }

  return {
    transcribeSamples,
    async dispose() {
      await Promise.allSettled([preprocessor.release(), encoder.release(), decoder.release()]);
    },
  };
}

/** `[layers, 1, hidden]` from the decoder's declared `input_states_1` shape. */
function decoderStateShape(session: InferenceSession): readonly [number, 1, number] {
  const meta = session.inputMetadata.find((entry) => entry.name === 'input_states_1');
  const shape = meta !== undefined && meta.isTensor ? meta.shape : [];
  const layers = typeof shape[0] === 'number' ? shape[0] : 2;
  const hidden = typeof shape[2] === 'number' ? shape[2] : 640;
  return [layers, 1, hidden];
}

// ---------------------------------------------------------------------------------
// The worker, from the main thread's side
// ---------------------------------------------------------------------------------

/** Main → worker. */
export type WorkerRequest =
  | { readonly kind: 'load'; readonly directory: string; readonly options: ParakeetRuntimeOptions }
  | { readonly kind: 'transcribe'; readonly id: number; readonly samples: Float32Array }
  | { readonly kind: 'dispose' };

/** Worker → main. */
export type WorkerReply =
  | { readonly kind: 'loaded' }
  | { readonly kind: 'text'; readonly id: number; readonly text: string }
  | { readonly kind: 'error'; readonly id: number | null; readonly message: string };

/**
 * The engine's side of the conversation, for whichever carrier it runs in: the worker thread
 * (`parakeet-worker.ts`, the fallback) or its own process (`engine-host.ts`, the app). Messages
 * are handled strictly in order, so a transcription never overlaps another.
 */
export function serveParakeet(port: {
  readonly onMessage: (listener: (request: WorkerRequest) => void) => void;
  readonly postMessage: (reply: WorkerReply) => void;
  /** After `dispose`: close the port or end the process. */
  readonly close: () => void;
}): void {
  let runtime: ParakeetRuntime | null = null;
  let queue: Promise<void> = Promise.resolve();
  const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  async function handle(request: WorkerRequest): Promise<void> {
    switch (request.kind) {
      case 'load':
        try {
          runtime = await loadParakeetRuntime(request.directory, request.options);
          port.postMessage({ kind: 'loaded' });
        } catch (error: unknown) {
          port.postMessage({ kind: 'error', id: null, message: describeError(error) });
        }
        return;
      case 'transcribe':
        if (runtime === null) {
          port.postMessage({ kind: 'error', id: request.id, message: 'the model is not loaded' });
          return;
        }
        try {
          port.postMessage({ kind: 'text', id: request.id, text: await runtime.transcribeSamples(request.samples) });
        } catch (error: unknown) {
          port.postMessage({ kind: 'error', id: request.id, message: describeError(error) });
        }
        return;
      case 'dispose':
        await runtime?.dispose();
        runtime = null;
        port.close();
        return;
    }
  }

  port.onMessage((request) => {
    queue = queue.then(() => handle(request));
  });
}

/**
 * The worker script's path — beside this file, and OUT of `app.asar` in a packaged app:
 * electron-builder unpacks it and everything it imports (`asarUnpack`), and a worker
 * thread should never depend on loading a script from inside an archive.
 */
export function parakeetWorkerPath(): string {
  const here = fileURLToPath(new URL('./parakeet-worker.js', import.meta.url));
  return here.replace(/app\.asar([\\/])/u, 'app.asar.unpacked$1');
}

/** Load the runtime in its own thread. Resolves once the three sessions are loaded. */
export function startParakeetWorker(
  directory: string,
  options: ParakeetRuntimeOptions,
  workerPath: string = parakeetWorkerPath(),
): Promise<ParakeetRuntime> {
  const worker = new Worker(workerPath);
  let dead: string | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();

  return new Promise<ParakeetRuntime>((resolveLoad, rejectLoad) => {
    let loaded = false;
    const die = (why: string): void => {
      if (dead !== null) return;
      dead = why;
      for (const [, waiter] of pending) waiter.reject(new Error(`the Parakeet worker stopped: ${why}`));
      pending.clear();
      if (!loaded) rejectLoad(new Error(`the Parakeet worker stopped while loading: ${why}`));
    };
    worker.on('error', (error) => die(error.message));
    worker.on('exit', (code) => die(`exit code ${code}`));
    worker.on('message', (reply: WorkerReply) => {
      if (reply.kind === 'loaded') {
        loaded = true;
        resolveLoad(runtime);
        return;
      }
      if (reply.kind === 'error' && reply.id === null) {
        if (!loaded) rejectLoad(new Error(reply.message));
        return;
      }
      if (reply.id === null) return;
      const waiter = pending.get(reply.id);
      if (waiter === undefined) return;
      pending.delete(reply.id);
      if (reply.kind === 'text') waiter.resolve(reply.text);
      else waiter.reject(new Error(reply.message));
    });

    const runtime: ParakeetRuntime = {
      transcribeSamples(samples) {
        if (dead !== null) return Promise.reject(new Error(`the Parakeet worker stopped: ${dead}`));
        const id = nextId;
        nextId += 1;
        // A copy, transferred: the caller keeps its buffer, and the copy crosses for free.
        const copy = samples.slice();
        return new Promise<string>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          worker.postMessage({ kind: 'transcribe', id, samples: copy } satisfies WorkerRequest, [copy.buffer]);
        });
      },
      alive: () => dead === null,
      async dispose() {
        if (dead !== null) return;
        worker.postMessage({ kind: 'dispose' } satisfies WorkerRequest);
        // The worker releases its sessions and exits; `terminate` is the backstop.
        const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
        const timer = setTimeout(() => void worker.terminate(), 2000);
        await exited;
        clearTimeout(timer);
      },
    };
    worker.postMessage({ kind: 'load', directory, options } satisfies WorkerRequest);
  });
}
