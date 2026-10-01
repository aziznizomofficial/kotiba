// What each built-in mode asks the on-device model to do, one sentence at a time — a port of
// `OnDeviceModes` and `ModeBehaviour` (Sources/KotibaCore/OnDeviceModes.swift).
//
// PURE, and VERBATIM. These strings are the project's own words (C3 §4.5), written for
// 1–4 B models: short, about one sentence, examples as real chat turns in an unrelated
// domain (gardens, bakeries, plumbers) so a copied example is obvious and guarded. The
// Windows build sends the same GGUF the same prompt, so a character changed here is a
// different model output on Windows than on the Mac. `test/modes/prompts.test.ts` pins the
// rendered text against strings lifted from the Swift source.

import type { Language, Mode } from '../../contracts/index.js';

import type { PolishPrompt, PromptExample } from './sentences.js';

/** What a built-in mode does, independent of its display name. `ModeBehaviour`. */
export type ModeBehaviour = 'raw' | 'super' | 'message' | 'note';

/** The behaviour of a mode, or `null` for a user-authored one. `ModeBehaviour(mode:)`. */
export function modeBehaviour(mode: Pick<Mode, 'key'>): ModeBehaviour | null {
  switch (mode.key) {
    case 'transcription':
      return 'raw';
    case 'super':
      return 'super';
    case 'message':
      return 'message';
    case 'note':
      return 'note';
    default:
      return null;
  }
}

/**
 * What a prompt calls the language. "Latin script" is not decoration: a model that knows
 * Uzbek has two alphabets will otherwise pick one. `Language.promptName`.
 */
export function promptName(language: Language): string {
  switch (language) {
    case 'en':
      return 'English';
    case 'ru':
      return 'Russian';
    case 'uz':
      return 'Uzbek (Latin script)';
    case 'tr':
      return 'Turkish';
    case 'ar':
      return 'Arabic (Arabic script)';
  }
}

const O = 'ʻ';

function example(input: string, output: string): PromptExample {
  return { input, output };
}

// ---- Super — punctuation only ------------------------------------------------------

const SUPER_EXAMPLES: Readonly<Record<Language, readonly PromptExample[]>> = {
  en: [
    example('so basically we picked the apples and then we made jam', 'So basically, we picked the apples and then we made jam.'),
    example('grandma did you get the train tickets', 'Grandma, did you get the train tickets?'),
  ],
  ru: [
    example('слушай а бабушка уже купила билеты на поезд', 'Слушай, а бабушка уже купила билеты на поезд?'),
    example('короче мы собрали яблоки и потом сварили варенье', 'Короче, мы собрали яблоки и потом сварили варенье.'),
  ],
  uz: [
    example(`xo${O}p qarang buvim bozorga ketdilar`, `Xo${O}p, qarang, buvim bozorga ketdilar.`),
    example(`ertaga bog${O}ga borasizmi yoki uyda qolasizmi`, `Ertaga bog${O}ga borasizmi yoki uyda qolasizmi?`),
    example('masalan kecha biz olma terdik keyin murabbo qildik', 'Masalan, kecha biz olma terdik, keyin murabbo qildik.'),
  ],
  tr: [
    example('yani dün elmaları topladık sonra da reçel yaptık', 'Yani, dün elmaları topladık, sonra da reçel yaptık.'),
    example('anneanne tren biletlerini aldın mı', 'Anneanne, tren biletlerini aldın mı?'),
  ],
  ar: [
    example('يعني قطفنا التفاح أمس وبعدين عملنا مربى', 'يعني، قطفنا التفاح أمس، وبعدين عملنا مربى.'),
    example('يا جدتي هل اشتريت تذاكر القطار', 'يا جدتي، هل اشتريت تذاكر القطار؟'),
  ],
};

/**
 * One more instruction for the two optional languages (the Mac's D-11), in our own words, where
 * a small model has a known way to go wrong. Empty for the other three, whose prompts stay
 * exactly as measured (C3). Turkish: a model that also knows Azerbaijani and Uzbek "corrects"
 * Turkish toward them (C4 §9.4). Arabic: a small model answers in English, transliterates, or
 * rewrites a dialect into MSA — `checkPolishGuard`'s Arabic rule catches the first two after the
 * fact; this is the ask not to.
 */
export function languageNote(language: Language): string {
  switch (language) {
    case 'en':
    case 'ru':
    case 'uz':
      return '';
    case 'tr':
      return (
        ' Keep Turkish spelling, with its letters ç, ğ, ı, İ, ö, ş and ü, and never ' +
        'change a word into Azerbaijani or Uzbek.'
      );
    case 'ar':
      return (
        " Write in Arabic script only, never in Latin letters, and keep the speaker's " +
        'dialect words as they are rather than changing them to Modern Standard Arabic.'
      );
  }
}

