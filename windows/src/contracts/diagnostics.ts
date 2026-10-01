// The diagnostics line: one JSON object per dictation, appended to diagnostics.jsonl.
//
// Ported from `DiagnosticsStore` (Sources/KotibaCore/DiagnosticsStore.swift:28) and
// `DictationRecord` (Sources/KotibaCore/DictationSession.swift:51).
//
// APPEND-ONLY JSON LINES, newline-terminated (0x0A). Not one JSON document: a crash
// mid-write costs the last line instead of the whole file, and appending never requires
// reading what is already there. One corrupt line costs that line, not the file.

import type { InputDeviceInfo } from './audio.js';
import type { RouteDecision, TranscriptDoubt } from './routing.js';
import type { DictationOutcome, StageMillis } from './state.js';

/**
 * Repeated on EVERY line, not written once as a header — a support bundle is often a
 * single grepped line, and a line that cannot say what it came from is worth less.
 */
export interface DiagnosticsEnvironment {
  /** The app version, or "dev". */
  readonly appVersion: string;
  /** macOS writes the literal "mac". Windows writes "windows". */
  readonly device: string;
  /** BCP-47 or the platform's locale identifier. */
  readonly locale: string;
  /** "major.minor.patch". */
  readonly osVersion: string;
}

/** `device` for this port. */
export const DIAGNOSTICS_DEVICE = 'windows';

/**
 * One dictation, as recorded.
 *
 * `raw` is exactly what the engine emitted; `result` is after deterministic
 * normalisation; `polished` is set ONLY when a polish was accepted AND the replace
 * succeeded. `modeKey` and `polishID` are written by the CONTROLLER after the session
 * returns, not by the session.
 *
 * Every optional field is OMITTED when absent, never written as `null` — the macOS
 * encoder uses `encodeIfPresent`, and a decoder that distinguishes absent from null
 * will read the two differently.
 */
export interface DictationRecord {
  readonly audioSeconds: number;
  readonly engineID?: string;
  /**
   * The microphone this take was recorded from. Optional — absent from records written
   * before it existed and from sources that do not know — and ignored by every reader that
   * does not want it. The NAME never reaches `summary()`.
   */
  readonly inputDevice?: InputDeviceInfo;
  /**
   * An append-only log of human sentences, NOT fatal. A successful record routinely
   * carries clipping notes, reroute notes and polish-rejection notes.
   */
  readonly errors: readonly string[];
  readonly modeKey?: string;
  readonly outcome: DictationOutcome;
  readonly peakAmplitude: number;
  readonly polishID?: string;
  readonly polished?: string;
  readonly raw?: string;
  readonly result?: string;
  /** Omitted when the dictation never got as far as routing. */
  readonly route?: RouteDecision;
  /** Milliseconds per stage. A missing stage did not run, and that is diagnostic. */
  readonly stageMillis: StageMillis;
  /** ISO-8601 UTC, seconds precision, e.g. `2026-08-19T12:34:56Z`. */
  readonly startedAt: string;
  /**
   * The unified engine's transcript doubted its route (session step 4a′), whatever came of
   * it — written even when the Uzbek engine's answer read as English and the first
   * transcript stood, so the rule's real firing rate is in the diagnostics rather than
   * assumed. Omitted when the check did not run or found nothing.
   */
  readonly unifiedDoubt?: TranscriptDoubt;
  /**
   * Milliseconds key-up spent waiting for `TurkishCheck` (C4, the Mac's D-11) — omitted when it
   * did not run (no Turkish candidate).
   */
  readonly turkishCheckWaitMillis?: number;
}

/**
 * THE LINE. Exactly this nesting: `{"environment": {...}, "record": {...}}`.
 *
 * Keys are emitted lexicographically sorted at every level, with no pretty-printing, so
 * two runs of the same dictation produce the same bytes and a diff is meaningful.
 */
export interface DiagnosticsRecord {
  readonly environment: DiagnosticsEnvironment;
  readonly record: DictationRecord;
}

/** The record a session starts from, before anything has happened. */
export const EMPTY_DICTATION_RECORD: Omit<DictationRecord, 'startedAt'> = {
  audioSeconds: 0,
  errors: [],
  outcome: 'incomplete',
  peakAmplitude: 0,
  stageMillis: {},
};

/**
 * The log is trimmed by KEEPING THE NEWEST HALF once it passes this size — never by
 * truncating from the end, and never by deleting the file.
 */
export const DIAGNOSTICS_MAX_BYTES = 2_000_000;

/** How many records `summary()` renders by default. */
export const DIAGNOSTICS_SUMMARY_LIMIT = 40;

/**
 * `summary()` must contain the outcome, the engine id, the stage names and the errors,
 * and must contain NO transcript text — `raw`, `result` and `polished` are never
 * printed. The whole point is a report a user can paste into a chat without pasting
 * everything they have ever dictated.
 */
export const DIAGNOSTICS_SUMMARY_EMPTY = '0 dictations recorded';
