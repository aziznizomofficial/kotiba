// Routing is ONE BIT: Uzbek engine, or the unified engine. These are the types that
// carry that decision and the evidence behind it.
//
// Ported from Sources/KotibaCore/Contracts.swift:136-166 and Sources/KotibaCore/Routing.swift.

import type { EngineFamily, Language } from './language.js';

/**
 * Where a route came from. Raw values are the JSON wire format and are asserted by
 * diagnostics tests.
 *
 * `transcriptCheck`: the unified engine's transcript read as neither English nor Russian
 * and the Uzbek engine's did not read as English — Uzbek the acoustic pass missed (session
 * step 4a′, `TranscriptCheck`). The Mac's `lexicalCheck` (step 4c, the Uzbek engine
 * answering in English words) has no Windows step yet, so it is not listed here: a source
 * nothing on this side can produce would be a wire value no test could reach.
 */
/* `only`: one language on (or English and Russian alone), so nothing was detected
 * (`LanguageSubset.soleRoute`) — free like a pin, but recoveries may still move it within the
 * languages that are on. */
export const ROUTE_SOURCES = ['pin', 'acoustic', 'scriptCheck', 'transcriptCheck', 'fallback', 'turkishCheck', 'arabicCheck', 'only'] as const;
export type RouteSource = (typeof ROUTE_SOURCES)[number];

/**
 * Why the unified engine's transcript doubted its own route (`TranscriptCheck.Doubt`). Raw
 * values are the wire format of `DictationRecord.unifiedDoubt`.
 *
 * - `noWords`: no words at all, though speech was heard — Parakeet gave up on it.
 * - `notEnglish`: Latin, and fewer than `NOT_ENGLISH_BELOW` of its words are English words.
 */
export const TRANSCRIPT_DOUBTS = ['noWords', 'notEnglish'] as const;
export type TranscriptDoubt = (typeof TRANSCRIPT_DOUBTS)[number];

/**
 * The route, and the evidence for it.
 *
 * `family` is DERIVED from `language` (`engineFamilyFor`), never an independent input —
 * but it IS on the wire, because the Swift `Codable` is synthesised over stored
 * properties and a diagnostics line without it does not decode.
 */
export interface RouteDecision {
  readonly language: Language;
  readonly family: EngineFamily;
  readonly source: RouteSource;
  /**
   * Summed normalised probability over the Turkic cluster. `null` for pins and fallbacks.
   *
   * A clean Uzbek clip scores `tr 0.63 / az 0.17 / uz 0.00`, so any rule waiting for `uz`
   * to win on argmax never fires. That is why this is a cluster sum and not a top-1.
   *
   * On a script-check reroute the ORIGINAL acoustic mass is carried into the new
   * decision, so the record still says what the acoustic pass thought.
   */
  readonly turkicMass: number | null;
  /**
   * The detector's `tr` and `ar` probabilities as shares of its whole posterior — recorded only
   * when an optional language is on, since only then does routing read them (the Mac's D-11).
   * Absent means off; the macOS encoder omits a nil optional, so a record written with both off
   * is byte-identical to one written before Turkish and Arabic existed.
   */
  readonly turkishShare?: number | null;
  readonly arabicShare?: number | null;
  /**
   * A second language the decision has not ruled out, for the session to settle with more
   * evidence: `tr` on an Uzbek route that sounded Turkish, settled by `TurkishCheck`; `ar` on
   * any route that half-sounded Arabic, settled by `ArabicCheck` (C4 §14.1).
   */
  readonly candidate?: Language | null;
  /** turbo's `tr` share, when `TurkishCheck` was asked. For the record. */
  readonly turkishVerified?: number | null;
  /** turbo's `ar` share, when `ArabicCheck` was asked. For the record. */
  readonly arabicVerified?: number | null;
}

// ---- Optional languages (D-11 on the Mac, C4) ------------------------------------------

/**
 * Arabic outright at an `ar` share of the whole posterior at or above this. FLEURS Arabic
 * scores a median 0.998; an Uzbek prayer formula reached 0.974 — so it sits just above that.
 */
export const DEFAULT_ARABIC_FROM = 0.975;
/** A Turkic recording with a `tr` share at least this is a Turkish CANDIDATE… */
export const DEFAULT_TURKISH_CANDIDATE_FROM = 0.9;
/** …and only one at least this long: short Turkish and Uzbek are least separable. */
export const DEFAULT_TURKISH_MINIMUM_SECONDS = 5;
/** `TurkishCheck`: Turkish at or above this `tr` share from turbo's own language head. */
export const TURKISH_VERIFIED_FROM = 0.99;
/**
 * …until the user has dictated Turkish once (`Settings.turkishDictations` is 0): turning
 * Turkish on is a reason to expect it, not proof (the Mac's `TurkishCheck.verifiedFromUnfamiliar`).
 */
export const TURKISH_VERIFIED_FROM_UNFAMILIAR = 0.995;
/**
 * The encoder window `TurkishCheck`'s head reads: the audio plus this many positions of
 * silence (50 a second), not the model's 30 s — cheaper by the ratio, and measured to separate
 * Turkish from Uzbek at least as well (the Mac's `TurkishCheck.headMargin`, C4 §13).
 */
