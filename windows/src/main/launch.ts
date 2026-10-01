// How the process was started, and what that means. PURE — argv in, decision out.
//
// Three ways Kotiba starts, and they are not the same app:
//
//   kotiba.exe                 the user opened it            → window on first run, tray always
//   kotiba.exe --background    Windows started it at sign-in → NO WINDOW, ever
//   kotiba.exe --check         CI, or a user proving it works → headless, prints, exits
//
// `--background` is the one that gets built wrong. `app.setLoginItemSettings` starts the
// app with whatever args it was given, and an app that opens its settings window every
// time you sign in is something nobody asked for — it is the single most common way a
// tray app becomes the thing the user uninstalls.

/** The literal flags. `setLoginItemSettings({ args })` is passed `[LAUNCH_FLAGS.background]`. */
export const LAUNCH_FLAGS = {
  background: '--background',
  check: '--check',
  /** Optional, `--fixtures <dir>`, so CI can point `--check` at a different corpus. */
  fixtures: '--fixtures',
  /** Optional, `--models <dir>`, same reason. */
  models: '--models',
} as const;

export interface LaunchOptions {
  /** Headless: run the pipeline over the fixtures, print, exit. Never shows any window. */
  readonly check: boolean;
  /** Started by Windows at sign-in. Tray only; no window of any kind. */
  readonly background: boolean;
  /** `--fixtures <dir>`, or `null` for the shipped default. */
  readonly fixturesDirectory: string | null;
  /** `--models <dir>`, or `null` for the shipped default. */
  readonly modelsDirectory: string | null;
}

/**
 * Parse the process arguments.
 *
 * Takes the args AFTER the executable — `process.argv.slice(1)` for a packaged Electron
 * app, which is where the login-item args land. Unknown arguments are ignored rather
 * than fatal: Electron and Windows both add their own (`--allow-file-access-from-files`,
 * a shortcut's working directory, a squirrel event), and a launcher that refuses to
 * start because it did not recognise an argument it was handed is a launcher that
 * refuses to start.
 */
export function parseLaunchOptions(argv: readonly string[]): LaunchOptions {
  let check = false;
  let background = false;
  let fixturesDirectory: string | null = null;
  let modelsDirectory: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    // Accept `--flag=value` as well as `--flag value`; Windows shortcuts write both.
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);

    switch (name) {
      case LAUNCH_FLAGS.check:
        check = true;
        break;
      case LAUNCH_FLAGS.background:
        background = true;
        break;
      case LAUNCH_FLAGS.fixtures:
        fixturesDirectory = inlineValue ?? argv[i + 1] ?? null;
        if (inlineValue === null) i += 1;
        break;
      case LAUNCH_FLAGS.models:
        modelsDirectory = inlineValue ?? argv[i + 1] ?? null;
        if (inlineValue === null) i += 1;
        break;
      default:
        break;
    }
  }

  return { check, background, fixturesDirectory, modelsDirectory };
}

/**
 * Whether this launch may open a window at all.
 *
 * ONE PLACE ASKS THIS QUESTION. Every window-opening path goes through it, so
 * "--background must genuinely not open a window" is a property of the code rather than
 * a promise about it. The tray is not a window and is always created.
 */
export function mayOpenWindows(options: LaunchOptions): boolean {
  return !options.check && !options.background;
}

/**
 * What the SECOND copy says before it exits.
 *
 * macOS quits a duplicate silently, deliberately and with no alert. Windows does not:
 * on macOS a second copy of a menu-bar app is visibly the same icon in the same place,
 * so the user can see what happened, whereas here a double-clicked shortcut that does
 * nothing at all reads as a broken install and is clicked again. So the second copy
 * says why — and it says it as a notification rather than a modal, because a modal from
 * a process that is about to exit is a dialog with nothing behind it.
 *
 * Two instances would share one hotkey and race two pastes into the same caret, which is
 * the actual reason, so the sentence names it.
 */
export const SECOND_INSTANCE_MESSAGE =
  'Kotiba is already running — look for the nib in the notification area. ' +
  'Only one copy can watch the dictation key, so this one has closed.';

/** Title of that notification. */
export const SECOND_INSTANCE_TITLE = 'Kotiba is already running';
