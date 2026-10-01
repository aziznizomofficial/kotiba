// The dictation-language pickers' order: default rank, then recent use, with hysteresis.
// The port of Tests/KotibaCoreTests/LanguageOrderTests.swift — same cases, same numbers.

import { describe, expect, it } from 'vitest';

import type { DictationRecord, Language } from '../../src/contracts/index.js';
import {
  defaultLanguageOrder,
  isClearLead,
  languageCounts,
  orderLanguages,
} from '../../src/core/languages/order.js';

type Code = string;
const order = (codes: Code[], counts: Record<Code, number>, previous: Code[] | null = null): Code[] =>
  orderLanguages<Code>({ languages: codes, counts, previous });

describe('language picker order', () => {
  it('a fresh install lists Uzbek, English, Russian', () => {
    expect(defaultLanguageOrder().slice(0, 3)).toEqual(['uz', 'en', 'ru']);
    expect(orderLanguages({ counts: {} }).slice(0, 3)).toEqual(['uz', 'en', 'ru']);
  });

  it('Arabic and Turkish slot in after Russian, in that order, with no code but the table', () => {
    expect(order(['tr', 'ru', 'ar', 'en', 'uz'], {})).toEqual(['uz', 'en', 'ru', 'ar', 'tr']);
    // A code the table has never heard of goes last, in declaration order.
    expect(order(['zz', 'en', 'yy', 'uz'], {})).toEqual(['uz', 'en', 'zz', 'yy']);
  });

  it('a clear lead moves a language up', () => {
    expect(order(['uz', 'en', 'ru'], { ru: 40, en: 10, uz: 2 })).toEqual(['ru', 'en', 'uz']);
  });

  it('a tie falls back to the default order', () => {
    expect(order(['uz', 'en', 'ru'], { ru: 5, en: 5, uz: 5 })).toEqual(['uz', 'en', 'ru']);
    expect(order(['uz', 'en', 'ru'], { ru: 9, en: 9 })).toEqual(['en', 'ru', 'uz']);
  });

  it('hysteresis: under 3 more, or under 20% more, does not swap', () => {
    expect(order(['uz', 'en', 'ru'], { uz: 10, en: 12 })).toEqual(['uz', 'en', 'ru']); // +2
    expect(order(['uz', 'en', 'ru'], { uz: 100, en: 110 })).toEqual(['uz', 'en', 'ru']); // +10%
    expect(order(['uz', 'en', 'ru'], { uz: 10, en: 13 })).toEqual(['en', 'uz', 'ru']); // +3, +30%
    expect(order(['uz', 'en', 'ru'], { uz: 0, en: 3 })).toEqual(['en', 'uz', 'ru']);
    expect(isClearLead(2, 0)).toBe(false);
  });

  it('what the user last saw is kept until a lead is clear', () => {
    expect(order(['uz', 'en', 'ru'], { uz: 12, en: 10 }, ['en', 'uz', 'ru'])).toEqual(['en', 'uz', 'ru']);
    expect(order(['uz', 'en', 'ru'], { uz: 20, en: 10 }, ['en', 'uz', 'ru'])).toEqual(['uz', 'en', 'ru']);
    const once = order(['uz', 'en', 'ru'], { ru: 30, en: 9 });
    expect(order(['uz', 'en', 'ru'], { ru: 30, en: 9 }, once)).toEqual(once);
  });

  it('a stale previous order with a language added or removed is repaired', () => {
    expect(order(['uz', 'en', 'ru', 'ar'], {}, ['ru', 'gone', 'en'])).toEqual(['uz', 'en', 'ru', 'ar']);
    expect(order(['uz', 'en', 'ru', 'ar'], { ru: 30 }, ['ru', 'gone', 'en'])).toEqual(['ru', 'uz', 'en', 'ar']);
  });
});

describe('language counts', () => {
  const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
  const DAY = 86_400_000;
  const rec = (language: Language, daysAgo: number, outcome = 'done'): DictationRecord =>
    ({
      startedAt: new Date(NOW - daysAgo * DAY).toISOString(),
      outcome,
      route: { language, source: 'pin' },
    }) as unknown as DictationRecord;

  it('counts only successful dictations from the last 30 days', () => {
    const counts = languageCounts(
      [
        ...[1, 1, 1, 2, 3].map((d) => rec('ru', d)),
        rec('ru', 45),
        rec('en', 1, 'failed'),
        rec('en', 1, 'heardNothing'),
        rec('uz', 1),
      ],
      NOW,
    );
    expect(counts).toEqual({ ru: 5, uz: 1 });
  });
});
