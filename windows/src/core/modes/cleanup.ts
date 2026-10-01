// The deterministic half of every mode — a port of `DictationCleanup`
// (Sources/KotibaCore/DictationCleanup.swift), pinned byte-for-byte by the `cleanup` rows of
// `fixtures/golden/modes.json` (197 of them: invented sentences in the shapes real
// diagnostics showed, plus the 120 committed Uzbek transcripts).
//
// PURE. Well under a millisecond per dictation, runs on every dictation that is not Raw,
// and cannot invent a word: the only operations are delete, re-punctuate and re-case.
// What it is for, measured on the owner's 1,094 English dictations (C3 §3): 139 filler
// tokens, 69 mid-sentence full stops the transcriber put at a pause and then lowercased
// past, stray capitals after commas, 16 stuttered doubles.
//
// Everything is per language on purpose. Uzbek ASR output is entirely lowercase, so the
// false-stop rule ("a stop followed by a lowercase word is not a sentence end") would
// delete every sentence boundary in every Uzbek dictation; Uzbek also reduplicates words
// as grammar (`tez tez`), so its stutter rule only touches pronouns and particles.
//
// Turkish and Arabic (C4, the Mac's D-11) follow the Uzbek pattern for the same reasons: both
// reduplicate as grammar (`yavaş yavaş`, `شوي شوي`), so only function words collapse, and neither
// gets the English transcriber-artefact rules. Arabic's marks `،` `؛` `؟` are punctuation wherever
// punctuation is reasoned about, and a closing question takes `؟`. Turkish lowercases through its
// own locale (`lowerIn`): the locale-free `toLowerCase` turns `İ` into `i` + a combining dot.

import type { Language } from '../../contracts/index.js';

import {
  chars,
  count,
  dropFirst,
  firstChar,
  foldApostrophes,
  isLetter,
  isLowercase,
  isNumber,
  isUppercase,
  lastChar,
  splitOn,
  splitWhere,
  trimWhitespace,
} from './swift.js';

// ---------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------

/**
 * A whitespace-delimited chunk, split into what surrounds the word and the word itself.
 *
 * `core` keeps internal punctuation — `don't`, `o'zbek`, `3.5`, `e.g` — because the
 * rules reason about the word, and the edges are what they move around.
 */
export interface Token {
  leading: string;
  core: string;
  trailing: string;
  /** A line break that preceded this token, kept verbatim so "new line" survives. */
  breakBefore: string;
}

export const EDGE_PUNCTUATION: ReadonlySet<string> = new Set([
  ',', '.', '!', '?', ';', ':', '…', '"', "'", '(', ')', '[', ']', '«', '»',
  '“', '”', '‘', '’', '-', '—', '–',
  // Arabic comma, semicolon and question mark.
  '\u060C', '\u061B', '\u061F',
]);

/**
 * The marks the Swift still spells `".!?…"` — a filler's carried sentence end, and whether a
 * spoken command sits mid-sentence. `STOPS` below is the wider set (`DictationCleanup.stops`).
 */
const TERMINATORS = '.!?…';

/** What ends a sentence, in every language: `.` `!` `?` `…` and the Arabic `؟`. */
export const STOPS: ReadonlySet<string> = new Set(['.', '!', '?', '…', '\u061F']);

/** `Language.lowercased`: Turkish through its locale, everything else locale-free. */
export function lowercaseIn(text: string, language: Language): string {
  return language === 'tr' ? text.toLocaleLowerCase('tr') : text.toLowerCase();
}

/** `Language.uppercased`. */
export function uppercaseIn(text: string, language: Language): string {
  return language === 'tr' ? text.toLocaleUpperCase('tr') : text.toUpperCase();
}

export function lower(token: Token): string {
  return token.core.toLowerCase();
}

/** `DictationCleanup.lower(_:)`: a token's word, lowercased the way this language lowercases. */
export function lowerIn(token: Token, language: Language): string {
  return lowercaseIn(token.core, language);
}

export function endsSentence(token: Token): boolean {
  return chars(token.trailing).some((ch) => STOPS.has(ch));
}

function makeToken(chunk: string, breakBefore: string): Token {
  const all = chars(chunk);
  let start = 0;
  let end = all.length;
  // An okina or apostrophe leading a word is part of it only in the middle; at the edges
  // it is a quote. `'salom'` → quote, salom, quote.
  while (start < end && EDGE_PUNCTUATION.has(all[start]!)) start += 1;
  while (end > start && EDGE_PUNCTUATION.has(all[end - 1]!)) end -= 1;
  return {
    leading: all.slice(0, start).join(''),
    core: all.slice(start, end).join(''),
    trailing: all.slice(end).join(''),
    breakBefore,
  };
}

