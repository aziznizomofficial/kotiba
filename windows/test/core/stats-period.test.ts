// The Statistics page's period — Today, Week, Month, All time — and how each is cut into bars.
// The port of Tests/KotibaUITests/StatsPeriodTests.swift. In New York, on purpose: it has
// daylight saving, and the two days a year a day is not 24 hours long are exactly where "add
// 86,400,000 ms" and "hour = ms since midnight / 3,600,000" break. 2026: the clocks go forward
// at 02:00 on 8 March and back at 02:00 on 1 November.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DictationRecord } from '../../src/contracts/index.js';
import { DEFAULT_SETTINGS } from '../../src/contracts/index.js';
import { setAppLanguage } from '../../src/core/i18n/index.js';
import {
  DEFAULT_STATS_PERIOD,
  STATS_PERIODS,
  barLabel,
  labelledBars,
  resolveStatsPeriod,
  usageStats,
} from '../../src/core/stats/index.js';
import type { StatsPeriod } from '../../src/core/stats/index.js';

const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
  setAppLanguage('en');
});

/** Local wall-clock time in the test's zone. */
const at = (year: number, month: number, day: number, hour = 12, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute).getTime();

function rec(when: number, outcome: DictationRecord['outcome'] = 'done'): DictationRecord {
  return {
    audioSeconds: 2,
    errors: [],
    outcome,
    peakAmplitude: 0.3,
    result: 'one two three',
    route: { language: 'en' } as DictationRecord['route'],
    modeKey: 'super',
    stageMillis: { transcribing: 100 },
    startedAt: new Date(when).toISOString(),
  };
}

const stats = (records: DictationRecord[], now: number, period: StatsPeriod) => usageStats(records, { now, period });
const local = (epoch: number): Date => new Date(epoch);

