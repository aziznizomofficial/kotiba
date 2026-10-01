// Insertion, against a real child process speaking kotiba-input's protocol.
//
// What is covered here is the client: framing, ordering, timeouts, restarts, and the
// mapping from a machine-readable `code` to the sentence the user reads. What is NOT
// covered anywhere in this repository is `SendInput`, the Win32 clipboard and UI
// Automation — those compile only on Windows and have never executed.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { INSERTION_REFUSALS } from '../../src/contracts/index.js';
import {
  createInputHelper,
  createInserter,
  refusalReason,
  InputHelperUnavailable,
} from '../../src/platform/insert.js';

const FAKE_INPUT = fileURLToPath(new URL('./fake-input.mjs', import.meta.url));

function spawner(environment: Record<string, string> = {}) {
  return (path: string): ChildProcessWithoutNullStreams =>
    spawn(process.execPath, [path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...environment },
    });
}

function inserter(environment: Record<string, string> = {}, notes: string[] = []) {
  return createInserter({
    helperPath: FAKE_INPUT,
    spawnProcess: spawner(environment),
    onNote: (note) => notes.push(note),
    requestTimeoutMs: 1_500,
  });
}

describe('which path a text asks for', () => {
  it('pastes anything multi-line or tabbed; types one line', async () => {
    const sent: Record<string, unknown>[] = [];
    const sink = createInserter({
      helperPath: 'unused',
      helper: {
        request: async (command) => {
          sent.push(command);
          return { ok: true, path: 'unicode' };
        },
        isRunning: true,
        restarts: 0,
        dispose: async () => undefined,
      },
    });
    await sink.insert('one line of text');
    // A typed U+000A is Enter in a chat box: a Note checklist would be SENT half-way.
    await sink.insert('- [ ] Fix the fence\n- Buy nails');
    await sink.insert('a\tb');
    expect(sent.map((command) => command['path'])).toEqual(['auto', 'clipboard', 'clipboard']);
  });
});

describe('the happy path', () => {
  it('inserts and says which way the text went in', async () => {
    const notes: string[] = [];
    const sink = inserter({}, notes);
    expect(await sink.insert('Assalomu alaykum')).toEqual({ kind: 'inserted' });
    expect(notes.some((note) => note.includes('via unicode'))).toBe(true);
    await sink.dispose();
  });

  it('carries the okina through unchanged', async () => {
    // U+02BB is the letter this whole insertion design exists for. macOS cannot type it
    // at all — no keycode produces it — which is why paste is the primary path there.
    // Windows can, via KEYEVENTF_UNICODE, and the client must not mangle it on the way.
    const sink = createInserter({ helperPath: FAKE_INPUT, spawnProcess: spawner() });
    const helper = createInputHelper({ helperPath: FAKE_INPUT, spawnProcess: spawner() });
    const response = await helper.request({ op: 'insert', text: 'oʻzbek sanʼat' });
    expect(response.ok).toBe(true);
    expect(response.units).toBe('oʻzbek sanʼat'.length);
    await helper.dispose();
    await sink.dispose();
  });

  it('reports clipboard formats it could not preserve', async () => {
    // Silently eating what the user had copied is a bug they notice and do not report.
    // The GDI-handle formats cannot be restored safely, so they are named.
    const notes: string[] = [];
    const sink = inserter(
      { KOTIBA_FAKE_INPUT_PATH: 'clipboard', KOTIBA_FAKE_INPUT_DROPPED: 'CF_BITMAP,CF_ENHMETAFILE' },
      notes,
    );
    expect(await sink.insert('hello')).toEqual({ kind: 'inserted' });
    expect(notes.some((note) => note.includes('CF_BITMAP'))).toBe(true);
    await sink.dispose();
  });

  it('answers concurrent requests in order', async () => {
    const helper = createInputHelper({ helperPath: FAKE_INPUT, spawnProcess: spawner() });
    const answers = await Promise.all([
      helper.request({ op: 'insert', text: 'one' }),
      helper.request({ op: 'insert', text: 'two two' }),
      helper.request({ op: 'insert', text: 'three three three' }),
    ]);
    expect(answers.map((answer) => answer.units)).toEqual([3, 7, 17]);
    await helper.dispose();
  });
});

