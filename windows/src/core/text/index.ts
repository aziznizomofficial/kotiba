// src/core/text — the Uzbek delivery normaliser and the capitaliser.  OWNER: t04
//
// PURE. No Electron, no Node builtins, no OS.
//
// THERE IS ONLY ONE NORMALISER HERE, AND THAT IS THE POINT. The Swift original carries
// three: `forDelivery`, the scoring normaliser `clean` (plus `normaliseReference` /
// `normaliseHypothesis` / `cyrillicToLatin` / `spellNumbers` beneath it), and a half-way
// `foldOrthography`. The wiring audit (docs/windows/inventory/critic-wiring.md:26) found
// that only `forDelivery` has a caller on the shipping path: `clean` is reached solely
// from the unshipped `kotiba-probe` WER tool, and `foldOrthography` from nothing at all.
//
// So the scoring normaliser is NOT PORTED, and this is a deliberate structural choice
// rather than an omission. Running it on delivered text is this project's most expensive
// shipped bug — it lowercases and turns `.`, `,` and `?` into spaces, which ALSO makes the
// capitaliser look broken, because the capitaliser finds sentence starts by looking for
// exactly the punctuation that was just removed. A normaliser that does not exist cannot
// be imported by mistake. If Windows ever needs WER numbers, that belongs in a measurement
// tool outside src/, not in the module the session imports.
//
// OKINA U+02BB AND TUTUQ BELGISI U+02BC ARE DIFFERENT LETTERS. The rule is the single
// character immediately before, lowercased: `o` or `g` → U+02BB, anything else → U+02BC.
// Never a global replace. Getting it backwards spells `sanʼat` as `sanʻat`, which is
// visibly wrong to an Uzbek reader and invisible to anyone testing in ASCII.
//
// GRAPHEME CLUSTERS, NOT CODE POINTS. Swift's `String` iterates extended grapheme
// clusters (UAX #29) and every algorithm below was written against that. The difference
// is observable and the goldens pin it: U+200C ZWNJ and U+200D ZWJ have
// Grapheme_Cluster_Break Extend/ZWJ, so they fuse onto the preceding letter and SURVIVE
// `forDelivery`, while U+200B, U+2060, U+FEFF and U+00AD are Control, stand alone as their
// own cluster, and are dropped. A port that iterates code points drops all six and fails
// `uzbek-delivery.json`. Hence `Intl.Segmenter` throughout — it is ECMA-402, not an OS API.

import type {
  Language,
  PolishGuardConfig,
  PolishRejection,
  Replacement,
  Script,
} from '../../contracts/index.js';
import {
  APOSTROPHE_FAMILY,
  RATIO_FLOOR_LENGTH,
  UZBEK_GUARD_MINIMUM_SPLIT_LENGTH,
  UZBEK_GUARD_NAMED_WORDS,
} from '../../contracts/index.js';
import { arabicShare, isArabicLetter, scriptOf } from '../routing/index.js';

// EVERY confusable or invisible character in this file is written as a \uXXXX escape, for
// the reason the fixture states in its own `escapes` note: the whole point is the
// distinction between U+02BB and U+02BC, and a literal glyph in a UTF-8 source file is one
// editor, one core.autocrlf, one NFC pass away from being the other one.

/** U+02BB MODIFIER LETTER TURNED COMMA — the Uzbek okina in oʻ / gʻ. */
export const OKINA = '\u02BB';

/**
 * U+02BC MODIFIER LETTER APOSTROPHE — the tutuq belgisi in sanʼat / maʼno / taʼlim.
 *
 * A different letter from the okina, not a different rendering of it.
 */
export const TUTUQ = '\u02BC';

// ---------------------------------------------------------------------------------
// Character primitives — Swift's `Character` semantics, in JavaScript
// ---------------------------------------------------------------------------------

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Swift's `Array(text)`: extended grapheme clusters, in order. */
function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of SEGMENTER.segment(text)) out.push(segment);
  return out;
}

/** Swift's `String.count`. Grapheme clusters, not UTF-16 units and not bytes. */
function characterCount(text: string): number {
  let n = 0;
  for (const _ of SEGMENTER.segment(text)) n += 1;
  return n;
}

// Swift's `Character.isLetter` / `.isUppercase` / `.isWhitespace` read the properties of
// the cluster's FIRST scalar, so these do the same. `isLetter` is the Unicode Alphabetic
// derived property (which is what Swift uses), not merely general category L.
const ALPHABETIC = /^\p{Alphabetic}/u;
const NUMERIC = /^\p{N}/u;
const UPPERCASE = /^\p{Uppercase}/u;
const WHITE_SPACE = /^\p{White_Space}/u;

function isLetter(ch: string): boolean {
  return ALPHABETIC.test(ch);
}

