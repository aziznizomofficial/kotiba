// How a dictated note is laid out, deterministically — a port of `NoteLayout`
// (Sources/KotibaCore/NoteLayout.swift), pinned by the `note` rows of
// `fixtures/golden/modes.json`.
//
// PURE. On-device models of the size that fits the latency budget could not be trusted to
// restructure a whole dictation: Qwen3-1.7B turned "No need to ask me before doing." into
// three checkboxes about a pricing page from its own examples. So the model's job shrinks
// to one word per sentence — TASK or POINT — and everything visible is built here from the
// speaker's own words. A model that misclassifies costs a checkbox; it cannot cost a word.

import type { Language } from '../../contracts/index.js';

import { lowercaseIn, uppercaseIn } from './cleanup.js';
import { isConnective, sharesStem, wordsOf } from './sentences.js';
import {
  chars,
  count,
  foldApostrophes,
  isLetter,
  splitOn,
  trimPunctuation,
  trimSet,
  trimWhitespace,
} from './swift.js';

export type NoteKind = 'task' | 'item' | 'point';

export interface NoteLine {
  readonly kind: NoteKind;
  readonly text: string;
}

/** Words that open an enumerated item, per language, matched at the sentence start. */
const ORDINAL_OPENERS: Readonly<Record<Language, readonly string[]>> = {
  en: [
    'first of all', 'firstly', 'first', 'secondly', 'second', 'thirdly', 'third', 'fourth',
    'fifth', 'then finally', 'finally', 'lastly', 'number one', 'number two', 'number three',
    'number four', 'number five', 'one', 'two', 'three', 'four', 'five', '1', '2', '3', '4', '5',
  ],
  ru: [
    'во-первых', 'во-вторых', 'в-третьих', 'в-четвёртых', 'в-четвертых', 'в-пятых', 'первое',
    'второе', 'третье', 'четвёртое', 'четвертое', 'пятое', 'и наконец', 'наконец', '1', '2', '3',
    '4', '5',
  ],
  uz: [
    'birinchidan', 'ikkinchidan', 'uchinchidan', 'toʻrtinchidan', 'beshinchidan', 'birinchi',
    'ikkinchi', 'uchinchi', 'toʻrtinchi', 'beshinchi', 'va nihoyat', 'nihoyat', 'oxirida',
    '1', '2', '3', '4', '5',
  ],
  tr: [
    'birincisi', 'ikincisi', 'üçüncüsü', 'dördüncüsü', 'beşincisi', 'ilk olarak', 'ikinci olarak',
    'üçüncü olarak', 've son olarak', 'son olarak', 'sonuç olarak', '1', '2', '3', '4', '5',
  ],
  ar: [
    'أولاً', 'أولا', 'ثانياً', 'ثانيا', 'ثالثاً', 'ثالثا', 'رابعاً', 'رابعا', 'خامساً', 'خامسا',
    'وأخيراً', 'وأخيرا', 'أخيراً', 'أخيرا', '1', '2', '3', '4', '5',
  ],
};

const BARE_ORDINALS: ReadonlySet<string> = new Set(['one', 'two', 'three', 'four', 'five', '1', '2', '3', '4', '5']);

/**
 * The sentence with an ordinal opener removed, or `null` when it does not open with one.
 * The bare numbers count only when followed by `,` `:` `.` `)`: "One more thing" is not
 * the first item of a list.
 */
export function strippingOrdinal(sentence: string, language: Language): string | null {
  const folded = foldApostrophes(sentence);
  const lowered = lowercaseIn(folded, language);
  for (const opener of ORDINAL_OPENERS[language]) {
    const key = foldApostrophes(opener);
    if (!lowered.startsWith(key)) continue;
    const rest = chars(folded).slice(count(key));
    const next = rest[0];
    if (next === undefined) continue;
    if (BARE_ORDINALS.has(key)) {
      if (!(next === ',' || next === ':' || next === '.' || next === ')')) continue;
    } else if (isLetter(next)) {
      continue;
    }
    let start = 0;
    while (start < rest.length && [',', ':', '.', ')', ' ', '-'].includes(rest[start]!)) start += 1;
    const body = rest.slice(start).join('');
    if (body === '') continue;
    return capitaliseFirst(body, language);
  }
  return null;
}

