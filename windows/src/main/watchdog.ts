// Relaunch after a crash — the Windows half of always-on.
//
// The Mac registers a launchd agent with `KeepAlive {SuccessfulExit = false}`: a crash or a
// Force Quit is relaunched, a deliberate `exit(0)` is not. Windows has no per-user service
// manager that does that without administrator rights, so the choice was between two:
//
//   * TASK SCHEDULER, "restart on failure". Rejected. A logon trigger for the current user
//     needs elevation on stock Windows (`schtasks /sc onlogon` answers "Access is denied"
//     to a standard user), and restart-on-failure only fires for a task whose ACTION fails
//     — it is not a supervisor for a process that crashes an hour in. It would also be a
//     second registration to keep in step with the Run entry, from an installer that runs
//     per-user and unelevated.
//   * A WATCHDOG PROCESS. Chosen. This same `Kotiba.exe`, started in Node mode
//     (`ELECTRON_RUN_AS_NODE=1`) with a forty-line script, DETACHED — so it is outside the
//     job object libuv puts every other child in, and survives the app dying — and joined
//     to the app by an IPC pipe. The app tells it `stop` before any deliberate exit; a pipe
//     that closes without being told is a crash, an End Task or a kill, and the watchdog
//     starts `Kotiba.exe --background` again. No admin, no registry, no extra binary to
//     build or sign, and nothing left behind when always-on is switched off.
//
// Guards, each against a real way this goes wrong:
//
//   * A 2-second GRACE before relaunching. The uninstaller and "End task" on the process
//     tree kill every `Kotiba.exe` at once; in the grace the watchdog is killed too, instead
//     of resurrecting an app that is being removed. launchd throttles for the same reason.
//   * A CRASH-LOOP CAP: three relaunches inside five minutes and it stops, and says so in
//     its state file. A Kotiba that dies on startup must not be restarted forever.
//   * The executable must still exist at relaunch time.
//
// The script is a STRING, written next to the history at start-up — the same pattern as
// the capture page — because it runs outside the asar in Node mode, must be CommonJS, and
// must not import anything from the app. `test/main/watchdog.test.ts` runs it for real,
// with Node standing in for Kotiba.

import type { ChildProcess, SpawnOptions } from 'node:child_process';

/** Relaunches allowed inside `WATCHDOG_WINDOW_MS` before the watchdog gives up. */
export const WATCHDOG_MAX_RELAUNCHES = 3;
export const WATCHDOG_WINDOW_MS = 5 * 60_000;
export const WATCHDOG_GRACE_MS = 2_000;
/** The file name the script is written to, under the local support directory. */
export const WATCHDOG_SCRIPT_NAME = 'watchdog.cjs';
export const WATCHDOG_STATE_NAME = 'watchdog.json';

