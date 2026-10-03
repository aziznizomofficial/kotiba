// First-use bundle downloads: idempotent by checksum, a download that does not verify
// never lands, the stamp is what "installed" means, and nothing is fetched twice at once.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe as suite, expect, test } from 'vitest';

import type { BundleId, ModelBundleSpec } from '../../src/contracts/index.js';
import {
  BUNDLE_CATALOGUE,
  ECAPA_LID,
  PARAKEET_ULTRA,
  QWEN3_1_7B,
  SHIPPED_BUNDLE_IDS,
  SHIPPED_HASH_LIMIT_BYTES,
  SILERO_VAD,
  bundleBytes,
} from '../../src/contracts/index.js';
import { createBundleStore } from '../../src/engines/bundle-store.js';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-bundles-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const payload = (text: string): Buffer => Buffer.from(text.repeat(1000));
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const A = payload('encoder ');
const B = payload('vocab ');

const TINY: ModelBundleSpec = {
  id: 'parakeet_ultra',
  name: 'Tiny',
  directory: 'tiny',
  baseUrl: 'https://example.invalid/pinned/',
  files: [
    { remotePath: 'int8/a.onnx', localName: 'a.onnx', bytes: A.length, sha256: sha(A) },
    { remotePath: 'b.txt', localName: 'b.txt', bytes: B.length, sha256: sha(B) },
  ],
  licence: 'test',
};
const CATALOGUE: Record<BundleId, ModelBundleSpec> = {
  parakeet_ultra: TINY,
  qwen3_1_7b: { ...TINY, directory: 'other' },
  silero_vad: { ...TINY, directory: 'vad' },
  cohere_arabic: { ...TINY, directory: 'cohere' },
  fastconformer_ar: { ...TINY, directory: 'fastconformer' },
  gemma4_e2b_ar: { ...TINY, directory: 'gemma' },
  ecapa_lid: { ...TINY, directory: 'lid' },
};

function fakeFetch(files: Record<string, Buffer>, requests: string[]) {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    requests.push(href);
    const key = href.replace(TINY.baseUrl, '');
    const data = files[key];
    if (data === undefined) return new Response('missing', { status: 404 });
    // In three pieces, so the store hashes and writes a stream, not one buffer.
    const third = Math.ceil(data.length / 3);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < data.length; at += third) controller.enqueue(new Uint8Array(data.subarray(at, at + third)));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

