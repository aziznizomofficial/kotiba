// src/core/routing — the transcript check.  OWNER: t03
//
// A 1:1 port of `TranscriptCheck` (Sources/KotibaCore/Routing.swift, "MARK: - Transcript
// check"). Asserted against fixtures/golden/transcript-check.json in
// test/routing/transcript-check.test.ts, which also proves the word list below is the
// Swift's own (count and sha256 of the newline-joined text).
//
// PURE, like the rest of this module: no Node builtin, no OS. The sha256 is checked in the
// TEST, with node:crypto; here the list is only split.
//
// THE MIS-ROUTE NOTHING ELSE CAN SEE: Uzbek audio routed to the unified engine (Parakeet,
// English and Russian). Measured on the Mac's own end-to-end run (P1 §0): 40 of 256 Uzbek
// dictations went there, the same 16 % as the whole-clip detector on the 344-clip harness,
// and nothing noticed — because Parakeet does not FAIL on Uzbek, it writes something. What
// it writes is not English: pseudo-Hungarian, -Polish, -Dutch or -Lithuanian, nothing at
// all, or (rarely) Cyrillic. Real English out of Parakeet is made of English words, so the
// one question worth asking of its transcript is "what share of these words are English
// words?" — against the 39k-word SCOWL list in `english-words.ts`.
//
// Measured (docs/research/P2-uzbek-route-and-tail.md §2): Parakeet's transcript reads below
// `NOT_ENGLISH_BELOW` for 91 % of Uzbek clips and for 0 of 400 FLEURS English and Russian
// ones; on the owner's own 1,159 English-routed dictations it fired on 11 (0.9 %).
//
// DOUBT IS NOT A VERDICT. The session follows a doubt with the Uzbek engine's own transcript
// of the same audio, and `readsAsEnglish` on THAT decides: English audio comes back from the
// Uzbek fine-tune as English, and then Parakeet's transcript stands. It only reads Latin —
// Parakeet's Cyrillic on Uzbek audio is too close to Russian for a word list of this size.
//
// CHARACTER HANDLING is by Unicode scalar (JS code point), as in index.ts. Three Swift
// properties and their JS twins:
//   * `isAlphabetic` → `\p{Alphabetic}` (the same `LETTER` rule index.ts documents).
//   * `isUppercase`  → `\p{Uppercase}`, the binary property (Lu + Other_Uppercase), NOT
//                      `\p{Lu}`: Ⓐ U+24B6 is uppercase to Swift and is not Lu.
//   * `numericType != nil` → `\p{N}`. The one difference, the Unihan numerals (一 二 …, Lo
//                      with a numeric type), is Alphabetic, so a text holding one has a
//                      word and never reaches the number test.
// And one Swift method: `String.lowercased()` maps scalar by scalar with no context, where
// `toLowerCase()` gives a word-final Σ as ς. The list holds no Greek, so no lookup can tell.

import type { TranscriptDoubt } from '../../contracts/index.js';
import { ENGLISH_WORDS } from './english-words.js';

/**
 * Below this share of English words, Parakeet's transcript is not English. On the tuning
 * half: 0.6 caught 40 of 55 missed Uzbek clips, 0.7 caught 45, and 0.8 caught no more while
 * flagging twice as much of the owner's English; 0 FLEURS clips at any of them.
 * (`TranscriptCheck.notEnglishBelow`.)
 */
export const NOT_ENGLISH_BELOW = 0.7;

/**
 * At or above this share the Uzbek engine's transcript is English — the audio was — and
 * Parakeet's stands. Uzbek comes back from it under 0.3 in 311 of 312 doubted harness
 * clips; the owner's English misrouted to it measured 0.62–1.0.
 * (`TranscriptCheck.readsAsEnglishFrom`.)
 */
export const READS_AS_ENGLISH_FROM = 0.5;

/**
 * What a transcript is made of. `counted` leaves out what a word list cannot judge — proper
 * nouns and acronyms — and `known` is how many of the counted words are English words.
 */
export interface TranscriptReading {
  readonly words: number;
  readonly latin: number;
  readonly cyrillic: number;
  readonly counted: number;
  readonly known: number;
  /** Share of counted words that are English words; `null` when nothing was counted. */
  readonly coverage: number | null;
}