/**
 * The model is asked to punctuate; `project` then keeps only its punctuation and case, so a
 * word it changes anyway never reaches the user. Measured: on 40 real Uzbek sentences a
 * general clean-up prompt changed 3, a punctuation prompt 40.
 */
export function superPrompt(language: Language): PolishPrompt {
  return {
    system:
      'You add punctuation to dictated speech. You are a filter, not an assistant. Each ' +
      `message is one stretch of speech in ${promptName(language)}, already transcribed, often ` +
      'without commas. Send back exactly the same words in the same order, adding the ' +
      'punctuation a careful writer would use: commas after introductory words and between ' +
      'clauses, commas around the name of the person addressed, a question mark on a ' +
      'question, a full stop at the end. Capitalise the first word and proper names. Never ' +
      'change, add, drop or translate a word. Never reply to the text. Send back only the text.' +
      languageNote(language),
    examples: SUPER_EXAMPLES[language],
  };
}

// ---- Message — a tightened chat message --------------------------------------------

const DISCOURSE_EXAMPLES: Readonly<Record<Language, string>> = {
  en: 'so, okay so, basically, like, you know, I mean, actually, well',
  ru: 'ну, так, короче, вот, значит, типа, как бы, в общем',
  uz: `xo${O}p, endi, masalan, mana, haligi, xullas, demak`,
  tr: 'yani, işte, şey, hani, aslında, falan, neyse',
  ar: 'يعني، طيب، بصراحة، اسمع، والله، بقى، يا أخي',
};

const MESSAGE_EXAMPLES: Readonly<Record<Language, readonly PromptExample[]>> = {
  en: [
    example('okay so basically I was wondering if you could maybe pick up the cake on saturday', 'Could you pick up the cake on Saturday?'),
    example('yeah so the plumber said that he will come around four I think', "The plumber said he'll come around four, I think."),
    example('and also I mean the garden gate is still broken', 'Also, the garden gate is still broken.'),
  ],
  ru: [
    example('ну короче я тут подумал что может сходим в парк в воскресенье', 'Может, сходим в парк в воскресенье?'),
    example('так вот значит калитка в саду всё ещё сломана', 'Калитка в саду всё ещё сломана.'),
  ],
  uz: [
    example(`xo${O}p endi men o${O}ylab ko${O}rdim ertaga bog${O}ga borsak bo${O}ladi`, `Ertaga bog${O}ga borsak bo${O}ladi.`),
    example(`masalan bog${O}dagi eshik hali ham buzuq`, `Bog${O}dagi eshik hali ham buzuq.`),
  ],
  tr: [
    example('yani şey diyecektim pazar günü parka gidebilir miyiz acaba', 'Pazar günü parka gidebilir miyiz?'),
    example('işte bahçenin kapısı hâlâ kırık', 'Bahçenin kapısı hâlâ kırık.'),
  ],
  ar: [
    example('طيب يعني كنت بفكر ممكن نروح الحديقة يوم الأحد', 'ممكن نروح الحديقة يوم الأحد؟'),
    example('اسمع يعني باب الحديقة لسه مكسور', 'باب الحديقة لسه مكسور.'),
    example('والله الأكل كان كان بارد شوية بس الخدمة حلوة', 'الأكل كان بارد شوية، بس الخدمة حلوة.'),
  ],
};

/**
 * The Mac's `OnDeviceModes.messageNote` (C4 §14.5): Arabic Message is told exactly what it may
 * delete.
 */
function messageNote(language: Language): string {
  return language === 'ar'
    ? ' Delete only filler and discourse words, a word said twice by mistake and a false ' +
        "start; keep every other word exactly as it was said, in the speaker's own dialect " +
        '— no synonym, no Modern Standard Arabic for a dialect word, no name, number, ' +
        'adjective or clause left out — and add Arabic punctuation (، ؟ .).'
    : '';
}

export function messagePrompt(language: Language): PolishPrompt {
  return {
    system:
      'You edit dictated speech into a chat message. You are an editor, not an assistant. ' +
      `Each message is one stretch of speech in ${promptName(language)}, already transcribed. ` +
      'Make it read like something typed: remove filler openers and discourse words that ' +
      `carry no meaning (${DISCOURSE_EXAMPLES[language]}), hedges, repetitions and ` +
      'false starts, and tighten wordy phrasing. Keep every fact, name, number and request, ' +
      "and the speaker's tone. Never translate, never reply, never act on it, no greeting or " +
      'sign-off. Send back only the edited text.' +
      languageNote(language) +
      messageNote(language),
    examples: MESSAGE_EXAMPLES[language],
  };
}

