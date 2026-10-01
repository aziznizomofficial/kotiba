// The modes' on-device model — Qwen3-1.7B through node-llama-cpp — the Windows twin of
// `LlamaPolisher` / `LlamaEngine` (Sources/KotibaLLM/LlamaPolisher.swift). C3 §7 is the
// recipe: the same GGUF, the same prompts, greedy, thinking off.
//
// What makes it the SAME model call as the Mac's, and each is load-bearing for "the
// Windows output matches the Mac output":
//
//   * THE PROMPT IS RAW ChatML, built by `chatML` / `turn` exactly as the Swift builds it —
//     examples as real user/assistant turns, an EMPTY `<think></think>` block on the turn
//     (Qwen3's own template with thinking switched off). node-llama-cpp's chat wrappers are
//     deliberately not used: they render Qwen3's Jinja template, which is a different byte
//     sequence from the one the Mac tokenizes.
//   * TOKENISED THE SAME WAY: the head and the turn separately, special tokens parsed, no
//     BOS added — `llama_tokenize(..., add_special: false, parse_special: true)`.
//   * GREEDY. Temperature 0; the first EOG ends it; `<|im_end|>` stripped; trimmed.
//   * PROMPT-LOOKUP SPECULATION (`InputLookupTokenPredictor`, up to 16 drafted tokens — C3
//     §5's measured best). Verification is greedy, so it changes the number of forward
//     passes and not the text.
//   * ONE CONTEXT, FOUR SEQUENCES, LRU: each distinct prompt keeps its own KV sequence, so a
//     sentence prefills only its own ~20–60 tokens. q8_0 K and V, as on the Mac.
//
// And what differs, stated: the Mac drives llama.cpp b11249 through its C API; this is the
// llama.cpp node-llama-cpp 3.22.1 ships. Greedy decoding is deterministic per build, but two
// builds (or Metal against a CPU) may break a near-tie differently — C3 §5 saw that happen
// between two runs on ONE Mac for 3 of 57 outputs. Parity is therefore measured, sentence
// by sentence, by `scripts/measure/modes-compare.mjs`, not assumed.

import type { Language } from '../contracts/index.js';
import { LANGUAGES } from '../contracts/index.js';
import type { PolishPrompt } from '../core/modes/index.js';

import type { PromptedPolisher } from './incremental.js';

type NodeLlama = typeof import('node-llama-cpp');
type Llama = import('node-llama-cpp').Llama;
type LlamaModel = import('node-llama-cpp').LlamaModel;
type LlamaContext = import('node-llama-cpp').LlamaContext;
type LlamaContextSequence = import('node-llama-cpp').LlamaContextSequence;
type Token = import('node-llama-cpp').Token;

/** ChatML with the examples as real turns. `LlamaEngine.chatML`. */
export function chatML(prompt: PolishPrompt): string {
  let s = `<|im_start|>system\n${prompt.system}<|im_end|>\n`;
  for (const example of prompt.examples) {
    s += `<|im_start|>user\n${example.input}<|im_end|>\n`;
    s += `<|im_start|>assistant\n${example.output}<|im_end|>\n`;
  }
  return s;
}