export const WATCHDOG_SOURCE = String.raw`'use strict';
// Kotiba's crash watchdog. Written by the app at start-up; see src/main/watchdog.ts.
const { spawn } = require('child_process');
const fs = require('fs');

const env = process.env;
const pid = Number(env.KOTIBA_WATCH_PID);
const exe = env.KOTIBA_RELAUNCH_EXE || '';
const args = JSON.parse(env.KOTIBA_RELAUNCH_ARGS || '[]');
const statePath = env.KOTIBA_WATCHDOG_STATE || '';
const graceMs = Number(env.KOTIBA_WATCHDOG_GRACE_MS || ${String(WATCHDOG_GRACE_MS)});
const limit = ${String(WATCHDOG_MAX_RELAUNCHES)};
const windowMs = Number(env.KOTIBA_WATCHDOG_WINDOW_MS || ${String(WATCHDOG_WINDOW_MS)});

let stopped = false;
let gone = false;

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { return { relaunches: [] }; }
}
function writeState(state) {
  try { fs.writeFileSync(statePath, JSON.stringify(state)); } catch (e) { /* nothing to do */ }
}

function relaunch(why) {
  const now = Date.now();
  const state = readState();
  const recent = (Array.isArray(state.relaunches) ? state.relaunches : []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    writeState({ relaunches: recent, gaveUp: now, why: why });
    process.exit(0);
  }
  if (!exe || !fs.existsSync(exe)) {
    writeState({ relaunches: recent, missing: exe, why: why });
    process.exit(0);
  }
  const childEnv = Object.assign({}, env);
  delete childEnv.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(childEnv)) if (key.indexOf('KOTIBA_WATCH') === 0 || key.indexOf('KOTIBA_RELAUNCH') === 0) delete childEnv[key];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', env: childEnv, windowsHide: false });
  child.unref();
  recent.push(now);
  writeState({ relaunches: recent, last: now, why: why });
  process.exit(0);
}

function parentGone(why) {
  if (gone) return;
  gone = true;
  if (stopped) process.exit(0);
  setTimeout(() => relaunch(why), graceMs);
}

process.on('message', (message) => {
  // No reply: the app disconnects the moment its message is in the pipe, and a send into
  // a closing channel would throw here and turn a clean exit into exit code 1.
  if (message && message.kind === 'stop') stopped = true;
});
process.on('disconnect', () => parentGone('the pipe to Kotiba closed without a stop'));
// Belt and braces for a pipe that somehow outlives its process.
setInterval(() => {
  try { process.kill(pid, 0); } catch (e) { if (e && e.code === 'ESRCH') parentGone('Kotiba is no longer running'); }
}, 2000);
`;

/** What the app holds while a watchdog is running. */
export interface WatchdogHandle {
  /** Tell it the next exit is deliberate, and let it go. Resolves once it has been told. */
  stop(): Promise<void>;
  readonly pid: number | null;
}

export interface WatchdogOptions {
  /** Where `WATCHDOG_SOURCE` has been written. */
  readonly scriptPath: string;
  readonly statePath: string;
  /** `process.execPath` — `Kotiba.exe`, which runs the script in Node mode. */
  readonly executable: string;
  /** What a relaunch runs. `['--background']`: a relaunch never opens a window. */
  readonly relaunchArgs: readonly string[];
  readonly watchedPid: number;
  readonly spawnProcess: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly graceMs?: number;
  readonly windowMs?: number;
}

/** Start the watchdog. The caller writes the script first; this only spawns it. */
export function startWatchdog(options: WatchdogOptions): WatchdogHandle {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    KOTIBA_WATCH_PID: String(options.watchedPid),
    KOTIBA_RELAUNCH_EXE: options.executable,
    KOTIBA_RELAUNCH_ARGS: JSON.stringify(options.relaunchArgs),
    KOTIBA_WATCHDOG_STATE: options.statePath,
  };
  if (options.graceMs !== undefined) env['KOTIBA_WATCHDOG_GRACE_MS'] = String(options.graceMs);
  if (options.windowMs !== undefined) env['KOTIBA_WATCHDOG_WINDOW_MS'] = String(options.windowMs);

  const child = options.spawnProcess(options.executable, [options.scriptPath], {
    // DETACHED is the whole mechanism: libuv puts every non-detached child in a job object
    // that is killed with the parent, which would take the watchdog down with the crash it
    // exists to notice.
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env,
    windowsHide: true,
  });
  // Neither the process nor its pipe may keep the app alive on the way out.
  child.unref();
  (child as ChildProcess & { channel?: { unref(): void } }).channel?.unref();
  child.on('error', () => undefined);

  let stopped = false;
  return {
    pid: child.pid ?? null,
    stop(): Promise<void> {
      if (stopped) return Promise.resolve();
      stopped = true;
      return new Promise<void>((resolve) => {
        const finish = (): void => {
          try {
            child.disconnect?.();
          } catch {
            /* already gone */
          }
          resolve();
        };
        // The callback fires once the message is in the pipe; the pipe is ordered, so the
        // watchdog reads `stop` before it sees the disconnect that follows.
        try {
          if (!child.connected) {
            resolve();
            return;
          }
          child.send({ kind: 'stop' }, () => finish());
        } catch {
          resolve();
        }
        // Never hold a quit hostage to a watchdog that is not answering.
        setTimeout(resolve, 500).unref?.();
      });
    },
  };
}