const ALPHABETIC = /\p{Alphabetic}/u;
const UPPERCASE = /\p{Uppercase}/u;
const NUMERIC = /\p{N}/u;
const RIGHT_SINGLE_QUOTE = '’';

/** Clitics an English word carries without being listed with them: `we'll`, `shouldn't`. */
const CLITICS = ["n't", "'re", "'ve", "'ll", "'d", "'m"] as const;

/**
 * Built on first use, not at import: splitting 39k words costs ~10 ms, and importing the
 * routing module (the router, the script check) should not pay it. The session's first
 * doubtful key-up pays it once — the Mac pays it at launch via `lexiconCount`; see
 * `englishLexiconCount`.
 */
let lexicon: ReadonlySet<string> | null = null;

function words(): ReadonlySet<string> {
  lexicon ??= new Set(ENGLISH_WORDS.split('\n'));
  return lexicon;
}

/** Words in the list. For the golden fixture, and to build the set before the first key-up. */
export function englishLexiconCount(): number {
  return words().size;
}

/**
 * English the dictionary list does not carry, and that a dictation is made of
 * (`TranscriptCheck.supplement`, core review 2026-09-30). The list is a 2020 word-game
 * dictionary: it has `hey` and `okay` but not `yeah`, `ok`, `yep` or `app`. So "Yeah." — a
 * whole, common English dictation — read as 0 % English, was sent to the Uzbek engine, and
 * even that engine's faithful "Yeah." then failed `readsAsEnglish` and replaced the unified
 * engine's text. Kept apart from the list so it and its golden sha256 stay as generated.
 * Only a word as it stands is looked up here: `'s` and the clitics read the list alone.
 */
const SUPPLEMENT: ReadonlySet<string> = new Set([
  'yeah', 'yep', 'yup', 'nope', 'nah', 'ok', 'alright', 'gotcha', 'huh', 'oops', 'lol',
  'gonna', 'wanna', 'gotta', 'kinda', 'dunno', 'anyways',
  'app', 'apps', 'online', 'offline', 'download', 'downloads', 'downloaded', 'upload',
  'uploaded', 'website', 'websites', 'setup', 'login', 'email', 'emails', 'browser',
  'screenshot', 'screenshots', 'inbox', 'username', 'wifi', 'laptop', 'podcast', 'blog',
]);

/**
 * Hesitation sounds, which every language makes. Evidence of nothing when there are words
 * beside them — `Um, yeah.` is English — and counted as not English only when they are all
 * there is, which is what the unified engine makes of some Uzbek (`Uh.`). Exported for the
 * language decision's `readTranscriptEvidence`, which counts them by the same rule.
 */
export const HESITATIONS: ReadonlySet<string> = new Set(['uh', 'um', 'hmm', 'mhm', 'er', 'erm', 'mm', 'ah']);

/** Whether a lowercase word (apostrophes folded to ') is an English word. */
export function isEnglishWord(word: string): boolean {
  const list = words();
  if (list.has(word) || SUPPLEMENT.has(word)) return true;
  // Every suffix here is ASCII, so dropping it by UTF-16 unit drops exactly its scalars.
  if (word.endsWith("'s") && list.has(word.slice(0, -2))) return true;
  const scalars = [...word].length;
  for (const clitic of CLITICS) {
    if (scalars > clitic.length && word.endsWith(clitic) && list.has(word.slice(0, -clitic.length))) {
      return true;
    }
  }
  return false;
}

/**
 * Words by Unicode scalar: a run of alphabetic scalars, with ' or ’ kept only between two
 * letters. A word after `.`, `!` or `?` (or the first) starts a sentence. `afterDigit`: the
 * scalar before it is numeric — the `st` of `1st`, the `s` of `90s`, the `am` of `9am`: a
 * number's suffix, which no word list judges.
 */
