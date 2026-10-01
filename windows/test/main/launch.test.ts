// `--background` must genuinely not open a window, and a second copy must say why.

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../../src/contracts/index.js';
import {
  LAUNCH_FLAGS,
  SECOND_INSTANCE_MESSAGE,
  mayOpenWindows,
  parseLaunchOptions,
} from '../../src/main/launch.js';
import {
  ONBOARDING_ALWAYS_ON_PRESET,
  ONBOARDING_STEP_IDS,
  shouldShowOnboarding,
} from '../../src/main/onboarding-model.js';

describe('parsing how we were started', () => {
  it('a plain launch opens windows', () => {
    const options = parseLaunchOptions([]);
    expect(options).toMatchObject({ check: false, background: false });
    expect(mayOpenWindows(options)).toBe(true);
  });

  it('--background opens NOTHING', () => {
    // This is the flag `setLoginItemSettings({ args })` passes. An app that opens its
    // window every time you sign in is the thing that gets uninstalled.
    const options = parseLaunchOptions([LAUNCH_FLAGS.background]);
    expect(options.background).toBe(true);
    expect(mayOpenWindows(options)).toBe(false);
  });

  it('--check opens nothing either', () => {
    expect(mayOpenWindows(parseLaunchOptions(['--check']))).toBe(false);
  });

  it('takes a directory as --flag value or --flag=value', () => {
    expect(parseLaunchOptions(['--fixtures', 'C:\\clips']).fixturesDirectory).toBe('C:\\clips');
    expect(parseLaunchOptions(['--fixtures=C:\\clips']).fixturesDirectory).toBe('C:\\clips');
    expect(parseLaunchOptions(['--models', 'D:\\m', '--check']).modelsDirectory).toBe('D:\\m');
    expect(parseLaunchOptions(['--models', 'D:\\m', '--check']).check).toBe(true);
  });

  it('ignores arguments it does not know rather than refusing to start', () => {
    // Electron, Windows shortcuts and Squirrel all add their own.
    const options = parseLaunchOptions([
      '--allow-file-access-from-files',
      '--squirrel-firstrun',
      LAUNCH_FLAGS.background,
    ]);
    expect(options.background).toBe(true);
  });
});

describe('the second copy', () => {
  it('says why instead of vanishing', () => {
    // macOS quits a duplicate silently; there the user can SEE it is the same icon in
    // the same place. Here a shortcut that does nothing reads as a broken install.
    expect(SECOND_INSTANCE_MESSAGE).toContain('already running');
    expect(SECOND_INSTANCE_MESSAGE.length).toBeGreaterThan(40);
  });

  it('names the actual reason — one key, one caret', () => {
    expect(SECOND_INSTANCE_MESSAGE).toContain('key');
  });
});

describe('onboarding', () => {
  it('is the Mac 1.0 walkthrough, with one permission step instead of three (D-W8)', () => {
    // D-W25: no Download models checklist — the languages' downloads start as that step is left.
    expect(ONBOARDING_STEP_IDS).toEqual(['language', 'welcome', 'microphone', 'hotkey', 'languages', 'alwaysOn', 'done']);
  });

  it('asks the interface language FIRST — every later step is read in it', () => {
    expect(ONBOARDING_STEP_IDS[0]).toBe('language');
  });

  it('pre-sets Always on, while the setting itself ships off', () => {
    expect(ONBOARDING_ALWAYS_ON_PRESET).toBe(true);
    expect(DEFAULT_SETTINGS.alwaysOn).toBe(false);
  });

  it('shows on a first run the user started, and never at sign-in', () => {
    expect(shouldShowOnboarding({ onboardingCompleted: false, background: false })).toBe(true);
    expect(shouldShowOnboarding({ onboardingCompleted: false, background: true })).toBe(false);
    expect(shouldShowOnboarding({ onboardingCompleted: true, background: false })).toBe(false);
  });
});
