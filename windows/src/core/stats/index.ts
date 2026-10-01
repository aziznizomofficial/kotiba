// What the Statistics page, the Home tiles and the History rows' timings are computed
// from. PURE — the port of `UsageStats` and `UsageModel.record(for:)`
// (Sources/KotibaUI/Statistics.swift), over the same source: the diagnostics log, one
// record per dictation, whether or not it produced text. The log is a rolling window (the
// sink keeps the newest half past 2 MB), so every number here is "over the dictations
// still in the log", and the page says so.
//
// Imported by the renderer too, so it may import nothing but `src/contracts`.

import type { DictationRecord, HistoryEntry } from '../../contracts/index.js';
import { formatDayMonth, formatDecimal, formatMonthYear, t } from '../i18n/index.js';

/** An average adult types around 40 words a minute; the page states the number it uses. */
export const TYPING_WORDS_PER_MINUTE = 40;

/**
 * Key-up to text-in-the-app: every stage the record timed except `arming`, which happens
 * while the key is still held. `loading` counts — a cold model load after key-up is
 * latency the user sat through — and so does `polishing`.
 */
export function releaseToPasteMillis(record: DictationRecord): number | null {
  const values = Object.entries(record.stageMillis)
    .filter(([stage, value]) => stage !== 'arming' && typeof value === 'number')
    .map(([, value]) => value as number);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

/** What ended up in the user's app — the polish when it survived, the transcript otherwise. */
export function finalText(record: DictationRecord): string | null {
  return record.polished ?? record.result ?? null;
}

export function wordCount(record: DictationRecord): number {
  const text = finalText(record);
  if (text === null) return 0;
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

export interface DayCount {
  /** Local midnight, epoch millis. */
  readonly date: number;
  readonly dictations: number;
  readonly words: number;
}

export interface Share {
  readonly key: string;
  readonly count: number;
  readonly fraction: number;
}

export interface StageTime {
  readonly stage: string;
  readonly medianMillis: number;
}

// ---------------------------------------------------------------------------------
// The period
// ---------------------------------------------------------------------------------

/**
 * What the Statistics page covers: today, the last 7 days, the last 30, or everything the
 * log holds. The values are what the `statsPeriod` setting stores — the Mac's `StatsPeriod`.
 */
export const STATS_PERIODS = ['today', 'week', 'month', 'all'] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];
/** The page opens on the last 7 days until the user picks another. */
export const DEFAULT_STATS_PERIOD: StatsPeriod = 'week';

/** A stored choice; an unknown one (a newer build's) reads as the default. */
export function resolveStatsPeriod(stored: string | undefined): StatsPeriod {
  return (STATS_PERIODS as readonly string[]).includes(stored ?? '') ? (stored as StatsPeriod) : DEFAULT_STATS_PERIOD;
}

/** How long one bar of the chart is. */
export type StatsBucketUnit = 'hour' | 'day' | 'week' | 'month';

/** One bar of the period's chart. */
export interface Bar {
  readonly index: number;
  /** Local start of the bar, epoch millis. */
  readonly start: number;
  readonly dictations: number;
  readonly words: number;
  /** The bar "now" is in: this hour, today, this week, this month. */
  readonly isCurrent: boolean;
}

/** Weeks go by months past about six months: 26 weekly bars are the most that stay legible. */
export const WEEKLY_UP_TO_DAYS = 183;

/** Local Monday 00:00 of the week `epochMillis` is in. Weeks start on Monday, as in Uzbekistan and Russia. */
export function startOfWeek(epochMillis: number): number {
  const date = new Date(startOfDay(epochMillis));
  const back = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - back);
  return date.getTime();
}

/** Local 1st, 00:00 of the month `epochMillis` is in. */
export function startOfMonth(epochMillis: number): number {
  const date = new Date(startOfDay(epochMillis));
  date.setDate(1);
  return date.getTime();
}