export function splitTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let pendingBreak = '';
  let current = '';
  const flush = (): void => {
    if (current === '') return;
    tokens.push(makeToken(current, pendingBreak));
    pendingBreak = '';
    current = '';
  };
  for (const ch of chars(text)) {
    if (ch === '\n') {
      flush();
      pendingBreak += ch;
    } else if (ch === ' ' || ch === '\t') {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return tokens;
}

export function joinTokens(tokens: readonly Token[]): string {
  let out = '';
  tokens.forEach((t, i) => {
    if (t.breakBefore !== '') {
      while (out.endsWith(' ')) out = out.slice(0, -1);
      out += t.breakBefore;
    } else if (i > 0) {
      out += ' ';
    }
    out += t.leading + t.core + t.trailing;
  });
  return out;
}

// ---------------------------------------------------------------------------------
// Tables — the Swift's, verbatim
// ---------------------------------------------------------------------------------

/**
 * Sounds that carry nothing, per language. Words that are sometimes filler and sometimes
 * meaning — `like`, `so`, `ну`, `как бы`, `haligi` — are deliberately absent: deleting one
 * that meant something is worse than keeping one that did not, and that call is what the
 * Message mode's model is for.
 */
const FILLERS: Readonly<Record<Language, ReadonlySet<string>>> = {
  en: new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'uhm', 'erm', 'hmm', 'hmmm', 'mm', 'mmm', 'mhm']),
  ru: new Set(['э', 'ээ', 'эээ', 'эм', 'эмм', 'ммм', 'мм', 'хм', 'хмм', 'а-а', 'э-э', 'э-э-э', 'um', 'uh']),
  uz: new Set(['ee', 'eee', 'e-e', 'mmm', 'mm', 'hmm', 'hmmm', 'um', 'uh', 'эээ', 'ээ']),
  // `şey` and `yani` are fillers only sometimes — `bir şey` is "something", `yani` often
  // carries "that is" — so they stay, by the rule above.
  tr: new Set(['ıı', 'ııı', 'ıh', 'ee', 'eee', 'eh', 'hmm', 'hmmm', 'mm', 'mmm', 'um', 'uh']),
  // `إيه` is Egyptian "what" as often as it is a hesitation, so it stays.
  ar: new Set(['امم', 'اممم', 'ممم', 'مم', 'أمم', 'إمم', 'اه', 'آه', 'um', 'uh']),
};

/**
 * A bare `e` / `э` is a hesitation only when commas fence it off or it opens the text
 * before a comma: `grammatik, e, talaffuzda` (measured, real Uzbek).
 */
const FENCED_FILLERS: ReadonlySet<string> = new Set(['e', 'э', 'a', 'er']);

/**
 * A single letter beside another single letter, or before `and`/`or`, is an item of a list
 * being read out — `A, B and C`, `x, a, and b` — not a hesitation. Deleting it deleted an
 * option the speaker named. (`DictationCleanup.isListItem`, core review 2026-09-30.)
 */
function isListItem(index: number, tokens: readonly Token[]): boolean {
  if (count(tokens[index]!.core) !== 1) return false;
  const isSingleLetter = (i: number): boolean => {
    const token = tokens[i];
    return token !== undefined && count(token.core) === 1 && isLetter(firstChar(token.core));
  };
  const next = tokens[index + 1];
  return isSingleLetter(index - 1) || isSingleLetter(index + 1) || (next !== undefined && LIST_JOINERS.has(lower(next)));
}

const LIST_JOINERS: ReadonlySet<string> = new Set(['and', 'or', 'va', 'yoki', 'и', 'или', 've', 'veya', 'yahut', 'أو']);

/**
 * `DictationCleanup.stutterable`: the only English and Russian words a double of which is
 * collapsed as a stutter — articles, pronouns, conjunctions, prepositions that are never also
 * a verb's particle, a few modals. The list used to run the other way (collapse any double
 * but a list of real ones) and deleted `Bora Bora`, `choo choo`, `a salad salad`, `белый
 * белый` and, most often, a phrasal verb meeting its preposition: `sign in in the morning`.
 */
