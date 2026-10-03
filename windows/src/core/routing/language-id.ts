// src/core/routing — the language decision (P4, D-14).
//
// A 1:1 port of Sources/KotibaCore/LanguageID.swift: `AcousticEvidence`, `TranscriptEvidence`,
// `LanguagePrior`, `LanguageModel`, `LanguageDecision`, `LanguagePolicy` and the router's pure
// `decide`. Asserted number for number against fixtures/golden/language-id.json in
// test/routing/language-id.test.ts — the decision is a measured classifier, and a quietly
// different fold, feature or weight is a quietly different router.
//
// PURE, like the rest of this module: no Node builtin, no OS. The classifier that produces the
// 107-language posterior (`src/engines/language-id.ts`, ECAPA on ONNX Runtime) arrives as an
// `AcousticClassifier`.
//
// ONE CALIBRATED DECISION over the languages that are on, from every piece of evidence the
// dictation has produced — instead of a chain of one-directional checks (steps 4a, 4a′, 4b, 4b′),
// each with its own threshold, each able to send speech to only one other language:
//
//   * what the audio sounds like: VoxLingua107 ECAPA-TDNN — 107 languages, Uzbek a class of its
//     own (whisper base answers clean Uzbek `tr 0.63 / az 0.17 / uz 0.00`; this model names it);
//   * what each engine that ran wrote, read against every language's word list (lexicon.ts): the
//     Uzbek engine writing Arabic speech as Latin transliteration is mostly unknown Uzbek words;
//     Parakeet writing English as Cyrillic is no Russian at all;
//   * how often this user dictates each language (`languagePrior`) — a prior, never a wall.
//
// They add up as log-odds (a multinomial logistic model, `Scripts/measure/fit-lid.py`, weights in
// language-model-weights.ts) and the decision is a posterior over the enabled languages. The same
// function decides for every language in every direction — no step can only ever point at Uzbek.
//
// NUMERICS. Every sum here runs in the Swift's order where the Swift's order is fixed (the model's
// language order, the feature order), and over a map's values where the Swift sums a
// `Dictionary` — whose order is per-process even in Swift, so the fixture prints six decimals and
// the test compares that decimal text (golden.ts). `Math.log` / `Math.log1p` / `Math.exp` are V8's
// fdlibm ports, Swift's are Apple libm: they agree far below the sixth decimal.

import type {
  AcousticClassifier,
  AcousticEvidence,
  AudioBuffer,
  EngineFamily,
  Language,
  LanguagePosterior,
  LanguageRouter,
  RouteDecision,
} from '../../contracts/index.js';
import { LANGUAGES, audioDuration, engineFamilyFor } from '../../contracts/index.js';
import { isUsableTranscript } from './index.js';
import { languageSubset, soleRoute, subsetFallback } from './language-subset.js';
import { lexiconContains } from './lexicon.js';
import { LID_ACOUSTIC_WEIGHTS, LID_TRANSCRIPT_WEIGHTS } from './language-model-weights.js';
import { HESITATIONS, transcriptWords } from './transcript-check.js';

/**
 * The five dictation languages in the model's fixed order — of its weights' rows, of
 * `AcousticEvidence.logProbabilities` and of `TranscriptEvidence.known`. NOT `LANGUAGES` order
 * (en, ru, uz, tr, ar): ties rank in THIS order, Uzbek first — the owner's rule, when unsure, Uzbek.
 */
export const LID_ORDER: readonly Language[] = ['uz', 'tr', 'ar', 'en', 'ru'];

// MARK: - Acoustic evidence

/**
 * Floor for a log-probability: the model's own posteriors go down to 1e-30, and nothing below
 * about 1e-5 is evidence of anything but how sure it was elsewhere.
 */
export const ACOUSTIC_LOG_FLOOR = Math.log(1e-5);

/**
 * What the language-ID model heard: the five languages' shares of the posterior's total, then the
 * rest's, each as a log floored at `ACOUSTIC_LOG_FLOOR`. A posterior with nothing in it (total ≤ 0)
 * is six floors.
 */
