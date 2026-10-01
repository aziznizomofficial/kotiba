// One row of the dictation history.
//
// Ported from `HistoryEntry` (Sources/KotibaCore/History.swift:21). D-W5 replaces the
// SQLite table + FTS5 index with append-only JSONL and an in-memory index: the
// user-visible behaviour — list, search, copy, delete, export — is identical at the
// sizes this app produces (505 records after weeks of real use), and a native module
// nobody on this project can rebuild or debug is not worth that.
//
// STORAGE DIVERGES. BEHAVIOUR MUST NOT. Two properties of the FTS5 index are load-bearing
// and the in-memory index has to reproduce them:
//
//   * NO STEMMING. macOS pins `tokenize="unicode61"`, never `porter`. Measured: with
//     porter, inserting "bordies" makes a search for "bordie" return a hit. Uzbek is
//     agglutinative — the suffixes ARE the grammar — so English stemming invents matches.
//   * NO DIACRITIC FOLDING (`remove_diacritics 0`). The Uzbek okina U+02BB is a LETTER,
//     not a diacritic. Stripping it merges oʻ with o and gʻ with g; a search for
//     "oʻzbekiston" must find the record and a search for "ozbekiston" must not.

import type { Language } from './language.js';

/**
 * A finished dictation, as kept for the History pane.
 *
 * Field names follow the macOS schema exactly, including `engineID` — this is a
 * persisted wire format, and a support bundle from Windows should read with the same
 * tooling. (The in-memory `TranscriptResult.engineId` is a different, unpersisted type;
 * the one-letter difference is deliberate, not a slip.)
 */
export interface HistoryEntry {
  /** UUID string. Re-inserting the same id updates rather than duplicating. */
  readonly id: string;
  /**
   * ISO-8601 UTC, seconds precision, e.g. `2026-08-19T12:34:56Z` — the same encoding
   * diagnostics uses, and it sorts lexicographically.
   *
   * D-W10 names local-day bucketing as one of exactly two places Windows differs
   * silently: the History pane groups by the user's LOCAL day, so a reader must convert
   * explicitly rather than slicing the first ten characters off this string.
   */
  readonly startedAt: string;
  readonly language: Language;
  readonly engineID: string;
  /** Exactly what the engine emitted, before any normalisation. */
  readonly raw: string;
  /** After deterministic normalisation — THIS is the text that was inserted. */
  readonly result: string;
  /** After the optional polish pass, when one ran and survived the guard. */
  readonly polished: string | null;
  readonly audioSeconds: number;
  /**
   * Relative to the store's audio directory, `null` when the recording was not kept.
   * In the schema, in the type, and never written by any caller — recordings are not
   * retained. Present for parity; do not build a feature on it.
   */
  readonly audioPath: string | null;
}

/** What the user actually sees for an entry: the polish if there is one, else the result. */
export function finalText(entry: HistoryEntry): string {
  return entry.polished ?? entry.result;
}

/** The History pane's page size. Distinct from `settings.historyLimit`, which is retention. */
export const HISTORY_RELOAD_LIMIT = 100;

/** Default page size for `recent` and `search`, matching the macOS signatures. */
export const HISTORY_DEFAULT_LIMIT = 50;

/**
 * Retention: `0` and any negative value keep EVERYTHING, and 0 is the shipped default.
 * A store must return immediately rather than deleting the whole file.
 */
export function keepsEverything(limit: number): boolean {
  return limit <= 0;
}
