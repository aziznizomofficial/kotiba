import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTINGS_KEYS } from '../../src/contracts/index.js';
import {
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION_KEY,
  WINDOWS_DEFAULT_SETTINGS,
  migrateSettingsBlob,
  parseSettings,
  schemaVersionOf,
  serialiseSettings,
  stableStringify,
} from '../../src/core/settings/index.js';

describe('the schema version', () => {
  it('is stamped into everything written', () => {
    const blob = JSON.parse(serialiseSettings(WINDOWS_DEFAULT_SETTINGS)) as Record<string, unknown>;
    expect(blob[SETTINGS_SCHEMA_VERSION_KEY]).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('reads a missing or nonsense version as 0', () => {
    expect(schemaVersionOf({})).toBe(0);
    expect(schemaVersionOf({ schemaVersion: 'one' })).toBe(0);
    expect(schemaVersionOf({ schemaVersion: -3 })).toBe(0);
    expect(schemaVersionOf({ schemaVersion: 1 })).toBe(1);
  });

  it('is not itself a setting, and never leaks into the loaded snapshot', () => {
    expect(SETTINGS_KEYS).not.toContain(SETTINGS_SCHEMA_VERSION_KEY);
    const load = parseSettings({ [SETTINGS_SCHEMA_VERSION_KEY]: 1, keepHistory: false });
    expect(load.dropped).toEqual([]);
    expect(Object.keys(load.settings)).not.toContain(SETTINGS_SCHEMA_VERSION_KEY);
  });
});

describe('migration', () => {
  it('brings a versionless blob up to the current version', () => {
    const { from, to } = migrateSettingsBlob({ keepHistory: false });
    expect(from).toBe(0);
    expect(to).toBe(SETTINGS_SCHEMA_VERSION);
  });

  // A macOS blob exported by hand is exactly a versionless one: the 28 shared fields
  // and none of the four Windows-only ones. Every shared value must survive, and the
  // Windows-only keys take their defaults through the ordinary missing-key path —
  // manufacturing them would be inventing data.
  it('reads a macOS-shaped blob, keeping every shared field', () => {
    const macOSBlob: Record<string, unknown> = {};
    for (const key of SETTINGS_KEYS) {
      if (key === 'hotkey' || key === 'fastEnglish') continue;
      if (key === 'launchAtLogin' || key === 'onboardingCompleted') continue;
      macOSBlob[key] = DEFAULT_SETTINGS[key];
    }
    macOSBlob['uzbekModelPath'] = 'C:\\models\\ggml-uzbek-stt-v1-q5_0.bin';
    macOSBlob['turkicThreshold'] = 0.07;

    const load = parseSettings(macOSBlob);
    expect(load.dropped).toEqual([]);
    expect(load.failure).toBeNull();
    expect(load.settings.uzbekModelPath).toBe('C:\\models\\ggml-uzbek-stt-v1-q5_0.bin');
    expect(load.settings.turkicThreshold).toBe(0.07);

    // The four Windows-only keys, defaulted rather than invented.
    expect(load.settings.hotkey).toEqual({ vk: 163, label: 'Right Ctrl' });
    expect(load.settings.fastEnglish).toBe(false);
    expect(load.settings.launchAtLogin).toBe(false);
    expect(load.settings.onboardingCompleted).toBe(false);

    // And the macOS value of the ONE field Windows overrides does NOT win: a blob that
    // says false was written by a build whose default was false, and this build's
    // default is true. Reading it back as false would be correct — it is a stored
    // value, not an absence — so assert exactly that, and that it can be changed.
    expect(load.settings.preloadAllLanguages).toBe(false);
    expect(parseSettings({}).settings.preloadAllLanguages).toBe(true);
  });

  // A file written by a NEWER build must degrade to "the keys this build understands",
  // not to nothing. Refusing it outright is the same mistake as decoding atomically.
  it('reads a blob from a future version rather than rejecting it', () => {
    const load = parseSettings({
      [SETTINGS_SCHEMA_VERSION_KEY]: 99,
      keepHistory: false,
      somethingNew: { deeply: ['nested'] },
      uzbekModelPath: 'C:\\models\\uz.bin',
    });
    expect(load.failure).toBeNull();
    expect(load.dropped).toEqual([]);
    expect(load.settings.keepHistory).toBe(false);
    expect(load.settings.uzbekModelPath).toBe('C:\\models\\uz.bin');
  });
});

describe('serialisation', () => {
  it('round-trips every field unchanged', () => {
    const settings = {
      ...WINDOWS_DEFAULT_SETTINGS,
      pinnedLanguage: 'uz' as const,
      uzbekModelPath: 'C:\\Users\\Aziz Nizomov\\models\\uz.bin',
      whisperBeamSize: 1,
      vocabulary: { uz: ['Toshkent', 'Samarqand'], ru: ['Москва'] },
      replacements: [{ find: 'kotiba', replaceWith: 'Kotiba', matchCase: false, wholeWord: true }],
      hotkey: { vk: 164, label: 'Right Alt' },
      historyLimit: 500,
    };
    const load = parseSettings(serialiseSettings(settings));
    expect(load.dropped).toEqual([]);
    expect(load.settings).toEqual(settings);
  });

  it('is byte-stable for equal settings, whatever order the keys arrived in', () => {
    const a = serialiseSettings(WINDOWS_DEFAULT_SETTINGS);
    const shuffled = Object.fromEntries(
      Object.entries(WINDOWS_DEFAULT_SETTINGS).reverse(),
    ) as typeof WINDOWS_DEFAULT_SETTINGS;
    expect(serialiseSettings(shuffled)).toBe(a);
  });

  it('sorts keys at every level, so a diff of two settings files means something', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    const lines = serialiseSettings(WINDOWS_DEFAULT_SETTINGS).split('\n');
    const keys = lines
      .map((line) => /^ {2}"([^"]+)":/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined);
    expect(keys).toEqual([...keys].sort());
  });

  it('ends with a newline, so the file is not a partial line to any reader', () => {
    expect(serialiseSettings(WINDOWS_DEFAULT_SETTINGS).endsWith('\n')).toBe(true);
  });
});
