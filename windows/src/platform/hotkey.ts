// The consumer half of the push-to-talk gesture. D-W4.  OWNER: t07
//
// `kotiba-hook.exe` reports transitions and has no policy (see its PROTOCOL.md). This
// file is all of the policy: which key is the hotkey, what a chord means, what a lost
// key-up means, and when the helper comes back.
//
// May use Node. May NOT import `electron`.
//
// ---------------------------------------------------------------------------------
// THE GESTURE
// ---------------------------------------------------------------------------------
//
//   hold Right Ctrl   → `pressed`,  the microphone opens
//   release it        → `released`, the dictation runs
//   press anything else while holding → `cancelled('chord')`, and the chord is left
//                                       entirely alone
//
// The third rule is D-W4 and it is not a nicety. Right Ctrl is a modifier: holding it
// and pressing V is the user pasting something, not dictating. Without the rule, every
// Ctrl chord on the machine would open the microphone, transcribe the room, and paste
// the result — while the chord itself still fired, because the hook never swallows.
//
// macOS has no such case (`HotkeyEvent` there is only `.pressed` and `.released`, and
// `DictationController.cancel()` is dead code for exactly that reason). Windows makes
// the cancel path live. This is the one place the do-not-port-dead-code rule is
// overruled, and it is overruled by a decision rather than by an oversight.
//
// ---------------------------------------------------------------------------------
// EDGES ARE NOT STATE, AND THE DIFFERENCE IS A STUCK MICROPHONE
// ---------------------------------------------------------------------------------
//
// `held` is inferred from edges. A single lost key-up therefore leaves it true forever:
// the microphone stays open, the HUD stays on Listening, and every subsequent press is
// refused as "still finishing the last one" for the life of the process. macOS pays for
// this with `resyncHeld()`, which re-samples the hardware whenever its event tap is
// re-enabled, and its own comment says re-enabling without resyncing is a known
// permanent-death bug.
//
// Two mechanisms cover it here:
//
//   * the helper sweeps the whole keyboard with `GetAsyncKeyState` before it installs
//     the hook and reports what is already down, so a restart never starts blind;
//   * this file refuses to trust a hold THE SWEEP reported. When the sweep says the
//     bound key is already down, the hotkey is IGNORED until it has been observed going
//     up (`awaitingRelease`).
//
// THAT SECOND RULE IS A DELIBERATE DIVERGENCE from macOS, which synthesises `.pressed`
// when it finds the key already down. On the Mac that opens the microphone for a key
// the user is holding for some other reason and then transcribes the room into whatever
// is focused. The purpose of `resyncHeld` was to prevent a stuck state, not to start a
// dictation nobody asked for, and the sweep achieves the purpose without the side
// effect. The cost is one wasted hold in a case that needs the app to have restarted
// its helper mid-press.
//
// AND IT IS CONDITIONAL ON THE SWEEP HAVING SAID SO, which is the whole of the fix for
// the bug this file shipped with. `awaitingRelease` used to start true on every start,
// restart and rebind, and was cleared only by an observed UP of the bound key. But the
// sweep emits DOWN only for keys PHYSICALLY HELD, so in the normal case — the key is up
// when the app launches — it emits nothing at all, and the user's first genuine press
// was eaten: its DOWN hit `if (awaitingRelease) return`, its UP merely flipped the flag,
// and zero events came out. Every 400 ms/5 s helper restart ate another one. The flag is
// now armed only by a DOWN the sweep produced, and never by anything else.
//
// TELLING A SWEEP DOWN FROM A REAL ONE is a question the wire cannot answer: PROTOCOL.md
// makes the sweep lines deliberately indistinguishable from real transitions, and the
// helper writes no marker between the sweep and the hook. What IS known is WHEN: the
// sweep is written synchronously before `SetWindowsHookEx` returns, so it is over within
// milliseconds of the helper starting, while a human's first press is hundreds of
// milliseconds away at best. `HOTKEY_SWEEP_WINDOW_MS` after a launch is therefore the
// sweep; after it, every DOWN is the user. Getting that wrong in the worst direction
// costs one swallowed press in the first quarter-second of a helper's life — the old
// behaviour, now confined to a window nobody presses in — rather than every first press.
//
// ---------------------------------------------------------------------------------
// 1.0: THE DECISIONS MOVED TO `src/core/hotkey`, AND THE HELPER LEARNT TWO WORDS
// ---------------------------------------------------------------------------------
//
// What a transition MEANS — press, release, chord, repeat — is `HotkeyTracker`, the port of
// the Mac's `HotkeyTracker`, and it is pure. Three things changed with it, all Mac parity:
//
//   * THE CHORD WINDOW. A key pressed within 1.5 s of the modifier cancels; a key bumped a
//     minute into a long dictation no longer throws the minute away. Modifiers and Caps
//     Lock are never a chord, as they are `flagsChanged` on the Mac.
//   * ORDINARY KEYS. F13–F24, Caps Lock, Pause… can be the hotkey. The helper is told
//     `SWALLOW <vk>` so their down, autorepeat and up never reach an app — the Mac's active
//     tap. A modifier binding sends `SWALLOW 0`: a modifier is observed, never eaten.
//   * RESYNC WHILE HELD. `POLL <vk>` every 250 ms while a hold is open, answered with
//     `STATE <vk> 0|1`. A key-up lost to a hook Windows silently removed, or to an
//     elevated window a normal-integrity hook cannot see, used to leave the microphone
//     open until the next press; with capture no longer capped at minutes that is a
//     microphone open indefinitely. Nothing is polled at idle.
//
// ---------------------------------------------------------------------------------
// WHAT MUST NOT BE LOGGED
// ---------------------------------------------------------------------------------
//
// The helper's stdout carries every key the user presses anywhere on the machine — it
// has to, because "any other key cancels" cannot be answered without seeing the other
// key. The containment obligation is stated in kotiba-hook/src/main.cpp and half of it
// lives here: a VK code that is not the hotkey is compared, counted, and dropped. It is
// never put in a note, a diagnostic, a log line or an error. `note()` below is wired to
// the diagnostics pane, and nothing that reaches it names a key the user pressed.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  HOOK_LINE_PATTERN,
  HOOK_STATE_PATTERN,
  hotkeyStartFailure,
  type CreateHotkeySource,
  type HotkeyBinding,
  type HotkeyEvent,
  type HotkeyRecordingResult,
  type HotkeySource,
  type Unsubscribe,
} from '../contracts/index.js';
import { HotkeyRecorder, HotkeyTracker, type HookInput } from '../core/hotkey/index.js';

