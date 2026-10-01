// One dictation, as a state machine. Ported from `DictationSession`
// (Sources/KotibaCore/DictationSession.swift, 759 lines).
//
// TWO RULES ARE STRUCTURAL HERE RATHER THAN CONVENTIONAL, because the macOS build broke
// both and the breakage was invisible for weeks:
//
//   1. THE RAW TRANSCRIPT IS INSERTED BEFORE POLISH RUNS. Polish is 4–18x the cost of
//      the transcription it polishes; putting it in front of the insertion is the single
//      largest self-inflicted latency error available. The polished text then REPLACES
//      what was inserted, and is never re-normalised or re-capitalised.
//   2. NOTHING FAILS SILENTLY. Every terminal state is `done`, `heardNothing` or
//      `failed` — there is no path that inserts an empty string and calls it success.
//
// And one rule that is structural because of a race rather than a bug in judgement:
// key-down and key-up arrive as two independent async callbacks with NO ordering
// guarantee, and `audio.start()` takes 100–300 ms. A key-up that returns early while
// arming is still in flight leaves the microphone open and hands the abandoned audio to
// the NEXT dictation, which then inserts the wrong text. So key-up PARKS on an explicit
// waiter list, and that list is drained on BOTH the success and the failure paths of
// arming.

import {
  audioDuration,
  dictationError,
  droppedSeconds,
  engineFamilyFor,
  isStreamingEngine,
  isTerminal,
  peakAmplitude,
  rerouteDeadlineMs,
} from '../contracts/index.js';
import type {
  AcousticClassifier,
  AudioBuffer,
  DictationError,
  DictationOutcome,
  DictationRecord,
  DictationState,
  EngineFamily,
  InsertionOutcome,
  InputDeviceInfo,
  Language,
  LanguageRouter,
  PolishGuardConfig,
  Polisher,
  RouteDecision,
  SessionConfig,
  StageMillis,
  StageName,
  SttEngine,
  TranscriptDoubt,
  TranscriptionStream,
  TranscriptResult,
} from '../contracts/index.js';
import { isCandidateVerified, posteriorShare, reroutedDecision } from '../core/routing/index.js';
import { untilSpeechEnds } from '../core/stt/segmenter.js';
import { writtenLanguage } from '../core/stt/tdt.js';
import { quoteSpoken } from '../core/text/index.js';
import type { Clock, IncrementalPolishSession, IncrementalPolisher, RoutingPort, TextPort } from './ports.js';
import { isIncrementalPolisher, systemClock } from './ports.js';

/** The Mac's `Language.promptName`, for the record's sentences. */
const PROMPT_NAMES: Readonly<Record<Language, string>> = {
  en: 'English',
  ru: 'Russian',
  uz: 'Uzbek',
  tr: 'Turkish',
  ar: 'Arabic',
};

/**
 * Full scale. A peak at or above it means the signal reached the rail — but see
 * `FLATTENING_FRACTION` for whether that actually cost anything.
 */
export const CLIPPING_THRESHOLD = 0.99;

/**
 * The share of samples sitting at the rail above which flattening measurably hurts.
 *
 * Derived from measurement, not chosen. On the 344-clip Uzbek set, flattening costs
 * nothing up to about 1% of samples (25.20% against a 25.19% baseline), 1.58 points at
 * 8.3% and 8.35 points at 28.6% — the curve is flat and then steep, so 2% sits just
 * above the highest measured no-op and well below the lowest measured harm.
 */
export const FLATTENING_FRACTION = 0.02;

/** A sample at or above this magnitude is sitting against the rail. */
export const SATURATION_MAGNITUDE = 0.999;

/**
 * The mutable half of a `DictationRecord`.
 *
 * `record` is THE single source of truth while a dictation runs. An earlier version of
 * the Swift kept a local copy and assigned it back at the end, which silently discarded
 * every stage timing written in the meantime — four of five stages vanished, and the
 * only reason anyone noticed is that a test asserted on their presence.
 */
interface RecordDraft {
  startedAt: string;
  audioSeconds: number;
  peakAmplitude: number;
  stageMillis: Partial<Record<StageName, number>>;
  route: RouteDecision | null;
  engineID: string | null;
  raw: string | null;
  result: string | null;
  polished: string | null;
  modeKey: string | null;
  polishID: string | null;
  outcome: DictationOutcome;
  errors: string[];
  unifiedDoubt: TranscriptDoubt | null;
  turkishCheckWaitMillis: number | null;
  /** The microphone the take came from (`AudioBuffer.device`); null when the source did not say. */
  inputDevice: InputDeviceInfo | null;
}

/** How a deadlined call ended. Three answers, not two. */
export type DeadlineOutcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'timedOut' };

/**
 * Runs `body`, giving up on it after `ms` — and RETURNING after `ms`, which is the part
 * that is easy to get wrong.
 *
 * A `Promise.race` alone does bound the wait, but the loser keeps running and its
 * rejection becomes an unhandled rejection that can take the process down. The loser is
 * therefore explicitly abandoned with its rejection swallowed, and a one-shot gate makes
 * the handover exactly-once so the timer firing after a value has landed changes nothing.
 *
 * `.failed` and `.timedOut` are separate cases because collapsing them destroys the
 * diagnosis: a polisher that failed in 40 ms with a bad API key was recorded as "polish
 * exceeded 8 seconds", and the real error was gone.
 */
export async function withDeadline<T>(
  clock: Clock,
  ms: number,
  body: () => Promise<T>,
): Promise<DeadlineOutcome<T>> {
  const timer = clock.sleep(ms);
  let settled = false;
  const claim = (): boolean => {
    if (settled) return false;
    settled = true;
    return true;
  };

  const work = body().then(
    (value): DeadlineOutcome<T> => ({ kind: 'value', value }),
    (error: unknown): DeadlineOutcome<T> => ({ kind: 'failed', message: describe(error) }),
  );

  const raced = await Promise.race<DeadlineOutcome<T>>([
    work.then((outcome) => (claim() ? outcome : NEVER<DeadlineOutcome<T>>())),
    timer.promise.then(() =>
      claim() ? ({ kind: 'timedOut' } as DeadlineOutcome<T>) : NEVER<DeadlineOutcome<T>>(),
    ),
  ]);

  timer.cancel();
  // The loser is abandoned rather than awaited. Swallowing its settlement is what keeps
  // an 8 s polish that resolves after the deadline from becoming an unhandled rejection.
  void work.catch(() => undefined);
  return raced;
}

