// Qwen3-1.7B in its own OS process — what the app holds for the modes (D-W22).
//
// WHY. `LlamaPolisher` in the Electron main process stalled it at key-down: the key-down
// `prepare` imports node-llama-cpp, loads its native addon and backends, maps the 1.28 GB GGUF
// and tokenises the prompts, and parts of that are synchronous — measured in
// 03-ENGINE-PARITY.md §13 (`scripts/measure/engine-stall.mjs`). That is the main loop the
// hotkey's key-up, the pill and the previous dictation's paste wait behind. And a native crash
// inside llama.cpp ended the app. Here the model runs in `engine-host.js llama`; main only
// posts messages, and a crash costs the sentences in flight their model — each is delivered in
// its deterministic form, as for any failed sentence — and the next dictation starts a new
// process.
//
// The same `PromptedPolisher` surface as `LlamaPolisher`, plus what the shell reads
// (`isLoaded`, `unload`, `dispose`, `last`), so nothing above it knows the difference.

import type { Language } from '../contracts/index.js';
import { LANGUAGES } from '../contracts/index.js';
import type { PolishPrompt } from '../core/modes/index.js';
import { CrashLimiter, EngineProcessExit, type EngineChannel, type EngineLauncher } from '../engines/engine-process.js';

import type { PromptedPolisher } from './incremental.js';
import type { LlamaRun } from './llama.js';
import type { LlamaHostConfig, LlamaHostReply, LlamaHostRequest } from './llama-host.js';

/** What the shell needs from the modes' model, wherever it runs. `LlamaPolisher` fits too. */
export interface ModesModel extends PromptedPolisher {
  readonly isLoaded: boolean;
  unload(): Promise<void>;
  dispose(): Promise<void>;
}

export interface RemoteLlamaOptions {
  readonly launcher: EngineLauncher;
  /** Resolved in main per request, so a download that lands later is picked up. */
  readonly modelPath: () => Promise<string | null>;
  readonly config?: LlamaHostConfig;
  readonly onNote?: (note: string) => void;
  /**
   * Built when the host process cannot START at all (a packaging fault, not a crash): the
   * in-process `LlamaPolisher`, so the modes keep their model at the old cost.
   */
  readonly fallback?: () => ModesModel;
  /** The languages it claims: Arabic only for the Arabic modes model (C4 §14.5). Absent: all. */
  readonly languages?: ReadonlySet<Language>;
  readonly crashLimiter?: CrashLimiter;
}

interface Waiter {
  resolve(reply: { text: string | null; run: LlamaRun | null }): void;
  reject(error: Error): void;
}

interface Host {
  readonly channel: EngineChannel;
  readonly pending: Map<number, Waiter>;
  hello: boolean;
  dead: EngineProcessExit | null;
  disposing: boolean;
}

export class RemoteLlamaPolisher implements ModesModel {
  readonly id: string;
  readonly supportedLanguages: ReadonlySet<Language>;
  last: LlamaRun | null = null;
  private readonly options: RemoteLlamaOptions;
  private readonly crashes: CrashLimiter;
  private host: Host | null = null;
  private loaded = false;
  private nextId = 1;
  private disposed = false;
  private fallback: ModesModel | null = null;

  constructor(options: RemoteLlamaOptions) {
    this.options = options;
    this.id = options.config?.id ?? 'qwen3-1.7b';
    this.supportedLanguages = options.languages ?? new Set(LANGUAGES);
    this.crashes = options.crashLimiter ?? new CrashLimiter();
  }

  get isLoaded(): boolean {
    return this.fallback?.isLoaded ?? this.loaded;
  }

  /** The engine process's id while one runs. For the diagnostics and the tests. */
  get pid(): number | undefined {
    return this.host?.dead === null ? this.host.channel.pid : undefined;
  }

  private note(text: string): void {
    this.options.onNote?.(`llama: ${text}`);
  }

