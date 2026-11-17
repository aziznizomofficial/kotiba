// REGRESSION (final win review 2026-09-30, fixed): two settings writes in flight at once — a slider dragged, a toggle
// flipped while the controller persists a pin — share ONE temp file name, so the
// second write truncates the first's temp file and its own rename then fails.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SETTINGS_FILE_NAME } from '../../src/contracts/index.js';
import { atomicWriteFs, createFileSettingsStore, writeFileAtomic } from '../../src/platform/settings.js';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kotiba-review-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('two overlapping writeFileAtomic calls to one target both succeed and leave one whole file', async () => {
  const target = path.join(directory, 'x.json');
  const a = JSON.stringify({ a: 'a'.repeat(50_000) });
  const b = JSON.stringify({ b: 1 });
  const results = await Promise.allSettled([writeFileAtomic(target, a), writeFileAtomic(target, b)]);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  const body = await fs.readFile(target, 'utf8');
  expect([a, b]).toContain(body);
});

it('overlapping settings updates never reject and the file holds the last state', async () => {
  const store = createFileSettingsStore({ directory });
  await store.load();
  const writes = [0.1, 0.2, 0.3, 0.4, 0.5].map((v) =>
    store.update({ duckLevel: v } as never),
  );
  const results = await Promise.allSettled(writes);
  expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
  const saved = JSON.parse(await fs.readFile(path.join(directory, SETTINGS_FILE_NAME), 'utf8')) as Record<string, unknown>;
  expect(JSON.stringify(saved)).toContain('0.5');
});

// I/O-BOUND BY DESIGN: up to 180 temp files, each fsync'd. It timed out at vitest's 5 s default
// when the whole suite ran beside other heavy jobs — the flake the 1.0.3 review chased. It was
// not a serialisation bug (the queue held every time); writes are now coalesced, which halves
// the fsyncs here, and the budget says what this test costs instead of hoping.
it('whatever the interleaving, the settings file on disk always parses', { timeout: 30_000 }, async () => {
  const store = createFileSettingsStore({ directory });
  await store.load();
  const target = path.join(directory, SETTINGS_FILE_NAME);
  let unparsable = 0;
  for (let round = 0; round < 60; round += 1) {
    // Values of different printed lengths, so a shorter write over a longer one shows.
    await Promise.allSettled([
      store.update({ duckLevel: 0.123456789 } as never),
      store.update({ duckLevel: 0.5 } as never),
      store.update({ polishModel: 'x'.repeat(round * 50) } as never),
    ]);
    try {
      JSON.parse(await fs.readFile(target, 'utf8'));
    } catch {
      unparsable += 1;
    }
  }
  expect(unparsable).toBe(0);
});

it('overlapping writes are coalesced: the newest contents, written once, and every caller settles', async () => {
  const target = path.join(directory, 'x.json');
  const rename = vi.spyOn(atomicWriteFs, 'rename');
  const calls = Array.from({ length: 10 }, (_, i) => writeFileAtomic(target, JSON.stringify({ i })));
  const results = await Promise.allSettled(calls);
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  // The first goes to disk at once; the nine that arrived while it was there collapse into one.
  expect(rename).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ i: 9 });
});

it('a rename Windows refuses while a scanner holds the file is retried, not reported', async () => {
  const target = path.join(directory, 'x.json');
  const real = atomicWriteFs.rename;
  let refusals = 0;
  vi.spyOn(atomicWriteFs, 'rename').mockImplementation(async (from, to) => {
    if (refusals < 3) {
      refusals += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    await real(from, to);
  });
  await writeFileAtomic(target, '{"ok":true}');
  expect(refusals).toBe(3);
  expect(await fs.readFile(target, 'utf8')).toBe('{"ok":true}');
});

it('a rename that keeps failing gives up, rejects, and leaves no temp file behind', async () => {
  const target = path.join(directory, 'x.json');
  vi.spyOn(atomicWriteFs, 'rename').mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
  await expect(writeFileAtomic(target, '{}')).rejects.toThrow('EPERM');
  expect(await fs.readdir(directory)).toEqual([]);
});

it('a failure that is not a busy file is not retried', async () => {
  const target = path.join(directory, 'x.json');
  const rename = vi.spyOn(atomicWriteFs, 'rename').mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
  await expect(writeFileAtomic(target, '{}')).rejects.toThrow('ENOSPC');
  expect(rename).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(directory)).toEqual([]);
});
