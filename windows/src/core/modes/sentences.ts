// Sentences in, sentences out: the splitter that feeds incremental polish, and the guards
// a rewritten sentence must pass. Ports of `SentenceSplitter` and `SentenceGuard`
// (Sources/KotibaCore/IncrementalPolish.swift) and of the Mac's current `PolishGuard`
// (Sources/KotibaCore/TextPipeline.swift) — refusal, prompt echo, length, script, overlap.
//
// PURE. The splitter is pinned by the `split` rows of `fixtures/golden/modes.json` and the
// guard by its `messageGuard` rows.
//
// WHY THIS FILE CARRIES ITS OWN `PolishGuard`. `src/core/text`'s `checkPolishGuard` is the
// whole-dictation guard the session applies, ported before the Mac grew its refusal, echo
// and overlap checks. The sentence guard is defined against the CURRENT Mac guard, at
// sentence scale (0.3–1.6, overlap 0.4), and the golden rows were generated from that — so
// reusing the older function would pass a rewrite the Mac refuses.

import type { Language, PolishRejection } from '../../contracts/index.js';
import { isArabicLetter, scriptOf } from '../routing/index.js';
import { checkUzbekPolishGuard, quoteSpoken } from '../text/index.js';

import {
  chars,
  count,
  formatWhole,
  isLetter,
  isNumber,
  splitWhere,
  trimWhitespace,
  trimWhitespaceAndNewlines,
  foldApostrophes,
} from './swift.js';

// ---------------------------------------------------------------------------------
// Prompts, as data
// ---------------------------------------------------------------------------------

/** One worked example, held as a real chat turn. */
export interface PromptExample {
  readonly input: string;
  readonly output: string;
}

/**
 * A system prompt plus worked examples, kept apart so an engine that can hold them as
 * chat turns — and cache them — does. `PolishPrompt` in OnDeviceModes.swift.
 */
export interface PolishPrompt {
  readonly system: string;
  readonly examples: readonly PromptExample[];
}

/** One string, for engines that take only instructions. Also what the echo check searches. */
export function renderPrompt(prompt: PolishPrompt): string {
  if (prompt.examples.length === 0) return prompt.system;
  return (
    prompt.system +
    '\n\nExamples:\n' +
    prompt.examples.map((example) => `Input: ${example.input}\nOutput: ${example.output}`).join('\n\n')
  );
}

// ---------------------------------------------------------------------------------
// The splitter
// ---------------------------------------------------------------------------------

export interface Split {
  readonly sentences: readonly string[];
  readonly rest: string;
}

/**
 * Splits at `. ! ? …` followed by whitespace, and at line breaks. Fragments shorter than
 * three words ride along with the next sentence: a model given "Okay." alone has nothing to
 * work with and is at its most likely to invent.
 *
 * With `keepIncompleteTail`, text after the last terminator is returned as the remainder —
 * the transcriber may still be adding to it. Without it (at `finish`), it is a sentence.
 */
export function splitSentences(text: string, keepIncompleteTail: boolean): Split {
  const sentences: string[] = [];
  let current = '';
  const all = chars(text);
  for (let i = 0; i < all.length; i += 1) {
    const ch = all[i]!;
    // A line break ends the sentence before it and opens the next one, which carries it —
    // so "new line" still starts a line after the sentences are joined back together.
    if (ch === '\n') {
      if (trimWhitespace(current) !== '') {
        sentences.push(current);
        current = '';
      }
      current += ch;
      continue;
    }
    current += ch;
    let atBoundary = false;
    const next = all[i + 1];
    if ('.!?…'.includes(ch) && (next === ' ' || next === '\n')) {
      // `3.5`, `e.g.` and `a.m.` are not boundaries: the character after a real sentence
      // end is whitespace, and the word before is longer than one letter.
      const withoutMark = chars(current).slice(0, -1).join('');
      const pieces = withoutMark.split(' ').filter((piece) => piece !== '');
      const word = pieces[pieces.length - 1] ?? '';
      atBoundary = !(ch === '.' && (count(word) <= 1 || word.includes('.')));
    }
    if (atBoundary) {
      sentences.push(current);
      current = '';
    }
  }

  // Merge short fragments forward, keeping their leading line breaks with them.
  const merged: string[] = [];
  let carry = '';
  for (const sentence of sentences) {
    const piece = carry + sentence;
    if (wordCount(piece) < 3 && !piece.includes('\n')) {
      carry = piece;
    } else {
      merged.push(piece);
      carry = '';
    }
  }
  let rest = carry + current;
  if (!keepIncompleteTail) {
    if (trimWhitespaceAndNewlines(rest) !== '') {
      const last = wordCount(rest) < 3 ? merged.pop() : undefined;
      merged.push(last === undefined ? rest : last + rest);
    }
    rest = '';
  }
  return { sentences: merged.map(tidy).filter((sentence) => sentence !== ''), rest };
}