export function transcriptWords(
  text: string,
): { readonly word: string; readonly startsSentence: boolean; readonly afterDigit: boolean }[] {
  const scalars = [...text];
  const out: { word: string; startsSentence: boolean; afterDigit: boolean }[] = [];
  let starts = true;
  let i = 0;
  while (i < scalars.length) {
    const scalar = scalars[i]!;
    if (!ALPHABETIC.test(scalar)) {
      if (scalar === '.' || scalar === '!' || scalar === '?') starts = true;
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < scalars.length) {
      const next = scalars[j]!;
      if (ALPHABETIC.test(next)) {
        j += 1;
      } else if (
        (next === "'" || next === RIGHT_SINGLE_QUOTE) &&
        j + 1 < scalars.length &&
        ALPHABETIC.test(scalars[j + 1]!)
      ) {
        j += 1;
      } else {
        break;
      }
    }
    out.push({
      word: scalars.slice(i, j).join(''),
      startsSentence: starts,
      afterDigit: i > 0 && NUMERIC.test(scalars[i - 1]!),
    });
    starts = false;
    i = j;
  }
  return out;
}

/** A-Z a-z, Latin-1 letters (not × ÷), Latin Extended-A/B, Latin Extended Additional. */
function isLatin(scalar: string): boolean {
  const value = scalar.codePointAt(0) ?? 0;
  if ((value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a)) return true;
  if (value >= 0x1e00 && value <= 0x1eff) return true;
  if (value >= 0xc0 && value <= 0x24f) return value !== 0xd7 && value !== 0xf7;
  return false;
}

function isCyrillic(scalar: string): boolean {
  const value = scalar.codePointAt(0) ?? 0;
  return value >= 0x400 && value <= 0x4ff;
}

export function readTranscript(text: string): TranscriptReading {
  let words = 0;
  let latin = 0;
  let cyrillic = 0;
  let counted = 0;
  let known = 0;
  let hesitated = 0;
  for (const { word, startsSentence, afterDigit } of transcriptWords(text)) {
    words += 1;
    const scalars = [...word];
    // Cyrillic is checked first: a word with a scalar of each is Cyrillic.
    if (scalars.some(isCyrillic)) {
      cyrillic += 1;
    } else if (scalars.some(isLatin)) {
      latin += 1;
    }
    // A number's suffix is not a word: `1st`, `2nd` and `3rd` counted `st`, `nd` and `rd`
    // as three non-English words.
    if (afterDigit) continue;
    // A proper noun or an acronym says nothing about the language around it — `Gonka`,
    // `MCP`, `YouTube` — and Parakeet capitalises them.
    if (scalars.slice(1).some((scalar) => UPPERCASE.test(scalar))) continue;
    const first = scalars[0];
    if (first !== undefined && UPPERCASE.test(first) && !startsSentence && word !== 'I') continue;
    const lower = word.toLowerCase().replaceAll(RIGHT_SINGLE_QUOTE, "'");
    if (HESITATIONS.has(lower)) {
      hesitated += 1;
      continue;
    }
    counted += 1;
    if (isEnglishWord(lower)) known += 1;
  }
  if (counted === 0) counted = hesitated;
  return { words, latin, cyrillic, counted, known, coverage: counted > 0 ? known / counted : null };
}

/**
 * Whether the unified engine's transcript of an unpinned dictation doubts its own route.
 * `null` — the common case — means it reads as English (or as Cyrillic, which this does not
 * judge). `noWords` is only a doubt when something heard speech; that is the caller's
 * question, not this function's.
 */
export function transcriptDoubt(unifiedTranscript: string): TranscriptDoubt | null {
  const reading = readTranscript(unifiedTranscript);
  if (reading.words === 0) {
    // "25" is a transcript; an empty string after speech is not.
    return NUMERIC.test(unifiedTranscript) ? null : 'noWords';
  }
  if (reading.latin < reading.cyrillic || reading.coverage === null) return null;
  return reading.coverage < NOT_ENGLISH_BELOW ? 'notEnglish' : null;
}

/**
 * Whether the Uzbek engine's transcript is English — then the audio was, and the doubt was
 * wrong. Nothing countable is not English.
 */
export function readsAsEnglish(text: string): boolean {
  return (readTranscript(text).coverage ?? 0) >= READS_AS_ENGLISH_FROM;
}