function addMonths(monthStart: number, months: number): number {
  const date = new Date(monthStart);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

/** Whole local calendar days from `from`'s day to `to`'s — DST-proof (`Date.UTC` of the local fields). */
function calendarDays(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000,
  );
}

/**
 * Where a period starts and how its chart is cut, in local calendar terms — the Mac's
 * `StatsBucketing`.
 *
 * Calendar arithmetic throughout (`setDate`, `setMonth`), never `86_400_000` ms: a day is 23
 * or 25 hours on the two daylight-saving Sundays, and a bar "24 hours after the last" drifts
 * off midnight for the rest of the chart. Hours are bucketed by their hour-of-day number, so
 * a daylight-saving day still has 24 bars, 00 to 23 — the skipped hour an empty bar, the
 * repeated one counted once.
 */
export interface StatsBucketing {
  readonly period: StatsPeriod;
  readonly unit: StatsBucketUnit;
  /** Where each bar starts, oldest first. */
  readonly starts: readonly number[];
  /** The first instant the period covers, or null for all time. */
  readonly from: number | null;
  /** The bar a moment belongs to, or null outside the chart. */
  bucket(epochMillis: number): number | null;
}

export function statsBucketing(period: StatsPeriod, now: number, earliest: number | null): StatsBucketing {
  const today = startOfDay(now);
  const days = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => addDays(from, i));
  if (period === 'today') {
    const starts = Array.from({ length: 24 }, (_, hour) => {
      const date = new Date(today);
      date.setHours(hour, 0, 0, 0);
      return date.getTime();
    });
    return {
      period,
      unit: 'hour',
      starts,
      from: today,
      bucket: (at) => (startOfDay(at) === today ? new Date(at).getHours() : null),
    };
  }
  if (period === 'week' || period === 'month') {
    const count = period === 'week' ? 7 : 30;
    const from = addDays(today, -(count - 1));
    const starts = days(from, count);
    return {
      period,
      unit: 'day',
      starts,
      from,
      bucket: (at) => {
        const index = starts.indexOf(startOfDay(at));
        return index < 0 ? null : index;
      },
    };
  }
  const first = Math.min(earliest ?? now, now);
  const monthly = calendarDays(first, now) > WEEKLY_UP_TO_DAYS;
  const startOf = monthly ? startOfMonth : startOfWeek;
  const next = (start: number): number => (monthly ? addMonths(start, 1) : addDays(start, 7));
  const last = startOf(now);
  const starts: number[] = [];
  for (let cursor = startOf(first); cursor <= last && starts.length < 1_000; cursor = next(cursor)) starts.push(cursor);
  if (starts.length === 0) starts.push(last);
  return {
    period,
    unit: monthly ? 'month' : 'week',
    starts,
    from: null,
    bucket: (at) => {
      const index = starts.indexOf(startOf(at));
      return index < 0 ? null : index;
    },
  };
}

/**
 * The label under one bar, in the interface language: hours as 00–23, days and weeks by their
 * date, months by month and year. Unique within a chart.
 */
export function barLabel(bar: Bar, unit: StatsBucketUnit): string {
  if (unit === 'hour') return String(bar.index).padStart(2, '0');
  if (unit === 'month') return formatMonthYear(new Date(bar.start));
  return formatDayMonth(new Date(bar.start));
}

/** Which bars the axis labels: every third hour; for dates about six, counted back from the latest. */
export function labelledBars(count: number, unit: StatsBucketUnit): number[] {
  const every = unit === 'hour' ? 3 : Math.max(1, Math.ceil(count / 6));
  return Array.from({ length: count }, (_, index) => index).filter((index) =>
    unit === 'hour' ? index % every === 0 : (count - 1 - index) % every === 0,
  );
}