/** Leading spaces go; a leading line break stays, so layout survives the round trip. */
function tidy(sentence: string): string {
  let breaks = '';
  for (const ch of chars(sentence)) {
    if (ch === '\n') breaks += ch;
    else if (ch !== ' ') break;
  }
  const body = trimWhitespaceAndNewlines(sentence);
  return body === '' ? '' : breaks + body;
}

export function wordCount(text: string): number {
  return splitWhere(text, (ch) => ch === ' ' || ch === '\n').length;
}

/**
 * Output ceiling for one sentence: its own length in tokens and a margin. Runaway
 * generation is stopped here rather than detected afterwards.
 */
export function tokenBudget(sentence: string): number {
  return Math.floor(count(sentence) / 2) + 24;
}

// ---------------------------------------------------------------------------------
// The polish guard, as the Mac has it today
// ---------------------------------------------------------------------------------

export interface FullPolishGuard {
  readonly minimumRatio: number;
  readonly maximumRatio: number;
  readonly shortInputHeadroom: number;
  /** The share of the input's content words the output must keep. */
  readonly minimumOverlap: number;
}

/** Below this many characters the length ratio stops meaning anything. */
const RATIO_FLOOR_LENGTH = 60;
/** Below this many content words, overlap is noise. */
const OVERLAP_FLOOR_WORDS = 3;

const REFUSAL_OPENINGS = [
  "i'm sorry", 'i am sorry', 'sorry,', 'sorry but', "i can't", 'i cannot', 'i can not', 'as an ai',
  "i'm unable", 'i am unable', "i won't", 'i will not',
];

function opensWithRefusal(text: string): boolean {
  const head = trimWhitespaceAndNewlines(text.toLowerCase().split('’').join("'"));
  return REFUSAL_OPENINGS.some((opening) => head.startsWith(opening));
}

/** Words of three letters or more, lowercased, apostrophes folded. */
function contentWords(text: string): Set<string> {
  const folded = text.toLowerCase().replace(/[ʻʼ’]/gu, "'");
  return new Set(splitWhere(folded, (ch) => !isLetter(ch) && ch !== "'").filter((word) => count(word) >= 3));
}

type GuardVerdict =
  | { readonly kind: 'refused' }
  | { readonly kind: 'echoedPrompt' }
  | { readonly kind: 'truncated'; readonly ratio: number }
  | { readonly kind: 'inflated'; readonly ratio: number }
  | { readonly kind: 'scriptChanged'; readonly from: string; readonly to: string }
  | { readonly kind: 'unrelated'; readonly overlap: number };

/** `PolishRejection.reason` on the Mac, word for word. */
export function guardReason(verdict: GuardVerdict): string {
  switch (verdict.kind) {
    case 'truncated':
      return `polish deleted content (length ratio ${verdict.ratio.toFixed(2)})`;
    case 'inflated':
      return `polish ran away (length ratio ${verdict.ratio.toFixed(2)})`;
    case 'scriptChanged':
      return `polish changed script from ${verdict.from} to ${verdict.to}`;
    case 'unrelated':
      return (
        `polish kept almost none of the words (${formatWhole(verdict.overlap * 100)}% overlap) — ` +
        'the model wrote something else'
      );
    case 'echoedPrompt':
      return 'polish returned a line from its own instructions';
    case 'refused':
      return 'polish refused to process the text';
  }
}

/** `PolishGuard.check(_:against:instructions:)`. `null` accepts. */
export function checkFullPolishGuard(
  polished: string,
  original: string,
  guard: FullPolishGuard,
  instructions: string | null,
): GuardVerdict | null {
  if (original === '') return null;

  // A refusal first, because in a restructuring mode it can be inside the length band.
  if (opensWithRefusal(polished) && !opensWithRefusal(original)) return { kind: 'refused' };

  // A line from the prompt. Twelve characters is the floor, and an echo has to bring words
  // the speaker did not say.
  const trimmed = trimWhitespaceAndNewlines(polished);
  if (
    instructions !== null &&
    count(trimmed) >= 12 &&
    instructions.toLowerCase().includes(trimmed.toLowerCase()) &&
    !isSubset(contentWords(polished), contentWords(original))
  ) {
    return { kind: 'echoedPrompt' };
  }

  const originalCount = count(original);
  const ratio = count(polished) / originalCount;
  if (ratio < guard.minimumRatio) return { kind: 'truncated', ratio };
  const allowance =
    originalCount < RATIO_FLOOR_LENGTH
      ? Math.max((originalCount + guard.shortInputHeadroom) / originalCount, guard.maximumRatio)
      : guard.maximumRatio;
  if (ratio > allowance) return { kind: 'inflated', ratio };

  const before = scriptOf(original);
  const after = scriptOf(polished);
  if (before !== after && before !== 'neither' && after !== 'neither' && before !== 'mixed' && after !== 'mixed') {
    return { kind: 'scriptChanged', from: before, to: after };
  }

  const said = contentWords(original);
  if (said.size >= OVERLAP_FLOOR_WORDS) {
    const kept = contentWords(polished);
    let shared = 0;
    for (const word of said) if (kept.has(word)) shared += 1;
    const overlap = shared / said.size;
    if (overlap < guard.minimumOverlap) return { kind: 'unrelated', overlap };
  }
  return null;
}

function isSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const word of a) if (!b.has(word)) return false;
  return true;
}

// ---------------------------------------------------------------------------------
// The guard for one rewritten sentence
// ---------------------------------------------------------------------------------

const SENTENCE_GUARD: FullPolishGuard = {
  minimumRatio: 0.3,
  maximumRatio: 1.6,
  shortInputHeadroom: 24,
  minimumOverlap: 0.4,
};

/**
 * Why a rewritten sentence may not replace the original, or `null` when it may.
 *
 * On top of the polish guard: every content word the rewrite contains must come from the
 * input — equal, or sharing a stem (`приложения` → `приложении`). That separates
 * "Yes, keep only telegram." → "Keep only Telegram." (fine) from "Apply the price added…"
 * → "Apply the price increase…" (a changed fact). Uzbek admits no new word at all: its
 * suffixes carry person and tense. `mayDrop`, when given, is the only vocabulary the
 * rewrite may delete.
 */
export function checkRewrite(
  output: string,
  input: string,
  language: Language,
  prompt: PolishPrompt,
  mayDrop: ReadonlySet<string> | null,
): string | null {
  if (output === '') return 'empty output';
  const verdict = checkFullPolishGuard(output, input, SENTENCE_GUARD, renderPrompt(prompt));
  if (verdict !== null) return guardReason(verdict);
  if (prompt.examples.some((example) => example.output === output && example.input !== input)) {
    return 'polish returned one of its own examples';
  }
  if (mayDrop !== null) {
    const dropped = droppedWords(input, output, mayDrop, language === 'uz');
    if (dropped.length > 0) {
      return `polish deleted words the speaker said ${quoteSpoken(dropped.slice(0, 4).join(', '))}`;
    }
  }
  if (language === 'uz') {
    const rejection: PolishRejection | null = checkUzbekPolishGuard(output, input);
    return rejection === null ? null : rejection.reason;
  }
  const novel = novelWords(output, input);
  if (novel.length > 0) {
    return `polish introduced words the speaker did not say ${quoteSpoken(novel.slice(0, 4).join(', '))}`;
  }
  return null;
}

/**
 * Words of `input` that `output` lost, other than those in `mayDrop` and grammar words.
 * `exact` demands the word itself back: the stem rule accepted `ertaga` (tomorrow) →
 * `erta` (early).
 */
export function droppedWords(
  input: string,
  output: string,
  mayDrop: ReadonlySet<string>,
  exact: boolean,
): string[] {
  const kept = wordsOf(output);
  const allowed = new Set([...mayDrop].map(foldWord));
  return wordsOf(input).filter(
    (word) =>
      !allowed.has(word) &&
      count(word) > 2 &&
      !isConnective(word) &&
      !kept.some((other) => (exact ? other === word : sharesStem(word, other))),
  );
}

/** Content words in `output` with no counterpart in `input`. */
export function novelWords(output: string, input: string): string[] {
  const source = wordsOf(input);
  return wordsOf(output).filter(
    (word) =>
      !isConnective(word) &&
      !chars(word).every(isNumber) &&
      !source.some((other) => sharesStem(word, other)),
  );
}

function foldWord(word: string): string {
  return arabicFold(foldApostrophes(word.toLowerCase()));
}

/** Whether the text holds an Arabic letter (`ScriptCheck.isArabicLetter`, scalar by scalar). */
function hasArabicLetter(text: string): boolean {
  for (const scalar of text) if (isArabicLetter(scalar)) return true;
  return false;
}

/**
 * The Mac's `SentenceGuard.arabicFold` (C4 §14.5): vowel marks and tatweel dropped, the alef
 * forms as `ا`, `ى` as `ي`, `ة` as `ه`. Text with no Arabic letter is returned as is.
 */
