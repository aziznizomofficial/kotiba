// Always-on, launch at login, and what "Quit" means. PURE — the decisions only.
//
// The port of `AppLifecycle` (Sources/KotibaPlatform/AppLifecycle.swift) and of
// `applicationShouldTerminate` in Apps/macOS/AppDelegate.swift. The owner's words: when
// always-on is on, quitting just closes the window; the tray icon persists and works; it
// survives logout, crash and reboot; the app only truly exits when the toggle is switched
// off inside the app.
//
// The Windows mechanisms, each chosen for being admin-free:
//
//   * LOGIN: the existing `HKCU\...\Run` entry (`autostart.ts`, `--background`). Always-on
//     implies it, exactly as the Mac's agent implies `RunAtLoad`, and the two are ONE
//     registration here — there is only one Run entry to have.
//   * CRASH: a watchdog (`./watchdog.ts`) — this same executable in Node mode, detached,
//     joined to the app by an IPC pipe. A deliberate exit tells it first; a pipe that
//     closes without being told is a crash or an End Task, and it relaunches.
//   * QUIT: every quit path asks `quitDecision`. With always-on, Quit hides the window;
//     only "Turn off Always on & quit", a duplicate stepping aside, and Windows ending the
//     session really exit — refusing the session end would hold up the user's sign-out,
//     and the Run entry brings Kotiba back at the next sign-in anyway.

import { t } from '../core/i18n/index.js';

/** Why the app is being asked to exit. */
export type QuitCause =
  /** Tray "Quit Kotiba", Ctrl+Q in the window, `app.quit()` from anywhere. */
  | 'user'
  /** "Turn off Always on & quit" — the one user exit from an always-on Kotiba. */
  | 'forReal'
  /** Windows is signing out, restarting or shutting down. Always wins. */
  | 'sessionEnd'
  /** A second copy handing over, or `--check` finishing. Not the user's choice. */
  | 'system';

export type QuitDecision = 'exit' | 'hide';

/**
 * Quit or hide. With always-on, every ordinary quit means "close the window": the tray
 * icon and the hotkey keep working.
 */
export function quitDecision(options: {
  readonly alwaysOn: boolean;
  readonly cause: QuitCause;
}): QuitDecision {
  if (!options.alwaysOn) return 'exit';
  return options.cause === 'user' ? 'hide' : 'exit';
}

/**
 * Whether the `HKCU\...\Run` entry should exist. Always-on starts at login itself, so
 * it implies the entry; the Mac keeps two registrations apart here, Windows has one.
 *
 * ONLY FOR A PACKAGED APP, as the watchdog already was. `setLoginItemSettings` registers
 * `process.execPath` — in a dev run (`npx electron .`) that is the BARE `electron.exe`
 * under `node_modules`, with no app path in the args. Finishing onboarding in a dev run
 * (Always on is pre-ticked) therefore left a Run value that opened Electron's default
 * "drag your app here" window at every sign-in, under the dev app's own name, where the
 * installed Kotiba never replaces it. Unpackaged, the answer is "no entry", which also
 * removes one an earlier dev run left behind.
 */
export function loginItemWanted(
  settings: {
    readonly alwaysOn: boolean;
    readonly launchAtLogin: boolean;
  },
  packaged: boolean,
): boolean {
  return packaged && (settings.alwaysOn || settings.launchAtLogin);
}

/** Whether a crash watchdog should be running for this process. */
export function watchdogWanted(settings: { readonly alwaysOn: boolean }, check: boolean): boolean {
  return settings.alwaysOn && !check;
}

/** The copy the Settings page and the tray share. The Mac's sentences, Windows nouns. */
export const LIFECYCLE_COPY = {
  get alwaysOnTitle(): string {
    return t('life.alwaysOnTitle');
  },
  get alwaysOnDetail(): string {
    return t('life.alwaysOnDetail');
  },
  get loginTitle(): string {
    return t('life.loginTitle');
  },
  get loginDetail(): string {
    return t('life.loginDetail');
  },
  get loginIncluded(): string {
    return t('life.loginIncluded');
  },
  get quitForRealTitle(): string {
    return t('life.quitForRealTitle');
  },
  get quitForRealDetail(): string {
    return t('life.quitForRealDetail');
  },
  get quitForRealButton(): string {
    return t('life.quitForRealButton');
  },
  get trayQuit(): string {
    return t('life.trayQuit');
  },
  get trayQuitForReal(): string {
    return t('life.trayQuitForReal');
  },
} as const;
