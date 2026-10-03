// language-id.json — the language decision of P4 (D-14), asserted section by section: the word
// lists (count and sha256 as generated), the fold, the lookups, what a transcript reads as, what a
// posterior becomes, the prior, the fitted weights, and the policy's answers — route, consider
// (afterFirst, ask; afterSecond, thirdAsk), choose (chooseFirst, choose, chooseRoutedOnly) and
// respell — over every synthetic scenario × enabled set × prior.
//
// The weights the decisions are run with are the TS file's (`FITTED_LANGUAGE_MODEL`), and the
// test first proves they are the fixture's to six decimals: a refit that regenerates one side and
// not the other fails here, by name, before any decision is compared.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { LANGUAGES, engineFamilyFor, type Language } from '../../src/contracts/index.js';
import { ARABIC_WORDS, ARABIC_WORDS_COUNT } from '../../src/core/routing/arabic-words.js';
import { ENGLISH_WORDS } from '../../src/core/routing/english-words.js';
import {
  DEFAULT_ASK_FROM,
  DEFAULT_MAX_ENGINES,
  FITTED_LANGUAGE_MODEL,
  LANGUAGE_PRIOR_SMOOTHING,
  LANGUAGE_PRIOR_WEIGHT,
  LEXICON_SHA256,
  LID_ORDER,
  acousticEvidence,
  acousticFeatures,
  createLanguageIDRouter,
  decideLanguageIDRoute,
  decisionLanguage,
  languageLogPrior,
  languagePolicy,
  lexiconContains,
  lexiconCounts,
  lexiconFold,
  needsRespelling,
  policyChoose,
  policyConsider,
  policyRoute,
  readTranscriptEvidence,
  transcriptFeatures,
  type LanguageDecision,
} from '../../src/core/routing/index.js';
import { RUSSIAN_WORDS, RUSSIAN_WORDS_COUNT } from '../../src/core/routing/russian-words.js';
import { TURKISH_WORDS, TURKISH_WORDS_COUNT } from '../../src/core/routing/turkish-words.js';
import { UZBEK_WORDS, UZBEK_WORDS_COUNT } from '../../src/core/routing/uzbek-words.js';
import {
  PROBABILITY_DECIMALS,
  bool,
  decimalLiterals,
  int,
  loadGolden,
  object,
  rows,
  sameNumber,
  str,
  strOrNull,
  type Json,
} from './golden.js';

const golden = loadGolden('language-id');
const constants = object(golden, 'constants');
const lists = object(golden, 'lists');
const weights = object(golden, 'weights');

/** Numbers in the fixture are `num(_, decimals: 6)` (seconds: 3). */
function sameVector(actual: readonly number[], expected: Json, decimals = PROBABILITY_DECIMALS): void {
  const values = expected as number[];
  expect(actual.length).toBe(values.length);
  actual.forEach((value, i) => sameNumber(value, values[i]!, decimals));
}

/** A posterior object: the same keys, the same six-decimal text. */
function samePosterior(actual: LanguageDecision, expected: Json): void {
  const fixture = expected as Record<string, number>;
  expect(Object.keys(actual).sort()).toEqual(Object.keys(fixture).sort());
  for (const [code, p] of Object.entries(fixture)) sameNumber(actual[code as Language]!, p, PROBABILITY_DECIMALS);
}

const languages = (value: Json): Language[] => value as Language[];

