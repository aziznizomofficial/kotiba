// Unit tests for the parts of src/core/text the two goldens do not reach:
// the replacement pass, the vocabulary hint, and the polish guards — plus one structural
// test that the scoring normaliser cannot be imported at all.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLISH_GUARD,
  RESTRUCTURING_POLISH_GUARD,
  type Replacement,
} from '../../src/contracts/index.js';
import { scriptOf } from '../../src/core/routing/index.js';
import * as text from '../../src/core/text/index.js';
import {
  applyReplacements,
  capitaliseFirstLetter,
  checkPolishGuard,
  checkUzbekPolishGuard,
  createCapitaliser,
  normaliseForDelivery,
  OKINA,
  TUTUQ,
  vocabularyHint,
} from '../../src/core/text/index.js';

function rule(find: string, replaceWith: string, over: Partial<Replacement> = {}): Replacement {
  return { find, replaceWith, matchCase: false, wholeWord: true, ...over };
}

describe('the module surface', () => {
  it('offers no scoring normaliser for the session to reach', () => {
    // THE TRAP. Two normalisers exist in the Swift and they are not interchangeable: one
    // folds orthography for WER SCORING and strips punctuation and case, the other prepares
    // text for DELIVERY and preserves them. Shipping the scoring one on the insertion path
    // is what made real Uzbek dictations arrive stripped. The wiring audit found the scoring
    // one has no caller on the shipping path at all, so it is not ported — and a function
    // that does not exist cannot be called by mistake.
    const surface = Object.keys(text);
    for (const dead of [
      'normaliseForScoring',
      'clean',
      'foldOrthography',
      'cyrillicToLatin',
      'normaliseReference',
      'normaliseHypothesis',
      'spellNumbers',
    ]) {
      expect(surface).not.toContain(dead);
    }
    expect(surface).toContain('normaliseForDelivery');
  });

  it('names the two marks as different letters', () => {
    expect(OKINA).toBe('ʻ');
    expect(TUTUQ).toBe('ʼ');
    expect(OKINA).not.toBe(TUTUQ);
  });
});

describe('normaliseForDelivery — the apostrophe rule, stated directly', () => {
  it('chooses the mark from the preceding letter, never globally', () => {
    expect(normaliseForDelivery("o'zbek")).toBe(`o${OKINA}zbek`);
    expect(normaliseForDelivery("g'alaba")).toBe(`g${OKINA}alaba`);
    expect(normaliseForDelivery("san'at")).toBe(`san${TUTUQ}at`);
    expect(normaliseForDelivery("ma'no")).toBe(`ma${TUTUQ}no`);
    // Both marks in one string, decided independently.
    expect(normaliseForDelivery("to'g'ri san'at")).toBe(`to${OKINA}g${OKINA}ri san${TUTUQ}at`);
  });

  it('lowercases the preceding letter for the o/g test only, and keeps its case', () => {
    expect(normaliseForDelivery("O'ZBEK")).toBe(`O${OKINA}ZBEK`);
    expect(normaliseForDelivery("San'at")).toBe(`San${TUTUQ}at`);
  });

  it('repairs a wrong mark in either direction', () => {
    expect(normaliseForDelivery(`san${OKINA}at`)).toBe(`san${TUTUQ}at`);
    expect(normaliseForDelivery(`o${TUTUQ}zbek`)).toBe(`o${OKINA}zbek`);
  });

  it('lets no ASCII apostrophe survive inside a word', () => {
    for (const word of ["o'n", "san'at", "to'rt", "ma'lumot"]) {
      expect(normaliseForDelivery(word)).not.toContain("'");
    }
  });

  it('keeps an apostrophe that is punctuation rather than orthography', () => {
    // Letters on BOTH sides or it stays punctuation: otherwise a quotation mark becomes a
    // letter, and the capitaliser — which takes the first isLetter it meets as the
    // sentence's first letter — consumes the quote and capitalises nothing.
    expect(normaliseForDelivery("'salom.' keyingi")).toBe("'salom.' keyingi");
    expect(normaliseForDelivery('‘salom’')).toBe('‘salom’');
  });

  it('leaves an English genitive as an ASCII apostrophe', () => {
    // "Chicago's" becoming "Chicagoʻs" puts an Uzbek letter inside a brand name, which then
    // fails to match in a search box or a URL.
    expect(normaliseForDelivery("Chicago's")).toBe("Chicago's");
    expect(normaliseForDelivery("Samsung's telefoni")).toBe("Samsung's telefoni");
    // A lone trailing `s` is the tell; `s` followed by more word is Uzbek again.
    expect(normaliseForDelivery("bo'sh")).toBe(`bo${OKINA}sh`);
  });

  it('preserves case, punctuation, digits and hyphens', () => {
    const spoken = "Salom! Bugun soat 10:30 da uchrashamiz. Yaxshimi? sa'y-harakat";
    expect(normaliseForDelivery(spoken)).toBe(
      `Salom! Bugun soat 10:30 da uchrashamiz. Yaxshimi? sa${TUTUQ}y-harakat`,
    );
  });

  it('collapses spaces and tabs, keeps newlines, and trims the edges', () => {
    expect(normaliseForDelivery('  salom   \t  dunyo  ')).toBe('salom dunyo');
    expect(normaliseForDelivery('birinchi\nikkinchi')).toBe('birinchi\nikkinchi');
  });

  it('is idempotent', () => {
    for (const s of ["o'n to'rt", "san'at", "Chicago's", 'salom  dunyo', "'salom.'"]) {
      const once = normaliseForDelivery(s);
      expect(normaliseForDelivery(once)).toBe(once);
    }
  });
});

