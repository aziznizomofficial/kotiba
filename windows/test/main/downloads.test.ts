// Model downloads (D-W25, superseding D-W23's checklist): the core fetched for everyone once
// onboarding is over, an optional language's files the moment it is turned on, the readiness
// card's one bar, and the "still downloading" a press says before an engine lands.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUNDLE_CATALOGUE, DEFAULT_SETTINGS, bundleBytes } from '../../src/contracts/index.js';
import { validateSettingsField } from '../../src/core/settings/index.js';
import {
  CORE_DOWNLOADS,
  DOWNLOAD_COPY,
  DOWNLOADABLE_MODELS,
  LANGUAGE_DOWNLOADS,
  bundleRowState,
  coreReadiness,
  degradedNotes,
  gettingReadyPercent,
  languageDownloadBytes,
  launchResume,
  megabytes,
  modelRowState,
  parseDownloadIds,
  uzbekRowState,
  wantedDownloads,
  withAccepted,
  type DownloadRow,
} from '../../src/main/downloads-model.js';
import { ONBOARDING_STEP_IDS } from '../../src/main/onboarding-model.js';

const PARAKEET = bundleBytes(BUNDLE_CATALOGUE.parakeet_ultra);
const QWEN = 1_282_439_264;
const TURBO = 574_041_195;


const all = (patch: Partial<Record<string, DownloadRow['state']>> = {}): DownloadRow[] =>
  DOWNLOADABLE_MODELS.map((id) => ({ id, state: patch[id] ?? (id === 'uzbek_stt_v1' ? { kind: 'included' } : { kind: 'notDownloaded' }) }));

describe('onboarding has no checklist', () => {
  it('goes from the languages straight to Always on', () => {
    expect(ONBOARDING_STEP_IDS).not.toContain('downloads' as never);
    expect(ONBOARDING_STEP_IDS.indexOf('alwaysOn')).toBe(ONBOARDING_STEP_IDS.indexOf('languages') + 1);
  });
});

describe('what is downloaded, and in what order', () => {
  it('the core first, then the optional languages’ files, with the catalogue’s sizes', () => {
    expect(DOWNLOADABLE_MODELS).toEqual(['parakeet_ultra', 'uzbek_stt_v1', 'qwen3_1_7b', 'large_v3_turbo', 'cohere_arabic', 'gemma4_e2b_ar']);
    expect(CORE_DOWNLOADS).toEqual(['parakeet_ultra', 'uzbek_stt_v1', 'qwen3_1_7b']);
    expect(DOWNLOAD_COPY.cohere_arabic.bytes).toBe(1_770_270_112);
    expect(DOWNLOAD_COPY.parakeet_ultra.bytes).toBe(PARAKEET);
    expect(DOWNLOAD_COPY.qwen3_1_7b.bytes).toBe(QWEN);
    expect(DOWNLOAD_COPY.uzbek_stt_v1.bytes).toBe(539_212_484);
    expect(DOWNLOAD_COPY.large_v3_turbo.bytes).toBe(TURBO);
    expect(DOWNLOAD_COPY.gemma4_e2b_ar.bytes).toBe(bundleBytes(BUNDLE_CATALOGUE.gemma4_e2b_ar));
  });

  it('Turkish brings turbo; Arabic brings Cohere, turbo and Gemma', () => {
    expect(LANGUAGE_DOWNLOADS.tr).toEqual(['large_v3_turbo']);
    expect([...LANGUAGE_DOWNLOADS.ar].sort()).toEqual(['cohere_arabic', 'gemma4_e2b_ar', 'large_v3_turbo']);
    expect(wantedDownloads(['uz', 'en', 'ru'])).toEqual(['parakeet_ultra', 'uzbek_stt_v1', 'qwen3_1_7b']);
    expect(wantedDownloads(['uz', 'tr'])).toEqual(['uzbek_stt_v1', 'qwen3_1_7b', 'large_v3_turbo']);
    expect(wantedDownloads(['en', 'ar'])).toEqual(['parakeet_ultra', 'qwen3_1_7b', 'large_v3_turbo', 'cohere_arabic', 'gemma4_e2b_ar']);
  });

  it('says, before turning it on, what a language would download — and nothing once it is here', () => {
    expect(languageDownloadBytes('tr', all())).toBe(TURBO);
    expect(megabytes(languageDownloadBytes('tr', all()))).toBe('574 MB');
    expect(languageDownloadBytes('ar', all())).toBe(TURBO + 1_770_270_112 + bundleBytes(BUNDLE_CATALOGUE.gemma4_e2b_ar));
    // Turkish already brought turbo: Arabic adds only its own two.
    expect(languageDownloadBytes('ar', all({ large_v3_turbo: { kind: 'installed' } }))).toBe(
      1_770_270_112 + bundleBytes(BUNDLE_CATALOGUE.gemma4_e2b_ar),
    );
    expect(languageDownloadBytes('en', all())).toBe(0);
  });

  it('says what Kotiba does until each missing model lands', () => {
    const notes = degradedNotes(all().filter((row) => CORE_DOWNLOADS.includes(row.id)));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/English and Russian wait for it/u);
    expect(notes[1]).toMatch(/modes run on their rules/u);
  });
});

