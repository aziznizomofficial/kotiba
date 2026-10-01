// The parity checklist, as a test. "A missing setting is a missing feature."
//
// Two directions, and both are needed:
//   * every control names a key that exists     — a control that writes nothing is dead UI
//   * every key is either rendered or NAMED     — a key with no control and no entry on
//                                                 the without-controls list is a feature
//                                                 that got dropped in the port

import { describe, expect, it } from 'vitest';

import type { Settings } from '../../src/contracts/index.js';
import { DEFAULT_SETTINGS, SETTINGS_KEYS } from '../../src/contracts/index.js';
import {
  APP_SECTIONS,
  KEYS_WITH_TWO_CONTROLS,
  MAIN_WINDOW_HEIGHT,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  MAIN_WINDOW_WIDTH,
  RAIL_BELOW,
  SECTION_IDS,
  SETTINGS_COMMIT,
  SETTINGS_WITHOUT_CONTROLS,
  allControls,
  boundSettingsKeys,
  secretIsPresent,
  greeting,
  modeSummary,
} from '../../src/main/settings-model.js';

describe('the seven sections', () => {
  it('are the Mac app window\'s seven, in its sidebar order', () => {
    expect(APP_SECTIONS.map((section) => section.id)).toEqual([...SECTION_IDS]);
    expect(APP_SECTIONS.map((section) => section.title)).toEqual([
      'Home',
      'History',
      'Statistics',
      'Modes',
      'Languages',
      'Hotkey',
      'Settings',
    ]);
  });

  it('is the Mac window geometry: 1000 × 680, never smaller than 720 × 480, rail below 860', () => {
    expect([MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT]).toEqual([1000, 680]);
    expect([MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT]).toEqual([720, 480]);
    expect(RAIL_BELOW).toBe(860);
  });

  it('greets by the Mac\'s hour bands', () => {
    expect(greeting(4)).toBe('Good evening');
    expect(greeting(5)).toBe('Good morning');
    expect(greeting(12)).toBe('Good afternoon');
    expect(greeting(18)).toBe('Good evening');
  });
});

describe('every control persists immediately', () => {
  it('there is no OK/Cancel model', () => {
    // Thirteen of twenty-one macOS controls once relied on window-close and lost data on
    // quit. A dialog with an Apply button reintroduces exactly that.
    expect(SETTINGS_COMMIT).toBe('immediate');
  });

  it('no control is named save, apply, ok or cancel', () => {
    for (const control of allControls()) {
      expect(control.id).not.toMatch(/\b(save|apply|ok|cancel)\b/iu);
    }
  });
});