  /** The running host, starting one if there is none — the automatic restart after a crash. */
  private ensureHost(): Host {
    if (this.host !== null && this.host.dead === null) return this.host;
    if (!this.crashes.mayStart()) {
      throw new Error(
        `the modes model crashed ${this.crashes.recent()} times in the last few minutes; ` +
          'the modes run on their rules until Kotiba restarts',
      );
    }
    const channel = this.options.launcher('llama');
    const host: Host = { channel, pending: new Map(), hello: false, dead: null, disposing: false };
    this.host = host;
    channel.onMessage((message) => this.onReply(host, message as LlamaHostReply));
    channel.onExit((code) => this.onExit(host, code));
    if (this.options.config !== undefined) channel.postMessage({ kind: 'configure', config: this.options.config } satisfies LlamaHostRequest);
    return host;
  }

  private onReply(host: Host, reply: LlamaHostReply): void {
    switch (reply.kind) {
      case 'hello':
        host.hello = true;
        return;
      case 'loaded':
        this.loaded = reply.loaded;
        return;
      case 'note':
        this.options.onNote?.(reply.text);
        return;
      case 'done': {
        const waiter = host.pending.get(reply.id);
        host.pending.delete(reply.id);
        if (reply.run !== null) this.last = reply.run;
        waiter?.resolve({ text: reply.text, run: reply.run });
        return;
      }
      case 'error': {
        const waiter = host.pending.get(reply.id);
        host.pending.delete(reply.id);
        waiter?.reject(new Error(reply.message));
        return;
      }
    }
  }

  private onExit(host: Host, code: number | null): void {
    const exit = new EngineProcessExit('llama', code, !host.hello);
    host.dead = exit;
    if (this.host === host) this.loaded = false;
    for (const [, waiter] of host.pending) waiter.reject(exit);
    host.pending.clear();
    if (host.disposing) return;
    if (exit.beforeReady && this.options.fallback !== undefined && this.fallback === null) {
      this.note(`${exit.message}; running the model in the app's own process instead`);
      this.fallback = this.options.fallback();
      return;
    }
    this.crashes.crashed();
    this.note(`${exit.message} — the next dictation starts it again`);
  }

  private request(build: (id: number) => LlamaHostRequest): Promise<{ text: string | null; run: LlamaRun | null }> {
    const host = this.ensureHost();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      host.pending.set(id, { resolve, reject });
      host.channel.postMessage(build(id));
    });
  }

  async prepare(prompts: readonly PolishPrompt[]): Promise<void> {
    if (this.disposed) return;
    if (this.fallback !== null) return this.fallback.prepare?.(prompts);
    const modelPath = await this.options.modelPath();
    if (modelPath === null) return;
    try {
      await this.request((id) => ({ kind: 'prepare', id, modelPath, prompts: [...prompts] }));
    } catch (error: unknown) {
      // A prefill that failed costs nothing but its speed; the next generate tries again.
      this.note(`prefill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async generate(
    text: string,
    language: Language,
    prompt: PolishPrompt,
    maxOutputTokens: number,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.disposed) throw new Error('the polish model was shut down');
    if (this.fallback !== null) return this.fallback.generate(text, language, prompt, maxOutputTokens, signal);
    if (signal.aborted) throw new Error('cancelled');
    const modelPath = await this.options.modelPath();
    if (modelPath === null) throw new Error('no polish model is installed');
    // Asked AGAIN after the await: an abort that landed while the path was being located
    // fired before the listener below existed, and the host would then generate the whole
    // sentence nobody is waiting for, ahead of the next one in its queue.
    if (signal.aborted) throw new Error('cancelled');
    let requestId = 0;
    const onAbort = (): void => {
      this.host?.channel.postMessage({ kind: 'abort', id: requestId } satisfies LlamaHostRequest);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const reply = await this.request((id) => {
        requestId = id;
        return { kind: 'generate', id, modelPath, text, language, prompt, maxOutputTokens };
      });
      return reply.text ?? '';
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async unload(): Promise<void> {
    if (this.fallback !== null) return this.fallback.unload();
    if (this.host === null || this.host.dead !== null) return;
    await this.request((id) => ({ kind: 'unload', id })).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.fallback?.dispose();
    const host = this.host;
    if (host === null || host.dead !== null) return;
    host.disposing = true;
    const exited = new Promise<void>((resolve) => host.channel.onExit(() => resolve()));
    host.channel.postMessage({ kind: 'dispose' } satisfies LlamaHostRequest);
    const timer = setTimeout(() => host.channel.kill(), 2000);
    await exited;
    clearTimeout(timer);
  }
}
