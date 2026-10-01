// The hotkey's decisions, with no hook: press, release, chord, repeat, the swallowed
// ordinary key, the resync, and the recorder. The port of Tests/KotibaPlatformTests/
// HotkeyTests.swift onto Windows virtual-key codes.

import { describe, expect, it } from 'vitest';

import {
  CHORD_WINDOW_MS,
  HOTKEY_PRESETS,
  HotkeyRecorder,
  HotkeyTracker,
  RECORDER_COPY,
  VK,
  bindingFor,
  hotkeyName,
  hotkeyWarnings,
  inlineName,
  isAllowedKey,
  keycapLabels,
  kindOf,
} from '../../src/core/hotkey/index.js';

const C = 0x43;
const V = 0x56;
const F13 = 0x7c;
const F5 = 0x74;

const down = (vk: number) => ({ kind: 'down', vk }) as const;
const up = (vk: number) => ({ kind: 'up', vk }) as const;

describe('a modifier held on its own (Right Ctrl, the default)', () => {
  it('press, then release, is one dictation', () => {
    const t = new HotkeyTracker(VK.rightControl);
    expect(t.handle(down(VK.rightControl), 0)).toBe('pressed');
    expect(t.isHeld).toBe(true);
    expect(t.handle(up(VK.rightControl), 900)).toBe('released');
    expect(t.isHeld).toBe(false);
  });

  it('a key within 1.5 s is a shortcut: cancelled once, and its release is silent', () => {
    const t = new HotkeyTracker(VK.rightControl);
    t.handle(down(VK.rightControl), 0);
    expect(t.handle(down(C), 200)).toBe('cancelled');
    // Said once: a second key in the same hold does not cancel again.
    expect(t.handle(down(V), 300)).toBeNull();
    expect(t.handle(up(C), 320)).toBeNull();
    expect(t.handle(up(VK.rightControl), 400)).toBeNull();
  });

  it(`a key bumped after ${String(CHORD_WINDOW_MS)} ms does NOT throw a long dictation away`, () => {
    const t = new HotkeyTracker(VK.rightControl);
    t.handle(down(VK.rightControl), 0);
    expect(t.handle(down(C), CHORD_WINDOW_MS + 1)).toBeNull();
    expect(t.handle(up(VK.rightControl), 60_000)).toBe('released');
  });

  it('another modifier is not a chord — only a real key is (the Mac\'s flagsChanged)', () => {
    const t = new HotkeyTracker(VK.rightControl);
    t.handle(down(VK.rightControl), 0);
    expect(t.handle(down(VK.leftShift), 100)).toBeNull();
    expect(t.handle(down(VK.capsLock), 150)).toBeNull();
    expect(t.handle(down(0x53), 200)).toBe('cancelled'); // Ctrl+Shift+S
  });

  it('an autorepeat of a key held from before the press is not a chord', () => {
    const t = new HotkeyTracker(VK.rightControl);
    t.handle(down(C), 0);
    t.handle(down(VK.rightControl), 10);
    expect(t.handle(down(C), 40)).toBeNull(); // repeat: C was already down
  });

  it('ignores the other side entirely', () => {
    const t = new HotkeyTracker(VK.rightControl);
    expect(t.handle(down(VK.leftControl), 0)).toBeNull();
    expect(t.handle(up(VK.leftControl), 10)).toBeNull();
    expect(t.isHeld).toBe(false);
  });

  it('ignores a second down of the held key', () => {
    const t = new HotkeyTracker(VK.rightControl);
    t.handle(down(VK.rightControl), 0);
    expect(t.handle(down(VK.rightControl), 30)).toBeNull();
  });
});

describe('an ordinary key (F13, Caps Lock…)', () => {
  it('press and release, and other keys during the hold are left alone', () => {
    const t = new HotkeyTracker(F13);
    expect(t.kind).toBe('key');
    expect(t.handle(down(F13), 0)).toBe('pressed');
    expect(t.handle(down(C), 100)).toBeNull(); // no chord rule for an ordinary key
    expect(t.handle(down(F13), 130)).toBeNull(); // autorepeat
    expect(t.handle(up(F13), 900)).toBe('released');
  });

  it('with Ctrl, Alt or Windows held it is someone else\'s shortcut — no press', () => {
    for (const modifier of [VK.leftControl, VK.rightAlt, VK.leftWin]) {
      const t = new HotkeyTracker(F13);
      t.handle(down(modifier), 0);
      expect(t.handle(down(F13), 10)).toBeNull();
      expect(t.handle(up(F13), 20)).toBeNull();
    }
  });

  it('a down the HOOK swallowed is ours even if a Ctrl key-up was lost here', () => {
    const t = new HotkeyTracker(F13);
    t.handle(down(VK.leftControl), 0); // its key-up never arrives
    expect(t.handle(down(F13), 10)).toBeNull();
    t.handle(up(F13), 20);
    expect(t.handle({ kind: 'down', vk: F13, swallowed: true }, 30)).toBe('pressed');
    expect(t.handle({ kind: 'up', vk: F13, swallowed: true }, 40)).toBe('released');
    // And the stale Ctrl is forgotten: the next unmarked press works too.
    expect(t.handle(down(F13), 50)).toBe('pressed');
  });

  it('a rebound tracker keeps the picture of held keys', () => {
    const before = new HotkeyTracker(VK.rightControl);
    before.handle(down(VK.leftAlt), 0);
    const after = new HotkeyTracker(F13, before.keysDown());
    expect(after.handle(down(F13), 10)).toBeNull(); // Alt+F13 is not ours
  });

  it('Shift does not stop it, as on the Mac', () => {
    const t = new HotkeyTracker(F13);
    t.handle(down(VK.leftShift), 0);
    expect(t.handle(down(F13), 10)).toBe('pressed');
  });
});

