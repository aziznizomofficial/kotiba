// The dictation languages the user dictates in — the Mac's `LanguageSubset`
// (Sources/KotibaCore/LanguageSubset.swift), ported rule for rule and pinned byte-exact by
// route.json › languageSubsets.
//
// Every one of the five can be turned off; at least one is always on. A language that is off is
// never routed to — not by the detector, not by Turkish's or Arabic's checks, not by a recovery
// after the fact — and costs nothing: no stream, no preload, no model kept warm.

import { CORE_LANGUAGES, LANGUAGES, engineFamilyFor, type EngineFamily, type Language } from '../../contracts/language.js';
import {
  TURKIC_CLUSTER,
  type LanguagePosterior,
  type LanguageSubset,
  type OptionalLanguageRules,
  type RouteDecision,
} from '../../contracts/routing.js';

export type { LanguageSubset };

export function languageSubset(languages: Iterable<Language>): LanguageSubset {
  const set = new Set<Language>();
  for (const language of languages) if ((LANGUAGES as readonly string[]).includes(language)) set.add(language);
  return { languages: set.size === 0 ? new Set<Language>(LANGUAGES) : set };
}

export const ALL_LANGUAGES: LanguageSubset = languageSubset(LANGUAGES);

/** Uzbek, English and Russian; Turkish or Arabic also when the system's own language is one. */
export function presetLanguages(systemLanguages: readonly string[]): LanguageSubset {
  const on = new Set<Language>(CORE_LANGUAGES);
  for (const code of systemLanguages) {
    const primary = (code.split(/[-_]/)[0] ?? '').toLowerCase();
    if (primary === 'tr') on.add('tr');
    if (primary === 'ar') on.add('ar');
  }
  return languageSubset(on);
}

export function subsetContains(subset: LanguageSubset, language: Language): boolean {
  return subset.languages.has(language);
}

export function isAllLanguages(subset: LanguageSubset): boolean {
  return subset.languages.size === LANGUAGES.length;
}

/** In `Language` order. */
export function orderedLanguages(subset: LanguageSubset): Language[] {
  return LANGUAGES.filter((language) => subset.languages.has(language));
}

export function subsetFamilies(subset: LanguageSubset): Set<EngineFamily> {
  return new Set([...subset.languages].map(engineFamilyFor));
}

/** The optional languages that are on (`tr`, `ar`). */
export function subsetOptional(subset: LanguageSubset): Set<Language> {
  return new Set([...subset.languages].filter((language) => language === 'tr' || language === 'ar'));
}

/** The last language on may not be turned off. */
export function canTurnOff(subset: LanguageSubset, language: Language): boolean {
  return !subset.languages.has(language) || subset.languages.size > 1;
}

/** The set with `language` turned on or off; turning the last one off returns it unchanged. */
export function settingLanguage(subset: LanguageSubset, language: Language, on: boolean): LanguageSubset {
  if (on) return languageSubset([...subset.languages, language]);
  if (!canTurnOff(subset, language)) return subset;
  return languageSubset([...subset.languages].filter((l) => l !== language));
}

/**
 * The route when there is nothing to detect: one language, or English and Russian alone (one
 * engine family; Parakeet settles en against ru itself). For en+ru: `preferring` when it is one
 * of them, else English.
 */
export function soleRoute(subset: LanguageSubset, preferring: Language = 'en'): Language | null {
  if (subsetFamilies(subset).size !== 1) return null;
  if (subset.languages.size === 1) return [...subset.languages][0]!;
  return subset.languages.has(preferring) ? preferring : 'en';
}

/** `preferred` when on, else the first on of Uzbek, English, Russian, Turkish, Arabic. */
export function subsetFallback(subset: LanguageSubset, preferred: Language): Language {
  if (subset.languages.has(preferred)) return preferred;
  for (const language of ['uz', 'en', 'ru', 'tr', 'ar'] as const) {
    if (subset.languages.has(language)) return language;
  }
  return 'en';
}

/**
 * Is a posterior code evidence for some language that is on? `en`/`ru`/`ar` are their own
 * language's; the Turkic cluster is Uzbek's or Turkish's; every other code stays.
 */
export function keepsCode(subset: LanguageSubset, code: string): boolean {
  switch (code) {
    case 'en':
      return subset.languages.has('en');
    case 'ru':
      return subset.languages.has('ru');
    case 'ar':
      return subset.languages.has('ar');
    default:
      if (TURKIC_CLUSTER.includes(code)) return subset.languages.has('uz') || subset.languages.has('tr');
      return true;
  }
}

/** The posterior without the evidence for languages that are off (renormalised by every share). */
export function restrictPosterior(subset: LanguageSubset, posterior: LanguagePosterior): LanguagePosterior {
  if (isAllLanguages(subset)) return posterior;
  const out: Record<string, number> = {};
  for (const [code, value] of Object.entries(posterior)) if (keepsCode(subset, code)) out[code] = value;
  return out;
}

/** Whether a recovery may move the route to `language`: only to one that is on. */
export function permits(subset: LanguageSubset, language: Language): boolean {
  return subset.languages.has(language);
}

function unifiedLabel(subset: LanguageSubset, base: RouteDecision): Language {
  if (subset.languages.has('en') && subset.languages.has('ru')) return base.language === 'ru' ? 'ru' : 'en';
  return subset.languages.has('ru') ? 'ru' : 'en';
}

/**
 * The acoustic tier restricted to the languages that are on — `LanguageSubset.decide`.
 * `decide` is `decideRoute` (passed in so this file has no import cycle with the router).
 */
export function decideInSubset(
  subset: LanguageSubset,
  posterior: LanguagePosterior,
  seconds: number,
  threshold: number,
  rules: OptionalLanguageRules,
  decide: (posterior: LanguagePosterior, seconds: number, threshold: number, rules: OptionalLanguageRules) => RouteDecision,
  preferring: Language = 'en',
): RouteDecision {
  const sole = soleRoute(subset, preferring);
  if (sole !== null) return { language: sole, family: engineFamilyFor(sole), source: 'only', turkicMass: null };
  if (isAllLanguages(subset)) return decide(posterior, seconds, threshold, rules);
  const optional = subsetOptional(subset);
  const on: OptionalLanguageRules = {
    ...rules,
    enabled: new Set([...rules.enabled].filter((language) => optional.has(language))),
  };
  const base = decide(restrictPosterior(subset, posterior), seconds, threshold, on);
  if (subset.languages.has(base.language)) return base;
  const has = (language: Language): boolean => subset.languages.has(language);
  let target: Language;
  switch (base.family) {
    case 'uzbek':
      target = has('tr') ? 'tr' : has('en') || has('ru') ? unifiedLabel(subset, base) : 'ar';
      break;
    case 'unified':
      if (has('en') || has('ru')) target = unifiedLabel(subset, base);
      else if (has('uz')) target = 'uz';
      else target = (base.arabicShare ?? 0) > (base.turkicMass ?? 0) || !has('tr') ? 'ar' : 'tr';
      break;
    case 'turkish':
    case 'arabic':
      target = subsetFallback(subset, 'uz');
      break;
  }
  const candidate = base.candidate !== undefined && base.candidate !== null && has(base.candidate) && base.candidate !== target ? base.candidate : null;
  return {
    language: target,
    family: engineFamilyFor(target),
    source: base.source,
    turkicMass: base.turkicMass,
    ...(base.turkishShare === undefined ? {} : { turkishShare: base.turkishShare }),
    ...(base.arabicShare === undefined ? {} : { arabicShare: base.arabicShare }),
    ...(candidate === null ? {} : { candidate }),
  };
}
