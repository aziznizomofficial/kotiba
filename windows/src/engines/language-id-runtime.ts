// The language-ID model's ONNX session, and the protocol it is served over in its own process.
//
// The Windows twin of the Mac's `EcapaLanguageIdentifier` (Sources/KotibaEngines/
// EcapaLanguageIdentifier.swift, P4 §2, D-14): SpeechBrain's VoxLingua107 ECAPA-TDNN
// (`speechbrain/lang-id-voxlingua107-ecapa`, Apache-2.0), exported by `Scripts/export-ecapa.py`
// as ONE graph from the waveform to the 107 log-posteriors — the STFT as a strided convolution,
// SpeechBrain's 60-band filterbank, sentence mean normalisation, the ECAPA-TDNN and its
// classifier. The Mac runs it as Core ML (Float16, 42.9 MB); Windows runs the same graph as ONNX
// opset 17, Float32, 86 MB (`ecapa-voxlingua107-lid.onnx`, Scripts/Manifest.json role
// `language-id-windows`), on the ONNX Runtime the port already carries for Parakeet.
//
// The graph: input `audio` [1, samples] 16 kHz float32, 4000 ≤ samples ≤ 480000 (0.25–30 s —
// the range it was exported for), output `logp` [1, 107] log-softmax in `ECAPA_LABELS` order.
//
// ONE THREAD-POOL OF ITS OWN, small: the CPU is shared with whichever engine decodes the tail at
// the same key-up, and on the Mac running it beside the Uzbek decode on the GPU is exactly what
// cost whisper base's detection ~150 ms of Uzbek tail (P1) — so it never runs there. Measured
// through this module on the 60-clip P4 tuning list (1.6–30 s, median 5.8 s; M4 Pro, plain Node,
// 2026-10-03): 1 thread p50 36 / p90 124 ms, 2 threads 25 / 71 ms, 4 threads 22 / 61 ms; load
// ~60 ms. Two is the default (`LANGUAGE_ID_THREADS`). Top language identical to the Mac's Core ML
// posteriors on 60 of 60 clips, every shared probability within 4e-4 (Float16 against Float32).
//
// This module imports nothing but onnxruntime-node: it is the whole module graph of the `lid`
// engine host (`engine-host.ts`), which the utility process reads from app.asar like the Arabic
// host's; only ONNX Runtime's native addon is unpacked (`asarUnpack`, already there for Parakeet).

import type { InferenceSession } from 'onnxruntime-node';

/** The class order of the model's output — `EcapaLanguageIdentifier.labels`, code for code. */
export const ECAPA_LABELS: readonly string[] = [
  'ab', 'af', 'am', 'ar', 'as', 'az', 'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs', 'ca', 'ceb',
  'cs', 'cy', 'da', 'de', 'el', 'en', 'eo', 'es', 'et', 'eu', 'fa', 'fi', 'fo', 'fr', 'gl',
  'gn', 'gu', 'gv', 'ha', 'haw', 'hi', 'hr', 'ht', 'hu', 'hy', 'ia', 'id', 'is', 'it', 'iw',
  'ja', 'jw', 'ka', 'kk', 'km', 'kn', 'ko', 'la', 'lb', 'ln', 'lo', 'lt', 'lv', 'mg', 'mi',
  'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'ne', 'nl', 'nn', 'no', 'oc', 'pa', 'pl', 'ps',
  'pt', 'ro', 'ru', 'sa', 'sco', 'sd', 'si', 'sk', 'sl', 'sn', 'so', 'sq', 'sr', 'su', 'sv',
  'sw', 'ta', 'te', 'tg', 'th', 'tk', 'tl', 'tr', 'tt', 'uk', 'ur', 'uz', 'vi', 'war', 'yi',
  'yo', 'zh',
];

/** The shortest and longest input the graph was exported for: 0.25 s and 30 s. */
export const ECAPA_MINIMUM_SAMPLES = 4_000;
export const ECAPA_MAXIMUM_SAMPLES = 480_000;

/**
 * What the graph is handed: the first 30 s, and anything shorter than 0.25 s padded with
 * silence at the end — the Mac's `posterior(for:)`, sample for sample.
 */
export function ecapaInput(samples: Float32Array): Float32Array {
  if (samples.length > ECAPA_MAXIMUM_SAMPLES) return samples.slice(0, ECAPA_MAXIMUM_SAMPLES);
  if (samples.length >= ECAPA_MINIMUM_SAMPLES) return samples;
  const padded = new Float32Array(ECAPA_MINIMUM_SAMPLES);
  padded.set(samples);
  return padded;
}

