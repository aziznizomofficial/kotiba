// C4 in the shell: when Arabic may fetch, where its speed-check verdict lives, what onboarding
// pre-ticks, what the Arabic card says, and what a launch resumes.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type Settings } from '../../src/contracts/index.js';
import { setAppLanguage } from '../../src/core/i18n/index.js';
import { arabicBackend, arabicMayDownload, speedCheckFileStore } from '../../src/main/arabic-wiring.js';
import { launchResume } from '../../src/main/downloads-model.js';
import {
  arabicEngineLine,
  arabicReasonLine,
  optionalLanguagesPreset,
  type ArabicSnapshot,
} from '../../src/main/languages-model.js';
import { SETTINGS_WITHOUT_CONTROLS, appSections } from '../../src/main/settings-model.js';

const settings = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

let dir = '';
afterEach(async () => {
  setAppLanguage('en');
  if (dir !== '') await rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('Arabic may fetch once it is on (D-W25: turning it on is the yes)', () => {
  it('onboarding over and Arabic on — no separate acceptance', () => {
    const all = settings({ onboardingCompleted: true, enabledLanguages: ['en', 'ru', 'uz', 'ar'], acceptedDownloads: [] });
    expect(arabicMayDownload(all)).toBe(true);
    expect(arabicMayDownload({ ...all, onboardingCompleted: false })).toBe(false);
    expect(arabicMayDownload({ ...all, enabledLanguages: ['en', 'ru', 'uz', 'tr'] })).toBe(false);
  });

  it('the GPU switch is transcribe.cpp’s backend', () => {
    expect(arabicBackend(settings({ whisperUseGPU: true }))).toBe('auto');
    expect(arabicBackend(settings({ whisperUseGPU: false }))).toBe('cpu');
  });

  it('Arabic on fetches all it needs — Cohere, turbo, Gemma — and only while it is on', () => {
    const base = { onboardingCompleted: true, present: (id: string) => id !== 'cohere_arabic' && id !== 'large_v3_turbo' && id !== 'gemma4_e2b_ar' };
    expect(launchResume({ ...base, enabledLanguages: ['en', 'ru', 'uz', 'ar'] })).toEqual(['large_v3_turbo', 'cohere_arabic', 'gemma4_e2b_ar']);
    expect(launchResume({ ...base, enabledLanguages: ['en', 'ru', 'uz', 'tr'] })).toEqual(['large_v3_turbo']);
    expect(launchResume({ ...base, enabledLanguages: ['en', 'ru', 'uz'] })).toEqual([]);
  });
});

describe('the speed-check verdict on disk', () => {
  it('round-trips, and anything unreadable reads as never checked', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kotiba-speed-'));
    const path = join(dir, 'models', 'arabic-speed-check.json');
    const store = speedCheckFileStore(path);
    expect(await store.read()).toBeNull();
    const verdict = {
      milliseconds: 580,
      thresholdMs: 300,
      slow: true,
      device: 'CPU',
      backend: 'auto' as const,
      clipSeconds: 3,
      measuredAt: '2026-09-30T12:00:00.000Z',
    };
    await store.write(verdict);
    expect(await store.read()).toEqual(verdict);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(verdict);
    await writeFile(path, '{"milliseconds":"fast"}');
    expect(await store.read()).toBeNull();
    await writeFile(path, 'not json');
    expect(await store.read()).toBeNull();
  });
});

describe('onboarding pre-ticks an optional language only for a system in it', () => {
  it('reads the FIRST preferred language only', () => {
    expect(optionalLanguagesPreset(['tr-TR', 'en-US'])).toEqual(['tr']);
    expect(optionalLanguagesPreset(['ar'])).toEqual(['ar']);
    expect(optionalLanguagesPreset(['ar-EG'])).toEqual(['ar']);
    expect(optionalLanguagesPreset(['en-US', 'tr-TR'])).toEqual([]);
    expect(optionalLanguagesPreset(['uz-Latn-UZ'])).toEqual([]);
    expect(optionalLanguagesPreset(['tt-RU'])).toEqual([]);
    expect(optionalLanguagesPreset([])).toEqual([]);
  });
});

describe('the Arabic card says which engine and why', () => {
  const base: ArabicSnapshot = {
    choice: 'auto',
    wanted: 'cohere',
    active: 'cohere',
    reason: 'speedCheckFast',
    device: 'Vulkan (Radeon)',
    speedCheck: { milliseconds: 210, thresholdMs: 300, slow: false, device: 'Vulkan (Radeon)', measuredAt: '' },
    cohere: { kind: 'loaded' },
    fastConformer: { kind: 'notDownloaded' },
  };

  it('names the engine and what it runs on — whisper before anything is loaded', () => {
    expect(arabicEngineLine(base)).toBe('Cohere Transcribe Arabic · Vulkan (Radeon)');
    expect(arabicEngineLine({ ...base, active: null })).toBe('whisper large-v3-turbo');
    expect(arabicEngineLine(null)).toBe('whisper large-v3-turbo');
  });

  it('gives the speed check’s numbers, both ways, and a manual pick as a pick', () => {
    expect(arabicReasonLine(base)).toContain('210 ms');
    const slow: ArabicSnapshot = {
      ...base,
      wanted: 'fastConformer',
      active: 'fastConformer',
      reason: 'speedCheckSlow',
      device: 'CPU',
      speedCheck: { ...base.speedCheck!, milliseconds: 580, slow: true, device: 'CPU' },
    };
    expect(arabicReasonLine(slow)).toMatch(/580 ms.*300 ms.*FastConformer/su);
    expect(arabicReasonLine({ ...base, reason: 'chosen', wanted: 'fastConformer' })).toContain('NVIDIA FastConformer Arabic');
    expect(arabicReasonLine({ ...base, reason: 'fallbackWhileLoading', wanted: 'fastConformer' })).toContain('Switching');
  });

  it('is localised', () => {
    setAppLanguage('ru');
    expect(arabicReasonLine(base)).toContain('Проверка скорости пройдена');
    setAppLanguage('uz-Cyrl');
    expect(arabicReasonLine(base)).toContain('Тезлик');
  });
});

describe('the Languages page binds both new settings', () => {
  it('enabledLanguages and arabicEngine are rendered by the page, not left unbound', () => {
    const languages = appSections().find((section) => section.id === 'languages');
    const keys = JSON.stringify(languages);
    expect(keys).toContain('enabledLanguages');
    expect(keys).toContain('arabicEngine');
    expect(SETTINGS_WITHOUT_CONTROLS).not.toContain('enabledLanguages');
  });

  it('the fallback-language picker offers the three core languages only', () => {
    const languages = appSections().find((section) => section.id === 'languages');
    expect(JSON.stringify(languages)).not.toMatch(/"value":"(tr|ar)"/u);
  });
});