/** A promise that never settles. The losing half of the race resolves to this. */
function NEVER<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** `"\(error)"` — this codebase's interchange format at a module boundary. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** ISO-8601 UTC, seconds precision. The same encoding history and diagnostics share. */
export function isoSeconds(epochMillis: number): string {
  return new Date(epochMillis).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * `raw.prefix(40).trimmingCharacters(in: .whitespaces)`: the first 40 CHARACTERS — slicing
 * UTF-16 units could cut an emoji or a decomposed okina in half — trimmed of spaces and tabs.
 */
function prefix40(raw: string): string {
  let out = '';
  let n = 0;
  for (const { segment } of GRAPHEMES.segment(raw)) {
    if (n === 40) break;
    out += segment;
    n += 1;
  }
  return out.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, '');
}

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** `10 s`, `8 s`, `1.5 s`. What a deadline is called in a diagnostics sentence. */
function secondsText(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

/** What `finish()` was asked to do with the polish. */
export interface FinishOptions {
  /** Absolute. Short-circuits routing, costs nothing, and is never overruled. */
  readonly pin: Language | null;
  readonly polisher: Polisher | null;
  /** `null` for a mode that never polishes. No prompt means no polisher means nothing leaves. */
  readonly polishInstructions: string | null;
  readonly polishGuard: PolishGuardConfig;
  /** True for a restructuring mode: wait for the polish and insert ONCE. */
  readonly insertAfterPolish: boolean;
  /** The composite chain's remarks, drained onto the record whatever the outcome. */
  drainPolishNotes?(): Promise<readonly string[]>;
}

/**
 * One dictation. `arm()` at key-down, `finish()` at key-up.
 *
 * `finish()` ALWAYS returns a record — per-stage wall-clock timings, the route, the
 * three text stages, an outcome and an error list — so the caller never has to guess
 * what went on.
 */
export interface DictationSession {
  readonly state: DictationState;
  /** Every transition of THIS run, in order. Cleared by `arm()`, never cumulative. */
  readonly transitions: readonly DictationState[];
  arm(): Promise<void>;
  finish(options: FinishOptions): Promise<DictationRecord>;
  /** D-W4: live on Windows, because a chord during the hold must not dictate. */
  cancel(reason: string): Promise<void>;
}

export interface SessionDeps {
  /**
   * THIS dictation's take. `onChunk` is the live 16 kHz stream of the same samples `stop()`
   * returns — the seam a streaming engine attaches to (transcribe during capture, commit
   * at pauses). Nothing in the session consumes it yet; the take's own store is built from
   * it, which is what keeps the stream honest.
   */
  readonly audio: {
    start(): Promise<void>;
    stop(): Promise<AudioBuffer>;
    onChunk?(listener: (samples: Float32Array) => void): () => void;
  };
  readonly router: LanguageRouter;
  /** `null` when nothing is configured for that family. */
  readonly engineFor: (family: EngineFamily) => SttEngine | null;
  /**
   * D-W25: how far `language`'s engine download has got, in whole percent, or `null` when it is
   * not downloading. English and Russian wait for Parakeet after a fresh install (the installer
   * no longer carries whisper turbo); a press then says "still downloading — 42 %" rather than
   * "not ready". Absent: always `null`.
   */
  readonly gettingReady?: (language: Language) => number | null;
  /**
   * The language this press is pinned to, when that is known at key-down (the mode's
   * language or the user's pin). It decides which family's stream is opened while the key
   * is held: the pinned one's, or — unpinned — the unified engine's, speculatively, as on
   * the Mac. A dictation that routes elsewhere simply never finishes its stream.
   */
  readonly pinAtPress?: Language | null;
  /**
   * The language to SPECULATE on when nothing is pinned — the default language. Windows
   * decodes on the CPU, so one stream per press, not one per family: the Mac speculates on
   * the unified engine always, and here an Uzbek-default user speculates on Uzbek (C2) and
   * everyone else on the unified engine. Absent means the Mac's rule.
   */
  readonly speculativeLanguage?: Language | null;
  /**
   * C4 / the Mac's D-11: turbo's own language head, asked at key-up for a Turkish CANDIDATE
   * (`RouteDecision.candidate === 'tr'`) — Turkish on its word, Uzbek otherwise, including when
   * it cannot answer in time. Absent or `null`: a candidate is Uzbek, the owner's rule for an
   * uncertain one. (The Mac asks it during the hold, and again at the pause before key-up;
   * Windows routes only at key-up, so the one turbo encoder pass is paid there — for candidates
   * only, which Turkish being on creates. Both read a window fitted to the audio,
   * `TURKISH_HEAD_MARGIN`, not the model's 30 s: C4 §13 measured the same routing at a
   * fraction of the encoder work.)
   */
  readonly languageHead?: () => AcousticClassifier | null;
  /**
   * Whether this user has dictated Turkish before (`Settings.turkishDictations` > 0): the check
   * asks more of the first one. Absent = not familiar — the stricter bar.
   */
  readonly turkishFamiliar?: boolean;
  /**
   * The same for Arabic (`Settings.arabicDictations` > 0, the Mac's `ArabicCheck`, C4 §14.1):
   * an Arabic CANDIDATE — any route the detector half-heard as Arabic — goes to Arabic only on
   * the same head's word, at 0.95 for a familiar user and 0.98 until then; its base route
   * otherwise. Absent = not familiar.
   */
  readonly arabicFamiliar?: boolean;
  /** The optional languages that are on. Arabic's script reroute (step 4b′) runs only for Arabic. */
  readonly optionalLanguages?: readonly Language[];
  /**
   * The dictation languages that are on (`Settings.enabledLanguages`, the Mac's
   * `config.languages`). Absent: all five. Nothing outside it is routed to — not by the router
   * (the controller gives it the same set), and not by any recovery after transcription (4a,
   * 4a′, 4b, 4b′ ask `permits`).
   */
  readonly languages?: readonly Language[];
  /**
   * The polisher this dictation will use, as soon as it is known — asked when the stream
   * first commits, ~14 s into a hold, never at key-down, so building it (a credential read)
   * never delays the microphone. When it can run incrementally, the text the stream
   * commits during the hold is polished during the hold, and key-up is left with the last
   * sentence (C3 §8).
   */
  readonly livePolisher?: () => Polisher | null;
  /**
   * `normalise` for a stretch that is NOT the end of the dictation: the same pipeline with
   * the final sentence left open. What committed text is normalised with before it is
   * polished. Absent means no incremental polish.
   */
  readonly normaliseSegment?: (text: string, language: Language) => string;
  readonly insert: (text: string) => Promise<InsertionOutcome>;
  /**
   * Replace `previous` — EXACTLY what this session inserted — with `text`.
   *
   * The implementation selects back over what was inserted and retypes, counting in
   * UTF-16 code units. Counting in characters misaligns the moment an emoji or an okina
   * is in the text, and an unverified select-last-N eats anything the user typed in
   * between.
   */
  readonly replace: (previous: string, text: string) => Promise<InsertionOutcome>;
  /** `forDelivery` → replacements → capitaliser. Built by the controller from settings + mode. */
  readonly normalise: (text: string, language: Language) => string;
  readonly routing: RoutingPort;
  readonly text: TextPort;
  readonly config: SessionConfig;
  readonly clock?: Clock;
}

export function createDictationSession(deps: SessionDeps): DictationSession {
  const clock = deps.clock ?? systemClock;

  let state: DictationState = { kind: 'idle' };
  let transitions: DictationState[] = [];
  let record: RecordDraft | null = null;

  /** Key-ups parked inside `audio.start()`. Drained on BOTH paths out of `arm()`. */
  let armingWaiters: (() => void)[] = [];

  /**
   * The stream the take's chunks feed while the key is held, and the family it speculates
   * on. `null` when nothing streams — then key-up is batch, exactly as before.
   */
  let live: { readonly stream: TranscriptionStream; readonly family: EngineFamily; stopFeeding: () => void } | null =
    null;
  /**
   * The stream handed over at key-up and not yet finished or cancelled. Every way out of
   * `finish()` cancels it (`discardLive`), so a failure between key-up and transcription —
   * no engine, a load that throws — cannot leave it decoding behind a dictation that is
   * over. Taken (`takeParked`) by whatever finishes or cancels it on purpose.
   */
  let parked: TranscriptionStream | null = null;
  /**
   * Incremental polish of what the stream committed. `prefix` is the normalised form of
   * everything committed so far — what has been handed to `session.commit` — and the key-up
   * uses the incremental result only if the finished transcript's normalised form still
   * starts with it. `broken` latches for THIS dictation only; the next one is a new session.
   */
  let livePolish: {
    readonly polisher: IncrementalPolisher;
    readonly session: IncrementalPolishSession;
    readonly committed: string[];
    prefix: string;
    broken: boolean;
  } | null = null;

  function transition(next: DictationState): void {
    state = next;
    transitions.push(next);
  }

  async function measure<T>(stage: StageName, body: () => Promise<T>): Promise<T> {
    const t0 = clock.now();
    try {
      return await body();
    } finally {
      // In a `finally`, so a stage that THREW still reports how long it took before it
      // did. A missing stage means it did not run; a stage that ran and failed is a
      // different fact and the record has to be able to tell them apart.
      if (record !== null) record.stageMillis[stage] = clock.now() - t0;
    }
  }

  function note(mutate: (draft: RecordDraft) => void): void {
    if (record !== null) mutate(record);
  }

  function fail(reason: DictationError, message: string): void {
    note((draft) => {
      draft.errors.push(message);
      draft.outcome = 'failed';
    });
    transition({ kind: 'failed', error: reason });
  }

  function releaseArmingWaiters(): void {
    const waiting = armingWaiters;
    armingWaiters = [];
    for (const resume of waiting) resume();
  }

  /**
   * A key-up that lands while `arm()` is still inside `audio.start()` waits here.
   *
   * Returning early instead would drop the key-up, leave the capture open, and hand the
   * abandoned audio to the next dictation — which then inserts the previous utterance's
   * text. That is the worst class of bug in this pipeline, because the symptom appears
   * one dictation after the cause.
   */
  async function awaitArmingIfNeeded(): Promise<void> {
    if (state.kind !== 'arming') return;
    await new Promise<void>((resolve) => armingWaiters.push(resolve));
  }

  function snapshot(): DictationRecord {
    const draft = record;
    if (draft === null) {
      return {
        startedAt: isoSeconds(clock.now()),
        audioSeconds: 0,
        errors: [],
        outcome: 'incomplete',
        peakAmplitude: 0,
        stageMillis: {},
      };
    }
    // Every optional field is OMITTED when absent, never written as `null` — the macOS
    // encoder uses `encodeIfPresent`, and a decoder that distinguishes absent from null
    // reads the two differently.
    const out: {
      -readonly [K in keyof DictationRecord]: DictationRecord[K];
    } = {
      startedAt: draft.startedAt,
      audioSeconds: draft.audioSeconds,
      errors: [...draft.errors],
      outcome: draft.outcome,
      peakAmplitude: draft.peakAmplitude,
      stageMillis: { ...draft.stageMillis } as StageMillis,
    };
    if (draft.engineID !== null) out.engineID = draft.engineID;
    if (draft.modeKey !== null) out.modeKey = draft.modeKey;
    if (draft.polishID !== null) out.polishID = draft.polishID;
    if (draft.polished !== null) out.polished = draft.polished;
    if (draft.raw !== null) out.raw = draft.raw;
    if (draft.result !== null) out.result = draft.result;
    if (draft.route !== null) out.route = draft.route;
    if (draft.unifiedDoubt !== null) out.unifiedDoubt = draft.unifiedDoubt;
    if (draft.turkishCheckWaitMillis !== null) out.turkishCheckWaitMillis = draft.turkishCheckWaitMillis;
    if (draft.inputDevice !== null) out.inputDevice = draft.inputDevice;
    return out;
  }

  // -------------------------------------------------------------------------------
  // Streaming while the key is held
  // -------------------------------------------------------------------------------

  /**
   * Start decoding while the user is still speaking, when both ends can.
   *
   * Opened SPECULATIVELY: the route is not known until key-up. Unpinned, it is the unified
   * engine's stream (English and Russian — Parakeet), as on the Mac; pinned, the pinned
   * family's, which is how a streaming Uzbek engine plugs in with no change here. Uzbek is
   * batch on Windows today, so an Uzbek pin opens nothing and costs nothing.
   */
  /** Whether a language is on (`deps.languages`; absent: every language). */
  function on(language: Language): boolean {
    return deps.languages === undefined || deps.languages.length === 0 || deps.languages.includes(language);
  }

  function openLiveStream(): void {
    const subscribe = deps.audio.onChunk;
    if (subscribe === undefined) return;
    const speculated = deps.pinAtPress ?? deps.speculativeLanguage ?? null;
    const family = speculated === null ? 'unified' : engineFamilyFor(speculated);
    const engine = deps.engineFor(family);
    if (!isStreamingEngine(engine)) return;
    let stream: TranscriptionStream;
    try {
      stream = engine.openStream();
    } catch {
      return;
    }
    const stopCommits = stream.onCommit?.((text) => {
      committedDuringHold(text);
    });
    const stopChunks = subscribe((samples) => {
      // A copy: the stream keeps what it is handed, and a chunk is not ours to keep.
      stream.append(samples.slice());
    });
    live = {
      stream,
      family,
      stopFeeding: () => {
        stopChunks();
        stopCommits?.();
      },
    };
  }

  /** The stream committed text during the hold. Polish it now, if this dictation can. */
  function committedDuringHold(raw: string): void {
    const polisher = deps.livePolisher?.() ?? null;
    const normaliseSegment = deps.normaliseSegment;
    if (polisher === null || normaliseSegment === undefined) return;
    if (!isIncrementalPolisher(polisher)) return;
    if (livePolish === null) {
      // The language is the engine's own answer — Parakeet writes English or Russian per
      // token; the Uzbek stream writes Uzbek — unless the press was pinned, which beats it
      // here as everywhere.
      const pinned = deps.pinAtPress ?? null;
      const language = pinned ?? (live?.family === 'uzbek' ? 'uz' : writtenLanguage<Language>(raw, 'en'));
      if (!polisher.supportedLanguages.has(language)) return;
      livePolish = { polisher, session: polisher.begin(language), committed: [], prefix: '', broken: false };
    }
    const polish = livePolish;
    if (polish.broken) return;
    polish.committed.push(raw);
    const next = normaliseSegment(polish.committed.join(' '), polish.session.language);
    if (!next.startsWith(polish.prefix)) {
      // Normalising more text changed text already handed over. Nothing wrong with the
      // text; the incremental result just cannot be trusted to line up. Key-up polishes
      // the whole transcript instead.
      polish.broken = true;
      return;
    }
    polish.session.commit(next.slice(polish.prefix.length));
    polish.prefix = next;
  }

  /** Stop feeding the stream and hand it over. After `audio.stop()`, every chunk is in it. */
  function closeLiveStream(): { readonly stream: TranscriptionStream; readonly family: EngineFamily } | null {
    const current = live;
    live = null;
    if (current === null) return null;
    current.stopFeeding();
    return current;
  }

  /** The parked stream, now the caller's to finish or cancel. */
  function takeParked(): TranscriptionStream | null {
    const stream = parked;
    parked = null;
    return stream;
  }

  /** Anything streaming that this dictation did not use. Safe to call twice. */
  function discardLive(): void {
    const current = live;
    live = null;
    if (current !== null) {
      current.stopFeeding();
      current.stream.cancel();
    }
    takeParked()?.cancel();
    livePolish?.session.cancel();
    livePolish = null;
  }

  // -------------------------------------------------------------------------------
  // Key down
  // -------------------------------------------------------------------------------

  async function arm(): Promise<void> {
    // The session is reusable: arming again after a terminal state starts a fresh
    // dictation. Arming while one is in flight is IGNORED, because a second key-down
    // before the first key-up is a stuck modifier, not a new utterance.
    if (!(state.kind === 'idle' || isTerminal(state))) return;

    transitions = [];
    const startedAt = clock.now();
    record = {
      startedAt: isoSeconds(startedAt),
      audioSeconds: 0,
      peakAmplitude: 0,
      stageMillis: {},
      route: null,
      engineID: null,
      raw: null,
      result: null,
      polished: null,
      modeKey: null,
      polishID: null,
      outcome: 'incomplete',
      errors: [],
      unifiedDoubt: null,
      turkishCheckWaitMillis: null,
      inputDevice: null,
    };
    transition({ kind: 'arming' });
    try {
      try {
        await measure('arming', () => deps.audio.start());
        transition({ kind: 'capturing' });
        openLiveStream();
      } catch (error: unknown) {
        const why = describe(error);
        fail(dictationError.armingFailed(why), why);
      }
    } finally {
      // BOTH paths. A failure that left the waiters parked would hang the key-up
      // forever, and the next press would find a session that never became idle.
      releaseArmingWaiters();
    }
  }

  // -------------------------------------------------------------------------------
  // Key up
  // -------------------------------------------------------------------------------

  async function finish(options: FinishOptions): Promise<DictationRecord> {
    try {
      return await finishDictation(options);
    } finally {
      // Every path out — heard nothing, a failure, another family's route — lets go of
      // whatever was streaming. Idempotent after a stream that was used.
      discardLive();
    }
  }

  async function finishDictation(options: FinishOptions): Promise<DictationRecord> {
    await awaitArmingIfNeeded();
    if (state.kind !== 'capturing' || record === null) return snapshot();

    // 1. Finalise the buffer.
    transition({ kind: 'finalising' });
    let buffer: AudioBuffer;
    let streamed: { readonly stream: TranscriptionStream; readonly family: EngineFamily } | null = null;
    try {
      buffer = await measure('finalising', () => deps.audio.stop());
      streamed = closeLiveStream();
      parked = streamed?.stream ?? null;
    } catch (error: unknown) {
      const why = describe(error);
      fail(dictationError.captureFailed(why), why);
      return snapshot();
    }

    const duration = audioDuration(buffer);
    const peak = peakAmplitude(buffer);
    // Steps 4a′ and 4b: the reroute ceiling scales with the recording (`rerouteDeadlineMs`).
    const rerouteMs = rerouteDeadlineMs(duration, deps.config.rerouteDeadlineMs);
    note((draft) => {
      draft.audioSeconds = duration;
      draft.peakAmplitude = peak;
      draft.inputDevice = buffer.device ?? null;
    });

    // Lost audio, said out loud. The recording is genuinely SHORT here — the user spoke
    // words this buffer does not contain — and reporting `done` over the top of that is
    // the silent-truncation failure this project exists to not repeat.
    if (buffer.droppedSamples > 0) {
      note((draft) => {
        draft.errors.push(
          `capture dropped ${buffer.droppedSamples} samples (` +
            `${droppedSeconds(buffer).toFixed(1)}s) — the recording is shorter than what was ` +
            'said, because nothing drained the buffer in time',
        );
      });
    }

    // Clipping, recorded but never fatal — and told apart from merely loud, because the
    // two cost different amounts and only one is worth acting on. The peak alone cannot
    // separate them: the resampler contributes up to +1.15 dB of overshoot of its own.
    // What separates them is how many samples are SITTING at the rail.
    if (peak >= CLIPPING_THRESHOLD) {
      let saturated = 0;
      for (const sample of buffer.samples) {
        if (Math.abs(sample) >= SATURATION_MAGNITUDE) saturated += 1;
      }
      const fraction = buffer.samples.length === 0 ? 0 : saturated / buffer.samples.length;
      const peakText = peak.toFixed(2);
      const percent = (fraction * 100).toFixed(1);
      note((draft) => {
        if (fraction >= FLATTENING_FRACTION) {
          draft.errors.push(
            `input is clipping — peak ${peakText}, and ${percent}% of samples are flat ` +
              'against the rail. Measured cost at this much flattening is about 1.5 points ' +
              'of word error. Lower the input volume in Settings › System › Sound › Input.',
          );
        } else {
          draft.errors.push(
            `input is hot — peak ${peakText} above full scale, but only ${percent}% of ` +
              'samples are flat, and that much was measured to cost nothing. Recorded ' +
              'rather than warned about.',
          );
        }
      });
    }

    // 1b. No audio AT ALL is a broken microphone, not a quiet room.
    //
    // The silence gate below compares peak amplitude and an empty buffer has a peak of
    // zero, so the two used to be indistinguishable — a capture that delivered literally
    // nothing was reported to the user as "I heard nothing", i.e. as their fault.
    if (buffer.samples.length === 0) {
      const why =
        'the microphone delivered no audio at all — not a quiet room, nothing arrived. ' +
        'If it repeats, the input device changed and Kotiba rebuilds its audio graph on ' +
        'the next press.';
      fail(dictationError.captureFailed(why), why);
      return snapshot();
    }

    // 2. Say so when nothing was said. A TERMINAL STATE, not an empty success.
    //    A 7.4 s silent recording ends here.
    if (peak < deps.config.silenceThreshold) {
      note((draft) => {
        draft.outcome = 'heardNothing';
      });
      transition({ kind: 'heardNothing' });
      return snapshot();
    }

    // 3. Route. A pin costs nothing and beats everything.
    transition({ kind: 'routing' });
    let routed = await measure('routing', () => deps.router.route(buffer, options.pin));
    // 3b. A Turkish candidate is settled by turbo's language head (`TurkishCheck`): Turkish only
    //     on its word, Uzbek otherwise — including when it cannot answer within the deadline.
    //     An Arabic candidate (C4 §14.1) the same way on any base route (`ArabicCheck`): Arabic
    //     only on the head's word, the base route otherwise.
    const candidate = routed.candidate ?? null;
    if ((candidate === 'tr' || candidate === 'ar') && options.pin === null) {
      const verifier = deps.languageHead?.() ?? null;
      const was = routed;
      const familiar = candidate === 'ar' ? (deps.arabicFamiliar ?? false) : (deps.turkishFamiliar ?? false);
      const name = candidate === 'ar' ? 'Arabic' : 'Turkish';
      if (verifier === null) {
        routed = reroutedDecision(was, was.language, was.source);
      } else {
        const asked = clock.now();
        // Over the speech and 0.3 s after it — what the fitted head window was measured on.
        const spoken: AudioBuffer = { ...buffer, samples: untilSpeechEnds(buffer.samples) };
        const answer = await withDeadline(clock, rerouteMs, () => verifier.posterior(spoken));
        const waited = clock.now() - asked;
        note((draft) => {
          draft.turkishCheckWaitMillis = waited;
        });
        if (answer.kind === 'value' && Object.keys(answer.value).length > 0) {
          const tr = candidate === 'tr' ? posteriorShare('tr', answer.value) : null;
          const ar = candidate === 'ar' ? posteriorShare('ar', answer.value) : null;
          routed = isCandidateVerified(candidate, answer.value, familiar)
            ? reroutedDecision(was, candidate, candidate === 'ar' ? 'arabicCheck' : 'turkishCheck', tr, ar)
            : reroutedDecision(was, was.language, was.source, tr, ar);
        } else {
          routed = reroutedDecision(was, was.language, was.source);
          note((draft) => {
            draft.errors.push(`the ${name} check could not answer; routed to ${PROMPT_NAMES[was.language]}.`);
          });
        }
      }
    }
    note((draft) => {
      draft.route = routed;
    });

    // An engine still downloading is "getting ready, 42 %" (D-W25); anything else, "not ready".
    const notReady = (family: EngineFamily, language: Language): DictationError => {
      const percent = deps.gettingReady?.(language) ?? null;
      return percent === null
        ? dictationError.noEngineReady(family, language)
        : dictationError.gettingReady(family, language, percent);
    };

    // 4. Transcribe. An engine that is not ready is a LOUD failure, never a silent
    //    substitution — the previous build fell back to a 30x slower engine in silence.
    const engine = deps.engineFor(routed.family);
    if (engine === null) {
      fail(
        notReady(routed.family, routed.language),
        `no engine registered for ${routed.family}`,
      );
      return snapshot();
    }

    // READINESS PREPARES, IT DOES NOT GUARD. "Not loaded yet" and "cannot load" are
    // different answers, and the engines that matter are lazy: whisper reports not-ready
    // until its 539 MB context is mapped in, and it maps it in on demand. Refusing a cold
    // engine here made Uzbek — the language this app exists for — fail on every default
    // install, pointing the user at a model file that was present and valid.
    //
    // So a cold engine gets exactly ONE chance to load, timed so a slow first dictation
    // is explainable. Only a load that actually THROWS is terminal, and it fails with the
    // reason the engine gave: a missing file, a bad checksum and a revoked permission
    // must not all read as "not ready".
    if (!(await engine.isReady())) {
      try {
        await measure('loading', () => engine.prepare());
      } catch (error: unknown) {
        fail(
          notReady(routed.family, routed.language),
          `engine ${engine.engineId} could not load: ${describe(error)}`,
        );
        return snapshot();
      }
      // RE-ASK, AND RECORD THE ANSWER — BUT DO NOT REFUSE ON IT.
      //
      // `isReady()` is a property of the whole FAMILY, and a family engine is imprecise
      // about its members in both directions. The macOS composite computed readiness as
      // an OR and read ready forever, which is the lie this re-ask was written for. The
      // opposite lie costs more: a family that ANDs over its members reports not-ready
      // whenever ANY member is cold — English resident, Russian never installed — and
      // `transcribe(buffer, language)` would have used the resident one and worked. This
      // check turned that into a dead dictation whose only explanation was "gave no
      // reason", for a model the user had every intention of never installing.
      //
      // The member that will actually be used is asked by USING it. A transcription into
      // an engine that genuinely has nothing loaded throws `EngineFailure`, and that
      // failure carries the engine's own words — which is a better sentence than this one
      // ever produced. Nothing fails silently either way; only the question changed.
      if (!(await engine.isReady())) {
        note((draft) => {
          draft.errors.push(
            `engine ${engine.engineId} still reports not-ready after loading — ` +
              `transcribing ${routed.language} anyway, because readiness is a property of ` +
              'the whole family and only the member this route uses has to be resident',
          );
        });
      }
    }

    // Whether step 4a′ will read the unified engine's transcript: unpinned, and routed there.
    const checksTranscript = options.pin === null && routed.family === 'unified' && routed.source !== 'pin' && on('uz');

    transition({ kind: 'transcribing' });
    let transcribed: TranscriptResult;
    try {
      const language = routed.language;
      // The stream is used only for the family it speculated on. Otherwise it is let go and
      // the routed engine decodes the finalised recording in batch, as before — with one
      // exception: an UZBEK stream (an Uzbek-default user speculates on Uzbek) on a dictation
      // step 4a′ will check is kept, because it is exactly the second opinion that step may
      // ask for, and it has usually decoded all but the tail already.
      const usesStream = streamed !== null && streamed.family === routed.family;
      const stream = usesStream ? takeParked() : null;
      if (!usesStream && !(checksTranscript && streamed?.family === 'uzbek')) takeParked()?.cancel();
      transcribed = await measure('transcribing', () =>
        stream === null ? engine.transcribe(buffer, language) : stream.finish(buffer, language),
      );
    } catch (error: unknown) {
      const why = describe(error);
      fail(dictationError.transcriptionFailed(why), why);
      return snapshot();
    }

    // 4a. The unified engine names the language itself.
    //
    // Parakeet decides English against Russian inside its decoder, so the transcript it
    // returns carries the language it actually wrote, and that beats the acoustic router's
    // en/ru guess. Taking it matters beyond the label: Latin text on a Russian route is what
    // `verifyRoute` reads as a mis-route toward Uzbek, and the step below would then hand
    // good English to the Uzbek engine. A pin still wins, as it does everywhere.
    if (
      routed.family === 'unified' &&
      routed.source !== 'pin' &&
      transcribed.language !== routed.language &&
      transcribed.language !== 'uz' &&
      on(transcribed.language)
    ) {
      routed = {
        language: transcribed.language,
        family: engineFamilyFor(transcribed.language),
        source: 'scriptCheck',
        turkicMass: routed.turkicMass,
      };
      const relabelled = routed;
      note((draft) => {
        draft.route = relabelled;
      });
    }

    // 4a′. Uzbek that the acoustic pass sent to the unified engine — the commonest mis-route,
    //      and until this step a silent one: 40 of 256 Uzbek dictations in the Mac pipeline's
    //      own end-to-end run (P1).
    //
    // The unified engine's transcript is already here, and on Uzbek audio it is not English —
    // it is pseudo-Hungarian or -Polish, or nothing (`transcriptDoubt`, golden-pinned in
    // src/core/routing). When it doubts its route, the Uzbek engine is asked for the same
    // audio, and its answer replaces the first unless it reads as English — which is what the
    // Uzbek fine-tune does with English audio. Constraints as in 4b: never a pin; toward
    // Uzbek only (nothing after this moves a `transcriptCheck` route back — Windows has no
    // step 4c, and 4b only moves toward Uzbek); a usable answer; the reroute deadline.
    //
    // WHERE WINDOWS DIFFERS FROM THE MAC. The Mac streams BOTH families during an unpinned
    // hold, keeps the Uzbek stream alive for this step, and keeps it speculating while the
    // unified engine's pause text reads not-English, so the second opinion is usually just
    // the tail. Windows decodes on the CPU and opens ONE stream per press — the unified
    // engine's when unpinned — so here the second opinion is normally a BATCH `transcribe`
    // of the whole recording, and it costs the Uzbek engine's full latency, bounded by the
    // deadline. The one exception is a user whose default language is Uzbek: their one
    // stream IS the Uzbek one, kept at step 4 above, and it is finished here instead.
    if (checksTranscript && routed.family === 'unified' && routed.source !== 'pin') {
      const uzbekStream = takeParked();
      // "No words" counts only when a speech detector heard speech: on the Mac an empty
      // transcript of a cough is the heard-nothing path (5b), not Uzbek. Nothing on this
      // side tracks speech through to key-up (`TranscriptionStream` has no `lastSpeechEnd`),
      // and the Mac's rule for "nothing tracks speech" is to treat it as heard — the peak
      // gate at step 2 has at least ruled out a silent room.
      const heardSpeech = true;
      let doubt = deps.routing.transcriptDoubt(transcribed.raw);
      if (doubt === 'noWords' && !heardSpeech) doubt = null;
      const doubted = doubt;
      if (doubted !== null) {
        note((draft) => {
          draft.unifiedDoubt = doubted;
        });
      }
      const uzbek = doubted === null ? null : deps.engineFor('uzbek');
      // Deliberately NOT prepared when cold, as in 4b: a cold 539 MB load would consume the
      // whole deadline and the first transcript would stand anyway. The doubt is on the
      // record either way.
      if (doubted !== null && uzbek !== null && (await uzbek.isReady())) {
        const was = routed;
        const unifiedId = transcribed.engineId;
        // A decode abandoned at the deadline is ABORTED, not left running: the whisper
        // host runs one request at a time, and the next Uzbek dictation would otherwise
        // queue behind it. The Mac cancels its task the same way.
        const giveUp = new AbortController();
        const second = await measure('rerouting', () =>
          withDeadline(clock, rerouteMs, () =>
            uzbekStream === null ? uzbek.transcribe(buffer, 'uz', giveUp.signal) : uzbekStream.finish(buffer, 'uz'),
          ),
        );
        if (second.kind === 'timedOut') giveUp.abort();
        if (
          second.kind === 'value' &&
          deps.routing.isUsableRerun(second.value.raw) &&
          !deps.routing.readsAsEnglish(second.value.raw)
        ) {
          transcribed = second.value;
          routed = {
            language: 'uz',
            family: engineFamilyFor('uz'),
            source: 'transcriptCheck',
            // The ORIGINAL acoustic mass is carried through, so the record still says what
            // the acoustic pass thought.
            turkicMass: was.turkicMass,
          };
          const settled = routed;
          note((draft) => {
            draft.route = settled;
            draft.errors.push(
              `route said ${was.language}, but ${unifiedId}'s transcript was not English ` +
                `(${doubted}); the Uzbek engine's answer stands.`,
            );
          });
        } else if (second.kind === 'value') {
          // Quoted, so the diagnostics summary redacts it (`redactSpoken`): it is speech.
          const preview = quoteSpoken(prefix40(second.value.raw));
          note((draft) => {
            draft.errors.push(
              `${unifiedId}'s transcript was not English (${doubted}), but the Uzbek engine's ` +
                `answer read as English or was unusable ${preview} — the first transcript ` +
                'stands.',
            );
          });
        } else if (second.kind === 'timedOut') {
          uzbekStream?.cancel();
          note((draft) => {
            draft.errors.push(
              `the Uzbek engine did not answer within ` +
                `${secondsText(rerouteMs)} — the first transcript stands.`,
            );
          });
        } else {
          note((draft) => {
            draft.errors.push(
              `the Uzbek engine refused the second opinion: ${second.message} — the first ` +
                'transcript stands.',
            );
          });
        }
      } else {
        uzbekStream?.cancel();
      }
    }

    // 4b. Recover from the one mis-route that is silent AND total.
    //
    // Measured, from this app's own diagnostics: Uzbek speech scored a Turkic cluster
    // mass of 0.012 — below the 0.05 threshold — went to the Russian model, and came
    // back as Uzbek spelled phonetically in Cyrillic, delivered without a word of
    // complaint. Four constraints, each here because dropping it makes this worse than
    // the bug it fixes:
    //
    //   * A PIN IS NEVER OVERRULED. It is the one signal the user actually authored.
    //   * IT ONLY EVER MOVES TOWARD UZBEK, so a retry cannot itself be re-routed.
    //   * THE REPLACEMENT HAS TO BE PLAUSIBLE, not merely non-empty.
    //   * IT IS BOUNDED, and on the deadline the first transcript stands.
    const verdict = deps.routing.verifyRoute(routed, transcribed.raw);
    if (verdict.kind === 'suspect' && verdict.suggests === 'uz' && routed.language !== 'uz' && on('uz')) {
      const letters = deps.routing.nonRussianCyrillicCount(transcribed.raw);
      const was = routed;
      const engineId = transcribed.engineId;

      // Said UNCONDITIONALLY, before anything is attempted. Reporting only on success
      // made the commonest case — the Uzbek model configured but not yet resident, which
      // is the default — look exactly like a route nobody had ever doubted.
      note((draft) => {
        draft.errors.push(
          `route said ${was.language} and ${engineId} answered in Cyrillic that is not ` +
            `Russian — ${letters} such letters, which reads as Uzbek.`,
        );
      });

      const uzbek = deps.engineFor('uzbek');
      if (was.source === 'pin') {
        note((draft) => {
          draft.errors.push(
            'the language was pinned, so the transcript stands as the Uzbek engine was ' +
              'not asked. Unpin it, or pin Uzbek, if this was wrong.',
          );
        });
      } else if (uzbek !== null && (await uzbek.isReady())) {
        // Deliberately NOT prepared here. A cold 539 MB load would consume the whole
        // deadline and the first transcript would stand anyway, having cost 10 seconds.
        const giveUp = new AbortController();
        const rerun = await measure('rerouting', () =>
          withDeadline(clock, rerouteMs, () =>
            uzbek.transcribe(buffer, 'uz', giveUp.signal),
          ),
        );
        // Abandoned: stop it on the host too (see step 4a′).
        if (rerun.kind === 'timedOut') giveUp.abort();
        if (rerun.kind === 'value' && deps.routing.isUsableRerun(rerun.value.raw)) {
          transcribed = rerun.value;
          routed = {
            language: 'uz',
            family: engineFamilyFor('uz'),
            source: 'scriptCheck',
            // The ORIGINAL acoustic mass is carried through, so the record still says
            // what the acoustic pass thought.
            turkicMass: was.turkicMass,
          };
          const settled = routed;
          note((draft) => {
            draft.route = settled;
            draft.errors.push('Transcribed again on the Uzbek engine.');
          });
        } else if (rerun.kind === 'value') {
          const preview = quoteSpoken(prefix40(rerun.value.raw));
          note((draft) => {
            draft.errors.push(
              `the Uzbek engine's second answer was not usable ${preview} — the first ` +
                'transcript stands.',
            );
          });
        } else if (rerun.kind === 'timedOut') {
          note((draft) => {
            draft.errors.push(
              `the Uzbek engine did not answer within ` +
                `${secondsText(rerouteMs)} — the first transcript stands.`,
            );
          });
        } else {
          note((draft) => {
            draft.errors.push(
              `the Uzbek engine refused the second pass: ${rerun.message} — the first ` +
                'transcript stands.',
            );
          });
        }
      } else {
        note((draft) => {
          draft.errors.push(
            'the Uzbek engine is not loaded, so there was nothing to try instead. Turn on ' +
              '"Keep every language loaded", or pin Uzbek, to make this recoverable.',
          );
        });
      }
    }

    // 4b′. Arabic script from a route that was not Arabic (C4, the Mac's D-11). Only Arabic is
    //      written in it, so this is the one unambiguous script signal. Same constraints as 4b:
    //      never a pin, a usable answer, the reroute deadline — and only when Arabic is on.
    const arabicOn = (deps.optionalLanguages?.includes('ar') ?? false) && on('ar');
    if (arabicOn && verdict.kind === 'suspect' && verdict.suggests === 'ar' && routed.language !== 'ar') {
      const arabic = deps.engineFor('arabic');
      const was = routed;
      const engineId = transcribed.engineId;
      note((draft) => {
        draft.errors.push(`route said ${was.language} and ${engineId} answered in Arabic script.`);
      });
      if (was.source === 'pin') {
        note((draft) => {
          draft.errors.push('the language was pinned, so the transcript stands.');
        });
      } else if (arabic !== null) {
        const rerun = await measure('rerouting', () =>
          withDeadline(clock, rerouteMs, () => arabic.transcribe(buffer, 'ar')),
        );
        if (rerun.kind === 'value' && rerun.value.raw.trim() !== '') {
          transcribed = rerun.value;
          routed = reroutedDecision(was, 'ar', 'scriptCheck');
          const settled = routed;
          note((draft) => {
            draft.route = settled;
            draft.errors.push('Transcribed again on the Arabic engine.');
          });
        } else {
          note((draft) => {
            draft.errors.push("the Arabic engine's second answer was not usable — the first transcript stands.");
          });
        }
      }
    }

    const decision = routed;
    const transcript = transcribed;

    // 5. Deterministic normalisation. Never a model — orthography is a lookup, not a guess.
    const cleaned = deps.normalise(transcript.raw, decision.language);
    note((draft) => {
      draft.engineID = transcript.engineId;
      draft.raw = transcript.raw;
      draft.result = cleaned;
    });

    // 5b. THE SECOND HEARD-NOTHING GATE. An engine that heard audio and produced no words
    //     is the most expensive defect this project has had, and the amplitude gate above
    //     cannot catch it: a fan, a door slam or mic hum clears 0.012 while containing no
    //     speech, and whisper answers those with "", " " or "[BLANK_AUDIO]".
    //     Normalisation is a third source — a raw string of punctuation reduces to nothing.
    if (isEmptyTranscript(cleaned)) {
      note((draft) => {
        draft.errors.push(
          `engine ${transcript.engineId} returned no words for ${duration.toFixed(2)}s of ` +
            `audio at peak ${peak.toFixed(4)}`,
        );
        draft.outcome = 'heardNothing';
      });
      transition({ kind: 'heardNothing' });
      return snapshot();
    }

    const wantsPolish =
      options.polisher !== null &&
      options.polishInstructions !== null &&
      options.polisher.supportedLanguages.has(decision.language);

    /**
     * What produces the polished text: the incremental session the stream has been feeding
     * during the hold, when its work still lines up with the finished transcript — then
     * only the tail is left to do — or the whole transcript through the polisher.
     */
    function polishProducer(): () => Promise<string> {
      const polisher = options.polisher as Polisher;
      const instructions = options.polishInstructions as string;
      const whole = (): Promise<string> => polisher.polish(cleaned, decision.language, instructions);
      const incremental = livePolish;
      if (incremental === null) return whole;
      livePolish = null;
      const lined =
        !incremental.broken &&
        incremental.polisher === polisher &&
        incremental.session.language === decision.language &&
        cleaned.startsWith(incremental.prefix);
      if (!lined) {
        incremental.session.cancel();
        return whole;
      }
      return async () => {
        const outcome = await incremental.session.finish(cleaned.slice(incremental.prefix.length));
        incremental.polisher.record(outcome);
        return outcome.text;
      };
    }

    /** Runs the polish under its deadline and applies both guards. Returns what to keep. */
    async function runPolish(): Promise<string | null> {
      const polisher = options.polisher as Polisher;
      const produce = polishProducer();
      transition({ kind: 'polishing' });
      const outcome = await measure('polishing', () =>
        withDeadline(clock, deps.config.polishDeadlineMs, produce),
      );

      // Drained whether the outcome was a value, a failure or a timeout: a fallback that
      // then timed out is exactly the case worth seeing.
      if (options.drainPolishNotes !== undefined) {
        for (const remark of await options.drainPolishNotes()) {
          note((draft) => {
            draft.errors.push(remark);
          });
        }
      }

      if (outcome.kind === 'timedOut') {
        note((draft) => {
          draft.errors.push(
            `polish exceeded ${secondsText(deps.config.polishDeadlineMs)}; raw transcript stands`,
          );
        });
        return null;
      }
      if (outcome.kind === 'failed') {
        note((draft) => {
          draft.errors.push(`polish ${polisher.id} failed: ${outcome.message}; raw transcript stands`);
        });
        return null;
      }

      const polished = outcome.value;
      // TWO INDEPENDENT GUARDS, and Uzbek gets the stricter one FIRST. Length ratio and
      // script cannot see an invented Uzbek word — it is the same length and the same
      // alphabet as the real one — and that is the measured failure.
      if (decision.language === 'uz') {
        const invented = deps.text.checkUzbekPolishGuard(polished, cleaned);
        if (invented !== null) {
          note((draft) => {
            draft.errors.push(invented.reason);
          });
          return null;
        }
      }
      const rejection = deps.text.checkPolishGuard(polished, cleaned, options.polishGuard);
      if (rejection !== null) {
        note((draft) => {
          draft.errors.push(`${rejection.reason}; raw transcript stands`);
        });
        return null;
      }
      return polished;
    }

    /** Writes text and maps the outcome onto a terminal state. `true` iff it landed. */
    async function insertOrFail(text: string): Promise<boolean> {
      transition({ kind: 'inserting' });
      let outcome: InsertionOutcome;
      try {
        outcome = await measure('inserting', () => deps.insert(text));
      } catch (error: unknown) {
        const why = describe(error);
        fail(dictationError.insertionRefused(why), why);
        return false;
      }
      if (outcome.kind === 'refused') {
        fail(dictationError.insertionRefused(outcome.reason), `insertion refused: ${outcome.reason}`);
        return false;
      }
      return true;
    }

    // 6. Insert.
    //
    // `insertAfterPolish` inverts the ordering for a mode whose output is a different
    // SHAPE — a note, a message split across lines. Two reasons, and the second is the
    // one that forced it: showing a paragraph and then swapping it for a checklist is
    // jarring, and replacement is not reliable. Measured in real use, `polish replace
    // refused; raw transcript stands` on FOUR dictations out of EIGHT. The user saw the
    // raw transcript every time and concluded the modes were identical.
    if (options.insertAfterPolish && wantsPolish) {
      const polished = await runPolish();
      const toInsert = polished ?? cleaned;
      if (polished !== null) {
        note((draft) => {
          draft.polished = polished;
        });
      }
      if (!(await insertOrFail(toInsert))) return snapshot();
      note((draft) => {
        draft.outcome = 'done';
      });
      transition({ kind: 'done' });
      return snapshot();
    }

    if (!(await insertOrFail(cleaned))) return snapshot();

    // 7. Polish, if asked. Everything past this point is a BONUS: the text the user
    //    wanted is already in their app, so no failure here can fail the session.
    if (wantsPolish) {
      const polished = await runPolish();
      if (polished !== null) {
        if (polished === cleaned) {
          // A no-op polish is not an error.
        } else {
          // The polished text REPLACES exactly what was inserted, and is never
          // re-normalised or re-capitalised — it was produced from `cleaned`, which has
          // already been through both.
          let replaced: InsertionOutcome;
          try {
            replaced = await deps.replace(cleaned, polished);
          } catch (error: unknown) {
            replaced = { kind: 'refused', reason: describe(error) };
          }
          if (replaced.kind === 'inserted') {
            note((draft) => {
              draft.polished = polished;
            });
          } else {
            note((draft) => {
              draft.errors.push('polish replace refused; raw transcript stands');
            });
          }
        }
      }
    }

    note((draft) => {
      draft.outcome = 'done';
    });
    transition({ kind: 'done' });
    return snapshot();
  }

  // -------------------------------------------------------------------------------
  // Cancel — D-W4
  // -------------------------------------------------------------------------------

  /**
   * A chord during the hold. macOS has no cancel gesture at all (`HotkeyEvent` has only
   * pressed and released); Windows needs one, because holding Right Ctrl and pressing V
   * is the user copying something, not dictating.
   *
   * It drains the arming waiters too: a cancel that arrives while `arm()` is in flight
   * must not leave a key-up parked forever on a session nobody will finish.
   */
  async function cancel(reason: string): Promise<void> {
    await awaitArmingIfNeeded();
    if (state.kind === 'idle' || isTerminal(state)) return;
    try {
      await deps.audio.stop();
    } catch {
      // Nothing is being delivered, so a failed stop has nowhere useful to go.
    }
    discardLive();
    note((draft) => {
      draft.errors.push(`cancelled: ${reason}`);
      draft.outcome = 'failed';
    });
    transition({ kind: 'failed', error: dictationError.captureFailed(`cancelled: ${reason}`) });
    releaseArmingWaiters();
  }

  return {
    get state() {
      return state;
    },
    get transitions() {
      return transitions;
    },
    arm,
    finish,
    cancel,
  };
}

/**
 * The second heard-nothing test: is the normalised transcript nothing but whitespace?
 *
 * Exported because `--check` and the controller both ask it, and a second copy of
 * "trim, then compare to empty" is a second place for it to be got wrong.
 */
export function isEmptyTranscript(text: string): boolean {
  return text.trim().length === 0;
}
