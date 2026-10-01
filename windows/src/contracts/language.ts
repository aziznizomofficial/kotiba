// The languages Kotiba dictates, and the engine families they route to.
//
// Ported from Sources/KotibaCore/Contracts.swift:13-33. Nothing here has an opinion
// about how a language is detected — that is src/core/routing.
//
// Turkish and Arabic (C4) are OPTIONAL DICTATION languages, never app-UI languages: the UI
// language is `AppLanguage` in src/core/i18n and stays en / ru / uz-Latn / uz-Cyrl. They are
// off until the user turns them on in the Languages page (`Settings.enabledLanguages`, where any
// of the five can be turned off).

/** No unknown case. The raw values are the JSON wire format. */
export const LANGUAGES = ['en', 'ru', 'uz', 'tr', 'ar'] as const;

/** The three the app exists for, always on. `tr` and `ar` are opt-in (C4 §9.6). */
export const CORE_LANGUAGES = ['en', 'ru', 'uz'] as const;
/** The dictation languages a user turns on. Off by default (unless Windows itself is tr/ar). */
export const OPTIONAL_LANGUAGES = ['tr', 'ar'] as const;
export type OptionalLanguage = (typeof OPTIONAL_LANGUAGES)[number];

export function isOptionalLanguage(value: unknown): value is OptionalLanguage {
  return typeof value === 'string' && (OPTIONAL_LANGUAGES as readonly string[]).includes(value);
}

/**
 * `en` | `ru` | `uz` | `tr` | `ar`, in `allCases` order.
 *
 * Having no unknown case is deliberate and load-bearing: a settings blob written by a
 * future build that knows a fourth language is *unreadable* for that one key, which is
 * exactly what the per-key salvage in SettingsStore exists to contain.
 */
export type Language = (typeof LANGUAGES)[number];

/** Type guard, so a string off disk can become a `Language` without a cast. */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Which engine family a language belongs to. English and Russian share ONE (Parakeet decides
 * between them inside its decoder), so for the three core languages the router's job is one
 * bit. Turkish and Arabic each have their own (C4 §0):
 *
 *   * `turkish` — whisper large-v3-turbo q5_0, downloaded when Turkish (or Arabic) is turned on
 *     (D-W25), streamed through `kotiba-stt` exactly as Uzbek is.
 *   * `arabic`  — Cohere Transcribe Arabic through transcribe.cpp, or NVIDIA's FastConformer
 *     on a PC the first-run speed check finds too slow for it (`src/engines/arabic.ts`).
 */
export const ENGINE_FAMILIES = ['unified', 'uzbek', 'turkish', 'arabic'] as const;
export type EngineFamily = (typeof ENGINE_FAMILIES)[number];

/** `uz` → `uzbek`, `tr` → `turkish`, `ar` → `arabic`; English and Russian → `unified`. */
export function engineFamilyFor(language: Language): EngineFamily {
  switch (language) {
    case 'uz':
      return 'uzbek';
    case 'tr':
      return 'turkish';
    case 'ar':
      return 'arabic';
    case 'en':
    case 'ru':
      return 'unified';
  }
}