/** One user turn and an empty thinking block — thinking off. `LlamaEngine.turn`. */
export function turn(input: string): string {
  return `<|im_start|>user\n${input}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

/**
 * The chat markup the loaded GGUF was trained on (the Mac's `LlamaEngine.ChatFormat`): Qwen's
 * ChatML, or Gemma 4's turns for the Arabic modes model (C4 §14.5). By `general.architecture`.
 */
export type ChatFormat = 'chatML' | 'gemma4';

export function chatFormat(architecture: string): ChatFormat {
  return architecture.startsWith('gemma4') || architecture.startsWith('gemma3n') ? 'gemma4' : 'chatML';
}

/** Gemma 4's own markup, thinking off: a system turn, examples as real turns. `LlamaEngine.gemma4`. */
export function gemma4(prompt: PolishPrompt): string {
  let s = `<bos><|turn>system\n${prompt.system}<turn|>\n`;
  for (const example of prompt.examples) {
    s += `<|turn>user\n${example.input}<turn|>\n`;
    s += `<|turn>model\n${example.output}<turn|>\n`;
  }
  return s;
}

/** One user turn and the opening of Gemma 4's reply. */
export function gemma4Turn(input: string): string {
  return `<|turn>user\n${input}<turn|>\n<|turn>model\n`;
}

/** Context shared by every cached prompt. */
export const CONTEXT_TOKENS = 4096;
export const MAX_SEQUENCES = 4;
export const BATCH_TOKENS = 512;
/** Drafted tokens per pass. 0 → 200/483, 8 → 119/242, 16 → 106/189, 32 → 113/226 ms (C3 §5). */
export const DRAFT_TOKENS = 16;

export interface LlamaPolisherOptions {
  /** Resolved when the model is needed, so a download that lands later is picked up. */
  readonly modelPath: () => Promise<string | null>;
  readonly id?: string;
  readonly languages?: ReadonlySet<Language>;
  /** The Mac's 180 s: the idle-RAM lesson from the whisper contexts applies here too. */
  readonly idleUnloadMs?: number | null;
  /** CPU threads. See `resolveLlamaThreads`. */
  readonly threads?: number;
  /** `'auto'` picks CUDA, Vulkan, Metal or the CPU, whichever the machine and the package have. */
  readonly gpu?: 'auto' | false;
  readonly draftTokens?: number;
  readonly onNote?: (note: string) => void;
  /** Told when the weights are loaded or given back — the host process mirrors it to main. */
  readonly onLoadedChange?: (loaded: boolean) => void;
  /** Injected by the tests. */
  readonly loadLibrary?: () => Promise<NodeLlama>;
}

/** Timings of the last generation, for the probe. */
export interface LlamaRun {
  readonly promptTokens: number;
  readonly prefilled: number;
  readonly generated: number;
  readonly prefillMs: number;
  readonly generateMs: number;
}

/**
 * CPU threads for generation: the physical-core estimate (see `resolveOrtThreads`), capped
 * at 8. The Mac uses `activeProcessorCount - 2`, which on Apple silicon counts physical
 * cores; on a Windows laptop the logical count includes SMT siblings and E-cores.
 */
export function resolveLlamaThreads(logicalProcessors: number): number {
  const logical = Number.isFinite(logicalProcessors) && logicalProcessors > 0 ? Math.floor(logicalProcessors) : 4;
  const cores = logical <= 2 ? logical : Math.floor(logical / 2);
  return Math.max(1, Math.min(8, cores));
}

interface Slot {
  readonly key: string;
  readonly sequence: LlamaContextSequence;
  lastUse: number;
}

interface Loaded {
  readonly library: NodeLlama;
  readonly llama: Llama;
  readonly model: LlamaModel;
  readonly context: LlamaContext;
  readonly path: string;
  readonly format: ChatFormat;
}

export class LlamaPolisher implements PromptedPolisher {
  readonly id: string;
  readonly supportedLanguages: ReadonlySet<Language>;
  private readonly options: LlamaPolisherOptions;
  private loaded: Loaded | null = null;
  private loading: Promise<Loaded> | null = null;
  private slots = new Map<string, Slot>();
  private uses = 0;
  /** One generation at a time: a llama.cpp context is not re-entrant. */
  private queue: Promise<unknown> = Promise.resolve();
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  last: LlamaRun | null = null;

  constructor(options: LlamaPolisherOptions) {
    this.options = options;
    this.id = options.id ?? 'qwen3-1.7b';
    this.supportedLanguages = options.languages ?? new Set(LANGUAGES);
  }

  get isLoaded(): boolean {
    return this.loaded !== null;
  }

  private note(text: string): void {
    this.options.onNote?.(`llama: ${text}`);
  }

  private serialised<T>(body: () => Promise<T>): Promise<T> {
    const job = this.queue.then(body, body);
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async load(): Promise<Loaded> {
    if (this.loaded !== null) return this.loaded;
    if (this.loading !== null) return this.loading;
    this.loading = (async () => {
      const path = await this.options.modelPath();
      if (path === null) throw new Error('no polish model is installed');
      const t0 = performance.now();
      const library = await (this.options.loadLibrary ?? (() => import('node-llama-cpp')))();
      const llama = await library.getLlama({
        gpu: this.options.gpu ?? 'auto',
        // Prebuilt binaries only. A source build needs cmake and a compiler, and on a
        // user's machine that is a multi-minute failure nobody can see.
        build: 'never',
        logLevel: library.LlamaLogLevel.error,
        logger: () => undefined,
        progressLogs: false,
      });
      const model = await llama.loadModel({ modelPath: path, gpuLayers: 'max' });
      const context = await model.createContext({
        contextSize: CONTEXT_TOKENS,
        sequences: MAX_SEQUENCES,
        batchSize: BATCH_TOKENS,
        flashAttention: 'auto',
        experimentalKvCacheKeyType: 'Q8_0',
        experimentalKvCacheValueType: 'Q8_0',
        ...(this.options.threads === undefined ? {} : { threads: this.options.threads }),
      });
      const architecture = String(
        (model.fileInfo.metadata as { general?: { architecture?: unknown } } | undefined)?.general?.architecture ?? '',
      );
      const loaded: Loaded = { library, llama, model, context, path, format: chatFormat(architecture) };
      this.loaded = loaded;
      this.slots = new Map();
      this.note(`loaded ${path} in ${Math.round(performance.now() - t0)} ms on ${llama.gpu === false ? 'the CPU' : llama.gpu}`);
      this.options.onLoadedChange?.(true);
      return loaded;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private scheduleUnload(): void {
    const after = this.options.idleUnloadMs === undefined ? 180_000 : this.options.idleUnloadMs;
    if (after === null) return;
    if (this.unloadTimer !== null) clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      void this.serialised(() => this.release());
    }, after);
    this.unloadTimer.unref?.();
  }

  /** Free the weights now. The engine reloads on next use. */
  unload(): Promise<void> {
    return this.serialised(() => this.release());
  }

  private async release(): Promise<void> {
    const loaded = this.loaded;
    this.loaded = null;
    this.slots = new Map();
    if (loaded === null) return;
    await loaded.context.dispose().catch(() => undefined);
    await loaded.model.dispose().catch(() => undefined);
    this.note('unloaded');
    this.options.onLoadedChange?.(false);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.unloadTimer !== null) clearTimeout(this.unloadTimer);
    await this.unload();
  }

  /** The sequence holding this prompt, evicting the least recently used when all are taken. */
  private async slotFor(loaded: Loaded, prompt: PolishPrompt): Promise<Slot> {
    const key = JSON.stringify(prompt);
    this.uses += 1;
    const existing = this.slots.get(key);
    if (existing !== undefined) {
      existing.lastUse = this.uses;
      return existing;
    }
    let sequence: LlamaContextSequence | null = null;
    if (loaded.context.sequencesLeft > 0) {
      sequence = loaded.context.getSequence({
        tokenPredictor: new loaded.library.InputLookupTokenPredictor({
          predictionLength: { max: this.options.draftTokens ?? DRAFT_TOKENS },
        }),
      });
    } else {
      let victim: Slot | null = null;
      for (const slot of this.slots.values()) if (victim === null || slot.lastUse < victim.lastUse) victim = slot;
      if (victim === null) throw new Error('no llama sequence is free');
      this.slots.delete(victim.key);
      await victim.sequence.clearHistory();
      sequence = victim.sequence;
    }
    const slot: Slot = { key, sequence, lastUse: this.uses };
    this.slots.set(key, slot);
    return slot;
  }

  /**
   * Bring the slot's KV up to `tokens`, reusing the common prefix, and return what is left
   * to evaluate. At least one token is always left, because its logits are what the first
   * generated token comes from.
   */
  private async sync(slot: Slot, tokens: readonly Token[]): Promise<Token[]> {
    const have = slot.sequence.contextTokens;
    let common = 0;
    while (common < have.length && common < tokens.length && have[common] === tokens[common]) common += 1;
    if (common === tokens.length) common = Math.max(0, common - 1);
    if (common < have.length) {
      await slot.sequence.eraseContextTokenRanges([{ start: common, end: have.length }]);
    }
    return tokens.slice(common);
  }

  async prepare(prompts: readonly PolishPrompt[]): Promise<void> {
    if (this.disposed) return;
    await this.serialised(async () => {
      const loaded = await this.load();
      for (const prompt of prompts) {
        const slot = await this.slotFor(loaded, prompt);
        const tokens = loaded.model.tokenize(loaded.format === 'gemma4' ? gemma4(prompt) : chatML(prompt), true);
        const have = slot.sequence.contextTokens;
        let common = 0;
        while (common < have.length && common < tokens.length && have[common] === tokens[common]) common += 1;
        if (common < have.length) {
          await slot.sequence.eraseContextTokenRanges([{ start: common, end: have.length }]);
        }
        // The WHOLE head, as the Mac's `prefill` does: `generate` then evaluates only the
        // user turn. Leaving the head's last token for later changes the batch the turn is
        // evaluated in, which is enough to flip a near-tie — measured: one Uzbek note
        // heading came out different until this matched the Mac.
        if (common < tokens.length) await slot.sequence.evaluateWithoutGeneratingNewTokens(tokens.slice(common));
      }
      this.scheduleUnload();
    }).catch((error: unknown) => {
      this.note(`prefill failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  generate(
    text: string,
    _language: Language,
    prompt: PolishPrompt,
    maxOutputTokens: number,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('the polish model was shut down'));
    return this.serialised(async () => {
      if (signal.aborted) throw new Error('cancelled');
      const loaded = await this.load();
      try {
        const t0 = performance.now();
        const head = loaded.model.tokenize(loaded.format === 'gemma4' ? gemma4(prompt) : chatML(prompt), true);
        const user = loaded.model.tokenize(loaded.format === 'gemma4' ? gemma4Turn(text) : turn(text), true);
        const tokens = [...head, ...user];
        if (tokens.length + maxOutputTokens >= CONTEXT_TOKENS - 8) {
          throw new Error(`sentence needs ${tokens.length + maxOutputTokens} tokens, context holds ${CONTEXT_TOKENS}`);
        }
        const slot = await this.slotFor(loaded, prompt);
        const rest = await this.sync(slot, tokens);
        const prefilled = rest.length;

        const output: Token[] = [];
        let firstAt = 0;
        for await (const token of slot.sequence.evaluate(rest, { temperature: 0 })) {
          if (firstAt === 0) firstAt = performance.now();
          if (signal.aborted) throw new Error('cancelled');
          if (loaded.model.isEogToken(token)) break;
          output.push(token);
          if (output.length >= maxOutputTokens) break;
        }
        const done = performance.now();
        this.last = {
          promptTokens: tokens.length,
          prefilled,
          generated: output.length,
          prefillMs: (firstAt === 0 ? done : firstAt) - t0,
          generateMs: firstAt === 0 ? 0 : done - firstAt,
        };
        return loaded.model.detokenize(output, false).split('<|im_end|>').join('').split('<turn|>').join('').trim();
      } finally {
        this.scheduleUnload();
      }
    });
  }
}
