// src/core/routing — cluster mass, script check, route decision.  OWNER: t03
//
// A 1:1 port of Sources/KotibaCore/Routing.swift, plus the two pure rules the mis-route
// recovery in Sources/KotibaCore/DictationSession.swift step 4b is made of
// (`isUsableRerun`, `recoveryPlan`), and — in transcript-check.ts, re-exported here — the
// `TranscriptCheck` step 4a′ reads the unified engine's transcript with. Asserted
// byte-for-byte against fixtures/golden/{cluster-mass,script-check,route,transcript-check}.json
// in test/routing.
//
// PURE. No Electron, no `node:fs`, no `node:child_process`, no OS. The classifier
// arrives as an interface, so these tests need a literal posterior map and not a
// 539 MB model. `windows/scripts/gate.sh` fails the build if that changes.
//
// ROUTING IS ONE BIT: the Uzbek engine, or the unified engine that covers English and
// Russian. Three tiers, in this order — a manual pin, which short-circuits everything
// and is absolute; ONE acoustic pass over the finished utterance; then a script check
// on the emitted transcript, which can overturn a non-pinned route toward Uzbek.
//
// THE THING MOST LIKELY TO BE GOT WRONG: `uz` NEVER WINS ON ARGMAX. Clean Uzbek scores
// tr 0.63 / az 0.17 / uz 0.00. A port that takes the top language from the detector
// routes Uzbek to Turkish and produces garbage — and looks correct in every unit test
// that does not use real audio. That is why this is a CLUSTER SUM against a threshold.
//
// Character handling throughout is by UNICODE SCALAR (JS code point), which is what
// `String.unicodeScalars` gives on the Swift side. The three counters walk Swift
// `Character`s, i.e. grapheme clusters; on this corpus, which carries no combining
// marks, the two agree, and code points were chosen over `Intl.Segmenter` because
// segmentation moves with the host's ICU version and a golden fixture may not.
//
// Three character classifications here have NO row in the golden corpus and were
// resolved by running the Swift rather than by reading it — `isLetter` is isAlphabetic
// and not `\p{L}`, Foundation's whitespace set is not `String.trim()`'s, and the Swift's
// okina clause is redundant. test/routing/swift-parity.test.ts records what the Swift
// answered and how to reproduce it.

import type {
  AcousticClassifier,
  Language,
  LanguagePosterior,
  LanguageRouter,
  OptionalLanguageRules,
  RouteDecision,
  RouteSource,
  RouteVerdict,
  Script,
} from '../../contracts/index.js';
import {
  ARABIC_VERIFIED_FROM,
  ARABIC_VERIFIED_FROM_UNFAMILIAR,
  DEFAULT_ARABIC_CANDIDATE_FROM,
  DEFAULT_ARABIC_CANDIDATE_MINIMUM_SECONDS,
  DEFAULT_ARABIC_FROM,
  DEFAULT_TURKIC_THRESHOLD,
  DEFAULT_TURKISH_CANDIDATE_FROM,
  DEFAULT_TURKISH_MINIMUM_SECONDS,
  SAMPLE_RATE,
  TURKISH_VERIFIED_FROM,
  TURKISH_VERIFIED_FROM_UNFAMILIAR,
  OKINA,
  TURKIC_CLUSTER,
  UZBEK_CYRILLIC_EVIDENCE,
  UZBEK_CYRILLIC_LETTERS,
  engineFamilyFor,
} from '../../contracts/index.js';
import { ALL_LANGUAGES, decideInSubset, soleRoute as soleRouteOf, subsetFallback, type LanguageSubset } from './language-subset.js';

/**
 * How long the second pass on the Uzbek engine may take before the first transcript
 * stands. Everything after transcription has a deadline; an unbounded second pass
 * sitting in front of the user's text does not belong in this pipeline.
 * (`DictationSession.Config.rerouteDeadline`.)
 */
export const REROUTE_DEADLINE_SECONDS = 10;

/**
 * Six of the same word in a row is not a sentence in any of the three languages — it
 * is what a mismatched model does when it has nothing to say.
 */
export const REPETITION_RUN_LIMIT = 6;

