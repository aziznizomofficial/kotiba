// The settings file: read bytes, hand them to `core/settings`, write bytes back.  OWNER: t05
//
// May use Node. May NOT import `electron`.
//
// Everything with an opinion — the schema, the defaults, the per-key salvage, the
// migration — is pure and lives in `src/core/settings`. This file is the part that
// touches a disk, and it has exactly two jobs the pure layer cannot do: write
// atomically, and refuse to write at all when the read failed.

import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  SETTINGS_FILE_NAME,
  SETTINGS_LOAD_MESSAGES,
  SETTINGS_UNREADABLE_FILE_NAME,
  type Settings,
  type SettingsLoad,
  type SettingsStore,
  type Unsubscribe,
} from '../contracts/index.js';
import {
  WINDOWS_DEFAULT_SETTINGS,
  parseSettings,
  serialiseSettings,
} from '../core/settings/index.js';

/**
 * Write a file so that a power cut cannot leave a half-written one behind.
 *
 * Write to a sibling temp file, flush it to the platform with `fsync`, then rename over
 * the target. `rename` within a directory is atomic on NTFS, so a reader sees either
 * the whole old file or the whole new one and never a truncated blob.
 *
 * The `fsync` is not ceremony. Without it the rename can reach the disk before the
 * bytes do, and the crash window produces a settings file that exists, is the right
 * size, and is full of zeros — which then reads as "the saved settings could not be
 * read" and costs the user their model paths for a reason no log will explain.
 *
 * Exported because history and diagnostics rewrite whole files for the same reason.
 */
export function writeFileAtomic(target: string, contents: string): Promise<void> {
  // ONE WRITE AT A TIME PER FILE, IN CALL ORDER — so the last call's contents are the ones
  // left on disk. Two writes in flight used to share one temp name: each truncated the
  // other's temp file, one rename failed with ENOENT, and the file left behind could be a
  // splice of the two that is not JSON at all (23 of 60 overlapping pairs in a test). Two
  // `settings:set` calls overlap easily — arrow keys on a slider, a toggle flipped twice —
  // and the next launch then read "could not be read" and started on defaults.
  const previous = writesInFlight.get(target) ?? Promise.resolve();
  const run = previous.then(() => writeOnce(target, contents));
  const settled = run.catch(() => undefined);
  writesInFlight.set(target, settled);
  void settled.then(() => {
    if (writesInFlight.get(target) === settled) writesInFlight.delete(target);
  });
  return run;
}

/** The tail of each file's write queue. Emptied as each queue drains. */
const writesInFlight = new Map<string, Promise<void>>();
let temporaryCounter = 0;

async function writeOnce(target: string, contents: string): Promise<void> {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });

  // `process.pid` keeps two Kotiba processes — one being replaced by an upgrade, say —
  // from racing on the same temp name and each renaming the other's half-written file;
  // the counter does the same for two writes inside this one.
  temporaryCounter += 1;
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${String(temporaryCounter)}.tmp`,
  );

  const handle = await fs.open(temporary, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function readIfPresent(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

export interface FileSettingsStoreOptions {
  /** `%APPDATA%\Kotiba`. Created with intermediates on first write. */
  readonly directory: string;
}

/**
 * The file-backed settings store.
 *
 * `load()` is safe to call on a missing file, an empty file, a truncated file and a
 * file full of another program's JSON. None of those throw, and none of them write.
 */
export function createFileSettingsStore(options: FileSettingsStoreOptions): SettingsStore {
  const file = path.join(options.directory, SETTINGS_FILE_NAME);
  const unreadableFile = path.join(options.directory, SETTINGS_UNREADABLE_FILE_NAME);

  let settings: Settings = WINDOWS_DEFAULT_SETTINGS;
  let failure: string | null = null;
  const listeners = new Set<(next: Settings) => void>();

  /**
   * Keep the original bytes before anything else happens to them.
   *
   * Written, never read back, never cleaned up — exactly as macOS does. It exists so
   * that a user whose settings stopped loading still has the model paths somewhere,
   * and so that a support bundle can say what the unreadable file actually contained.
   * `wx` refuses to clobber an existing copy: the FIRST failure is the interesting one,
   * and a second launch would otherwise overwrite it with the file it just wrote.
   */
  async function preserve(raw: string): Promise<void> {
    try {
      await fs.mkdir(options.directory, { recursive: true });
      const handle = await fs.open(unreadableFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL);
      try {
        await handle.writeFile(raw, 'utf8');
      } finally {
        await handle.close();
      }
    } catch {
      // A failure to keep the copy must not become a failure to start. The app is
      // already in its degraded path; making it throw here would turn "your settings
      // reset" into "the app will not launch".
    }
  }

  async function load(): Promise<SettingsLoad> {
    let raw: string | null;
    try {
      raw = await readIfPresent(file);
    } catch {
      // Unreadable for a reason that is not absence — a lock, a permission, a bad
      // sector. Defaults stand and NOTHING is written.
      settings = WINDOWS_DEFAULT_SETTINGS;
      failure = SETTINGS_LOAD_MESSAGES.unreadable;
      notify();
      return { settings, dropped: [], failure };
    }

    // No file at all is the ordinary first-launch state, not a failure. macOS returns
    // from `load()` at this point with `loadFailure` still nil, and — importantly — it
    // does not write the defaults out either. The file appears on the first change the
    // user makes, and until then a fresh install has nothing to corrupt.
    if (raw === null) {
      settings = WINDOWS_DEFAULT_SETTINGS;
      failure = null;
      notify();
      return { settings, dropped: [], failure };
    }

    const result = parseSettings(raw);
    settings = result.settings;
    failure = result.failure;

    // THE RULE THAT MATTERS: A FAILED READ MUST NOT WRITE.
    //
    // Anything went wrong — a total failure or a single dropped key — and the original
    // bytes are copied aside and the original file is LEFT ALONE. macOS returns from
    // `load()` without touching the stored blob for exactly this reason: writing the
    // defaults back destroys the only copy of the user's configuration, and the model
    // paths are the hardest state in this app to reconstruct.
    if (result.failure !== null) {
      await preserve(raw);
    }

    notify();
    return result;
  }

  async function persist(): Promise<void> {
    await writeFileAtomic(file, serialiseSettings(settings));
  }

  function notify(): void {
    for (const listener of listeners) listener(settings);
  }

  return {
    current(): Settings {
      return settings;
    },

    load,

    async update(patch: Partial<Settings>): Promise<Settings> {
      settings = { ...settings, ...patch };
      await persist();
      notify();
      return settings;
    },

    onChange(listener: (next: Settings) => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get loadFailure(): string | null {
      return failure;
    },
  };
}
