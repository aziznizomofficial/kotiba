// Who is in front, against a real child process speaking kotiba-input's protocol.
//
// The credential gate reads this, so the tests that matter are the ones about NOT
// knowing: an unreadable foreground must never arrive looking like a safe one.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isSensitiveApp, formatForApp } from '../../src/core/settings/index.js';
import { createFocusSource, defaultInputHelperPath } from '../../src/platform/focus.js';
import { createInputHelper } from '../../src/platform/insert.js';

const FAKE_INPUT = fileURLToPath(new URL('./fake-input.mjs', import.meta.url));

function spawner(environment: Record<string, string> = {}) {
  return (path: string): ChildProcessWithoutNullStreams =>
    spawn(process.execPath, [path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...environment },
    });
}

function focus(environment: Record<string, string> = {}, selfPid = 4242) {
  return createFocusSource({
    helperPath: FAKE_INPUT,
    spawnProcess: spawner(environment),
    requestTimeoutMs: 1_500,
    selfPid,
  });
}

describe('the foreground application', () => {
  it('is an AppId: basename, lowercased, .exe stripped', async () => {
    const source = focus({ KOTIBA_FAKE_INPUT_APP: 'Telegram' });
    expect(await source.foreground()).toEqual({ appId: 'telegram', displayName: 'Telegram' });
    expect(source.lastFailure).toBeNull();
    await source.dispose();
  });

  it('normalises whatever case the helper sends', async () => {
    const source = focus({ KOTIBA_FAKE_INPUT_APP: '1Password' });
    const app = await source.foreground();
    expect(app.appId).toBe('1password');
    // And the gate downstream recognises it. This is the security property: a password
    // dictated into a password manager must not reach a polish endpoint.
    expect(isSensitiveApp(app.appId)).toBe(true);
    expect(formatForApp(app.appId)).toBe('password');
    await source.dispose();
  });

  it('can be read repeatedly — macOS reads it twice per dictation on purpose', async () => {
    const source = focus({ KOTIBA_FAKE_INPUT_APP: 'code' });
    expect((await source.foreground()).appId).toBe('code');
    expect((await source.foreground()).appId).toBe('code');
    expect((await source.foreground()).appId).toBe('code');
    await source.dispose();
  });
});

describe('when it cannot be read', () => {
  it('answers null AND records why, so a caller can tell the two apart', async () => {
    // A locked session, a UAC prompt, or an elevated password manager. "I do not know"
    // must never arrive looking like "nothing sensitive is in front".
    const source = focus({ KOTIBA_FAKE_INPUT_APP: '-' });
    expect(await source.foreground()).toEqual({ appId: null, displayName: null });
    expect(source.lastFailure).toContain('cannot open process');
    await source.dispose();
  });

  it('answers null when the helper is missing, rather than throwing', async () => {
    const source = createFocusSource({ helperPath: '/nonexistent/kotiba-input.exe' });
    expect(await source.foreground()).toEqual({ appId: null, displayName: null });
    expect(source.lastFailure).not.toBeNull();
    await source.dispose();
  });

  it('starts with no failure recorded, so a stale sentence cannot be read as a live one', async () => {
    const source = focus({ KOTIBA_FAKE_INPUT_APP: 'telegram' });
    expect(source.lastFailure).toBeNull();
    await source.foreground();
    expect(source.lastFailure).toBeNull();
    await source.dispose();
  });
});

describe('isSelfForeground — a deliberate Windows addition, not parity', () => {
  // macOS has `Focus.isSelfFrontmost` and calls it from NOWHERE: `grep -rn
  // isSelfFrontmost` over the Swift tree returns the two definitions and nothing else,
  // and `PasteboardSink.insert()` checks only that the text is non-empty and that
  // Accessibility is trusted. So this is an ADDITION. It is worth having on Windows
  // because the case it was written for is more likely here: the settings window is a
  // real focusable window, the onboarding window is Windows-only, and the HUD sits over
  // everything.
  it('is true when the front window belongs to this process', async () => {
    const source = focus({ KOTIBA_FAKE_INPUT_APP: 'kotiba', KOTIBA_FAKE_INPUT_PID: '777' }, 777);
    expect(await source.isSelfForeground()).toBe(true);
    await source.dispose();
  });

  it('is false for any other process', async () => {
    const source = focus({ KOTIBA_FAKE_INPUT_APP: 'telegram', KOTIBA_FAKE_INPUT_PID: '888' }, 777);
    expect(await source.isSelfForeground()).toBe(false);
    await source.dispose();
  });

  it('is FALSE when the foreground cannot be read, never true', async () => {
    // Answering true on an unreadable foreground would silently suppress insertion into
    // every elevated application on the machine — a far worse failure than pasting into
    // our own settings window once.
    const source = focus({ KOTIBA_FAKE_INPUT_APP: '-' }, 777);
    expect(await source.isSelfForeground()).toBe(false);
    await source.dispose();
  });
});

describe('the shared helper', () => {
  it('is not torn down by the focus source that borrowed it', async () => {
    const helper = createInputHelper({ helperPath: FAKE_INPUT, spawnProcess: spawner() });
    const source = createFocusSource({ helperPath: FAKE_INPUT, helper, selfPid: 4242 });
    expect((await source.foreground()).appId).toBe('telegram');
    await source.dispose();
    expect((await helper.request({ op: 'hello' })).ok).toBe(true);
    await helper.dispose();
  });
});

describe('the default helper path', () => {
  it('sits beside the running executable', () => {
    expect(defaultInputHelperPath().endsWith('\\kotiba-input.exe')).toBe(true);
  });
});