const STUTTERABLE: Readonly<Record<Language, ReadonlySet<string>>> = {
  en: new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'nor', 'if', 'as', 'than', 'because', 'although',
    'i', 'me', 'my', 'you', 'your', 'he', 'him', 'his', 'she', 'it', 'its', 'we', 'us', 'our',
    'they', 'them', 'their', 'this', 'these', 'those', 'who', 'which', 'what', 'where', 'when',
    'why', 'how', 'other', 'another', 'to', 'of', 'for', 'with', 'from', 'at', 'into', 'onto',
    'would', 'could', 'should', 'might', 'must', 'shall',
    "i'm", "i've", "i'll", "i'd", "you're", "we're", "they're", "it's", "that's", "there's",
    "he's", "she's", "don't", "didn't", "doesn't",
  ]),
  ru: new Set([
    'я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они', 'меня', 'мне', 'мной', 'тебя', 'тебе',
    'тобой', 'его', 'него', 'её', 'ее', 'неё', 'нее', 'ему', 'нему', 'ей', 'ней', 'им', 'ним',
    'их', 'них', 'нас', 'нам', 'вас', 'вам', 'мой', 'моя', 'моё', 'мое', 'мои', 'твой', 'твоя',
    'твои', 'наш', 'наша', 'наше', 'наши', 'ваш', 'ваша', 'ваше', 'ваши', 'этот', 'эта', 'это',
    'эти', 'этого', 'этой', 'этом', 'и', 'а', 'но', 'или', 'в', 'во', 'на', 'с', 'со', 'к',
    'ко', 'по', 'от', 'из', 'за', 'для', 'до', 'про', 'без', 'при', 'над', 'под', 'через', 'же',
    'бы', 'ли', 'если', 'чтобы', 'потому', 'который', 'которая', 'которое', 'которые',
  ]),
  uz: new Set(),
  // Turkish reduplicates adjectives and adverbs as grammar (`yavaş yavaş`, `güzel güzel`,
  // `ara ara`), so, as for Uzbek, only pronouns, conjunctions and postpositions.
  tr: new Set([
    'ben', 'sen', 'biz', 'siz', 'onlar', 'bu', 'şu', 'bunu', 'şunu', 'onu', 'benim',
    'senin', 'bizim', 'sizin', 'onun', 've', 'ama', 'fakat', 'ile', 'için', 'gibi',
    'ki', 'eğer', 'çünkü', 'veya', 'yani',
  ]),
  // Arabic writes `و` and `ف` as prefixes, so the separate function words are few; its
  // reduplication (`شوي شوي`, `واحد واحد`) is grammar and stays.
  ar: new Set([
    'في', 'على', 'إلى', 'الى', 'عن', 'هذا', 'هذه', 'ذلك', 'تلك', 'أنا', 'انا', 'أنت',
    'انت', 'هو', 'هي', 'نحن', 'هم', 'أن', 'إن', 'ان', 'لكن', 'أو', 'ثم', 'التي',
    'الذي',
  ]),
};

/**
 * `DictationCleanup.clauseOpeningStutterable`: a particle doubled where no verb comes before
 * it — `Also, in in the garden` — cannot be a phrasal verb meeting its preposition.
 */
const CLAUSE_OPENING_STUTTERABLE: Readonly<Record<Language, ReadonlySet<string>>> = {
  en: new Set(['in', 'on', 'up', 'out', 'off', 'over', 'down', 'by', 'about', 'through', 'around']),
  ru: new Set(),
  uz: new Set(),
  tr: new Set(),
  ar: new Set(),
};

/**
 * Uzbek reduplicates adjectives, adverbs and verbs as grammar (`tez tez`, `asta asta`),
 * so only these — pronouns, particles, conjunctions — are treated as stutters.
 */
const UZBEK_STUTTERABLE: ReadonlySet<string> = new Set([
  'men', 'sen', 'u', 'biz', 'siz', 'ular', 'bu', 'shu', 'oʻsha', 'va', 'lekin', 'keyin',
  'endi', 'ham', 'bilan', 'uchun', 'agar', 'chunki', 'yani', 'yaʻni', 'manga', 'menga',
  'senga', 'unga', 'bizga', 'sizga', 'mening', 'sening', 'uning', 'the', 'and', 'a', 'i',
]);

const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'inc', 'ltd', 'co', 'no', 'approx',
]);

/**
 * Frequent English words that are practically never a proper noun when dictated. `Will`,
 * `May`, `Mark`, `Notes`, `Mail` and `Code` are deliberately absent.
 */
const COMMON_LOWERCASE: ReadonlySet<string> = new Set(
  (
    'a about above after again against all almost also always am an and another any anyone ' +
    'anything are around as ask at away back be because been before being below between both ' +
    "but by can can't come could couldn't create did didn't do does doesn't doing don't done " +
    'down during each either else enough even ever every everything few find first fix for ' +
    'from full fully get give go going gonna got had has have having he her here hers him his ' +
    "how however if in into is isn't it it's its just keep know last later less let let's like " +
    'little look lot made make many maybe me might mine more most much must my need never new ' +
    'next no nor not nothing now of off often on once one only or other our ours out over own ' +
    'please put quite rather really right run said same say see seem send set she should ' +
    "shouldn't show since so some something still such sure take than that that's the their " +
    'them then there these they thing things think this those though through to together too ' +
    "try turn under until up upon us use very want wanna was wasn't way we well were weren't " +
    'what when where whether which while who whom whose why with within without won\'t would ' +
    "wouldn't yeah yes yet you your yours consider check change move open close add remove " +
    'start stop build make sure also actually basically just because okay ok instead each ' +
    'both whole every everyone someone somebody nobody anybody tell told write read made ' +
    'want wanted wants need needed needs have has had let lets makes making go goes went gone'
  )
    .split(' ')
    .filter((word) => word !== ''),
);