/**
 * Swift's `Character.isNumber` is `numericType != nil`, which is very slightly wider than
 * `\p{N}` — it also covers ideographs carrying a numeric value, e.g. 七. Nothing in the
 * corpus or in Uzbek, Russian or English orthography reaches that gap.
 */
function isNumber(ch: string): boolean {
  return NUMERIC.test(ch);
}

function isUppercase(ch: string): boolean {
  return UPPERCASE.test(ch);
}

function isWhitespace(ch: string): boolean {
  return WHITE_SPACE.test(ch);
}

/**
 * Swift's `String == String` and `Set<String>` membership compare by CANONICAL
 * EQUIVALENCE, so `é` and `e` + U+0301 are one key. NFC is the standard way to say that.
 */
function canonical(text: string): string {
  return text.normalize('NFC');
}

/** Foundation's `.trimmingCharacters(in: .whitespacesAndNewlines)`. */
const TRIM_EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Code-point order, which is what Swift's `String <` gives for these strings. */
function byScalar(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const d = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return left.length - right.length;
}

// ---------------------------------------------------------------------------------
// The delivery normaliser
// ---------------------------------------------------------------------------------

/** BOM, ZWSP, ZWNJ, ZWJ, word joiner. See the grapheme-cluster note in the header. */
const ZERO_WIDTH = new Set(['\uFEFF', '\u200B', '\u200C', '\u200D', '\u2060']);

const SOFT_HYPHEN = '\u00AD';

/**
 * Every glyph a model might use for either mark. `normaliseForDelivery` decides which one
 * it meant from the preceding letter; the wider set here also catches the prime and acute
 * that keyboards produce.
 */
const DELIVERY_APOSTROPHES = new Set([
  '\u0027', // '  APOSTROPHE
  '\u2018', // ‘  LEFT SINGLE QUOTATION MARK
  '\u2019', // ’  RIGHT SINGLE QUOTATION MARK
  '\u02BB', // ʻ  MODIFIER LETTER TURNED COMMA (the okina)
  '\u02BC', // ʼ  MODIFIER LETTER APOSTROPHE (the tutuq belgisi)
  '\u0060', // `  GRAVE ACCENT
  '\u00B4', // ´  ACUTE ACCENT
  '\u02B9', // ʹ  MODIFIER LETTER PRIME
  '\u02BD', // ʽ  MODIFIER LETTER REVERSED COMMA
  '\u2032', // ′  PRIME
]);

/**
 * THE ONE NORMALISER ON THE USER'S PATH. Applied to Uzbek transcripts only.
 *
 * Preserves case and punctuation; fixes orthography. Byte-for-byte parity with the Swift
 * `UzbekNormaliser.forDelivery` is asserted against `fixtures/golden/uzbek-delivery.json`,
 * so this is not "close enough" territory.
 *
 * Case, punctuation, hyphens and digits belong to the speaker. The two things a raw Uzbek
 * transcript does need corrected are which apostrophe glyph it chose and the occasional
 * Cyrillic look-alike inside a Latin word.
 */
export function normaliseForDelivery(text: string): string {
  const chars = graphemes(text);
  let out = '';

  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index]!;
    if (ZERO_WIDTH.has(ch) || ch === SOFT_HYPHEN) continue;

    if (DELIVERY_APOSTROPHES.has(ch)) {
      // Both Uzbek marks are intra-word. Folding unconditionally broke two things: a
      // quotation mark became a letter (U+02BC is category Lm, so the capitaliser — which
      // takes the first `isLetter` it meets as the sentence's first letter — consumed the
      // quote and capitalised nothing), and paired ‘…’ quotes were destroyed outright.
      // So: letters on both sides, or it is punctuation and stays punctuation.
      const before = index > 0 ? chars[index - 1]! : null;
      const after = index + 1 < chars.length ? chars[index + 1]! : null;
      if (before === null || after === null || !isLetter(before) || !isLetter(after)) {
        out += ch;
        continue;
      }

      // An English genitive is not Uzbek orthography. Measured on the first version:
      // "Chicago's" became "Chicagoʻs", "Samsung's" became "Samsungʻs" — an Uzbek letter
      // inside a brand name, which then fails to match in a search box or a URL. Uzbek has
      // no `'s` suffix, so a lone `s` at the end of the word gives it away.
      const afterThat = index + 2 < chars.length ? chars[index + 2]! : null;
      const englishGenitive =
        (after === 's' || after === 'S') &&
        (afterThat === null || !(isLetter(afterThat) || isNumber(afterThat)));
      if (englishGenitive) {
        out += "'";
        continue;
      }

      // Lowercased for the o/g test only — an "O'" at the start of a sentence is the same
      // letter as an "o'" in the middle of one.
      const lower = graphemes(before.toLowerCase())[0];
      out += lower === 'o' || lower === 'g' ? OKINA : TUTUQ;
      continue;
    }

    switch (ch) {
      case '\u0430': // stray Cyrillic а in Latin text
        out += 'a';
        break;
      case '\u04EF': // ӯ, a non-standard ў
        out += 'o' + OKINA;
        break;
      case '\u04EE': // Ӯ
        out += 'O' + OKINA;
        break;
      default:
        out += ch;
    }
  }

  // whisper.cpp concatenates segments each of which begins with a space, so runs of spaces
  // and tabs collapse. A newline is left alone — a mode may have asked for one.
  let collapsed = '';
  let lastWasSpace = false;
  for (const ch of graphemes(out)) {
    const isSpace = ch === ' ' || ch === '\t';
    if (isSpace) {
      if (!lastWasSpace) collapsed += ' ';
    } else {
      collapsed += ch;
    }
    lastWasSpace = isSpace;
  }
  return collapsed.replace(TRIM_EDGES, '');
}