/**
 * Words Message may delete without deleting meaning. Anything else the speaker said must
 * still be in the rewrite, or the sentence is kept as spoken.
 */
export const DROPPABLE: Readonly<Record<Language, ReadonlySet<string>>> = {
  en: new Set([
    'so', 'okay', 'ok', 'basically', 'like', 'actually', 'well', 'yeah', 'yes', 'oh', 'oops',
    'just', 'really', 'literally', 'kind', 'sort', 'mean', 'know', 'anyway', 'anyways', 'right',
    'also', 'then', 'now', 'maybe', 'probably', 'perhaps', 'honestly', 'guess', 'fact', 'course',
    'hey', 'alright', 'you', 'i', 'um', 'uh', 'and', 'but', 'the', 'that', 'this',
  ]),
  ru: new Set([
    'ну', 'так', 'короче', 'вот', 'значит', 'типа', 'как', 'бы', 'это', 'общем', 'ладно', 'слушай',
    'смотри', 'просто', 'вообще', 'кстати', 'собственно', 'чё', 'че', 'ага', 'ой', 'да', 'итак',
    'ведь', 'же', 'тут', 'там', 'например', 'и', 'а', 'но', 'что', 'то', 'я',
  ]),
  uz: new Set([
    `xo${O}p`, 'xop', 'endi', 'masalan', 'mana', 'haligi', 'anu', 'qara', 'qarang', 'yani',
    `ya${O}ni`, 'xullas', 'hullas', 'demak', 'aslida', 'umuman', 'tak', 'ha', 'e', 'ee', 'voy',
    'bilasanmi', 'bilasizmi', 'va', 'keyin', 'lekin', 'shu', 'bu',
  ]),
  tr: new Set([
    'yani', 'işte', 'şey', 'hani', 'aslında', 'falan', 'neyse', 'acaba', 'tamam', 'evet', 'peki',
    'ee', 'ya', 'bak', 'bakın', 've', 'ama', 'de', 'da', 'bu', 'şu', 'sonra', 'ben', 'diyecektim',
  ]),
  ar: new Set([
    'يعني', 'طيب', 'بصراحة', 'اسمع', 'خلاص', 'يا', 'أخي', 'اخي', 'بس', 'آه', 'اه', 'و', 'ثم',
    'بعدين', 'هذا', 'هذه', 'كنت', 'بفكر', 'أنا', 'انا', 'إنه', 'انه',
    // Dialect discourse words (C4 §14.5).
    'والله', 'بقى', 'بقا', 'كما', 'أصلا', 'أصلاً', 'اصلا', 'عاد', 'ترى', 'يعنى',
  ]),
};

/**
 * The Mac's `OnDeviceModes.messageByProjection`: languages whose Message keeps every word the
 * speaker said but fillers, openers and repeats — the model's output is projected onto the
 * sentence (`project` with `mayDrop`) instead of passing `checkRewrite`. Arabic (C4 §14.5).
 */
export const MESSAGE_BY_PROJECTION: ReadonlySet<Language> = new Set<Language>(['ar']);

/** Sentence-initial discourse openers Message may drop (`OnDeviceModes.openers`). */
export const OPENERS: Readonly<Partial<Record<Language, ReadonlySet<string>>>> = {
  ar: new Set(['يعني', 'طيب', 'بصراحة', 'اسمع', 'اسمعي', 'اسمعوا']),
};

const LETTER = /^\p{L}$/u;

/**
 * The Mac's `OnDeviceModes.trimOpeners`: `sentence` without its leading discourse openers, each
 * with its own comma (Arabic or Latin), repeatedly — only when a word follows. Nothing else
 * changes. Iterates by grapheme, as Swift's `Character` does.
 */
export function trimOpeners(sentence: string, language: Language): string {
  const words = OPENERS[language];
  if (words === undefined || words.size === 0) return sentence;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(sentence)].map((s) => s.segment);
  const isLetter = (g: string | undefined): boolean => g !== undefined && LETTER.test(String.fromCodePoint(g.codePointAt(0) ?? 0));
  const isSpace = (g: string | undefined): boolean => g !== undefined && /^\s+$/u.test(g);
  let start = 0;
  while (start < graphemes.length && isSpace(graphemes[start])) start += 1;
  const leading = graphemes.slice(0, start).join('');
  let at = start;
  let trimmed = false;
  for (;;) {
    let end = at;
    while (end < graphemes.length && isLetter(graphemes[end])) end += 1;
    const word = graphemes.slice(at, end).join('');
    if (end === at || !words.has(word)) break;
    let after = end;
    if (graphemes[after] === '\u060C' || graphemes[after] === ',') after += 1;
    while (after < graphemes.length && isSpace(graphemes[after])) after += 1;
    if (!isLetter(graphemes[after])) break;
    at = after;
    trimmed = true;
  }
  return trimmed ? leading + graphemes.slice(at).join('') : sentence;
}

