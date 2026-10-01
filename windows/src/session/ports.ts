// The seams the dictation state machine drives, and nothing else.
//
// WHY THESE EXIST AT ALL. The session is the spine: it is the one module that touches
// all eight others. If it imported them it could not be written until they were done,
// and it could not be tested without eight real implementations — a microphone, 1.1 GB
// of whisper weights and a network endpoint to fail a polish against.
//
// So it is written against `src/contracts` for everything that has an interface there
// (`SttEngine`, `AudioCapture`, `Inserter`, `LanguageRouter`, `Polisher`, the stores),
// and against the function types below for the PURE decisions that live in `src/core`
// and have no interface — routing's script check, text's delivery pipeline, the two
// polish guards, mode resolution. A composition root binds them; the session never
// learns whose function it got, and a test binds a fake in three lines.
//
// EVERY TYPE CROSSING THESE SEAMS IS A CONTRACT TYPE. That is the rule that keeps this
// from becoming a second, private schema that drifts from the one nine modules share.

import type {
  AcousticClassifier,
  LanguageSubset,
  OptionalLanguageRules,
  AppId,
  AppTextFormat,
  BuiltInModeTable,
  Language,
  LanguageRouter,
  Mode,
  ModeDecision,
  Polisher,
  PolishGuardConfig,
  PolishRejection,
  PromptContext,
  Replacement,
  RouteDecision,
  RouteVerdict,
  Settings,
  TranscriptDoubt,
} from '../contracts/index.js';

// ---------------------------------------------------------------------------------
// Routing — `src/core/routing` (t03)
// ---------------------------------------------------------------------------------

/**
 * The routing questions the session asks AFTER a transcript exists: three for step 4b's
 * script check, two for step 4a′'s transcript check.
 *
 * Deliberately NOT `recoveryPlan()`. t03's own comment says the pin exemption lives in
 * the session, and it does: step 4b's four constraints are a session policy over these
 * facts. Taking a pre-baked plan would be a wrapper re-asking the same question
 * one level down — which is exactly how the macOS composite engine re-broke Russian
 * after the readiness fix landed (02-BEHAVIOUR §6.2).
 */
export interface RoutingPort {
  /** Does the emitted script agree with the route? Reports; never re-transcribes. */
  verifyRoute(decision: RouteDecision, transcript: string): RouteVerdict;
  /** Distinct Cyrillic letters that are not Russian letters. For the diagnostics sentence. */
  nonRussianCyrillicCount(text: string): number;
  /**
   * Is the Uzbek engine's second answer plausible enough to replace the first?
   *
   * NOT "is it non-empty". An Uzbek-only fine-tune handed Russian audio is the likeliest
   * source of a repetition loop or a bare `[BLANK_AUDIO]` there is, and pasting either
   * over a correct Russian transcript is worse than the mis-route it was undoing.
   */
  isUsableRerun(text: string): boolean;
  /**
   * Does the unified engine's transcript doubt its own route? `null` — the common case — is
   * English, or Cyrillic, which this does not judge. `noWords` means only that there were
   * none; whether speech was heard is the session's question.
   */
  transcriptDoubt(unifiedTranscript: string): TranscriptDoubt | null;
  /** Is the Uzbek engine's second answer English? Then the audio was, and the doubt was wrong. */
  readsAsEnglish(text: string): boolean;
}

// ---------------------------------------------------------------------------------
// Text delivery — `src/core/text` (t04)
// ---------------------------------------------------------------------------------

/** What `createCapitaliser` returns. Structural, so t04's own type satisfies it. */
export interface Capitaliser {
  restore(text: string): string;
}

/**
 * The live text pipeline and the two polish guards.
 *
 * `deliver` is `forDelivery` → replacements → capitaliser, in that order, and it is the
 * ONLY normaliser on the user's path. The scoring normaliser (`clean`) lowercases and
 * turns `.`, `,` and `?` into spaces; running it here is this project's most expensive
 * historical bug, because it also silently disables the capitaliser, which finds
 * sentence starts by looking for exactly the punctuation `clean` had just removed.
 */
