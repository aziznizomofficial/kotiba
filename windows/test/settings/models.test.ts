// The three-step model resolution.
//
// "Exists" here is ALWAYS the magic-number-and-size inspection, never a file-existence
// check — every test below injects a predicate that says so. With plain existence a
// half-finished download turns uzbekReady true, clears the blocker, shows a green tick,
// and the only feedback the user ever gets is whisper guessing at noise 7.8 s into a
// load, once per launch, forever.

import { describe, expect, it } from 'vitest';

import {
  KNOWN_MODEL_FILENAMES,
  WINDOWS_DEFAULT_SETTINGS,
  autoDetectReady,
  availableLanguages,
  resolveModelPath,
} from '../../src/core/settings/index.js';

const MODELS = 'C:\\Users\\aziz\\AppData\\Roaming\\Kotiba\\models';
const BUNDLED = 'C:\\Program Files\\Kotiba\\resources\\models';

/** A stand-in for `ModelFile.inspect(path).isUsable`. Only listed paths pass. */
function usable(paths: readonly string[]) {
  const set = new Set(paths);
  return (path: string) => set.has(path);
}

function resolve(options: {
  role?: 'uzbek' | 'russian' | 'detector' | 'fastEnglish';
  explicit?: string;
  present?: readonly string[];
}) {
  return resolveModelPath({
    role: options.role ?? 'uzbek',
    settings: { ...WINDOWS_DEFAULT_SETTINGS, uzbekModelPath: options.explicit ?? '' },
    modelsDirectory: MODELS,
    bundledDirectory: BUNDLED,
    isUsable: usable(options.present ?? []),
  });
}

describe('the three steps, in order', () => {
  it('takes the explicit setting first', () => {
    const explicit = 'D:\\somewhere else\\uz.bin';
    expect(resolve({ explicit, present: [explicit] })).toEqual({
      path: explicit,
      source: 'explicit',
    });
  });

  it('ignores an explicit setting that does not pass inspection', () => {
    const explicit = 'D:\\half-downloaded\\uz.bin';
    const bundled = `${BUNDLED}\\ggml-uzbek-stt-v1-q5_0.bin`;
    // The half-downloaded file EXISTS. It just is not usable, which is the whole point
    // of routing every readiness question through the inspection.
    expect(resolve({ explicit, present: [bundled] })).toEqual({
      path: bundled,
      source: 'bundled',
    });
  });

  // Step 2 MUST beat step 3, or a user who was sent a better Uzbek engine cannot use it
  // without an installer.
  it('prefers a model dropped into the models directory over the one inside the install', () => {
    const dropped = `${MODELS}\\ggml-uzbek-stt-v1-q5_0.bin`;
    const bundled = `${BUNDLED}\\ggml-uzbek-stt-v1-q5_0.bin`;
    expect(resolve({ present: [dropped, bundled] })).toEqual({
      path: dropped,
      source: 'modelsDirectory',
    });
  });

  it('falls back to the bundled copy, which is what makes a stock install work', () => {
    const bundled = `${BUNDLED}\\ggml-uzbek-stt-v1-q5_0.bin`;
    expect(resolve({ present: [bundled] })).toEqual({ path: bundled, source: 'bundled' });
  });

  it('returns null when nothing usable is anywhere', () => {
    expect(resolve({ present: [] })).toBeNull();
  });

  // Order inside the candidate list is measured, not alphabetical: uzbek_stt_v1 is
  // 21.68% WER against navoi-medium's 25.19%.
  it('prefers uzbek-stt-v1 over navoi-medium when both are present', () => {
    const better = `${MODELS}\\ggml-uzbek-stt-v1-q5_0.bin`;
    const worse = `${MODELS}\\ggml-navoi-medium-q5_0.bin`;
    expect(resolve({ present: [worse, better] })?.path).toBe(better);
  });

  it('still finds navoi-medium when it is the only one there', () => {
    const worse = `${MODELS}\\ggml-navoi-medium-q5_0.bin`;
    expect(resolve({ present: [worse] })?.path).toBe(worse);
  });

  it('knows the filename for every role', () => {
    expect(KNOWN_MODEL_FILENAMES.uzbek[0]).toBe('ggml-uzbek-stt-v1-q5_0.bin');
    // D-W2: English rides on the Russian engine, so there is one file for both.
    expect(KNOWN_MODEL_FILENAMES.russian).toEqual(['ggml-large-v3-turbo-q5_0.bin']);
    expect(KNOWN_MODEL_FILENAMES.detector).toEqual(['ggml-base-q5_1.bin']);
    expect(KNOWN_MODEL_FILENAMES.fastEnglish).toEqual(['ggml-small.en-q5_1.bin']);
  });

  it('resolves the detector and the Russian engine the same way', () => {
    const detector = `${MODELS}\\ggml-base-q5_1.bin`;
    expect(
      resolveModelPath({
        role: 'detector',
        settings: WINDOWS_DEFAULT_SETTINGS,
        modelsDirectory: MODELS,
        bundledDirectory: BUNDLED,
        isUsable: usable([detector]),
      }),
    ).toEqual({ path: detector, source: 'modelsDirectory' });
  });

  it('builds candidate paths with backslashes', () => {
    const bundled = `${BUNDLED}\\ggml-base-q5_1.bin`;
    const found = resolveModelPath({
      role: 'detector',
      settings: WINDOWS_DEFAULT_SETTINGS,
      modelsDirectory: MODELS,
      bundledDirectory: BUNDLED,
      isUsable: usable([bundled]),
    });
    expect(found?.path).toBe('C:\\Program Files\\Kotiba\\resources\\models\\ggml-base-q5_1.bin');
    expect(found?.path).not.toContain('/');
  });
});