/**
 * Only commands that cannot be ordinary speech. `period` is a word (`the trial period`),
 * and so is Russian `точка` (`в одной точке А`, measured in the owner's own dictation), so
 * neither is here; `full stop` and `точка с запятой` are.
 */
const SPOKEN_PUNCTUATION: Readonly<Record<Language, readonly (readonly [string, string])[]>> = {
  en: [
    ['new paragraph', '\n\n'],
    ['new line', '\n'],
    ['question mark', '?'],
    ['exclamation mark', '!'],
    ['exclamation point', '!'],
    ['full stop', '.'],
    ['semicolon', ';'],
  ],
  ru: [
    ['новый абзац', '\n\n'],
    ['с новой строки', '\n'],
    ['новая строка', '\n'],
    ['вопросительный знак', '?'],
    ['восклицательный знак', '!'],
    ['точка с запятой', ';'],
    ['двоеточие', ':'],
  ],
  uz: [
    ['yangi xatboshi', '\n\n'],
    ['yangi qator', '\n'],
    ['soʻroq belgisi', '?'],
    ['undov belgisi', '!'],
    ['nuqtali vergul', ';'],
  ],
  // `nokta` alone is a word (`bir nokta`, "a point"), like `точка`, so it is not here.
  tr: [
    ['yeni paragraf', '\n\n'],
    ['yeni satır', '\n'],
    ['soru işareti', '?'],
    ['ünlem işareti', '!'],
    ['noktalı virgül', ';'],
  ],
  // Likewise `نقطة` alone ("a point", "a dot").
  ar: [
    ['فقرة جديدة', '\n\n'],
    ['سطر جديد', '\n'],
    ['علامة استفهام', '\u061F'],
    ['علامة تعجب', '!'],
    ['فاصلة منقوطة', '\u061B'],
  ],
};

const ENGLISH_QUESTION_OPENERS: ReadonlySet<string> = new Set([
  'what', 'why', 'how', 'when', 'where', 'who', 'whom', 'whose', 'which', 'can', 'could',
  'would', 'should', 'do', 'does', 'did', 'is', 'are', 'was', 'were', 'will', 'shall', 'have',
  'has', 'may', 'am', "isn't", "aren't", "don't", "doesn't", "didn't", "won't", "can't",
  "couldn't", "wouldn't", "shouldn't",
]);

const RUSSIAN_QUESTION_WORDS: ReadonlySet<string> = new Set([
  'что', 'почему', 'зачем', 'как', 'когда', 'где', 'куда', 'откуда', 'кто', 'сколько', 'какой',
  'какая', 'какое', 'какие', 'каким', 'чей', 'чья', 'чьё', 'разве', 'неужели', 'ли',
]);

const UZBEK_QUESTION_WORDS: ReadonlySet<string> = new Set([
  'nima', 'nimaga', 'nimani', 'nega', 'qanday', 'qanaqa', 'qachon', 'qayerda', 'qayerga',
  'qayerdan', 'kim', 'kimga', 'kimni', 'qaysi', 'necha', 'nechta', 'qancha', 'nimalar',
]);

/** Ordinary words that happen to end in the interrogative `-mi`. */
const UZBEK_NOT_QUESTIONS: ReadonlySet<string> = new Set(['ismi', 'qismi', 'rasmi', 'jismi', 'hammi', 'ilmi']);

const UZBEK_QUESTION_SUFFIXES = ['mi', 'mikan', 'mikin', 'misiz', 'misan', 'misizlar', 'mizmi'];

// ---------------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------------

export interface CleanupOptions {
  /**
   * Whether to close an unterminated last sentence with `.` or `?`. Off for a segment
   * that is not yet the end of the dictation.
   */
  readonly closesFinalSentence?: boolean;
}

/** `DictationCleanup(language:closesFinalSentence:).apply(text)`. */
export function cleanUp(text: string, language: Language, options: CleanupOptions = {}): string {
  let out = collapseSpaces(text);
  out = applySpokenPunctuation(out, language);
  let tokens = splitTokens(out);
  tokens = removeFillers(tokens, language);
  tokens = collapseStutters(tokens, language);
  if (language === 'en') {
    tokens = repairFalseStops(tokens);
    tokens = lowercaseStrayCapitals(tokens);
  }
  out = joinTokens(tokens);
  out = fixSpacing(out);
  if (options.closesFinalSentence ?? true) out = closeFinalSentence(out, language);
  return out;
}

// ---- fillers ----------------------------------------------------------------------