/** Lead-ins that turn a sentence into a to-do without adding to it. */
const TASK_LEAD_INS: Readonly<Record<Language, readonly string[]>> = {
  en: [
    'i want you to', 'i need you to', "i'd like you to", "don't forget to", 'make sure to',
    'make sure you', 'remember to', 'we need to', 'we have to', 'we should', 'i need to',
    'i have to', 'i should', 'you need to', 'you have to', 'you should', 'we must', 'i must',
    'you must', 'please', "let's", 'lets',
  ],
  ru: [
    'не забудь', 'не забыть', 'нам нужно', 'мне нужно', 'тебе нужно', 'вам нужно', 'нам надо',
    'мне надо', 'тебе надо', 'вам надо', 'надо', 'нужно', 'необходимо', 'пожалуйста',
  ],
  uz: ['iltimos', 'esingizdan chiqmasin', 'unutmang'],
  tr: ['unutma', 'unutmayın', 'lütfen', 'yapmamız gerekiyor', 'yapmam gerekiyor', 'yapman gerekiyor'],
  ar: [
    'لا تنس', 'لا تنسى', 'لا تنسوا', 'من فضلك', 'يجب أن', 'يجب ان', 'لازم', 'علينا أن', 'علينا ان', 'رجاءً', 'رجاء',
    // The dialects' and the to-do list's own (C4 §14.5).
    'ما تنساش', 'ما تنسيش', 'متنساش', 'لا تنسي', 'تذكر أن', 'تذكر ان', 'ذكرني', 'ذكّرني', 'خليك فاكر', 'خلينا',
    'ضروري', 'لو سمحت', 'يجب علينا', 'يجب على', 'نحتاج أن', 'نحتاج ان', 'عليّ أن', 'علي أن',
  ],
};

/**
 * The text of a task line: lead-in removed, `… kerak` / `… lozim` removed in Uzbek, first
 * letter capitalised, final full stop dropped (a checkbox is not a sentence).
 */
export function taskText(sentence: string, language: Language): string {
  let text = trimWhitespace(sentence);
  const lowered = lowercaseIn(text, language);
  // Longest first. Equal lengths cannot both be prefixes of one text, so order among them
  // does not matter — which is why the Swift's unstable sort is safe to copy.
  const leadIns = [...TASK_LEAD_INS[language]].sort((a, b) => count(b) - count(a));
  for (const leadIn of leadIns) {
    if (!lowered.startsWith(leadIn)) continue;
    const rest = chars(text).slice(count(leadIn));
    const next = rest[0];
    if (next === undefined || isLetter(next)) continue;
    let start = 0;
    while (start < rest.length && (rest[start] === ' ' || rest[start] === ',')) start += 1;
    const trimmed = rest.slice(start).join('');
    // Never trim a sentence down to nothing, or to one word it cannot stand on.
    if (splitOn(trimmed, ' ').length >= 2) text = trimmed;
    break;
  }
  if (language === 'uz') {
    for (const tail of [' kerak.', ' kerak', ' lozim.', ' lozim', ' shart.', ' shart']) {
      if (text.toLowerCase().endsWith(tail) && splitOn(text, ' ').length > 2) {
        text = chars(text).slice(0, -count(tail)).join('');
        break;
      }
    }
  }
  while (text.endsWith('.')) text = text.slice(0, -1);
  return capitaliseFirst(text, language);
}

const IMPERATIVE_OPENERS: ReadonlySet<string> = new Set([
  'add', 'ask', 'book', 'buy', 'call', 'change', 'check', 'clean', 'create', 'delete', 'email',
  'find', 'finish', 'fix', 'get', 'go', 'make', 'move', 'order', 'pay', 'pick', 'prepare',
  'remove', 'reply', 'review', 'schedule', 'send', 'set', 'ship', 'start', 'stop', 'text',
  'update', 'write', 'turn', 'install', 'build', 'test', 'merge', 'deploy', 'open', 'close',
  'print', 'sign', 'submit', 'tell', 'remind', 'renew', 'cancel', 'bring', 'take', 'put',
  'save', 'share', 'upload', 'download', 'research', 'analyze', 'analyse', 'draft',
]);