describe('capitaliseFirstLetter', () => {
  it('treats the okina as a letter, so the first letter is the o before it', () => {
    expect(capitaliseFirstLetter(`o${OKINA}zbekiston`)).toBe(`O${OKINA}zbekiston`);
  });

  it('steps over a leading non-letter and leaves it in place', () => {
    expect(capitaliseFirstLetter('"salom')).toBe('"Salom');
    expect(capitaliseFirstLetter('(kotib')).toBe('(Kotib');
  });

  it('returns a word with no letter unchanged', () => {
    expect(capitaliseFirstLetter('123')).toBe('123');
    expect(capitaliseFirstLetter('')).toBe('');
  });
});

describe('the capitaliser', () => {
  it('will not begin a sentence with a modifier letter', () => {
    // Without the exclusion the leading U+02BC is taken as the sentence's first letter,
    // "uppercased" to itself, and the real first letter is left lower case.
    const bare = createCapitaliser([]);
    expect(bare.restore(`${TUTUQ}salom.${TUTUQ} keyingi gap.`)).toBe(
      `${TUTUQ}Salom.${TUTUQ} Keyingi gap.`,
    );
  });

  it('force-capitalises a vocabulary term mid-sentence, in any language', () => {
    const seeded = createCapitaliser(['kotib', 'toshkent']);
    expect(seeded.restore('men kotib bilan toshkent shahriga bordim.')).toBe(
      'Men Kotib bilan Toshkent shahriga bordim.',
    );
    // An Uzbek term inside an English sentence too — the seed is the union across all
    // three languages, not the routed one.
    expect(seeded.restore('i went to toshkent.')).toBe('I went to Toshkent.');
  });

  it('matches vocabulary terms lowercased', () => {
    const seeded = createCapitaliser(['KOTIB']);
    expect(seeded.restore('salom kotib.')).toBe('Salom Kotib.');
  });

  it('never lowercases anything', () => {
    const bare = createCapitaliser([]);
    expect(bare.restore('Salom DUNYO. Yaxshi.')).toBe('Salom DUNYO. Yaxshi.');
  });

  it('does not treat a comma or a digit as a sentence start', () => {
    const bare = createCapitaliser([]);
    expect(bare.restore('salom, dunyo. 10 kishi keldi.')).toBe('Salom, dunyo. 10 kishi keldi.');
  });

  it('skips a closing quote or bracket between a terminator and the next sentence', () => {
    const bare = createCapitaliser([]);
    expect(bare.restore('"salom." keyingi gap.')).toBe('"Salom." Keyingi gap.');
    expect(bare.restore('“salom.” keyingi gap.')).toBe(
      '“Salom.” Keyingi gap.',
    );
  });

  it('returns empty text untouched', () => {
    expect(createCapitaliser([]).restore('')).toBe('');
  });
});