describe('the parity checklist', () => {
  it('every control writes a key that exists', () => {
    const known = new Set<string>(SETTINGS_KEYS as readonly string[]);
    for (const control of allControls()) {
      if (control.settingKey !== null) expect(known.has(control.settingKey)).toBe(true);
      if (control.kind === 'secret') expect(known.has(control.account)).toBe(true);
    }
  });

  it('every persisted key is either rendered or deliberately not', () => {
    const bound = boundSettingsKeys();
    const named = new Set<keyof Settings>(SETTINGS_WITHOUT_CONTROLS);
    const missing = SETTINGS_KEYS.filter((key) => !bound.has(key) && !named.has(key));
    expect(missing).toEqual([]);
  });

  it('the without-controls list names nothing that actually has a control', () => {
    const bound = boundSettingsKeys();
    for (const key of SETTINGS_WITHOUT_CONTROLS) expect(bound.has(key)).toBe(false);
  });

  it('no key is written by two controls, except the ones named for it', () => {
    const seen = new Set<string>();
    for (const control of allControls()) {
      if (control.settingKey === null) continue;
      if (!KEYS_WITH_TWO_CONTROLS.includes(control.settingKey)) {
        expect(seen.has(control.settingKey)).toBe(false);
      }
      seen.add(control.settingKey);
    }
  });

  it('every control id is unique — the renderer keys on it', () => {
    const ids = allControls().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the controls whose ranges and options are behaviour', () => {
  const control = (id: string) => allControls().find((c) => c.id === id);

  it('the silence-threshold slider spans the macOS range around the shipped 0.012', () => {
    const slider = control('settings.silenceThreshold');
    expect(slider).toMatchObject({ kind: 'slider', min: 0.001, max: 0.1 });
    expect(DEFAULT_SETTINGS.silenceThreshold).toBe(0.012);
  });

  it('ducking lowers to 0…80% in 5% steps, around the shipped 25%', () => {
    expect(control('settings.duckLevel')).toMatchObject({ kind: 'slider', min: 0, max: 0.8, step: 0.05 });
    expect(DEFAULT_SETTINGS.duckLevel).toBe(0.25);
    expect(DEFAULT_SETTINGS.duckingEnabled).toBe(true);
  });

  it('always-on is OFF by default and has its control; onboarding is where it is pre-set on', () => {
    expect(DEFAULT_SETTINGS.alwaysOn).toBe(false);
    expect(control('settings.alwaysOn')).toMatchObject({ kind: 'toggle', settingKey: 'alwaysOn' });
  });

  it('accuracy offers exactly two beam widths, tagged with the widths themselves', () => {
    const picker = control('languages.beamSize');
    expect(picker?.kind === 'picker' && picker.options.map((o) => o.value)).toEqual([1, 5]);
  });

  it('the polish timeout slider spans 2…30 around the shipped 8', () => {
    expect(control('polish.timeout')).toMatchObject({ kind: 'slider', min: 2, max: 30, step: 1 });
    expect(DEFAULT_SETTINGS.polishTimeoutSeconds).toBe(8);
  });

  it('history retention is a real choice now, as on the Mac', () => {
    const picker = control('settings.historyLimit');
    expect(picker?.kind === 'picker' && picker.options.map((o) => o.value)).toEqual([0, 100, 1000, 10_000]);
  });

  it('the languages’ on/off and the fallback among them are one control, with no detection switch', () => {
    const languages = JSON.stringify(APP_SECTIONS.find((section) => section.id === 'languages'));
    expect(languages).toContain('"custom":"languageToggles","id":"languages.languageToggles","writes":["enabledLanguages","defaultLanguage"]');
    expect(control('languages.autoDetect')).toBeUndefined();
    expect(control('languages.defaultLanguage')).toBeUndefined();
  });

  it('the hotkey is recorded on its own page and written as a binding', () => {
    expect(control('hotkey.hotkeyRecorder')).toMatchObject({ kind: 'custom', writes: ['hotkey'] });
    expect(DEFAULT_SETTINGS.hotkey).toEqual({ vk: 163, label: 'Right Ctrl' });
  });

  it('"Make default" writes the fallback only — never a pin', () => {
    expect(control('modes.modeCards')).toMatchObject({ writes: ['defaultModeKey'] });
  });

  it('the API key is never a settings key', () => {
    const secret = allControls().find((c) => c.kind === 'secret');
    expect(secret?.settingKey).toBeNull();
    expect(JSON.stringify(DEFAULT_SETTINGS).toLowerCase()).not.toContain('sk-');
  });

  it('every mode has its sentence', () => {
    for (const key of ['super', 'message', 'note', 'transcription']) {
      expect(modeSummary(key)).not.toBe('A custom mode.');
    }
  });
});

describe('the saved-key flag in the settings snapshot', () => {
  it('a credential store that cannot be read is "no key", never a rejected settings:get', async () => {
    // Constrained Language Mode refuses Add-Type: the store throws on every read. Thrown
    // through settings:get, the renderer never drew Home or opened onboarding.
    const broken = {
      get: async () => {
        throw new Error('Windows Credential Manager could not read the key (exit 1)');
      },
      set: async () => undefined,
      remove: async () => undefined,
    };
    await expect(secretIsPresent(broken, 'polish')).resolves.toBe(false);
    await expect(secretIsPresent(null, 'polish')).resolves.toBe(false);
    const saved = { ...broken, get: async () => 'sk-1' };
    await expect(secretIsPresent(saved, 'polish')).resolves.toBe(true);
    const empty = { ...broken, get: async () => '' };
    await expect(secretIsPresent(empty, 'polish')).resolves.toBe(false);
  });
});