/**
 * How quickly the helper is brought back after it dies.
 *
 * Zero would be a fork bomb against a helper that dies on startup. macOS retries its
 * event tap on a 5-second timer and never gives up, which is the right shape: the
 * hotkey is the app's only gesture, so an unrecoverable hook is an unusable app, and a
 * user who plugs in a misbehaving driver and unplugs it must get their app back without
 * restarting it.
 */
export const HOTKEY_RESTART_DELAY_MS = 400;

/** After this many consecutive deaths, back off to the macOS recovery cadence. */
export const HOTKEY_RAPID_RESTARTS = 3;
export const HOTKEY_SLOW_RESTART_DELAY_MS = 5_000;

/**
 * A helper that ran this long before dying was working, so its death is an incident
 * rather than a pattern and the backoff starts over.
 *
 * Without this the counter would be reset on every spawn and the backoff would never
 * engage — a helper that dies on startup would be respawned every 400 ms for as long as
 * the app runs, which is the fork bomb the backoff exists to prevent.
 */
export const HOTKEY_HEALTHY_AFTER_MS = 10_000;

/**
 * How long after a helper launch a `DOWN` of the bound key is read as the startup sweep
 * rather than as the user.
 *
 * The sweep runs before the hook is installed, so the helper is done with it within
 * single-digit milliseconds of starting; what this has to cover is the parent's side —
 * process creation and the first pipe read — on the 1-core CI-class machine this project
 * targets, where that can take a good fraction of a second under load.
 *
 * The trade is worth stating, because both ends of it are real. Too SHORT and a key held
 * at launch opens a dictation nobody asked for and transcribes the room. Too LONG and a
 * press inside the window is swallowed. Three quarters of a second is far past any
 * plausible spawn and far short of the time a person takes to reach for a key after their
 * app has started — and it stays under the 5 s slow-restart cadence, so a helper that is
 * crash-looping cannot spend the whole time inside a sweep window.
 */
export const HOTKEY_SWEEP_WINDOW_MS = 750;

/** While a hold is open, how often the helper is asked whether the key is really down. */
export const HOTKEY_HOLD_POLL_MS = 250;

