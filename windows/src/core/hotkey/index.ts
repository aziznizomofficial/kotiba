// Which key is the push-to-talk key, and every decision about it that needs no hook.
//
// PURE — the port of `Sources/KotibaPlatform/HotkeySpec.swift` (HotkeySpec, HotkeyTracker,
// HotkeyRecorder and the conflict warnings). `src/platform/hotkey.ts` is only the process
// that feeds `HotkeyTracker`, exactly as `PushToTalkMonitor` is only the tap that feeds it
// on the Mac. The renderer imports this file too, for the key names and the recorder
// copy, so it may import nothing but `src/contracts` — no zod, no Node, no bare specifier
// a `file://` page could not resolve.
//
// TWO SHAPES, as on macOS:
//
//   * a MODIFIER held on its own — Right Ctrl (the default, D-W4), Right Shift, Right Alt,
//     their left twins. Observed, never swallowed: it must keep working as a modifier in
//     every other app. A key pressed within 1.5 s of it is a shortcut and cancels.
//   * an ORDINARY KEY held down — F13–F24, Caps Lock, Pause… Swallowed by `kotiba-hook`
//     (down, autorepeat and up), so holding it types nothing and fires nothing. Held with
//     Ctrl, Alt or Windows it keeps its usual job: a combination is the system's.
//
// Windows virtual-key codes throughout — the numbers `kotiba-hook.exe` prints.

import type { HotkeyBinding, HotkeyRecordingResult } from '../../contracts/index.js';
import type { AppLanguage } from '../i18n/index.js';
import { appLanguage, t, tIn } from '../i18n/index.js';

// ---------------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------------

/** The sided modifier codes the hook reports. The generic 16/17/18 never arrive. */
export const VK = {
  leftShift: 0xa0,
  rightShift: 0xa1,
  leftControl: 0xa2,
  rightControl: 0xa3,
  leftAlt: 0xa4,
  rightAlt: 0xa5,
  leftWin: 0x5b,
  rightWin: 0x5c,
  capsLock: 0x14,
  escape: 0x1b,
  pause: 0x13,
  scrollLock: 0x91,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageUp: 0x21,
  pageDown: 0x22,
  apps: 0x5d,
  f1: 0x70,
  f13: 0x7c,
  f24: 0x87,
} as const;

/** The modifiers that can be the hotkey on their own. The Windows keys cannot (see below). */
const MODIFIER_CODES: ReadonlySet<number> = new Set<number>([
  VK.leftShift,
  VK.rightShift,
  VK.leftControl,
  VK.rightControl,
  VK.leftAlt,
  VK.rightAlt,
]);

/**
 * Keys that are part of a shortcut rather than the start of one. On the Mac these arrive
 * as `flagsChanged`, never as `keyDown`, so they never cancel a hold; here the hook
 * reports them as ordinary transitions and this set restores the Mac's meaning. Right
 * Ctrl then Shift is not a chord; Right Ctrl, Shift, then S is.
 */
const CHORD_NEUTRAL: ReadonlySet<number> = new Set<number>([
  ...MODIFIER_CODES,
  VK.leftWin,
  VK.rightWin,
  VK.capsLock,
  0x10, // VK_SHIFT, VK_CONTROL, VK_MENU — never emitted by the hook, named for safety
  0x11,
  0x12,
  // VK_PACKET: a character typed by SendInput(KEYEVENTF_UNICODE) — never a physical key.
  // kotiba-input types the PREVIOUS dictation this way while the next one is held
  // (overlapping presses); kotiba-hook 1.2.0 skips Kotiba's own keystrokes, and this is the
  // net under a hook that does not.
  0xe7,
]);

/**
 * Ctrl, Alt and the Windows keys: an ordinary key pressed under one of these is a
 * shortcut, not the hotkey — the Mac's `shortcutMask` (⌘ ⌥ ⌃), with Shift left out for
 * the same reason it is left out there. `kotiba-hook` applies the same rule before it
 * swallows, so a key it passes through is a key this file does not press on.
 */
const SHORTCUT_MODIFIERS: ReadonlySet<number> = new Set<number>([
  VK.leftControl,
  VK.rightControl,
  VK.leftAlt,
  VK.rightAlt,
  VK.leftWin,
  VK.rightWin,
]);

export type HotkeyKind = 'modifier' | 'key';

export function isModifierCode(vk: number): boolean {
  return MODIFIER_CODES.has(vk);
}

export function kindOf(vk: number): HotkeyKind {
  return isModifierCode(vk) ? 'modifier' : 'key';
}

