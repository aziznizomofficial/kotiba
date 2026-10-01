// script-check.json — the post-transcription verifier, asserted row by row.
//
// Three rules a port gets wrong by being reasonable, and each has rows here that change
// answer if it is got wrong:
//
//   1. Only ASCII A–Z/a–z count as Latin and only U+0400–U+04FF as Cyrillic. Under
//      `\p{Script=Latin}`, "Éñš" becomes latin and "ʻʼ" becomes latin, and four
//      decisions move at once.
//   2. The evidence is counted in DISTINCT WORDS, not letters. "Я живу на Қўйлиқ,
//      рядом с Мирзо Улуғбек" has MORE Uzbek-Cyrillic letters than the real mis-route
//      and is not a mis-route.
//   3. `agrees` is one-directional per route, never symmetric.

import { describe, expect, it } from 'vitest';
import { LANGUAGES, UZBEK_CYRILLIC_LETTERS } from '../../src/contracts/index.js';
import {
  looksLikeUzbekInCyrillic,
  nonRussianCyrillicCount,
  scriptAgrees,
  arabicShare,
  scriptOf,
  uzbekCyrillicWordCount,
} from '../../src/core/routing/index.js';
import { MASS_DECIMALS, bool, decimalLiterals, fixed, int, loadGolden, object, rows, str } from './golden.js';

const golden = loadGolden('script-check');
const cases = rows(golden, 'cases');

describe('script-check.json', () => {
  it('is the file this build was written against', () => {
    expect(golden['fixture']).toBe('script-check');
    expect(cases.length).toBe(golden['count']);
    // 45, and the 14 Arabic and Turkish probes of D-11 (C4).
    expect(cases.length).toBe(59);
    // The one decimal column is `arabicShare`, printed at nine places; the comparison below is
    // by that text, which this proves is exact.
    for (const { literal, digits } of decimalLiterals('script-check')) {
      expect(Number(literal).toFixed(digits)).toBe(literal);
    }
  });

  it('holds the constants the check is built on', () => {
    const constants = object(golden, 'constants');
    expect(constants['latinRanges']).toEqual(['U+0041-U+005A', 'U+0061-U+007A']);
    expect(str(constants, 'cyrillicRange')).toBe('U+0400-U+04FF');
    expect(int(constants, 'uzbekCyrillicEvidenceWords')).toBe(4);
    expect(bool(constants, 'letterCountIsCaseInsensitive')).toBe(true);
    expect([...UZBEK_CYRILLIC_LETTERS].sort()).toEqual(constants['uzbekCyrillicLetters']);
    expect(constants['arabicRanges']).toEqual(['U+0600-U+06FF', 'U+0750-U+077F', 'U+08A0-U+08FF', 'U+FB50-U+FDFF', 'U+FE70-U+FEFF']);
    expect(str(constants, 'scriptOfTwoOrMoreScripts')).toBe('mixed');
  });

  for (const [index, row] of cases.entries()) {
    const text = str(row, 'text');
    it(`[${index}] ${str(row, 'exercises')}`, () => {
      expect(scriptOf(text)).toBe(str(row, 'script'));
      expect(fixed(arabicShare(text), MASS_DECIMALS)).toBe(fixed(int(row, 'arabicShare'), MASS_DECIMALS));
      expect(nonRussianCyrillicCount(text)).toBe(int(row, 'nonRussianCyrillicCount'));
      expect(uzbekCyrillicWordCount(text)).toBe(int(row, 'uzbekCyrillicWordCount'));
      expect(looksLikeUzbekInCyrillic(text)).toBe(bool(row, 'looksLikeUzbekInCyrillic'));
      const agrees = object(row, 'agreesWith');
      for (const language of LANGUAGES) {
        expect(scriptAgrees(text, language)).toBe(bool(agrees, language));
      }
    });
  }
});