describe('statistics periods', () => {
  it('runs in a zone with daylight saving', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(300);
    expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(240);
  });

  it('Today is 24 hourly bars, 00 to 23, with the current hour lit', () => {
    const now = at(2026, 9, 29, 14, 20);
    const s = stats([rec(at(2026, 9, 29, 0, 5)), rec(at(2026, 9, 29, 14, 1)), rec(at(2026, 9, 29, 14, 19)), rec(at(2026, 9, 28, 23, 59))], now, 'today');
    expect(s.barUnit).toBe('hour');
    expect(s.bars).toHaveLength(24);
    expect(s.bars[0]?.dictations).toBe(1);
    expect(s.bars[14]?.dictations).toBe(2);
    expect(s.bars.filter((bar) => bar.isCurrent).map((bar) => bar.index)).toEqual([14]);
    expect(s.dictations).toBe(3);
    expect(s.words).toBe(9);
  });

  it('a daylight-saving day still has 24 hourly bars; the skipped hour is empty, the repeated one counted once', () => {
    const spring = stats([rec(at(2026, 3, 8, 1, 30)), rec(at(2026, 3, 8, 3, 30))], at(2026, 3, 8, 20), 'today');
    expect(spring.bars).toHaveLength(24);
    expect([spring.bars[1]?.dictations, spring.bars[2]?.dictations, spring.bars[3]?.dictations]).toEqual([1, 0, 1]);
    const first = at(2026, 11, 1, 1, 30);
    const second = first + 3_600_000;
    expect(local(second).getHours()).toBe(1);
    const fall = stats([rec(first), rec(second), rec(at(2026, 11, 1, 23, 50))], at(2026, 11, 1, 23, 55), 'today');
    expect(fall.bars).toHaveLength(24);
    expect(fall.bars[1]?.dictations).toBe(2);
    expect(fall.bars[23]?.dictations).toBe(1);
    expect(fall.dictations).toBe(3);
  });

  it('Week is the last 7 local days, each bar starting at midnight, across a clock change', () => {
    const now = at(2026, 3, 10, 9);
    const s = stats([rec(at(2026, 3, 3, 23, 59)), rec(at(2026, 3, 4, 0, 0)), rec(at(2026, 3, 8, 23, 30)), rec(at(2026, 3, 10, 8))], now, 'week');
    expect(s.barUnit).toBe('day');
    expect(s.bars).toHaveLength(7);
    for (const bar of s.bars) {
      expect(local(bar.start).getHours()).toBe(0);
      expect(local(bar.start).getMinutes()).toBe(0);
    }
    expect(local(s.bars[0]?.start ?? 0).getDate()).toBe(4);
    expect(s.bars.map((bar) => bar.dictations)).toEqual([1, 0, 0, 0, 1, 0, 1]);
    expect(s.bars.at(-1)?.isCurrent).toBe(true);
    expect(s.dictations).toBe(3);
  });

  it('Month is the last 30 local days', () => {
    const now = at(2026, 11, 3, 10);
    const records = Array.from({ length: 40 }, (_, back) => {
      const date = local(now);
      date.setDate(date.getDate() - back);
      return rec(date.getTime());
    });
    const s = stats(records, now, 'month');
    expect(s.bars).toHaveLength(30);
    expect(s.dictations).toBe(30);
    expect(s.bars.every((bar) => bar.dictations === 1)).toBe(true);
    expect([local(s.bars[0]?.start ?? 0).getMonth(), local(s.bars[0]?.start ?? 0).getDate()]).toEqual([9, 5]);
  });

  it('All time goes by weeks starting Monday, and by months past half a year', () => {
    const now = at(2026, 9, 30, 10);
    const short = stats([rec(at(2026, 8, 20)), rec(now)], now, 'all');
    expect(short.barUnit).toBe('week');
    for (const bar of short.bars) {
      expect(local(bar.start).getDay()).toBe(1);
      expect(local(bar.start).getHours()).toBe(0);
    }
    expect(local(short.bars[0]?.start ?? 0).getDate()).toBe(17);
    expect(short.bars).toHaveLength(7);
    expect(short.bars.reduce((sum, bar) => sum + bar.dictations, 0)).toBe(2);
    expect(short.bars.at(-1)?.isCurrent).toBe(true);

    const long = stats([rec(at(2025, 11, 15)), rec(now)], now, 'all');
    expect(long.barUnit).toBe('month');
    expect(long.bars).toHaveLength(11);
    expect(local(long.bars[0]?.start ?? 0).getDate()).toBe(1);
    expect([long.bars[0]?.dictations, long.bars.at(-1)?.dictations]).toEqual([1, 1]);
  });

  it('an empty log still draws each period\'s axis, all zero', () => {
    for (const period of STATS_PERIODS) {
      const s = stats([], at(2026, 9, 30, 10), period);
      expect(s.bars.length, period).toBeGreaterThan(0);
      expect(s.bars.every((bar) => bar.dictations === 0)).toBe(true);
      expect(s.latencyMedianMillis).toBeNull();
    }
  });

  it('the period drives the totals and splits; the streak and today are the whole log\'s', () => {
    const now = at(2026, 9, 30, 10);
    const records = Array.from({ length: 10 }, (_, back) => {
      const date = local(now);
      date.setDate(date.getDate() - back);
      return rec(date.getTime());
    });
    records.push(rec(at(2026, 9, 30, 9), 'failed'));
    const today = stats(records, now, 'today');
    const week = stats(records, now, 'week');
    const all = stats(records, now, 'all');
    expect([today.dictations, week.dictations, all.dictations]).toEqual([1, 7, 10]);
    expect(today.failed).toBe(1);
    expect([today.streakDays, week.streakDays]).toEqual([10, 10]);
    expect(today.todayDictations).toBe(1);
    expect(week.byLanguage[0]?.count).toBe(7);
    expect(week.earliest).toBe(all.earliest);
  });

  it('is a setting that opens on Week; an unknown one reads as Week', () => {
    expect(DEFAULT_STATS_PERIOD).toBe('week');
    expect(DEFAULT_SETTINGS.statsPeriod).toBe('week');
    expect(resolveStatsPeriod('today')).toBe('today');
    expect(resolveStatsPeriod('fortnight')).toBe('week');
    expect(resolveStatsPeriod(undefined)).toBe('week');
  });

  it('labels bars uniquely in every language, every third hour and the latest date always', () => {
    const now = at(2026, 9, 30, 10);
    for (const language of ['en', 'ru', 'uz-Latn', 'uz-Cyrl'] as const) {
      setAppLanguage(language);
      for (const period of STATS_PERIODS) {
        const s = stats([rec(at(2024, 1, 5)), rec(now)], now, period);
        const labels = s.bars.map((bar) => barLabel(bar, s.barUnit));
        expect(new Set(labels).size, `${language} ${period}: ${labels.join(', ')}`).toBe(labels.length);
        const shown = labelledBars(s.bars.length, s.barUnit);
        expect(shown.length).toBeLessThanOrEqual(8);
        if (s.barUnit !== 'hour') expect(shown.at(-1)).toBe(s.bars.length - 1);
      }
    }
    setAppLanguage('ru');
    const may = stats([rec(at(2026, 5, 3)), rec(at(2026, 9, 30))], at(2026, 11, 30), 'all');
    expect(may.bars.map((bar) => barLabel(bar, 'month'))).toContain('май 26');
    setAppLanguage('en');
    expect(labelledBars(24, 'hour')).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
  });
});