export function arabicFold(word: string): string {
  if (!hasArabicLetter(word)) return word;
  let out = '';
  for (const scalar of word) {
    const cp = scalar.codePointAt(0) ?? 0;
    if ((cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || cp === 0x0640) continue;
    if (cp === 0x0622 || cp === 0x0623 || cp === 0x0625 || cp === 0x0671) out += '\u0627';
    else if (cp === 0x0649) out += '\u064A';
    else if (cp === 0x0629) out += '\u0647';
    else out += scalar;
  }
  return out;
}

/**
 * The Mac's `SentenceGuard.arabicStem`: the word without `و`/`ف`, then `ب`/`ل`/`ك` before the
 * article, then `ال` (`لل` for `ل` + `ال`). Never shorter than two letters.
 */
export function arabicStem(word: string): string {
  const w = chars(word);
  const drop = (n: number): void => {
    if (w.length - n >= 2) w.splice(0, n);
  };
  if ((w[0] === '\u0648' || w[0] === '\u0641') && w.length > 3) drop(1);
  if (w.length > 3 && w[0] === '\u0644' && w[1] === '\u0644') {
    drop(2);
  } else {
    if ((w[0] === '\u0628' || w[0] === '\u0644' || w[0] === '\u0643') && w.length > 4 && w[1] === '\u0627' && w[2] === '\u0644') drop(1);
    if (w.length > 3 && w[0] === '\u0627' && w[1] === '\u0644') drop(2);
  }
  return w.join('');
}

/** Lowercased, apostrophe-folded words (Arabic spelling folded, `arabicFold`). */
export function wordsOf(text: string): string[] {
  return splitWhere(
    foldApostrophes(text).toLowerCase(),
    (ch) => !(isLetter(ch) || isNumber(ch) || ch === 'ʻ'),
  ).map(arabicFold);
}

/**
 * The same word, or one inflection of it: one is a prefix of the other, or they share a
 * stem of at least four letters that covers half of the longer word.
 */
export function sharesStem(a: string, b: string): boolean {
  if (a === b) return true;
  // Arabic writes "and", "the" and the prepositions onto the word: compare what is left.
  if (hasArabicLetter(a)) {
    const x = arabicStem(a);
    const y = arabicStem(b);
    if (x !== a || y !== b) return sharesStem(x, y);
  }
  const left = chars(a);
  const right = chars(b);
  const shorter = Math.min(left.length, right.length);
  let common = 0;
  while (common < shorter && left[common] === right[common]) common += 1;
  if (common === shorter && shorter >= 3) return true;
  return common >= 4 && common >= 0.5 * Math.max(left.length, right.length);
}

const CONNECTIVE_LIST = [
  // English
  'the', 'and', 'but', 'for', 'with', 'that', 'this', 'these', 'those', 'then', 'than', 'was',
  'were', 'are', 'is', 'be', 'been', 'can', 'could', 'would', 'should', 'will', 'shall', 'may',
  'might', 'must', 'not', 'you', 'your', 'our', 'we', 'they', 'them', 'their', 'his', 'her',
  'its', "it's", "i'm", "i'll", "i've", 'let', "let's", 'please', 'also', 'just', 'there',
  'here', 'what', 'which', 'who', 'how', 'when', 'where', 'why', 'have', 'has', 'had', 'does',
  'did', "don't", "doesn't", "can't", "won't", 'all', 'any', 'some', 'into', 'onto', 'from',
  'about', 'once', 'done',
  // Russian
  'и', 'в', 'во', 'не', 'на', 'что', 'чтобы', 'как', 'это', 'то', 'так', 'уже', 'ещё', 'еще',
  'да', 'нет', 'мы', 'вы', 'они', 'она', 'он', 'мне', 'нам', 'вам', 'тебе', 'для', 'или', 'но',
  'же', 'ли', 'бы', 'по', 'за', 'из', 'от', 'до', 'при', 'про', 'его', 'её', 'их', 'все', 'всё',
  'там', 'тут', 'здесь', 'можно', 'нужно', 'надо', 'давай', 'давайте',
  // Uzbek
  'va', 'bu', 'shu', 'ham', 'bilan', 'uchun', 'esa', 'lekin', 'endi', 'keyin', 'bir', 'biz',
  'siz', 'ular', 'men', 'sen', 'yoki', 'agar', 'chunki',
  // Arabic (C4 §14.5)
  'على', 'الى', 'إلى', 'عن', 'مع', 'لكن', 'ثم', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي',
  'الذين', 'انه', 'أنه', 'انها', 'أنها', 'كان', 'كانت', 'قد', 'لقد', 'هو', 'هي', 'هم',
  'نحن', 'انا', 'أنا', 'انت', 'أنت', 'كل', 'بعض', 'او', 'أو', 'اذا', 'إذا', 'لان', 'لأن',
  'حتى', 'عند', 'بين', 'ايضا', 'أيضا', 'هناك', 'يكون', 'تكون',
];

/** Folded the same way `wordsOf` folds, so `i'm` matches the `iʻm` it becomes. */
const CONNECTIVES: ReadonlySet<string> = new Set(CONNECTIVE_LIST.map(foldWord));

/** Grammar words a rewrite may add without adding a fact. */
export function isConnective(word: string): boolean {
  return count(word) <= 2 || CONNECTIVES.has(word);
}