const TURKIC_CLUSTER_SET: ReadonlySet<string> = new Set(TURKIC_CLUSTER);
const UZBEK_CYRILLIC_SET: ReadonlySet<string> = new Set(UZBEK_CYRILLIC_LETTERS);

/**
 * `Character.isLetter`, which is `Unicode.Scalar.Properties.isAlphabetic` and NOT
 * general category L. The difference is real: `Nl` (U+2160 ROMAN NUMERAL ONE) and the
 * Other_Alphabetic combining marks are letters to Swift and are not `\p{L}`. Verified
 * against the Swift runtime rather than assumed — no row in the golden corpus reaches
 * either, so the fixtures cannot tell you.
 */
const LETTER = /\p{Alphabetic}/u;

/** `isLetter || isNumber`. `\p{N}` covers Nd, Nl and No, which is `numericType != nil`. */
const LETTER_OR_NUMBER = /[\p{Alphabetic}\p{N}]/u;

/**
 * `CharacterSet.whitespacesAndNewlines` — Zs, plus tab, plus the newline scalars.
 *
 * NOT `String.prototype.trim()`, which is inverted from Foundation on exactly two
 * characters: it strips U+FEFF, which Foundation keeps, and keeps U+0085 NEL, which
 * Foundation strips. `isUsableRerun` opens with this trim, so a BOM-prefixed second
 * answer would decide differently in the two languages.
 */
const WHITESPACE_AND_NEWLINES = new Set(
  [
    0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
    0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
    0x3000,
  ].map((scalar) => String.fromCodePoint(scalar)),
);

// The transcript check (session step 4a′) — its own file, because its word list is
// 39k generated lines.
export {
  NOT_ENGLISH_BELOW,
  READS_AS_ENGLISH_FROM,
  englishLexiconCount,
  isEnglishWord,
  readTranscript,
  readsAsEnglish,
  transcriptDoubt,
  transcriptWords,
} from './transcript-check.js';
export type { TranscriptReading } from './transcript-check.js';

// The language decision (P4, D-14) — lexicon.ts holds the five word lists, language-id.ts the
// evidence, the fitted model and the policy session step 4L runs. Golden: language-id.json.
export { LEXICON_SHA256, lexiconContains, lexiconCounts, lexiconFold, warmLexicons } from './lexicon.js';
export {
  ACOUSTIC_LOG_FLOOR,
  DEFAULT_ASK_FROM,
  DEFAULT_MAX_ENGINES,
  FITTED_LANGUAGE_MODEL,
  LANGUAGE_PRIOR_SMOOTHING,
  LANGUAGE_PRIOR_WEIGHT,
  LID_ORDER,
  acousticEvidence,
  acousticFeatures,
  createLanguageIDRouter,
  decideLanguage,
  decideLanguageIDRoute,
  decisionCodes,
  decisionConfidence,
  decisionLanguage,
  languageLogPrior,
  languagePolicy,
  languageScores,
  needsRespelling,
  policyChoose,
  policyConsider,
  policyRoute,
  rankedLanguages,
  readTranscriptEvidence,
  transcriptFeatures,
} from './language-id.js';
export type {
  LanguageCounts,
  LanguageDecision,
  LanguageModel,
  LanguagePolicy,
  ReadTranscript,
  TranscriptEvidence,
  TranscriptsByFamily,
} from './language-id.js';

// The per-language on/off (the Mac's `LanguageSubset`).
export {
  ALL_LANGUAGES,
  canTurnOff,
  isAllLanguages,
  keepsCode,
  languageSubset,
  orderedLanguages,
  permits,
  presetLanguages,
  restrictPosterior,
  settingLanguage,
  soleRoute,
  subsetContains,
  subsetFallback,
  subsetFamilies,
  subsetOptional,
} from './language-subset.js';
export type { LanguageSubset } from './language-subset.js';

/** `LanguageSubset.decide`: the acoustic tier restricted to the languages that are on. */
export function decideRouteInSubset(
  subset: LanguageSubset,
  posterior: LanguagePosterior,
  seconds: number,
  threshold: number,
  rules: OptionalLanguageRules,
  preferring: Language = 'en',
): RouteDecision {
  return decideInSubset(subset, posterior, seconds, threshold, rules, decideRoute, preferring);
}

// MARK: - Cluster mass