function removeFillers(tokens: readonly Token[], language: Language): Token[] {
  const plain = FILLERS[language];
  const input = tokens.map((token) => ({ ...token }));
  const out: Token[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const token = input[i]!;
    const word = lowerIn(token, language);
    const before = out[out.length - 1];
    const fenced =
      FENCED_FILLERS.has(word) &&
      token.trailing.startsWith(',') &&
      (before === undefined ? true : before.trailing.endsWith(',') || endsSentence(before)) &&
      !isListItem(i, input);
    if (!(token.core !== '' && token.leading === '' && (plain.has(word) || fenced))) {
      out.push(token);
      continue;
    }
    // The filler goes; what to do with the punctuation around it.
    //
    //   "how is, uh, the logic"  → both commas existed only for the filler: drop both.
    //   "give me. Um, captions"  → the stop belongs to the sentence before: kept.
    //   "and then, um. The next" → the filler carried the sentence end: move it back.
    //   "Так, э, нужно"          → the first comma follows an opening word: it stays.
    const carriesEnd = endsSentence(token);
    const opensSentence = before === undefined ? true : endsSentence(before);
    const previous = out.pop();
    if (previous !== undefined) {
      const beforePrevious = out[out.length - 1];
      const previousOpens = beforePrevious === undefined ? true : endsSentence(beforePrevious);
      if (carriesEnd && !endsSentence(previous)) {
        previous.trailing =
          previous.trailing.split(',').join('') +
          chars(token.trailing)
            .filter((ch) => TERMINATORS.includes(ch))
            .join('');
      } else if (previous.trailing === ',' && !carriesEnd && !previousOpens && i + 1 < input.length) {
        previous.trailing = '';
      }
      out.push(previous);
    }
    // A filler that opened a sentence carried its capital; the word after it inherits it,
    // or the false-stop rule below would read "me. the" as a pause.
    const next = input[i + 1];
    if (opensSentence && isUppercase(firstChar(token.core)) && next !== undefined) {
      const first = firstChar(next.core);
      if (first !== undefined && isLowercase(first)) {
        next.core = first.toUpperCase() + dropFirst(next.core);
      }
    }
    // A line break the filler sat after must not vanish with it.
    if (token.breakBefore !== '' && next !== undefined && next.breakBefore === '') {
      next.breakBefore = token.breakBefore;
    }
  }
  return out;
}

// ---- stutters ---------------------------------------------------------------------

function isStutterable(word: string, language: Language): boolean {
  if (language === 'uz') return UZBEK_STUTTERABLE.has(foldApostrophes(word));
  return STUTTERABLE[language].has(word);
}

/** Whether the last token of `out` (the first of a pair) opens the text, a line or a clause. */
function opensClause(out: readonly Token[]): boolean {
  return (
    out.length === 1 ||
    out[out.length - 1]!.breakBefore !== '' ||
    out[out.length - 2]!.trailing !== ''
  );
}