describe('applyReplacements', () => {
  it('returns the text untouched when there are no rules', () => {
    expect(applyReplacements('salom', [])).toBe('salom');
  });

  it('lets the longest match win at each position', () => {
    const rules = [rule('bir', 'ONE'), rule('bir ikki', 'TWO')];
    expect(applyReplacements('bir ikki', rules)).toBe('TWO');
  });

  it('resolves equal-length competitors to the FIRST rule in array order', () => {
    // t01's stub comment claimed the last one wins. The Swift guard is
    // `needle.count > matchedLength` — strictly greater — so a later rule of the same
    // length never displaces an earlier one. This test exists to pin the code, not the prose.
    expect(applyReplacements('bir', [rule('bir', 'A'), rule('bir', 'B')])).toBe('A');
  });

  it('never rescans its own output, so rules cannot chain', () => {
    // a→b then b→c must not silently turn every a into c.
    expect(applyReplacements('a', [rule('a', 'b'), rule('b', 'c')])).toBe('b');
  });

  it('cannot loop on a growing rule', () => {
    expect(applyReplacements('x', [rule('x', 'xx')])).toBe('xx');
  });

  it('matches case-insensitively by default and uses the replacement own case', () => {
    expect(applyReplacements('MARGULAN keldi', [rule('margulan', 'Margʻulan')])).toBe(
      'Margʻulan keldi',
    );
  });

  it('honours matchCase when asked', () => {
    const rules = [rule('kotib', 'Kotib', { matchCase: true })];
    expect(applyReplacements('KOTIB kotib', rules)).toBe('KOTIB Kotib');
  });

  it('treats the string edges as a space for wholeWord', () => {
    expect(applyReplacements('kotib', [rule('kotib', 'Kotib')])).toBe('Kotib');
    expect(applyReplacements('kotibxona', [rule('kotib', 'Kotib')])).toBe('kotibxona');
    expect(applyReplacements('9kotib', [rule('kotib', 'Kotib')])).toBe('9kotib');
  });

  it('matches inside a word when wholeWord is off', () => {
    const rules = [rule('kotib', 'Kotib', { wholeWord: false })];
    expect(applyReplacements('kotibxona', rules)).toBe('Kotibxona');
  });

  it('ignores an empty find', () => {
    expect(applyReplacements('salom', [rule('', 'X')])).toBe('salom');
  });
});

describe('vocabularyHint', () => {
  const EXEMPLAR_UZ = `Bu yerda ismlar to${OKINA}g${OKINA}ri yozilgan.`;

  it('returns null and never an empty string when there is nothing to say', () => {
    // An empty prompt is NOT the same as no prompt to a decoder.
    expect(vocabularyHint([], 'en')).toBeNull();
    expect(vocabularyHint([], 'ru')).toBeNull();
  });

  it('sends the style exemplar for Uzbek even with no terms at all', () => {
    // 20 points of punctuation emission for nothing, and most people never open the
    // vocabulary pane.
    expect(vocabularyHint([], 'uz')).toBe(EXEMPLAR_UZ);
  });

  it('punctuates the term list and appends the exemplar', () => {
    // A bare comma-separated list models unpunctuated writing and the decoder obliges —
    // the full stop is worth 23 points of punctuation emission on the 344-clip set.
    expect(vocabularyHint(['Kotib', 'Toshkent'], 'uz')).toBe(
      `Kotib, Toshkent. ${EXEMPLAR_UZ}`,
    );
    expect(vocabularyHint(['Мирзо'], 'ru')).toBe(
      'Мирзо. Здесь имена написаны правильно.',
    );
  });

  it('gives English a bare punctuated list, because whisper is not the English engine', () => {
    expect(vocabularyHint(['Kotib', 'Telegram'], 'en')).toBe('Kotib, Telegram.');
  });
});