export interface TextPort {
  deliver(options: {
    readonly text: string;
    readonly language: Language;
    readonly replacements: readonly Replacement[];
    /** `null` means do not capitalise. The CALLER decides; this must never re-derive it. */
    readonly capitaliser: Capitaliser | null;
    /** A mode's deterministic clean-up, run after `forDelivery` and before the replacements. */
    readonly cleanUp?: (text: string) => string;
  }): string;

  /** Seeded with the union of vocabulary terms across ALL THREE languages. */
  createCapitaliser(alwaysCapitalised: Iterable<string>): Capitaliser;

  /** The general guard: length ratio and script change. `null` accepts. */
  checkPolishGuard(
    polished: string,
    original: string,
    config: PolishGuardConfig,
  ): PolishRejection | null;

  /**
   * The deterministic half of every built-in mode but Raw — `DictationCleanup` — run
   * between the Uzbek delivery normaliser and the replacements, exactly where the Mac's
   * `normalise` closure runs it. `closesFinalSentence: false` for a stretch that is not yet
   * the end of the dictation. Optional so a test's fake text port need not carry it; the
   * app's is `src/core/modes`'s `cleanUp`.
   */
  cleanUp?(text: string, language: Language, options?: { readonly closesFinalSentence?: boolean }): string;

  /**
   * The Uzbek-only guard, applied BEFORE the general one when the route is Uzbek.
   *
   * It rejects any WORD the polish introduced. Length ratio and script cannot see that
   * failure — an invented Uzbek word is the same length and the same alphabet as the
   * real one — and it is the measured one: 7 of 14 real polishes of real Uzbek changed
   * words the speaker did not say, of which the general guard caught 1.
   */
  checkUzbekPolishGuard(polished: string, original: string): PolishRejection | null;
}

// ---------------------------------------------------------------------------------
// Modes — `src/core/settings` (t05)
// ---------------------------------------------------------------------------------

/**
 * Mode resolution and the credential gate.
 *
 * `isSensitiveApp` is here as its OWN entry and not derived from `resolveMode`'s answer
 * on purpose. The controller asks it a second time before building a polisher, because
 * the first gate protects a password only as long as the forced mode happens to have no
 * prompt — and "happens to" is not a security property. See `THE SECOND GATE` in
 * controller.ts.
 */
export interface ModesPort {
  /** FOUR TIERS: credential gate, tray pick, persisted default, app-follow. */
  resolveMode(options: {
    readonly modes: BuiltInModeTable;
    readonly settings: Settings;
    readonly userPickedModeKey: string | null;
    readonly foregroundApp: AppId | null;
  }): ModeDecision;

  /** `formatForApp(appId) === 'password'`. Exactly one format, nothing else. */
  isSensitiveApp(appId: AppId | null): boolean;

  formatForApp(appId: AppId | null): AppTextFormat;

  /** The rendered system prompt, or `null` for a mode that never polishes. */
  polishInstructions(options: { readonly mode: Mode; readonly context: PromptContext }): string | null;

  promptContext(options: {
    readonly appId: AppId | null;
    readonly appName?: string | null;
    readonly language: string;
    readonly datetime: string;
    readonly locale: string;
    readonly names?: readonly string[];
  }): PromptContext;
}

// ---------------------------------------------------------------------------------
// Polish — `src/polish`, assembled by the composition root
// ---------------------------------------------------------------------------------

/**
 * What the polish layer answers when asked to build a chain.
 *
 * `notConfigured` IS A FLAG SET BY THE COMPONENT THAT KNOWS. Never a regex over an error
 * message: that exact bug shipped in `ai-balance/windows`, where `no GONKA_API_KEY /
 * GONKA_BASE_URL stored` failed the regex `no [A-Z_]+ stored` and a healthy app exited
 * non-zero (D-W10). The whole point of a typed field is that "off" and "broken" are
 * different answers and the UI can say which.
 */
export interface PolishChain {
  /** `null` when nothing can polish. Not an error — the raw transcript stands. */
  readonly polisher: Polisher | null;
  /** True when polish is off or unconfigured. False when it is configured and broken. */
  readonly notConfigured: boolean;
  /** One sentence for the blocker list, or `null` when there is nothing to say. */
  readonly reason: string | null;
  /**
   * Remarks the chain wants on the record — which member actually ran when a composite
   * fell back, and what failed on the way there. Drained whether the polish produced a
   * value, a failure or a timeout, because a fallback that then timed out is exactly the
   * case worth seeing. macOS calls this `PolishEngine.drainNotes()`.
   */
  drainNotes?(): Promise<readonly string[]>;
}

