// Statistics arithmetic — the port of Tests/KotibaUITests/UsageStatsTests.swift.

import { describe, expect, it } from 'vitest';

import type { DictationRecord, HistoryEntry } from '../../src/contracts/index.js';
import {
  formatCount,
  formatDuration,
  formatMillis,
  indexBySecond,
  percentile,
  recordForEntry,
  releaseToPasteMillis,
  startOfDay,
  usageStats,
  wordCount,
} from '../../src/core/stats/index.js';

const NOW = new Date(2026, 8, 29, 15, 0, 0).getTime();
const DAY = 86_400_000;

function rec(overrides: Partial<DictationRecord> & { at: number }): DictationRecord {
  const { at, ...rest } = overrides;
  return {
    audioSeconds: 3,
    errors: [],
    outcome: 'done',
    peakAmplitude: 0.3,
    result: 'one two three',
    stageMillis: { arming: 30, transcribing: 200, inserting: 20 },
    startedAt: new Date(at).toISOString().replace(/\.\d+Z$/u, 'Z'),
    ...rest,
  };
}

describe('one dictation, as statistics see it', () => {
  it('key-up to text is every stage except arming', () => {
    expect(releaseToPasteMillis(rec({ at: NOW }))).toBe(220);
    expect(releaseToPasteMillis(rec({ at: NOW, stageMillis: { arming: 10 } }))).toBeNull();
  });

  it('counts the words of what was delivered — the polish when it survived', () => {
    expect(wordCount(rec({ at: NOW, polished: 'a b' }))).toBe(2);
    expect(wordCount(rec({ at: NOW }))).toBe(3);
  });
});

describe('the numbers', () => {
  const records = [
    rec({ at: NOW - 60_000, route: { language: 'en' } as DictationRecord['route'], modeKey: 'super' }),
    rec({ at: NOW - 120_000, route: { language: 'uz' } as DictationRecord['route'], modeKey: 'message' }),
    rec({ at: NOW - DAY, route: { language: 'en' } as DictationRecord['route'], modeKey: 'super' }),
    rec({ at: NOW - 2 * DAY }),
    rec({ at: NOW - 5 * DAY, outcome: 'heardNothing', result: undefined }),
    rec({ at: NOW - 5 * DAY, outcome: 'failed', result: undefined }),
  ];
  const stats = usageStats(records, { now: NOW, days: 7 });

  it('counts dictations, words, today and the outcomes that are not successes', () => {
    expect(stats.dictations).toBe(4);
    expect(stats.words).toBe(12);
    expect(stats.todayDictations).toBe(2);
    expect(stats.todayWords).toBe(6);
    expect(stats.heardNothing).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it('the per-day series covers every day, zeros included', () => {
    expect(stats.perDay).toHaveLength(7);
    expect(stats.perDay.at(-1)).toMatchObject({ date: startOfDay(NOW), dictations: 2 });
    expect(stats.perDay.at(-4)?.dictations).toBe(0);
  });

  it('the streak runs back from today through consecutive days', () => {
    expect(stats.streakDays).toBe(3);
    // At nine in the morning, before the first dictation, yesterday still counts.
    const early = usageStats(records.slice(2), { now: NOW });
    expect(early.streakDays).toBe(2);
  });

  it('splits by language and mode, largest first', () => {
    expect(stats.byLanguage[0]).toMatchObject({ key: 'en', count: 2, fraction: 0.5 });
    expect(stats.byMode.map((share) => share.key)).toEqual(['super', 'message', 'unknown']);
  });

  it('medians and nearest-rank p90', () => {
    expect(stats.latencyMedianMillis).toBe(220);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('time saved is typing at 40 wpm minus speaking and waiting, never negative', () => {
    // 12 words take 18 s to type; 12 s were spoken and 4 × 0.22 s waited.
    expect(stats.savedSeconds).toBeCloseTo(18 - 12 - 0.88, 5);
    expect(usageStats([rec({ at: NOW, audioSeconds: 60 })], { now: NOW }).savedSeconds).toBe(0);
    const lots = usageStats([rec({ at: NOW, result: 'word '.repeat(400).trim(), audioSeconds: 60 })], { now: NOW });
    expect(lots.savedSeconds).toBeCloseTo(600 - 60 - 0.22, 5);
  });

  it('leaves out a stage that ran on fewer than one dictation in twenty', () => {
    const many = Array.from({ length: 40 }, (_, i) => rec({ at: NOW - i * 1000 }));
    many.push(rec({ at: NOW, stageMillis: { loading: 7_800, transcribing: 200 } }));
    const stages = usageStats(many, { now: NOW }).stageMedians.map((stage) => stage.stage);
    expect(stages).not.toContain('loading');
    expect(stages).toContain('transcribing');
  });
});

describe('joining history to the log', () => {
  it('matches on the second, and on a neighbour only when the text agrees', () => {
    const records = [rec({ at: Date.UTC(2026, 8, 29, 10, 0, 5), result: 'hello' })];
    const index = indexBySecond(records);
    const entry = (startedAt: string, result: string): HistoryEntry => ({
      id: '1',
      startedAt,
      language: 'en',
      engineID: 'x',
      raw: result,
      result,
      polished: null,
      audioSeconds: 1,
      audioPath: null,
    });
    expect(recordForEntry(entry('2026-09-29T10:00:05.412Z', 'hello'), index)).not.toBeNull();
    expect(recordForEntry(entry('2026-09-29T10:00:04.999Z', 'hello'), index)).not.toBeNull();
    expect(recordForEntry(entry('2026-09-29T10:00:04.999Z', 'other'), index)).toBeNull();
  });
});

describe('names for numbers', () => {
  it('prints the way the Mac does', () => {
    expect(formatMillis(184)).toBe('184 ms');
    expect(formatMillis(2_100)).toBe('2.1 s');
    expect(formatMillis(12_000)).toBe('12 s');
    expect(formatMillis(null)).toBe('—');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(6.8 * 3600)).toBe('6.8 h');
    expect(formatCount(33_821)).toBe('33 821');
  });
});