describe('checkUzbekPolishGuard', () => {
  it('accepts a polish that only reorders, requotes, capitalises and punctuates', () => {
    expect(
      checkUzbekPolishGuard('Salom, doʻstim!', 'salom doʼstim'),
    ).toBeNull();
  });

  it('accepts an apostrophe swap for free', () => {
    expect(checkUzbekPolishGuard("do'stim", `do${OKINA}stim`)).toBeNull();
  });

  it('accepts deletions — a correction pass legitimately drops fillers', () => {
    expect(checkUzbekPolishGuard('salom dunyo', 'salom ha ha dunyo')).toBeNull();
  });

  it('rejects an invented word, and names it', () => {
    const verdict = checkUzbekPolishGuard('keçşurun keldim', 'kechqurun keldim');
    expect(verdict?.kind).toBe('inventedWords');
    if (verdict?.kind !== 'inventedWords') throw new Error('unreachable');
    expect(verdict.words).toEqual(['keçşurun']);
    expect(verdict.reason).toContain('introduced 1 word ');
    expect(verdict.reason).toContain('keçşurun');
    expect(verdict.reason).toContain('kept as spoken');
  });

  it('rejects the measured Turkish-pull corruptions', () => {
    // chunki -> chunkı and do'stim -> dostim are the same length and the same script, so
    // the general guard cannot see either.
    expect(checkUzbekPolishGuard('chunkı', 'chunki')?.kind).toBe('inventedWords');
    expect(checkUzbekPolishGuard('dostim', `do${OKINA}stim`)?.kind).toBe('inventedWords');
  });

  it('allows a word split, which is one of the most useful things a polish does', () => {
    expect(checkUzbekPolishGuard('bir-ikki', 'birikki')).toBeNull();
    expect(
      checkUzbekPolishGuard('eshitganmisiz? Ayasi', 'eshitganmisizayasi'),
    ).toBeNull();
  });

  it('will not call a two-character fragment a split', () => {
    // "a" is inside almost everything; allowing it opens the door the rule exists to shut.
    expect(checkUzbekPolishGuard('ki chunki', 'chunki')?.kind).toBe('inventedWords');
  });

  it('pluralises its sentence correctly', () => {
    const verdict = checkUzbekPolishGuard('zzzz yyyy', 'salom');
    if (verdict?.kind !== 'inventedWords') throw new Error('expected a rejection');
    expect(verdict.reason).toContain('introduced 2 words ');
    // Named in a stable order regardless of input order.
    expect(verdict.words).toEqual(['yyyy', 'zzzz']);
  });
});

/**
 * `checkPolishGuard` delegates its script comparison to `scriptOf` in src/core/routing,
 * which is t03's module. The REJECT paths return before reaching it; every ACCEPT path
 * falls through to it, so those cases cannot run until t03 lands.
 *
 * Probed rather than hard-skipped, so the moment t03 merges these tests start running by
 * themselves and nobody has to remember to flip a flag.
 */
const routingIsImplemented = ((): boolean => {
  try {
    scriptOf('salom');
    return true;
  } catch {
    return false;
  }
})();