/**
 * One dictation's incremental polish: sentences polished as the transcriber commits them
 * during the hold, the tail at key-up, inserted once. `IncrementalPolish` in `src/polish`.
 */
export interface IncrementalPolishSession {
  readonly language: Language;
  /** Load the model and prefill this mode's prompts. Safe to skip. */
  prepare(): Promise<void>;
  /** Normalised text the transcriber will not revise. */
  commit(segment: string): void;
  /** Everything after the last commit; waits at most its own deadline for the model. */
  finish(tail: string): Promise<{ readonly text: string; readonly notes: readonly string[] }>;
  cancel(): void;
}

/**
 * A polisher that can also run incrementally — a built-in mode's `ModePolisher`. The
 * session feeds it while the key is held, when the transcriber streams.
 */
export interface IncrementalPolisher extends Polisher {
  begin(language: Language): IncrementalPolishSession;
  /** Files an incremental outcome's notes, so `drainNotes` reports them like a whole-text one. */
  record(outcome: { readonly notes: readonly string[] }): void;
}

export function isIncrementalPolisher(polisher: Polisher | null | undefined): polisher is IncrementalPolisher {
  return (
    polisher !== null &&
    polisher !== undefined &&
    typeof (polisher as Partial<IncrementalPolisher>).begin === 'function' &&
    typeof (polisher as Partial<IncrementalPolisher>).record === 'function'
  );
}

export type CreatePolishChain = (request: {
  readonly mode: Mode;
  readonly settings: Settings;
  /** Already read from the credential store. `null` or empty means no key. */
  readonly apiKey: string | null;
}) => PolishChain;

/** The empty chain. What a credential field, a prompt-less mode and `polishEnabled: false` all get. */
export const NO_POLISH: PolishChain = { polisher: null, notConfigured: true, reason: null };

// ---------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------

/**
 * Wall clock and timers, injectable so a test can drive a 10 s reroute deadline in
 * microseconds and so `startedAt` is deterministic in a golden.
 */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Resolves after `ms`. The returned handle cancels it. */
  sleep(ms: number): { readonly promise: Promise<void>; cancel(): void };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms: number) {
    let done: (() => void) | null = null;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    const handle = setTimeout(() => done?.(), ms);
    return {
      promise,
      cancel() {
        clearTimeout(handle);
        done?.();
      },
    };
  },
};

/**
 * Build the three-tier router.
 *
 * The controller owns this rather than receiving a built router, because the router's
 * inputs — the detector, the threshold and the fallback language — all change when
 * settings change, and a router captured once at construction would keep routing on the
 * threshold the app started with.
 */
export type CreateRouter = (options: {
  readonly classifier: AcousticClassifier | null;
  readonly threshold: number;
  readonly fallbackLanguage: Language;
  /** C4: which optional languages are on, and the Mac's thresholds for them. */
  readonly optional?: OptionalLanguageRules;
  /** The dictation languages that are on. Absent: all five. */
  readonly languages?: LanguageSubset;
}) => LanguageRouter;

/** Everything the session and the controller need that is not a `src/contracts` interface. */
export interface SessionPorts {
  readonly routing: RoutingPort;
  readonly createRouter: CreateRouter;
  readonly text: TextPort;
  readonly modes: ModesPort;
  readonly createPolishChain: CreatePolishChain;
  readonly clock?: Clock;
  /** BCP-47, for `{{locale}}`. The composition root knows it; pure code cannot ask. */
  readonly locale?: string;
}

/**
 * Lowering other apps' audio while the key is held — the controller's view of it. The
 * real one is `src/platform/ducking.ts`, installed by the composition root; everything
 * else, every test included, holds `INERT_DUCKING`.
 */
export interface PlaybackDucking {
  duck(level: number): void;
  restore(): void;
}

export const INERT_DUCKING: PlaybackDucking = {
  duck: () => undefined,
  restore: () => undefined,
};
