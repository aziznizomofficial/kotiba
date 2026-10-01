// Start with Windows — and start WITHOUT a window.

import { app } from 'electron';

import { LAUNCH_FLAGS } from './launch.js';

/**
 * Reflect `settings.launchAtLogin`.
 *
 * The `args` are the entire point. `setLoginItemSettings` registers the executable in
 * `HKCU\...\Run`, and whatever is passed there is what runs at sign-in — so without
 * `--background` the app opens its window every time the user logs in, which is a thing
 * nobody asked for and the fastest route to being uninstalled.
 *
 * `openAsHidden` is macOS-only and is deliberately not set: on Windows the flag does
 * nothing and relying on it would hide the fact that `--background` is doing the work.
 */
export function setLaunchAtLogin(enabled: boolean): Promise<void> {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: [LAUNCH_FLAGS.background],
  });
  return Promise.resolve();
}

/**
 * What Windows currently believes, which is not necessarily what the settings file says:
 * a user can remove the entry from Task Manager's Startup tab, and an installer can be
 * repaired. The truth is whatever the OS reports.
 */
export function launchesAtLogin(): boolean {
  return app.getLoginItemSettings({ args: [LAUNCH_FLAGS.background] }).openAtLogin;
}

/**
 * Bring the two into agreement at startup, taking the SETTINGS as the intent.
 *
 * Only writes when they disagree: `setLoginItemSettings` touches the registry, and doing
 * that on every launch of a program that starts on every login is needless.
 */
export function reconcileLaunchAtLogin(wanted: boolean): void {
  if (launchesAtLogin() !== wanted) void setLaunchAtLogin(wanted);
}
