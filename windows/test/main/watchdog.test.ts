// The crash watchdog, run for real: the script the app writes, in a real Node process,
// joined to this test by a real IPC pipe. Node stands in for `Kotiba.exe` twice — as the
// Node-mode host the script runs in, and as the "app" a relaunch starts, which here just
// writes a file to prove it ran.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WATCHDOG_MAX_RELAUNCHES,
  WATCHDOG_SOURCE,
  startWatchdog,
} from '../../src/main/watchdog.js';
import {
  loginItemWanted,
  quitDecision,
  watchdogWanted,
} from '../../src/main/lifecycle.js';

let dir: string;
let script: string;
let state: string;
let marker: string;
let relaunchScript: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kotiba-watchdog-'));
  script = join(dir, 'watchdog.cjs');
  state = join(dir, 'watchdog.json');
  marker = join(dir, 'relaunched.txt');
  relaunchScript = join(dir, 'fake-kotiba.cjs');
  writeFileSync(script, WATCHDOG_SOURCE);
  writeFileSync(
    relaunchScript,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function launch(watchedPid: number): { handle: ReturnType<typeof startWatchdog>; child: () => ChildProcess } {
  let spawned: ChildProcess | null = null;
  const handle = startWatchdog({
    scriptPath: script,
    statePath: state,
    executable: process.execPath,
    relaunchArgs: [relaunchScript, '--background'],
    watchedPid,
    graceMs: 50,
    spawnProcess: (command: string, args: readonly string[], options: SpawnOptions) => {
      spawned = spawn(command, [...args], options);
      return spawned;
    },
  });
  return {
    handle,
    child: () => {
      if (spawned === null) throw new Error('not spawned');
      return spawned;
    },
  };
}

describe('the crash watchdog', () => {
  it('relaunches with --background when the pipe closes WITHOUT a stop (a crash)', async () => {
    const { child } = launch(process.pid);
    await waitFor(() => child().connected, 2_000);
    // The app dying closes the pipe; nothing said "stop" first.
    child().disconnect();
    expect(await waitFor(() => existsSync(marker), 5_000)).toBe(true);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(['--background']);
    const recorded = JSON.parse(readFileSync(state, 'utf8')) as { relaunches: number[] };
    expect(recorded.relaunches).toHaveLength(1);
  });

  it('does NOT relaunch after a deliberate exit that said stop first', async () => {
    const { handle, child } = launch(process.pid);
    await waitFor(() => child().connected, 2_000);
    await handle.stop();
    await waitFor(() => child().exitCode !== null, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(marker)).toBe(false);
    expect(child().exitCode).toBe(0);
  });

  it('notices a watched process that is gone even while the pipe is open', async () => {
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)']);
    const { child } = launch(victim.pid ?? 0);
    await new Promise((resolve) => victim.on('exit', resolve));
    expect(await waitFor(() => existsSync(marker), 6_000)).toBe(true);
    child().kill();
  });

  it(`gives up after ${String(WATCHDOG_MAX_RELAUNCHES)} relaunches in five minutes`, async () => {
    const now = Date.now();
    writeFileSync(state, JSON.stringify({ relaunches: [now - 3_000, now - 2_000, now - 1_000] }));
    const { child } = launch(process.pid);
    await waitFor(() => child().connected, 2_000);
    child().disconnect();
    await waitFor(() => child().exitCode !== null, 5_000);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toHaveProperty('gaveUp');
  });
});

describe('what Quit means', () => {
  it('always-on turns an ordinary quit into hiding the window', () => {
    expect(quitDecision({ alwaysOn: true, cause: 'user' })).toBe('hide');
    expect(quitDecision({ alwaysOn: false, cause: 'user' })).toBe('exit');
  });

  it('"Turn off Always on & quit", a session end and a hand-over always exit', () => {
    for (const cause of ['forReal', 'sessionEnd', 'system'] as const) {
      expect(quitDecision({ alwaysOn: true, cause })).toBe('exit');
    }
  });

  it('always-on implies the login entry, and the watchdog only outside --check', () => {
    expect(loginItemWanted({ alwaysOn: true, launchAtLogin: false }, true)).toBe(true);
    expect(loginItemWanted({ alwaysOn: false, launchAtLogin: true }, true)).toBe(true);
    expect(loginItemWanted({ alwaysOn: false, launchAtLogin: false }, true)).toBe(false);
    // A dev run registers `process.execPath` — the bare electron.exe — so it never
    // registers at all, whatever the settings say (and clears a stale dev entry).
    expect(loginItemWanted({ alwaysOn: true, launchAtLogin: true }, false)).toBe(false);
    expect(watchdogWanted({ alwaysOn: true }, false)).toBe(true);
    expect(watchdogWanted({ alwaysOn: true }, true)).toBe(false);
    expect(watchdogWanted({ alwaysOn: false }, false)).toBe(false);
  });
});