function collapseStutters(tokens: readonly Token[], language: Language): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      previous.trailing === '' &&
      token.leading === '' &&
      token.breakBefore === '' &&
      previous.core !== '' &&
      lowerIn(previous, language) === lowerIn(token, language) &&
      (isStutterable(lowerIn(token, language), language) ||
        (opensClause(out) && CLAUSE_OPENING_STUTTERABLE[language].has(lowerIn(token, language)))) &&
      !isNamePair(
        previous,
        token,
        out.length === 1 || endsSentence(out[out.length - 2]!) || previous.breakBefore !== '',
      )
    ) {
      // Keep the first one's case (it may open the sentence) and the second one's
      // trailing punctuation (it may close it).
      out[out.length - 1] = { ...previous, trailing: token.trailing };
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * `Bora Bora`, `Baden Baden`: both capitalised with neither opening the sentence is a name,
 * not a stutter. `I I` is the exception — its capital says nothing.
 */
function isNamePair(first: Token, second: Token, opensSentence: boolean): boolean {
  return (
    !opensSentence &&
    lower(first) !== 'i' &&
    isUppercase(firstChar(first.core)) &&
    isUppercase(firstChar(second.core))
  );
}

// ---- English transcriber artefacts -------------------------------------------------

/** `you don't. Cross. a point` → `you don't. Cross a point`. */
function repairFalseStops(tokens: readonly Token[]): Token[] {
  const out = tokens.map((token) => ({ ...token }));
  if (out.length <= 1) return out;
  for (let i = 0; i < out.length - 1; i += 1) {
    const next = out[i + 1]!;
    const first = firstChar(next.core);
    if (
      out[i]!.trailing !== '.' ||
      next.leading !== '' ||
      next.breakBefore !== '' ||
      first === undefined ||
      !isLetter(first) ||
      !isLowercase(first)
    ) {
      continue;
    }
    const word = lower(out[i]!);
    if (
      count(word) <= 1 ||
      word.includes('.') ||
      !(chars(word).every(isLetter) || word.includes("'")) ||
      ABBREVIATIONS.has(word)
    ) {
      continue;
    }
    out[i]!.trailing = '';
  }
  return out;
}

/** `I wanna, Have 3` → `I wanna, have 3`; `I will Consider` → `I will consider`. */
function lowercaseStrayCapitals(tokens: readonly Token[]): Token[] {
  const out = tokens.map((token) => ({ ...token }));
  for (let i = 0; i < out.length; i += 1) {
    const token = out[i]!;
    const word = lower(token);
    const atStart = i === 0 || endsSentence(out[i - 1]!) || token.breakBefore !== '';
    if (word === 'i' || word.startsWith("i'")) {
      token.core = 'I' + dropFirst(token.core);
      continue;
    }
    const first = firstChar(token.core);
    // A capital standing alone is a name — `Plan B`, `Section A`, `vitamin A` — and `a`
    // being a common word made the first of those `Section a`.
    if (
      atStart ||
      token.leading !== '' ||
      count(token.core) <= 1 ||
      first === undefined ||
      !isUppercase(first) ||
      !chars(dropFirst(token.core)).every((ch) => isLowercase(ch) || ch === "'") ||
      !COMMON_LOWERCASE.has(word)
    ) {
      continue;
    }
    // Nor inside a name: a capitalised word on each side (`The New Line opened`), or `New`
    // before one (`New York`). Neighbours read from the input, as the Swift does.
    const next = tokens[i + 1];
    const previous = tokens[i - 1];
    const joinsNext =
      next !== undefined &&
      token.trailing === '' &&
      next.leading === '' &&
      next.breakBefore === '' &&
      isTitleCased(next);
    const joinsPrevious = previous !== undefined && previous.trailing === '' && isTitleCased(previous);
    if (joinsNext && (joinsPrevious || word === 'new')) continue;
    token.core = word;
  }
  return out;
}

/** `DictationCleanup.isTitleCased`: a capital and then at least one lowercase letter; not `I`. */
function isTitleCased(token: Token): boolean {
  const first = firstChar(token.core);
  const word = lower(token);
  if (first === undefined || !isUppercase(first) || count(token.core) <= 1) return false;
  if (word === 'i' || word.startsWith("i'")) return false;
  return chars(dropFirst(token.core)).some(isLowercase);
}

// ---- spoken punctuation -------------------------------------------------------------

/**
 * ICU's `\w`, which is what `\b` in an `NSRegularExpression` is defined against. JavaScript's
 * `\b` is ASCII-only even under the `u` flag, so it would never see a boundary inside
 * Cyrillic or Uzbek — every Russian command would silently stop matching.
 */
const WORD = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200C\\u200D]';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Words after which `new line` / `new paragraph` is a noun phrase — `a new line of shoes`,
 * `the new line feature` — and not a command. Without it both words were deleted and a line
 * break put in their place, which is the one thing this layer promises never to do.
 */
const NOUN_PHRASE_OPENERS =
  'a|an|the|this|that|these|those|our|my|your|their|his|her|its|whole|entire|new|every|each|another|one';

/**
 * `DictationCleanup.markOpeners`: the same for the marks — `came to a full stop`, `put a
 * question mark there`. Narrower: `one full stop two` is a command.
 */
const MARK_OPENERS = 'a|an|the|this|that|these|those|our|my|your|their|his|her|its|every|each|another|any';

function spokenPunctuationPattern(phrase: string, language: Language, breaksLine: boolean): RegExp {
  // Compared against an apostrophe-folded class so `so'roq`, `so‘roq` and `soʻroq` all match.
  const body = phrase
    .split(' ')
    .map((part) =>
      [...part]
        .map((ch) => (ch === 'ʻ' ? "['‘’ʻʼ`]" : escapeRegExp(ch)))
        .join(''),
    )
    .join('\\s+');
  // `(?i)([,\s]*)<guard>\b(<phrase>)\b[.,]?` — each `\b` here sits against a letter of the
  // phrase, so it reduces to "no word character on the other side". The Swift's noun guard,
  // `(?<!\b(?:a|an|…)\s)`, likewise: its `\b` sits before an ASCII letter.
  const openers = breaksLine ? NOUN_PHRASE_OPENERS : MARK_OPENERS;
  const guardNoun = language === 'en' ? `(?<!(?<!${WORD})(?:${openers})\\s)` : '';
  return new RegExp(`([,\\s]*)${guardNoun}(?<!${WORD})(${body})(?!${WORD})[.,]?`, 'giu');
}

/**
 * `DictationCleanup.isSpeech`: the matched phrase is speech, not a command, when nothing is
 * before it, when it is a mark at the start of a line, or when the transcriber capitalised it
 * as a name (a later word capitalised, or the first one mid-sentence).
 */
