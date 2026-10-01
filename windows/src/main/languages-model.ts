// Turkish and Arabic in the window, as data (C4). PURE — the Languages page's two cards, the
// onboarding rows and the tray all read what is here, so they cannot disagree about what is on,
// what it costs, or which Arabic engine is serving and why.

import {
  OPTIONAL_LANGUAGES,
  type ArabicEngineChoice,
  type BundleState,
  type Language,
  type OptionalLanguage,
} from '../contracts/index.js';
import { t } from '../core/i18n/index.js';

/** What the window is told about Arabic's engine. `ArabicEngineStatus`, as it crosses IPC. */
export interface ArabicSnapshot {
  readonly choice: ArabicEngineChoice;
  readonly wanted: 'cohere' | 'fastConformer';
  readonly active: 'cohere' | 'fastConformer' | null;
  readonly reason: 'chosen' | 'speedCheckFast' | 'speedCheckSlow' | 'notChecked' | 'fallbackWhileLoading';
  readonly device: string | null;
  readonly speedCheck: {
    readonly milliseconds: number;
    readonly thresholdMs: number;
    readonly slow: boolean;
    readonly device: string;
    readonly measuredAt: string;
  } | null;
  readonly cohere: BundleState;
  readonly fastConformer: BundleState;
}

/**
 * Onboarding pre-ticks an optional language only when the system itself is in it: a Turkish or
 * Arabic Windows is the one signal that the person dictates in it. `locales` is the preference
 * list, best first (`navigator.languages`); only the FIRST counts — a Turkish entry far down a
 * list is somebody's keyboard layout, not their language.
 */
export function optionalLanguagesPreset(locales: readonly string[]): OptionalLanguage[] {
  const first = (locales[0] ?? '').toLowerCase();
  return OPTIONAL_LANGUAGES.filter((code) => first === code || first.startsWith(`${code}-`));
}

export const ARABIC_ENGINE_NAMES = {
  cohere: 'Cohere Transcribe Arabic',
  fastConformer: 'NVIDIA FastConformer Arabic',
  whisper: 'whisper large-v3-turbo',
} as const;

/** The Arabic card's engine line: what serves right now, and on what. */
export function arabicEngineLine(status: ArabicSnapshot | null): string {
  if (status === null || status.active === null) return ARABIC_ENGINE_NAMES.whisper;
  const name = ARABIC_ENGINE_NAMES[status.active];
  return status.device === null ? name : `${name} · ${status.device}`;
}

/** The Arabic card's one sentence: why this engine — the owner's "which one is active". */
export function arabicReasonLine(status: ArabicSnapshot | null): string {
  if (status === null) return t('lang.ar.reason.whisper');
  const check = status.speedCheck;
  switch (status.reason) {
    case 'chosen':
      return t('lang.ar.reason.chosen', { engine: ARABIC_ENGINE_NAMES[status.wanted] });
    case 'speedCheckFast':
      return check === null
        ? t('lang.ar.reason.notChecked')
        : t('lang.ar.reason.fast', { ms: String(check.milliseconds), threshold: String(check.thresholdMs), device: check.device });
    case 'speedCheckSlow':
      return check === null
        ? t('lang.ar.reason.notChecked')
        : t('lang.ar.reason.slow', { ms: String(check.milliseconds), threshold: String(check.thresholdMs), device: check.device });
    case 'fallbackWhileLoading':
      return t('lang.ar.reason.switching', { engine: ARABIC_ENGINE_NAMES[status.wanted] });
    case 'notChecked':
      return status.active === null ? t('lang.ar.reason.whisper') : t('lang.ar.reason.notChecked');
  }
}

/** The engine picker's options, Automatic first. */
export function arabicChoiceOptions(): readonly { readonly value: ArabicEngineChoice; readonly label: string }[] {
  return [
    { value: 'auto', label: t('lang.ar.choice.auto') },
    { value: 'cohere', label: 'Cohere' },
    { value: 'fastConformer', label: 'FastConformer' },
  ];
}

// ---- Removing a language's model files (the Mac's `LanguageModelFile`) ----------------------

/**
 * A model file on disk by the dictation languages it serves. Files are shared: Parakeet is
 * English and Russian; whisper turbo is Turkish's engine and Arabic's head and fallback (D-W25: it
 * is downloaded with them, so it goes with them — English and Russian are Parakeet's, and turbo
 * stands behind them only while it happens to be here); Fast English is English's. A file is
 * offered for removal only when no language that is on still uses it.
 */
export type LanguageModelFile =
  | { readonly kind: 'model'; readonly id: 'uzbek_stt_v1' | 'large_v3_turbo' | 'small_en' }
  | { readonly kind: 'bundle'; readonly id: 'parakeet_ultra' | 'cohere_arabic' | 'fastconformer_ar' | 'gemma4_e2b_ar' };

const LANGUAGE_MODEL_FILES: readonly { readonly file: LanguageModelFile; readonly languages: readonly Language[] }[] = [
  { file: { kind: 'bundle', id: 'parakeet_ultra' }, languages: ['en', 'ru'] },
  { file: { kind: 'model', id: 'uzbek_stt_v1' }, languages: ['uz'] },
  { file: { kind: 'model', id: 'large_v3_turbo' }, languages: ['tr', 'ar'] },
  { file: { kind: 'model', id: 'small_en' }, languages: ['en'] },
  { file: { kind: 'bundle', id: 'cohere_arabic' }, languages: ['ar'] },
  { file: { kind: 'bundle', id: 'fastconformer_ar' }, languages: ['ar'] },
  { file: { kind: 'bundle', id: 'gemma4_e2b_ar' }, languages: ['ar'] },
];

/** The files `language` is off and alone in using, while `enabled` are on. Empty while it is on. */
export function removableModelFiles(language: Language, enabled: readonly Language[]): LanguageModelFile[] {
  if (enabled.includes(language)) return [];
  return LANGUAGE_MODEL_FILES.filter(
    (entry) => entry.languages.includes(language) && !entry.languages.some((each) => enabled.includes(each)),
  ).map((entry) => entry.file);
}
