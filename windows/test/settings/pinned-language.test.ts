// The one field assigned unconditionally.
//
// `pinnedLanguage: null` means Automatic and is a REAL user choice. macOS assigns it
// straight through where the other 31 fields use `if let`, and the inventory names the
// consequence of getting it wrong: a cleared pin silently resurrects on the next
// launch. That matters because the pin is the user's ONLY override on a router measured
// at 83.1% recall on Uzbek — 58.4% under two seconds — so someone who cleared it did so
// after being wrong about their own language once too often.

import { describe, expect, it } from 'vitest';

import { WINDOWS_DEFAULT_SETTINGS, parseSettings, serialiseSettings } from '../../src/core/settings/index.js';

describe('pinnedLanguage', () => {
  it('reads a stored null as a cleared pin', () => {
    const load = parseSettings({ pinnedLanguage: null });
    expect(load.settings.pinnedLanguage).toBeNull();
    expect(load.dropped).toEqual([]);
  });

  it('reads an absent key as a cleared pin', () => {
    expect(parseSettings({}).settings.pinnedLanguage).toBeNull();
  });

  it('round-trips a set pin', () => {
    expect(parseSettings({ pinnedLanguage: 'uz' }).settings.pinnedLanguage).toBe('uz');
  });

  // THE REGRESSION. Pin Uzbek, save, clear it, save, relaunch: the pin must still be
  // clear. An `if let`, a `??`, or a truthiness test on this field all produce 'uz'.
  it('stays cleared across a save and a reload, starting from a set pin', () => {
    const pinned = { ...WINDOWS_DEFAULT_SETTINGS, pinnedLanguage: 'uz' as const };
    const afterPin = parseSettings(serialiseSettings(pinned));
    expect(afterPin.settings.pinnedLanguage).toBe('uz');

    const cleared = { ...afterPin.settings, pinnedLanguage: null };
    const afterClear = parseSettings(serialiseSettings(cleared));
    expect(afterClear.settings.pinnedLanguage).toBeNull();

    // And once more, because a resurrection bug can take two launches to show.
    expect(parseSettings(serialiseSettings(afterClear.settings)).settings.pinnedLanguage).toBeNull();
  });

  it('writes the cleared pin explicitly rather than omitting it', () => {
    // macOS OMITS a nil optional, so a factory-fresh blob has 27 keys and not 28. Here
    // the key is always written: an absent key and a stored null already mean the same
    // thing to the reader, and writing it makes the file say what the app decided.
    const blob: unknown = JSON.parse(serialiseSettings(WINDOWS_DEFAULT_SETTINGS));
    expect(Object.prototype.hasOwnProperty.call(blob, 'pinnedLanguage')).toBe(true);
    expect((blob as { pinnedLanguage: unknown }).pinnedLanguage).toBeNull();
  });

  it('falls back to Automatic when the stored pin is unreadable', () => {
    const load = parseSettings({ pinnedLanguage: 'kk', uzbekModelPath: 'C:\\m.bin' });
    expect(load.dropped).toEqual(['pinnedLanguage']);
    expect(load.settings.pinnedLanguage).toBeNull();
    expect(load.settings.uzbekModelPath).toBe('C:\\m.bin');
  });
});