/**
 * Summed probability of the Turkic cluster over the total.
 *
 * The posterior NEED NOT be normalised — divide by the sum of all values. A total of
 * zero returns 0 rather than dividing (that guards both an empty map and an all-zero
 * one; the Swift guard is `total > 0`, so a negative total returns 0 too).
 *
 * The last bit or two of both sums moves with iteration order, which is why every
 * fixture carrying a mass states a tolerance and prints nine decimals.
 */
export function clusterMass(
  posterior: LanguagePosterior,
  cluster: readonly string[] | ReadonlySet<string> = TURKIC_CLUSTER_SET,
): number {
  const members = cluster instanceof Set ? cluster : new Set(cluster as readonly string[]);
  let total = 0;
  for (const value of Object.values(posterior)) total += value;
  if (!(total > 0)) return 0;
  let inCluster = 0;
  for (const [code, value] of Object.entries(posterior)) {
    if (members.has(code)) inCluster += value;
  }
  return inCluster / total;
}

/**
 * `clusterMass(posterior) >= threshold`. **GREATER-OR-EQUAL.**
 *
 * The tie deliberately favours Uzbek, because the two mistakes are not symmetric: the
 * unified engine cannot emit Uzbek at all, whereas the Uzbek engine merely emits
 * English badly.
 */
export function isUzbek(
  posterior: LanguagePosterior,
  threshold: number = DEFAULT_TURKIC_THRESHOLD,
  cluster: readonly string[] | ReadonlySet<string> = TURKIC_CLUSTER_SET,
): boolean {
  return clusterMass(posterior, cluster) >= threshold;
}

// MARK: - Script check

/**
 * ASCII A–Z/a–z ONLY for Latin, and U+0400–U+04FF ONLY for Cyrillic.
 *
 * `\p{Script=Latin}` is NOT a substitute: it reclassifies accented Latin and the okina
 * U+02BB, and silently changes four routing decisions at once. Anything else — Greek,
 * digits, punctuation, U+0500 Cyrillic Supplement — counts as neither.
 */
export function scriptOf(text: string): Script {
  let latin = 0;
  let cyrillic = 0;
  let arabic = 0;
  for (const character of text) {
    const scalar = character.codePointAt(0) ?? 0;
    if ((scalar >= 0x0041 && scalar <= 0x005a) || (scalar >= 0x0061 && scalar <= 0x007a)) {
      latin += 1;
    } else if (scalar >= 0x0400 && scalar <= 0x04ff) {
      cyrillic += 1;
    } else if (isArabicLetter(character)) {
      arabic += 1;
    }
  }
  const scripts = (latin > 0 ? 1 : 0) + (cyrillic > 0 ? 1 : 0) + (arabic > 0 ? 1 : 0);
  if (scripts === 0) return 'neither';
  if (scripts > 1) return 'mixed';
  return latin > 0 ? 'latin' : cyrillic > 0 ? 'cyrillic' : 'arabic';
}

const ALPHABETIC = /^\p{Alphabetic}$/u;
const NONSPACING_MARK = /^\p{Mn}$/u;

/**
 * `ScriptCheck.isArabicLetter`: an Arabic-script LETTER — the Arabic, Supplement, Extended-A and
 * presentation-form blocks, Unicode Alphabetic and not a nonspacing mark. `،` `؛` `؟`, the
 * Arabic-Indic digits and the tashkeel share the blocks and say nothing about the script alone.
 */
export function isArabicLetter(character: string): boolean {
  const scalar = character.codePointAt(0) ?? 0;
  const inBlock =
    (scalar >= 0x0600 && scalar <= 0x06ff) ||
    (scalar >= 0x0750 && scalar <= 0x077f) ||
    (scalar >= 0x08a0 && scalar <= 0x08ff) ||
    (scalar >= 0xfb50 && scalar <= 0xfdff) ||
    (scalar >= 0xfe70 && scalar <= 0xfeff);
  return inBlock && ALPHABETIC.test(character) && !NONSPACING_MARK.test(character);
}

/**
 * `ScriptCheck.arabicShare`: Arabic letters over ASCII-Latin + Cyrillic + Arabic letters, 0 when
 * there are none. The Arabic polish guard keys off this rather than `scriptOf`, because Arabic
 * dictation carries Latin names (`أرسل الملف على Google Drive`) and is then `mixed`.
 */
