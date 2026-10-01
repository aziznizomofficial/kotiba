// Windows path building.
//
// D-W10 names this as one of exactly TWO places a port differs silently. Every
// developer here is on a Mac, so `node:path` would build POSIX paths in every test and
// backslashed ones only in production — which is why these are built by hand and
// asserted as literal Windows strings.

import { describe, expect, it } from 'vitest';

import {
  MissingWindowsPathError,
  joinWindowsPath,
  kotibaPaths,
  localAppDataDirectory,
  roamingAppDataDirectory,
} from '../../src/core/settings/index.js';

const ORDINARY = {
  APPDATA: 'C:\\Users\\aziz\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\aziz\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\aziz',
};

describe('joinWindowsPath', () => {
  it('joins with backslashes and not slashes', () => {
    expect(joinWindowsPath('C:\\Users\\aziz', 'Kotiba', 'models')).toBe(
      'C:\\Users\\aziz\\Kotiba\\models',
    );
  });

  it('does not double a separator that is already there', () => {
    expect(joinWindowsPath('C:\\Users\\aziz\\', '\\Kotiba\\')).toBe('C:\\Users\\aziz\\Kotiba');
  });

  it('keeps a drive root a root', () => {
    // `C:\` trimmed to `C:` resolves against the CURRENT directory on that drive, not
    // its root — a bug that only appears when someone has cd'd elsewhere on C:.
    expect(joinWindowsPath('C:\\', 'Kotiba')).toBe('C:\\Kotiba');
  });

  it('keeps a UNC path a UNC path', () => {
    // A roaming profile on a domain share is a real deployment, and stripping the
    // leading backslashes silently retargets it at the local drive root.
    expect(joinWindowsPath('\\\\fileserver\\profiles\\aziz', 'Kotiba')).toBe(
      '\\\\fileserver\\profiles\\aziz\\Kotiba',
    );
  });

  it('skips empty segments instead of emitting empty components', () => {
    expect(joinWindowsPath('C:\\Kotiba', '', 'models')).toBe('C:\\Kotiba\\models');
  });

  // A space in a username is ordinary, not an edge case, and nothing here may quote it:
  // a path that arrives at `fs` pre-quoted fails to open in a way that reads like a
  // permissions problem. Quoting is a shell concern and nothing here sees a shell.
  it('leaves spaces in a path exactly as they are', () => {
    expect(joinWindowsPath('C:\\Users\\Aziz Nizomov\\AppData\\Roaming', 'Kotiba')).toBe(
      'C:\\Users\\Aziz Nizomov\\AppData\\Roaming\\Kotiba',
    );
  });
});

describe('the roaming and local directories', () => {
  it('uses APPDATA and LOCALAPPDATA when they are set', () => {
    expect(roamingAppDataDirectory(ORDINARY)).toBe('C:\\Users\\aziz\\AppData\\Roaming');
    expect(localAppDataDirectory(ORDINARY)).toBe('C:\\Users\\aziz\\AppData\\Local');
  });

  // A process launched from a service, a scheduled task or an SSH session routinely has
  // no APPDATA — and D-W10's Windows CI job is exactly such a process. Failing there
  // gives `undefined\Kotiba\settings.v1.json` on the one machine nobody can debug.
  it('falls back to USERPROFILE when APPDATA is unset', () => {
    expect(roamingAppDataDirectory({ USERPROFILE: 'C:\\Users\\aziz' })).toBe(
      'C:\\Users\\aziz\\AppData\\Roaming',
    );
    expect(localAppDataDirectory({ USERPROFILE: 'C:\\Users\\aziz' })).toBe(
      'C:\\Users\\aziz\\AppData\\Local',
    );
  });

  it('treats an empty APPDATA the same as an unset one', () => {
    expect(roamingAppDataDirectory({ APPDATA: '   ', USERPROFILE: 'C:\\Users\\aziz' })).toBe(
      'C:\\Users\\aziz\\AppData\\Roaming',
    );
  });

  it('falls back to HOMEDRIVE + HOMEPATH when USERPROFILE is unset too', () => {
    expect(roamingAppDataDirectory({ HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\aziz' })).toBe(
      'C:\\Users\\aziz\\AppData\\Roaming',
    );
  });

  it('names the variable it could not resolve rather than building a nonsense path', () => {
    expect(() => roamingAppDataDirectory({})).toThrow(MissingWindowsPathError);
    expect(() => roamingAppDataDirectory({})).toThrow(/APPDATA/);
    expect(() => localAppDataDirectory({})).toThrow(/LOCALAPPDATA/);
  });
});

describe('kotibaPaths', () => {
  it('puts settings and models in roaming, history and diagnostics in local', () => {
    const paths = kotibaPaths(ORDINARY);
    expect(paths).toEqual({
      roamingDirectory: 'C:\\Users\\aziz\\AppData\\Roaming\\Kotiba',
      localDirectory: 'C:\\Users\\aziz\\AppData\\Local\\Kotiba',
      settingsFile: 'C:\\Users\\aziz\\AppData\\Roaming\\Kotiba\\settings.v1.json',
      settingsUnreadableFile:
        'C:\\Users\\aziz\\AppData\\Roaming\\Kotiba\\settings.v1.json.unreadable',
      modelsDirectory: 'C:\\Users\\aziz\\AppData\\Roaming\\Kotiba\\models',
      historyFile: 'C:\\Users\\aziz\\AppData\\Local\\Kotiba\\history.jsonl',
      diagnosticsFile: 'C:\\Users\\aziz\\AppData\\Local\\Kotiba\\diagnostics.jsonl',
    });
  });

  it('survives a username with a space in it, unquoted', () => {
    const paths = kotibaPaths({
      APPDATA: 'C:\\Users\\Aziz Nizomov\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Aziz Nizomov\\AppData\\Local',
    });
    expect(paths.settingsFile).toBe(
      'C:\\Users\\Aziz Nizomov\\AppData\\Roaming\\Kotiba\\settings.v1.json',
    );
    expect(paths.historyFile).toBe(
      'C:\\Users\\Aziz Nizomov\\AppData\\Local\\Kotiba\\history.jsonl',
    );
    expect(paths.settingsFile).not.toContain('"');
  });

  it('survives a non-ASCII username', () => {
    // The audience is Uzbek. `Ozodbek` is fine; `Озодбек` is what a Cyrillic-locale
    // install actually produces, and it must not be escaped or transliterated.
    const paths = kotibaPaths({
      APPDATA: 'C:\\Users\\Озодбек\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Озодбек\\AppData\\Local',
    });
    expect(paths.roamingDirectory).toBe('C:\\Users\\Озодбек\\AppData\\Roaming\\Kotiba');
  });

  it('builds every path from the fallback when neither APPDATA nor LOCALAPPDATA is set', () => {
    const paths = kotibaPaths({ USERPROFILE: 'C:\\Users\\aziz' });
    expect(paths.settingsFile).toBe(
      'C:\\Users\\aziz\\AppData\\Roaming\\Kotiba\\settings.v1.json',
    );
    expect(paths.diagnosticsFile).toBe(
      'C:\\Users\\aziz\\AppData\\Local\\Kotiba\\diagnostics.jsonl',
    );
  });

  it('never emits a forward slash', () => {
    for (const value of Object.values(kotibaPaths(ORDINARY))) {
      expect(value).not.toContain('/');
    }
  });
});