export function acousticEvidence(posterior: LanguagePosterior, seconds: number): AcousticEvidence {
  let total = 0;
  for (const value of Object.values(posterior)) total += value;
  const lp = (p: number): number => Math.max(ACOUSTIC_LOG_FLOOR, Math.log(Math.max(p, 0)));
  if (!(total > 0)) {
    return { logProbabilities: Array.from({ length: 6 }, () => ACOUSTIC_LOG_FLOOR), seconds };
  }
  const five = LID_ORDER.map((language) => (posterior[language] ?? 0) / total);
  let sum = 0;
  for (const share of five) sum += share;
  return { logProbabilities: [...five.map(lp), lp(1 - sum)], seconds };
}

/** The features the model reads: the six log-probabilities and log seconds (at least 0.25 s). */
export function acousticFeatures(evidence: AcousticEvidence): number[] {
  return [...evidence.logProbabilities, Math.log(Math.max(evidence.seconds, 0.25))];
}

// MARK: - Transcript evidence

/**
 * One transcript, read against every language's word list. Counts only: what they mean depends
 * on which engine wrote the text, and that is the model's business.
 */
export interface TranscriptEvidence {
  /**
   * Words the lists can judge: not a proper noun or an acronym (a capital anywhere but a
   * sentence's first letter), not a number's suffix, not a hesitation — the transcript check's
   * rule. Hesitations count only when they are all there is.
   */
  readonly counted: number;
  /** Of `counted`, how many each list knows, in `LID_ORDER`. */
  readonly known: readonly number[];
  /** A repetition loop, a bare marker, or nothing: what an engine writes for speech it cannot read. */
  readonly unusable: boolean;
}

/** `TranscriptEvidence.read`. The words are `transcriptWords`' — the same splitter as step 4a′. */
export function readTranscriptEvidence(text: string): TranscriptEvidence {
  let counted = 0;
  const known = [0, 0, 0, 0, 0];
  const count = (word: string): void => {
    counted += 1;
    LID_ORDER.forEach((language, i) => {
      if (lexiconContains(word, language)) known[i]! += 1;
    });
  };
  const hesitations: string[] = [];
  for (const { word, startsSentence, afterDigit } of transcriptWords(text)) {
    if (afterDigit) continue;
    const scalars = [...word];
    if (scalars.slice(1).some((scalar) => UPPERCASE.test(scalar))) continue;
    const first = scalars[0];
    if (first !== undefined && UPPERCASE.test(first) && !startsSentence && word !== 'I') continue;
    if (HESITATIONS.has(word.toLowerCase())) {
      hesitations.push(word);
      continue;
    }
    // The word as written: each list folds it its own way (`lexiconContains`).
    count(word);
  }
  if (counted === 0) for (const word of hesitations) count(word);
  return { counted, known, unusable: !isUsableTranscript(text) };
}

/** `Unicode.Scalar.Properties.isUppercase` — the binary property, as transcript-check.ts explains. */
const UPPERCASE = /\p{Uppercase}/u;

/**
 * The features the model reads for one transcript: per list, log(1 + known) and log(1 + not
 * known), then unusable. Logarithms because word evidence is not independent — the tenth unknown
 * word of a transliteration says less than the first — and a 30 s dictation must not outvote the
 * audio by its length alone.
 */
export function transcriptFeatures(evidence: TranscriptEvidence): number[] {
  const out: number[] = [];
  for (const known of evidence.known) out.push(Math.log1p(known), Math.log1p(evidence.counted - known));
  out.push(evidence.unusable ? 1 : 0);
  return out;
}

// MARK: - The user's own history

/** How often this user has dictated each language — `Settings.*Dictations`, pins included. */
export type LanguageCounts = Readonly<Partial<Record<Language, number>>>;

/** The prior's weight: a 600-to-0 history is 0.25 × log(620 / 20) = 0.86 nats — a prior, not a wall (P4 §5). */
export const LANGUAGE_PRIOR_WEIGHT = 0.25;
/** Pseudo-dictations each enabled language starts with, so a never-used one keeps a real chance. */
export const LANGUAGE_PRIOR_SMOOTHING = 20;

/**
 * `LanguagePrior.logPrior`: weight × log of the user's smoothed share of `language` among the
 * enabled ones, × their count — 0 for every language of a new user (a flat prior).
 */
export function languageLogPrior(counts: LanguageCounts, language: Language, enabled: ReadonlySet<Language>): number {
  let total = 0;
  for (const each of enabled) total += (counts[each] ?? 0) + LANGUAGE_PRIOR_SMOOTHING;
  if (!(total > 0)) return 0;
  const mine = (counts[language] ?? 0) + LANGUAGE_PRIOR_SMOOTHING;
  return LANGUAGE_PRIOR_WEIGHT * Math.log((mine / total) * enabled.size);
}