suite('the catalogue pins what C1 §8 and C3 §7 recorded', () => {
  test('Parakeet Ultra: five files at one commit, 668 MB (667,961,292 bytes)', () => {
    expect(PARAKEET_ULTRA.baseUrl).toContain('/resolve/dd203225f41c8a7d0323967afa1869cea0907436/');
    expect(PARAKEET_ULTRA.files.map((file) => file.remotePath)).toEqual([
      'int8/encoder-model.int8.onnx',
      'int8/decoder_joint-model.int8.onnx',
      'nemo128.onnx',
      'vocab.txt',
      'config.json',
    ]);
    expect(PARAKEET_ULTRA.files.reduce((sum, file) => sum + file.bytes, 0)).toBe(667_961_292);
    for (const file of PARAKEET_ULTRA.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('Qwen3-1.7B: the GGUF the Mac runs', () => {
    expect(QWEN3_1_7B.files[0]!.sha256).toBe('d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5');
    expect(QWEN3_1_7B.files[0]!.bytes).toBe(1_282_439_264);
    expect(BUNDLE_CATALOGUE.qwen3_1_7b.baseUrl).toContain('/resolve/daeb8e2d528a760970442092f6bf1e55c3b659eb/');
  });
});

suite('ensure', () => {
  test('downloads, verifies, stamps — and a second call fetches nothing', async () => {
    const requests: string[] = [];
    const store = createBundleStore({
      modelsDirectory: root,
      catalogue: CATALOGUE,
      fetch: fakeFetch({ 'int8/a.onnx': A, 'b.txt': B }, requests),
    });
    expect(await store.isInstalled('parakeet_ultra')).toBe(false);
    const progress: number[] = [];
    const directory = await store.ensure('parakeet_ultra', (p) => progress.push(p.receivedBytes));
    expect(directory).toBe(join(root, 'tiny'));
    expect(await store.isInstalled('parakeet_ultra')).toBe(true);
    expect(await store.locate('parakeet_ultra')).toBe(directory);
    expect(progress[progress.length - 1]).toBe(A.length + B.length);
    expect(requests).toHaveLength(2);
    await store.ensure('parakeet_ultra');
    expect(requests).toHaveLength(2);
    expect((await readdir(directory)).sort()).toEqual(['.kotiba-verified.json', 'a.onnx', 'b.txt']);
  });

  test('a corrupt download never lands, and leaves no partial behind', async () => {
    const requests: string[] = [];
    const store = createBundleStore({
      modelsDirectory: root,
      catalogue: CATALOGUE,
      fetch: fakeFetch({ 'int8/a.onnx': payload('tampered'), 'b.txt': B }, requests),
    });
    await expect(store.ensure('parakeet_ultra')).rejects.toThrow(/arrived corrupt/);
    expect(await store.isInstalled('parakeet_ultra')).toBe(false);
    expect(await readdir(join(root, 'tiny'))).toEqual([]);
  });

  test('an HTTP failure says so', async () => {
    const store = createBundleStore({ modelsDirectory: root, catalogue: CATALOGUE, fetch: fakeFetch({}, []) });
    await expect(store.ensure('parakeet_ultra')).rejects.toThrow(/HTTP 404/);
  });

  test('a file already on disk is verified by checksum, not refetched', async () => {
    await mkdir(join(root, 'tiny'), { recursive: true });
    await writeFile(join(root, 'tiny', 'a.onnx'), A);
    const requests: string[] = [];
    const store = createBundleStore({
      modelsDirectory: root,
      catalogue: CATALOGUE,
      fetch: fakeFetch({ 'int8/a.onnx': A, 'b.txt': B }, requests),
    });
    await store.ensure('parakeet_ultra');
    expect(requests.map((url) => url.replace(TINY.baseUrl, ''))).toEqual(['b.txt']);
  });

  test('two callers at once share one download', async () => {
    const requests: string[] = [];
    const store = createBundleStore({
      modelsDirectory: root,
      catalogue: CATALOGUE,
      fetch: fakeFetch({ 'int8/a.onnx': A, 'b.txt': B }, requests),
    });
    await Promise.all([store.ensure('parakeet_ultra'), store.ensure('parakeet_ultra')]);
    expect(requests).toHaveLength(2);
  });

  test('a verified copy in the read-only directory is used as-is', async () => {
    const shipped = join(root, 'app');
    const writer = createBundleStore({
      modelsDirectory: shipped,
      catalogue: CATALOGUE,
      fetch: fakeFetch({ 'int8/a.onnx': A, 'b.txt': B }, []),
    });
    await writer.ensure('parakeet_ultra');
    const requests: string[] = [];
    const store = createBundleStore({
      modelsDirectory: join(root, 'user'),
      readOnlyDirectory: shipped,
      catalogue: CATALOGUE,
      fetch: fakeFetch({}, requests),
    });
    expect(await store.locate('parakeet_ultra')).toBe(join(shipped, 'tiny'));
    expect(await store.ensure('parakeet_ultra')).toBe(join(shipped, 'tiny'));
    expect(requests).toEqual([]);
  });

  test('a file that changed size since the stamp is not installed', async () => {
    const store = createBundleStore({
      modelsDirectory: root,
      catalogue: CATALOGUE,
      fetch: fakeFetch({ 'int8/a.onnx': A, 'b.txt': B }, []),
    });
    await store.ensure('parakeet_ultra');
    await writeFile(join(root, 'tiny', 'b.txt'), 'short');
    expect(await store.isInstalled('parakeet_ultra')).toBe(false);
  });
});

/** A server that honours `Range`, and can be told to cut a body short or to ignore ranges. */
function rangedFetch(
  files: Record<string, Buffer>,
  log: { url: string; range: string | null }[],
  behaviour: { cutAfter?: number; ignoreRange?: boolean } = {},
) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    log.push({ url: href.replace(TINY.baseUrl, ''), range });
    const data = files[href.replace(TINY.baseUrl, '')];
    if (data === undefined) return new Response('missing', { status: 404 });
    const from = range !== null && behaviour.ignoreRange !== true ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const slice = data.subarray(from);
    const cut = behaviour.cutAfter;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      // Pulled, so the first piece is READ before the error arrives — an error raised in
      // `start` would discard a chunk still in the queue, which is not what a reset does.
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(cut === undefined ? slice : slice.subarray(0, cut)));
          return;
        }
        if (cut !== undefined) controller.error(new Error('connection reset'));
        else controller.close();
      },
    });
    return new Response(body, { status: from > 0 ? 206 : 200 });
  }) as typeof fetch;
}

