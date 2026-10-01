// Every dictation language's on/off (`Settings.enabledLanguages`, the Mac's `LanguageSubset`):
// the migration from the two keys it replaced, the rules that keep a pin and the fallback inside
// the set, and the pure helpers the Languages page and onboarding read.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/contracts/index.js';
import { parseSettings, settleLanguages } from '../../src/core/settings/index.js';
import { detectionWanted } from '../../src/core/settings/models.js';
import { removableModelFiles } from '../../src/main/languages-model.js';
import { downloadWanted } from '../../src/main/downloads-model.js';
import { effectivePin, pinFor } from '../../src/session/controller.js';

describe('enabledLanguages', () => {
  it('defaults to Uzbek, English and Russian, as on the Mac', () => {
    expect(DEFAULT_SETTINGS.enabledLanguages).toEqual(['en', 'ru', 'uz']);
  });

  it('migrates optionalLanguages to the core three plus those', () => {
    expect(parseSettings({ optionalLanguages: ['ar'] }).settings.enabledLanguages).toEqual(['en', 'ru', 'uz', 'ar']);
    expect(parseSettings({ optionalLanguages: [] }).settings.enabledLanguages).toEqual(['en', 'ru', 'uz']);
    // A blob that already has the new key keeps it.
    expect(parseSettings({ optionalLanguages: ['tr'], enabledLanguages: ['en'] }).settings.enabledLanguages).toEqual(['en']);
    // Neither key is reported as dropped: the old one is a newer-build-style unknown key.
    expect(parseSettings({ optionalLanguages: ['tr'] }).dropped).toEqual([]);
  });

  it('migrates auto-detect off to a pin on the default language', () => {
    expect(parseSettings({ autoDetectLanguage: false, defaultLanguage: 'uz' }).settings.pinnedLanguage).toBe('uz');
    expect(parseSettings({ autoDetectLanguage: false, pinnedLanguage: 'ru' }).settings.pinnedLanguage).toBe('ru');
    expect(parseSettings({ autoDetectLanguage: true }).settings.pinnedLanguage).toBeNull();
  });

  it('never loads empty, and keeps the pin and the default inside the set', () => {
    expect(parseSettings({ enabledLanguages: [] }).settings.enabledLanguages).toEqual(['en', 'ru', 'uz']);
    const settled = parseSettings({ enabledLanguages: ['ru', 'en'], pinnedLanguage: 'uz', defaultLanguage: 'uz' }).settings;
    expect(settled.enabledLanguages).toEqual(['en', 'ru']);
    expect(settled.pinnedLanguage).toBeNull();
    expect(settled.defaultLanguage).toBe('en');
    expect(settleLanguages({ ...DEFAULT_SETTINGS, enabledLanguages: ['tr'], defaultLanguage: 'en' }).defaultLanguage).toBe('tr');
  });
});

describe('no detection with one family on', () => {
  it('one language, or English and Russian alone, needs no detector and no pin', () => {
    expect(detectionWanted({ ...DEFAULT_SETTINGS, enabledLanguages: ['en'] })).toBe(false);
    expect(detectionWanted({ ...DEFAULT_SETTINGS, enabledLanguages: ['en', 'ru'] })).toBe(false);
    expect(detectionWanted({ ...DEFAULT_SETTINGS, enabledLanguages: ['uz', 'en'] })).toBe(true);
    // The router routes there itself (source `only`), so the press is not pinned.
    expect(pinFor({ ...DEFAULT_SETTINGS, enabledLanguages: ['en', 'ru'] }, false)).toBeNull();
    // A pin on a language that is off is not a pin.
    expect(pinFor({ ...DEFAULT_SETTINGS, enabledLanguages: ['uz', 'en'], pinnedLanguage: 'ru' }, true)).toBeNull();
    // Without a detector, the fallback inside the set.
    expect(pinFor({ ...DEFAULT_SETTINGS, enabledLanguages: ['uz', 'tr'], defaultLanguage: 'en' }, false)).toBe('uz');
  });

  it('a mode pinned to a language that is off does not route there', () => {
    const mode = { language: 'ru' } as Parameters<typeof effectivePin>[0];
    expect(effectivePin(mode, { ...DEFAULT_SETTINGS, enabledLanguages: ['uz', 'en'] }, true)).toBeNull();
    expect(effectivePin(mode, DEFAULT_SETTINGS, true)).toBe('ru');
  });
});

describe('removing a language’s model files', () => {
  it('offers only files no language that is on still uses', () => {
    // Parakeet stays while Russian is on; turbo (D-W25: Turkish's and Arabic's) while either is.
    expect(removableModelFiles('en', ['ru', 'uz'])).toEqual([{ kind: 'model', id: 'small_en' }]);
    expect(removableModelFiles('en', ['uz'])).toEqual([
      { kind: 'bundle', id: 'parakeet_ultra' },
      { kind: 'model', id: 'small_en' },
    ]);
    expect(removableModelFiles('tr', ['uz', 'en', 'ru'])).toEqual([{ kind: 'model', id: 'large_v3_turbo' }]);
    expect(removableModelFiles('tr', ['uz', 'ar'])).toEqual([]);
    expect(removableModelFiles('uz', ['en'])).toEqual([{ kind: 'model', id: 'uzbek_stt_v1' }]);
    expect(removableModelFiles('ar', ['tr']).map((file) => file.id)).toEqual(['cohere_arabic', 'fastconformer_ar', 'gemma4_e2b_ar']);
    expect(removableModelFiles('ar', ['uz']).map((file) => file.id)).toContain('large_v3_turbo');
    // Nothing while it is on.
    expect(removableModelFiles('uz', ['uz', 'en'])).toEqual([]);
  });

  it('downloads follow the languages', () => {
    expect(downloadWanted('parakeet_ultra', ['uz'])).toBe(false);
    expect(downloadWanted('parakeet_ultra', ['ru'])).toBe(true);
    expect(downloadWanted('uzbek_stt_v1', ['en'])).toBe(false);
    expect(downloadWanted('cohere_arabic', ['ar'])).toBe(true);
    expect(downloadWanted('qwen3_1_7b', ['en'])).toBe(true);
    // D-W25: turbo with Turkish or Arabic, never for English or Russian; Gemma with Arabic.
    expect(downloadWanted('large_v3_turbo', ['en', 'ru', 'uz'])).toBe(false);
    expect(downloadWanted('large_v3_turbo', ['tr'])).toBe(true);
    expect(downloadWanted('large_v3_turbo', ['ar'])).toBe(true);
    expect(downloadWanted('gemma4_e2b_ar', ['tr'])).toBe(false);
    expect(downloadWanted('gemma4_e2b_ar', ['ar'])).toBe(true);
  });
});