// MARK: - The model

/**
 * Which engine wrote a transcript — the index of its weights. Each reads differently: Parakeet's
 * unknown Latin words are Uzbek or Turkish it could not write; the Uzbek engine's are Arabic or
 * Turkish it transliterated.
 */
const TRANSCRIPT_SOURCE: Readonly<Record<EngineFamily, number>> = { unified: 0, uzbek: 1, turkish: 2, arabic: 3 };

/** `[language in LID_ORDER][feature]` (7 acoustic + bias) and `[source][language][feature]` (11). */
export interface LanguageModel {
  readonly acoustic: readonly (readonly number[])[];
  readonly transcript: readonly (readonly (readonly number[])[])[];
}

/** The fitted model (`LanguageModel.fitted`), whatever `fit-lid.py --write` last generated. */
export const FITTED_LANGUAGE_MODEL: LanguageModel = {
  acoustic: LID_ACOUSTIC_WEIGHTS,
  transcript: LID_TRANSCRIPT_WEIGHTS,
};

/** Transcripts by the family of the engine that wrote them. */
export type TranscriptsByFamily = Readonly<Partial<Record<EngineFamily, TranscriptEvidence>>>;

/** `zip(a, b).reduce(0) { $0 + $1.0 * $1.1 }` — over the shorter of the two, in order. */
function dot(weights: readonly number[], features: readonly number[]): number {
  let sum = 0;
  const n = Math.min(weights.length, features.length);
  for (let i = 0; i < n; i += 1) sum += weights[i]! * features[i]!;
  return sum;
}

/** The scores, before the softmax, for every language in `LID_ORDER`. */
export function languageScores(
  model: LanguageModel,
  acoustic: AcousticEvidence | null,
  transcripts: TranscriptsByFamily,
  counts: LanguageCounts,
  enabled: ReadonlySet<Language>,
): number[] {
  const x = acoustic === null ? null : [...acousticFeatures(acoustic), 1];
  const read = (Object.entries(transcripts) as [EngineFamily, TranscriptEvidence | undefined][])
    .filter((entry): entry is [EngineFamily, TranscriptEvidence] => entry[1] !== undefined)
    .map(([family, evidence]) => ({ source: TRANSCRIPT_SOURCE[family], features: transcriptFeatures(evidence) }));
  return LID_ORDER.map((language, i) => {
    let s = 0;
    if (x !== null) s += dot(model.acoustic[i] ?? [], x);
    for (const { source, features } of read) s += dot(model.transcript[source]?.[i] ?? [], features);
    return s + languageLogPrior(counts, language, enabled);
  });
}

/** A posterior over the enabled languages, keyed by code. */
export type LanguageDecision = Readonly<Partial<Record<Language, number>>>;

/** `LanguageModel.decide`: the softmax of the scores over the enabled languages (empty = all five). */
export function decideLanguage(
  model: LanguageModel,
  acoustic: AcousticEvidence | null,
  transcripts: TranscriptsByFamily,
  counts: LanguageCounts,
  enabled: ReadonlySet<Language>,
): LanguageDecision {
  const on: ReadonlySet<Language> = enabled.size === 0 ? new Set(LANGUAGES) : enabled;
  const s = languageScores(model, acoustic, transcripts, counts, on);
  const pairs = LID_ORDER.map((language, i) => ({ language, score: s[i]! })).filter(({ language }) => on.has(language));
  const top = pairs.length === 0 ? 0 : Math.max(...pairs.map(({ score }) => score));
  const exps = pairs.map(({ language, score }) => ({ language, e: Math.exp(score - top) }));
  let z = 0;
  for (const { e } of exps) z += e;
  const posterior: Partial<Record<Language, number>> = {};
  for (const { language, e } of exps) posterior[language] = e / z;
  return posterior;
}

/** Ranked, ties broken in `LID_ORDER` (Uzbek first). */
export function rankedLanguages(decision: LanguageDecision): { readonly language: Language; readonly probability: number }[] {
  return LID_ORDER.flatMap((language, order) => {
    const probability = decision[language];
    return probability === undefined ? [] : [{ language, probability, order }];
  })
    .sort((a, b) => (a.probability !== b.probability ? b.probability - a.probability : a.order - b.order))
    .map(({ language, probability }) => ({ language, probability }));
}