describe('what is fetched without asking', () => {
  const nothingHere = (): boolean => false;

  it('nothing before onboarding is over', () => {
    expect(launchResume({ onboardingCompleted: false, enabledLanguages: ['uz', 'en', 'ru'], present: nothingHere })).toEqual([]);
  });

  it('the core after onboarding, with no acceptance at all (the setting still reads, and gates nothing)', () => {
    expect(DEFAULT_SETTINGS.acceptedDownloads).toEqual([]);
    expect(
      launchResume({ onboardingCompleted: true, enabledLanguages: ['uz', 'en', 'ru'], present: (id) => id === 'uzbek_stt_v1' }),
    ).toEqual(['parakeet_ultra', 'qwen3_1_7b']);
  });

  it('nothing already here, and nothing only an off language wants', () => {
    expect(launchResume({ onboardingCompleted: true, enabledLanguages: ['uz'], present: (id) => id === 'uzbek_stt_v1' })).toEqual([
      'qwen3_1_7b',
    ]);
    expect(launchResume({ onboardingCompleted: true, enabledLanguages: ['uz', 'en'], present: () => true })).toEqual([]);
  });

  it('keeps the accepted list canonical and refuses what the page cannot name', () => {
    expect(withAccepted(['qwen3_1_7b'], ['parakeet_ultra', 'qwen3_1_7b'])).toEqual(['parakeet_ultra', 'qwen3_1_7b']);
    expect(parseDownloadIds(['qwen3_1_7b', 'silero_vad', '../../etc', 7])).toEqual(['qwen3_1_7b']);
    expect(parseDownloadIds(['large_v3_turbo', 'gemma4_e2b_ar'])).toEqual(['large_v3_turbo', 'gemma4_e2b_ar']);
    expect(parseDownloadIds('parakeet_ultra')).toEqual([]);
  });

  it('a stored list naming an unknown model is unreadable, so it falls back to nothing', () => {
    expect(validateSettingsField('acceptedDownloads', ['parakeet_ultra']).ok).toBe(true);
    expect(validateSettingsField('acceptedDownloads', ['parakeet_ultra', 'gemma']).ok).toBe(false);
  });
});

describe('Getting Kotiba ready', () => {
  const core = ['uz', 'en', 'ru'];

  it('one bar over the core, the size still to come, gone once it is here', () => {
    const fresh = coreReadiness(all(), core);
    expect(fresh).toEqual({ remainingBytes: PARAKEET + QWEN, fraction: 0, failed: null });
    expect(megabytes(fresh?.remainingBytes ?? 0)).toBe('1.95 GB');
    const half = coreReadiness(all({ parakeet_ultra: { kind: 'installed' }, qwen3_1_7b: { kind: 'downloading', receivedBytes: QWEN / 2, totalBytes: QWEN } }), core);
    expect(half?.remainingBytes).toBe(QWEN / 2);
    expect(half?.fraction).toBeCloseTo((PARAKEET + QWEN / 2) / (PARAKEET + QWEN), 6);
    expect(coreReadiness(all({ parakeet_ultra: { kind: 'installed' }, qwen3_1_7b: { kind: 'installed' } }), core)).toBeNull();
  });

  it('an optional language’s files are not on this card (its own rows show them)', () => {
    const done = all({ parakeet_ultra: { kind: 'installed' }, qwen3_1_7b: { kind: 'installed' } });
    expect(coreReadiness(done, ['uz', 'en', 'ar'])).toBeNull();
  });

  it('a failure says why only when nothing else is still downloading', () => {
    const failed = all({ parakeet_ultra: { kind: 'failed', reason: 'HTTP 500' } });
    expect(coreReadiness(failed, core)?.failed).toBe('HTTP 500');
    const busy = all({ parakeet_ultra: { kind: 'failed', reason: 'x' }, qwen3_1_7b: { kind: 'downloading', receivedBytes: 1, totalBytes: QWEN } });
    expect(coreReadiness(busy, core)?.failed).toBeNull();
  });
});

