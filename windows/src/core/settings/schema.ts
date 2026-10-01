// The zod schema, ONE VALIDATOR PER KEY.
//
// PURE. zod is data validation, not an operating system.
//
// It is per-key and not one big object on purpose: that is what makes the salvage in
// `./parse.ts` a per-key validity test rather than an all-or-nothing decode. macOS gets
// the same property for free because every field of its `Snapshot` mirror struct is
// Optional, so a one-key JSON object is a valid Snapshot; here it has to be built.

import { z } from 'zod';

import { ARABIC_ENGINE_CHOICES, DOWNLOADABLE_MODELS, LANGUAGES, type Settings } from '../../contracts/index.js';

const language = z.enum(LANGUAGES);

/**
 * `Replacement` — all four keys REQUIRED, matching the synthesised Swift Codable.
 *
 * A malformed rule therefore drops the WHOLE `replacements` key, not just that rule.
 * That is macOS's behaviour and it is deliberate: a half-applied replacement set
 * silently rewrites the user's words differently from how they configured it.
 */
const replacement = z.object({
  find: z.string(),
  replaceWith: z.string(),
  matchCase: z.boolean(),
  wholeWord: z.boolean(),
});

const hotkey = z.object({
  vk: z.number().int().min(0).max(0xff),
  label: z.string(),
});

/**
 * A validator for every settings key. The keys of this object ARE the schema: a field
 * added to `Settings` and forgotten here is a compile error, not a silent data loss —
 * which is the failure macOS's `snapshotIsComplete` test exists to catch by hand.
 */
export const SETTINGS_FIELD_SCHEMAS = {
  defaultLanguage: language,
  /** Nullable, and `null` is a MEANING (Automatic), not an absence. See `./parse.ts`. */
  pinnedLanguage: language.nullable(),
  uzbekModelPath: z.string(),
  russianModelPath: z.string(),
  whisperUseGPU: z.boolean(),
  whisperBeamSize: z.number().int(),
  preloadAllLanguages: z.boolean(),
  detectorModelPath: z.string(),
  turkicThreshold: z.number().finite(),
  silenceThreshold: z.number().finite(),
  soundFeedback: z.boolean(),
  vocabulary: z.record(z.string(), z.array(z.string())),
  replacements: z.array(replacement),
  autoCapitalise: z.boolean(),
  defaultModeKey: z.string(),
  modeFollowsApp: z.boolean(),
  polishEnabled: z.boolean(),
  preferOnDeviceModel: z.boolean(),
  polishUzbek: z.boolean(),
  polishBaseURL: z.string(),
  polishModel: z.string(),
  polishFallbackModel: z.string(),
  polishKeyAccount: z.string(),
  polishTimeoutSeconds: z.number().finite(),
  keepHistory: z.boolean(),
  historyLimit: z.number().int(),
  diagnosticsEnabled: z.boolean(),
  hotkey,
  fastEnglish: z.boolean(),
  launchAtLogin: z.boolean(),
  onboardingCompleted: z.boolean(),
  alwaysOn: z.boolean(),
  // An id this build does not know (a newer build's) makes the whole list unreadable and it
  // falls back to [] — nothing is downloaded that the user has not accepted in THIS build.
  acceptedDownloads: z.array(z.enum(DOWNLOADABLE_MODELS)),
  duckingEnabled: z.boolean(),
  // Clamped on write by the pane; a stored value outside 0…1 is unreadable, not clamped,
  // because a duck "to 300%" is a louder machine, never a quieter one.
  duckLevel: z.number().finite().min(0).max(1),
  // Any string: an id this build does not know resolves as "follow the system" (core/i18n),
  // which is better than dropping the key and forgetting the choice for a newer build.
  appLanguage: z.string(),
  // Any string, for the same reason: an unknown style resolves to the default when drawn.
  pillStyle: z.string(),
  statsPeriod: z.string(),
  // An unknown code (a newer build's language) makes the list unreadable and it falls back to
  // the default three. Never empty: an empty list is unreadable too (at least one stays on).
  enabledLanguages: z.array(language).min(1),
  turkishDictations: z.number().int().min(0),
  arabicDictations: z.number().int().min(0),
  arabicEngine: z.enum(ARABIC_ENGINE_CHOICES),
} as const satisfies { [K in keyof Settings]: z.ZodType<Settings[K]> };

/** Every settings key, in declaration order. */
export const SETTINGS_FIELD_NAMES = Object.keys(SETTINGS_FIELD_SCHEMAS) as (keyof Settings)[];

// THERE IS DELIBERATELY NO WHOLE-BLOB SCHEMA.
//
// macOS decodes the whole `Snapshot` first and only falls back to the per-key loop when
// that throws — two code paths, because Swift's Codable is atomic and the fast one is
// free. Here the per-key loop IS the only path. It produces the same answer for a
// well-formed file (nothing dropped, no failure) at a cost measured in microseconds on
// 32 keys, and one path cannot drift from the other. A whole-blob schema would also
// have to be `.loose()` — an unknown key from a newer build is not a failure — which
// makes it a strictly weaker check than the loop it was meant to short-circuit.

/** Validate ONE key alone. Used by the salvage loop; never throws. */
export function validateSettingsField(
  key: keyof Settings,
  value: unknown,
): { readonly ok: true; readonly value: Settings[keyof Settings] } | { readonly ok: false } {
  const parsed = SETTINGS_FIELD_SCHEMAS[key].safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data as Settings[keyof Settings] } : { ok: false };
}

/** Is this a key the current build knows? An unknown key is tolerated, never dropped. */
export function isSettingsKey(key: string): key is keyof Settings {
  return Object.prototype.hasOwnProperty.call(SETTINGS_FIELD_SCHEMAS, key);
}