suite('resuming', () => {
  test('a dropped connection leaves a partial, and the next attempt asks only for the rest', async () => {
    const log: { url: string; range: string | null }[] = [];
    const first = createBundleStore({
      modelsDirectory: root,
      catalogue: CATALOGUE,
      fetch: rangedFetch({ 'int8/a.onnx': A, 'b.txt': B }, log, { cutAfter: 3000 }),
    });
    await expect(first.ensure('parakeet_ultra')).rejects.toThrow(/connection reset/);
    expect((await readFile(join(root, 'tiny', 'a.onnx.partial'))).length).toBe(3000);
    expect(await first.isInstalled('parakeet_ultra')).toBe(false);

    const second = createBundleStore({
      modelsDirectory: root,
      catalogue: CATALOGUE,
      fetch: rangedFetch({ 'int8/a.onnx': A, 'b.txt': B }, log),
    });
    const progress: number[] = [];
    await second.ensure('parakeet_ultra', (p) => progress.push(p.receivedBytes));
    expect(log.slice(1)).toEqual([
      { url: 'int8/a.onnx', range: 'bytes=3000-' },
      { url: 'b.txt', range: null },
    ]);
    expect(await second.isInstalled('parakeet_ultra')).toBe(true);
    expect(await readFile(join(root, 'tiny', 'a.onnx'))).toEqual(A);
    expect(progress.at(-1)).toBe(A.length + B.length);
    expect((await readdir(join(root, 'tiny'))).sort()).toEqual(['.kotiba-verified.json', 'a.onnx', 'b.txt']);
  });

  test('a server that ignores the range restarts the file instead of appending a second copy', async () => {
    await mkdir(join(root, 'tiny'), { recursive: true });
    await writeFile(join(root, 'tiny', 'a.onnx.partial'), A.subarray(0, 1000));
    const log: { url: string; range: string | null }[] = [];
    const store = createBundleStore({
      modelsDirectory: root,
      catalogue: CATALOGUE,
      fetch: rangedFetch({ 'int8/a.onnx': A, 'b.txt': B }, log, { ignoreRange: true }),
    });
    await store.ensure('parakeet_ultra');
    expect(await readFile(join(root, 'tiny', 'a.onnx'))).toEqual(A);
  });

  test('a partial of different bytes fails the whole-file hash, is deleted, and the next attempt starts clean', async () => {
    await mkdir(join(root, 'tiny'), { recursive: true });
    await writeFile(join(root, 'tiny', 'a.onnx.partial'), Buffer.alloc(1000, 7));
    const log: { url: string; range: string | null }[] = [];
    const store = createBundleStore({
      modelsDirectory: root,
      catalogue: CATALOGUE,
      fetch: rangedFetch({ 'int8/a.onnx': A, 'b.txt': B }, log),
    });
    await expect(store.ensure('parakeet_ultra')).rejects.toThrow(/arrived corrupt/);
    expect(await readdir(join(root, 'tiny'))).toEqual([]);
    await store.ensure('parakeet_ultra');
    expect(log.at(-2)).toEqual({ url: 'int8/a.onnx', range: null });
  });

  test('a complete partial from a run that died before the rename is verified, not refetched', async () => {
    await mkdir(join(root, 'tiny'), { recursive: true });
    await writeFile(join(root, 'tiny', 'a.onnx.partial'), A);
    const log: { url: string; range: string | null }[] = [];
    const store = createBundleStore({
      modelsDirectory: root,
      catalogue: CATALOGUE,
      fetch: rangedFetch({ 'int8/a.onnx': A, 'b.txt': B }, log),
    });
    await store.ensure('parakeet_ultra');
    expect(log.map((entry) => entry.url)).toEqual(['b.txt']);
  });
});

suite('shipped bundles (Silero, in the installer)', () => {
  test('Silero and the language-ID model ship; only Silero is small enough to hash at launch', () => {
    expect(SHIPPED_BUNDLE_IDS).toEqual(['silero_vad', 'ecapa_lid']);
    expect(SILERO_VAD.files.map((file) => file.localName)).toEqual(['ggml-silero-v6.2.0.bin']);
    expect(SILERO_VAD.files[0]!.bytes).toBe(885_098);
    expect(bundleBytes(SILERO_VAD)).toBeLessThanOrEqual(SHIPPED_HASH_LIMIT_BYTES);
    // 86 MB: fetch-models.mjs stages it with its stamp, which is what the store checks instead.
    expect(bundleBytes(ECAPA_LID)).toBeGreaterThan(SHIPPED_HASH_LIMIT_BYTES);
    expect(ECAPA_LID.files.map((file) => file.localName)).toEqual(['ecapa-voxlingua107-lid.onnx']);
  });

  test('an installer copy with no stamp is found by its hash, and nothing is fetched', async () => {
    const shipped = join(root, 'resources', 'models');
    await mkdir(join(shipped, 'vad'), { recursive: true });
    await writeFile(join(shipped, 'vad', 'a.onnx'), A);
    await writeFile(join(shipped, 'vad', 'b.txt'), B);
    const requests: string[] = [];
    const store = createBundleStore({
      modelsDirectory: join(root, 'user'),
      readOnlyDirectory: shipped,
      catalogue: CATALOGUE,
      fetch: fakeFetch({}, requests),
    });
    expect(await store.locate('silero_vad')).toBe(join(shipped, 'vad'));
    expect(await store.isInstalled('silero_vad')).toBe(true);
    expect(requests).toEqual([]);
  });

  test('an installer copy with the right size and the wrong bytes is not trusted', async () => {
    const shipped = join(root, 'resources', 'models');
    await mkdir(join(shipped, 'vad'), { recursive: true });
    await writeFile(join(shipped, 'vad', 'a.onnx'), Buffer.alloc(A.length, 1));
    await writeFile(join(shipped, 'vad', 'b.txt'), B);
    const store = createBundleStore({
      modelsDirectory: join(root, 'user'),
      readOnlyDirectory: shipped,
      catalogue: CATALOGUE,
      fetch: fakeFetch({}, []),
    });
    expect(await store.locate('silero_vad')).toBeNull();
    expect(store.notes.join('\n')).toMatch(/does not match its pinned sha256/);
  });
});