/** `F13` for 0x7C. `null` for anything that is not F1–F24. */
function functionKeyNumber(vk: number): number | null {
  return vk >= VK.f1 && vk <= VK.f24 ? vk - VK.f1 + 1 : null;
}

/**
 * The sided modifiers, as a side and a key. The key's own name (Shift, Ctrl, Alt, Windows) is
 * what is printed on it and stays Latin in every language; the SIDE is a word, and translated.
 */
const SIDED_KEYS: Readonly<Record<number, { readonly side: 'left' | 'right'; readonly key: string }>> = {
  [VK.leftShift]: { side: 'left', key: 'Shift' },
  [VK.rightShift]: { side: 'right', key: 'Shift' },
  [VK.leftControl]: { side: 'left', key: 'Ctrl' },
  [VK.rightControl]: { side: 'right', key: 'Ctrl' },
  [VK.leftAlt]: { side: 'left', key: 'Alt' },
  [VK.rightAlt]: { side: 'right', key: 'Alt' },
  [VK.leftWin]: { side: 'left', key: 'Windows' },
  [VK.rightWin]: { side: 'right', key: 'Windows' },
};

const NAMED_KEYS: Readonly<Record<number, string>> = {
  [VK.capsLock]: 'Caps Lock',
  [VK.escape]: 'Escape',
  [VK.pause]: 'Pause',
  [VK.scrollLock]: 'Scroll Lock',
  [VK.insert]: 'Insert',
  [VK.home]: 'Home',
  [VK.end]: 'End',
  [VK.pageUp]: 'Page Up',
  [VK.pageDown]: 'Page Down',
  [VK.apps]: 'Menu',
  0x08: 'Backspace',
  0x09: 'Tab',
  0x0d: 'Enter',
  0x20: 'Space',
  0x25: '←',
  0x26: '↑',
  0x27: '→',
  0x28: '↓',
  0x2e: 'Delete',
  0x2c: 'Print Screen',
  0x90: 'Num Lock',
};

/** "Right Ctrl", "F13", "Caps Lock" — in the interface language. The one place a code becomes words. */
export function hotkeyName(vk: number, language: AppLanguage = appLanguage()): string {
  const f = functionKeyNumber(vk);
  if (f !== null) return `F${String(f)}`;
  const sided = SIDED_KEYS[vk];
  if (sided !== undefined) return tIn(language, sided.side === 'left' ? 'key.left' : 'key.right', { key: sided.key });
  const named = vk === VK.apps ? tIn(language, 'key.menu') : NAMED_KEYS[vk];
  if (named !== undefined) return named;
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  return tIn(language, 'key.code', { code: String(vk) });
}

/** The name inside a sentence: "Hold right Ctrl to dictate", "Hold F13 to dictate". */
export function inlineName(vk: number): string {
  const sided = SIDED_KEYS[vk];
  if (sided === undefined) return hotkeyName(vk);
  return t(sided.side === 'left' ? 'key.leftInline' : 'key.rightInline', { key: sided.key });
}

/** One label per key cap to draw: "right" "Ctrl", or a single "F13". */
export function keycapLabels(vk: number): readonly string[] {
  const sided = SIDED_KEYS[vk];
  if (sided !== undefined) return [t(sided.side === 'left' ? 'key.leftCap' : 'key.rightCap'), sided.key];
  return [hotkeyName(vk)];
}

/**
 * The persisted binding for a code. The label is derived, never typed by hand — and written
 * in English whatever the interface language, so the file does not change with it. Nothing
 * reads it back: every surface names the key from `vk`.
 */
export function bindingFor(vk: number): HotkeyBinding {
  return { vk, label: hotkeyName(vk, 'en') };
}

/**
 * Whether an ordinary key may be the hotkey. Everything that types or edits text is
 * refused, as on the Mac: swallowing it would stop that character working everywhere for
 * as long as Kotiba runs. Function keys, navigation, Pause, Scroll Lock, Caps Lock, Insert
 * and the Menu key are allowed.
 */
export function isAllowedKey(vk: number): boolean {
  if (functionKeyNumber(vk) !== null) return true;
  return [
    VK.capsLock,
    VK.pause,
    VK.scrollLock,
    VK.insert,
    VK.home,
    VK.end,
    VK.pageUp,
    VK.pageDown,
    VK.apps,
  ].includes(vk as never);
}

/** Offered in the pane, best first. */
export const HOTKEY_PRESETS: readonly number[] = [
  VK.rightControl,
  VK.rightShift,
  VK.rightAlt,
  VK.leftControl,
  VK.capsLock,
  0x7c, // F13
  0x7d,
  0x7e,
  0x7f,
  0x80,
  0x81,
  0x82, // F19
];

