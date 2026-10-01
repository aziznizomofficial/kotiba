// Parakeet's three ONNX sessions in their own OS process — what the app runs (D-W22). The
// engine sees the same `ParakeetRuntime` it gets from the worker thread; only the carrier
// differs, and with it what a native crash costs: this process, not the app.

import { EngineProcessExit, type EngineLauncher } from './engine-process.js';
import type { ParakeetRuntime, ParakeetRuntimeOptions, WorkerReply, WorkerRequest } from './parakeet-runtime.js';

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
): Promise<ParakeetRuntime> {
  const channel = launcher('parakeet');
  let dead: EngineProcessExit | null = null;
  let hello = false;
  let loaded = false;
  let disposing = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();

  return new Promise<ParakeetRuntime>((resolveLoad, rejectLoad) => {
    channel.onExit((code) => {
      if (dead !== null) return;
      dead = new EngineProcessExit('parakeet', code, !hello);
      for (const [, waiter] of pending) waiter.reject(dead);
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
      if (reply.kind === 'text') waiter.resolve(reply.text);
      else waiter.reject(new Error(reply.message));
    });

    const runtime: ParakeetRuntime = {
      transcribeSamples(samples) {
        if (dead !== null) return Promise.reject(dead);
        const id = nextId;
        nextId += 1;
        return new Promise<string>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          // Structured-cloned: the caller keeps its buffer, and 64 KB per second of audio
          // crosses in well under a millisecond (03-ENGINE-PARITY.md §13).
          channel.postMessage({ kind: 'transcribe', id, samples } satisfies WorkerRequest);
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
