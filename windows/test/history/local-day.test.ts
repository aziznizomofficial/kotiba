// Local-day bucketing, across a timezone boundary.
//
// D-W10 names this and path building as the two places a Windows port differs silently.
// Every stored timestamp is ISO-8601 UTC, and the obvious grouping — slice the first
// ten characters — is right in London in winter and wrong everywhere else. For this
// app's audience (UTC+5, Tashkent) the slice happens to agree for most of the day and
// disagrees exactly at the edges, which is the worst possible failure mode: it looks
// correct until someone dictates late.

import { describe, expect, it } from 'vitest';

import type { HistoryEntry } from '../../src/contracts/index.js';
import { groupByLocalDay, localDayKey } from '../../src/core/settings/index.js';

const TASHKENT = 'Asia/Tashkent'; // UTC+5, no daylight saving.
const NEW_YORK = 'America/New_York'; // UTC-5 / UTC-4.
const UTC = 'UTC';

describe('localDayKey', () => {
  it('agrees with the UTC prefix when the zone is UTC', () => {
    expect(localDayKey('2026-08-19T12:34:56Z', UTC)).toBe('2026-08-19');
  });

  // 22:00 UTC on the 18th is 03:00 on the 19th in Tashkent. Slicing the string puts
  // this dictation in yesterday's group while the user is still awake in today.
  it('rolls forward across midnight for a zone ahead of UTC', () => {
    expect('2026-08-18T22:00:00Z'.slice(0, 10)).toBe('2026-08-18');
    expect(localDayKey('2026-08-18T22:00:00Z', TASHKENT)).toBe('2026-08-19');
  });

  // 02:00 UTC on the 19th is 22:00 on the 18th in New York — the mirror-image mistake.
  it('rolls back across midnight for a zone behind UTC', () => {
    expect('2026-08-19T02:00:00Z'.slice(0, 10)).toBe('2026-08-19');
    expect(localDayKey('2026-08-19T02:00:00Z', NEW_YORK)).toBe('2026-08-18');
  });

  it('is stable across a daylight-saving transition', () => {
    // 2026-03-08 is the US spring-forward. 06:30 UTC is 01:30 EST; 07:30 UTC is
    // 03:30 EDT. Both are the 8th locally, and neither may fall out of the group.
    expect(localDayKey('2026-03-08T06:30:00Z', NEW_YORK)).toBe('2026-03-08');
    expect(localDayKey('2026-03-08T07:30:00Z', NEW_YORK)).toBe('2026-03-08');
    // 04:00 UTC is 23:00 on the 7th, still EST.
    expect(localDayKey('2026-03-08T04:00:00Z', NEW_YORK)).toBe('2026-03-07');
  });

  it('pads month and day, so the keys sort lexicographically', () => {
    expect(localDayKey('2026-01-05T12:00:00Z', UTC)).toBe('2026-01-05');
    const keys = ['2026-10-01', '2026-01-05', '2026-02-11'];
    expect([...keys].sort()).toEqual(['2026-01-05', '2026-02-11', '2026-10-01']);
  });

  it('handles a year boundary', () => {
    // 2025-12-31T20:00Z is 2026-01-01T01:00 in Tashkent.
    expect(localDayKey('2025-12-31T20:00:00Z', TASHKENT)).toBe('2026-01-01');
  });

  // A history row with a corrupt date must still be listable: dropping it would lose
  // the text, which is the only part the user cares about.
  it('returns an empty key rather than throwing on an unparseable timestamp', () => {
    expect(localDayKey('not a date', TASHKENT)).toBe('');
    expect(localDayKey('', TASHKENT)).toBe('');
  });
});

describe('groupByLocalDay', () => {
  const rows: readonly Pick<HistoryEntry, 'id' | 'startedAt'>[] = [
    { id: 'late-night', startedAt: '2026-08-18T22:30:00Z' }, // 03:30 on the 19th, Tashkent
    { id: 'morning', startedAt: '2026-08-19T04:00:00Z' }, // 09:00 on the 19th
    { id: 'yesterday', startedAt: '2026-08-18T10:00:00Z' }, // 15:00 on the 18th
  ];

  it('groups by the user local day, not by the stored UTC day', () => {
    const grouped = groupByLocalDay(rows, (row) => row.startedAt, TASHKENT);
    expect(grouped.map((group) => group.day)).toEqual(['2026-08-19', '2026-08-18']);
    expect(grouped[0]?.entries.map((row) => row.id)).toEqual(['late-night', 'morning']);
    expect(grouped[1]?.entries.map((row) => row.id)).toEqual(['yesterday']);
  });

  it('groups the same rows differently in a different zone — which is the whole point', () => {
    const grouped = groupByLocalDay(rows, (row) => row.startedAt, UTC);
    expect(grouped.map((group) => group.day)).toEqual(['2026-08-18', '2026-08-19']);
    expect(grouped[0]?.entries.map((row) => row.id)).toEqual(['late-night', 'yesterday']);
  });

  it('preserves the order it was given inside each day', () => {
    const grouped = groupByLocalDay(
      [
        { id: 'b', startedAt: '2026-08-19T12:00:00Z' },
        { id: 'a', startedAt: '2026-08-19T09:00:00Z' },
      ],
      (row) => row.startedAt,
      UTC,
    );
    expect(grouped[0]?.entries.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('returns nothing for nothing', () => {
    expect(groupByLocalDay([], (row: { startedAt: string }) => row.startedAt, UTC)).toEqual([]);
  });
});