/**
 * The graph ends in a log-softmax; exponentiated against the maximum for stability and normalised,
 * as the Swift does. Keyed by `ECAPA_LABELS`; `{}` for an output of the wrong length — "no opinion".
 */
export function posteriorFromLogp(logp: ArrayLike<number>): Record<string, number> {
  if (logp.length !== ECAPA_LABELS.length) return {};
  let top = -Infinity;
  for (let i = 0; i < logp.length; i += 1) top = Math.max(top, logp[i]!);
  const exps = Array.from({ length: logp.length }, (_, i) => Math.exp(logp[i]! - top));
  let z = 0;
  for (const e of exps) z += e;
  const posterior: Record<string, number> = {};
  ECAPA_LABELS.forEach((label, i) => {
    posterior[label] = exps[i]! / z;
  });
  return posterior;
}

/** What the classifier needs from ONNX Runtime. Injectable, so its logic is testable. */
export interface LanguageIDRuntime {
  /** 16 kHz mono in (already `ecapaInput`-shaped or not — it is applied here), 107 log-posteriors out. */
  logPosterior(samples: Float32Array): Promise<Float32Array>;
  /** `false` once the runtime can never answer again — a process that died. */
  alive?(): boolean;
  dispose(): Promise<void>;
}

export interface LanguageIDRuntimeOptions {
  /** Intra-op threads. Small on purpose — see the header. */
  readonly threads: number;
}

type OrtModule = typeof import('onnxruntime-node');

async function loadOrt(): Promise<OrtModule> {
  // A CommonJS package — the same lifting as parakeet-runtime.ts.
  const module = (await import('onnxruntime-node')) as unknown as Partial<OrtModule> & { default?: OrtModule };
  return (module.InferenceSession !== undefined ? module : module.default) as OrtModule;
}

/** Loads the session IN THIS THREAD. The host process calls this; so do the headless measurements. */
export async function loadLanguageIDRuntime(modelPath: string, options: LanguageIDRuntimeOptions): Promise<LanguageIDRuntime> {
  const ort = await loadOrt();
  const session: InferenceSession = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: Math.max(1, options.threads),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    // No spinning after a run: one pass per dictation is the whole workload (parakeet-runtime.ts).
    extra: { session: { intra_op: { allow_spinning: '0' } } },
  });
  return {
    async logPosterior(samples) {
      const input = ecapaInput(samples);
      const out = await session.run({ audio: new ort.Tensor('float32', input, [1, input.length]) });
      const logp = out['logp'];
      if (logp === undefined) throw new Error('the language-ID graph returned no `logp`');
      return Float32Array.from(logp.data as Float32Array);
    },
    async dispose() {
      await session.release();
    },
  };
}

// ---------------------------------------------------------------------------------
// The protocol, from the host process's side
// ---------------------------------------------------------------------------------

/** Main → host. */
export type LanguageIDRequest =
  | { readonly kind: 'load'; readonly modelPath: string; readonly options: LanguageIDRuntimeOptions }
  | { readonly kind: 'identify'; readonly id: number; readonly samples: Float32Array }
  | { readonly kind: 'dispose' };

/** Host → main. */
export type LanguageIDReply =
  | { readonly kind: 'loaded' }
  | { readonly kind: 'logp'; readonly id: number; readonly logp: Float32Array }
  | { readonly kind: 'error'; readonly id: number | null; readonly message: string };

/**
 * The model's side of the conversation, in `engine-host.js lid`. Strictly in order, one pass at a
 * time — the same discipline as `serveParakeet`.
 */
export function serveLanguageID(port: {
  readonly onMessage: (listener: (request: LanguageIDRequest) => void) => void;
  readonly postMessage: (reply: LanguageIDReply) => void;
  readonly close: () => void;
}): void {
  let runtime: LanguageIDRuntime | null = null;
  let queue: Promise<void> = Promise.resolve();
  const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  async function handle(request: LanguageIDRequest): Promise<void> {
    switch (request.kind) {
      case 'load':
        try {
          runtime = await loadLanguageIDRuntime(request.modelPath, request.options);
          port.postMessage({ kind: 'loaded' });
        } catch (error: unknown) {
          port.postMessage({ kind: 'error', id: null, message: describeError(error) });
        }
        return;
      case 'identify':
        if (runtime === null) {
          port.postMessage({ kind: 'error', id: request.id, message: 'the model is not loaded' });
          return;
        }
        try {
          port.postMessage({ kind: 'logp', id: request.id, logp: await runtime.logPosterior(request.samples) });
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
