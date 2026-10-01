// Polish: the optional LLM pass, and the two guards that decide whether to keep it.
//
// Ported from `PolishGuard` / `UzbekPolishGuard` / `PolishClient`
// (Sources/KotibaCore/TextPipeline.swift, UzbekPolishGuard.swift, PolishClient.swift).

import type { Language } from './language.js';
import type { Script } from './routing.js';

/** The band a polish result must land in to be accepted. */
export interface PolishGuardConfig {
  /** Below this length ratio the polish deleted content. */
  readonly minimumRatio: number;
  /** Above this it ran away. */
  readonly maximumRatio: number;
  /**
   * Extra characters allowed on a SHORT input, where a ratio stops meaning anything.
   * Applied as `max((length + headroom) / length, maximumRatio)`.
   */
  readonly shortInputHeadroom: number;
}

/** Applied to every NON-restructuring mode (`super`, `transcription`). */
export const DEFAULT_POLISH_GUARD: PolishGuardConfig = {
  // 0.75 sits just above the measured 0.72 failure.
  minimumRatio: 0.75,
  maximumRatio: 2.0,
  shortInputHeadroom: 0,
};

/**
 * Applied when `mode.restructures` is true (`message`, `note`).
 *
 * The `note` mode measured compression ratios of 0.23 and 0.30 in the wild, both
 * rejected by the older 0.5 floor — which is why the mode appeared to do nothing while
 * every test passed.
 */
export const RESTRUCTURING_POLISH_GUARD: PolishGuardConfig = {
  minimumRatio: 0.12,
  maximumRatio: 3.0,
  shortInputHeadroom: 120,
};

/** Below this many characters the length ratio stops meaning anything. */
export const RATIO_FLOOR_LENGTH = 60;

/**
 * Why a polish was thrown away. `null` from a guard means accept.
 *
 * Ratios are over CHARACTER counts (grapheme clusters), not bytes and not UTF-16 units.
 */
export type PolishRejection =
  | { readonly kind: 'truncated'; readonly ratio: number; readonly reason: string }
  | { readonly kind: 'inflated'; readonly ratio: number; readonly reason: string }
  | {
      readonly kind: 'scriptChanged';
      readonly from: Script;
      readonly to: Script;
      readonly reason: string;
    }
  | { readonly kind: 'inventedWords'; readonly words: readonly string[]; readonly reason: string };

/**
 * The Uzbek-only second guard, applied BEFORE the general one when the route is Uzbek.
 *
 * The rule: a polish may reorder, requote, capitalise, punctuate and DELETE words, but
 * it may not INTRODUCE a word absent from the input. It exists because the general
 * guard accepts a rewrite of identical length and script — 7 of 14 real polishes of
 * real Uzbek changed words the speaker did not say, and the general guard caught 1.
 *
 * Word splits are allowed (a word of 3+ characters that is a strict substring of an
 * original), which is why "bir-ikki" out of "birikki" passes.
 */
export const UZBEK_GUARD_MINIMUM_SPLIT_LENGTH = 3;

/** How many invented words the rejection sentence names before it stops. */
export const UZBEK_GUARD_NAMED_WORDS = 5;

/**
 * The apostrophe-family scalars that all fold to the okina U+02BB before comparison, so
 * an apostrophe swap is free. Deliberately does NOT lowercase or strip punctuation —
 * that would discard the capitals and full stops a polish was asked to add.
 */
export const APOSTROPHE_FAMILY: readonly string[] = [
  "'",
  '‘',
  '’',
  '`',
  '´',
  'ʼ',
  'ʻ',
  'ʹ',
  '′',
  'ʽ',
];

/** The request shape sent to an OpenAI-compatible endpoint. Not settings-persisted. */
export interface PolishConfiguration {
  readonly stream: boolean;
  readonly maxTokens: number;
  readonly temperature: number;
}

export const DEFAULT_POLISH_CONFIGURATION: PolishConfiguration = {
  stream: true,
  maxTokens: 1024,
  temperature: 0.2,
};

/** The completions path appended to a trimmed base URL. */
export const POLISH_COMPLETIONS_PATH = '/chat/completions';

/**
 * One member of the polish chain.
 *
 * `supportedLanguages` is a claim the member makes about itself, and the session SKIPS
 * a member that does not claim the routed language. That is the whole implementation of
 * `polishUzbek: false` — it removes `uz` from the client's set and needs no extra
 * control flow. A port that routes around the claim loses the protection silently.
 */
export interface Polisher {
  /** Stable and recorded as `polishID` in diagnostics. */
  readonly id: string;
  readonly supportedLanguages: ReadonlySet<Language>;
  polish(text: string, language: Language, instructions: string): Promise<string>;
}
