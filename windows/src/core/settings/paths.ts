// Where everything lives on Windows, built from the environment and nothing else.
//
// PURE, and deliberately NOT `node:path`. Two reasons, and the second is the real one:
//
//   1. `src/core/**` may not import a Node builtin (01-ARCHITECTURE, enforced by
//      windows/scripts/gate.sh).
//   2. `node:path` on a Mac is POSIX. Every developer on this project is on a Mac and
//      the only Windows machine available is a CI runner, so a path built with
//      `path.join` would be tested with forward slashes and shipped with backslashes.
//      D-W10 names path building as one of exactly TWO places Windows differs silently.
//      Building it by hand means the Mac-run test asserts the real Windows string.

import {
  DIAGNOSTICS_FILE_NAME,
  HISTORY_FILE_NAME,
  MODELS_DIRECTORY_NAME,
  SETTINGS_FILE_NAME,
  SETTINGS_UNREADABLE_FILE_NAME,
  SUPPORT_DIRECTORY_NAME,
} from '../../contracts/index.js';

/** The separator. One place, so a test can say which one it means. */
export const WINDOWS_SEPARATOR = '\\';

/** Just the environment variables this module reads. Injected, never read from `process`. */
export interface WindowsEnvironment {
  readonly APPDATA?: string | undefined;
  readonly LOCALAPPDATA?: string | undefined;
  readonly USERPROFILE?: string | undefined;
  readonly HOMEDRIVE?: string | undefined;
  readonly HOMEPATH?: string | undefined;
}

/** Neither the variable nor any fallback was set. Named, so a caller can say which. */
export class MissingWindowsPathError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(
      `${variable} is not set and no fallback could be built from USERPROFILE or ` +
        'HOMEDRIVE+HOMEPATH — Kotiba cannot decide where to keep its files',
    );
    this.name = 'MissingWindowsPathError';
    this.variable = variable;
  }
}

/**
 * Join path segments with a single backslash.
 *
 * Spaces are LEFT ALONE and never quoted: `C:\Users\Aziz Nizomov\AppData\Roaming` is a
 * perfectly ordinary path, and a path that arrives at `fs` pre-quoted fails to open in
 * a way that reads like a permissions problem. Quoting is a shell concern, and nothing
 * here goes through a shell.
 *
 * A trailing separator on a segment is absorbed so `join('C:\\', 'Kotiba')` is
 * `C:\Kotiba` and not `C:\\Kotiba`. A leading separator on a later segment is absorbed
 * for the same reason.
 */
export function joinWindowsPath(...segments: readonly string[]): string {
  const parts: string[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment === '') continue;
    // Keep a leading separator on the FIRST segment only — `\\server\share` is a real
    // path and stripping its first backslash silently retargets it at the drive root.
    const trimmed = index === 0 ? trimTrailing(segment) : trimBoth(segment);
    if (trimmed === '') continue;
    parts.push(trimmed);
  }

  let out = '';
  for (const part of parts) {
    if (out === '') out = part;
    // A drive root keeps its separator (see `trimTrailing`), so joining onto it must
    // not add a second one.
    else if (out.endsWith(WINDOWS_SEPARATOR)) out += part;
    else out += WINDOWS_SEPARATOR + part;
  }
  return out;
}

function trimTrailing(segment: string): string {
  let end = segment.length;
  while (end > 0 && (segment[end - 1] === '\\' || segment[end - 1] === '/')) end -= 1;
  // A bare drive root (`C:\`) trims to `C:`, which resolves against the CURRENT
  // directory on that drive rather than its root. Keep the separator.
  if (end === 0) return segment.slice(0, 1);
  if (end === 2 && segment[1] === ':') return segment.slice(0, 3);
  return segment.slice(0, end);
}

function trimBoth(segment: string): string {
  let start = 0;
  let end = segment.length;
  while (start < end && (segment[start] === '\\' || segment[start] === '/')) start += 1;
  while (end > start && (segment[end - 1] === '\\' || segment[end - 1] === '/')) end -= 1;
  return segment.slice(start, end);
}

