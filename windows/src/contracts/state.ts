// The two state machines: what one dictation is doing, and what the app is showing.
//
// Ported from `SessionState` (Sources/KotibaCore/DictationSession.swift:16) and
// `DictationController.Status` (Sources/KotibaUI/DictationController.swift:30), mapped in
// docs/windows/inventory/session.md.

import type { InputDeviceInfo } from './audio.js';
import type { DictationError } from './errors.js';

/**
 * The 11 states of one dictation, in declaration order. Three are terminal: `done`,
 * `heardNothing`, `failed`.
 *
 * `heardNothing` is neither success nor failure — the microphone was open and nothing
 * was said. It is a state of its own precisely so it is never delivered as an empty
 * paste reported as success.
 *
 * There is no `loading` state: the cold-engine load happens inside `routing` and is
 * visible only as a `stageMillis.loading` entry. There is no `cancelled` state either —
 * `HotkeyEvent` has only pressed and released, so there is no cancel gesture (02-BEHAVIOUR §3).
 */
export type DictationState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'arming' }
  | { readonly kind: 'capturing' }
  | { readonly kind: 'finalising' }
  | { readonly kind: 'routing' }
  | { readonly kind: 'transcribing' }
  | { readonly kind: 'inserting' }
  | { readonly kind: 'polishing' }
  | { readonly kind: 'done' }
  | { readonly kind: 'heardNothing' }
  | { readonly kind: 'failed'; readonly error: DictationError };

export type DictationStateKind = DictationState['kind'];

/** The three terminal states. `arm()` admits a session that is in any of them. */
export const TERMINAL_STATES: readonly DictationStateKind[] = ['done', 'heardNothing', 'failed'];

export function isTerminal(state: DictationState): boolean {
  return TERMINAL_STATES.includes(state.kind);
}

/**
 * The stages `stageMillis` can carry. A stage MISSING from the map means it did not
 * run, and that absence is itself the answer to most "why was that slow" questions.
 */
export const STAGE_NAMES = [
  'arming',
  'finalising',
  'routing',
  'loading',
  'transcribing',
  'rerouting',
  'polishing',
  'inserting',
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/** Milliseconds per stage. Sparse by design. */
export type StageMillis = Readonly<Partial<Record<StageName, number>>>;

/** The four values `DictationRecord.outcome` ever takes. */
export const DICTATION_OUTCOMES = ['incomplete', 'failed', 'heardNothing', 'done'] as const;
export type DictationOutcome = (typeof DICTATION_OUTCOMES)[number];

/**
 * What the tray icon and the HUD show. Seven cases.
 *
 * THE READINESS-VS-DICTATION SPLIT, which a port must keep: the controller holds TWO
 * independent `DictationStatus` values — `readiness` (what the app is doing to itself:
 * a model loading, a model that would not load) and `dictation` (what this run is
 * doing) — and exposes `isRunning ? dictation : readiness`. They used to be one
 * variable written from six places, and `isBusy` collapsed both into the admission
 * gate, so re-preparing a model refused dictations with "Still finishing the last one."
 * while nothing was finishing and the microphone was free.
 */
export type DictationStatus =
  | { readonly kind: 'idle' }
  /** `what` is a human noun phrase: "English model", "Uzbek model", a model's name. */
  | { readonly kind: 'preparing'; readonly what: string }
  | { readonly kind: 'listening' }
  /** `stage` is a stage word; the shipping app only ever sets "transcribing". */
  | { readonly kind: 'working'; readonly stage: string }
  /** Carries the final text. */
  | { readonly kind: 'succeeded'; readonly text: string }
  /**
   * `quietMic` is set when the take was a real hold that barely registered and this device has
   * not been reported within the hour — the pill then names it (`quietMicPillName`).
   */
  | { readonly kind: 'heardNothing'; readonly quietMic?: InputDeviceInfo }
  /**
   * Carries a full sentence — a `DictationError.message`, never a raw error — for Home, and in
   * `pill` the few words the pill says instead (`dictationErrorHeadline`): the pill is 160
   * pixels of glance. Absent (a model that failed to load, parked in readiness), the pill says
   * only that it did not finish; the sentence is on Home either way. The Mac's `.failed(_, pill:)`.
   */
  | { readonly kind: 'failed'; readonly message: string; readonly pill?: string };

export type DictationStatusKind = DictationStatus['kind'];

/**
 * True for exactly `preparing`, `listening` and `working`.
 *
 * This is NOT the admission gate. Admission is `isRunning` — "is there a session or a
 * run task" — and conflating the two is the shipped bug named above.
 */
export function isBusy(status: DictationStatus): boolean {
  return status.kind === 'preparing' || status.kind === 'listening' || status.kind === 'working';
}

/** The HUD copy, so the shell and the session agree on it without duplicating strings. */
export const STATUS_COPY = {
  idle: 'Ready',
  /** `Loading the ${what}…` */
  preparingPrefix: 'Loading the ',
  preparingSuffix: '…',
  listening: 'Listening',
  /** `${stage capitalised}…` */
  workingSuffix: '…',
  /** Deliberately not phrased as an error. */
  heardNothing: 'I did not hear anything',
  heardNothingDetail: 'Hold the key while you speak, then let go.',
  // `stillRunning` ("Still finishing the last one.") is gone with the refusal it named:
  // since 1.0 a press during processing starts a new take, as on the Mac.
} as const;

/**
 * The 10 s ceiling on step 4b's second transcription, after a script check overturns
 * the route toward Uzbek. Not overridable and there is NO settings key for it — a port
 * must not invent one.
 */
export const REROUTE_DEADLINE_MS = 10_000;

/**
 * …or this much per second of audio, whichever is longer (`Config.rerouteDeadlinePerSecond`,
 * core review 2026-09-30). A fixed ceiling is right for a phrase and wrong for a minute: a
 * second pass over a long recording cannot finish in 10 s, so the misroute it exists to undo
 * stood every time — and the abandoned pass went on holding the Uzbek host's one request
 * slot for the dictations after it. 0.5 s per second is ~3x whisper-medium's measured rate
 * on the Mac; the Windows CPU decode is slower, so this is a floor on what it needs, not a
 * ceiling.
 */
export const REROUTE_DEADLINE_PER_SECOND = 0.5;

/** The reroute ceiling for a recording of `audioSeconds`: `max(floorMs, audio × 0.5 s/s)`. */
export function rerouteDeadlineMs(audioSeconds: number, floorMs: number = REROUTE_DEADLINE_MS): number {
  // `Int(duration * perSecond * 1000)` in the Swift: truncated, not rounded.
  return Math.max(floorMs, Math.trunc(audioSeconds * REROUTE_DEADLINE_PER_SECOND * 1000));
}

/** `DictationSession.Config` — three of the four come from settings. */
export interface SessionConfig {
  /** From `settings.silenceThreshold`. Default 0.012. */
  readonly silenceThreshold: number;
  /** From `max(1, settings.polishTimeoutSeconds)`, in milliseconds. Default 8000. */
  readonly polishDeadlineMs: number;
  /**
   * Always `REROUTE_DEADLINE_MS`. Present so a test can shorten it. The FLOOR of the
   * reroute ceiling: a long recording gets `REROUTE_DEADLINE_PER_SECOND` per second of audio
   * (`rerouteDeadlineMs`).
   */
  readonly rerouteDeadlineMs: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  silenceThreshold: 0.012,
  polishDeadlineMs: 8_000,
  rerouteDeadlineMs: REROUTE_DEADLINE_MS,
};
