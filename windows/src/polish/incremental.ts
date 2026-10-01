// Polish while the user is still talking — a port of `IncrementalPolish` and `ModePolisher`
// (Sources/KotibaCore/IncrementalPolish.swift, ModePolisher.swift).
//
// Measured before this existed (C3 §0): polish was the single largest latency item, median
// 1,615 ms and p90 3,687 ms after key-release, because the whole dictation went to a model
// only once the key came up. So each sentence is polished the moment the transcriber
// commits it, in the background, and at release only the sentence still being spoken
// remains:
//
//     commit("First sentence. Second")   → "First sentence." polishing now
//     commit(" sentence. Third")         → "Second sentence." queued behind it
//     finish(" sentence")                → "Third sentence." — the only work left
//
// Three properties are load-bearing, all three copied from the Swift:
//
//   * PER-SENTENCE FALLBACK. Every sentence carries its deterministic form, and that is
//     what is delivered if the model is slow, fails, or is refused by a guard — for that
//     sentence alone.
//   * ONE ENGINE, IN ORDER. A single llama.cpp context cannot run two generations at once,
//     and sentence order is output order, so jobs are chained: each waits for the one
//     before. The chain is assigned before the first suspension point, so two commits
//     cannot read the same predecessor.
//   * INSERT ONCE, NEVER REPLACE. The result is pasted once, after `finish`. Paste-then-
//     replace was the commonest failure on record (`polish replace refused`, 94 times).

import type { Language, Polisher } from '../contracts/index.js';
import { LANGUAGES } from '../contracts/index.js';
import {
  DROPPABLE,
  MESSAGE_BY_PROJECTION,
  OPENERS,
  SUPER_MODEL_LANGUAGES,
  SUPER_TAIL_CAP_MS,
  trimOpeners,
  acceptsHeading,
  checkRewrite,
  cleanHeading,
  durationText,
  formatWhole,
  headingPrompt,
  looksLikeTask,
  messagePrompt,
  noteClassifierPrompt,
  noteLine,
  project,
  MINIMUM_ALIGNMENT,
  renderNote,
  splitSentences,
  strippingOrdinal,
  superPrompt,
  tokenBudget,
  type ModeBehaviour,
  type NoteKind,
  type PolishPrompt,
} from '../core/modes/index.js';
import { trimWhitespaceAndNewlines } from '../core/modes/swift.js';
import { checkUzbekPolishGuard, orthographyForDelivery } from '../core/text/index.js';

/**
 * A polisher that takes a structured prompt — the on-device model. `PromptedPolishEngine`.
 *
 * `signal` is the Swift's task cancellation: a sentence abandoned at the deadline stops
 * generating instead of holding the one context for the next dictation.
 */
export interface PromptedPolisher {
  /** Recorded as part of `polishID`, e.g. `qwen3-1.7b`. */
  readonly id: string;
  readonly supportedLanguages: ReadonlySet<Language>;
  generate(
    text: string,
    language: Language,
    prompt: PolishPrompt,
    maxOutputTokens: number,
    signal: AbortSignal,
  ): Promise<string>;
  /**
   * Load the weights and pre-fill the prompts now, so the first sentence does not pay. With
   * `language`, a model made of several warms only the one that answers it.
   */
  prepare?(prompts: readonly PolishPrompt[], language?: Language): Promise<void>;
}

/** Wall clock and timers, injectable so a test can drive a deadline in microseconds. */
export interface PolishClock {
  now(): number;
  sleep(ms: number): { readonly promise: Promise<void>; cancel(): void };
}

const SYSTEM_CLOCK: PolishClock = {
  now: () => performance.now(),
  sleep(ms: number) {
    let done: (() => void) | null = null;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    const handle = setTimeout(() => done?.(), Math.max(0, ms));
    return {
      promise,
      cancel() {
        clearTimeout(handle);
        done?.();
      },
    };
  },
};