export interface UsageStats {
  readonly dictations: number;
  readonly heardNothing: number;
  readonly failed: number;
  readonly words: number;
  readonly spokenSeconds: number;
  readonly perDay: readonly DayCount[];
  readonly byLanguage: readonly Share[];
  readonly byMode: readonly Share[];
  readonly latencyMedianMillis: number | null;
  readonly latencyP90Millis: number | null;
  readonly stageMedians: readonly StageTime[];
  readonly streakDays: number;
  readonly todayDictations: number;
  readonly todayWords: number;
  /** Epoch millis of the oldest record, or null. */
  readonly earliest: number | null;
  /** Typing time minus speaking and waiting, floored at zero. */
  readonly savedSeconds: number;
  /** The period everything above the streak covers, and its chart. */
  readonly period: StatsPeriod | 'none';
  readonly barUnit: StatsBucketUnit;
  readonly bars: readonly Bar[];
}

/** Nearest-rank percentile of an already-sorted array. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? null;
}

function shares(keys: readonly string[]): Share[] {
  const total = Math.max(1, keys.length);
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count, fraction: count / total }))
    .sort((a, b) => (a.count !== b.count ? b.count - a.count : a.key < b.key ? -1 : 1));
}

/** Local midnight of `epochMillis`. */
export function startOfDay(epochMillis: number): number {
  const date = new Date(epochMillis);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(dayStart: number, days: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** Pipeline order, for "where the time goes". */
const STAGE_ORDER = [
  'finalising',
  'loading',
  'routing',
  'transcribing',
  'rerouting',
  'polishing',
  'inserting',
] as const;

/**
 * Everything the pages show, from the records alone.
 *
 * `days` is how many calendar days the per-day chart covers, ending today. Days with no
 * dictation appear with zero, so the chart's axis is honest about gaps.
 */
export function usageStats(
  all: readonly DictationRecord[],
  options: { readonly now?: number; readonly days?: number; readonly period?: StatsPeriod } = {},
): UsageStats {
  const now = options.now ?? Date.now();
  const days = Math.max(1, options.days ?? 30);
  const allStarts = all.map((record) => Date.parse(record.startedAt)).filter(Number.isFinite);
  const earliest = allStarts.length === 0 ? null : Math.min(...allStarts);
  // The period: what the totals, the splits, the timings and the chart read. Without one,
  // everything the log holds, with no chart of its own (Home's tiles).
  const bucketing = options.period === undefined ? null : statsBucketing(options.period, now, earliest);
  const from = bucketing?.from ?? null;
  const records =
    from === null
      ? all
      : all.filter((record) => {
          const at = Date.parse(record.startedAt);
          return Number.isFinite(at) && at >= from;
        });
  const done = records.filter((record) => record.outcome === 'done');
  const everything = all.filter((record) => record.outcome === 'done');
  const words = done.reduce((sum, record) => sum + wordCount(record), 0);
  const spokenSeconds = done.reduce((sum, record) => sum + record.audioSeconds, 0);

  const counts = (bucketing?.starts ?? []).map(() => ({ dictations: 0, words: 0 }));
  for (const record of done) {
    const at = Date.parse(record.startedAt);
    const index = bucketing === null || !Number.isFinite(at) ? null : bucketing.bucket(at);
    const slot = index === null ? undefined : counts[index];
    if (slot !== undefined) {
      slot.dictations += 1;
      slot.words += wordCount(record);
    }
  }
  const currentBar = bucketing?.bucket(now) ?? null;
  const bars: Bar[] = (bucketing?.starts ?? []).map((start, index) => ({
    index,
    start,
    dictations: counts[index]?.dictations ?? 0,
    words: counts[index]?.words ?? 0,
    isCurrent: index === currentBar,
  }));

  // Per day, over the whole log: Home's today and streak.
  const today = startOfDay(now);
  const byDay = new Map<number, { dictations: number; words: number }>();
  for (const record of everything) {
    const at = Date.parse(record.startedAt);
    if (!Number.isFinite(at)) continue;
    const day = startOfDay(at);
    const current = byDay.get(day) ?? { dictations: 0, words: 0 };
    byDay.set(day, { dictations: current.dictations + 1, words: current.words + wordCount(record) });
  }
  const perDay: DayCount[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = addDays(today, -offset);
    const value = byDay.get(day) ?? { dictations: 0, words: 0 };
    perDay.push({ date: day, dictations: value.dictations, words: value.words });
  }

  // Streak: consecutive days with at least one dictation, ending today — or yesterday, so
  // the streak does not read zero at nine in the morning before the first dictation.
  let cursor = byDay.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (byDay.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  const latencies = done
    .map(releaseToPasteMillis)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const latencyMedianMillis = percentile(latencies, 0.5);

  const stageMedians: StageTime[] = [];
  for (const stage of STAGE_ORDER) {
    const values = done
      .map((record) => record.stageMillis[stage])
      .filter((value): value is number => typeof value === 'number')
      .sort((a, b) => a - b);
    // A stage that ran on fewer than one in twenty dictations (a cold load, a reroute)
    // would put a misleading median on the chart as if it were paid every time.
    const median = percentile(values, 0.5);
    if (values.length * 20 >= Math.max(1, done.length) && median !== null) {
      stageMedians.push({ stage, medianMillis: median });
    }
  }

  const typingSeconds = (words / TYPING_WORDS_PER_MINUTE) * 60;
  const waited = ((latencyMedianMillis ?? 0) / 1000) * done.length;

  return {
    dictations: done.length,
    heardNothing: records.filter((record) => record.outcome === 'heardNothing').length,
    failed: records.filter((record) => record.outcome === 'failed').length,
    words,
    spokenSeconds,
    perDay,
    byLanguage: shares(done.map((record) => record.route?.language ?? '?')),
    byMode: shares(done.map((record) => record.modeKey ?? 'unknown')),
    latencyMedianMillis,
    latencyP90Millis: percentile(latencies, 0.9),
    stageMedians,
    streakDays: streak,
    todayDictations: byDay.get(today)?.dictations ?? 0,
    todayWords: byDay.get(today)?.words ?? 0,
    earliest,
    savedSeconds: Math.max(0, typingSeconds - spokenSeconds - waited),
    period: options.period ?? 'none',
    barUnit: bucketing?.unit ?? 'day',
    bars,
  };
}

/**
 * The diagnostics record for a history entry. History keeps `startedAt` to the second or
 * finer; the log's ISO-8601 dates keep whole seconds — so match on the second, and allow
 * the one either side a rounding difference could land in, but only when the text agrees.
 */
export function recordForEntry(
  entry: HistoryEntry,
  bySecond: ReadonlyMap<number, DictationRecord>,
): DictationRecord | null {
  const second = Math.floor(Date.parse(entry.startedAt) / 1000);
  const exact = bySecond.get(second);
  if (exact !== undefined) return exact;
  for (const neighbour of [second - 1, second + 1]) {
    const candidate = bySecond.get(neighbour);
    if (candidate !== undefined && candidate.result === entry.result) return candidate;
  }
  return null;
}

/** The index `recordForEntry` reads. */
export function indexBySecond(records: readonly DictationRecord[]): Map<number, DictationRecord> {
  const index = new Map<number, DictationRecord>();
  for (const record of records) {
    const at = Date.parse(record.startedAt);
    if (Number.isFinite(at)) index.set(Math.floor(at / 1000), record);
  }
  return index;
}

// ---------------------------------------------------------------------------------
// Names, shared by every page that prints a number
// ---------------------------------------------------------------------------------

export function formatMillis(value: number | null): string {
  if (value === null) return '—';
  if (value >= 10_000) return t('unit.s', { value: formatDecimal(value / 1000, 0) });
  if (value >= 1000) return t('unit.s', { value: formatDecimal(value / 1000, 1) });
  return t('unit.ms', { value: String(Math.round(value)) });
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return t('unit.s', { value: String(total) });
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return t('unit.min', { value: String(minutes) });
  const hours = minutes / 60;
  return t('unit.h', { value: hours < 10 ? formatDecimal(hours, 1) : String(Math.round(hours)) });
}

/** "3 186" — grouped with a thin space, as the Mac's `.grouping(.automatic)` renders it. */
export function formatCount(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
}
