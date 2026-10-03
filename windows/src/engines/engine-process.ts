// The on-device engines in their OWN OS PROCESS — the channel, the launchers, and the rule for
// how often a crashing engine is restarted.
//
// WHY A PROCESS AND NOT A THREAD (1.0 follow-up, docs/windows/00-DECISIONS.md D-W22). ONNX
// Runtime (Parakeet) and llama.cpp (Qwen3-1.7B) are native code. In a `worker_threads` worker a
// segfault, an abort() or an out-of-memory kill inside either takes the WHOLE Electron main
// process with it — the hotkey, the tray, the pill and the dictation in flight — and the D-W16
// watchdog then relaunches the app. In a separate process the same crash costs one dictation's
// fast path: the family falls back to whisper, the modes to their rules, and the next use
// starts a fresh engine process.
//
// The cost is the IPC, and it is small: a 16 kHz mono Float32Array is 64 KB per second of
// audio, structured-cloned. Measured with `scripts/measure/engine-ipc.mjs` (numbers in
// 03-ENGINE-PARITY.md §13).
//
// TWO LAUNCHERS, ONE CHANNEL. The app runs the host in an Electron `utilityProcess` (built in
// `src/main/utility-launcher.ts` — only `src/main` may import electron) and plain Node — the
// tests, the headless measurements — uses `child_process.fork` with structured-clone
// serialisation. Both are an `EngineChannel`, and the host script cannot tell them apart except
// through `hostPort()`.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Main's end of one engine process. */
export interface EngineChannel {
  /** Structured-cloned. A typed array crosses as a copy. */
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Once, however the process ended — a clean exit, a kill, or a native crash. */
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
  readonly pid: number | undefined;
}

/** Starts `engine-host.js` for one role. */
export type EngineLauncher = (role: EngineRole) => EngineChannel;

/** `lid`: the language-ID model (P4, `language-id.ts`) — ONNX Runtime like Parakeet, its own process. */
export type EngineRole = 'parakeet' | 'llama' | 'arabic' | 'lid';

/**
 * The host script's path. NOT redirected to `app.asar.unpacked`: the host imports
 * node-llama-cpp's JavaScript, which lives inside the archive, and a process started from the
 * unpacked copy would resolve packages beside IT, where only the native binaries are. Electron's
 * utility process reads asar like the main process does; the `.node` addons are redirected to
 * the unpacked copy by Electron itself (`asarUnpack` in electron-builder.yml).
 */
export function engineHostPath(): string {
  return fileURLToPath(new URL('./engine-host.js', import.meta.url));
}

/**
 * `child_process.fork` — plain Node, and the tests. `advanced` serialisation is the structured
 * clone `utilityProcess` uses, so a Float32Array arrives as a Float32Array on both.
 *
 * Inside Electron's main process `process.execPath` is Electron itself, so the child is told to
 * behave as Node (`ELECTRON_RUN_AS_NODE`) — never used by the app, which has the utility
 * launcher, but it keeps this launcher honest if someone runs it there.
 */
export function forkLauncher(
  scriptPath: string = engineHostPath(),
  options: {
    /** Node flags for the child — the tests register a loader that runs the `.ts` sources. */
    readonly execArgv?: readonly string[];
    /** Appended after the role. Asked per launch, so a test can vary what each start does. */
    readonly extraArgs?: (role: EngineRole) => readonly string[];
  } = {},
): EngineLauncher {
  return (role) => {
    const child = fork(scriptPath, [role, ...(options.extraArgs?.(role) ?? [])], {
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [...(options.execArgv ?? [])],
    });
    let exited = false;
    const exitListeners: ((code: number | null) => void)[] = [];
    const finish = (code: number | null): void => {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener(code);
    };
    child.on('exit', (code) => finish(code));
    child.on('error', () => finish(null));
    return {
      postMessage(message) {
        if (!exited && child.connected) child.send(message as never);
      },
      onMessage(listener) {
        child.on('message', listener);
      },
      onExit(listener) {
        if (exited) listener(null);
        else exitListeners.push(listener);
      },
      kill() {
        if (!exited) child.kill();
      },
      get pid() {
        return child.pid;
      },
    };
  };
}

/** The host's end: Electron's `process.parentPort`, or Node's `process.send`. */
export interface HostPort {
  onMessage(listener: (message: unknown) => void): void;
  postMessage(message: unknown): void;
}

interface ElectronParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

export function hostPort(): HostPort {
  const parentPort = (process as unknown as { parentPort?: ElectronParentPort }).parentPort;
  if (parentPort !== undefined) {
    return {
      onMessage: (listener) => parentPort.on('message', (event) => listener(event.data)),
      postMessage: (message) => parentPort.postMessage(message),
    };
  }
  if (process.send === undefined) throw new Error('engine-host.js runs only as a child process');
  return {
    onMessage: (listener) => process.on('message', listener),
    postMessage: (message) => process.send?.(message as never),
  };
}

// ---------------------------------------------------------------------------------
// How often a crashing engine is started again
// ---------------------------------------------------------------------------------

/**
 * Restart on the next use, automatically — but not forever. A model that crashes the process
 * on every load would otherwise cost a process spawn and a failed load per key-press, for the
 * rest of the session. Three crashes in five minutes and that engine stays down until Kotiba
 * restarts; what it served falls back (whisper for English and Russian, the rules for the
 * modes), and the diagnostics say why.
 */
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 5 * 60_000;

export class CrashLimiter {
  private readonly crashes: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { readonly limit?: number; readonly windowMs?: number; readonly now?: () => number } = {}) {
    this.limit = options.limit ?? CRASH_LIMIT;
    this.windowMs = options.windowMs ?? CRASH_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Record one crash. */
  crashed(): void {
    this.crashes.push(this.now());
  }

  /** How many crashes fall inside the window right now. */
  recent(): number {
    const since = this.now() - this.windowMs;
    while (this.crashes.length > 0 && (this.crashes[0] ?? 0) < since) this.crashes.shift();
    return this.crashes.length;
  }

  /** False once the engine has crashed `limit` times inside the window. */
  mayStart(): boolean {
    return this.recent() < this.limit;
  }
}

/** A process that ended without being asked to. `code` is null for a signal or a crash. */
export class EngineProcessExit extends Error {
  readonly code: number | null;
  /** True when it died before it ever answered — the launcher, not the engine, is broken. */
  readonly beforeReady: boolean;

  constructor(role: EngineRole, code: number | null, beforeReady: boolean) {
    super(
      `the ${role} engine process ${beforeReady ? 'could not start' : 'stopped'}` +
        (code === null ? ' (crashed)' : ` (exit code ${code})`),
    );
    this.name = 'EngineProcessExit';
    this.code = code;
    this.beforeReady = beforeReady;
  }
}