export function arabicShare(text: string): number {
  let counted = 0;
  let arabic = 0;
  for (const character of text) {
    const scalar = character.codePointAt(0) ?? 0;
    if (
      (scalar >= 0x0041 && scalar <= 0x005a) ||
      (scalar >= 0x0061 && scalar <= 0x007a) ||
      (scalar >= 0x0400 && scalar <= 0x04ff)
    ) {
      counted += 1;
    } else if (isArabicLetter(character)) {
      counted += 1;
      arabic += 1;
    }
  }
  return counted === 0 ? 0 : arabic / counted;
}

/**
 * How many LETTERS in `text` are Uzbek-Cyrillic ones Russian does not have: ў қ ғ ҳ.
 *
 * A plain count over the lowercased text — no word splitting, no deduplication. It is
 * the number the diagnostics line quotes ("6 such letters, which reads as Uzbek"), and
 * it is deliberately NOT what the evidence bar is measured in; see
 * `uzbekCyrillicWordCount`, which is.
 *
 * Deliberately these four letters and not "everything outside the Russian alphabet":
 * ә ұ ү ң are Kazakh, ҷ ҳ ӣ Tajik, і ї є ґ Ukrainian, and a Tashkent speaker dictating
 * Russian names any of them without having switched language.
 */
export function nonRussianCyrillicCount(text: string): number {
  let count = 0;
  for (const character of text.toLowerCase()) {
    if (UZBEK_CYRILLIC_SET.has(character)) count += 1;
  }
  return count;
}

/**
 * How many DISTINCT WORDS contain one of ў қ ғ ҳ.
 *
 * Splits on every non-letter — so hyphens AND digits break a word — and deduplicates
 * through a set, because the same word repeated eight times is one word's worth of
 * evidence. This splitter and the one inside `isUsableRerun` are different on purpose
 * and both are load-bearing; swapping them breaks a real case each.
 *
 * Words, not letters: the measured mis-route has 6 letters across 5 words, while a
 * legitimate Russian sentence naming Tashkent places ("Я живу на Қўйлиқ, рядом с Мирзо
 * Улуғбек") has 4 letters across 2 words. By letters the Russian one looks MORE Uzbek.
 */
export function uzbekCyrillicWordCount(text: string): number {
  const seen = new Set<string>();
  for (const word of splitWords(text.toLowerCase(), isLetter)) {
    for (const character of word) {
      if (UZBEK_CYRILLIC_SET.has(character)) {
        seen.add(word);
        break;
      }
    }
  }
  return seen.size;
}

/** `uzbekCyrillicWordCount(text) >= UZBEK_CYRILLIC_EVIDENCE`. */
export function looksLikeUzbekInCyrillic(text: string): boolean {
  return uzbekCyrillicWordCount(text) >= UZBEK_CYRILLIC_EVIDENCE;
}

/**
 * Does this output look like it came from the engine we routed to?
 *
 * One-directional per route, never symmetric. The Uzbek engine's vocabulary contains
 * ZERO Cyrillic tokens, so Cyrillic out of it is impossible rather than merely
 * surprising. The other direction used to be unwatched — Cyrillic from a Russian route
 * agreed by definition — and that is how a whole Uzbek dictation was delivered spelled
 * out phonetically in Cyrillic with nothing anywhere noticing.
 */
export function scriptAgrees(text: string, language: Language): boolean {
  switch (scriptOf(text)) {
    case 'neither':
    case 'mixed':
      return true; // punctuation, digits, or a code-switched line
    case 'arabic':
      // The one unambiguous signal: only Arabic is written in it (C4 §9.2).
      return language === 'ar';
    case 'cyrillic':
      // Cannot come from the Uzbek engine (no Cyrillic in its vocabulary), nor from the Turkish
      // or Arabic route (turbo is told the language; Cohere writes Arabic).
      if (language === 'uz' || language === 'tr' || language === 'ar') return false;
      return !looksLikeUzbekInCyrillic(text);
    case 'latin':
      // Latin from a Russian route is a mis-route; so is Latin from Cohere.
      return language !== 'ru' && language !== 'ar';
  }
}

// MARK: - The router