describe('resync — a lost key-up recovered by polling', () => {
  it('a hold whose key is no longer down is released', () => {
    const t = new HotkeyTracker(VK.rightControl);
    t.handle(down(VK.rightControl), 0);
    expect(t.resync(true)).toBeNull();
    expect(t.resync(false)).toBe('released');
    expect(t.isHeld).toBe(false);
    // And the next real press is admitted.
    expect(t.handle(down(VK.rightControl), 5_000)).toBe('pressed');
  });

  it('a chorded hold whose key-up was lost goes quietly', () => {
    const t = new HotkeyTracker(VK.rightControl);
    t.handle(down(VK.rightControl), 0);
    t.handle(down(C), 100);
    expect(t.resync(false)).toBeNull();
    expect(t.isHeld).toBe(false);
  });

  it('never OPENS a dictation from a poll', () => {
    const t = new HotkeyTracker(VK.rightControl);
    expect(t.resync(true)).toBeNull();
    expect(t.isHeld).toBe(false);
  });
});

describe('the recorder', () => {
  it('a modifier is recorded when it goes down and up alone', () => {
    const r = new HotkeyRecorder();
    expect(r.handle(down(VK.rightShift))).toEqual({ kind: 'recording' });
    expect(r.handle(up(VK.rightShift))).toEqual({
      kind: 'recorded',
      binding: { vk: VK.rightShift, label: 'Right Shift' },
    });
  });

  it('two modifiers together are a combination and record nothing', () => {
    const r = new HotkeyRecorder();
    r.handle(down(VK.leftControl));
    r.handle(down(VK.leftShift));
    expect(r.handle(up(VK.leftShift))).toEqual({ kind: 'recording' });
    expect(r.handle(up(VK.leftControl))).toEqual({ kind: 'recording' });
  });

  it('an ordinary key is recorded the moment it goes down', () => {
    const r = new HotkeyRecorder();
    expect(r.handle(down(F13))).toEqual({ kind: 'recorded', binding: { vk: F13, label: 'F13' } });
  });

  it('refuses keys that type, combinations, and the Windows key; Escape cancels', () => {
    expect(new HotkeyRecorder().handle(down(C))).toEqual({ kind: 'rejected', message: RECORDER_COPY.typingKey(C) });
    const combo = new HotkeyRecorder();
    combo.handle(down(VK.leftControl));
    expect(combo.handle(down(F5))).toEqual({ kind: 'rejected', message: RECORDER_COPY.combination });
    expect(new HotkeyRecorder().handle(down(VK.leftWin))).toEqual({ kind: 'rejected', message: RECORDER_COPY.windowsKey });
    expect(new HotkeyRecorder().handle(down(VK.escape))).toEqual({ kind: 'cancelled' });
  });
});

describe('names and warnings', () => {
  it('names keys the way the Mac names its own', () => {
    expect(hotkeyName(VK.rightControl)).toBe('Right Ctrl');
    expect(inlineName(VK.rightControl)).toBe('right Ctrl');
    expect(keycapLabels(VK.rightControl)).toEqual(['right', 'Ctrl']);
    expect(keycapLabels(F13)).toEqual(['F13']);
    expect(hotkeyName(0x87)).toBe('F24');
    expect(bindingFor(VK.rightControl)).toEqual({ vk: 163, label: 'Right Ctrl' });
  });

  it('the default is a modifier; F-keys, Caps Lock and navigation are allowed ordinary keys', () => {
    expect(kindOf(VK.rightControl)).toBe('modifier');
    expect(isAllowedKey(F13)).toBe(true);
    expect(isAllowedKey(VK.capsLock)).toBe(true);
    expect(isAllowedKey(VK.pageDown)).toBe(true);
    expect(isAllowedKey(C)).toBe(false);
    expect(isAllowedKey(0x20)).toBe(false); // Space
  });

  it('every preset is recordable and the default comes first', () => {
    expect(HOTKEY_PRESETS[0]).toBe(VK.rightControl);
    for (const vk of HOTKEY_PRESETS) expect(kindOf(vk) === 'modifier' || isAllowedKey(vk)).toBe(true);
  });

  it('warns about the left keys, AltGr, Shift, and says an ordinary key is swallowed', () => {
    expect(hotkeyWarnings(VK.rightControl)).toEqual([]);
    expect(hotkeyWarnings(VK.leftControl)[0]).toContain('Most shortcuts use the left Ctrl');
    expect(hotkeyWarnings(VK.rightAlt).join(' ')).toContain('AltGr');
    expect(hotkeyWarnings(VK.rightShift).join(' ')).toContain('capital letter');
    expect(hotkeyWarnings(F13).join(' ')).toContain('swallows F13');
  });
});
