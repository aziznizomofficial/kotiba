// Parakeet's three ONNX sessions in their own OS process — what the app runs (D-W22). The
// engine sees the same `ParakeetRuntime` it gets from the worker thread; only the carrier
// differs, and with it what a native crash costs: this process, not the app.

import { EngineProcessExit, type EngineLauncher } from './engine-process.js';
import type { ParakeetRuntime, ParakeetRuntimeOptions, WorkerReply, WorkerRequest } from './parakeet-runtime.js';

/**
 * How long one decode may take before the process is presumed hung: a floor, plus two seconds per
 * second of audio. A laptop CPU decodes a 14 s window in ~0.2–0.8 s and a minute in ~2–5 s, so
 * nothing slow is mistaken for it. What it ends is the case that had no end: a decode that never
 * answers held `ParakeetEngine`'s queue, so every later English and Russian dictation waited
 * behind it for good. The process is killed — the next dictation starts a fresh one, counted by
 * the crash limiter like any other death.
 */
export const PARAKEET_REQUEST_TIMEOUT_MS = 30_000;

export function parakeetRequestTimeoutMs(samples: number, floorMs: number = PARAKEET_REQUEST_TIMEOUT_MS): number {
  return floorMs + Math.ceil((samples / 16_000) * 2_000);
}

/** What the host says first, before any model is touched. Proves the process can start at all. */
export interface HostHello {
  readonly kind: 'hello';
  readonly pid: number;
}

/**
 * Start a host process, load the bundle in it, and resolve once the three sessions are loaded.
 * Rejects with `EngineProcessExit` when the process dies — `beforeReady` when it never said
 * hello, which is the launcher failing rather than the model.
 */
export function startParakeetProcess(
  directory: string,
  options: ParakeetRuntimeOptions,
  launcher: EngineLauncher,
  onExit?: (exit: EngineProcessExit) => void,
  requestTimeoutMs: number = PARAKEET_REQUEST_TIMEOUT_MS,
): Promise<ParakeetRuntime> {
  const channel = launcher('parakeet');
  let dead: EngineProcessExit | null = null;
  let hello = false;
  let loaded = false;
  let disposing = false;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  return new Promise<ParakeetRuntime>((resolveLoad, rejectLoad) => {
    channel.onExit((code) => {
      if (dead !== null) return;
      dead = new EngineProcessExit('parakeet', code, !hello);
      for (const [, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(dead);
      }
      pending.clear();
      if (!loaded) rejectLoad(dead);
      else if (!disposing) onExit?.(dead);
    });
    channel.onMessage((message) => {
      const reply = message as WorkerReply | HostHello;
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
      clearTimeout(waiter.timer);
      if (reply.kind === 'text') waiter.resolve(reply.text);
      else waiter.reject(new Error(reply.message));
    });

    const runtime: ParakeetRuntime = {
      transcribeSamples(samples, script = null) {
        if (dead !== null) return Promise.reject(dead);
        const id = nextId;
        nextId += 1;
        return new Promise<string>((resolve, reject) => {
          const limit = parakeetRequestTimeoutMs(samples.length, requestTimeoutMs);
          const timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            reject(new Error(`the parakeet engine did not answer within ${Math.round(limit / 1000)} s — restarting it`));
            // Hung, not slow: end it, so the queue behind this decode is freed and the next
            // dictation loads a fresh process. Its exit is reported like any other death.
            channel.kill();
          }, limit);
          timer.unref?.();
          pending.set(id, { resolve, reject, timer });
          // Structured-cloned: the caller keeps its buffer, and 64 KB per second of audio
          // crosses in well under a millisecond (03-ENGINE-PARITY.md §13). A VIEW is cloned with
          // its whole backing buffer, though — key-up's tail is `subarray(committed)` of the full
          // recording, which after a 30-minute hold is 115 MB — so a view is copied down first.
          const exact = samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength ? samples : samples.slice();
          channel.postMessage({ kind: 'transcribe', id, samples: exact, script } satisfies WorkerRequest);
        });
      },
      alive: () => dead === null,
      async dispose() {
        if (dead !== null) return;
        disposing = true;
        const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));
        channel.postMessage({ kind: 'dispose' } satisfies WorkerRequest);
        // The host releases its sessions and exits; the kill is the backstop.
        const timer = setTimeout(() => channel.kill(), 2000);
        await exited;
        clearTimeout(timer);
      },
    };
    channel.postMessage({ kind: 'load', directory, options } satisfies WorkerRequest);
  });
}
