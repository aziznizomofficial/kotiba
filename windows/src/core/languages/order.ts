// The order the dictation-language pickers list their languages in: Home's row, the tray's
// Language section, the Languages page and onboarding's languages step. (The interface
// language picker is another list with a fixed order and does not come through here.)
// The port of `LanguageOrder` (Sources/KotibaCore/LanguageOrder.swift), same rule:
//
//   1. DEFAULT — a rank table by language code: Uzbek, English, Russian, Arabic, Turkish. A
//      language added to `LANGUAGES` slots in by its rank; one the table has never heard of
//      sorts after every ranked one, in declaration order.
//   2. USAGE — then by successful dictations in the last 30 days (the Statistics source and
//      window), ties by default order, and a neighbour is only overtaken with a clear lead:
//      at least 3 more dictations AND at least 20% more. So a picker never shuffles over a
//      one-dictation difference.
//
// "Automatic" is not a language; the caller puts it first. PURE — no clock, no file.

import type { DictationRecord, Language } from '../../contracts/index.js';
import { LANGUAGES } from '../../contracts/index.js';
import { statsBucketing } from '../stats/index.js';

/** Default rank, best first, by language code. A new language: put its code here where it should rank (`ar` and `tr` are already listed). */
export const DEFAULT_LANGUAGE_CODES: readonly string[] = ['uz', 'en', 'ru', 'ar', 'tr'];

/** A neighbour is only overtaken with at least this many more dictations… */
export const MINIMUM_LEAD = 3;
/** …and at least this much more than it (1.2 = 20% more). */
export const MINIMUM_RATIO = 1.2;

function rankOf(code: string, declared: readonly string[]): number {
  const ranked = DEFAULT_LANGUAGE_CODES.indexOf(code);
  if (ranked >= 0) return ranked;
  const index = declared.indexOf(code);
  return DEFAULT_LANGUAGE_CODES.length + (index >= 0 ? index : declared.length);
}

/** The languages in the default order — a fresh install, and onboarding. */
export function defaultLanguageOrder<L extends string = Language>(languages: readonly L[] = LANGUAGES as unknown as readonly L[]): L[] {
  return [...languages].sort((a, b) => rankOf(a, languages) - rankOf(b, languages));
}

/** Whether a language with `challenger` dictations clearly leads the one above it with `incumbent`. */
export function isClearLead(challenger: number, incumbent: number): boolean {
  return challenger >= incumbent + MINIMUM_LEAD && challenger >= incumbent * MINIMUM_RATIO;
}

export interface OrderInput<L extends string> {
  /** Successful dictations per language over the window. */
  readonly counts: Readonly<Partial<Record<L, number>>>;
  /** The order the user last saw (`null` on a fresh launch: start from the default). */
  readonly previous?: readonly L[] | null;
  /** Every language, in declaration order. Defaults to `LANGUAGES`. */
  readonly languages?: readonly L[];
}

/** Default order, then usage with hysteresis. */
export function orderLanguages<L extends string = Language>(input: OrderInput<L>): L[] {
  const languages = input.languages ?? (LANGUAGES as unknown as readonly L[]);
  const byDefault = defaultLanguageOrder(languages);
  let list = byDefault;
  if (input.previous) {
    // Where the user last saw it, dropping what is gone and appending what is new.
    const known = input.previous.filter((code) => languages.includes(code));
    list = [...known, ...byDefault.filter((code) => !known.includes(code))];
  }
  const count = (code: L): number => input.counts[code] ?? 0;
  // `below` moves above `above` on a clear lead, or — equal counts — when the default order
  // says so. Each swap strictly improves one of the pair, so this settles; the cap is belt
  // and braces.
  const overtakes = (below: L, above: L): boolean =>
    count(below) === count(above)
      ? rankOf(below, languages) < rankOf(above, languages)
      : isClearLead(count(below), count(above));
  const cap = Math.max(1, list.length * list.length);
  for (let pass = 0, swapped = true; swapped && pass < cap; pass++) {
    swapped = false;
    for (let i = 0; i + 1 < list.length; i++) {
      const above = list[i];
      const below = list[i + 1];
      if (above !== undefined && below !== undefined && overtakes(below, above)) {
        list[i] = below;
        list[i + 1] = above;
        swapped = true;
      }
    }
  }
  return list;
}

/**
 * Successful dictations per language over the last 30 days ending `now` — the Statistics
 * page's source (the diagnostics records) and its "Month" window.
 */
export function languageCounts(records: readonly DictationRecord[], now: number): Partial<Record<Language, number>> {
  const from = statsBucketing('month', now, null).from;
  const counts: Partial<Record<Language, number>> = {};
  for (const record of records) {
    if (record.outcome !== 'done' || record.route === undefined) continue;
    const at = Date.parse(record.startedAt);
    if (!Number.isFinite(at) || (from !== null && at < from)) continue;
    counts[record.route.language] = (counts[record.route.language] ?? 0) + 1;
  }
  return counts;
}
