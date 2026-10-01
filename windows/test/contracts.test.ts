// The contracts assert themselves. These are t01's tests; each other module owns its own.
//
// Two of these are direct ports of macOS regression tests that caught real, shipped bugs:
// the error-message contract (DictationControllerTests.swift:15-61) and the
// settings-completeness one (RegressionTests.swift:130 `snapshotIsComplete`, which
// covered only 22 of the 28 fields — this one covers all of them).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_MODE_ORDER,
  BUNDLED_MODEL_IDS,
  DEFAULT_HOTKEY,
  DEFAULT_POLISH_GUARD,
  DEFAULT_SETTINGS,
  DEFAULT_TURKIC_THRESHOLD,
  LANGUAGES,
  MODEL_CATALOGUE,
  PUBLIC_MODELS_BASE,
  MODEL_IDS,
  MODEL_MINIMUM_BYTES,
  MODEL_STATUSES,
  RESTRUCTURING_POLISH_GUARD,
  SELECTABLE_MODE_ORDER,
  SETTINGS_KEYS,
  SHIPPED_DEFAULT_MODE_KEY,
  TURKIC_CLUSTER,
  dictationError,
  engineError,
  notImplemented,
  NotImplementedError,
} from '../src/contracts/index.js';
import type { DictationError, Language, Settings } from '../src/contracts/index.js';

describe('settings', () => {
  it('carries every key, so a salvage loop can walk them', () => {
    // 28 macOS fields + 4 Windows-only ones + the 3 the 1.0 platform slice added on both
    // (alwaysOn, duckingEnabled, duckLevel — same names as the Mac's) + acceptedDownloads
    // (D-W23, Windows-only: which first-use downloads the user said yes to) + appLanguage
    // (the interface language, shared with the Mac by name) + pillStyle (the pill's animation,
    // shared with the Mac by name and value) + statsPeriod (the Statistics page's period, the same)
    // + enabledLanguages (every dictation language's on/off; it replaced optionalLanguages and the
    // removed autoDetectLanguage, hence one fewer) + arabicEngine (Windows-only: Cohere,
    // FastConformer, or the speed check's pick) + turkishDictations (the user's Turkish history,
    // shared with the Mac by name) + arabicDictations (the same for Arabic, C4 §14.1).
    expect(SETTINGS_KEYS).toHaveLength(42);
    for (const key of SETTINGS_KEYS) {
      expect(DEFAULT_SETTINGS).toHaveProperty(key);
    }
  });

  it('ships the values the Mac app ships', () => {
    // Spot-checks of the ones a port gets wrong, per the inventory.
    expect(DEFAULT_SETTINGS.defaultLanguage).toBe('en');
    expect(DEFAULT_SETTINGS.defaultModeKey).toBe(SHIPPED_DEFAULT_MODE_KEY);
    expect(DEFAULT_SETTINGS.modeFollowsApp).toBe(false);
    expect(DEFAULT_SETTINGS.autoCapitalise).toBe(true);
    expect(DEFAULT_SETTINGS.polishUzbek).toBe(false);
    expect(DEFAULT_SETTINGS.historyLimit).toBe(0);
    expect(DEFAULT_SETTINGS.silenceThreshold).toBe(0.012);
  });

  it('pins turkicThreshold to the ONE literal, never a second copy', () => {
    // The two copies previously disagreed: 0.5 in core, 0.05 in the app.
    expect(DEFAULT_SETTINGS.turkicThreshold).toBe(DEFAULT_TURKIC_THRESHOLD);
    expect(DEFAULT_TURKIC_THRESHOLD).toBe(0.05);
  });

  it('leaves pinnedLanguage null, which is Automatic and a real choice', () => {
    expect(DEFAULT_SETTINGS.pinnedLanguage).toBeNull();
    // Typed as `Language | null` and not `Language | undefined`: the difference is what
    // stops a loader treating "the user cleared the pin" as "the key is absent".
    const pin: Language | null = DEFAULT_SETTINGS.pinnedLanguage;
    expect(pin).toBeNull();
  });

  it('binds push-to-talk to Right Ctrl, not Right Alt', () => {
    expect(DEFAULT_SETTINGS.hotkey).toEqual(DEFAULT_HOTKEY);
    expect(DEFAULT_HOTKEY.vk).toBe(163); // VK_RCONTROL
  });

  it('is deeply readonly at the type level', () => {
    // Compiles only because every field is `readonly`; the assignment below would not.
    const settings: Settings = DEFAULT_SETTINGS;
    // @ts-expect-error Settings is readonly by design — a writer takes a patch.
    settings.polishEnabled = false;
  });
});