// ---------------------------------------------------------------------------------
// Replacements
// ---------------------------------------------------------------------------------

/**
 * Applies the user's find/replace rules in a SINGLE left-to-right pass.
 *
 * At each position every non-empty rule is tested and the LONGEST match wins; matched
 * output is appended and never rescanned, so rules cannot chain and `x → xx` cannot loop.
 *
 * EQUAL-LENGTH COMPETING RULES RESOLVE TO THE FIRST ONE IN ARRAY ORDER, not the last.
 * t01's stub comment said "the LAST one" and that is wrong: the Swift's guard is
 * `needle.count > matchedLength`, a STRICT `>`, so once a rule of length n has matched
 * every later rule of length n is skipped. Ported from the code, not from the prose.
 *
 * `wholeWord` requires the characters immediately before and after — treated as a space at
 * the string edges — to be neither a letter nor a number.
 */
export function applyReplacements(text: string, rules: readonly Replacement[]): string {
  if (rules.length === 0) return text;
  const chars = graphemes(text);
  let out = '';
  let i = 0;

  while (i < chars.length) {
    let matched: Replacement | null = null;
    let matchedLength = 0;

    for (const rule of rules) {
      if (rule.find === '') continue;
      const needle = graphemes(rule.find);
      if (needle.length <= matchedLength || i + needle.length > chars.length) continue;

      const window = chars.slice(i, i + needle.length).join('');
      const same = rule.matchCase
        ? canonical(window) === canonical(rule.find)
        : canonical(window.toLowerCase()) === canonical(rule.find.toLowerCase());
      if (!same) continue;

      if (rule.wholeWord) {
        const before = i > 0 ? chars[i - 1]! : ' ';
        const after = i + needle.length < chars.length ? chars[i + needle.length]! : ' ';
        if (isLetter(before) || isNumber(before) || isLetter(after) || isNumber(after)) continue;
      }

      matched = rule;
      matchedLength = needle.length;
    }

    if (matched !== null) {
      out += matched.replaceWith;
      i += matchedLength;
    } else {
      out += chars[i]!;
      i += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------
// The capitaliser
// ---------------------------------------------------------------------------------

/** Terminators after which the next letter starts a sentence. */
// `؟` too: a Turkish or English word after an Arabic question is a sentence start all the same.
const TERMINATORS = new Set(['.', '!', '?', '\u2026', '\u061F']);

/**
 * Characters that may sit between a terminator and the next sentence.
 *
 * The curly quotes are here for the same reason the straight ones always were: without
 * them a quoted sentence ends, the closing `”` clears `atSentenceStart`, and the sentence
 * after it never gets its capital.
 */
const SKIPPABLE = new Set([
  ' ',
  '\n',
  '\t',
  '"',
  '\u0027', // '
  '\u00AB', // «
  '\u00BB', // »
  ')',
  ']',
  '\u2018', // ‘
  '\u2019', // ’
  '\u201C', // “
  '\u201D', // ”
]);

/**
 * Uzbek's two modifier letters. Unicode calls them letters — category Lm — and they have
 * no uppercase form, so a sentence may not BEGIN with one even though a word may contain
 * one. Without this, `restore` takes a leading one as the sentence's first letter,
 * "uppercases" it to itself, clears `atSentenceStart` and leaves the real first letter
 * lower case: `ʼsalom.ʼ keyingi gap.` comes back with no capitals at all.
 */
const MODIFIER_LETTERS = new Set([OKINA, TUTUQ]);

/** Restores sentence capitalisation without changing anything else. */
export interface Capitaliser {
  /**
   * Guarantee, pinned over 120 real transcripts: it changes NOTHING except letter case.
   * `output.length === input.length` and `output.toLowerCase() === input.toLowerCase()`.
   *
   * `language` decides HOW a letter is capitalised (the Mac's D-11): Turkish through its locale
   * (`istanbul` → `İstanbul`, never `Istanbul`), and Arabic not at all — the text comes back as
   * it went in, so a Latin word opening an Arabic sentence (`iPhone …`) is not made `IPhone`.
   * Absent: the locale-free rule every caller had before.
   */
  restore(text: string, language?: Language): string;
}

/**
 * `alwaysCapitalised` is seeded with the UNION of vocabulary terms across ALL THREE
 * languages, not just the routed one — `Set(settings.vocabulary.values.flatMap { $0 })` —
 * so those words are force-capitalised mid-sentence in English and Russian too.
 * Implementing "capitalise sentence starts" alone diverges the moment a user adds one
 * vocabulary word.
 *
 * Terms are compared lowercased.
 */
export function createCapitaliser(alwaysCapitalised: Iterable<string>): Capitaliser {
  const terms = new Set<string>();
  for (const term of alwaysCapitalised) terms.add(canonical(term.toLowerCase()));

  return {
    restore(text: string, language?: Language): string {
      if (text === '' || language === 'ar') return text;
      const upper = (s: string): string => (language === 'tr' ? s.toLocaleUpperCase('tr') : s.toUpperCase());
      const lowerFor = (s: string): string => (language === 'tr' ? s.toLocaleLowerCase('tr') : s.toLowerCase());
      let out = '';
      let atSentenceStart = true;
      let wordBuffer = '';

      const flushWord = (): void => {
        if (wordBuffer === '') return;
        out += terms.has(canonical(lowerFor(wordBuffer)))
          ? capitaliseFirstLetter(wordBuffer, language)
          : wordBuffer;
        wordBuffer = '';
      };

      // A terminator ends a sentence only once whitespace follows it. Straight after one, a
      // letter is still inside the word: `john.doe@gmail.com` came out `john.Doe@gmail.Com`,
      // and `notes.txt`, `google.com` and `e.g.` likewise (core review 2026-09-30).
      let afterTerminator = false;
      for (const ch of graphemes(text)) {
        // The ASCII apostrophe is part of a word so that "Chicago's" is one word; the okina
        // is part of a word because in Uzbek it is part of a letter. U+02BC needs no entry
        // here — Unicode already calls it a letter.
        if (isLetter(ch) || ch === OKINA || ch === "'") {
          if (atSentenceStart && isLetter(ch) && !MODIFIER_LETTERS.has(ch)) {
            flushWord();
            out += upper(ch);
            atSentenceStart = false;
          } else {
            wordBuffer += ch;
          }
          // A closing `'` after the stop is a quote, not the next word: `'salom.' keyingi`.
          // So is a closing U+02BC or U+02BB: letters to Unicode, but no word starts with one.
          if (isLetter(ch) && !MODIFIER_LETTERS.has(ch)) afterTerminator = false;
          continue;
        }

        flushWord();
        out += ch;
        if (TERMINATORS.has(ch)) {
          afterTerminator = true;
        } else if (isWhitespace(ch)) {
          if (afterTerminator) atSentenceStart = true;
          afterTerminator = false;
        } else if (!SKIPPABLE.has(ch)) {
          // A comma or a digit does not begin a sentence.
          atSentenceStart = false;
          afterTerminator = false;
        }
      }
      flushWord();
      return out;
    },
  };
}

/**
 * Uppercases the first character for which `isLetter` holds, leaving any prefix — a
 * leading quote or okina — in place. Returns the word unchanged when it has no letter.
 *
 * The okina is the trap: `oʻzbekiston` capitalises to `Oʻzbekiston`, never `OʻZbekiston`,
 * because the okina IS a letter and a naive "skip non-alphanumerics" gets this wrong.
 */
export function capitaliseFirstLetter(word: string, language?: Language): string {
  const chars = graphemes(word);
  const index = chars.findIndex(isLetter);
  if (index < 0) return word;
  const letter = chars[index]!;
  return (
    chars.slice(0, index).join('') +
    (language === 'tr' ? letter.toLocaleUpperCase('tr') : letter.toUpperCase()) +
    chars.slice(index + 1).join('')
  );
}

/**
 * What fraction of sentences in `text` begin with a capital — the measure the capitaliser
 * is graded on, and the `rateIn` / `rateOut` columns of `capitalise.json`.
 *
 * Empty text scores 1: no sentences means nothing was got wrong.
 */
export function sentenceInitialCapitalRate(text: string): number {
  let sentences = 0;
  let capitalised = 0;
  let expectingStart = true;
  for (const ch of graphemes(text)) {
    if (expectingStart && isLetter(ch)) {
      sentences += 1;
      if (isUppercase(ch)) capitalised += 1;
      expectingStart = false;
    } else if (TERMINATORS.has(ch)) {
      expectingStart = true;
    }
  }
  return sentences > 0 ? capitalised / sentences : 1;
}

// ---------------------------------------------------------------------------------
// The live pipeline
// ---------------------------------------------------------------------------------

/**
 * THE LIVE TEXT PIPELINE, in this exact order:
 *   1. `normaliseForDelivery` — Uzbek routes only.
 *   2. `applyReplacements`.
 *   3. `capitaliser.restore` — only when one was supplied.
 *
 * The capitaliser is supplied only when `settings.autoCapitalise && mode.autocapitalizeInsert`.
 * BOTH must be true. All four shipped modes set the mode flag true, including `super`, the
 * mode that keeps every word — the flag gates this deterministic layer, not the model. Off,
 * every Uzbek dictation arrives entirely lower case, because the Uzbek model emits zero
 * capitals: measured over 24 real Uzbek dictations, not one capital in 24, while still
 * emitting sentence punctuation.
 *
 * Deciding the gate is the CALLER's job — pass `null` and no capitalisation happens. This
 * function must never re-derive it, because the flag was once read by nothing at all and the
 * preserve-tier mode's defining guarantee was broken from underneath.
 */
export function deliver(options: {
  readonly text: string;
  readonly language: Language;
  readonly replacements: readonly Replacement[];
  readonly capitaliser: Capitaliser | null;
  /**
   * A built-in mode's deterministic clean-up (`src/core/modes` `cleanUp`), when the mode
   * has one — step 1b, exactly where the Mac's `normalise` closure runs `DictationCleanup`:
   * after the Uzbek orthography, before the replacements and the capitaliser. Absent for
   * Raw, and for every caller that predates the modes.
   */
  readonly cleanUp?: (text: string) => string;
}): string {
  let out = options.text;
  // `normaliseForDelivery`, NOT a scoring normaliser. See the header. Arabic has its own
  // (marks, digits, case endings — the Mac's `Orthography.forDelivery`).
  out = orthographyForDelivery(out, options.language);
  if (options.cleanUp !== undefined) out = options.cleanUp(out);
  out = applyReplacements(out, options.replacements);
  if (options.capitaliser !== null) out = options.capitaliser.restore(out, options.language);
  return out;
}

// ---------------------------------------------------------------------------------
// Arabic delivery — the Mac's `ArabicNormaliser.forDelivery` (D-11, C4 §14.3)
// ---------------------------------------------------------------------------------

const ARABIC_COMMA = '\u060C';
const ARABIC_SEMICOLON = '\u061B';
const ARABIC_QUESTION = '\u061F';
const ALPHABETIC_SCALAR = /^\p{Alphabetic}$/u;

/** Fatha, damma, kasra, sukun — what a case ending is written with (not tanwin, not shadda). */
function isCaseVowel(cp: number): boolean {
  return cp === 0x064e || cp === 0x064f || cp === 0x0650 || cp === 0x0652;
}

/** Any Arabic combining mark: U+064B–U+065F, superscript alef U+0670, Quranic U+06D6–U+06ED. */
function isArabicMark(cp: number): boolean {
  return (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || (cp >= 0x06d6 && cp <= 0x06ed);
}

function westernDigit(cp: number): string | null {
  if (cp >= 0x0660 && cp <= 0x0669) return String.fromCharCode(0x30 + cp - 0x0660);
  if (cp >= 0x06f0 && cp <= 0x06f9) return String.fromCharCode(0x30 + cp - 0x06f0);
  return null;
}

function isAnyDigit(scalar: string | undefined): boolean {
  if (scalar === undefined) return false;
  const cp = scalar.codePointAt(0) ?? 0;
  return (cp >= 0x30 && cp <= 0x39) || westernDigit(cp) !== null;
}

function isLatinOrCyrillicLetter(scalar: string): boolean {
  const cp = scalar.codePointAt(0) ?? 0;
  const inRange =
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0xc0 && cp <= 0x24f) ||
    (cp >= 0x1e00 && cp <= 0x1eff) ||
    (cp >= 0x400 && cp <= 0x4ff);
  return inRange && ALPHABETIC_SCALAR.test(scalar);
}

/**
 * What an Arabic transcript looks like when it reaches the user, every mode, Raw included —
 * byte-for-byte the Mac's `ArabicNormaliser.forDelivery` (`fixtures/golden/arabic-delivery.json`).
 * Inside Arabic text (the sentence so far holds at least as many Arabic letters as Latin and
 * Cyrillic ones) `,` `;` `?` become `،` `؛` `؟`, with no space before and one after; a comma
 * between digits stays. Arabic-Indic and Persian digits (and the Arabic decimal / thousands
 * separators and percent sign beside digits) become Western. Tatweel goes. A fatha, damma,
 * kasra or sukun that is the last mark of a word (a case ending) goes; every other mark stays.
 * Text with no Arabic letter is returned exactly. Idempotent.
 */
export function normaliseArabicForDelivery(text: string): string {
  const input = Array.from(text);
  if (!input.some((scalar) => isArabicLetter(scalar))) return text;
  const out: string[] = [];
  let arabic = 0;
  let other = 0;
  for (let i = 0; i < input.length; i += 1) {
    const s = input[i] as string;
    const cp = s.codePointAt(0) ?? 0;
    const previous = i > 0 ? input[i - 1] : undefined;
    const next = i + 1 < input.length ? input[i + 1] : undefined;
    if (cp === 0x0640) continue;
    const digit = westernDigit(cp);
    if (digit !== null) {
      out.push(digit);
      continue;
    }
    if (cp === 0x066b && isAnyDigit(previous) && isAnyDigit(next)) {
      out.push('.');
      continue;
    }
    if (cp === 0x066c && isAnyDigit(previous) && isAnyDigit(next)) {
      out.push(',');
      continue;
    }
    if (cp === 0x066a && isAnyDigit(previous)) {
      out.push('%');
      continue;
    }
    if (isCaseVowel(cp)) {
      let j = i + 1;
      while (j < input.length && isArabicMark(input[j]?.codePointAt(0) ?? 0)) j += 1;
      if (j === input.length || !isArabicLetter(input[j] as string)) continue;
    }
    if (isArabicLetter(s)) arabic += 1;
    else if (isLatinOrCyrillicLetter(s)) other += 1;
    const inArabic = arabic > 0 && arabic >= other;
    let mark = s;
    if (s === ',') {
      if (inArabic && !(isAnyDigit(previous) && isAnyDigit(next))) mark = ARABIC_COMMA;
    } else if (s === ';') {
      if (inArabic) mark = ARABIC_SEMICOLON;
    } else if (s === '?') {
      if (inArabic) mark = ARABIC_QUESTION;
    }
    if (mark === ARABIC_COMMA || mark === ARABIC_SEMICOLON || mark === ARABIC_QUESTION) {
      while (out.length > 0 && (out[out.length - 1] === ' ' || out[out.length - 1] === '\u00A0')) out.pop();
      out.push(mark);
      if (next !== undefined && (ALPHABETIC_SCALAR.test(next) || isAnyDigit(next))) out.push(' ');
    } else {
      out.push(mark);
    }
    if (s === '.' || s === '!' || s === '?' || mark === ARABIC_QUESTION || s === '\n') {
      if (!(s === '.' && isAnyDigit(previous) && isAnyDigit(next))) {
        arabic = 0;
        other = 0;
      }
    }
  }
  return out.join('');
}

/**
 * The Mac's `Orthography.forDelivery`: Uzbek's apostrophes, Arabic's marks and digits; every
 * other language as written. The session's `deliver` and a mode's model output both pass it.
 */
export function orthographyForDelivery(text: string, language: Language): string {
  if (language === 'uz') return normaliseForDelivery(text);
  if (language === 'ar') return normaliseArabicForDelivery(text);
  return text;
}

// ---------------------------------------------------------------------------------
// The vocabulary hint
// ---------------------------------------------------------------------------------

/**
 * One well-formed, punctuated sentence in the target language, appended to the term list.
 *
 * This is the part that buys the punctuation back, and it has to be in the language being
 * transcribed — the prompt is decoder context, so a sentence in the wrong language biases
 * the decoder toward the wrong language, which for Uzbek is the failure this whole app is
 * built around. English has no exemplar because whisper is not the English engine here.
 */
const STYLE_EXEMPLAR: Readonly<Record<Language, string | null>> = {
  uz: `Bu yerda ismlar to${OKINA}g${OKINA}ri yozilgan.`,
  ru: 'Здесь имена написаны правильно.',
  en: null,
  // Turbo already punctuates Turkish (F1 62, a stop on 99 %, C4 §3.1): sent only after terms,
  // for the reason Russian's is not sent without them.
  tr: 'Burada isimler doğru yazılmıştır.',
  // C4 §3.2: unprompted, whisper writes almost no Arabic punctuation (F1 5, a stop at the end
  // 4.5 % of the time); this sentence (our own) lifts that to F1 35 / 99 % at no MSA WER cost.
  // It reaches whisper only as the Arabic FALLBACK — Cohere and FastConformer punctuate.
  ar: 'مرحبًا، هذه رسالة قصيرة. هل يمكنك مراجعتها؟ شكرًا.',
};

/**
 * The `initial_prompt` handed to whisper.
 *
 * Returns `null`, never `""` — an empty prompt is NOT the same as no prompt to a decoder.
 * With no terms it still returns the style exemplar for Uzbek (and only Uzbek), so every
 * Uzbek decode carries a prompt even for a user who never opened the vocabulary pane. With
 * terms: the terms joined by ", " plus a full stop, then a space and the exemplar.
 *
 * The SHAPE matters as much as the words, and it is measured on the 344-clip Uzbek set:
 *
 *     no hint at all                       WER 25.19 %   punctuation 68.3 %
 *     "Kotiba, Toshkent"                    WER 24.79 %   punctuation 61.0 %
 *     "Kotiba, Toshkent."                   WER 25.05 %   punctuation 91.0 %
 *     "Kotiba, Toshkent." + a full sentence WER 24.79 %   punctuation 91.0 %
 *
 * A bare comma-separated keyword list models unpunctuated writing and the decoder obliges —
 * it costs 7.3 points against no hint at all, and a punctuated one gains 23. That is not
 * cosmetic: the capitaliser finds sentence starts by looking for `.`, `!` and `?`, so
 * punctuation the model never emitted is also every capital after the first one.
 *
 * `terms` is expected already tidied (trimmed, de-duplicated case-insensitively) by the
 * settings layer that owns the vocabulary.
 */
export function vocabularyHint(terms: readonly string[], language: Language): string | null {
  const exemplar = STYLE_EXEMPLAR[language];
  // Uzbek always (C2); Arabic always too — it is what makes whisper punctuate Arabic (C4 §3.2).
  if (terms.length === 0) return language === 'uz' || language === 'ar' ? exemplar : null;
  let hint = terms.join(', ') + '.';
  if (exemplar !== null) hint += ' ' + exemplar;
  return hint;
}

// ---------------------------------------------------------------------------------
// The polish guards
// ---------------------------------------------------------------------------------

/** Swift's `String(format: "%.2f", ratio)`. */
function ratioText(ratio: number): string {
  return ratio.toFixed(2);
}

/**
 * The general, language-agnostic polish guard. `null` accepts.
 *
 * Ratios are over CHARACTER counts. Below `RATIO_FLOOR_LENGTH` characters the ratio stops
 * meaning anything and `shortInputHeadroom` widens the ceiling — a greeting and a sign-off
 * are a fixed cost, not a proportion: "sounds good" (11 chars) becoming
 * "Hi,\n\nSounds good.\n\nBest,\nAziz" is a ratio of 2.5 and is exactly right.
 *
 * An absolute allowance rather than skipping the check, because the short input is also
 * where runaway generation is most dangerous.
 */
export function checkPolishGuard(
  polished: string,
  original: string,
  config: PolishGuardConfig,
): PolishRejection | null {
  if (original === '') return null;

  const originalCount = characterCount(original);
  const ratio = characterCount(polished) / originalCount;
  if (ratio < config.minimumRatio) {
    return {
      kind: 'truncated',
      ratio,
      reason: `polish deleted content (length ratio ${ratioText(ratio)})`,
    };
  }

  const allowance =
    originalCount < RATIO_FLOOR_LENGTH
      ? Math.max((originalCount + config.shortInputHeadroom) / originalCount, config.maximumRatio)
      : config.maximumRatio;
  if (ratio > allowance) {
    return {
      kind: 'inflated',
      ratio,
      reason: `polish ran away (length ratio ${ratioText(ratio)})`,
    };
  }

  // Script is checked second because it catches what length cannot: a translation is
  // roughly the same length as its input. A ≤2B model was measured translating English into
  // Russian AND changing "Tuesday" to "Monday", at a length ratio well inside any band.
  const before: Script = scriptOf(original);
  const after: Script = scriptOf(polished);
  if (
    before !== after &&
    before !== 'neither' &&
    after !== 'neither' &&
    before !== 'mixed' &&
    after !== 'mixed'
  ) {
    return {
      kind: 'scriptChanged',
      from: before,
      to: after,
      reason: `polish changed script from ${before} to ${after}`,
    };
  }
  // Arabic, stricter (the Mac's D-11): a rewrite of mostly-Arabic text must stay mostly Arabic.
  // The rule above lets `mixed` through both ways, and Arabic dictation is often mixed — one
  // Latin brand name is enough — so a model that transliterated the sentence into Latin, or
  // answered in English around the one Latin word, was not caught.
  if (arabicShare(original) >= 0.5 && arabicShare(polished) < 0.5 && after !== 'neither') {
    return {
      kind: 'scriptChanged',
      from: before,
      to: after,
      reason: `polish changed script from ${before} to ${after}`,
    };
  }
  return null;
}

/** Folds every apostrophe-ish SCALAR onto the okina. Deliberately nothing else. */
function foldApostrophes(text: string): string {
  let out = '';
  for (const scalar of text) out += APOSTROPHE_FAMILY.includes(scalar) ? OKINA : scalar;
  return out;
}

/** The word types in a string, apostrophes folded and case ignored. */
function uzbekVocabulary(text: string): Set<string> {
  const folded = foldApostrophes(text).toLowerCase();
  const words = new Set<string>();
  let current = '';
  for (const ch of graphemes(folded)) {
    // The okina is part of a word in Uzbek, not a separator. Everything else that is not a
    // letter or a digit is.
    if (isLetter(ch) || isNumber(ch) || ch === OKINA) {
      current += ch;
    } else if (current !== '') {
      words.add(canonical(current));
      current = '';
    }
  }
  if (current !== '') words.add(canonical(current));
  return words;
}

/**
 * Whether a "new" word is really a piece of a word that was already there.
 *
 * Real ASR runs words together, and pulling them apart is one of the most useful things a
 * correction pass does: `birikki` → `bir-ikki` and `eshitganmisizayasi` →
 * `eshitganmisiz? Ayasi` are both right, and a rule that only compared whole words called
 * all four halves inventions — rejecting roughly a third of CORRECT polishes.
 *
 * A split adds no new letters. An invention is not a substring: `keçşurun` is nowhere
 * inside `kechqurun`, `chunkı` nowhere inside `chunki`, `dostim` nowhere inside `doʻstim`.
 * Two characters is too short to be evidence of anything.
 */
function isSplitOf(word: string, original: ReadonlySet<string>): boolean {
  if (characterCount(word) < UZBEK_GUARD_MINIMUM_SPLIT_LENGTH) return false;
  const needle = characterCount(word);
  for (const candidate of original) {
    if (characterCount(candidate) > needle && candidate.includes(word)) return true;
  }
  return false;
}

/**
 * The Uzbek-only guard, applied BEFORE the general one when the route is Uzbek. `null`
 * accepts.
 *
 * A polish may reorder, requote, capitalise, punctuate and DELETE words, but it may not
 * INTRODUCE one absent from the input. Measured on real Uzbek through real cloud models:
 * 7 of 14 polishes changed words the speaker did not say and the general guard caught 1 —
 * length ratio and script check cannot see it, because an invented Uzbek word is the same
 * length and the same script as the real one. The pull is always toward Turkish.
 *
 * Additions are the failure mode; removals are not. A correction pass legitimately drops
 * filler words.
 */
export function checkUzbekPolishGuard(polished: string, original: string): PolishRejection | null {
  const before = uzbekVocabulary(original);
  const after = uzbekVocabulary(polished);
  const introduced = [...after].filter((w) => !before.has(w) && !isSplitOf(w, before));
  if (introduced.length === 0) return null;

  // Sorted so the same pair of strings always names the same words in the same order; the
  // Swift original reads them out of an unordered Set.
  introduced.sort(byScalar);
  const list = introduced.slice(0, UZBEK_GUARD_NAMED_WORDS).join(', ');
  return {
    kind: 'inventedWords',
    words: introduced,
    reason:
      `the polish introduced ${introduced.length} word` +
      (introduced.length === 1 ? '' : 's') +
      ` the speaker did not say ${quoteSpoken(list)} — Uzbek transcript kept as spoken`,
  };
}

// ---------------------------------------------------------------------------------
// SpokenText — words the speaker said, quoted inside a diagnostic note
// ---------------------------------------------------------------------------------
//
// A port of `SpokenText` (Sources/KotibaCore/DiagnosticsStore.swift), pinned by the
// `spokenText` rows of fixtures/golden/modes.json.
//
// A record's notes may name what was said — which words a guard refused, what a second
// engine answered — and the JSON lines keep them. The plain-text summary a user pastes into
// a bug report promises no transcript text, and the notes are part of it: every note that
// quotes speech goes through `quoteSpoken`, and the summary puts every note through
// `redactSpoken`.

const QUOTE_OPEN = '\u00AB'; // «
const QUOTE_CLOSE = '\u00BB'; // »

/** `text` between guillemets, any guillemet inside it made harmless so the quote ends where it should. */
export function quoteSpoken(text: string): string {
  const inner = text.replaceAll(QUOTE_CLOSE, '\u203A').replaceAll(QUOTE_OPEN, '\u2039');
  return `${QUOTE_OPEN}${inner}${QUOTE_CLOSE}`;
}

/** `line` with every quoted stretch replaced by its length in words. */
export function redactSpoken(line: string): string {
  let out = '';
  let quoted: string | null = null;
  for (const character of graphemes(line)) {
    if (quoted === null && character === QUOTE_OPEN) {
      quoted = '';
    } else if (quoted !== null && character === QUOTE_CLOSE) {
      // Swift's `split(whereSeparator:)`: empty pieces omitted.
      const words = quoted.split(/[ ,]/u).filter((piece) => piece !== '').length;
      out += `${QUOTE_OPEN}${words} word${words === 1 ? '' : 's'}${QUOTE_CLOSE}`;
      quoted = null;
    } else if (quoted !== null) {
      quoted += character;
    } else {
      out += character;
    }
  }
  // An unterminated quote is still speech.
  if (quoted !== null) out += `${QUOTE_OPEN}\u2026`;
  return out;
}
