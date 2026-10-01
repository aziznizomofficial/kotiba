// Kotib → Kotiba on Windows: the directory moves and the credential copy, against scratch
// directories under the OS temp dir and an in-memory SecretStore. Never the real %APPDATA%,
// %LOCALAPPDATA% or Credential Manager.

import { mkdtemp, mkdir, readFile, rm, stat, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SecretStore } from '../../src/contracts/index.js';
import { kotibaPaths } from '../../src/core/settings/index.js';
import { LEGACY_SUPPORT_DIRECTORY_NAME } from '../../src/contracts/index.js';
import {
  RENAME_MIGRATION_MARKER,
  migrateKotibDirectories,
  migrateKotibSecrets,
} from '../../src/platform/rename-migration.js';

let root = '';
const roamingOld = (): string => join(root, 'Roaming', 'Kotib');
const roamingNew = (): string => join(root, 'Roaming', 'Kotiba');
const localOld = (): string => join(root, 'Local', 'Kotib');
const localNew = (): string => join(root, 'Local', 'Kotiba');

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}
async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
const run = () =>
  migrateKotibDirectories({
    directories: [
      { legacy: roamingOld(), current: roamingNew() },
      { legacy: localOld(), current: localNew() },
    ],
    markerDirectory: roamingNew(),
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-rename-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('rename migration — directories', () => {
  it('does nothing on a machine that never had Kotib', async () => {
    const outcome = await run();
    expect(outcome.renamed).toEqual([]);
    expect(outcome.problems).toEqual([]);
    expect(await present(join(roamingNew(), RENAME_MIGRATION_MARKER))).toBe(true);
  });

  it('renames both directories in place (same inode: a move, not a copy)', async () => {
    await put(join(roamingOld(), 'settings.v1.json'), '{"alwaysOn":true}');
    await put(join(roamingOld(), 'models', 'ggml-uzbek-stt-v1-q5_0.bin'), 'weights');
    await put(join(localOld(), 'history.jsonl'), 'line\n');
    const before = (await stat(join(roamingOld(), 'models', 'ggml-uzbek-stt-v1-q5_0.bin'))).ino;

    const outcome = await run();

    expect(outcome.renamed).toEqual([roamingNew(), localNew()]);
    expect(await readFile(join(roamingNew(), 'settings.v1.json'), 'utf8')).toBe('{"alwaysOn":true}');
    expect(await readFile(join(localNew(), 'history.jsonl'), 'utf8')).toBe('line\n');
    expect((await stat(join(roamingNew(), 'models', 'ggml-uzbek-stt-v1-q5_0.bin'))).ino).toBe(before);
    expect(await present(roamingOld())).toBe(false);
    expect(await present(localOld())).toBe(false);
  });

  it('merges into an existing Kotiba directory, and the old file wins whole', async () => {
    await put(join(roamingNew(), 'settings.v1.json'), '{}');
    await put(join(roamingNew(), 'models', 'y.bin'), 'y');
    await put(join(roamingOld(), 'settings.v1.json'), '{"alwaysOn":true}');
    await put(join(roamingOld(), 'models', 'x.bin'), 'x');

    const outcome = await run();

    expect(await readFile(join(roamingNew(), 'settings.v1.json'), 'utf8')).toBe('{"alwaysOn":true}');
    expect(await readFile(join(roamingNew(), 'settings.v1.json.before-rename'), 'utf8')).toBe('{}');
    expect(await present(join(roamingNew(), 'models', 'x.bin'))).toBe(true);
    expect(await present(join(roamingNew(), 'models', 'y.bin'))).toBe(true);
    expect(outcome.setAside).toEqual(['settings.v1.json']);
    expect(await present(roamingOld())).toBe(false);
  });

  it('runs once: a later Kotib install is not merged in behind the user', async () => {
    await put(join(roamingOld(), 'settings.v1.json'), 'a');
    await run();
    await put(join(roamingOld(), 'settings.v1.json'), 'b');

    const again = await run();
    expect(again.alreadyDone).toBe(true);
    expect(await readFile(join(roamingOld(), 'settings.v1.json'), 'utf8')).toBe('b');
  });

  it('the legacy layout is the same layout under the old name', () => {
    const env = { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    const legacy = kotibaPaths(env, LEGACY_SUPPORT_DIRECTORY_NAME);
    expect(legacy.roamingDirectory).toBe('C:\\Users\\a\\AppData\\Roaming\\Kotib');
    expect(legacy.historyFile).toBe('C:\\Users\\a\\AppData\\Local\\Kotib\\history.jsonl');
    expect(kotibaPaths(env).roamingDirectory).toBe('C:\\Users\\a\\AppData\\Roaming\\Kotiba');
  });
});

function memorySecrets(initial: Record<string, string> = {}): SecretStore & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    get: (account) => Promise.resolve(items.get(account) ?? null),
    set: (account, value) => {
      items.set(account, value);
      return Promise.resolve();
    },
    remove: (account) => {
      items.delete(account);
      return Promise.resolve();
    },
  };
}

describe('rename migration — the polish key', () => {
  it('copies to the new target and leaves the old one', async () => {
    const legacy = memorySecrets({ 'polish-default': 'sk-old' });
    const current = memorySecrets();
    const result = await migrateKotibSecrets({ legacy, current, accounts: ['polish-default', 'polish-default'] });
    expect(result.copied).toEqual(['polish-default']);
    expect(current.items.get('polish-default')).toBe('sk-old');
    expect(legacy.items.get('polish-default')).toBe('sk-old');
  });

  it('never overwrites a key already set in Kotiba', async () => {
    const legacy = memorySecrets({ 'polish-default': 'sk-old' });
    const current = memorySecrets({ 'polish-default': 'sk-new' });
    const result = await migrateKotibSecrets({ legacy, current, accounts: ['polish-default'] });
    expect(result.copied).toEqual([]);
    expect(current.items.get('polish-default')).toBe('sk-new');
  });

  it('reports a failing store rather than throwing', async () => {
    const legacy: SecretStore = {
      get: () => Promise.reject(new Error('Credential Manager could not read the key')),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const result = await migrateKotibSecrets({ legacy, current: memorySecrets(), accounts: ['polish-default'] });
    expect(result.problems).toHaveLength(1);
  });
});