describe('routing constants', () => {
  it('has the three core languages, then the two optional ones (C4), and no unknown case', () => {
    expect([...LANGUAGES]).toEqual(['en', 'ru', 'uz', 'tr', 'ar']);
  });

  it('names all seven cluster codes, Tajik included', () => {
    expect([...TURKIC_CLUSTER].sort()).toEqual(['az', 'kk', 'ky', 'tg', 'tk', 'tr', 'uz']);
  });
});

describe('models', () => {
  it('answers readiness with a status, never with prose', () => {
    expect([...MODEL_STATUSES]).toEqual(['notInstalled', 'corrupt', 'ready']);
    // If this ever becomes a string union of sentences, the ai-balance/windows bug is
    // back: machine state recovered by regex over a human message.
    for (const status of MODEL_STATUSES) {
      expect(status).not.toContain(' ');
    }
  });

  it('keeps one copy of each sha256, in lowercase hex', () => {
    for (const id of MODEL_IDS) {
      const spec = MODEL_CATALOGUE[id];
      expect(spec.id).toBe(id);
      if (spec.sha256 !== '') {
        expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('ships the uzbek-stt-v1 build, not navoi-medium', () => {
    // Both files are 539,212,484 bytes with DIFFERENT sha256s, so the wrong one fails
    // verification in a way that looks like a corrupt download.
    const uzbek = MODEL_CATALOGUE.uzbek_stt_v1;
    expect(uzbek.fileName).toBe('ggml-uzbek-stt-v1-q5_0.bin');
    expect(uzbek.sha256).toBe('2891c1ca99f40a5519cd2e863e85b70b6cdc057b46fdbb5edbe6d9cead29c1b2');
    expect(uzbek.bytes).toBe(539_212_484);
  });

  it('bundles Uzbek and the detector — Uzbek works offline from the first launch (D-W3, D-W25)', () => {
    // D-W25: whisper turbo left the installer (−574 MB); it comes with Turkish or Arabic.
    expect([...BUNDLED_MODEL_IDS].sort()).toEqual(['base_detector', 'uzbek_stt_v1']);
    expect(MODEL_CATALOGUE.large_v3_turbo.bundled).toBe(false);
    expect(MODEL_CATALOGUE.large_v3_turbo.url).not.toBeNull();
    for (const id of BUNDLED_MODEL_IDS) {
      expect(MODEL_CATALOGUE[id].bundled).toBe(true);
    }
    // Every bundled model clears the plausibility floor by orders of magnitude.
    for (const id of BUNDLED_MODEL_IDS) {
      expect(MODEL_CATALOGUE[id].bytes ?? 0).toBeGreaterThan(MODEL_MINIMUM_BYTES);
    }
  });

  it('fetches the Uzbek model from the one public-models constant, which the Mac manifest shares', () => {
    expect(MODEL_CATALOGUE.uzbek_stt_v1.url).toBe(`${PUBLIC_MODELS_BASE}ggml-uzbek-stt-v1-q5_0.bin`);
    const manifest = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'Scripts', 'Manifest.json'), 'utf8'),
    ) as { public_models_base: string; models: { dest: string; public_asset?: string; sha256: string; bytes: number }[] };
    expect(manifest.public_models_base).toBe(PUBLIC_MODELS_BASE);
    const entry = manifest.models.find((m) => m.dest === 'ggml-uzbek-stt-v1-q5_0.bin');
    expect(entry?.public_asset).toBe(MODEL_CATALOGUE.uzbek_stt_v1.fileName);
    expect(entry?.sha256).toBe(MODEL_CATALOGUE.uzbek_stt_v1.sha256);
    expect(entry?.bytes).toBe(MODEL_CATALOGUE.uzbek_stt_v1.bytes);
  });
});

describe('the error taxonomy', () => {
  const everyCase: readonly DictationError[] = [
    dictationError.armingFailed('the device disappeared'),
    dictationError.captureFailed('the graph stopped'),
    ...LANGUAGES.map((language) => dictationError.noEngineReady('unified', language)),
    dictationError.transcriptionFailed('the host exited'),
    dictationError.insertionRefused('the clipboard refused the text'),
    dictationError.insertionTimedOut(),
  ];

  it('gives every case a real sentence', () => {
    // "an error occurred" cost days on the predecessor.
    for (const error of everyCase) {
      expect(error.message.length).toBeGreaterThan(12);
      expect(error.message).not.toContain('Optional(');
      expect(error.message).not.toContain('Error Domain');
      expect(error.message.trim()).toBe(error.message);
    }
  });

  it('names the language that is missing, not the family', () => {
    // Keying off the family alone reported a missing Russian model as an English
    // problem and pointed the user at the one thing that was working.
    const russian = dictationError.noEngineReady('unified', 'ru').message.toLowerCase();
    expect(russian).toContain('russian');
    expect(russian).toContain('settings');
    expect(russian).not.toContain('english');

    const uzbek = dictationError.noEngineReady('uzbek', 'uz').message.toLowerCase();
    expect(uzbek).toContain('uzbek');
    expect(uzbek).toContain('settings');
  });

  it('separates a missing model from a corrupt one as a KIND, not a message', () => {
    const missing = engineError.modelMissing('C:\\models\\ggml-uzbek-stt-v1-q5_0.bin');
    const corrupt = engineError.modelCorrupt('C:\\models\\ggml-uzbek-stt-v1-q5_0.bin', 'only 3 MB');
    expect(missing.kind).toBe('modelMissing');
    expect(corrupt.kind).toBe('modelCorrupt');
    expect(missing.kind).not.toBe(corrupt.kind);
  });

  it("says 'no model is installed' rather than 'the router misrouted'", () => {
    const reason = engineError.noEngineInstalled('uz').reason;
    expect(reason).toContain('Settings');
    expect(reason).not.toContain('misrouted');
  });
});

describe('modes', () => {
  it('renders in one order and offers another', () => {
    expect([...BUILT_IN_MODE_ORDER]).toEqual(['message', 'super', 'note', 'transcription']);
    // A different hard-coded order, and it excludes the credential-gate mode.
    expect([...SELECTABLE_MODE_ORDER]).toEqual(['super', 'note', 'message']);
    expect(SELECTABLE_MODE_ORDER).not.toContain('transcription');
  });

  it('defaults to Super, not to the registry key', () => {
    expect(SHIPPED_DEFAULT_MODE_KEY).toBe('super');
  });
});

describe('polish guards', () => {
  it('gives a restructuring mode room the default guard would refuse', () => {
    // `note` measured compression ratios of 0.23 and 0.30 in the wild — both rejected
    // by the 0.5-era floor, which is why the mode appeared to do nothing.
    expect(DEFAULT_POLISH_GUARD.minimumRatio).toBe(0.75);
    expect(RESTRUCTURING_POLISH_GUARD.minimumRatio).toBe(0.12);
    expect(RESTRUCTURING_POLISH_GUARD.minimumRatio).toBeLessThan(0.23);
  });
});

describe('the stubs', () => {
  it('throw with their own name, so a gap is never a mystery', () => {
    expect(() => notImplemented('core/routing')).toThrow(NotImplementedError);
    expect(() => notImplemented('core/routing')).toThrow(/core\/routing/);
  });
});