function isSpeech(phrase: string, leading: string, before: string, breaksLine: boolean): boolean {
  const last = lastChar(before);
  if (last === undefined) return true;
  if (!breaksLine && leading.includes('\n')) return true;
  const words = phrase.split(/\s+/u).filter((word) => word !== '');
  if (words.slice(1).some((word) => isUppercase(firstChar(word)))) return true;
  const midSentence = !leading.includes('\n') && !TERMINATORS.includes(last);
  return midSentence && words[0] !== undefined && isUppercase(firstChar(words[0]));
}

function applySpokenPunctuation(text: string, language: Language): string {
  let out = text;
  for (const [phrase, replacement] of SPOKEN_PUNCTUATION[language]) {
    const breaksLine = replacement.startsWith('\n');
    const template = breaksLine ? replacement : replacement + ' ';
    // A spoken sentence end opens a sentence, so the word after it takes a capital. Left
    // lowercase, `hello. how are you` read to `repairFalseStops` as a transcriber's stray
    // stop and the spoken "full stop" vanished without trace.
    const endsSentence = replacement === '.' || replacement === '?' || replacement === '!' || replacement === '\u061F';
    let rebuilt = '';
    let cursor = 0;
    let capitaliseNext = false;
    for (const match of out.matchAll(spokenPunctuationPattern(phrase, language, breaksLine))) {
      const speech = isSpeech(match[2]!, match[1]!, out.slice(0, match.index), breaksLine);
      // Speech is copied through untouched; a capital owed by a command before it is paid to
      // whatever comes first.
      const end = speech ? match.index + match[0].length : match.index;
      let between = out.slice(cursor, end);
      if (capitaliseNext) between = capitalisingFirstLetter(between, language);
      rebuilt += between + (speech ? '' : template);
      cursor = match.index + match[0].length;
      capitaliseNext = speech ? false : endsSentence;
    }
    let rest = out.slice(cursor);
    if (capitaliseNext) rest = capitalisingFirstLetter(rest, language);
    out = rebuilt + rest;
  }
  return out;
}

/** `DictationCleanup.capitalisingFirstLetter`: the first non-whitespace character, if a letter. */
function capitalisingFirstLetter(text: string, language: Language): string {
  const all = chars(text);
  const index = all.findIndex((ch) => !isSwiftWhitespace(ch));
  if (index < 0 || !isLetter(all[index])) return text;
  return all.slice(0, index).join('') + uppercaseIn(all[index]!, language) + all.slice(index + 1).join('');
}

/** `Character.isWhitespace`: the Unicode White_Space property of its first scalar. */
function isSwiftWhitespace(ch: string): boolean {
  return /^\p{White_Space}/u.test(ch);
}

// ---- spacing ------------------------------------------------------------------------

function collapseSpaces(text: string): string {
  let out = '';
  let lastWasSpace = false;
  for (const ch of chars(text)) {
    const isSpace = ch === ' ' || ch === '\t' || ch === ' ';
    if (isSpace && lastWasSpace) continue;
    out += isSpace ? ' ' : ch;
    lastWasSpace = isSpace;
  }
  return out;
}

const CLOSERS: ReadonlySet<string> = new Set([',', '.', '!', '?', ';', ':', '…', ')', ']', '»', '\u060C', '\u061B', '\u061F']);

/** After these, a space before a letter that follows at once — Arabic's `، ؛ ؟` too. */
const SPACED_AFTER: ReadonlySet<string> = new Set([',', ';', '?', '!', '\u060C', '\u061B', '\u061F']);

/**
 * No space before `, . ! ? ; : …`, one after it before a letter, no doubled marks, no
 * trailing spaces on a line. Exported: `PunctuationProjection` finishes with it.
 */
export function fixSpacing(text: string): string {
  const all = chars(text);
  const out: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const ch = all[i]!;
    const next = all[i + 1];
    if (ch === ' ' && next !== undefined && CLOSERS.has(next)) continue;
    // `,,` `,.` `.,` — keep the stronger of the two.
    const last = out[out.length - 1];
    if ((ch === ',' || ch === '.') && (last === ',' || last === '.') && !(ch === '.' && last === '.')) {
      if (ch === '.') out[out.length - 1] = '.';
      continue;
    }
    out.push(ch);
    // A space after a comma, semicolon, question or exclamation mark when a letter
    // follows immediately. Not after `.` or `:` — `3.5`, `e.g.`, `3:30`, URLs.
    if (SPACED_AFTER.has(ch) && next !== undefined && isLetter(next)) {
      out.push(' ');
    }
  }
  const lines = out.join('').split('\n').map(trimWhitespace);
  return trimWhitespace(lines.join('\n'));
}

// ---- final sentence ------------------------------------------------------------------

/**
 * Closes an unterminated dictation with `?` when it plainly asks something, `.` otherwise.
 * Three words minimum; Uzbek packs a question into two (`ertaga kelasizmi`).
 */