/** The decided language — English when the decision is empty, as the Swift's `?? .english`. */
export function decisionLanguage(decision: LanguageDecision): Language {
  return rankedLanguages(decision)[0]?.language ?? 'en';
}

export function decisionConfidence(decision: LanguageDecision): number {
  return rankedLanguages(decision)[0]?.probability ?? 0;
}

/** The posterior keyed by code, as the record stores it (`LanguageDecision.codes`). */
export function decisionCodes(decision: LanguageDecision): Record<string, number> {
  return { ...decision } as Record<string, number>;
}

// MARK: - The policy

/**
 * Ask another engine while the languages of the engines not yet heard from hold at least this much
 * (`LanguagePolicy.defaultAskFrom`, chosen on the tuning half, P4 §4).
 */
export const DEFAULT_ASK_FROM = 0.1;

/** Engines that may write a transcript of one dictation, the routed one included. */
export const DEFAULT_MAX_ENGINES = 3;

/**
 * The moments the session decides, as one pure rule (golden language-id.json › decisions):
 *
 * 1. **Route** (`policyRoute`): the audio and the prior alone — which engine finishes the dictation.
 * 2. **Read** (`policyConsider`): every transcript in hand is added. When the posterior then gives
 *    the languages of engines NOT YET HEARD FROM at least `askFrom` between them, the most likely of
 *    those is asked: its engine transcribes the same audio, and its transcript is read too.
 *    Repeated — at most `maxEngines` engines in all — so the Uzbek engine's transliteration of
 *    Arabic, once read, can send the dictation on to Cohere. Symmetric: Parakeet's text can send a
 *    dictation to Arabic as readily as to Uzbek, the Uzbek engine's to Turkish or English.
 * 3. **Choose** (`policyChoose`): the decision over every transcript, among the languages of the
 *    engines that wrote a usable one (nothing else has a transcript to deliver).
 *
 * Inside Parakeet's family the decision also names English or Russian, and that beats the script
 * Parakeet happened to write (`needsRespelling`).
 */
export interface LanguagePolicy {
  readonly model: LanguageModel;
  readonly counts: LanguageCounts;
  /** Never empty: an empty set given to `languagePolicy` is all five. */
  readonly enabled: ReadonlySet<Language>;
  readonly askFrom: number;
  readonly maxEngines: number;
}

export function languagePolicy(options: {
  readonly model?: LanguageModel;
  readonly counts?: LanguageCounts;
  readonly enabled: Iterable<Language>;
  readonly askFrom?: number;
  readonly maxEngines?: number;
}): LanguagePolicy {
  const enabled = new Set(options.enabled);
  return {
    model: options.model ?? FITTED_LANGUAGE_MODEL,
    counts: options.counts ?? {},
    enabled: enabled.size === 0 ? new Set(LANGUAGES) : enabled,
    askFrom: options.askFrom ?? DEFAULT_ASK_FROM,
    maxEngines: options.maxEngines ?? DEFAULT_MAX_ENGINES,
  };
}

/** One engine's transcript, under the language it was asked for. */
export type ReadTranscript = readonly [Language, TranscriptEvidence];

/** By the family of the engine that wrote each — a later transcript of a family replaces an earlier one. */
function byFamily(transcripts: readonly ReadTranscript[]): TranscriptsByFamily {
  const out: Partial<Record<EngineFamily, TranscriptEvidence>> = {};
  for (const [language, evidence] of transcripts) out[engineFamilyFor(language)] = evidence;
  return out;
}

export function policyRoute(policy: LanguagePolicy, acoustic: AcousticEvidence | null): LanguageDecision {
  return decideLanguage(policy.model, acoustic, {}, policy.counts, policy.enabled);
}

/**
 * The decision over every enabled language with the transcripts in hand, and the language whose
 * engine to ask next — `null` when the engines heard from already hold more than 1 − `askFrom`,
 * or `maxEngines` have written.
 */
