// The modes' model on the far side of a process boundary: the wire, and the host's half of it.
//
// `RemoteLlamaPolisher` (./remote-llama.ts) is what the app holds; this file is what runs in
// `engine-host.js`: one ordinary `LlamaPolisher`, driven by messages. Everything that makes the
// model call the Mac's — the ChatML, the tokenisation, greedy decoding, the four cached
// sequences — is that class, unchanged; the process only moves WHERE it runs.

import type { Language } from '../contracts/index.js';
import type { PolishPrompt } from '../core/modes/index.js';

import { LlamaPolisher, type LlamaPolisherOptions, type LlamaRun } from './llama.js';

/** What a host is configured with once, before any request. Plain data: it is cloned. */
export interface LlamaHostConfig {
  readonly id?: string;
  readonly threads?: number;
  readonly gpu?: 'auto' | false;
  readonly draftTokens?: number;
  readonly idleUnloadMs?: number | null;
}

/** Main → host. `modelPath` rides on each request: main resolves it, the host never looks. */
export type LlamaHostRequest =
  | { readonly kind: 'configure'; readonly config: LlamaHostConfig }
  | { readonly kind: 'prepare'; readonly id: number; readonly modelPath: string; readonly prompts: readonly PolishPrompt[] }
  | {
      readonly kind: 'generate';
      readonly id: number;
      readonly modelPath: string;
      readonly text: string;
      readonly language: Language;
      readonly prompt: PolishPrompt;
      readonly maxOutputTokens: number;
    }
  | { readonly kind: 'abort'; readonly id: number }
  | { readonly kind: 'unload'; readonly id: number }
  | { readonly kind: 'dispose' };

/** Host → main. */
export type LlamaHostReply =
  | { readonly kind: 'hello'; readonly pid: number }
  | { readonly kind: 'done'; readonly id: number; readonly text: string | null; readonly run: LlamaRun | null }
  | { readonly kind: 'error'; readonly id: number; readonly message: string }
  | { readonly kind: 'loaded'; readonly loaded: boolean }
  | { readonly kind: 'note'; readonly text: string };

/** Serve one `LlamaPolisher` over `port`. Returns when set up; the port keeps it alive. */
export function serveLlama(port: {
  readonly onMessage: (listener: (request: LlamaHostRequest) => void) => void;
  readonly postMessage: (reply: LlamaHostReply) => void;
  readonly close: () => void;
  /** Injected by the tests. */
  readonly loadLibrary?: LlamaPolisherOptions['loadLibrary'];
}): void {
  let modelPath: string | null = null;
  let polisher: LlamaPolisher | null = null;
  const aborts = new Map<number, AbortController>();
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const build = (config: LlamaHostConfig): LlamaPolisher =>
    new LlamaPolisher({
      modelPath: async () => modelPath,
      ...(config.id === undefined ? {} : { id: config.id }),
      ...(config.threads === undefined ? {} : { threads: config.threads }),
      ...(config.gpu === undefined ? {} : { gpu: config.gpu }),
      ...(config.draftTokens === undefined ? {} : { draftTokens: config.draftTokens }),
      ...(config.idleUnloadMs === undefined ? {} : { idleUnloadMs: config.idleUnloadMs }),
      onNote: (text) => port.postMessage({ kind: 'note', text }),
      onLoadedChange: (loaded) => port.postMessage({ kind: 'loaded', loaded }),
      ...(port.loadLibrary === undefined ? {} : { loadLibrary: port.loadLibrary }),
    });
  const engine = (): LlamaPolisher => {
    polisher ??= build({});
    return polisher;
  };

  port.onMessage((request) => {
    switch (request.kind) {
      case 'configure':
        polisher ??= build(request.config);
        return;
      case 'prepare':
        modelPath = request.modelPath;
        // `prepare` never throws — a failed prefill is a note, and the next generate retries.
        void engine()
          .prepare(request.prompts)
          .then(() => port.postMessage({ kind: 'done', id: request.id, text: null, run: null }));
        return;
      case 'generate': {
        modelPath = request.modelPath;
        const abort = new AbortController();
        aborts.set(request.id, abort);
        const polish = engine();
        void polish
          .generate(request.text, request.language, request.prompt, request.maxOutputTokens, abort.signal)
          .then(
            (text) => port.postMessage({ kind: 'done', id: request.id, text, run: polish.last }),
            (error: unknown) => port.postMessage({ kind: 'error', id: request.id, message: describe(error) }),
          )
          .finally(() => aborts.delete(request.id));
        return;
      }
      case 'abort':
        aborts.get(request.id)?.abort();
        return;
      case 'unload':
        void engine()
          .unload()
          .then(() => port.postMessage({ kind: 'done', id: request.id, text: null, run: null }));
        return;
      case 'dispose':
        void (polisher?.dispose() ?? Promise.resolve()).finally(() => port.close());
        return;
    }
  });
}
