// The push-to-talk gesture, against a real child process speaking the real protocol.
//
// Everything here runs on a Mac and a Linux runner. What it CANNOT cover is the helper
// itself: `WH_KEYBOARD_LL` compiles only on Windows and has never executed anywhere in
// this project. So these tests pin the consumer's half — the state machine, the
// restart, the refusal to trust a hold it did not see begin — and CI compiles the C++.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_HOTKEY, HOOK_LINE_PATTERN, type HotkeyEvent } from '../../src/contracts/index.js';
import { createHotkeySource } from '../../src/platform/hotkey.js';

const FAKE_HOOK = fileURLToPath(new URL('./fake-hook.mjs', import.meta.url));

const RIGHT_CTRL = DEFAULT_HOTKEY.vk; // 163
const LEFT_CTRL = 162;
const V = 86;

interface Harness {
  readonly events: HotkeyEvent[];
  readonly notes: string[];
  readonly source: ReturnType<typeof createHotkeySource>;
  /**
   * Declare the helper's startup sweep finished, so every line after this is the user.
   *
   * NOT a convenience. `DOWN 163` from the sweep and `DOWN 163` from a thumb are the
   * same eleven bytes — PROTOCOL.md says so on purpose — and the consumer tells them
   * apart by when they arrive relative to the helper's launch. A test that wants a
   * genuine press says so by moving the clock past that window; a test that wants a key
   * already held at startup simply does not call this. Nothing here waits on wall time.
   *
   * The window this harness gives the source is a minute wide and the jump is ten, so
   * which side of it a line falls on is decided HERE and never by how long node took to
   * boot. Leaning on the production 750 ms instead made the sweep tests flaky on a busy
   * machine: the fake had not written its first line yet when the window closed.
   *
   * Every script in this file used to open with a synthetic `UP 163` instead. The real
   * helper never writes that line, and its presence is what hid the bug: the first press
   * of every real session was swallowed, and every test had already spent the flag.
   */
  endStartupSweep(): void;
}

/** Spawn the fake with a script of lines, collect what the consumer makes of them. */
function harness(
  lines: string[],
  extra: {
    exit?: number;
    restartDelayMs?: number;
    sweepAfterLines?: number;
    /** What the fake answers to `POLL`: '1' held, '0' up, 'none' silent. */
    state?: string;
    /** A file the fake appends every stdin command to. */
    log?: string;
    binding?: { vk: number; label: string };
    holdPollMs?: number;
  } = {},
): Harness {
  const events: HotkeyEvent[] = [];
  const notes: string[] = [];
  let clockSkew = 0;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    KOTIBA_FAKE_HOOK_LINES: lines.join(';'),
  };
  if (extra.exit !== undefined) environment['KOTIBA_FAKE_HOOK_EXIT'] = String(extra.exit);
  if (extra.state !== undefined) environment['KOTIBA_FAKE_HOOK_STATE'] = extra.state;
  if (extra.log !== undefined) environment['KOTIBA_FAKE_HOOK_LOG'] = extra.log;

  const spawnProcess = (path: string): ChildProcessWithoutNullStreams => {
    const child = spawn(process.execPath, [path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
    });
    // `sweepAfterLines` is for the one shape `endStartupSweep()` cannot express: a sweep
    // that DID report something, followed by a genuine press. The boundary has to fall
    // between two lines of the same script, so it is counted off the pipe rather than
    // guessed from a delay — this listener is attached before the source's, so it sees
    // every chunk first and the window closes before the source reads the next line.
    const after = extra.sweepAfterLines;
    if (after !== undefined) {
      let seen = 0;
      let buffered = '';
      child.stdout.on('data', (chunk: Buffer | string) => {
        if (seen >= after) return;
        buffered += chunk.toString();
        for (let nl = buffered.indexOf('\n'); nl >= 0 && seen < after; nl = buffered.indexOf('\n')) {
          seen += 1;
          buffered = buffered.slice(nl + 1);
        }
        if (seen >= after) clockSkew += 600_000;
      });
    }
    return child;
  };

  const source = createHotkeySource({
    helperPath: FAKE_HOOK,
    binding: extra.binding ?? DEFAULT_HOTKEY,
    spawnProcess,
    ...(extra.holdPollMs === undefined ? {} : { holdPollMs: extra.holdPollMs }),
    onNote: (note) => notes.push(note),
    restartDelayMs: extra.restartDelayMs ?? 20,
    slowRestartDelayMs: extra.restartDelayMs ?? 20,
    sweepWindowMs: 60_000,
    now: () => Date.now() + clockSkew,
  });
  source.onEvent((event) => events.push(event));
  return {
    events,
    notes,
    source,
    endStartupSweep: () => {
      clockSkew += 600_000;
    },
  };
}