export interface HotkeySourceOptions {
  /** Path to `kotiba-hook.exe`. */
  readonly helperPath: string;
  readonly binding: HotkeyBinding;
  /** Injected in tests. Defaults to `node:child_process.spawn`. */
  readonly spawnProcess?: (path: string) => ChildProcessWithoutNullStreams;
  /**
   * Diagnostics. NEVER receives a virtual-key code that is not the bound hotkey — see
   * the note above about what this stream carries.
   */
  readonly onNote?: (note: string) => void;
  readonly restartDelayMs?: number;
  readonly slowRestartDelayMs?: number;
  readonly healthyAfterMs?: number;
  /** Injected in tests, so "the startup sweep is over" is a fact rather than a wait. */
  readonly sweepWindowMs?: number;
  /** Injected in tests. */
  readonly holdPollMs?: number;
  /** Injected in tests, so "it ran for ten seconds" does not take ten seconds. */
  readonly now?: () => number;
}

/** The helper's stdin command that makes the binding's own key swallowed, or none. */
export function swallowCommand(binding: HotkeyBinding, recording: boolean): string {
  // Nothing is swallowed while recording: the user is pressing keys AT the recorder, and a
  // key eaten there is a key the recorder never sees.
  const tracker = new HotkeyTracker(binding.vk);
  return `SWALLOW ${String(!recording && tracker.kind === 'key' ? binding.vk : 0)}\n`;
}

