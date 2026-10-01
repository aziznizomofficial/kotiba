// Swift's `Character` and Foundation's string helpers, in JavaScript — for the modes port.
//
// PURE. The modes' deterministic layer (`DictationCleanup`, `PunctuationProjection`,
// `NoteLayout`, `SentenceSplitter`, `SentenceGuard`) is pinned byte-for-byte by
// `fixtures/golden/modes.json`, which the Swift generates by running the real code. Every
// place the Swift says `Array(text)`, `.count`, `.isLetter` or `.trimmingCharacters` has
// to mean here exactly what it means there, and the four ways it silently would not are:
//
//   * `Array(text)` and `.count` are EXTENDED GRAPHEME CLUSTERS, not UTF-16 units.
//   * `Character.isLetter` is the Unicode Alphabetic property of the first scalar — which
//     includes the okina U+02BB (Lm) — not `\p{L}` and not `[A-Za-z]`.
//   * `.whitespaces` is Zs plus TAB; `.whitespacesAndNewlines` adds the line separators.
//   * `split(separator:)` drops empty pieces unless told otherwise.
//
// `src/core/text` has private copies of the first two for the delivery normaliser; these
// are kept separate so neither module's golden suite depends on the other's internals.

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Swift's `Array(text)`: extended grapheme clusters, in order. */
export function chars(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of SEGMENTER.segment(text)) out.push(segment);
  return out;
}

/** Swift's `String.count`. */
export function count(text: string): number {
  let n = 0;
  for (const _ of SEGMENTER.segment(text)) n += 1;
  return n;
}

const ALPHABETIC = /^\p{Alphabetic}/u;
const NUMERIC = /^\p{N}/u;
const UPPERCASE = /^\p{Uppercase}/u;
const LOWERCASE = /^\p{Lowercase}/u;
const PUNCTUATION = /^\p{P}$/u;

/** `Character.isLetter`: the first scalar's Alphabetic property. */
export function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ALPHABETIC.test(ch);
}

/** `Character.isNumber`. Swift's is `numericType != nil`; `\p{N}` differs only on CJK numerals. */
export function isNumber(ch: string | undefined): boolean {
  return ch !== undefined && NUMERIC.test(ch);
}

export function isUppercase(ch: string | undefined): boolean {
  return ch !== undefined && UPPERCASE.test(ch);
}

export function isLowercase(ch: string | undefined): boolean {
  return ch !== undefined && LOWERCASE.test(ch);
}

/** Foundation `.whitespaces`: general category Zs, and TAB. */
function isBlank(scalar: string): boolean {
  return scalar === '\t' || /^\p{Zs}$/u.test(scalar);
}

/** Foundation `.whitespacesAndNewlines`: Z*, and U+000A–U+000D, U+0085. */
function isBlankOrNewline(scalar: string): boolean {
  return /^[\p{Z}\t\n\u000B\u000C\r\u0085]$/u.test(scalar);
}

/** `.trimmingCharacters(in:)` works on unicode SCALARS, from both ends. */
function trimScalars(text: string, drop: (scalar: string) => boolean): string {
  const scalars = [...text];
  let start = 0;
  let end = scalars.length;
  while (start < end && drop(scalars[start]!)) start += 1;
  while (end > start && drop(scalars[end - 1]!)) end -= 1;
  return scalars.slice(start, end).join('');
}

/** `.trimmingCharacters(in: .whitespaces)`. */
export function trimWhitespace(text: string): string {
  return trimScalars(text, isBlank);
}

/** `.trimmingCharacters(in: .whitespacesAndNewlines)`. */
export function trimWhitespaceAndNewlines(text: string): string {
  return trimScalars(text, isBlankOrNewline);
}

/** `.trimmingCharacters(in: CharacterSet(charactersIn: set))`. */
export function trimSet(text: string, set: string): string {
  const members = new Set([...set]);
  return trimScalars(text, (scalar) => members.has(scalar));
}

/** `.trimmingCharacters(in: .punctuationCharacters)` — Unicode general category P*. */
export function trimPunctuation(text: string): string {
  return trimScalars(text, (scalar) => PUNCTUATION.test(scalar));
}

/** `text.split(whereSeparator:)` over characters, empties omitted (Swift's default). */
export function splitWhere(text: string, isSeparator: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of chars(text)) {
    if (isSeparator(ch)) {
      if (current !== '') out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/** `text.split(separator: " ")`: empties omitted. */
export function splitOn(text: string, separator: string): string[] {
  return splitWhere(text, (ch) => ch === separator);
}

/** The last grapheme, or `undefined` — Swift's `text.last`. */
export function lastChar(text: string): string | undefined {
  const all = chars(text);
  return all[all.length - 1];
}

/** The first grapheme — Swift's `text.first`. */
export function firstChar(text: string): string | undefined {
  for (const { segment } of SEGMENTER.segment(text)) return segment;
  return undefined;
}

/** `String(text.dropFirst(n))`, in characters. */
export function dropFirst(text: string, n = 1): string {
  return chars(text).slice(n).join('');
}

/** `String(text.dropLast(n))`, in characters. */
export function dropLast(text: string, n = 1): string {
  const all = chars(text);
  return all.slice(0, Math.max(0, all.length - n)).join('');
}

/** Code-point order — what Swift's `String <` gives for these strings. */
export function byScalar(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const d = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return left.length - right.length;
}

/**
 * `String(format: "%.0f", value)` — C's rounding, which is round-half-EVEN on an exact tie
 * (12.5 → "12"), where `toFixed(0)` rounds half up. Only diagnostics sentences use it.
 */
export function formatWhole(value: number): string {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction === 0.5) return String(floor % 2 === 0 ? floor : floor + 1);
  return value.toFixed(0);
}

/**
 * Swift's `Duration` description, which is what the Swift's `"\(deadline)"` puts in a
 * diagnostics sentence: `.milliseconds(1500)` → "1.5 seconds", `.seconds(2)` → "2.0 seconds".
 */
export function durationText(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds.toFixed(1) : String(seconds)} seconds`;
}

/** The okina, U+02BB. What every apostrophe-ish scalar folds onto. */
export const OKINA = 'ʻ';

/** `UzbekPolishGuard.foldApostrophes`: ' ‘ ’ ` ´ ʼ ʻ ʹ ′ ʽ → ʻ. Nothing else. */
export function foldApostrophes(text: string): string {
  let out = '';
  for (const scalar of text) {
    switch (scalar.codePointAt(0)) {
      case 0x0027:
      case 0x2018:
      case 0x2019:
      case 0x0060:
      case 0x00b4:
      case 0x02bc:
      case 0x02bb:
      case 0x02b9:
      case 0x2032:
      case 0x02bd:
        out += OKINA;
        break;
      default:
        out += scalar;
    }
  }
  return out;
}