/** What this key will fight with, in words the pane can show. Empty is the normal case. */
export function hotkeyWarnings(vk: number): readonly string[] {
  const out: string[] = [];
  switch (vk) {
    case VK.leftControl:
    case VK.leftAlt:
    case VK.leftShift:
      out.push(t('hotkey.warn.leftModifier', { key: SIDED_KEYS[vk]?.key ?? hotkeyName(vk) }));
      break;
    case VK.rightAlt:
      out.push(t('hotkey.warn.altGr'));
      break;
    default:
      break;
  }
  if (vk === VK.leftShift || vk === VK.rightShift) {
    out.push(t('hotkey.warn.shift'));
  }
  if (!isModifierCode(vk)) {
    out.push(t('hotkey.warn.swallowed', { key: hotkeyName(vk) }));
  }
  return out;
}

// ---------------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------------

/** One transition from the hook, abstracted from the wire. */
export type HookInput =
  | { readonly kind: 'down'; readonly vk: number; readonly swallowed?: boolean }
  | { readonly kind: 'up'; readonly vk: number; readonly swallowed?: boolean };

export type TrackerEvent = 'pressed' | 'released' | 'cancelled';

/**
 * How long after the modifier goes down a key press still reads as a shortcut.
 *
 * Shortcuts are fast: Ctrl+C is the modifier and the letter inside a few hundred
 * milliseconds. A key pressed a minute into a dictation is not the user changing their
 * mind about the whole minute — cancelling there would throw away everything they said
 * because they bumped a key. Past the window the key goes through and the dictation
 * carries on. The macOS number.
 */
export const CHORD_WINDOW_MS = 1_500;

/**
 * Turns hook transitions into press / release / cancel for one binding. Not thread-safe
 * and does not need to be: one hotkey source owns one and feeds it from one stream.
 *
 * Autorepeat is DERIVED here rather than reported: the hook prints a `DOWN` for every
 * repeat, and a `DOWN` for a key this tracker already has down is a repeat.
 */
export class HotkeyTracker {
  readonly vk: number;
  readonly kind: HotkeyKind;
  #held = false;
  /** A chord was seen during this hold, so its release is not a dictation. */
  #chorded = false;
  #heldSince = 0;
  /** Every key the stream says is down right now. Repeat detection and the shortcut rule. */
  readonly #down = new Set<number>();

  /** `keysDown` carries the picture of the keyboard over from a previous tracker (a rebind). */
  constructor(vk: number, keysDown: Iterable<number> = []) {
    this.vk = vk;
    this.kind = kindOf(vk);
    for (const key of keysDown) this.#down.add(key);
  }