describe('language-id.json', () => {
  it('is the file this build was written against', () => {
    expect(golden['fixture']).toBe('language-id');
    expect(rows(golden, 'folds').length).toBe(18);
    expect(rows(golden, 'lookups').length).toBe(24);
    expect(rows(golden, 'evidence').length).toBe(18);
    expect(rows(golden, 'acousticEvidence').length).toBe(8);
    expect(rows(golden, 'prior').length).toBe(12);
    expect(rows(golden, 'decisions').length).toBe(108);
  });

  it('compares by the generator’s own decimal text, not by a tolerance', () => {
    for (const { literal, digits } of decimalLiterals('language-id')) {
      expect(Number(literal).toFixed(digits)).toBe(literal);
    }
  });

  it('holds the constants and the model order', () => {
    sameNumber(DEFAULT_ASK_FROM, constants['askFrom'] as number, PROBABILITY_DECIMALS);
    expect(DEFAULT_MAX_ENGINES).toBe(int(constants, 'maxEngines'));
    sameNumber(LANGUAGE_PRIOR_WEIGHT, constants['priorWeight'] as number, PROBABILITY_DECIMALS);
    sameNumber(LANGUAGE_PRIOR_SMOOTHING, constants['priorSmoothing'] as number, PROBABILITY_DECIMALS);
    expect(constants['order']).toEqual([...LID_ORDER]);
  });

  it('holds the Swift’s five word lists: same count, same sha256 of the newline-joined text', () => {
    const texts: Record<Language, string> = {
      en: ENGLISH_WORDS,
      uz: UZBEK_WORDS,
      tr: TURKISH_WORDS,
      ru: RUSSIAN_WORDS,
      ar: ARABIC_WORDS,
    };
    const counts = lexiconCounts();
    for (const language of LANGUAGES) {
      const entry = object(lists, language);
      // The set a lookup reads, and the list's own line count: distinct, so the two agree.
      expect(counts[language]).toBe(int(entry, 'count'));
      expect(texts[language].split('\n').length).toBe(int(entry, 'count'));
      const sha = createHash('sha256').update(texts[language], 'utf8').digest('hex');
      expect(sha).toBe(str(entry, 'sha256'));
      expect(LEXICON_SHA256[language]).toBe(str(entry, 'sha256'));
    }
    // And the generated headers say the same.
    expect([UZBEK_WORDS_COUNT, TURKISH_WORDS_COUNT, RUSSIAN_WORDS_COUNT, ARABIC_WORDS_COUNT]).toEqual(
      (['uz', 'tr', 'ru', 'ar'] as const).map((language) => int(object(lists, language), 'count')),
    );
  });

  it('folds every word as the Swift does, scalar by scalar', () => {
    for (const row of rows(golden, 'folds')) {
      expect(lexiconFold(str(row, 'word'), str(row, 'language') as Language), str(row, 'word')).toBe(str(row, 'folded'));
    }
  });

  it('looks every word up as the Swift does', () => {
    for (const row of rows(golden, 'lookups')) {
      const word = str(row, 'word');
      const language = str(row, 'language') as Language;
      expect(lexiconContains(word, language), `${word} in ${language}`).toBe(bool(row, 'contains'));
    }
  });

  it('reads every transcript into the same counts and features', () => {
    for (const row of rows(golden, 'evidence')) {
      const text = str(row, 'text');
      const evidence = readTranscriptEvidence(text);
      expect(evidence.counted, text).toBe(int(row, 'counted'));
      expect(evidence.known, text).toEqual(row['known']);
      expect(evidence.unusable, text).toBe(bool(row, 'unusable'));
      sameVector(transcriptFeatures(evidence), row['features']!);
    }
  });

  it('turns every posterior into the same acoustic features', () => {
    for (const row of rows(golden, 'acousticEvidence')) {
      const posterior = object(row, 'posterior') as unknown as Record<string, number>;
      const evidence = acousticEvidence(posterior, row['seconds'] as number);
      sameVector(acousticFeatures(evidence), row['features']!);
    }
  });

  it('gives the same log-prior for every history and enabled set', () => {
    for (const row of rows(golden, 'prior')) {
      const counts = object(row, 'counts') as unknown as Partial<Record<Language, number>>;
      const enabled = new Set(languages(row['enabled']!));
      for (const [code, expected] of Object.entries(object(row, 'logPrior'))) {
        sameNumber(languageLogPrior(counts, code as Language, enabled), expected as number, PROBABILITY_DECIMALS);
      }
    }
  });

  it('carries the fixture’s fitted weights (language-model-weights.ts is regenerated with the Swift twin)', () => {
    const acoustic = weights['acoustic'] as number[][];
    const transcript = weights['transcript'] as number[][][];
    expect(FITTED_LANGUAGE_MODEL.acoustic.length).toBe(5);
    acoustic.forEach((row, i) => sameVector(FITTED_LANGUAGE_MODEL.acoustic[i]!, row));
    expect(FITTED_LANGUAGE_MODEL.transcript.length).toBe(transcript.length);
    transcript.forEach((source, s) => source.forEach((row, i) => sameVector(FITTED_LANGUAGE_MODEL.transcript[s]![i]!, row)));
  });

  it('decides every scenario as the Swift does: route, consider, ask, choose, respell', () => {
    const texts = rows(golden, 'evidence').map((row) => str(row, 'text'));
    const acoustics = rows(golden, 'acousticEvidence');
    const priors = new Map(
      rows(golden, 'prior').map((row) => [str(row, 'prior'), object(row, 'counts') as unknown as Partial<Record<Language, number>>]),
    );
    let asked = 0;
    for (const row of rows(golden, 'decisions')) {
      const label = `${str(row, 'scenario')} · ${str(row, 'prior')} · ${languages(row['enabled']!).join(',')}`;
      const a = acoustics[int(row, 'acoustic')]!;
      const posterior = object(a, 'posterior') as unknown as Record<string, number>;
      const evidence = Object.keys(posterior).length === 0 ? null : acousticEvidence(posterior, a['seconds'] as number);
      const policy = languagePolicy({ counts: priors.get(str(row, 'prior'))!, enabled: languages(row['enabled']!) });

      const route = policyRoute(policy, evidence);
      samePosterior(route, row['route']!);
      expect(decisionLanguage(route), label).toBe(str(row, 'routeLanguage'));

      const routed = str(row, 'routed') as Language;
      const firstText = texts[int(row, 'firstText')]!;
      const first = [routed, readTranscriptEvidence(firstText)] as const;
      const { decision, ask } = policyConsider(policy, evidence, [first]);
      samePosterior(decision, row['afterFirst']!);
      expect(decisionLanguage(decision), label).toBe(str(row, 'afterFirstLanguage'));
      expect(ask, label).toBe(strOrNull(row, 'ask'));
      expect(needsRespelling(firstText, decisionLanguage(decision)), label).toBe(bool(row, 'respell'));
      samePosterior(policyChoose(policy, evidence, [first]), row['chooseFirst']!);

      if (ask !== null) {
        asked += 1;
        const both = [first, [ask, readTranscriptEvidence(texts[int(row, 'secondText')]!)] as const];
        const again = policyConsider(policy, evidence, both);
        samePosterior(again.decision, row['afterSecond']!);
        expect(again.ask, label).toBe(strOrNull(row, 'thirdAsk'));
        const chosen = policyChoose(policy, evidence, both);
        samePosterior(chosen, row['choose']!);
        expect(decisionLanguage(chosen), label).toBe(str(row, 'chooseLanguage'));
        samePosterior(policyChoose(policy, evidence, both, new Set([engineFamilyFor(routed)])), row['chooseRoutedOnly']!);
      } else {
        expect(row['afterSecond'], label).toBeUndefined();
      }
    }
    // The fixture exercises the ask path, not only its absence.
    expect(asked).toBeGreaterThan(10);
  });

  it('routes a posterior through the policy, and a pin, a sole language and no answer for free', async () => {
    const policy = languagePolicy({ enabled: ['en', 'ru', 'uz'] });
    const decided = decideLanguageIDRoute({ en: 0.9, ru: 0.05, _: 0.05 }, 3, policy);
    expect(decided.source).toBe('acoustic');
    expect(decided.acoustic?.logProbabilities.length).toBe(6);
    expect(Object.keys(decided.probabilities ?? {}).sort()).toEqual(['en', 'ru', 'uz']);
    const audio = { samples: new Float32Array(16_000), droppedSamples: 0 } as never;
    let asked = 0;
    const router = createLanguageIDRouter({
      classifier: {
        posterior: () => {
          asked += 1;
          return Promise.resolve({});
        },
      },
      policy,
      fallback: 'uz',
    });
    expect((await router.route(audio, 'ru')).source).toBe('pin');
    expect(asked).toBe(0);
    const fallback = await router.route(audio, null);
    expect([fallback.language, fallback.source]).toEqual(['uz', 'fallback']);
    expect(asked).toBe(1);
    const only = createLanguageIDRouter({ classifier: { posterior: () => Promise.reject(new Error('never')) }, policy: languagePolicy({ enabled: ['uz'] }) });
    expect((await only.route(audio, null)).source).toBe('only');
  });
});