describe('checkPolishGuard — the length band', () => {
  it('rejects a truncation and reports the ratio to two places', () => {
    const original = 'x'.repeat(100);
    const verdict = checkPolishGuard('x'.repeat(50), original, DEFAULT_POLISH_GUARD);
    expect(verdict?.kind).toBe('truncated');
    if (verdict?.kind !== 'truncated') throw new Error('unreachable');
    expect(verdict.ratio).toBeCloseTo(0.5, 9);
    expect(verdict.reason).toBe('polish deleted content (length ratio 0.50)');
  });

  it('rejects a runaway', () => {
    const original = 'x'.repeat(100);
    const verdict = checkPolishGuard('x'.repeat(300), original, DEFAULT_POLISH_GUARD);
    expect(verdict?.kind).toBe('inflated');
    if (verdict?.kind !== 'inflated') throw new Error('unreachable');
    expect(verdict.reason).toBe('polish ran away (length ratio 3.00)');
  });

  it('rejects a short input that ran away past its absolute allowance', () => {
    // "sounds good" (11 chars) becoming "Hi,\n\nSounds good.\n\nBest,\nAziz" is a ratio of
    // 2.5 — right for a restructuring mode, a runaway for every other one, because a
    // greeting and a sign-off are a fixed cost rather than a proportion.
    const original = 'sounds good';
    const polished = 'Hi,\n\nSounds good.\n\nBest,\nAziz';
    expect(checkPolishGuard(polished, original, DEFAULT_POLISH_GUARD)?.kind).toBe('inflated');
  });

  it('rejects the compressions the older floor rejected, under the default band', () => {
    // The `note` mode measured 0.23 and 0.30 in the wild, which is why it needs its own band.
    const original = 'x'.repeat(100);
    expect(checkPolishGuard('x'.repeat(23), original, DEFAULT_POLISH_GUARD)?.kind).toBe(
      'truncated',
    );
    expect(checkPolishGuard('x'.repeat(30), original, DEFAULT_POLISH_GUARD)?.kind).toBe(
      'truncated',
    );
  });

  describe.skipIf(!routingIsImplemented)('the accept path, which needs t03 scriptOf', () => {
    it('accepts anything when the original is empty', () => {
      expect(checkPolishGuard('anything at all', '', DEFAULT_POLISH_GUARD)).toBeNull();
    });

    it('widens the ceiling on a short input by an absolute allowance', () => {
      const original = 'sounds good';
      const polished = 'Hi,\n\nSounds good.\n\nBest,\nAziz';
      expect(checkPolishGuard(polished, original, RESTRUCTURING_POLISH_GUARD)).toBeNull();
    });

    it('lets the restructuring band through the 0.23 and 0.30 compressions', () => {
      const original = 'x'.repeat(100);
      expect(checkPolishGuard('x'.repeat(23), original, RESTRUCTURING_POLISH_GUARD)).toBeNull();
      expect(checkPolishGuard('x'.repeat(30), original, RESTRUCTURING_POLISH_GUARD)).toBeNull();
    });

    it('counts characters, not UTF-16 units', () => {
      // A run of astral characters is half as long in graphemes as in `.length`; a guard
      // measuring `.length` on one side would call an identical pair a truncation.
      const original = '\u{1F600}'.repeat(40);
      expect(original.length).toBe(80);
      expect(checkPolishGuard(original, original, DEFAULT_POLISH_GUARD)).toBeNull();
    });
  });
});

// C4 / the Mac's D-11: the Arabic script guard. `mixed` passes the general rule both ways, and
// Arabic dictation is often mixed, so a rewrite of mostly-Arabic text must stay mostly Arabic.
describe('checkPolishGuard — Arabic stays Arabic', () => {
  it('refuses a transliteration or an English answer around a Latin name', async () => {
    const { checkPolishGuard } = await import('../../src/core/text/index.js');
    const { DEFAULT_POLISH_GUARD } = await import('../../src/contracts/index.js');
    const original = 'أرسل الملف على Google Drive اليوم';
    expect(checkPolishGuard('Send the file on Google Drive today', original, DEFAULT_POLISH_GUARD)?.kind).toBe('scriptChanged');
    expect(checkPolishGuard('arsil al-malaf ala Google Drive al-yawm', original, DEFAULT_POLISH_GUARD)?.kind).toBe('scriptChanged');
    // Punctuated, still Arabic: accepted.
    expect(checkPolishGuard('أرسل الملف على Google Drive اليوم.', original, DEFAULT_POLISH_GUARD)).toBeNull();
  });
});