  /** Every key the stream says is down. For handing over to a rebound tracker. */
  keysDown(): readonly number[] {
    return [...this.#down];
  }

  get isHeld(): boolean {
    return this.#held;
  }

  /** Whether Ctrl, Alt or a Windows key is down, as far as the stream has said. */
  shortcutModifierHeld(): boolean {
    for (const vk of this.#down) if (SHORTCUT_MODIFIERS.has(vk)) return true;
    return false;
  }

  handle(input: HookInput, now: number): TrackerEvent | null {
    const isRepeat = input.kind === 'down' && this.#down.has(input.vk);
    if (input.kind === 'down') this.#down.add(input.vk);
    else this.#down.delete(input.vk);
    return this.kind === 'modifier'
      ? this.#handleModifier(input, isRepeat, now)
      : this.#handleKey(input, isRepeat);
  }

  #handleModifier(input: HookInput, isRepeat: boolean, now: number): TrackerEvent | null {
    if (input.vk === this.vk) {
      if (input.kind === 'down') {
        if (this.#held) return null; // the edge guard; modifiers do not autorepeat anyway
        this.#held = true;
        this.#chorded = false;
        this.#heldSince = now;
        return 'pressed';
      }
      if (!this.#held) return null;
      this.#held = false;
      const wasChord = this.#chorded;
      this.#chorded = false;
      return wasChord ? null : 'released';
    }
    // Right Ctrl then C is Ctrl+C. Said once, and the key goes through untouched — the
    // hook never swallows a modifier's partner.
    if (
      input.kind !== 'down' ||
      !this.#held ||
      this.#chorded ||
      isRepeat ||
      CHORD_NEUTRAL.has(input.vk) ||
      now - this.#heldSince > CHORD_WINDOW_MS
    ) {
      return null;
    }
    this.#chorded = true;
    return 'cancelled';
  }

  #handleKey(input: HookInput, isRepeat: boolean): TrackerEvent | null {
    if (input.vk !== this.vk) return null;
    if (input.kind === 'down') {
      // Autorepeat, every 30-odd ms for as long as the key is down. `kotiba-hook` swallows
      // it; here it is simply not a second press.
      if (this.#held || isRepeat) return null;
      // Ctrl+F13 belongs to someone else. The hook passed it through; so does this. A
      // down the hook SWALLOWED is ours whatever this record says: the hook checked the
      // real keyboard, and a Ctrl key-up lost here must not disable the binding for good.
      if (input.swallowed !== true && this.shortcutModifierHeld()) return null;
      if (input.swallowed === true) {
        for (const vk of SHORTCUT_MODIFIERS) this.#down.delete(vk);
      }
      this.#held = true;
      return 'pressed';
    }
    if (!this.#held) return null;
    this.#held = false;
    return 'released';
  }

  /**
   * Reconcile with what the hardware reports NOW, after an edge may have been lost —
   * a hook removed by `LowLevelHooksTimeout`, input to an elevated window that a
   * non-elevated hook never sees. Polled four times a second while a hold is active.
   *
   * Only the lost KEY-UP is recovered. A key found down that the stream never reported
   * does not open a dictation: that is the deliberate Windows divergence documented in
   * `src/platform/hotkey.ts` (the sweep), and a poll must not reintroduce what the sweep
   * rule removed.
   */
  resync(keyIsDown: boolean): TrackerEvent | null {
    if (!this.#held || keyIsDown) return null;
    this.#held = false;
    this.#down.delete(this.vk);
    const wasChord = this.#chorded;
    this.#chorded = false;
    return wasChord ? null : 'released';
  }

  /** Forget the current hold without reporting it — the source is re-keyed or recording. */
  reset(): void {
    this.#held = false;
    this.#chorded = false;
  }

  /** Forget every key, too. A helper restart makes the whole picture stale. */
  forgetKeys(): void {
    this.reset();
    this.#down.clear();
  }
}

// ---------------------------------------------------------------------------------
// Recording a new key
// ---------------------------------------------------------------------------------

export type RecorderResult = HotkeyRecordingResult;

export const RECORDER_COPY = {
  get combination(): string {
    return t('hotkey.rec.combination');
  },
  get windowsKey(): string {
    return t('hotkey.rec.windowsKey');
  },
  typingKey: (vk: number): string => t('hotkey.rec.typingKey', { key: hotkeyName(vk) }),
} as const;

/**
 * Turns what the user presses in "Record new key" into a binding.
 *
 * A modifier becomes the binding when it goes down and comes back up with nothing else
 * pressed in between — the gesture the user will actually make. An ordinary key becomes
 * the binding the moment it goes down. Escape abandons recording. The macOS recorder,
 * fed by the hook itself rather than by the window's key events, so what is recorded is
 * exactly the code the hook will later report — sided, and including F13–F24, which a
 * browser `KeyboardEvent` does not reliably name.
 */
export class HotkeyRecorder {
  #candidate: number | null = null;
  readonly #down = new Set<number>();

  handle(input: HookInput): RecorderResult {
    if (isModifierCode(input.vk)) return this.#modifier(input.vk, input.kind === 'down');
    if (input.kind === 'up') {
      this.#down.delete(input.vk);
      return { kind: 'recording' };
    }
    if (this.#down.has(input.vk)) return { kind: 'recording' }; // autorepeat
    return this.#key(input.vk);
  }

  #modifier(vk: number, isDown: boolean): RecorderResult {
    if (isDown) {
      if (this.#down.has(vk)) return { kind: 'recording' }; // repeat
      // A second modifier makes it a combination.
      this.#candidate = [...this.#down].some(isModifierCode) ? null : vk;
      this.#down.add(vk);
      return { kind: 'recording' };
    }
    this.#down.delete(vk);
    const nothingElseDown = ![...this.#down].some(isModifierCode);
    if (this.#candidate === vk && nothingElseDown) {
      this.#candidate = null;
      return { kind: 'recorded', binding: bindingFor(vk) };
    }
    return { kind: 'recording' };
  }

  #key(vk: number): RecorderResult {
    if (vk === VK.escape) return { kind: 'cancelled' };
    this.#candidate = null;
    if (vk === VK.leftWin || vk === VK.rightWin) {
      return { kind: 'rejected', message: RECORDER_COPY.windowsKey };
    }
    if ([...this.#down].some(isModifierCode)) {
      return { kind: 'rejected', message: RECORDER_COPY.combination };
    }
    this.#down.add(vk);
    if (!isAllowedKey(vk)) return { kind: 'rejected', message: RECORDER_COPY.typingKey(vk) };
    return { kind: 'recorded', binding: bindingFor(vk) };
  }
}