export const TURKISH_HEAD_MARGIN = 128;

/**
 * Under `arabicFrom`, an `ar` share at least this makes an Arabic CANDIDATE on any base route
 * (the Mac's `OptionalLanguageRules.arabicCandidateFrom`, C4 §14.1): English, Russian and
 * Turkish never reach it; 9 % of Uzbek dictations of 3.5 s or more do, and are asked.
 */
export const DEFAULT_ARABIC_CANDIDATE_FROM = 0.05;
/** …and only a recording at least this long: turbo hears some SHORT Uzbek as Arabic. */
export const DEFAULT_ARABIC_CANDIDATE_MINIMUM_SECONDS = 3.5;
/** `ArabicCheck`: Arabic at or above this `ar` share from turbo's head, once the user has dictated Arabic. */
export const ARABIC_VERIFIED_FROM = 0.95;
/** …until then (`Settings.arabicDictations` is 0). */
export const ARABIC_VERIFIED_FROM_UNFAMILIAR = 0.98;

/**
 * The dictation languages that are on (`Settings.enabledLanguages`, the Mac's `LanguageSubset`):
 * never empty. The rules over it live in src/core/routing/language-subset.ts.
 */
export interface LanguageSubset {
  readonly languages: ReadonlySet<Language>;
}

/** Which optional languages are on, and the thresholds. Empty `enabled`: nothing is read. */
export interface OptionalLanguageRules {
  readonly enabled: ReadonlySet<Language>;
  readonly arabicFrom: number;
  readonly turkishCandidateFrom: number;
  readonly turkishMinimumSeconds: number;
  readonly arabicCandidateFrom: number;
  readonly arabicCandidateMinimumSeconds: number;
}

/**
 * The languages an Uzbek utterance is routinely heard as. Seven codes.
 * Tajik (`tg`) is not Turkic; it is in the set because it is the same geography.
 */
export const TURKIC_CLUSTER: readonly string[] = ['uz', 'tr', 'az', 'tk', 'kk', 'ky', 'tg'];

/**
 * Turkic cluster mass at or above which a recording routes to the Uzbek engine.
 *
 * ONE literal, mirrored into `DEFAULT_SETTINGS.turkicThreshold`. The two copies previously
 * disagreed (0.5 in core, 0.05 in the app). Derived from 120 clips: 106 cleared 0.05, only
 * 47 cleared 0.50, worst English/Russian control 0.012, Uzbek median 0.325.
 *
 * The comparison is `>=`. The tie deliberately favours Uzbek, because the two mistakes are
 * not symmetric: the unified engine cannot emit Uzbek at all, whereas the Uzbek engine
 * merely emits English badly.
 */
export const DEFAULT_TURKIC_THRESHOLD = 0.05;

/** A language-code → probability map. NOT normalised; the consumer divides by the total. */
export type LanguagePosterior = Readonly<Record<string, number>>;

/** What `ScriptCheck.script(of:)` answers. */
export const SCRIPTS = ['latin', 'cyrillic', 'arabic', 'mixed', 'neither'] as const;
export type Script = (typeof SCRIPTS)[number];

/**
 * ASCII ONLY for Latin, and the whole Cyrillic block for Cyrillic.
 *
 * `\p{Script=Latin}` is NOT a substitute: it reclassifies accented Latin and U+02BB and
 * silently changes four routing decisions at once.
 */
export const SCRIPT_RANGES = {
  latin: [
    [0x0041, 0x005a],
    [0x0061, 0x007a],
  ],
  cyrillic: [[0x0400, 0x04ff]],
} as const;

/**
 * The four letters that mark Uzbek written in Cyrillic: ў қ ғ ҳ.
 *
 * Deliberately NOT "everything outside the Russian alphabet": ә ұ ү ң are Kazakh,
 * ҷ ӣ Tajik, і ї є ґ Ukrainian, and a Tashkent speaker dictating Russian names any of
 * them without switching language.
 */
export const UZBEK_CYRILLIC_LETTERS = 'ўқғҳ';

/**
 * DISTINCT WORDS containing an Uzbek-Cyrillic letter, at or above which a Cyrillic
 * transcript is read as Uzbek. Words, not letters: the measured mis-route has 6 letters
 * across 5 words, while a legitimate Russian sentence naming Tashkent places
 * ("Я живу на Қўйлиқ, рядом с Мирзо Улуғбек") has 4 letters across 2 words.
 */
export const UZBEK_CYRILLIC_EVIDENCE = 4;

/** MODIFIER LETTER TURNED COMMA — a word character, not punctuation. */
export const OKINA = 'ʻ';
/** MODIFIER LETTER APOSTROPHE — the tutuq belgisi. A different letter from the okina. */
export const TUTUQ = 'ʼ';

/**
 * The post-transcription verifier's answer. Transient — never persisted.
 *
 * It reports; the caller decides. It deliberately does not consider `source`: the pin
 * exemption lives in the session, not here.
 */
export type RouteVerdict =
  | { readonly kind: 'consistent' }
  | { readonly kind: 'suspect'; readonly observed: Script; readonly suggests: Language };