/**
 * Without a model: is this sentence a to-do? Lead-ins, `kerak`, and an English imperative
 * opener. Conservative — a missed task is still on the page as a sentence.
 */
export function looksLikeTask(sentence: string, language: Language): boolean {
  const lowered = trimWhitespace(lowercaseIn(sentence, language));
  if (TASK_LEAD_INS[language].some((leadIn) => lowered.startsWith(leadIn + ' '))) return true;
  switch (language) {
    case 'en': {
      const firstWord = splitOn(lowered, ' ')[0];
      const first = firstWord === undefined ? '' : trimPunctuation(firstWord);
      return IMPERATIVE_OPENERS.has(first) && !lowered.endsWith('?');
    }
    case 'ru':
      return false;
    case 'uz': {
      const bare = trimSet(lowered, '.!');
      return bare.endsWith(' kerak') || bare.endsWith(' lozim');
    }
    case 'tr': {
      // `… gerekiyor` / `… lazım`: the Turkish counterpart of Uzbek's closing `kerak`.
      const bare = trimSet(lowered, '.!');
      return bare.endsWith(' gerekiyor') || bare.endsWith(' lazım') || bare.endsWith(' gerek');
    }
    case 'ar':
      return false;
  }
}

/** One sentence into one note line, given its kind. */
export function noteLine(sentence: string, kind: NoteKind, language: Language): NoteLine {
  switch (kind) {
    case 'task':
      return { kind: 'task', text: taskText(sentence, language) };
    case 'item': {
      // A list line, like a checkbox, is not a sentence: no closing full stop.
      let body = strippingOrdinal(sentence, language) ?? sentence;
      while (body.endsWith('.')) body = body.slice(0, -1);
      return { kind: 'item', text: body };
    }
    case 'point':
      return { kind: 'point', text: sentence };
  }
}

/**
 * The finished note. Consecutive points form one paragraph; tasks and items are list
 * lines; a blank line separates a paragraph from a list.
 */
export function renderNote(heading: string | null, lines: readonly NoteLine[]): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push(paragraph.join(' '));
    paragraph = [];
  };
  const flushList = (): void => {
    if (list.length > 0) blocks.push(list.join('\n'));
    list = [];
  };
  for (const line of lines) {
    if (line.text === '') continue;
    switch (line.kind) {
      case 'point':
        flushList();
        paragraph.push(line.text);
        break;
      case 'task':
        flushParagraph();
        list.push('- [ ] ' + line.text);
        break;
      case 'item':
        flushParagraph();
        list.push('- ' + line.text);
        break;
    }
  }
  flushParagraph();
  flushList();
  if (heading !== null && heading !== '') blocks.unshift('## ' + heading);
  return blocks.join('\n\n');
}

/**
 * Whether a model's heading is made only of the note's own words (or their stems), plus
 * connectives. Anything else is the model naming the note with words nobody said.
 */
export function acceptsHeading(heading: string, text: string): boolean {
  const words = wordsOf(heading);
  if (words.length < 1 || words.length > 6 || heading.includes('\n') || count(heading) > 60) return false;
  const source = wordsOf(text);
  return words.every((word) => isConnective(word) || source.some((other) => sharesStem(word, other)));
}

/** A heading as it should appear: trimmed of quotes, markdown and a final stop. */
export function cleanHeading(raw: string): string {
  const firstLine = raw.split('\n').filter((line) => line !== '')[0] ?? '';
  return capitaliseFirst(trimSet(firstLine, '#*"\'«»“” \t.'));
}

export function capitaliseFirst(text: string, language: Language = 'en'): string {
  const all = chars(text);
  const index = all.findIndex((ch) => isLetter(ch));
  if (index < 0) return text;
  return all.slice(0, index).join('') + uppercaseIn(all[index]!, language) + all.slice(index + 1).join('');
}