export function createHotkeySource(options: HotkeySourceOptions): HotkeySource {
  const spawnProcess =
    options.spawnProcess ??
    ((path: string) => spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  const note = options.onNote ?? (() => {});
  const restartDelayMs = options.restartDelayMs ?? HOTKEY_RESTART_DELAY_MS;
  const slowRestartDelayMs = options.slowRestartDelayMs ?? HOTKEY_SLOW_RESTART_DELAY_MS;
  const healthyAfterMs = options.healthyAfterMs ?? HOTKEY_HEALTHY_AFTER_MS;
  const sweepWindowMs = options.sweepWindowMs ?? HOTKEY_SWEEP_WINDOW_MS;
  const holdPollMs = options.holdPollMs ?? HOTKEY_HOLD_POLL_MS;
  const now = options.now ?? (() => Date.now());

  let binding = options.binding;
  let child: ChildProcessWithoutNullStreams | null = null;
  let stdout = '';
  let stderrTail = '';
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let consecutiveFailures = 0;
  let startedAt = 0;
  let stopped = true;
  let failure: string | null = null;

  const listeners = new Set<(event: HotkeyEvent) => void>();

  // ---- the gesture's whole state, and there is deliberately very little of it -----
  /** Press, release, chord, repeat. The pure half; this file only feeds it. */
  let tracker = new HotkeyTracker(binding.vk);
  /**
   * The STARTUP SWEEP found the bound key down: ignore it until it has been seen going
   * up. Armed by nothing else — see the divergence note above.
   */
  let awaitingRelease = false;
  /** Until this instant, a `DOWN` of the bound key is the startup sweep, not the user. */
  let sweepUntil = 0;
  /** "Record new key" in progress: transitions go here instead of to the tracker. */
  let recorder: HotkeyRecorder | null = null;
  let recordingListener: ((result: HotkeyRecordingResult) => void) | null = null;

  function emit(event: HotkeyEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        // A listener that throws must not take the hook down with it — the gesture is
        // the app, and a broken HUD is not a reason to lose the microphone.
        note(`hotkey listener threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Write one command line to the helper. A helper that is gone is simply not told. */
  function tell(line: string): void {
    const process_ = child;
    if (process_ === null) return;
    try {
      process_.stdin.write(line);
    } catch {
      /* the close handler will restart it and re-send the binding */
    }
  }

  function watchHold(): void {
    if (tracker.isHeld && pollTimer === null) {
      pollTimer = setInterval(() => {
        tell(`POLL ${String(binding.vk)}\n`);
      }, holdPollMs);
      pollTimer.unref?.();
    } else if (!tracker.isHeld && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function deliver(event: 'pressed' | 'released' | 'cancelled' | null): void {
    watchHold();
    if (event === 'pressed') emit({ kind: 'pressed' });
    else if (event === 'released') emit({ kind: 'released' });
    else if (event === 'cancelled') emit({ kind: 'cancelled', reason: 'chord' });
  }

  /** Drop any open hold without emitting `released`. Used when the hold stops being trustworthy. */
  function abandonHold(reason: 'hookRestarted'): void {
    if (!tracker.isHeld) return;
    tracker.reset();
    watchHold();
    emit({ kind: 'cancelled', reason });
  }

  function handleTransition(edge: 'DOWN' | 'UP', vk: number, swallowed = false): void {
    const input: HookInput = { kind: edge === 'DOWN' ? 'down' : 'up', vk, swallowed };

    if (recorder !== null) {
      const result = recorder.handle(input);
      recordingListener?.(result);
      if (result.kind === 'recorded' || result.kind === 'cancelled') stopRecording();
      return;
    }

    if (vk === binding.vk) {
      if (edge === 'DOWN') {
        if (awaitingRelease) return; // a hold we did not see begin; wait for the key to come up
        if (now() < sweepUntil) {
          // The startup sweep, not a press. The key is genuinely down — the helper read the
          // hardware — so the eventual UP must be absorbed rather than orphaned, and no
          // dictation may open for a hold nobody started.
          awaitingRelease = true;
          return;
        }
      } else if (awaitingRelease) {
        awaitingRelease = false;
        return;
      }
    }
    // NOT the hotkey, or the hotkey itself: either way the tracker decides, and a code
    // that is not the hotkey is compared, counted and dropped inside it — never named.
    deliver(tracker.handle(input, now()));
  }

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const match = HOOK_LINE_PATTERN.exec(trimmed);
    if (match !== null) {
      const vk = Number.parseInt(match[2] as string, 10);
      handleTransition(match[1] === 'DOWN' ? 'DOWN' : 'UP', vk, match[3] !== undefined);
      return;
    }
    const state = HOOK_STATE_PATTERN.exec(trimmed);
    if (state !== null) {
      // Only the bound key is ever polled, so this names nothing the user typed.
      if (Number.parseInt(state[1] as string, 10) !== binding.vk || recorder !== null) return;
      const event = tracker.resync(state[2] === '1');
      if (event !== null) note('hotkey: a lost key-up was recovered by polling the key');
      deliver(event);
      return;
    }
    // Anything that is not a transition is a bug in the helper. It is recorded
    // without its content: a stray line could hold anything, and this stream is the
    // one place in the app where "anything" includes a password.
    note(`kotiba-hook wrote a line that is not a transition (${trimmed.length} chars)`);
  }

  function scheduleRestart(): void {
    if (stopped || restartTimer !== null) return;
    const delay = consecutiveFailures > HOTKEY_RAPID_RESTARTS ? slowRestartDelayMs : restartDelayMs;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopped) return;
      launch();
    }, delay);
    // Node must not be held awake by the retry timer; the app's own windows do that.
    restartTimer.unref?.();
  }

  function launch(): void {
    let process_: ChildProcessWithoutNullStreams;
    try {
      process_ = spawnProcess(options.helperPath);
    } catch (error) {
      consecutiveFailures += 1;
      const why = error instanceof Error ? error.message : String(error);
      failure = hotkeyStartFailure.helperMissing(options.helperPath).reason;
      note(`kotiba-hook would not start: ${why}`);
      scheduleRestart();
      return;
    }

    child = process_;
    startedAt = now();
    stdout = '';
    stderrTail = '';

    // A restart means the key-up that would have closed an open hold is gone, so the
    // hold cannot be trusted. Drop the dictation rather than leave it open — an open
    // dictation with no way to end it is the stuck microphone this whole file is
    // organised around. Every other key the old helper reported down is stale too.
    abandonHold('hookRestarted');
    tracker.forgetKeys();
    // A fresh helper sweeps again, so the window reopens. It is NOT armed here: a sweep
    // that reports nothing must leave the very next press admissible.
    awaitingRelease = false;
    sweepUntil = startedAt + sweepWindowMs;

    process_.stdout.setEncoding('utf8');
    process_.stdout.on('data', (chunk: string) => {
      if (child !== process_) return;
      stdout += chunk;
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        handleLine(line);
        newline = stdout.indexOf('\n');
      }
      // A helper that writes an unbounded line without a newline must not grow this
      // buffer forever. 4 KB is far past any legitimate transition line.
      if (stdout.length > 4096) stdout = '';
    });

    process_.stderr.setEncoding('utf8');
    process_.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2048);
    });
    // A helper that dies with a command half-written must not throw an EPIPE into main.
    process_.stdin.on?.('error', () => undefined);

    process_.on('error', (error: Error) => {
      if (child !== process_) return;
      child = null;
      consecutiveFailures += 1;
      failure = hotkeyStartFailure.helperMissing(options.helperPath).reason;
      note(`kotiba-hook would not start: ${error.message}`);
      abandonHold('hookRestarted');
      scheduleRestart();
    });

    process_.on('close', (code: number | null, signal: string | null) => {
      if (child !== process_) return;
      child = null;
      if (stopped) return; // we asked it to go; not a failure and not a restart
      // A helper that ran for a while was working. Its death is an incident, not a
      // pattern, so the backoff starts over rather than counting a week of uptime as a
      // failure streak.
      consecutiveFailures = now() - startedAt >= healthyAfterMs ? 1 : consecutiveFailures + 1;
      const how = signal !== null ? `killed by ${signal}` : `exited with code ${code ?? 'unknown'}`;
      const detail = stderrTail.trim().length > 0 ? `${how} — ${stderrTail.trim().slice(-300)}` : how;
      failure = hotkeyStartFailure.helperCrashed(detail).reason;
      note(`kotiba-hook ${detail}`);
      abandonHold('hookRestarted');
      scheduleRestart();
    });

    // The binding's swallow rule, first thing on every launch: a restarted helper starts
    // with none, and an F13 binding whose helper has forgotten it types into the app.
    tell(swallowCommand(binding, recorder !== null));

    // Optimistic: `spawn` has not failed yet, and a spawn that is going to fail reports
    // it on the `error` event a tick from now, which puts the sentence back. The tray
    // showing healthy for one tick is worth more than the tray showing broken every
    // time the helper is restarted successfully.
    //
    // `consecutiveFailures` is NOT cleared here. See HOTKEY_HEALTHY_AFTER_MS.
    failure = null;
  }

  function stopRecording(): void {
    if (recorder === null) return;
    recorder = null;
    recordingListener = null;
    tell(swallowCommand(binding, false));
  }

  return {
    async start(): Promise<void> {
      if (child !== null) return; // a silent no-op, as macOS's start() is
      stopped = false;
      consecutiveFailures = 0;
      launch();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      const process_ = child;
      child = null;
      // Drop an open hold without a `released`: the app is shutting the gesture down,
      // not finishing a dictation.
      tracker.forgetKeys();
      watchHold();
      awaitingRelease = false;
      sweepUntil = 0;
      failure = null;
      recorder = null;
      recordingListener = null;
      if (process_ === null) return;
      // Closing stdin is the helper's documented shutdown; the kill is the backstop for
      // one that has stopped reading it.
      try {
        process_.stdin.end();
      } catch {
        /* already gone */
      }
      try {
        process_.kill();
      } catch {
        /* already gone */
      }
    },

    onEvent(listener: (event: HotkeyEvent) => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async setBinding(next: HotkeyBinding): Promise<void> {
      if (next.vk === binding.vk) return;
      // No restart: the helper has no idea which key is the hotkey beyond the one it is
      // told to swallow, which is precisely why D-W4's "configurable from the first
      // release" costs nothing here.
      abandonHold('hookRestarted');
      binding = next;
      // A fresh tracker that KEEPS the picture of which keys are down — the stream's record
      // of held modifiers is still true. `held` is only ever set by a DOWN edge observed
      // from here on, so a key that is already down cannot open a dictation, and its
      // eventual UP finds nothing held.
      tracker = new HotkeyTracker(next.vk, tracker.keysDown());
      awaitingRelease = false;
      tell(swallowCommand(binding, recorder !== null));
      note(`hotkey rebound to ${next.label}`);
    },

    startRecording(listener: (result: HotkeyRecordingResult) => void): void {
      // Pressing the current hotkey to record it must not dictate, and an open hold is
      // not something the recorder can finish.
      abandonHold('hookRestarted');
      recorder = new HotkeyRecorder();
      recordingListener = listener;
      tell(swallowCommand(binding, true));
    },

    stopRecording,

    get failure(): string | null {
      return failure;
    },
  };
}

/**
 * The `CreateHotkeySource` factory the composition root wires. The extra options above
 * are for tests and for the diagnostics pane; the contract only promises these two.
 */
export const createHotkeySourceFactory: CreateHotkeySource = (options) =>
  createHotkeySource({ helperPath: options.helperPath, binding: options.binding });