function closeFinalSentence(text: string, language: Language): string {
  const last = lastChar(text);
  if (last === undefined || !(isLetter(last) || isNumber(last))) return text;
  const lines = splitOn(text, '\n');
  const lastLine = lines[lines.length - 1] ?? text;
  const words = splitOn(lastLine, ' ');
  const asks = isQuestion(lastSentence(lastLine), language);
  if (!(words.length >= 3 || (words.length === 2 && asks))) return text;
  // Arabic closes a question with the mark Arabic writes.
  return text + (asks ? (language === 'ar' ? '\u061F' : '?') : '.');
}

function lastSentence(text: string): string {
  const all = chars(text);
  let cut = -1;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (STOPS.has(all[i]!)) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return text;
  return trimWhitespace(all.slice(cut + 1).join(''));
}

export function isQuestion(sentence: string, language: Language): boolean {
  const words = splitWhere(
    lowercaseIn(sentence, language),
    (ch) => !isLetter(ch) && ch !== "'" && ch !== 'ʻ' && ch !== '-',
  );
  const first = words[0];
  if (first === undefined) return false;
  switch (language) {
    case 'en':
      return ENGLISH_QUESTION_OPENERS.has(first);
    case 'ru':
      return RUSSIAN_QUESTION_WORDS.has(first) || (words.length > 1 && words[1] === 'ли');
    case 'uz': {
      // The interrogative suffixes are the reliable signal: `yaxshimisiz`, `bo'ladimi`,
      // `ko'rdingizmi`. A question word helps only when it opens the sentence.
      const lastWord = foldApostrophes(words[words.length - 1] ?? '');
      const suffixed =
        !UZBEK_NOT_QUESTIONS.has(lastWord) &&
        UZBEK_QUESTION_SUFFIXES.some(
          (suffix) => lastWord.endsWith(suffix) && count(lastWord) > count(suffix) + 2,
        );
      return suffixed || UZBEK_QUESTION_WORDS.has(first);
    }
    case 'tr':
      return (
        words.some(isTurkishQuestionParticle) ||
        TURKISH_QUESTION_WORDS.has(first) ||
        TURKISH_QUESTION_WORDS.has(words[words.length - 1] ?? '')
      );
    case 'ar': {
      // `وهل`, `فكيف`: the conjunction is written onto the question word.
      const bare = (first.startsWith('و') || first.startsWith('ف')) && count(first) > 2 ? dropFirst(first) : first;
      return ARABIC_QUESTION_OPENERS.has(first) || ARABIC_QUESTION_OPENERS.has(bare);
    }
  }
}

/**
 * Turkish question words. Unlike English they need not open the sentence (`Bu ne?`, `Saat
 * kaçta?`), so the first and the last word are both asked.
 */
const TURKISH_QUESTION_WORDS: ReadonlySet<string> = new Set([
  'ne', 'neden', 'niye', 'niçin', 'nasıl', 'nerede', 'nereye', 'nereden', 'neresi', 'kim',
  'kime', 'kimi', 'kimin', 'kimde', 'hangi', 'hangisi', 'kaç', 'kaçta', 'kaçıncı',
]);

/**
 * Turkish's question particle is a separate word — `mı mi mu mü` — carrying person and tense
 * after it: `geliyor musun`, `hazır mısınız`, `doğru mudur`. Any word of the sentence may be
 * it, and nothing else in Turkish is spelled this way.
 */
export function isTurkishQuestionParticle(word: string): boolean {
  const all = chars(word);
  if (all[0] !== 'm' || all.length < 2) return false;
  if (!'ıiuü'.includes(all[1]!)) return false;
  const rest = all.slice(2).join('');
  return rest === '' || TURKISH_PARTICLE_ENDINGS.has(rest);
}

const TURKISH_PARTICLE_ENDINGS: ReadonlySet<string> = new Set([
  'sın', 'sin', 'sun', 'sün', 'yım', 'yim', 'yum', 'yüm', 'yız', 'yiz', 'yuz', 'yüz',
  'sınız', 'siniz', 'sunuz', 'sünüz', 'dır', 'dir', 'dur', 'dür', 'ydı', 'ydi', 'ydu',
  'ydü', 'ymış', 'ymiş', 'ymuş', 'ymüş', 'yken',
]);

/**
 * Arabic interrogatives, which open the sentence. `من` ("who", but far more often "from") and
 * `ما` ("what", and the negation) are left out: they would turn statements into questions. The
 * dialect forms are the ones a dictation is spoken in.
 */
const ARABIC_QUESTION_OPENERS: ReadonlySet<string> = new Set([
  'هل', 'أين', 'اين', 'كيف', 'لماذا', 'لماذ', 'متى', 'ماذا', 'كم', 'أي', 'أليس', 'ألا',
  'ليش', 'ليه', 'وين', 'فين', 'شو', 'إيش', 'ايش', 'إزاي', 'ازاي', 'امتى', 'إمتى',
]);