/**
 * The three-tier router. Non-throwing: it must ALWAYS return a decision.
 *
 * A `null` classifier is legal — no detector configured — and yields a `fallback` route
 * to `fallbackLanguage`, as does a classifier that returns an empty map ("no opinion").
 * An all-zero map is NOT empty and does reach the acoustic tier, where it scores 0.
 */
/** `OptionalLanguageRules()` with `enabled`: the Mac's measured thresholds. */
export function optionalLanguageRules(enabled: Iterable<Language> = []): OptionalLanguageRules {
  const on = new Set<Language>();
  for (const language of enabled) if (language === 'tr' || language === 'ar') on.add(language);
  return {
    enabled: on,
    arabicFrom: DEFAULT_ARABIC_FROM,
    turkishCandidateFrom: DEFAULT_TURKISH_CANDIDATE_FROM,
    turkishMinimumSeconds: DEFAULT_TURKISH_MINIMUM_SECONDS,
    arabicCandidateFrom: DEFAULT_ARABIC_CANDIDATE_FROM,
    arabicCandidateMinimumSeconds: DEFAULT_ARABIC_CANDIDATE_MINIMUM_SECONDS,
  };
}

/** `OptionalLanguageRules.share`: `code`'s share of the whole posterior; 0 when it is empty. */
export function posteriorShare(code: string, posterior: LanguagePosterior): number {
  let total = 0;
  for (const value of Object.values(posterior)) total += value;
  if (!(total > 0)) return 0;
  return (posterior[code] ?? 0) / total;
}

/**
 * `TurkishCheck.isTurkish`: turbo's language head says Turkish — at `TURKISH_VERIFIED_FROM` for
 * a user who has dictated Turkish before, `TURKISH_VERIFIED_FROM_UNFAMILIAR` until then.
 */
export function isTurkishVerified(verifierPosterior: LanguagePosterior, familiar: boolean): boolean {
  return (
    posteriorShare('tr', verifierPosterior) >=
    (familiar ? TURKISH_VERIFIED_FROM : TURKISH_VERIFIED_FROM_UNFAMILIAR)
  );
}

/**
 * `ArabicCheck.isArabic`: turbo's language head says Arabic — at `ARABIC_VERIFIED_FROM` for a
 * user who has dictated Arabic before, `ARABIC_VERIFIED_FROM_UNFAMILIAR` until then (C4 §14.1).
 */
export function isArabicVerified(verifierPosterior: LanguagePosterior, familiar: boolean): boolean {
  return posteriorShare('ar', verifierPosterior) >= (familiar ? ARABIC_VERIFIED_FROM : ARABIC_VERIFIED_FROM_UNFAMILIAR);
}

/** `LanguageCheck.verifies`: the candidate's own rule over the one head's posterior. */
export function isCandidateVerified(candidate: Language, verifierPosterior: LanguagePosterior, familiar: boolean): boolean {
  if (candidate === 'tr') return isTurkishVerified(verifierPosterior, familiar);
  if (candidate === 'ar') return isArabicVerified(verifierPosterior, familiar);
  return false;
}

/**
 * `TieredRouter.decide`: the acoustic tier over one posterior of `seconds` of audio. Pure, so
 * the golden fixtures replay exactly what the router does. With no optional language on, it is
 * the three-language rule it always was, and records no shares.
 *
 *   * Arabic first, at `arabicFrom`: no Uzbek clip measured reaches it, and an Arabic clip that
 *     also carried Turkic mass (some dialect ones do) belongs here.
 *   * The Turkic cluster → Uzbek, with `candidate: 'tr'` when Turkish is on, the `tr` share
 *     reaches `turkishCandidateFrom` and the recording is at least `turkishMinimumSeconds` —
 *     settled by `TurkishCheck` at key-up (the session), Uzbek when uncertain.
 *   * Otherwise the unified engine.
 */