export interface PolishOutcome {
  readonly text: string;
  /** Per-sentence events worth a line in the diagnostics: fallbacks and why. */
  readonly notes: readonly string[];
  readonly sentences: number;
  /** Sentences whose model output was used. */
  readonly modelSentences: number;
  /** What `finish` spent waiting, i.e. what the user saw after release. */
  readonly tailMs: number;
}

interface SentenceResult {
  readonly text: string;
  readonly kind: NoteKind | null;
  readonly usedModel: boolean;
  readonly note: string | null;
}

interface Job {
  readonly sentence: string;
  readonly result: Promise<SentenceResult>;
  readonly abort: AbortController;
}

/** The default tail deadline: what `IncrementalPolish.finish` waits at most. */
export const TAIL_DEADLINE_MS = 1500;

export interface IncrementalPolishOptions {
  readonly behaviour: ModeBehaviour;
  readonly language: Language;
  /** `null`, or one that does not claim `language`: the deterministic layer alone. */
  readonly engine: PromptedPolisher | null;
  readonly superModelLanguages?: ReadonlySet<Language>;
  readonly clock?: PolishClock;
}

export class IncrementalPolish {
  readonly behaviour: ModeBehaviour;
  readonly language: Language;
  private readonly engine: PromptedPolisher | null;
  private readonly usesModel: boolean;
  private readonly clock: PolishClock;

  private pending = '';
  private readonly jobs: Job[] = [];
  private chain: Promise<void> = Promise.resolve();
  private heading: { readonly result: Promise<string | null>; readonly abort: AbortController } | null = null;
  private finished = false;

  constructor(options: IncrementalPolishOptions) {
    this.behaviour = options.behaviour;
    this.language = options.language;
    this.engine = options.engine;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    const claims = options.engine?.supportedLanguages.has(options.language) ?? false;
    switch (options.behaviour) {
      case 'raw':
        this.usesModel = false;
        break;
      case 'super':
        this.usesModel = claims && (options.superModelLanguages ?? SUPER_MODEL_LANGUAGES).has(options.language);
        break;
      case 'message':
        this.usesModel = claims;
        break;
      case 'note':
        this.usesModel = claims;
        break;
    }
  }

  /** The prompts this session will run, so the engine can prefill them at key-down. */
  get prompts(): readonly PolishPrompt[] {
    if (!this.usesModel) return [];
    switch (this.behaviour) {
      case 'raw':
        return [];
      case 'super':
        return [superPrompt(this.language)];
      case 'message':
        return [messagePrompt(this.language)];
      case 'note':
        return [noteClassifierPrompt(this.language), headingPrompt(this.language)];
    }
  }

  /** Warm the engine for this mode and language. Safe to skip; costs only the first sentence. */
  async prepare(): Promise<void> {
    if (!this.usesModel || this.engine?.prepare === undefined) return;
    await this.engine.prepare(this.prompts, this.language);
  }

  /**
   * Text the transcriber has committed and will not revise. Complete sentences start
   * polishing immediately; an unfinished one waits for more text or for `finish`.
   */
  commit(segment: string): void {
    if (this.finished) return;
    this.pending += segment;
    const split = splitSentences(this.pending, true);
    this.pending = split.rest;
    for (const sentence of split.sentences) this.enqueue(sentence);
    this.startHeadingIfDue(false);
  }