const kinds = (events: HotkeyEvent[]): string[] =>
  events.map((event) => (event.kind === 'cancelled' ? `cancelled:${event.reason}` : event.kind));

// A real child process, over a real pipe, on whatever the OS scheduler feels like giving
// it — a fixed sleep here is a bet on how fast that is. `waitFor` polls instead of
// betting: the pass path is driven entirely by the predicate becoming true, and the
// ceiling only exists to turn a genuine hang into a clear failure rather than an
// infinite one. On the 1-core / 2-thread Windows CI VM this project targets (measured
// 2026-08-11) a busy neighbour can make a spawn+pipe round trip take seconds where an
// idle Mac takes tens of milliseconds, so the ceiling is generous on purpose.
async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`condition not met within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * For "nothing happened" assertions, absence cannot be polled for — only waited out. The
 * script itself never sleeps longer than a few tens of ms between lines, so 1 second is
 * a large multiple of the slowest thing under test and still small next to vitest's
 * default 5-second per-test timeout.
 */
const NOTHING_HAPPENED_MS = 1_000;
const settle = (ms = NOTHING_HAPPENED_MS): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the wire format', () => {
  it('accepts exactly what the helper promises to write', () => {
    expect(HOOK_LINE_PATTERN.exec('DOWN 163')?.[2]).toBe('163');
    expect(HOOK_LINE_PATTERN.exec('UP 8')?.[2]).toBe('8');
    // Not a transition, and each of these has been a real bug in a line-oriented
    // protocol somewhere: a trailing CR, a padded number, a lowercase edge.
    expect(HOOK_LINE_PATTERN.exec('DOWN 163\r')).toBeNull();
    expect(HOOK_LINE_PATTERN.exec('DOWN 0163')).toBeNull();
    expect(HOOK_LINE_PATTERN.exec('down 163')).toBeNull();
    expect(HOOK_LINE_PATTERN.exec('DOWN')).toBeNull();
    // 1.1.1: a swallowed transition carries ` S`, and nothing else may follow.
    expect(HOOK_LINE_PATTERN.exec('DOWN 124 S')?.[3]).toBe(' S');
    expect(HOOK_LINE_PATTERN.exec('DOWN 124 X')).toBeNull();
  });
});

describe('press and hold', () => {
  it('opens on the key going down and closes on it coming up', async () => {
    const h = harness([`DOWN ${RIGHT_CTRL}`, '@30', `UP ${RIGHT_CTRL}`]);
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 2);
    expect(kinds(h.events)).toEqual(['pressed', 'released']);
    await h.source.stop();
  });

  it('ignores the left-hand key entirely', async () => {
    // Half the keyboard shortcuts on the machine are Left Ctrl. The gesture is the
    // RIGHT key and nothing else — this is the single most expensive thing to get wrong.
    const h = harness([`DOWN ${LEFT_CTRL}`, `UP ${LEFT_CTRL}`]);
    await h.source.start();
    h.endStartupSweep();
    await settle();
    expect(kinds(h.events)).toEqual([]);
    await h.source.stop();
  });

  it('collapses a repeated key-down into one press', async () => {
    const h = harness([
      `DOWN ${RIGHT_CTRL}`,
      `DOWN ${RIGHT_CTRL}`,
      `DOWN ${RIGHT_CTRL}`,
      `UP ${RIGHT_CTRL}`,
    ]);
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 2);
    expect(kinds(h.events)).toEqual(['pressed', 'released']);
    await h.source.stop();
  });

  it('survives a line arriving one byte at a time', async () => {
    const h = harness([`DOWN ${RIGHT_CTRL}`, '@split', `UP ${RIGHT_CTRL}`]);
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 2);
    expect(kinds(h.events)).toEqual(['pressed', 'released']);
    await h.source.stop();
  });

  it('drives ten consecutive holds without latching', async () => {
    // Ten, not two. The macOS admission bug refused every press after the first for the
    // life of the process, and a two-press test would not have caught it.
    const lines: string[] = [];
    for (let i = 0; i < 10; i += 1) lines.push(`DOWN ${RIGHT_CTRL}`, `UP ${RIGHT_CTRL}`);
    const h = harness(lines);
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 20);
    expect(h.events.filter((event) => event.kind === 'pressed')).toHaveLength(10);
    expect(h.events.filter((event) => event.kind === 'released')).toHaveLength(10);
    await h.source.stop();
  });
});

describe('a chord is not a dictation', () => {
  it('cancels when another key goes down during the hold, and stays silent on the key-up', async () => {
    // D-W4: holding Right Ctrl and pressing V is the user pasting something. The chord
    // itself is left alone — the helper never swallowed it — and no dictation happens.
    const h = harness([
      `DOWN ${RIGHT_CTRL}`,
      `DOWN ${V}`,
      `UP ${V}`,
      `UP ${RIGHT_CTRL}`,
    ]);
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 2);
    expect(kinds(h.events)).toEqual(['pressed', 'cancelled:chord']);
    await h.source.stop();
  });

  it('cancels once, however many keys the chord uses', async () => {
    const h = harness([
      `DOWN ${RIGHT_CTRL}`,
      `DOWN ${V}`,
      'DOWN 67',
      'DOWN 88',
      `UP ${RIGHT_CTRL}`,
    ]);
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 2);
    expect(kinds(h.events)).toEqual(['pressed', 'cancelled:chord']);
    await h.source.stop();
  });

  it('lets the next hold work normally', async () => {
    const h = harness([
      `DOWN ${RIGHT_CTRL}`,
      `DOWN ${V}`,
      `UP ${RIGHT_CTRL}`,
      '@20',
      `DOWN ${RIGHT_CTRL}`,
      `UP ${RIGHT_CTRL}`,
    ]);
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 4);
    expect(kinds(h.events)).toEqual(['pressed', 'cancelled:chord', 'pressed', 'released']);
    await h.source.stop();
  });

  it('ignores other keys pressed while nothing is held', async () => {
    const h = harness([`DOWN ${V}`, `UP ${V}`, 'DOWN 65', 'UP 65']);
    await h.source.start();
    h.endStartupSweep();
    await settle();
    expect(kinds(h.events)).toEqual([]);
    await h.source.stop();
  });
});

describe('a hold it did not see begin', () => {
  it('ignores a hotkey the startup sweep reports as already down', async () => {
    // The helper sweeps the keyboard before installing the hook, so a key held at
    // startup arrives as a DOWN. Opening the microphone for it would transcribe the
    // room into whatever is focused, for a key the user is holding for another reason.
    // macOS synthesises `.pressed` here; this is the deliberate divergence.
    //
    // `endStartupSweep` is deliberately NOT called: this script IS the sweep.
    const h = harness([`DOWN ${RIGHT_CTRL}`, '@20', `UP ${RIGHT_CTRL}`]);
    await h.source.start();
    await settle();
    expect(kinds(h.events)).toEqual([]);
    await h.source.stop();
  });

  it('works normally on the next real press', async () => {
    // Two lines of sweep — the key was held when the helper started — and then the user
    // lets go and presses properly.
    const h = harness(
      [
        `DOWN ${RIGHT_CTRL}`,
        '@20',
        `UP ${RIGHT_CTRL}`,
        '@40',
        `DOWN ${RIGHT_CTRL}`,
        '@20',
        `UP ${RIGHT_CTRL}`,
      ],
      { sweepAfterLines: 2 },
    );
    await h.source.start();
    await waitFor(() => h.events.length >= 2);
    expect(kinds(h.events)).toEqual(['pressed', 'released']);
    await h.source.stop();
  });

  it('admits the FIRST press when the sweep reported nothing — the normal case', async () => {
    // THE REGRESSION. `awaitingRelease` used to start true on every launch and was
    // cleared only by an observed UP of the bound key. The sweep emits DOWN only for
    // keys physically held, so when the key is up at launch — which is the normal case,
    // every launch — it emits nothing, and this exact script produced ONE pressed pair
    // instead of two: the first DOWN was dropped, the first UP only flipped the flag.
    //
    // Two holds, no synthetic UP in front of them, because the helper never writes one.
    const h = harness([
      `DOWN ${RIGHT_CTRL}`,
      '@20',
      `UP ${RIGHT_CTRL}`,
      '@20',
      `DOWN ${RIGHT_CTRL}`,
      '@20',
      `UP ${RIGHT_CTRL}`,
    ]);
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 4);
    expect(kinds(h.events)).toEqual(['pressed', 'released', 'pressed', 'released']);
    await h.source.stop();
  });
});

describe('when the helper dies', () => {
  it('drops an open hold rather than leaving the microphone on', async () => {
    // A lost key-up is the stuck-microphone bug: held stays true, the HUD stays on
    // Listening, and every subsequent press is refused for the life of the process.
    const h = harness([`DOWN ${RIGHT_CTRL}`], { exit: 3 });
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => kinds(h.events).includes('pressed') && kinds(h.events).includes('cancelled:hookRestarted'));
    expect(kinds(h.events)).toContain('pressed');
    expect(kinds(h.events)).toContain('cancelled:hookRestarted');
    await h.source.stop();
  });

  it('records a sentence for the tray and brings the helper back', async () => {
    const h = harness([], { exit: 3, restartDelayMs: 20 });
    await h.source.start();
    await waitFor(() => h.notes.some((note) => note.includes('exited with code 3')));
    expect(h.notes.some((note) => note.includes('kotiba-hook'))).toBe(true);
    // It restarted at least once — the fake exits every time, so the count only grows.
    expect(h.notes.filter((note) => note.includes('exited with code 3')).length).toBeGreaterThan(0);
    await h.source.stop();
  });

  it('reports a missing helper instead of throwing', async () => {
    const events: HotkeyEvent[] = [];
    const notes: string[] = [];
    const source = createHotkeySource({
      helperPath: '/nonexistent/kotiba-hook.exe',
      binding: DEFAULT_HOTKEY,
      onNote: (note) => notes.push(note),
      restartDelayMs: 10_000, // do not thrash the test runner
    });
    source.onEvent((event) => events.push(event));
    await source.start();
    await waitFor(() => source.failure !== null);
    expect(source.failure).not.toBeNull();
    expect(source.failure).toContain('reinstall Kotiba');
    expect(events).toEqual([]);
    await source.stop();
  });

  it('stops restarting once stopped', async () => {
    const h = harness([], { exit: 1, restartDelayMs: 20 });
    await h.source.start();
    // Wait for at least one restart cycle to actually have happened before stopping —
    // otherwise "nothing restarted after stop" would pass vacuously because nothing had
    // restarted yet either way.
    await waitFor(() => h.notes.length > 0);
    await h.source.stop();
    const after = h.notes.length;
    // Proving a negative (no further restart) genuinely needs a real wait: well above
    // the 20 ms restartDelayMs, so a timer that survived stop() would have fired.
    await settle();
    expect(h.notes.length).toBe(after);
    expect(h.source.failure).toBeNull();
  });
});

describe('a line that is not a transition', () => {
  it('is recorded without its content and changes nothing', async () => {
    // The stream carries every key the user presses. A stray line could hold anything,
    // and "anything" here includes a password, so the note counts characters and stops.
    const h = harness([
      'hello there',
      'DOWN 1234', // four digits: the helper promises 1..254, so this is not a transition
      `DOWN ${RIGHT_CTRL}`,
      `UP ${RIGHT_CTRL}`,
    ]);
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 2);
    expect(kinds(h.events)).toEqual(['pressed', 'released']);
    const strays = h.notes.filter((note) => note.includes('not a transition'));
    expect(strays.length).toBe(2);
    expect(strays.join(' ')).not.toContain('hello there');
    await h.source.stop();
  });
});

describe('rebinding', () => {
  it('takes effect without restarting the helper — the helper has no policy', async () => {
    const h = harness([
      '@60',
      `DOWN ${LEFT_CTRL}`,
      '@20',
      `UP ${LEFT_CTRL}`,
      '@20',
      `DOWN ${LEFT_CTRL}`,
      `UP ${LEFT_CTRL}`,
    ]);
    // setBinding is a synchronous state change with no dependency on the child having
    // produced anything yet, so calling it immediately after start() — rather than
    // racing it against the script's own `@60` delay with a guessed pre-wait — makes the
    // ordering (rebind before the first Left Ctrl DOWN) true by construction instead of
    // by timing luck.
    await h.source.start();
    h.endStartupSweep();
    await h.source.setBinding({ vk: LEFT_CTRL, label: 'Left Ctrl' });
    await waitFor(() => h.events.length >= 4);
    // BOTH holds work. The rebind used to arm `awaitingRelease`, which ate the first
    // press of the key the user had just chosen — and a picker that commits on key-UP
    // never delivers the UP that would have cleared it, so it ate one press for nothing.
    // `held` is only ever set by a DOWN edge this file saw, so a key that is already down
    // at the rebind cannot open a dictation without that flag either.
    expect(kinds(h.events)).toEqual(['pressed', 'released', 'pressed', 'released']);
    await h.source.stop();
  });
});

// ---------------------------------------------------------------------------------
// 1.0: the swallowed ordinary key, the chord window, resync while held, the recorder
// ---------------------------------------------------------------------------------

describe('1.0 — what the source tells the helper, and what it asks', () => {
  const F13 = 0x7c;

  function logFile(): string {
    return join(mkdtempSync(join(tmpdir(), 'kotiba-hook-log-')), 'commands.txt');
  }
  const commands = (path: string): string[] =>
    existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0) : [];

  it('a modifier binding swallows nothing; an F13 binding asks for F13 to be swallowed', async () => {
    const log = logFile();
    const h = harness([], { log });
    await h.source.start();
    await waitFor(() => commands(log).includes('SWALLOW 0'));
    await h.source.setBinding({ vk: F13, label: 'F13' });
    await waitFor(() => commands(log).includes(`SWALLOW ${String(F13)}`));
    await h.source.stop();
  });

  it('an F13 hold opens and closes; its autorepeat is not a second press', async () => {
    const h = harness([`DOWN ${String(F13)}`, `DOWN ${String(F13)}`, `DOWN ${String(F13)}`, '@20', `UP ${String(F13)}`], {
      binding: { vk: F13, label: 'F13' },
      sweepAfterLines: 0,
    });
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 2);
    expect(kinds(h.events)).toEqual(['pressed', 'released']);
    await h.source.stop();
  });

  it('polls a held key four times a second, and a lost key-up is RECOVERED', async () => {
    // The hold opens and its UP never arrives — a hook Windows removed, an elevated window
    // the hook cannot see. The poll answers "up", and the dictation is released.
    const log = logFile();
    const h = harness([`DOWN ${String(RIGHT_CTRL)}`], { log, state: '0', holdPollMs: 30 });
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => kinds(h.events).join() === 'pressed,released');
    expect(commands(log)).toContain(`POLL ${String(RIGHT_CTRL)}`);
    expect(h.notes.some((note) => note.includes('lost key-up was recovered'))).toBe(true);
    await h.source.stop();
  });

  it('a pre-1.0 helper that never answers POLL changes nothing', async () => {
    const h = harness([`DOWN ${String(RIGHT_CTRL)}`, '@150', `UP ${String(RIGHT_CTRL)}`], { state: 'none', holdPollMs: 20 });
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 2);
    expect(kinds(h.events)).toEqual(['pressed', 'released']);
    await h.source.stop();
  });

  it('does not poll at idle', async () => {
    const log = logFile();
    const h = harness([], { log, holdPollMs: 10 });
    await h.source.start();
    await settle(200);
    expect(commands(log).filter((line) => line.startsWith('POLL'))).toEqual([]);
    await h.source.stop();
  });

  it('a key after the 1.5 s chord window does not cancel the dictation', async () => {
    const h = harness([`DOWN ${String(RIGHT_CTRL)}`, '@1600', `DOWN ${String(V)}`, `UP ${String(V)}`, `UP ${String(RIGHT_CTRL)}`]);
    await h.source.start();
    h.endStartupSweep();
    await waitFor(() => h.events.length >= 2, 6_000);
    expect(kinds(h.events)).toEqual(['pressed', 'released']);
    await h.source.stop();
  });

  it('while recording, the hotkey does not dictate and the recorder hears every key', async () => {
    const log = logFile();
    const h = harness(['@200', `DOWN ${String(RIGHT_CTRL)}`, `UP ${String(RIGHT_CTRL)}`, `DOWN ${String(F13)}`], { log });
    const results: string[] = [];
    await h.source.start();
    h.endStartupSweep();
    h.source.startRecording((result) => results.push(result.kind === 'recorded' ? `recorded:${result.binding.label}` : result.kind));
    await waitFor(() => results.some((each) => each.startsWith('recorded')));
    // Right Ctrl down and up alone IS a recording of Right Ctrl — and not a dictation.
    expect(results).toContain('recorded:Right Ctrl');
    expect(h.events).toEqual([]);
    // Nothing is swallowed while recording.
    expect(commands(log)).toContain('SWALLOW 0');
    await h.source.stop();
  });
});
