// src/core/routing — the five word lists the language decision reads every transcript against.
//
// A 1:1 port of `Lexicon` (Sources/KotibaCore/Lexicon.swift, P4 §3). Asserted against
// fixtures/golden/language-id.json › folds, lookups and lists in test/routing/language-id.test.ts,
// which also proves each list below is the Swift's own (count and sha256 of the newline-joined
// text, as `Scripts/lexicons.py` generated it).
//
// PURE, like the rest of this module: no Node builtin, no OS.
//
// English is SCOWL (`isEnglishWord`, transcript-check.ts — the list step 4a′ already reads). The
// other four are every word form in the Common Voice sentence collector for that language (CC0):
// 121 k Uzbek, 34 k Turkish, 50 k Russian and 42 k Arabic forms. Big enough that real speech out
// of its own engine reads mostly as known words, while an engine handed the wrong language writes
// mostly unknown ones — the Uzbek engine's Latin transliteration of Arabic, Parakeet's Cyrillic
// for English (`Инсайд зе контент фоль.`, 0 known Russian words).
//
// MEMBERSHIP IS ASKED OF A FOLDED WORD (`lexiconFold`), the orthography the lists were built in.
// The fold walks Unicode scalars (JS code points), as `String.unicodeScalars` does, and ends with
// a whole-string lowercase. `String.lowercased()` maps scalar by scalar with no context, where
// `toLowerCase()` gives a word-final Σ as ς; none of the five lists holds Greek, so no lookup can
// tell the two apart (the same note as transcript-check.ts).
//
// BUILT ON FIRST USE, not at import: splitting 255 k words costs ~40 ms and importing the routing
// module (the tiered router, the script check) should not pay it. `warmLexicons` builds them all
// off the critical path — the Mac's `Lexicon.warmUp`, called once at launch.

import type { Language } from '../../contracts/index.js';
import { ARABIC_WORDS, ARABIC_WORDS_SHA256 } from './arabic-words.js';
import { ENGLISH_WORDS_SHA256 } from './english-words.js';
import { RUSSIAN_WORDS, RUSSIAN_WORDS_SHA256 } from './russian-words.js';
import { englishLexiconCount, isEnglishWord } from './transcript-check.js';
import { TURKISH_WORDS, TURKISH_WORDS_SHA256 } from './turkish-words.js';
import { UZBEK_WORDS, UZBEK_WORDS_SHA256 } from './uzbek-words.js';

/** The apostrophes Uzbek writes oʻ, gʻ and the tutuq with — ’ ‘ ʻ ʼ and the backtick — all as '. */
const APOSTROPHES: ReadonlySet<number> = new Set([0x2019, 0x2018, 0x02bb, 0x02bc, 0x60]);

/** Arabic tashkeel, the Quranic marks and the tatweel: not part of a word's spelling. */
function isArabicMark(scalar: number): boolean {
  return (
    (scalar >= 0x0610 && scalar <= 0x061a) ||
    (scalar >= 0x064b && scalar <= 0x065f) ||
    scalar === 0x0670 ||
    (scalar >= 0x06d6 && scalar <= 0x06ed) ||
    scalar === 0x0640
  );
}

/**
 * One orthography for the lookup — the one `Scripts/lexicons.py` built the lists in: apostrophes
 * to ', Turkish İ / I / ı to i, Russian ё / Ё to е, Arabic without tashkeel or tatweel and with
 * أ إ آ ٱ → ا, ى → ي, ة → ه; then lowercase. Note the Turkish rule runs BEFORE the lowercase, so
 * `ISIK` folds to `isik` and not to `ısık`: the lists were folded the same way, and a dotted /
 * dotless distinction the user's engine may or may not have written is exactly what a lookup
 * must not depend on.
 */
export function lexiconFold(word: string, language: Language): string {
  let out = '';
  for (const character of word) {
    const scalar = character.codePointAt(0) ?? 0;
    if (APOSTROPHES.has(scalar)) {
      out += "'";
      continue;
    }
    switch (language) {
      case 'tr':
        if (scalar === 0x0130 || scalar === 0x49 || scalar === 0x0131) {
          out += 'i';
          continue;
        }
        break;
      case 'ar':
        if (isArabicMark(scalar)) continue;
        if (scalar === 0x0623 || scalar === 0x0625 || scalar === 0x0622 || scalar === 0x0671) {
          out += 'ا';
          continue;
        }
        if (scalar === 0x0649) {
          out += 'ي';
          continue;
        }
        if (scalar === 0x0629) {
          out += 'ه';
          continue;
        }
        break;
      case 'ru':
        if (scalar === 0x0451 || scalar === 0x0401) {
          out += 'е';
          continue;
        }
        break;
      case 'en':
      case 'uz':
        break;
    }
    out += character;
  }
  return out.toLowerCase();
}

/** The four generated lists, split on first use. English lives in transcript-check.ts. */
const SOURCES = {
  uz: UZBEK_WORDS,
  tr: TURKISH_WORDS,
  ru: RUSSIAN_WORDS,
  ar: ARABIC_WORDS,
} as const;
type ListLanguage = keyof typeof SOURCES;

const built = new Map<ListLanguage, ReadonlySet<string>>();

function list(language: ListLanguage): ReadonlySet<string> {
  let set = built.get(language);
  if (set === undefined) {
    set = new Set(SOURCES[language].split('\n'));
    built.set(language, set);
  }
  return set;
}

/** Whether `word` — as written, any case, any apostrophe — is a word of `language`. */
export function lexiconContains(word: string, language: Language): boolean {
  if (language === 'en') return isEnglishWord(word.toLowerCase().replaceAll('’', "'"));
  return list(language).has(lexiconFold(word, language));
}

/** Words in each list (distinct, so the size of the set a lookup reads) — for the golden fixture. */
export function lexiconCounts(): Readonly<Record<Language, number>> {
  return {
    en: englishLexiconCount(),
    uz: list('uz').size,
    tr: list('tr').size,
    ru: list('ru').size,
    ar: list('ar').size,
  };
}

/** Each list's sha256 as generated — for the golden fixture, so the port proves it holds the same lists. */
export const LEXICON_SHA256: Readonly<Record<Language, string>> = {
  en: ENGLISH_WORDS_SHA256,
  uz: UZBEK_WORDS_SHA256,
  tr: TURKISH_WORDS_SHA256,
  ru: RUSSIAN_WORDS_SHA256,
  ar: ARABIC_WORDS_SHA256,
};

/** Build every set now, off the critical path: the first key-up must not pay ~40 ms of splitting. */
export function warmLexicons(): void {
  lexiconCounts();
}