/** `%USERPROFILE%`, or `%HOMEDRIVE%%HOMEPATH%` when a login profile did not set it. */
function userProfile(env: WindowsEnvironment): string | null {
  const profile = env.USERPROFILE?.trim();
  if (profile !== undefined && profile !== '') return profile;

  const drive = env.HOMEDRIVE?.trim();
  const home = env.HOMEPATH?.trim();
  if (drive !== undefined && drive !== '' && home !== undefined && home !== '') {
    return joinWindowsPath(drive, home);
  }
  return null;
}

/**
 * `%APPDATA%` — roaming. The settings blob lives here, so it follows the user onto
 * another machine in a domain environment, which is what "roaming" is for.
 *
 * The fallback is not defensive noise: a process launched from a service, a scheduled
 * task, or an SSH session routinely has no APPDATA at all, and D-W10's Windows CI job
 * is exactly such a process. Failing there with `undefined\Kotiba\settings.v1.json`
 * would be a path bug that only ever appears on the one machine nobody can attach a
 * debugger to.
 */
export function roamingAppDataDirectory(env: WindowsEnvironment): string {
  const appData = env.APPDATA?.trim();
  if (appData !== undefined && appData !== '') return appData;

  const profile = userProfile(env);
  if (profile === null) throw new MissingWindowsPathError('APPDATA');
  return joinWindowsPath(profile, 'AppData', 'Roaming');
}

/**
 * `%LOCALAPPDATA%` — machine-local. History and diagnostics live here.
 *
 * Deliberately not roaming: a domain profile syncs `%APPDATA%` at logoff, and a
 * history file that grows with use plus a 2 MB diagnostics log are exactly the sort of
 * thing that turns a logoff into a five-minute wait. Neither is worth carrying between
 * machines, and macOS keeps both beside the settings only because it has one directory.
 */
export function localAppDataDirectory(env: WindowsEnvironment): string {
  const local = env.LOCALAPPDATA?.trim();
  if (local !== undefined && local !== '') return local;

  const profile = userProfile(env);
  if (profile === null) throw new MissingWindowsPathError('LOCALAPPDATA');
  return joinWindowsPath(profile, 'AppData', 'Local');
}

/** Every path the app keeps state in. */
export interface KotibaPaths {
  /** `%APPDATA%\Kotiba` — the settings blob and the models directory. */
  readonly roamingDirectory: string;
  /** `%LOCALAPPDATA%\Kotiba` — history and diagnostics. */
  readonly localDirectory: string;
  readonly settingsFile: string;
  /** Where the original bytes go when a key failed to decode. Written, never read back. */
  readonly settingsUnreadableFile: string;
  readonly modelsDirectory: string;
  readonly historyFile: string;
  readonly diagnosticsFile: string;
}

/**
 * The complete layout, from the environment.
 *
 * macOS puts all of this in one directory because it has exactly one to put it in.
 * Windows has two with different semantics and using both is the parity-preserving
 * choice, not a divergence: the user-visible behaviour is identical and the roaming
 * profile stays small.
 *
 * `directoryName` is only ever the default or `LEGACY_SUPPORT_DIRECTORY_NAME` — the same
 * layout under the name the app had before it was Kotiba, which the rename migration moves.
 */
export function kotibaPaths(
  env: WindowsEnvironment,
  directoryName: string = SUPPORT_DIRECTORY_NAME,
): KotibaPaths {
  const roamingDirectory = joinWindowsPath(roamingAppDataDirectory(env), directoryName);
  const localDirectory = joinWindowsPath(localAppDataDirectory(env), directoryName);

  return {
    roamingDirectory,
    localDirectory,
    settingsFile: joinWindowsPath(roamingDirectory, SETTINGS_FILE_NAME),
    settingsUnreadableFile: joinWindowsPath(roamingDirectory, SETTINGS_UNREADABLE_FILE_NAME),
    modelsDirectory: joinWindowsPath(roamingDirectory, MODELS_DIRECTORY_NAME),
    historyFile: joinWindowsPath(localDirectory, HISTORY_FILE_NAME),
    diagnosticsFile: joinWindowsPath(localDirectory, DIAGNOSTICS_FILE_NAME),
  };
}
