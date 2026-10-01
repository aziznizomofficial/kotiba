// Golden parity for src/core/text, against the fixtures t02 generated from the Swift.
//
// The comparison is EXACT STRING EQUALITY. No tolerance, no normalisation — the fixture
// says so in its own `comparison` field, and normalising here would erase the single
// distinction the whole file exists to pin: U+02BB against U+02BC.
//
// `uzbek-scoring.json` is deliberately absent. The wiring audit found the scoring
// normaliser has no caller on the shipping path, t02 did not emit a fixture for it, and
// src/core/text does not implement it. See the header of src/core/text/index.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Language, Replacement } from '../../src/contracts/index.js';
import {
  createCapitaliser,
  deliver,
  normaliseForDelivery,
  sentenceInitialCapitalRate,
} from '../../src/core/text/index.js';

const OKINA = 'ʻ';
const TUTUQ = 'ʼ';

function golden<T>(name: string): T {
  const path = fileURLToPath(new URL(`../../fixtures/golden/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** How many times a single character occurs, counted the way the generator counts. */
function occurrences(text: string, character: string): number {
  let n = 0;
  for (const ch of text) if (ch === character) n += 1;
  return n;
}

interface DeliveryCase {
  readonly in: string;
  readonly out: string;
  readonly origin: string;
  readonly exercises?: string;
  readonly changed: boolean;
  readonly idempotent: boolean;
  readonly okinaOut: number;
  readonly tutuqOut: number;
  readonly asciiApostropheOut: number;
}

interface DeliveryFixture {
  readonly count: number;
  readonly changedCount: number;
  readonly cases: readonly DeliveryCase[];
}

interface CapitaliseCase {
  readonly in: string;
  readonly out: string;
  readonly outWithVocabulary: string;
  readonly origin: string;
  readonly exercises?: string;
  readonly idempotent: boolean;
  readonly rateIn: number;
  readonly rateOut: number;
}

interface PipelineCase {
  readonly in: string;
  readonly language: Language;
  readonly autoCapitalise: boolean;
  readonly modeAutocapitalizeInsert: boolean;
  readonly capitaliserRan: boolean;
  readonly out: string;
}

interface LanguageCase {
  readonly language: Language;
  readonly in: string;
  readonly exercises: string;
  readonly out: string;
  readonly outWithVocabulary: string;
}

interface CapitaliseFixture {
  readonly count: number;
  readonly pipelineCount: number;
  readonly vocabularyUnion: readonly string[];
  readonly cases: readonly CapitaliseCase[];
  readonly pipeline: readonly PipelineCase[];
  readonly constants: { readonly terminators: readonly string[] };
  readonly languageCount: number;
  readonly languageCases: readonly LanguageCase[];
}

const delivery = golden<DeliveryFixture>('uzbek-delivery.json');
const capitalisation = golden<CapitaliseFixture>('capitalise.json');

describe('normaliseForDelivery — uzbek-delivery.json', () => {
  it('has the corpus the fixture claims', () => {
    expect(delivery.cases).toHaveLength(delivery.count);
    expect(delivery.count).toBeGreaterThan(1000);
  });

  it('reproduces every case byte for byte', () => {
    const wrong: { origin: string; exercises?: string; expected: string; actual: string }[] = [];
    for (const c of delivery.cases) {
      const actual = normaliseForDelivery(c.in);
      if (actual !== c.out) {
        wrong.push({
          origin: c.origin,
          ...(c.exercises === undefined ? {} : { exercises: c.exercises }),
          expected: c.out,
          actual,
        });
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(wrong).toHaveLength(0);
  });

  it('agrees with the fixture about which inputs it changes at all', () => {
    let changed = 0;
    for (const c of delivery.cases) {
      const actual = normaliseForDelivery(c.in);
      expect(actual !== c.in).toBe(c.changed);
      if (actual !== c.in) changed += 1;
    }
    expect(changed).toBe(delivery.changedCount);
  });

  it('is idempotent everywhere the fixture says it is', () => {
    for (const c of delivery.cases) {
      const once = normaliseForDelivery(c.in);
      expect(normaliseForDelivery(once) === once).toBe(c.idempotent);
      // Every row in this corpus is idempotent, and that is load-bearing: the navai-uz
      // family emits U+02BB natively in 71.8–76.7% of transcripts, so `forDelivery` runs
      // on text that has already been through it.
      expect(c.idempotent).toBe(true);
    }
  });

  it('emits the exact okina / tutuq / ASCII-apostrophe counts the fixture recorded', () => {
    for (const c of delivery.cases) {
      const actual = normaliseForDelivery(c.in);
      expect({
        okina: occurrences(actual, OKINA),
        tutuq: occurrences(actual, TUTUQ),
        ascii: occurrences(actual, "'"),
      }).toEqual({ okina: c.okinaOut, tutuq: c.tutuqOut, ascii: c.asciiApostropheOut });
    }
  });

  it('leaves no ASCII apostrophe behind except the English genitive', () => {
    // The fixture allows a U+0027 in the output for exactly one reason — "Chicago's" must
    // not become "Chicagoʻs" — so any row with a surviving ASCII apostrophe must be one
    // where the mark was either a genitive or not intra-word at all.
    for (const c of delivery.cases) {
      if (c.asciiApostropheOut === 0) continue;
      expect(normaliseForDelivery(c.in)).toBe(c.out);
    }
  });
});

describe('Capitaliser — capitalise.json', () => {
  const bare = createCapitaliser([]);
  const seeded = createCapitaliser(capitalisation.vocabularyUnion);

  it('has the corpus the fixture claims', () => {
    expect(capitalisation.cases).toHaveLength(capitalisation.count);
    expect(capitalisation.pipeline).toHaveLength(capitalisation.pipelineCount);
  });

  it('reproduces every bare case byte for byte', () => {
    const wrong: { origin: string; expected: string; actual: string }[] = [];
    for (const c of capitalisation.cases) {
      const actual = bare.restore(c.in);
      if (actual !== c.out) wrong.push({ origin: c.origin, expected: c.out, actual });
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(wrong).toHaveLength(0);
  });

  it('reproduces every vocabulary-seeded case byte for byte', () => {
    // The union across ALL THREE languages, which is what DictationController builds. An
    // Uzbek term is force-capitalised inside an English sentence too, so "capitalise
    // sentence starts" alone diverges the moment a user adds one vocabulary word.
    const wrong: { origin: string; expected: string; actual: string }[] = [];
    for (const c of capitalisation.cases) {
      const actual = seeded.restore(c.in);
      if (actual !== c.outWithVocabulary) {
        wrong.push({ origin: c.origin, expected: c.outWithVocabulary, actual });
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(wrong).toHaveLength(0);
  });

  it('proves the seed is doing work, not just riding sentence starts', () => {
    const divergent = capitalisation.cases.filter((c) => c.out !== c.outWithVocabulary);
    expect(divergent.length).toBeGreaterThan(0);
  });

  it('is idempotent where the fixture says it is', () => {
    for (const c of capitalisation.cases) {
      const once = bare.restore(c.in);
      expect(bare.restore(once) === once).toBe(c.idempotent);
    }
  });

  it('changes nothing except letter case', () => {
    for (const c of capitalisation.cases) {
      for (const out of [bare.restore(c.in), seeded.restore(c.in)]) {
        expect(out).toHaveLength(c.in.length);
        expect(out.toLowerCase()).toBe(c.in.toLowerCase());
      }
    }
  });

  it('reproduces the sentence-initial capital rate in and out', () => {
    for (const c of capitalisation.cases) {
      expect(sentenceInitialCapitalRate(c.in)).toBeCloseTo(c.rateIn, 9);
      expect(sentenceInitialCapitalRate(bare.restore(c.in))).toBeCloseTo(c.rateOut, 9);
    }
    expect(sentenceInitialCapitalRate('')).toBe(1);
  });
});

// D-11 / C4: the same restore told the dictation's language. Turkish capitalises through its
// locale (i → İ, ı → I); Arabic has no case and comes back untouched, Latin word and all.
describe('Capitaliser with a language — capitalise.json languageCases', () => {
  const bare = createCapitaliser([]);
  const seeded = createCapitaliser(capitalisation.vocabularyUnion);

  it('has the probes the fixture claims, Turkish and Arabic among them', () => {
    expect(capitalisation.languageCases).toHaveLength(capitalisation.languageCount);
    const languages = new Set(capitalisation.languageCases.map((c) => c.language));
    expect(languages.has('tr') && languages.has('ar')).toBe(true);
    expect(capitalisation.constants.terminators).toContain('\u061F');
  });

  it.each(capitalisation.languageCases.map((c) => [c.exercises, c] as const))('%s', (_label, c) => {
    expect(bare.restore(c.in, c.language)).toBe(c.out);
    expect(seeded.restore(c.in, c.language)).toBe(c.outWithVocabulary);
  });
});

describe('deliver — the composed pipeline in capitalise.json', () => {
  const seeded = createCapitaliser(capitalisation.vocabularyUnion);
  const noReplacements: readonly Replacement[] = [];

  it('reproduces every gate combination byte for byte', () => {
    const wrong: { row: PipelineCase; actual: string }[] = [];
    for (const row of capitalisation.pipeline) {
      // The gate is the caller's, exactly as in DictationController: BOTH
      // settings.autoCapitalise AND mode.autocapitalizeInsert must be true.
      const capitalises = row.autoCapitalise && row.modeAutocapitalizeInsert;
      expect(capitalises).toBe(row.capitaliserRan);

      const actual = deliver({
        text: row.in,
        language: row.language,
        replacements: noReplacements,
        capitaliser: capitalises ? seeded : null,
      });
      if (actual !== row.out) wrong.push({ row, actual });
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(wrong).toHaveLength(0);
  });

  it('honours a false mode flag even when the text is screaming for capitals', () => {
    // The flag was once declared, encoded, decoded and read by NOTHING, so a mode that
    // shipped it false had every sentence-initial letter capitalised anyway by the layer
    // beneath it.
    const uzbek = capitalisation.pipeline.filter((r) => r.language === 'uz');
    const off = uzbek.filter((r) => !r.capitaliserRan);
    expect(off.length).toBeGreaterThan(0);
    for (const row of off) {
      expect(
        deliver({
          text: row.in,
          language: 'uz',
          replacements: noReplacements,
          capitaliser: null,
        }),
      ).toBe(normaliseForDelivery(row.in));
    }
  });

  it('normalises for Uzbek routes and only for Uzbek routes', () => {
    const byInput = new Map<string, Map<Language, string>>();
    for (const row of capitalisation.pipeline) {
      if (row.capitaliserRan) continue;
      let langs = byInput.get(row.in);
      if (langs === undefined) {
        langs = new Map();
        byInput.set(row.in, langs);
      }
      langs.set(row.language, row.out);
    }
    let sawDifference = false;
    for (const [input, langs] of byInput) {
      expect(langs.get('en')).toBe(input);
      expect(langs.get('ru')).toBe(input);
      expect(langs.get('uz')).toBe(normaliseForDelivery(input));
      if (langs.get('uz') !== input) sawDifference = true;
    }
    expect(sawDifference).toBe(true);
  });
});
