// transcript-check.json — the key-up reading of the unified engine's transcript (session
// step 4a′), asserted row by row, plus proof that the word list is the Swift's own.
//
// The rules a port gets wrong by being reasonable, each with rows here that change answer
// if it is got wrong:
//
//   1. A capitalised word that does not start a sentence is a name and is NOT counted —
//      but one that starts a sentence is, and `I` always is.
//   2. ' and ’ are part of a word only BETWEEN two letters, and ’ folds to ' before lookup.
//   3. Cyrillic is checked before Latin, and a mostly-Cyrillic text is not judged at all.
//   4. No words is `noWords` only when there is no numeric scalar: "25" is a transcript.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { ROUTE_SOURCES, TRANSCRIPT_DOUBTS } from '../../src/contracts/index.js';
import {
  ENGLISH_WORDS,
  ENGLISH_WORDS_COUNT,
  ENGLISH_WORDS_SHA256,
} from '../../src/core/routing/english-words.js';
import {
  NOT_ENGLISH_BELOW,
  READS_AS_ENGLISH_FROM,
  englishLexiconCount,
  isEnglishWord,
  readTranscript,
  readsAsEnglish,
  transcriptDoubt,
} from '../../src/core/routing/index.js';
import {
  PROBABILITY_DECIMALS,
  bool,
  decimalLiterals,
  int,
  loadGolden,
  numOrNull,
  object,
  rows,
  sameNumber,
  str,
  strOrNull,
} from './golden.js';

const golden = loadGolden('transcript-check');
const cases = rows(golden, 'cases');
const lookups = rows(golden, 'lookups');
const constants = object(golden, 'constants');

describe('transcript-check.json', () => {
  it('is the file this build was written against', () => {
    expect(golden['fixture']).toBe('transcript-check');
    expect(cases.length).toBe(golden['count']);
    expect(cases.length).toBe(45);
    expect(lookups.length).toBe(66);
  });

  it('compares by the generator’s own decimal text, not by a tolerance', () => {
    for (const { literal, digits } of decimalLiterals('transcript-check')) {
      expect(Number(literal).toFixed(digits)).toBe(literal);
    }
  });

  it('holds the thresholds the check is built on', () => {
    sameNumber(NOT_ENGLISH_BELOW, constants['notEnglishBelow'] as number, PROBABILITY_DECIMALS);
    sameNumber(READS_AS_ENGLISH_FROM, constants['readsAsEnglishFrom'] as number, PROBABILITY_DECIMALS);
    // And exactly, not just to six places: these are literals, not computed values.
    expect(NOT_ENGLISH_BELOW).toBe(0.7);
    expect(READS_AS_ENGLISH_FROM).toBe(0.5);
  });

  it('holds the Swift’s word list: same count, same sha256 of the newline-joined text', () => {
    const words = ENGLISH_WORDS.split('\n');
    expect(words.length).toBe(int(constants, 'lexiconCount'));
    // Distinct, so the Set the check looks words up in has exactly as many.
    expect(englishLexiconCount()).toBe(int(constants, 'lexiconCount'));
    expect(ENGLISH_WORDS_COUNT).toBe(int(constants, 'lexiconCount'));
    const sha = createHash('sha256').update(ENGLISH_WORDS, 'utf8').digest('hex');
    expect(sha).toBe(str(constants, 'lexiconSHA256'));
    expect(ENGLISH_WORDS_SHA256).toBe(str(constants, 'lexiconSHA256'));
  });

  it('names its doubts and its route source on the wire', () => {
    expect([...TRANSCRIPT_DOUBTS]).toEqual(['noWords', 'notEnglish']);
    expect(ROUTE_SOURCES).toContain('transcriptCheck');
  });

  for (const [index, row] of cases.entries()) {
    const text = str(row, 'text');
    it(`[${index}] ${str(row, 'exercises')}`, () => {
      const reading = readTranscript(text);
      expect(reading.words).toBe(int(row, 'words'));
      expect(reading.latin).toBe(int(row, 'latin'));
      expect(reading.cyrillic).toBe(int(row, 'cyrillic'));
      expect(reading.counted).toBe(int(row, 'counted'));
      expect(reading.known).toBe(int(row, 'known'));
      const coverage = numOrNull(row, 'coverage');
      if (coverage === null) {
        expect(reading.coverage).toBeNull();
      } else {
        expect(reading.coverage).not.toBeNull();
        sameNumber(reading.coverage!, coverage, PROBABILITY_DECIMALS);
      }
      expect(transcriptDoubt(text)).toBe(strOrNull(row, 'doubt'));
      expect(readsAsEnglish(text)).toBe(bool(row, 'readsAsEnglish'));
    });
  }

  for (const row of lookups) {
    const word = str(row, 'word');
    it(`isEnglishWord(${JSON.stringify(word)})`, () => {
      expect(isEnglishWord(word)).toBe(bool(row, 'isEnglishWord'));
    });
  }
});
