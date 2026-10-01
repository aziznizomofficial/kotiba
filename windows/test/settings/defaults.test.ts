import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTINGS_KEYS, type Settings } from '../../src/contracts/index.js';
import {
  SETTINGS_FIELD_NAMES,
  WINDOWS_DEFAULT_SETTINGS,
  WINDOWS_SETTINGS_DELTAS,
} from '../../src/core/settings/index.js';

describe('the shipped defaults', () => {
  it('has a validator for every key and a key for every validator', () => {
    expect([...SETTINGS_FIELD_NAMES].sort()).toEqual([...SETTINGS_KEYS].sort());
  });

  it('differs from macOS in exactly one place', () => {
    const differing = SETTINGS_KEYS.filter(
      (key) => JSON.stringify(WINDOWS_DEFAULT_SETTINGS[key]) !== JSON.stringify(DEFAULT_SETTINGS[key]),
    );
    expect(differing).toEqual(['preloadAllLanguages']);
  });

  // The Windows delta. macOS ships this false and the inventory says plainly that off
  // "was the only thing hiding the cold-start defect on the developer's machine" — on a
  // fresh install Uzbek and Russian are configured-but-not-resident, so the step-4b
  // reroute finds a cold engine and gives up. D-W3 bundles all three models, so every
  // Windows install is in exactly that state from first launch.
  it('preloads all languages on Windows and does not on macOS', () => {
    expect(DEFAULT_SETTINGS.preloadAllLanguages).toBe(false);
    expect(WINDOWS_DEFAULT_SETTINGS.preloadAllLanguages).toBe(true);
    expect(WINDOWS_SETTINGS_DELTAS).toEqual({ preloadAllLanguages: true });
  });

  it('ships Super as the default mode, not the registry key Message', () => {
    expect(WINDOWS_DEFAULT_SETTINGS.defaultModeKey).toBe('super');
  });

  it('keeps every measured constant that has no UI to change it', () => {
    // turkicThreshold, historyLimit, polishFallbackModel and detectorModelPath are
    // read by the pipeline and writable only by editing the file. Dropping any of them
    // loses the retention policy, the second free-tier model, or the routing threshold
    // — and turkicThreshold is the constant that previously drifted out of sync with
    // its core-module twin.
    expect(WINDOWS_DEFAULT_SETTINGS.turkicThreshold).toBe(0.05);
    expect(WINDOWS_DEFAULT_SETTINGS.historyLimit).toBe(0);
    expect(WINDOWS_DEFAULT_SETTINGS.polishFallbackModel).toBe('openai/gpt-oss-20b');
    expect(WINDOWS_DEFAULT_SETTINGS.detectorModelPath).toBe('');
    expect(WINDOWS_DEFAULT_SETTINGS.silenceThreshold).toBe(0.012);
    expect(WINDOWS_DEFAULT_SETTINGS.polishTimeoutSeconds).toBe(8);
  });

  it('carries no API key, only the credential-store account name', () => {
    const blob = JSON.stringify(WINDOWS_DEFAULT_SETTINGS).toLowerCase();
    expect(WINDOWS_DEFAULT_SETTINGS.polishKeyAccount).toBe('polish-default');
    expect(blob).not.toContain('apikey');
    expect(blob).not.toContain('sk-');
  });

  it('starts with the pin cleared, which means Automatic', () => {
    const pinned: Settings['pinnedLanguage'] = WINDOWS_DEFAULT_SETTINGS.pinnedLanguage;
    expect(pinned).toBeNull();
  });
});

// Every field the Mac's `AppSettings` declares, read out of the Swift declaration by
// `kotiba-golden` (its field list is closed, so a setting added on the Mac fails the generator
// until it is listed). A field Windows shares must default to the same value; one it does not
// share is named below with the reason, so a new Mac setting cannot be silently skipped.
describe('the shipped defaults against the Mac declaration (settings.json)', () => {
  const golden = JSON.parse(readFileSync(join(__dirname, '../../fixtures/golden/settings.json'), 'utf8')) as {
    readonly defaults: Readonly<Record<string, unknown>>;
    readonly windowsDeltas: Readonly<Record<string, string>>;
  };

  /** Mac fields with no Windows twin of the same name and shape, and where each went. */
  const NOT_SHARED: Readonly<Record<string, string>> = {
    // D-W4: a Win32 VK code, not a macOS kVK code — the FIELD is shared, the value cannot be.
    hotkey: 'hotkey',
    // Same meaning, Windows' name for it.
    hasCompletedOnboarding: 'onboardingCompleted',
    // A Core Audio behaviour with no Windows counterpart (D-W6 captures the default device).
    preferBuiltInMicWithBluetooth: '',
    // Each Windows engine carries its own idle unload; there is no user setting for it.
    modelIdleUnloadMinutes: '',
    // D-W23: Windows records which downloads were accepted, not one on/off switch.
    autoDownloadModels: 'acceptedDownloads',
    // The Mac's opt-in cloud endpoint for custom modes; Windows 1.0 has no cloud polish UI.
    cloudPolish: '',
  };

  it('names a Windows delta for every Mac field it does not share', () => {
    for (const key of Object.keys(NOT_SHARED)) {
      expect(golden.defaults, key).toHaveProperty(key);
      if (key !== 'cloudPolish') expect(golden.windowsDeltas, key).toHaveProperty(key);
    }
  });

  it('defaults every shared field to the Mac value', () => {
    const differing: string[] = [];
    for (const [key, value] of Object.entries(golden.defaults)) {
      if (key in NOT_SHARED) continue;
      expect(SETTINGS_KEYS as readonly string[], `Windows has no \`${key}\``).toContain(key);
      if (JSON.stringify(DEFAULT_SETTINGS[key as keyof Settings]) !== JSON.stringify(value)) differing.push(key);
    }
    expect(differing).toEqual([]);
  });

  it('keeps the renamed and reshaped ones at the Mac meaning', () => {
    expect(golden.defaults.hasCompletedOnboarding).toBe(false);
    expect(DEFAULT_SETTINGS.onboardingCompleted).toBe(false);
    expect(golden.defaults.hotkey).toEqual({ kind: 'modifier', keyCode: 54 });
    expect(DEFAULT_SETTINGS.hotkey.vk).toBe(163);
  });
});