describe('a press before its engine lands', () => {
  it('English and Russian say how far Parakeet has got; Uzbek is never waiting', () => {
    const rows = all({ parakeet_ultra: { kind: 'downloading', receivedBytes: PARAKEET * 0.42, totalBytes: PARAKEET } });
    expect(gettingReadyPercent('en', rows, new Set())).toBe(42);
    expect(gettingReadyPercent('ru', rows, new Set())).toBe(42);
    expect(gettingReadyPercent('uz', rows, new Set())).toBeNull();
  });

  it('queued counts as 0 %; failed, here, or never asked for is not "getting ready"', () => {
    expect(gettingReadyPercent('en', all(), new Set(['parakeet_ultra']))).toBe(0);
    expect(gettingReadyPercent('en', all(), new Set())).toBeNull();
    expect(gettingReadyPercent('en', all({ parakeet_ultra: { kind: 'installed' } }), new Set(['parakeet_ultra']))).toBeNull();
  });

  it('Turkish waits for turbo; Arabic for Cohere and turbo together', () => {
    const rows = all({ large_v3_turbo: { kind: 'downloading', receivedBytes: TURBO, totalBytes: TURBO } });
    expect(gettingReadyPercent('tr', rows, new Set())).toBe(99);
    expect(gettingReadyPercent('ar', rows, new Set(['cohere_arabic']))).toBe(
      Math.floor((100 * TURBO) / (TURBO + 1_770_270_112)),
    );
  });
});

describe('the rows', () => {
  it('reads a bundle’s state as a row', () => {
    expect(bundleRowState({ kind: 'loaded' })).toEqual({ kind: 'installed' });
    expect(bundleRowState({ kind: 'downloading', receivedBytes: 5, totalBytes: 10 })).toEqual({
      kind: 'downloading',
      receivedBytes: 5,
      totalBytes: 10,
    });
  });

  it('turbo: on this PC, on its way, failed, or not downloaded — never "included"', () => {
    expect(modelRowState({ status: 'ready', downloading: null, error: null })).toEqual({ kind: 'installed' });
    expect(modelRowState({ status: 'notInstalled', downloading: { receivedBytes: 1, totalBytes: 2 }, error: null }).kind).toBe('downloading');
    expect(modelRowState({ status: 'notInstalled', downloading: null, error: 'HTTP 404' })).toEqual({ kind: 'failed', reason: 'HTTP 404' });
    expect(modelRowState({ status: 'notInstalled', downloading: null, error: null })).toEqual({ kind: 'notDownloaded' });
  });

  it('Uzbek: included from the installer, installed from a download, and never a 404 button', () => {
    const base = { downloadable: false, downloading: null, error: null } as const;
    expect(uzbekRowState({ ...base, status: 'ready', inInstaller: true })).toEqual({ kind: 'included' });
    expect(uzbekRowState({ ...base, status: 'ready', inInstaller: false })).toEqual({ kind: 'installed' });
    expect(uzbekRowState({ ...base, status: 'notInstalled', inInstaller: false }).kind).toBe('unavailable');
    expect(uzbekRowState({ ...base, status: 'notInstalled', inInstaller: false, downloadable: true }).kind).toBe('notDownloaded');
  });
});

describe('the wiring', () => {
  const index = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8');
  const onboarding = readFileSync(join(__dirname, '../../src/renderer/onboarding.ts'), 'utf8');
  const usage = readFileSync(join(__dirname, '../../src/renderer/pages/usage.ts'), 'utf8');

  it('launch, the end of onboarding and every language change fetch what is wanted', () => {
    expect(index).toContain('.then(() => resumeDownloads(state))');
    expect(index).toMatch(/onboardingCompleted: true, alwaysOn[\s\S]*resumeDownloads\(state\)/u);
    expect(index).toContain("if (key === 'enabledLanguages') resumeDownloads(state);");
    expect(index).toMatch(/autoDownload: \(\) => state\.settings\.onboardingCompleted,/u);
  });

  it('onboarding starts the chosen languages’ downloads; onboarding and Home draw the readiness card', () => {
    expect(onboarding).toContain('IPC_INVOKE.downloadsAccept, wantedDownloads(next)');
    expect(onboarding).toContain('readinessCard(scope, retry)');
    expect(usage).toContain('readinessCard(scope');
    expect(index).toContain('ipcMain.handle(IPC_INVOKE.downloadsAccept');
  });

  it('a press for a language still downloading is told how far it has got', () => {
    expect(index).toContain('gettingReady: (language) => gettingReadyPercent(language, downloadRows(state), state.queued)');
  });
});