export function decideRoute(
  posterior: LanguagePosterior,
  seconds: number,
  threshold: number,
  rules: OptionalLanguageRules = optionalLanguageRules(),
): RouteDecision {
  const mass = clusterMass(posterior);
  const on = rules.enabled.size > 0;
  const tr = on ? posteriorShare('tr', posterior) : null;
  const ar = on ? posteriorShare('ar', posterior) : null;
  const shares = on ? { turkishShare: tr, arabicShare: ar } : {};
  if (rules.enabled.has('ar') && ar !== null && ar >= rules.arabicFrom) {
    return { ...decision('ar', 'acoustic', mass), ...shares };
  }
  // Half-heard Arabic, from any route: settled by `ArabicCheck` (C4 §14.1). A Turkish candidate
  // asks first (it leaves at most 0.1 for `ar`).
  const arabicCandidate =
    rules.enabled.has('ar') && (ar ?? 0) >= rules.arabicCandidateFrom && seconds >= rules.arabicCandidateMinimumSeconds;
  if (mass >= threshold) {
    const candidate =
      rules.enabled.has('tr') && (tr ?? 0) >= rules.turkishCandidateFrom && seconds >= rules.turkishMinimumSeconds
        ? ('tr' as const)
        : arabicCandidate
          ? ('ar' as const)
          : null;
    return { ...decision('uz', 'acoustic', mass), ...shares, ...(candidate === null ? {} : { candidate }) };
  }
  // Inside the unified engine the language label is advisory: the decoder settles en-vs-ru
  // itself. Recording the more likely of the two is for the log and the HUD, not for the
  // engine, which is why getting it wrong here costs nothing.
  const ru = posterior['ru'] ?? 0;
  const en = posterior['en'] ?? 0;
  return { ...decision(ru > en ? 'ru' : 'en', 'acoustic', mass), ...shares, ...(arabicCandidate ? { candidate: 'ar' as const } : {}) };
}

/** `RouteDecision.rerouted`: the same decision sent to `language` by `source`, the evidence kept. */
export function reroutedDecision(
  original: RouteDecision,
  language: Language,
  source: RouteSource,
  turkishVerified?: number | null,
  arabicVerified?: number | null,
  probabilities?: Readonly<Record<string, number>> | null,
): RouteDecision {
  const verified = turkishVerified ?? original.turkishVerified ?? null;
  const arabic = arabicVerified ?? original.arabicVerified ?? null;
  // P4: what the language-ID model heard is kept, and the posterior is the newest one the
  // decision made — the Mac's `rerouted(to:by:…probabilities:)`.
  const acoustic = original.acoustic ?? null;
  const posterior = probabilities ?? original.probabilities ?? null;
  return {
    ...decision(language, source, original.turkicMass),
    ...(original.turkishShare === undefined ? {} : { turkishShare: original.turkishShare }),
    ...(original.arabicShare === undefined ? {} : { arabicShare: original.arabicShare }),
    ...(verified === null ? {} : { turkishVerified: verified }),
    ...(arabic === null ? {} : { arabicVerified: arabic }),
    ...(acoustic === null ? {} : { acoustic }),
    ...(posterior === null ? {} : { probabilities: posterior }),
  };
}

export function createTieredRouter(options: {
  readonly classifier: AcousticClassifier | null;
  readonly threshold: number;
  readonly fallbackLanguage: Language;
  /** Turkish and Arabic, when the user turned them on. Absent: the three-language router. */
  readonly optional?: OptionalLanguageRules;
  /** The dictation languages that are on. Absent: all five. Nothing outside it is returned. */
  readonly languages?: LanguageSubset;
}): LanguageRouter {
  const { classifier, threshold } = options;
  const languages = options.languages ?? ALL_LANGUAGES;
  const fallbackLanguage = subsetFallback(languages, options.fallbackLanguage);
  const rules = options.optional ?? optionalLanguageRules();
  return {
    async route(audio, pin) {
      // P1. A pin is absolute and free. Nothing below it runs — not even to log a
      // second opinion, because the acoustic pass costs real milliseconds on the
      // critical path.
      if (pin !== null) return decision(pin, 'pin', null);
      // One language on (or English and Russian alone): nothing to decide, and just as free.
      const sole = soleRouteOf(languages, fallbackLanguage);
      if (sole !== null) return decision(sole, 'only', null);

      // P4. One acoustic pass over the WHOLE utterance at key-release. Not a rolling
      // pass over a prefix: prefix answers are wrong *and* confident, and their
      // accuracy is not even monotonic in prefix length.
      if (classifier === null) return decision(fallbackLanguage, 'fallback', null);
      const posterior = await classifier.posterior(audio);
      if (Object.keys(posterior).length === 0) {
        return decision(fallbackLanguage, 'fallback', null);
      }

      return decideRouteInSubset(languages, posterior, audio.samples.length / SAMPLE_RATE, threshold, rules, fallbackLanguage);
    },
  };
}

