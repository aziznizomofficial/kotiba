// route.json › languageSubsets — the per-language on/off (the Mac's `LanguageSubset`), replayed
// row for row: every decision through `decideRouteInSubset` and through the router end to end,
// and every set's sole route, fallback, last-toggle rule and kept posterior codes.

import { describe, expect, it } from 'vitest';
import type { AcousticClassifier, AudioBuffer, Language, LanguagePosterior } from '../../src/contracts/index.js';
import { DEFAULT_TURKIC_THRESHOLD, ENGINE_FAMILIES, LANGUAGES, SAMPLE_RATE } from '../../src/contracts/index.js';
import {
  canTurnOff,
  createTieredRouter,
  decideRouteInSubset,
  keepsCode,
  languageSubset,
  optionalLanguageRules,
  presetLanguages,
  settingLanguage,
  soleRoute,
  subsetFallback,
  subsetFamilies,
  subsetOptional,
} from '../../src/core/routing/index.js';
import { MASS_DECIMALS, loadGolden, numOrNull, rows, sameNumber, str, strOrNull, type Json } from './golden.js';

const section = loadGolden('route')['languageSubsets'] as Record<string, Json>;

function posteriorOf(row: Record<string, Json>): LanguagePosterior {
  return row['posterior'] as Record<string, number>;
}

function bufferOf(seconds: number): AudioBuffer {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  samples[0] = 0.1;
  return { samples, peak: 0.1, droppedSamples: 0 } as unknown as AudioBuffer;
}

describe('route.json → languageSubsets', () => {
  it('has every count it says', () => {
    expect(rows(section, 'decisions')).toHaveLength(section['decisionCount'] as number);
    expect(rows(section, 'sets')).toHaveLength(section['setCount'] as number);
    expect(section['setCount']).toBe(31);
  });

  for (const [index, row] of rows(section, 'sets').entries()) {
    const languages = row['languages'] as Language[];
    it(`set [${index}] ${languages.join('+')}`, () => {
      const subset = languageSubset(languages);
      expect(ENGINE_FAMILIES.filter((f) => subsetFamilies(subset).has(f))).toEqual(row['families']);
      expect(soleRoute(subset, 'en')).toBe(strOrNull(row, 'soleRouteEnglish'));
      expect(soleRoute(subset, 'ru')).toBe(strOrNull(row, 'soleRouteRussian'));
      expect(subsetFallback(subset, 'en')).toBe(str(row, 'fallbackEnglish'));
      expect(subsetFallback(subset, 'ru')).toBe(str(row, 'fallbackRussian'));
      expect(LANGUAGES.filter((l) => canTurnOff(subset, l))).toEqual(row['canTurnOff']);
      expect(['en', 'ru', 'ar', 'tr', 'uz', 'az', 'kk', 'fr', 'uk'].filter((c) => keepsCode(subset, c))).toEqual(row['keeps']);
    });
  }

  for (const [index, row] of rows(section, 'decisions').entries()) {
    const languages = row['languages'] as Language[];
    it(`[${index}] ${str(row, 'posteriorName')} — on: ${languages.join('+')}`, async () => {
      const subset = languageSubset(languages);
      const rules = optionalLanguageRules(subsetOptional(subset));
      const seconds = row['seconds'] as number;
      const preferring = str(row, 'preferring') as Language;
      const p = posteriorOf(row);
      const decided = decideRouteInSubset(subset, p, seconds, DEFAULT_TURKIC_THRESHOLD, rules, preferring);
      const classifier: AcousticClassifier = { posterior: () => Promise.resolve(p) };
      const routed = await createTieredRouter({
        classifier,
        threshold: DEFAULT_TURKIC_THRESHOLD,
        fallbackLanguage: preferring,
        optional: rules,
        languages: subset,
      }).route(bufferOf(seconds), null);
      // An empty posterior is the router's fallback, not the acoustic tier's; only the pure
      // decision is compared there.
      const checked = Object.keys(p).length === 0 && str(row, 'source') !== 'only' ? [decided] : [decided, routed];
      for (const d of checked) {
        expect(d.language).toBe(str(row, 'language'));
        expect(d.family).toBe(str(row, 'family'));
        expect(d.source).toBe(str(row, 'source'));
        expect(d.candidate ?? null).toBe(strOrNull(row, 'candidate'));
        for (const key of ['turkicMass', 'turkishShare', 'arabicShare'] as const) {
          const expected = numOrNull(row, key);
          const actual = d[key] ?? null;
          if (expected === null) expect(actual).toBeNull();
          else sameNumber(actual as number, expected, MASS_DECIMALS);
        }
      }
    });
  }
});

describe('LanguageSubset helpers', () => {
  it('never empties, and refuses to turn the last language off', () => {
    expect([...languageSubset([]).languages]).toHaveLength(5);
    const one = languageSubset(['en']);
    expect(settingLanguage(one, 'en', false)).toBe(one);
    expect([...settingLanguage(one, 'ru', true).languages].sort()).toEqual(['en', 'ru']);
  });
  it('presets tr/ar only for a Turkish or Arabic system', () => {
    expect([...presetLanguages(['en-US']).languages].sort()).toEqual(['en', 'ru', 'uz']);
    expect(presetLanguages(['tr-TR']).languages.has('tr')).toBe(true);
    expect(presetLanguages(['ar_EG']).languages.has('ar')).toBe(true);
  });
});