export function policyConsider(
  policy: LanguagePolicy,
  acoustic: AcousticEvidence | null,
  transcripts: readonly ReadTranscript[],
): { readonly decision: LanguageDecision; readonly ask: Language | null } {
  const decision = decideLanguage(policy.model, acoustic, byFamily(transcripts), policy.counts, policy.enabled);
  const heard = new Set(transcripts.map(([language]) => engineFamilyFor(language)));
  if (heard.size >= policy.maxEngines) return { decision, ask: null };
  let outside = 0;
  for (const [language, p] of Object.entries(decision) as [Language, number][]) {
    if (!heard.has(engineFamilyFor(language))) outside += p;
  }
  const next = rankedLanguages(decision).find(({ language }) => !heard.has(engineFamilyFor(language)))?.language ?? null;
  if (outside < policy.askFrom || next === null) return { decision, ask: null };
  return { decision, ask: next };
}

/**
 * The language to deliver: the decision over every transcript, among the enabled languages of the
 * `deliverable` families (by default every family that wrote) — all enabled when none is.
 */
export function policyChoose(
  policy: LanguagePolicy,
  acoustic: AcousticEvidence | null,
  transcripts: readonly ReadTranscript[],
  deliverable?: ReadonlySet<EngineFamily>,
): LanguageDecision {
  const heard = deliverable ?? new Set(transcripts.map(([language]) => engineFamilyFor(language)));
  const on = new Set([...policy.enabled].filter((language) => heard.has(engineFamilyFor(language))));
  return decideLanguage(policy.model, acoustic, byFamily(transcripts), policy.counts, on.size === 0 ? policy.enabled : on);
}

/**
 * `LanguagePolicy.respell`: whether Parakeet's transcript must be decoded again in the decided
 * language — it wrote the other script (more Cyrillic letters than Latin for English, the reverse
 * for Russian). Latin is ASCII A–Z a–z, Cyrillic the whole U+0400 block, as `writtenLanguage`.
 */
export function needsRespelling(text: string, language: Language): boolean {
  if (language !== 'en' && language !== 'ru') return false;
  let latin = 0;
  let cyrillic = 0;
  for (const character of text) {
    const scalar = character.codePointAt(0) ?? 0;
    if ((scalar >= 0x41 && scalar <= 0x5a) || (scalar >= 0x61 && scalar <= 0x7a)) latin += 1;
    else if (scalar >= 0x400 && scalar <= 0x4ff) cyrillic += 1;
  }
  return language === 'en' ? cyrillic > latin : latin > cyrillic;
}

// MARK: - The router

/**
 * `LanguageIDRouter.decide`: the acoustic route over one posterior, through the policy's route.
 * Static and pure for the goldens; the router below calls it with the classifier's answer.
 */
export function decideLanguageIDRoute(posterior: LanguagePosterior, seconds: number, policy: LanguagePolicy): RouteDecision {
  const acoustic = acousticEvidence(posterior, seconds);
  const decision = policyRoute(policy, acoustic);
  const language = decisionLanguage(decision);
  return {
    language,
    family: engineFamilyFor(language),
    source: 'acoustic',
    turkicMass: null,
    acoustic,
    probabilities: decisionCodes(decision),
  };
}

/**
 * The acoustic route of P4: the language-ID model over the recording, through `policyRoute`. A pin
 * and a single enabled family are free, exactly as in the tiered router; an empty posterior (the
 * model could not answer) is the fallback language, never a blocked dictation.
 */
export function createLanguageIDRouter(options: {
  readonly classifier: AcousticClassifier;
  readonly policy: LanguagePolicy;
  readonly fallback?: Language;
}): LanguageRouter & { readonly policy: LanguagePolicy } {
  const subset = languageSubset(options.policy.enabled);
  const fallback = subsetFallback(subset, options.fallback ?? 'en');
  return {
    policy: options.policy,
    async route(audio: AudioBuffer, pin: Language | null): Promise<RouteDecision> {
      if (pin !== null) return { language: pin, family: engineFamilyFor(pin), source: 'pin', turkicMass: null };
      const sole = soleRoute(subset, fallback);
      if (sole !== null) return { language: sole, family: engineFamilyFor(sole), source: 'only', turkicMass: null };
      const posterior = await options.classifier.posterior(audio);
      if (Object.keys(posterior).length === 0) {
        return { language: fallback, family: engineFamilyFor(fallback), source: 'fallback', turkicMass: null };
      }
      return decideLanguageIDRoute(posterior, audioDuration(audio), options.policy);
    },
  };
}
