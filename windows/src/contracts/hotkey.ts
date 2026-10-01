// The push-to-talk gesture.
//
// Ported from `HotkeyEvent` / `PushToTalkMonitor` (Sources/KotibaPlatform/Hotkey.swift),
// with the one change D-W4 forces.

/**
 * D-W4. macOS holds right ⌘. Windows has no Command key, so the app's central gesture
 * changes on day one: **hold Right Ctrl**, configurable from the first release.
 *
 * Right Alt was the obvious alternative and is REJECTED: it is AltGr on Central Asian
 * and European layouts, where it is a live modifier for typing characters. Right Ctrl
 * is reachable by the same thumb, is not a dead-key modifier on any layout this
 * audience uses, and is almost never pressed alone.
 */
export const DEFAULT_HOTKEY_VK = 163; // VK_RCONTROL, 0xA3

/**
 * What the hook reports.
 *
 * macOS `HotkeyEvent` has exactly two cases, and 02-BEHAVIOUR §3 lists
 * `DictationController.cancel()` as dead code for that reason — there is no cancel
 * gesture on the Mac. **Windows adds one, deliberately**, because D-W4 requires it:
 * holding Right Ctrl and pressing V is the user copying something, not dictating, so
 * any other key pressed during the hold cancels the dictation and lets the chord be.
 *
 * So `cancelled` is a real, live third case here, and the cancel path that is dead on
 * macOS is live on Windows. This is the one place the dead-code rule is overruled, and
 * it is overruled by a decision, not by an oversight.
 */
export type HotkeyEvent =
  | { readonly kind: 'pressed' }
  | { readonly kind: 'released' }
  | { readonly kind: 'cancelled'; readonly reason: HotkeyCancelReason };

export const HOTKEY_CANCEL_REASONS = ['chord', 'hookRestarted'] as const;
/**
 * `chord` — another key went down while the hotkey was held.
 * `hookRestarted` — the hook process died mid-hold and was restarted, so the key-up is
 * gone; the hold cannot be trusted and the dictation is dropped rather than left open.
 */
export type HotkeyCancelReason = (typeof HOTKEY_CANCEL_REASONS)[number];

/**
 * Two hard requirements on the hook, both of which are how this goes wrong.
 *
 * OBSERVE, NEVER SWALLOW. The low-level hook must pass the key through. Eating Right
 * Ctrl would break every Ctrl chord in every other app. macOS gets this from a
 * listen-only event tap; Windows gets it by returning `CallNextHookEx` unconditionally.
 *
 * RESYNC AFTER ANY GAP. `isHeld` is inferred purely from edges, so a lost key-up leaves
 * it stuck true forever: microphone open, HUD stuck on Listening, every subsequent
 * press swallowed. macOS re-samples the hardware modifier state whenever its tap is
 * re-enabled; the Windows hook must do the equivalent (`GetAsyncKeyState`) whenever it
 * restarts, and the main process must treat a hook restart as a cancel.
 */
export const HOTKEY_OBSERVE_ONLY = true;

/** Why the hook could not start. Windows needs no permission grant for this (D-W8). */
export type HotkeyStartFailure =
  | { readonly kind: 'hookRefused'; readonly reason: string }
  | { readonly kind: 'helperMissing'; readonly path: string; readonly reason: string }
  | { readonly kind: 'helperCrashed'; readonly why: string; readonly reason: string };

export const hotkeyStartFailure = {
  hookRefused(why: string): HotkeyStartFailure {
    return { kind: 'hookRefused', reason: `Windows refused the keyboard hook — ${why}` };
  },
  helperMissing(path: string): HotkeyStartFailure {
    return {
      kind: 'helperMissing',
      path,
      reason: `the push-to-talk helper is missing at ${path} — reinstall Kotiba`,
    };
  },
  helperCrashed(why: string): HotkeyStartFailure {
    return {
      kind: 'helperCrashed',
      why,
      reason: `the push-to-talk helper stopped — ${why}`,
    };
  },
} as const;

/**
 * The wire format `kotiba-hook.exe` speaks on its stdout: one line per edge,
 * `DOWN <vk>` or `UP <vk>`, decimal, no padding. Anything else on stdout is a bug in
 * the helper and must be logged, not parsed.
 */
export const HOOK_LINE_PATTERN = /^(DOWN|UP) (\d{1,3})( S)?$/;

/*
 * The optional ` S` (kotiba-hook 1.1.1) marks a transition the helper SWALLOWED — the one
 * ordinary key it was told to hold back, pressed with no Ctrl, Alt or Windows key down.
 * The helper read the real keyboard to decide that, so the consumer trusts the mark over
 * its own record of which modifiers are down, which a lost key-up can leave stale.
 */

/**
 * The answer to a `POLL <vk>` written on the helper's stdin: `STATE <vk> 1` when the key
 * is physically down now, `STATE <vk> 0` when it is not (`GetAsyncKeyState`, high bit).
 * Asked four times a second while a hold is active and never at idle — the Windows twin
 * of the Mac's 250 ms `resyncHeld`. A helper older than 1.0 never answers, and a hold
 * then simply ends on its key-up as before.
 */
export const HOOK_STATE_PATTERN = /^STATE (\d{1,3}) ([01])$/;

/** What "Record new key" reports, one result per hook transition while recording. */
export type HotkeyRecordingResult =
  | { readonly kind: 'recording' }
  | { readonly kind: 'recorded'; readonly binding: { readonly vk: number; readonly label: string } }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'rejected'; readonly message: string };
