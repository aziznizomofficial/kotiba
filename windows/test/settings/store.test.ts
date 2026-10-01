// The file-backed settings store.
//
// Two rules the pure layer cannot enforce, and both of them cost the user their model
// paths when they are broken: write atomically, and NEVER write on a failed read.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SETTINGS_FILE_NAME,
  SETTINGS_LOAD_MESSAGES,
  SETTINGS_UNREADABLE_FILE_NAME,
} from '../../src/contracts/index.js';
import { WINDOWS_DEFAULT_SETTINGS, serialiseSettings } from '../../src/core/settings/index.js';
import { createFileSettingsStore, writeFileAtomic } from '../../src/platform/settings.js';

let directory: string;
let file: string;
let unreadable: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kotiba-settings-'));
  file = path.join(directory, SETTINGS_FILE_NAME);
  unreadable = path.join(directory, SETTINGS_UNREADABLE_FILE_NAME);
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('a fresh install', () => {
  it('loads defaults from a missing file without reporting a failure', async () => {
    const store = createFileSettingsStore({ directory });
    const load = await store.load();

    expect(load.failure).toBeNull();
    expect(load.dropped).toEqual([]);
    expect(load.settings).toEqual(WINDOWS_DEFAULT_SETTINGS);
    expect(store.loadFailure).toBeNull();
  });

  it('does not write anything until the user changes something', async () => {
    const store = createFileSettingsStore({ directory });
    await store.load();
    // Nothing to corrupt on a fresh install, and nothing to explain if the app never
    // launches again.
    expect(await exists(file)).toBe(false);

    await store.update({ soundFeedback: true });
    expect(await exists(file)).toBe(true);
  });
});

describe('an ordinary round trip', () => {
  it('persists a patch and reads it back', async () => {
    const first = createFileSettingsStore({ directory });
    await first.load();
    await first.update({ pinnedLanguage: 'uz', historyLimit: 200 });

    const second = createFileSettingsStore({ directory });
    const load = await second.load();
    expect(load.settings.pinnedLanguage).toBe('uz');
    expect(load.settings.historyLimit).toBe(200);
    expect(load.failure).toBeNull();
  });

  it('keeps a cleared pin cleared across a restart', async () => {
    const first = createFileSettingsStore({ directory });
    await first.load();
    await first.update({ pinnedLanguage: 'uz' });
    await first.update({ pinnedLanguage: null });

    const second = createFileSettingsStore({ directory });
    expect((await second.load()).settings.pinnedLanguage).toBeNull();
  });

  it('notifies listeners on every change', async () => {
    const store = createFileSettingsStore({ directory });
    const seen: (boolean | undefined)[] = [];
    const stop = store.onChange((next) => seen.push(next.soundFeedback));

    await store.load();
    await store.update({ soundFeedback: true });
    stop();
    await store.update({ soundFeedback: false });

    expect(seen).toEqual([false, true]);
  });
});

describe('a failed read must not write', () => {
  it('leaves a corrupt file byte-identical and keeps a copy aside', async () => {
    const corrupt = '{ this is not json';
    await fs.writeFile(file, corrupt, 'utf8');

    const store = createFileSettingsStore({ directory });
    const load = await store.load();

    expect(load.failure).toBe(SETTINGS_LOAD_MESSAGES.unreadable);
    expect(load.settings).toEqual(WINDOWS_DEFAULT_SETTINGS);

    // THE RULE. Writing defaults back here destroys the only copy of the user's
    // configuration, and the model paths are the hardest state in this app to rebuild.
    expect(await fs.readFile(file, 'utf8')).toBe(corrupt);
    expect(await fs.readFile(unreadable, 'utf8')).toBe(corrupt);
  });

  it('keeps a copy aside when only some keys were unreadable, and still does not write', async () => {
    const partial = JSON.stringify({
      uzbekModelPath: 'C:\\models\\uz.bin',
      defaultLanguage: 'kk',
      whisperBeamSize: 'five',
    });
    await fs.writeFile(file, partial, 'utf8');

    const store = createFileSettingsStore({ directory });
    const load = await store.load();

    expect(load.dropped).toEqual(['defaultLanguage', 'whisperBeamSize']);
    expect(load.settings.uzbekModelPath).toBe('C:\\models\\uz.bin');
    expect(await fs.readFile(file, 'utf8')).toBe(partial);
    expect(await fs.readFile(unreadable, 'utf8')).toBe(partial);
  });

  it('keeps the FIRST unreadable copy, not the most recent launch', async () => {
    await fs.writeFile(file, 'original bytes', 'utf8');
    await createFileSettingsStore({ directory }).load();
    await fs.writeFile(file, 'later bytes', 'utf8');
    await createFileSettingsStore({ directory }).load();

    // The first failure is the interesting one; a second launch overwriting it would
    // throw away the only copy of the configuration that mattered.
    expect(await fs.readFile(unreadable, 'utf8')).toBe('original bytes');
  });

  it('writes no copy when the file read cleanly', async () => {
    await fs.writeFile(file, serialiseSettings(WINDOWS_DEFAULT_SETTINGS), 'utf8');
    await createFileSettingsStore({ directory }).load();
    expect(await exists(unreadable)).toBe(false);
  });

  it('reports the failure through loadFailure as well as the load result', async () => {
    await fs.writeFile(file, 'nonsense', 'utf8');
    const store = createFileSettingsStore({ directory });
    await store.load();
    expect(store.loadFailure).toBe(SETTINGS_LOAD_MESSAGES.unreadable);
  });

  it('never throws on startup, whatever the file contains', async () => {
    for (const contents of ['', '   ', '[]', 'null', '\u0000\u0000', '{"a":']) {
      await fs.writeFile(file, contents, 'utf8');
      const store = createFileSettingsStore({ directory });
      await expect(store.load()).resolves.toBeDefined();
    }
  });
});

describe('atomic writes', () => {
  it('leaves no temp file behind', async () => {
    const store = createFileSettingsStore({ directory });
    await store.load();
    await store.update({ soundFeedback: true });

    const left = (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'));
    expect(left).toEqual([]);
  });

  it('replaces the whole file rather than truncating and rewriting it', async () => {
    // A longer file overwritten by a shorter one must not leave the tail of the old
    // one behind — which is exactly what an in-place write does when it forgets to
    // truncate, and it produces trailing JSON that parses as a total failure.
    const long = path.join(directory, 'probe.json');
    await writeFileAtomic(long, `${'x'.repeat(4096)}\n`);
    await writeFileAtomic(long, 'short\n');
    expect(await fs.readFile(long, 'utf8')).toBe('short\n');
  });

  it('creates the directory it was pointed at', async () => {
    const nested = path.join(directory, 'Kotiba', 'nested');
    const store = createFileSettingsStore({ directory: nested });
    await store.load();
    await store.update({ soundFeedback: true });
    expect(await exists(path.join(nested, SETTINGS_FILE_NAME))).toBe(true);
  });
});