// MARK: - Verification after the fact

/**
 * The post-transcription check. It REPORTS; the caller decides whether to re-transcribe.
 *
 * It deliberately does not consider `decision.source` — the pin exemption lives in the
 * session (see `recoveryPlan`), not here. Nor does it re-run the other engine on its
 * own authority: that costs the slow engine's full latency on every false positive.
 */
export function verifyRoute(decision: RouteDecision, transcript: string): RouteVerdict {
  if (scriptAgrees(transcript, decision.language)) return { kind: 'consistent' };
  const observed = scriptOf(transcript);
  // Cyrillic is evidence in whichever direction the route did not go: out of the Uzbek
  // engine it means the audio was Russian, and out of the Russian one — where it only
  // reaches here at all when the letters are not Russian letters — it means Uzbek.
  //
  // Arabic script suggests Arabic from any route; out of the Arabic route, Latin suggests
  // English and Cyrillic Russian (Cohere writes Arabic for Arabic speech). Cyrillic out of the
  // Turkish route suggests Russian, like out of the Uzbek one.
  const language = decision.language;
  let suggests: Language;
  if (observed === 'arabic') suggests = 'ar';
  else if (observed === 'cyrillic') suggests = language === 'uz' || language === 'tr' || language === 'ar' ? 'ru' : 'uz';
  else if (observed === 'latin' && (language === 'uz' || language === 'ar')) suggests = 'en';
  else suggests = 'uz';
  return { kind: 'suspect', observed, suggests };
}

/**
 * Build the decision a script check produces, carrying the ORIGINAL acoustic mass
 * through, so the record still says what the acoustic pass thought.
 */
export function rerouteDecision(original: RouteDecision, language: Language): RouteDecision {
  return decision(language, 'scriptCheck', original.turkicMass);
}

// MARK: - The mis-route recovery

/**
 * What the session does with a verdict, as data rather than as prose.
 *
 * The four constraints from `DictationSession` step 4b, each of which is here because
 * dropping it makes this worse than the bug it fixes:
 *
 * - **A pin is never overruled.** A pin is the one signal the user actually authored.
 *   When a pinned route trips the check, the record says so and the transcript stands.
 * - **It only ever moves toward Uzbek**, so a retry cannot itself be re-routed.
 * - **The replacement has to be plausible** — see `isUsableRerun`.
 * - **It is bounded**, by `REROUTE_DEADLINE_SECONDS`, after which the first transcript
 *   stands.
 *
 * Whether the Uzbek engine is loaded is the session's business and not modelled here;
 * this answers only whether the rule permits the attempt.
 */
export interface RecoveryPlan {
  /** Run the second pass on the Uzbek engine. */
  readonly attempted: boolean;
  /** The check fired and a pin is the only reason nothing happens. */
  readonly blockedByPin: boolean;
  readonly reTranscribesToward: Language | null;
  readonly resultingSourceOnSuccess: RouteSource | null;
  /** The ORIGINAL acoustic mass, carried into the new decision. */
  readonly turkicMassOnSuccess: number | null;
  readonly deadlineSeconds: number;
}

export function recoveryPlan(decision: RouteDecision, verdict: RouteVerdict): RecoveryPlan {
  const suspectTowardUzbek =
    verdict.kind === 'suspect' && verdict.suggests === 'uz' && decision.language !== 'uz';
  const attempted = suspectTowardUzbek && decision.source !== 'pin';
  return {
    attempted,
    blockedByPin: suspectTowardUzbek && decision.source === 'pin',
    reTranscribesToward: attempted ? 'uz' : null,
    resultingSourceOnSuccess: attempted ? 'scriptCheck' : null,
    turkicMassOnSuccess: attempted ? decision.turkicMass : null,
    deadlineSeconds: REROUTE_DEADLINE_SECONDS,
  };
}

