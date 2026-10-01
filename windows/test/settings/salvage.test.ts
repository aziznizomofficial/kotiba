// The per-key salvage, and the two rules that make it worth having.
//
// Every case here is one macOS pinned in SettingsSalvageTests.swift, plus the Windows
// keys. The point of all of them is the same: ONE unreadable value must not cost the
// other 31, because the model paths are the hardest state in this app to reconstruct
// and losing them presents to the user as "No Uzbek model" — pointing at the wrong
// cause entirely.

import { describe, expect, it } from 'vitest';

import { SETTINGS_LOAD_MESSAGES } from '../../src/contracts/index.js';
import { WINDOWS_DEFAULT_SETTINGS, parseSettings } from '../../src/core/settings/index.js';

const good = {
  uzbekModelPath: 'C:\\Users\\Aziz\\AppData\\Roaming\\Kotiba\\models\\ggml-uzbek-stt-v1-q5_0.bin',
  russianModelPath: 'C:\\Users\\Aziz\\AppData\\Roaming\\Kotiba\\models\\ggml-large-v3-turbo-q5_0.bin',
  polishModel: 'llama-3.3-70b-versatile',
};

describe('per-key salvage', () => {
  it('reads a well-formed blob with nothing dropped', () => {
    const load = parseSettings({ ...good, whisperBeamSize: 1, soundFeedback: true });
    expect(load.dropped).toEqual([]);
    expect(load.failure).toBeNull();
    expect(load.settings.uzbekModelPath).toBe(good.uzbekModelPath);
    expect(load.settings.whisperBeamSize).toBe(1);
    expect(load.settings.soundFeedback).toBe(true);
  });

  // The case the whole design exists for. A settings file written by a build that knew
  // a fourth language makes exactly `defaultLanguage` unreadable. The model paths must
  // survive it.
  it('keeps the model paths when a future language code makes one key unreadable', () => {
    const load = parseSettings({ ...good, defaultLanguage: 'kk' });

    expect(load.dropped).toEqual(['defaultLanguage']);
    expect(load.settings.uzbekModelPath).toBe(good.uzbekModelPath);
    expect(load.settings.russianModelPath).toBe(good.russianModelPath);
    expect(load.settings.defaultLanguage).toBe(WINDOWS_DEFAULT_SETTINGS.defaultLanguage);
    expect(load.failure).toBe(`${SETTINGS_LOAD_MESSAGES.droppedPrefix}defaultLanguage`);
  });

  it('makes a wrong-typed value cost only itself', () => {
    const load = parseSettings({ ...good, whisperBeamSize: 'five' });
    expect(load.dropped).toEqual(['whisperBeamSize']);
    expect(load.settings.whisperBeamSize).toBe(5);
    expect(load.settings.polishModel).toBe('llama-3.3-70b-versatile');
  });

  it('tolerates an unknown key from a newer build without reporting it', () => {
    const load = parseSettings({ ...good, somethingFromVersionNine: { nested: true } });
    expect(load.dropped).toEqual([]);
    expect(load.failure).toBeNull();
    expect(load.settings.uzbekModelPath).toBe(good.uzbekModelPath);
  });

  // macOS: `[Replacement]` is a synthesised Codable with four NON-optional fields, so
  // one malformed rule drops the entire key rather than that rule. Deliberate — a
  // half-applied replacement set rewrites the user's words differently from how they
  // configured it, and silently.
  it('drops the whole replacements key when one rule is malformed', () => {
    const load = parseSettings({
      ...good,
      replacements: [
        { find: 'kotiba', replaceWith: 'Kotiba', matchCase: false, wholeWord: true },
        { find: 'oops' },
      ],
    });
    expect(load.dropped).toEqual(['replacements']);
    expect(load.settings.replacements).toEqual([]);
  });

  it('accepts a well-formed replacement set whole', () => {
    const rule = { find: 'kotiba', replaceWith: 'Kotiba', matchCase: false, wholeWord: true };
    const load = parseSettings({ replacements: [rule] });
    expect(load.dropped).toEqual([]);
    expect(load.settings.replacements).toEqual([rule]);
  });

  it('keeps a vocabulary entry for a language code this build does not know', () => {
    // Storage tolerates it; the conversion to a Vocabulary is where it is dropped.
    const load = parseSettings({ vocabulary: { uz: ['Toshkent'], kk: ['Almaty'] } });
    expect(load.dropped).toEqual([]);
    expect(load.settings.vocabulary).toEqual({ uz: ['Toshkent'], kk: ['Almaty'] });
  });

  it('names every dropped key, sorted', () => {
    const load = parseSettings({
      ...good,
      whisperUseGPU: 'yes',
      defaultLanguage: 'kk',
      autoCapitalise: 3,
    });
    expect(load.dropped).toEqual(['autoCapitalise', 'defaultLanguage', 'whisperUseGPU']);
    expect(load.failure).toBe(
      `${SETTINGS_LOAD_MESSAGES.droppedPrefix}autoCapitalise, defaultLanguage, whisperUseGPU`,
    );
  });

  it('reports a total failure for bytes that are not JSON at all', () => {
    for (const raw of ['', '{not json', '\u0000\u0000\u0000\u0000', '[1,2,3]', '"a string"']) {
      const load = parseSettings(raw);
      expect(load.failure).toBe(SETTINGS_LOAD_MESSAGES.unreadable);
      expect(load.settings).toEqual(WINDOWS_DEFAULT_SETTINGS);
    }
  });

  it('accepts the text of a file as readily as a parsed object', () => {
    const load = parseSettings(JSON.stringify(good));
    expect(load.failure).toBeNull();
    expect(load.settings.uzbekModelPath).toBe(good.uzbekModelPath);
  });

  it('treats an empty object as a factory-fresh install, not a failure', () => {
    const load = parseSettings({});
    expect(load.dropped).toEqual([]);
    expect(load.failure).toBeNull();
    expect(load.settings).toEqual(WINDOWS_DEFAULT_SETTINGS);
  });

  it('does not decode the blob atomically — every key is tested alone', () => {
    // The regression this pins: one bad value used to cost all 32. If salvage were
    // removed, every field below would come back at its default.
    const load = parseSettings({
      ...good,
      pinnedLanguage: 'martian',
      turkicThreshold: 0.2,
      historyLimit: 500,
      keepHistory: false,
    });
    expect(load.dropped).toEqual(['pinnedLanguage']);
    expect(load.settings.turkicThreshold).toBe(0.2);
    expect(load.settings.historyLimit).toBe(500);
    expect(load.settings.keepHistory).toBe(false);
    expect(load.settings.uzbekModelPath).toBe(good.uzbekModelPath);
  });
});