  /**
   * Everything after the last commit, then wait — at most `deadlineMs` — for every
   * sentence. A sentence still running at the deadline goes in its deterministic form.
   */
  async finish(tail: string, deadlineMs: number = TAIL_DEADLINE_MS): Promise<PolishOutcome> {
    const started = this.clock.now();
    // Super in a language with a cap waits for the model only that long after release
    // (`SUPER_TAIL_CAP_MS`, the Mac's `OnDeviceModes.superTailCap`, C4 §14.4).
    const cap = this.behaviour === 'super' ? SUPER_TAIL_CAP_MS[this.language] : undefined;
    const until = started + (cap === undefined ? deadlineMs : Math.min(deadlineMs, cap));
    if (!this.finished) {
      this.finished = true;
      this.pending += tail;
      const split = splitSentences(this.pending, false);
      this.pending = '';
      for (const sentence of split.sentences) this.enqueue(sentence);
      this.startHeadingIfDue(true);
    }

    const results: SentenceResult[] = [];
    const notes: string[] = [];
    for (const job of this.jobs) {
      const result = await this.valueOf(job.result, until);
      if (result !== null) {
        results.push(result);
      } else {
        job.abort.abort();
        results.push(this.fallback(job.sentence));
        notes.push(`sentence not polished within ${durationText(deadlineMs)}; kept as spoken`);
      }
    }
    let heading: string | null = null;
    if (this.heading !== null) {
      heading = await this.valueOf(this.heading.result, until);
      this.heading.abort.abort();
    }
    for (const job of this.jobs) job.abort.abort();
    for (const result of results) if (result.note !== null) notes.push(result.note);

    return {
      text: this.assemble(results, heading),
      notes,
      sentences: results.length,
      modelSentences: results.filter((result) => result.usedModel).length,
      tailMs: this.clock.now() - started,
    };
  }

  /** Resolves once every committed sentence has been processed. For the probe and tests. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Stop everything. What has been committed is abandoned. */
  cancel(): void {
    this.finished = true;
    this.heading?.abort.abort();
    for (const job of this.jobs) job.abort.abort();
  }

  // ---- jobs -------------------------------------------------------------------------

  private enqueue(sentence: string): void {
    const previous = this.chain;
    const abort = new AbortController();
    const engine = this.usesModel ? this.engine : null;
    const result = (async (): Promise<SentenceResult> => {
      // One generation at a time, in order.
      await previous;
      return processSentence(sentence, this.behaviour, this.language, engine, abort.signal);
    })();
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    this.jobs.push({ sentence, result, abort });
  }

