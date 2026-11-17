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
  // ONE WRITE AT A TIME PER FILE, AND THE LAST CALL'S CONTENTS ARE THE ONES LEFT ON DISK.
  // Two writes in flight used to share one temp name: each truncated the other's temp file,
  // one rename failed with ENOENT, and the file left behind could be a splice of the two
  // that is not JSON at all (23 of 60 overlapping pairs in a test). Two `settings:set`
  // calls overlap easily — arrow keys on a slider, a toggle flipped twice — and the next
  // launch then read "could not be read" and started on defaults.
  //
  // COALESCED, NOT MERELY QUEUED. Every caller hands over the WHOLE file, so while one
  // write is on its way to the disk, any number of later calls collapse into one: the
  // newest contents, written once, and every one of those callers settles with it. Ten
  // arrow-key presses on a slider used to be ten temp files and ten fsyncs in a row —
  // on a laptop disk with an antivirus scanning each new file, a queue that took seconds
  // to drain, during which a quit could cut it short.
  let queue = writeQueues.get(target);
  if (queue === undefined) {
    queue = { running: false, next: null };
    writeQueues.set(target, queue);
  }
  if (queue.next !== null) {
    queue.next.contents = contents;
    return queue.next.done;
  }
  let settle: { resolve: () => void; reject: (error: unknown) => void } = { resolve: () => {}, reject: () => {} };
  const done = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  queue.next = { contents, done, ...settle };
  if (!queue.running) void drain(target, queue);
  return done;
}

interface PendingWrite {
  contents: string;
  readonly done: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface WriteQueue {
  running: boolean;
  /** The write waiting behind the running one; later calls overwrite its contents. */
  next: PendingWrite | null;
}

/** One queue per file, removed as each drains. */
const writeQueues = new Map<string, WriteQueue>();
let temporaryCounter = 0;

async function drain(target: string, queue: WriteQueue): Promise<void> {
  queue.running = true;
  while (queue.next !== null) {
    // Taken BEFORE the first await, so a call made while this one is on the disk queues
    // a fresh write instead of joining one whose bytes are already fixed.
    const job = queue.next;
    queue.next = null;
    try {
      await writeOnce(target, job.contents);
      job.resolve();
    } catch (error: unknown) {
      job.reject(error);
    }
  }
  queue.running = false;
  writeQueues.delete(target);
}

/** Overridable by tests, which cannot make a real file busy on a POSIX runner. */
export const atomicWriteFs = {
  rename: (from: string, to: string): Promise<void> => fs.rename(from, to),
};

async function writeOnce(target: string, contents: string): Promise<void> {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });

  // `process.pid` keeps two Kotiba processes — one being replaced by an upgrade, say —
  // from racing on the same temp name and each renaming the other's half-written file;
  // the counter does the same for two files written inside this one.
  temporaryCounter += 1;
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${String(temporaryCounter)}.tmp`,
  );

  try {
    const handle = await fs.open(temporary, 'w');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, target);
  } catch (error) {
    // Any failure — a full disk mid-write as much as a refused rename — takes the temp
    // file with it. Left behind, each failed save on a full disk is one more file on it.
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The codes Windows answers a rename with while another process holds the target open. */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Waits between rename attempts: about two seconds in all. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640, 640];

/**
 * `rename`, retried while Windows says the target is busy.
 *
 * Replacing a file on Windows fails with EPERM / EACCES / EBUSY for as long as any process
 * has it open without FILE_SHARE_DELETE — and the processes that do that are Defender
 * scanning the file we wrote a moment ago, the search indexer, a backup or sync client
 * (OneDrive syncs %APPDATA% on some managed machines). Each holds it for milliseconds to a
 * second. Failing on the first refusal threw away a settings write, a history rewrite or a
 * diagnostics trim for a lock that would have been gone by the next attempt; graceful-fs
 * retries the same codes for the same reason. A refusal that outlasts the schedule is real
 * and is thrown.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => Promise<void> = (f, t) => atomicWriteFs.rename(f, t),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (code === undefined || !TRANSIENT_RENAME_CODES.has(code) || delay === undefined) throw error;
      await sleep(delay);
    }
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
