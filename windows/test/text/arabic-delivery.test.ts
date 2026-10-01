// Golden parity for Arabic delivery (the Mac's `ArabicNormaliser.forDelivery` and
// `Orthography.forDelivery`, D-11, C4 §14.3) against fixtures/golden/arabic-delivery.json.
// Exact string equality, as for Uzbek: the marks U+060C/U+061B/U+061F against , ; ? are the
// whole point, and a normalising comparison would erase them.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LANGUAGES, type Language } from '../../src/contracts/index.js';
import { deliver, normaliseArabicForDelivery, orthographyForDelivery } from '../../src/core/text/index.js';

interface ArabicCase {
  readonly in: string;
  readonly out: string;
  readonly changed: boolean;
  readonly idempotent: boolean;
  readonly exercises: string;
  readonly byLanguage: Readonly<Record<Language, string>>;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/golden/arabic-delivery.json', import.meta.url)), 'utf8'),
) as { readonly cases: readonly ArabicCase[] };

describe('normaliseArabicForDelivery — arabic-delivery.json', () => {
  it('reproduces every case byte for byte, idempotently', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
    for (const c of fixture.cases) {
      const actual = normaliseArabicForDelivery(c.in);
      expect({ exercises: c.exercises, out: actual }).toEqual({ exercises: c.exercises, out: c.out });
      expect(actual !== c.in).toBe(c.changed);
      expect(normaliseArabicForDelivery(actual) === actual).toBe(c.idempotent);
    }
  });

  it('orthographyForDelivery gives the Mac’s answer in every language', () => {
    for (const c of fixture.cases) {
      for (const language of LANGUAGES) {
        expect(orthographyForDelivery(c.in, language)).toBe(c.byLanguage[language]);
      }
    }
  });

  it('the session’s deliver runs it for Arabic, before the mode’s clean-up', () => {
    const seen: string[] = [];
    const out = deliver({
      text: 'مرحبا , كيف حالك ?',
      language: 'ar',
      replacements: [],
      capitaliser: null,
      cleanUp: (text) => {
        seen.push(text);
        return text;
      },
    });
    expect(seen).toEqual(['مرحبا، كيف حالك؟']);
    expect(out).toBe('مرحبا، كيف حالك؟');
  });
});