  /**
   * A heading once there is enough note to name: after the third sentence during capture,
   * or at finish for a note of two sentences. One sentence gets no heading.
   */
  private startHeadingIfDue(final: boolean): void {
    const engine = this.engine;
    if (this.behaviour !== 'note' || !this.usesModel || this.heading !== null || engine === null) return;
    if (!(this.jobs.length >= 3 || (final && this.jobs.length === 2))) return;
    const text = this.jobs
      .slice(0, 3)
      .map((job) => job.sentence)
      .join(' ');
    const previous = this.chain;
    const abort = new AbortController();
    const language = this.language;
    const result = (async (): Promise<string | null> => {
      await previous;
      if (abort.signal.aborted) return null;
      let raw: string;
      try {
        raw = await engine.generate(text, language, headingPrompt(language), 16, abort.signal);
      } catch {
        return null;
      }
      const heading = cleanHeading(raw);
      if (!acceptsHeading(heading, text)) return null;
      // Uzbek takes the same bar the whole note is held to before it is inserted (the Uzbek
      // polish guard, which admits no new word at all). The stem rule above accepts
      // `Ertangi rejalar` over `Ertaga rejalarimizni…`; the note guard then refused the whole
      // note for the one inflected heading word, and every checkbox went with it.
      if (language === 'uz' && checkUzbekPolishGuard(heading, text) !== null) return null;
      return heading;
    })();
    this.heading = { result, abort };
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * The promise's value, or `null` at the deadline — whichever comes first, WITHOUT
   * waiting for the loser. A sentence stuck in an engine that has not yet noticed its
   * abort must not hold `finish` hostage; the Swift measured exactly that at 5,050 ms for
   * a 50 ms deadline before it raced instead of grouping.
   */
  private async valueOf<T>(promise: Promise<T>, until: number): Promise<T | null> {
    const timer = this.clock.sleep(Math.max(0, until - this.clock.now()));
    try {
      return await Promise.race([promise, timer.promise.then(() => null)]);
    } finally {
      timer.cancel();
    }
  }

  private fallback(spoken: string): SentenceResult {
    // A note lays its own lines out; a line break the sentence opened with is not part of it.
    const sentence = this.behaviour === 'note' ? trimWhitespaceAndNewlines(spoken) : spoken;
    return {
      text: sentence,
      kind: this.behaviour === 'note' ? heuristicKind(sentence, this.language) : null,
      usedModel: false,
      note: null,
    };
  }

  private assemble(results: readonly SentenceResult[], heading: string | null): string {
    if (this.behaviour !== 'note') return joinSentences(results.map((result) => result.text));
    return renderNote(
      heading,
      results.map((result) => noteLine(result.text, result.kind ?? 'point', this.language)),
    );
  }
}

function heuristicKind(sentence: string, language: Language): NoteKind {
  if (strippingOrdinal(sentence, language) !== null) return 'item';
  return looksLikeTask(sentence, language) ? 'task' : 'point';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function processSentence(
  sentence: string,
  behaviour: ModeBehaviour,
  language: Language,
  engine: PromptedPolisher | null,
  signal: AbortSignal,
): Promise<SentenceResult> {
  const kept: SentenceResult = { text: sentence, kind: null, usedModel: false, note: null };
  switch (behaviour) {
    case 'raw':
      return kept;

    case 'super': {
      if (engine === null || signal.aborted) return kept;
      try {
        const raw = await engine.generate(sentence, language, superPrompt(language), tokenBudget(sentence), signal);
        const projected = project(raw, sentence);
        if (projected.aligned < MINIMUM_ALIGNMENT) {
          return {
            text: sentence,
            kind: null,
            usedModel: false,
            note: `super: model rewrote a sentence (${formatWhole(projected.aligned * 100)}% aligned); kept as spoken`,
          };
        }
        return { text: projected.text, kind: null, usedModel: projected.text !== sentence, note: null };
      } catch (error: unknown) {
        return { text: sentence, kind: null, usedModel: false, note: `super: ${engine.id} failed: ${describe(error)}` };
      }
    }

    case 'message': {
      // No model: the rules — `trimOpeners`, which leaves a language without openers untouched.
      if (engine === null || signal.aborted) return { text: trimOpeners(sentence, language), kind: null, usedModel: false, note: null };
      const prompt = messagePrompt(language);
      try {
        const raw = await engine.generate(sentence, language, prompt, tokenBudget(sentence), signal);
        const output = raw.trim();
        // Arabic (C4 §14.5): the speaker's words with the model's punctuation, minus the
        // fillers, openers and repeats the model took out — never a word changed.
        if (MESSAGE_BY_PROJECTION.has(language)) {
          const mayDrop = new Set([...DROPPABLE[language], ...(OPENERS[language] ?? [])]);
          const projected = project(output, sentence, mayDrop);
          if (projected.aligned < MINIMUM_ALIGNMENT) {
            return {
              text: trimOpeners(sentence, language),
              kind: null,
              usedModel: false,
              note: `message: model rewrote a sentence (${formatWhole(projected.aligned * 100)}% aligned); kept as spoken`,
            };
          }
          const delivered = trimOpeners(orthographyForDelivery(projected.text, language), language);
          return { text: delivered, kind: null, usedModel: delivered !== sentence, note: null };
        }
        const rejection = checkRewrite(output, sentence, language, prompt, DROPPABLE[language]);
        if (rejection !== null) {
          return { text: sentence, kind: null, usedModel: false, note: `message: ${rejection}; kept as spoken` };
        }
        // The model writes ASCII apostrophes; the rest of the dictation carries the okina
        // the session's normaliser put there.
        const delivered = orthographyForDelivery(output, language);
        return { text: delivered, kind: null, usedModel: delivered !== sentence, note: null };
      } catch (error: unknown) {
        return { text: sentence, kind: null, usedModel: false, note: `message: ${engine.id} failed: ${describe(error)}` };
      }
    }

    case 'note': {
      // The splitter keeps a sentence's leading line break so running text survives the
      // round trip; a note makes its own lines, and left in, the break defeated every rule
      // below that reads the sentence's first word — a task became prose — and a TASK label
      // wrote `- [ ] ` over a stray empty line.
      const line = trimWhitespaceAndNewlines(sentence);
      // An enumerated sentence is an item whatever a model thinks.
      if (strippingOrdinal(line, language) !== null) {
        return { text: line, kind: 'item', usedModel: false, note: null };
      }
      const heuristic = heuristicKind(line, language);
      if (engine === null || signal.aborted) return { text: line, kind: heuristic, usedModel: false, note: null };
      try {
        const raw = await engine.generate(line, language, noteClassifierPrompt(language), 3, signal);
        const label = raw.toUpperCase();
        const kind: NoteKind = label.includes('TASK') ? 'task' : label.includes('POINT') ? 'point' : heuristic;
        return { text: line, kind, usedModel: true, note: null };
      } catch (error: unknown) {
        return { text: line, kind: heuristic, usedModel: false, note: `note: ${engine.id} failed: ${describe(error)}` };
      }
    }
  }
}

/**
 * Sentences back into running text. A sentence that began a new line when it was spoken
 * still begins one.
 */
export function joinSentences(sentences: readonly string[]): string {
  let out = '';
  for (const sentence of sentences) {
    if (sentence === '') continue;
    if (out === '' || out.endsWith('\n') || sentence.startsWith('\n')) out += sentence;
    else out += ' ' + sentence;
  }
  return out;
}

// ---------------------------------------------------------------------------------
// ModePolisher — a built-in mode as a `Polisher`
// ---------------------------------------------------------------------------------

/**
 * `ModePolisher`: the whole-transcript path, and the factory for the streaming one.
 *
 * `polish` runs the same per-sentence machinery over a finished transcript — the same
 * prompts, projection, guards and fallbacks — so a mode behaves identically whether or not
 * the transcriber streamed; only the latency differs. `begin` hands out the incremental
 * session a streaming dictation commits into while the key is held.
 *
 * It claims every language, because the deterministic layer always works. Whether a MODEL
 * is involved is decided per session by what `engine` claims.
 */
export class ModePolisher implements Polisher {
  readonly supportedLanguages: ReadonlySet<Language> = new Set(LANGUAGES);
  readonly behaviour: ModeBehaviour;
  private readonly engine: PromptedPolisher | null;
  /**
   * Bounds the whole post-release wait on the whole-transcript path, where every sentence
   * is after release. Two seconds: a long dictation gets its first sentences from the model
   * and the rest in their deterministic form, rather than holding the paste.
   */
  readonly deadlineMs: number;
  private readonly clock: PolishClock | undefined;
  private notes: string[] = [];

  constructor(options: {
    readonly behaviour: ModeBehaviour;
    readonly engine: PromptedPolisher | null;
    readonly deadlineMs?: number;
    readonly clock?: PolishClock;
  }) {
    this.behaviour = options.behaviour;
    this.engine = options.engine;
    this.deadlineMs = options.deadlineMs ?? 2000;
    this.clock = options.clock;
  }

  get id(): string {
    return `${this.behaviour}+${this.engine?.id ?? 'rules'}`;
  }

  /** A fresh incremental session for one dictation in one language. */
  begin(language: Language): IncrementalPolish {
    return new IncrementalPolish({
      behaviour: this.behaviour,
      language,
      engine: this.engine,
      ...(this.clock === undefined ? {} : { clock: this.clock }),
    });
  }

  /** `instructions` is ignored: a built-in mode carries its own per-sentence prompts. */
  async polish(text: string, language: Language, _instructions: string): Promise<string> {
    const outcome = await this.begin(language).finish(text, this.deadlineMs);
    this.record(outcome);
    return outcome.text;
  }

  /** Files an outcome's notes for `drainNotes` — both paths go through here. */
  record(outcome: PolishOutcome): void {
    // Only what went wrong: the session files these under the record's errors.
    this.notes.push(...outcome.notes);
  }

  async drainNotes(): Promise<readonly string[]> {
    const drained = this.notes;
    this.notes = [];
    return drained;
  }
}