/**
 * Is the Uzbek engine's second answer plausible enough to replace the first?
 *
 * Not merely non-empty. Handing Russian audio to an Uzbek-only fine-tune is the best
 * way there is to get a repetition loop or a bare `[BLANK_AUDIO]`, and pasting either
 * over a correct Russian transcript is a worse outcome than the mis-route it was meant
 * to fix.
 *
 * Ported from `DictationSession.isUsableRerun`, which is `internal` to KotibaCore — so
 * the golden generator could not call it either and transcribed the body instead. That
 * seam is named in `route.json` → `rerunsDerivedBy`; this is the only rule in this file
 * whose fixture is not the return of a public Swift API.
 */
export function isUsableRerun(text: string): boolean {
  return usable(text, true);
}

/**
 * `TranscriptEvidence.isUsable` (the language decision, P4): `isUsableRerun` without "Cyrillic
 * is unusable", which was a rule about the Uzbek engine only — here every engine's transcript is
 * judged, and Cyrillic is Russian's script. Golden-pinned through language-id.json › evidence.
 */
export function isUsableTranscript(text: string): boolean {
  return usable(text, false);
}

function usable(text: string, cyrillicIsUnusable: boolean): boolean {
  const trimmed = trimWhitespaceAndNewlines(text);
  if (trimmed.length === 0) return false;

  // whisper's own bracketed markers, in either bracket style. A transcript that is
  // nothing but markers carries no words.
  const withoutMarkers = trimWhitespaceAndNewlines(
    trimmed.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' '),
  );
  if (withoutMarkers.length === 0) return false;

  // The Uzbek engine's vocabulary holds zero Cyrillic tokens, so Cyrillic out of it is
  // not a second opinion — it is a broken one, and certainly not evidence against the
  // first.
  if (cyrillicIsUnusable && scriptOf(withoutMarkers) === 'cyrillic') return false;

  // A repetition loop. This splitter keeps DIGITS and the okina U+02BB inside words and
  // walks consecutive pairs WITHOUT deduplicating — the deliberate other half of the
  // asymmetry noted on `uzbekCyrillicWordCount`.
  const words = splitWords(withoutMarkers.toLowerCase(), isLetterOrNumberOrOkina);
  let run = 1;
  for (let i = 1; i < words.length; i += 1) {
    run = words[i - 1] === words[i] ? run + 1 : 1;
    if (run >= REPETITION_RUN_LIMIT) return false;
  }
  return true;
}

// MARK: - Helpers

function decision(
  language: Language,
  source: RouteSource,
  turkicMass: number | null,
): RouteDecision {
  return { language, family: engineFamilyFor(language), source, turkicMass };
}

/** `String.split(whereSeparator:)`, which omits empty subsequences. */
function splitWords(text: string, isWordCharacter: (character: string) => boolean): string[] {
  const words: string[] = [];
  let current = '';
  for (const character of text) {
    if (isWordCharacter(character)) {
      current += character;
    } else if (current.length > 0) {
      words.push(current);
      current = '';
    }
  }
  if (current.length > 0) words.push(current);
  return words;
}

/** `Character.isLetter` — see `LETTER`: isAlphabetic, NOT general category L. */
function isLetter(character: string): boolean {
  return LETTER.test(character);
}

/**
 * `!$0.isLetter && !$0.isNumber && $0 != "\u{02BB}"`, negated.
 *
 * The okina clause is REDUNDANT in both languages — U+02BB is a modifier letter, so it
 * is `isAlphabetic` to Swift and `\p{Alphabetic}` to JS. It is kept because the Swift
 * carries it, and because a reader arriving from `uzbekCyrillicWordCount` needs to see
 * that the difference between the two splitters is DIGITS and deduplication, not the
 * okina.
 */
function isLetterOrNumberOrOkina(character: string): boolean {
  return character === OKINA || LETTER_OR_NUMBER.test(character);
}

/** `trimmingCharacters(in: .whitespacesAndNewlines)`. */
function trimWhitespaceAndNewlines(text: string): string {
  const characters = [...text];
  let start = 0;
  let end = characters.length;
  while (start < end && WHITESPACE_AND_NEWLINES.has(characters[start]!)) start += 1;
  while (end > start && WHITESPACE_AND_NEWLINES.has(characters[end - 1]!)) end -= 1;
  return characters.slice(start, end).join('');
}