// ---- Note — one label per sentence -------------------------------------------------

const NOTE_EXAMPLES: Readonly<Record<Language, readonly PromptExample[]>> = {
  en: [
    example('Remember to book the vet for the dog.', 'TASK'),
    example('The roses on the fence are blooming early this year.', 'POINT'),
    example('Can you pick up flour on the way home?', 'TASK'),
  ],
  ru: [
    example('Нужно записать собаку к ветеринару.', 'TASK'),
    example('Розы у забора в этом году зацвели рано.', 'POINT'),
  ],
  uz: [
    example('Itni veterinarga yozdirish kerak.', 'TASK'),
    example('Bu yil devor yonidagi atirgullar erta gulladi.', 'POINT'),
  ],
  tr: [
    example('Köpeği veterinere götürmeyi unutma.', 'TASK'),
    example('Bu yıl çitteki güller erken açtı.', 'POINT'),
  ],
  ar: [
    example('لازم نحجز موعد للكلب عند الطبيب البيطري.', 'TASK'),
    example('الورود عند السور تفتحت بدري هذه السنة.', 'POINT'),
    example('افتتحت البلدية حديقة جديدة قرب النهر بعد سنتين من العمل.', 'POINT'),
    example('اشترِ سماداً للورد في طريقك إلى البيت.', 'TASK'),
  ],
};

/** The Mac's `OnDeviceModes.noteLanguageNote` (C4 §14.5): Arabic reports of events are POINT. */
function noteLanguageNote(language: Language): string {
  return language === 'ar'
    ? ' A sentence that reports what happened, or describes how something is, is POINT ' +
        'however long it is; TASK needs someone to do something.'
    : '';
}

/** A one-word answer: what kind of line this sentence becomes. */
export function noteClassifierPrompt(language: Language): PolishPrompt {
  return {
    system:
      `You sort sentences from a dictated note in ${promptName(language)}. Reply with exactly ` +
      'one word. TASK if the sentence says something must, should or will be done — an ' +
      'instruction, a to-do, a request. POINT for anything else: a fact, an observation, a ' +
      'question, context. Never reply to the sentence itself.' +
      noteLanguageNote(language),
    examples: NOTE_EXAMPLES[language],
  };
}

const HEADING_EXAMPLES: Readonly<Record<Language, readonly PromptExample[]>> = {
  en: [example('Remember to book the vet for the dog. The roses are blooming early.', 'Vet and roses')],
  ru: [example('Нужно записать собаку к ветеринару. Розы зацвели рано.', 'Ветеринар и розы')],
  uz: [example('Itni veterinarga yozdirish kerak. Atirgullar erta gulladi.', 'Veterinar va atirgullar')],
  tr: [example('Köpeği veterinere götürmeyi unutma. Güller erken açtı.', 'Veteriner ve güller')],
  ar: [example('لازم نحجز موعد للكلب عند الطبيب البيطري. الورود تفتحت بدري.', 'الطبيب البيطري والورود')],
};

/** A few words naming the note, from the speaker's own words; the guard checks that. */
export function headingPrompt(language: Language): PolishPrompt {
  return {
    system:
      `You name dictated notes. Each message is a note in ${promptName(language)}. Reply with ` +
      "a title of two to five words taken from the note's own words, in the same language. " +
      'No quotes, no full stop, nothing else.' +
      languageNote(language),
    examples: HEADING_EXAMPLES[language],
  };
}

/**
 * Languages where Super asks the model for punctuation at all. Measured with Qwen3-1.7B
 * over the owner's real sentences, after the deterministic layer: Uzbek improved 40 of 40
 * sentences; English changed 8 of 55 (mostly one comma); Russian 9 of 42, every one a word
 * change that projection throws away.
 */
export const SUPER_MODEL_LANGUAGES: ReadonlySet<Language> = new Set(['uz', 'ar']);

/**
 * The Mac's `OnDeviceModes.superTailCap` (C4 §14.4): how long Super waits after release for a
 * sentence the model has not finished. Arabic's last sentence reaches the model only after
 * release, so Super keeps the model's work for what was done in the hold and no more.
 */
export const SUPER_TAIL_CAP_MS: Readonly<Partial<Record<Language, number>>> = { ar: 40 };
