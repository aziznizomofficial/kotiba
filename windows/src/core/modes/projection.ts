// A model's punctuation, laid over the speaker's words — a port of `PunctuationProjection`
// (Sources/KotibaCore/PunctuationProjection.swift), pinned by the `projection` rows of
// `fixtures/golden/modes.json`.
//
// PURE. The measured failure of every model tried as a "light correction" pass is the
// same: it changes a word. Projection keeps the model's commas, question marks and case
// and nothing else — the input's words are aligned to the model's (longest common
// subsequence over case- and apostrophe-folded forms); every input word is kept, in order,
// and takes the model's case and edge punctuation where aligned. A word the model added is
// dropped; a word it removed is kept. So Super's output can differ from what was said only
// in punctuation and capitalisation — by construction, not by a guard that might miss.

import { EDGE_PUNCTUATION, endsSentence, fixSpacing, joinTokens, splitTokens } from './cleanup.js';
import { arabicFold } from './sentences.js';
import { chars, dropFirst, firstChar, foldApostrophes, isLetter, isLowercase, isNumber, isUppercase } from './swift.js';

export interface ProjectionResult {
  readonly text: string;
  /** Share of the input's words the model's output could be aligned to. */
  readonly aligned: number;
}

/**
 * Below this share of aligned words the model wrote something else, and its punctuation
 * would land on the wrong words. Every real sentence where the model only punctuated
 * aligned at 1.00; the worst legitimate case at 0.83.
 */
export const MINIMUM_ALIGNMENT = 0.7;

const TERMINATORS = '.!?…';

/**
 * `mayDrop` (the Mac's `project(_:onto:mayDrop:)`, Arabic Message, C4 §14.5): an input word the
 * model dropped is dropped too when it is in `mayDrop` (folded) or repeats the word before it;
 * those words do not count against the alignment. Every other input word stays.
 */
export function project(model: string, input: string, mayDrop?: ReadonlySet<string>): ProjectionResult {
  const source = splitTokens(input);
  const target = splitTokens(model);
  if (source.length === 0) return { text: input, aligned: 1 };
  const dropping = mayDrop === undefined ? null : new Set([...mayDrop].map(fold));

  const a = source.map((token) => fold(token.core));
  const b = target.map((token) => fold(token.core));
  const pairs = lcs(a, b);
  const counted = a.filter((word, index) => {
    if (word === '') return false;
    if (dropping === null) return true;
    return !(dropping.has(word) || (index > 0 && a[index - 1] === word));
  }).length;
  const aligned = Math.min(1, pairs.length / Math.max(1, counted));
  if (aligned < MINIMUM_ALIGNMENT) return { text: input, aligned };

  const out = source.map((token) => ({ ...token }));
  const alignedIndices = new Set<number>();
  for (const [i, j] of pairs) {
    alignedIndices.add(i);
    const from = target[j]!;
    const fromWord = strip(from.core);
    const into = out[i]!;
    const original = source[i]!.core;
    // Case: take the model's only when it is the same letters.
    if (fromWord.toLowerCase() === original.toLowerCase()) {
      into.core = fromWord;
    } else if (isUppercase(firstChar(fromWord))) {
      const first = firstChar(original);
      if (first !== undefined && isLowercase(first)) into.core = first.toUpperCase() + dropFirst(original);
    }
    into.leading = sanitise(from.leading);
    into.trailing = sanitise(from.trailing);
  }

  // With `mayDrop`, a pause the model put before words it left out (and we keep) belongs after
  // them, at the end of the speaker's phrase.
  if (dropping !== null) {
    let k = 0;
    while (k < out.length) {
      if (alignedIndices.has(k) && out[k]!.trailing !== '' && !endsSentence(out[k]!)) {
        let j = k + 1;
        while (j < out.length && !alignedIndices.has(j)) j += 1;
        if (j > k + 1 && out[j - 1]!.trailing === '') {
          out[j - 1]!.trailing = out[k]!.trailing;
          out[k]!.trailing = '';
        }
        k = j;
      } else {
        k += 1;
      }
    }
  }
  // The model ended a sentence on a word it kept and then dropped the words the speaker
  // said after it: the end belongs after those words. Without this, "call the plumber
  // today now" came back as "call the plumber today. now".
  let i = 0;
  while (i < out.length) {
    if (alignedIndices.has(i) && endsSentence(out[i]!)) {
      let j = i + 1;
      while (j < out.length && !alignedIndices.has(j)) j += 1;
      if (j > i + 1 && !endsSentence(out[j - 1]!)) {
        const mark = chars(out[i]!.trailing).filter((ch) => TERMINATORS.includes(ch)).join('');
        out[i]!.trailing = chars(out[i]!.trailing).filter((ch) => !TERMINATORS.includes(ch)).join('');
        out[j - 1]!.trailing += mark;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  // `mayDrop`: the model's deletions of fillers and repeats are kept.
  let result = out;
  if (dropping !== null) {
    const kept: typeof out = [];
    let carriedBreak = '';
    out.forEach((token, index) => {
      const word = a[index]!;
      const repeated = index > 0 && word !== '' && a[index - 1] === word;
      if (!alignedIndices.has(index) && word !== '' && (dropping.has(word) || repeated)) {
        if (endsSentence(token)) {
          const last = kept.pop();
          if (last !== undefined) {
            if (!endsSentence(last)) last.trailing += token.trailing;
            kept.push(last);
          }
        }
        if (token.breakBefore !== '') carriedBreak = token.breakBefore;
        return;
      }
      const next = { ...token };
      if (carriedBreak !== '' && next.breakBefore === '') next.breakBefore = carriedBreak;
      carriedBreak = '';
      kept.push(next);
    });
    if (kept.length > 0) result = kept;
  }
  return { text: fixSpacing(joinTokens(result)), aligned };
}

/**
 * Only punctuation may come across. Anything else found at a word's edge — an emoji, a
 * markdown marker — is the model writing, not punctuating.
 */
function sanitise(edge: string): string {
  return chars(edge)
    .filter((ch) => EDGE_PUNCTUATION.has(ch))
    .join('');
}

function fold(word: string): string {
  return arabicFold(foldApostrophes(strip(word).toLowerCase()).split('ʻ').join("'"));
}

/** The word without whatever non-letters the model wrapped it in (`**Buy**`). */
function strip(word: string): string {
  const all = chars(word);
  const isPart = (ch: string): boolean => isLetter(ch) || isNumber(ch);
  const first = all.findIndex(isPart);
  if (first < 0) return word;
  let last = all.length - 1;
  while (last > first && !isPart(all[last]!)) last -= 1;
  return all.slice(first, last + 1).join('');
}

/** Index pairs of a longest common subsequence. Sentences are tens of words. */
function lcs(a: readonly string[], b: readonly string[]): [number, number][] {
  if (a.length === 0 || b.length === 0) return [];
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] !== '' && a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] !== '' && a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}
