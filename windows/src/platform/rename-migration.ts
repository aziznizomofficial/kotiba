// Kotib → Kotiba, on Windows. The Mac's `RenameMigration` (Sources/KotibaPlatform) in the
// shape this port keeps its state: two directories instead of one, a file instead of a
// defaults domain, and Credential Manager instead of the Keychain.
//
//   1. `%APPDATA%\Kotib` → `%APPDATA%\Kotiba` (the settings blob and the models) and
//      `%LOCALAPPDATA%\Kotib` → `%LOCALAPPDATA%\Kotiba` (history and diagnostics). MOVED,
//      never copied: the models are gigabytes and a rename within one volume is instant.
//      Where the new directory already exists the two are merged item by item; on a clash
//      the old file wins and the new one is renamed aside (`name.before-rename`), exactly as
//      on the Mac. The settings blob has the same file name on both sides, so nothing else
//      about settings needs importing.
//   2. The polish key is copied from `uz.kotib.app:<account>` to `uz.kotiba.app:<account>`,
//      never over a key already set in the new app. Credential Manager has no per-app ACL,
//      so there is no prompt; the old credential is left, as on the Mac.
//
// A running old Kotib holds `history.jsonl` and `diagnostics.jsonl` open, and Windows
// refuses to move a directory with an open file in it (EBUSY/EPERM). That is reported, not
// thrown: the launch goes on, the shell raises the `renamed-legacy-running` blocker, and the
// next launch finishes through the merge path. Nothing is marked done until a pass completes
// with no problem.
//
// What it does NOT touch: the old install itself (its uninstaller, its Start-menu shortcut,
// and its `HKCU\…\Run` entry if always-on was on in it). Kotiba has a new appId, so it
// installs beside Kotib rather than over it; uninstalling Kotib from Settings › Apps removes
// all three and — its data being gone from `%APPDATA%\Kotib` by then — nothing else.

import { mkdir, readdir, rename, rm, stat, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import type { SecretStore } from '../contracts/index.js';

/** Written into the new roaming directory once a pass has completed with no problem. */
export const RENAME_MIGRATION_MARKER = 'renamed-from-kotib';
/** Appended to a new-side file an old file of the same name replaced. Never deleted. */
export const SET_ASIDE_SUFFIX = '.before-rename';

export interface RenameMigrationOptions {
  /** `{ legacy, current }` directory pairs: roaming and local (one pair on a POSIX dev box). */
  readonly directories: readonly { readonly legacy: string; readonly current: string }[];
  /** Where the completion marker lives — the new roaming directory. */
  readonly markerDirectory: string;
}

export interface RenameMigrationOutcome {
  /** Pairs moved in one rename. */
  readonly renamed: string[];
  /** Paths moved one by one by a merge, relative to their pair. */
  readonly merged: string[];
  /** New-side paths renamed aside because an old file replaced them. */
  readonly setAside: string[];
  /** One sentence per thing that did not work. Nothing here is fatal. */
  readonly problems: string[];
  readonly alreadyDone: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function sentence(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function merge(
  from: string,
  into: string,
  relative: string,
  outcome: RenameMigrationOutcome,
): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(from)).sort();
  } catch (error) {
    outcome.problems.push(`could not list ${from}: ${sentence(error)}`);
    return;
  }
  for (const name of names) {
    const source = join(from, name);
    const target = join(into, name);
    const path = relative === '' ? name : `${relative}/${name}`;
    if ((await isDirectory(source)) && (await isDirectory(target))) {
      await merge(source, target, path, outcome);
      await removeIfEmpty(source);
      continue;
    }
    if (await exists(target)) {
      const aside = `${target}${SET_ASIDE_SUFFIX}`;
      try {
        await rm(aside, { recursive: true, force: true });
        await rename(target, aside);
        outcome.setAside.push(path);
      } catch (error) {
        outcome.problems.push(`could not set aside ${target}: ${sentence(error)}`);
        continue;
      }
    }
    try {
      await rename(source, target);
      outcome.merged.push(path);
    } catch (error) {
      outcome.problems.push(`could not move ${source}: ${sentence(error)}`);
    }
  }
}

async function removeIfEmpty(directory: string): Promise<void> {
  try {
    if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true });
  } catch {
    // Left in place: whatever is still in it was reported by the merge.
  }
}

/** Move the old directories. Idempotent; runs to completion once, then only checks a file. */
export async function migrateKotibDirectories(
  options: RenameMigrationOptions,
): Promise<RenameMigrationOutcome> {
  const outcome: RenameMigrationOutcome = {
    renamed: [],
    merged: [],
    setAside: [],
    problems: [],
    alreadyDone: false,
  };
  const marker = join(options.markerDirectory, RENAME_MIGRATION_MARKER);
  if (await exists(marker)) return { ...outcome, alreadyDone: true };

  for (const { legacy, current } of options.directories) {
    if (legacy === current || !(await exists(legacy))) continue;
    if (!(await exists(current))) {
      try {
        await rename(legacy, current);
        outcome.renamed.push(current);
        continue;
      } catch (error) {
        // EBUSY/EPERM: the old app has a file open. Fall through to the merge, which moves
        // everything that is not open and reports what is.
        outcome.problems.push(`could not rename ${legacy}: ${sentence(error)}`);
        try {
          await mkdir(current, { recursive: true });
        } catch {
          continue;
        }
      }
    }
    await merge(legacy, current, '', outcome);
    await removeIfEmpty(legacy);
  }

  if (outcome.problems.length === 0) {
    try {
      await mkdir(options.markerDirectory, { recursive: true });
      await writeFile(marker, `${new Date().toISOString()}\n`, 'utf8');
    } catch (error) {
      outcome.problems.push(`could not record the migration: ${sentence(error)}`);
    }
  }
  return outcome;
}

/**
 * Copy the polish key(s) to the new credential target. Credential Manager cannot list a
 * prefix without a second P/Invoke, and the accounts are known: the default one and
 * whichever the (just migrated) settings name. Returns the accounts copied.
 */
export async function migrateKotibSecrets(options: {
  readonly legacy: SecretStore;
  readonly current: SecretStore;
  readonly accounts: readonly string[];
}): Promise<{ readonly copied: string[]; readonly problems: string[] }> {
  const copied: string[] = [];
  const problems: string[] = [];
  for (const account of [...new Set(options.accounts)]) {
    try {
      if ((await options.current.get(account)) !== null) continue;
      const value = await options.legacy.get(account);
      if (value === null || value === '') continue;
      await options.current.set(account, value);
      copied.push(account);
    } catch (error) {
      problems.push(`could not copy the credential ${account}: ${sentence(error)}`);
    }
  }
  return { copied, problems };
}