describe('refusals are values, not throws', () => {
  it('refuses empty text without asking the helper', async () => {
    const notes: string[] = [];
    const sink = inserter({}, notes);
    expect(await sink.insert('')).toEqual({ kind: 'refused', reason: INSERTION_REFUSALS.empty });
    expect(notes).toEqual([]); // no round trip at all
    await sink.dispose();
  });

  it.each([
    ['clipboardRefused', INSERTION_REFUSALS.clipboardRefused],
    ['clipboardStolen', INSERTION_REFUSALS.clipboardStolen],
    ['couldNotSendKeys', INSERTION_REFUSALS.couldNotSendKeys],
    ['notEditable', INSERTION_REFUSALS.notEditable],
    ['moved', INSERTION_REFUSALS.moved],
  ])('turns code %s into its shipped sentence', async (code, sentence) => {
    const sink = inserter({ KOTIBA_FAKE_INPUT_MODE: `refuse:${code}` });
    expect(await sink.insert('hello')).toEqual({ kind: 'refused', reason: sentence });
    await sink.dispose();
  });

  it('never matches on the helper prose — an unknown code still says something honest', () => {
    // D-W10 in miniature. `ai-balance/windows` matched an error message with a regex and
    // a healthy app exited non-zero; the code is what a caller branches on.
    expect(refusalReason('somethingNew', 'the window went away')).toContain('the window went away');
    expect(refusalReason(undefined, undefined)).toContain('no reason given');
    expect(refusalReason('empty', 'ignored')).toBe(INSERTION_REFUSALS.empty);
  });

  it('turns a missing helper into a refusal, not an exception', async () => {
    const sink = createInserter({ helperPath: '/nonexistent/kotiba-input.exe' });
    const outcome = await sink.insert('hello');
    expect(outcome.kind).toBe('refused');
    await sink.dispose();
  });

  it('turns a silent helper into a refusal once the timeout fires', async () => {
    const sink = createInserter({
      helperPath: FAKE_INPUT,
      spawnProcess: spawner({ KOTIBA_FAKE_INPUT_MODE: 'silent' }),
      requestTimeoutMs: 250,
    });
    const outcome = await sink.insert('hello');
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('did not answer');
    await sink.dispose();
  });

  it('turns a helper that dies into a refusal', async () => {
    const sink = createInserter({
      helperPath: FAKE_INPUT,
      spawnProcess: spawner({ KOTIBA_FAKE_INPUT_MODE: 'crash' }),
      requestTimeoutMs: 1_000,
    });
    const outcome = await sink.insert('hello');
    expect(outcome.kind).toBe('refused');
    await sink.dispose();
  });
});

describe('replace, which is what makes the polish pass real', () => {
  it('refuses an empty previous without a round trip', async () => {
    const sink = inserter();
    expect(await sink.replace('', 'polished')).toEqual({
      kind: 'refused',
      reason: INSERTION_REFUSALS.nothingToReplace,
    });
    await sink.dispose();
  });

  it('replaces when the text before the caret is exactly what we inserted', async () => {
    const sink = inserter({ KOTIBA_FAKE_INPUT_PREVIOUS: 'raw text' });
    expect(await sink.replace('raw text', 'polished text')).toEqual({ kind: 'inserted' });
    await sink.dispose();
  });

  it('refuses when the text moved, rather than eating what the user typed', async () => {
    // Replacement destroys what it selects, so an unverified select-last-N eats
    // whatever the user typed in between. Refusing is the only safe answer.
    const sink = inserter({ KOTIBA_FAKE_INPUT_PREVIOUS: 'raw text' });
    expect(await sink.replace('something else', 'polished')).toEqual({
      kind: 'refused',
      reason: INSERTION_REFUSALS.moved,
    });
    await sink.dispose();
  });

  it('does not refuse unconditionally — the macOS bug that discarded every polish', async () => {
    const sink = inserter();
    const outcome = await sink.replace('raw', 'polished');
    expect(outcome).toEqual({ kind: 'inserted' });
    await sink.dispose();
  });
});

describe('the helper process', () => {
  it('stops answering once disposed, and says so', async () => {
    const helper = createInputHelper({ helperPath: FAKE_INPUT, spawnProcess: spawner() });
    expect((await helper.request({ op: 'hello' })).ok).toBe(true);
    await helper.dispose();
    await expect(helper.request({ op: 'hello' })).rejects.toBeInstanceOf(InputHelperUnavailable);
  });

  it('comes back after a death instead of staying dead', async () => {
    // The first request kills the fake; the second must find a fresh one. The restart
    // budget exists so a helper that dies on every request stops rather than fork-bombs.
    const notes: string[] = [];
    const helper = createInputHelper({
      helperPath: FAKE_INPUT,
      spawnProcess: spawner({ KOTIBA_FAKE_INPUT_MODE: 'crash' }),
      onNote: (note) => notes.push(note),
      requestTimeoutMs: 1_000,
    });
    await expect(helper.request({ op: 'hello' })).rejects.toBeInstanceOf(InputHelperUnavailable);
    await expect(helper.request({ op: 'hello' })).rejects.toBeInstanceOf(InputHelperUnavailable);
    await expect(helper.request({ op: 'hello' })).rejects.toBeInstanceOf(InputHelperUnavailable);
    // The fourth is refused without a spawn: three deaths in a row is a pattern.
    await expect(helper.request({ op: 'hello' })).rejects.toThrow(/will not be restarted/);
    await helper.dispose();
  });

  it('leaves a shared helper alone when the inserter is disposed', async () => {
    const helper = createInputHelper({ helperPath: FAKE_INPUT, spawnProcess: spawner() });
    const sink = createInserter({ helperPath: FAKE_INPUT, helper });
    expect(await sink.insert('hello')).toEqual({ kind: 'inserted' });
    await sink.dispose();
    // Still usable: the helper belongs to whoever created it, and the focus source is
    // sharing this one.
    expect((await helper.request({ op: 'hello' })).ok).toBe(true);
    await helper.dispose();
  });
});
