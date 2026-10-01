// The Swift-versus-JavaScript decisions the golden corpus cannot reach.
//
// The fixtures are evidence about the corpus, not about the function. Three character
// classifications sit inside routing that no committed row exercises, and each was
// resolved by running the Swift rather than by reading it. This file records what the
// Swift answered, so a later reader does not have to re-derive it — and so a "tidy-up"
// back to the obvious JavaScript spelling fails here instead of in production.
//
// Reproduce with:
//
//     swift -e 'for s in ["\u{02BB}","\u{2160}"] { print(Character(s).isLetter) }'
//     swift -e 'print("\u{FEFF}a\u{0085}".trimmingCharacters(in: .whitespacesAndNewlines))'

import { describe, expect, it } from 'vitest';
import { isUsableRerun, uzbekCyrillicWordCount } from '../../src/core/routing/index.js';

const NEL = '';
const BOM = '﻿';
const ROMAN_ONE = 'Ⅰ'; // Nl — alphabetic to Swift, not \p{L}
const OKINA = 'ʻ';
const QO = 'қ'; // қ, one of the four Uzbek-Cyrillic letters

describe('Character.isLetter is isAlphabetic, not general category L', () => {
  // `Character.isLetter` is `_firstScalar.properties.isAlphabetic`, which includes Nl.
  // Under `\p{L}` the Roman numeral would split the word in two, and BOTH halves carry
  // a қ, so the distinct-word count would read 2 where Swift reads 1.
  it('keeps an Nl scalar inside a word, so it does not inflate the evidence count', () => {
    expect(uzbekCyrillicWordCount(`${QO}a${ROMAN_ONE}${QO}b`)).toBe(1);
  });

  // The evidence bar is four DISTINCT words. A splitter that is one character too
  // eager reaches four on text that has three.
  it('splits on a non-letter, so a hyphen still makes two words', () => {
    expect(uzbekCyrillicWordCount(`${QO}a-${QO}b`)).toBe(2);
  });
});

describe('trimmingCharacters(in: .whitespacesAndNewlines) is not String.trim()', () => {
  // Foundation strips NEL; JavaScript's own `trim` does not. Under `trim()` this is a
  // one-character answer that survives the plausibility gate and gets pasted over a
  // correct Russian transcript.
  it('strips U+0085 NEL, which JavaScript’s trim leaves in place', () => {
    expect(isUsableRerun(`${NEL} ${NEL}`)).toBe(false);
  });

  // And the other way: Foundation KEEPS the byte-order mark, so a BOM-prefixed answer
  // is not whitespace-only and is judged on what follows it.
  it('keeps U+FEFF, which JavaScript’s trim strips', () => {
    expect(isUsableRerun(BOM)).toBe(true);
    expect(isUsableRerun(`${BOM}[BLANK_AUDIO]`)).toBe(true);
  });
});

describe('the okina clause in the rerun splitter is redundant, and deliberately kept', () => {
  // U+02BB is a modifier letter, so it is alphabetic to both languages. The two
  // splitters differ in DIGITS and in deduplication — not in the okina, whatever the
  // Swift's belt-and-braces `$0 != "\u{02BB}"` suggests.
  it('treats the okina as a word character in both splitters', () => {
    expect(isUsableRerun(`do${OKINA}st `.repeat(6))).toBe(false);
    expect(uzbekCyrillicWordCount(`${QO}a${OKINA}${QO}b`)).toBe(1);
  });

  // The one that IS different: digits split a word for `uzbekCyrillicWordCount` and do
  // not for the rerun splitter. The fixture pins the first half; this pins the second.
  it('keeps digits inside a word for the rerun splitter and not for the other', () => {
    expect(uzbekCyrillicWordCount(`${QO}a1${QO}b`)).toBe(2);
    expect(isUsableRerun('bir1 bir1 bir1 bir1 bir1 bir1')).toBe(false);
  });
});
