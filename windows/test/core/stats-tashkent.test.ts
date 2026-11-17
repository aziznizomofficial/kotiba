// The #418 shape, on Windows (1.0.3 review): a dictation at 03:00 in Tashkent is stored as 22:00Z
// THE PREVIOUS DAY. Home's "Today", the streak, and the Today/Week charts must count it on the
// user's day, never on the UTC day the ISO string starts with.

import { afterAll, beforeAll, expect, it } from 'vitest';

import type { DictationRecord } from '../../src/contracts/index.js';
import { usageStats } from '../../src/core/stats/index.js';

const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Tashkent';
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

function rec(iso: string): DictationRecord {
  return {
    audioSeconds: 2,
    errors: [],
    outcome: 'done',
    peakAmplitude: 0.3,
    result: 'bir ikki uch',
    route: { language: 'uz' } as DictationRecord['route'],
    modeKey: 'super',
    stageMillis: { transcribing: 100 },
    startedAt: iso,
  };
}

it('runs at UTC+5', () => {
  expect(new Date(2026, 10, 17).getTimezoneOffset()).toBe(-300);
});

it('a 03:00 local dictation is today, not yesterday, on Home and in both charts', () => {
  // 17 Nov 2026, 03:10 in Tashkent = 16 Nov 22:10Z. "Now" is 09:00 local on the 17th.
  const records = [rec('2026-11-16T22:10:00Z'), rec('2026-11-15T10:00:00Z')];
  const now = new Date(2026, 10, 17, 9, 0).getTime();
  const home = usageStats(records, { now });
  expect(home.todayDictations).toBe(1);
  // The 15th and the 17th, with nothing on the 16th: a streak of one, not two.
  expect(home.streakDays).toBe(1);

  const today = usageStats(records, { now, period: 'today' });
  expect(today.dictations).toBe(1);
  expect(today.bars[3]?.dictations).toBe(1);

  const week = usageStats(records, { now, period: 'week' });
  expect(week.bars.map((bar) => bar.dictations)).toEqual([0, 0, 0, 0, 1, 0, 1]);
});