describe('discovery and the raw setting are different questions', () => {
  // macOS pins this at SettingsTests.swift:178 and :259. Discovery must NEVER write the
  // setting back — a settings file that claims a path the user never chose survives an
  // uninstall of the model it names.
  it('never writes the setting it discovered', () => {
    const settings = { ...WINDOWS_DEFAULT_SETTINGS };
    const before = JSON.stringify(settings);
    resolveModelPath({
      role: 'uzbek',
      settings,
      modelsDirectory: MODELS,
      bundledDirectory: BUNDLED,
      isUsable: usable([`${MODELS}\\ggml-uzbek-stt-v1-q5_0.bin`]),
    });
    expect(JSON.stringify(settings)).toBe(before);
    expect(settings.uzbekModelPath).toBe('');
  });
});

describe('readiness', () => {
  // All THREE conditions, not two: a detector with no Uzbek model is not ready, because
  // routing to an engine that is not there is worse than not routing at all.
  it('needs something to detect, the detector AND (while Uzbek is on) the Uzbek model', () => {
    const on = { ...WINDOWS_DEFAULT_SETTINGS };
    expect(autoDetectReady({ settings: on, detectorPath: 'd', uzbekPath: 'u' })).toBe(true);
    expect(autoDetectReady({ settings: on, detectorPath: 'd', uzbekPath: null })).toBe(false);
    expect(autoDetectReady({ settings: on, detectorPath: null, uzbekPath: 'u' })).toBe(false);
    // One family on: nothing to detect.
    expect(autoDetectReady({ settings: { ...on, enabledLanguages: ['en', 'ru'] }, detectorPath: 'd', uzbekPath: 'u' })).toBe(false);
    // Uzbek off: no Uzbek model needed to choose between the others.
    expect(autoDetectReady({ settings: { ...on, enabledLanguages: ['en', 'tr'] }, detectorPath: 'd', uzbekPath: null })).toBe(true);
  });

  it('always offers English to pin, and the others only once their model resolved', () => {
    expect(availableLanguages({ uzbekPath: null, russianPath: null })).toEqual(['en']);
    expect(availableLanguages({ uzbekPath: 'u', russianPath: null })).toEqual(['en', 'uz']);
    expect(availableLanguages({ uzbekPath: 'u', russianPath: 'r' })).toEqual(['en', 'ru', 'uz']);
  });
});
