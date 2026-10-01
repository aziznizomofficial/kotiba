// The model store, against real files on a real disk.
//
// The one thing this suite exists to pin: `notInstalled` and `corrupt` are DIFFERENT
// MACHINE STATES set by the component that looked at the file. D-W10 names the
// precedent — `ai-balance/windows` recovered state with a regex over an error message,
// the message changed, and a healthy app exited non-zero.

import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelStore, inspectModelFile } from '../../src/engines/index.js';
import {
  DEFAULT_SETTINGS,
  GGML_MAGIC,
  MODEL_MINIMUM_BYTES,
  PUBLIC_MODELS_BASE,
  PUBLIC_MODELS_LIVE,
  type Settings,
} from '../../src/contracts/index.js';

let root = '';
let models = '';
let bundled = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-models-'));
  models = join(root, 'models');
  bundled = join(root, 'app');
  await mkdir(models, { recursive: true });
  await mkdir(bundled, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A file that passes: the ggml magic little-endian, and over the size floor. */
async function writeModel(path: string, bytes = MODEL_MINIMUM_BYTES + 1024): Promise<string> {
  const buffer = Buffer.alloc(bytes);
  buffer.writeUInt32LE(GGML_MAGIC, 0);
  await writeFile(path, buffer);
  return path;
}

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

describe('inspectModelFile', () => {
  it('accepts a file with the ggml magic and enough bytes', async () => {
    const path = await writeModel(join(models, 'ggml-uzbek-stt-v1-q5_0.bin'));
    const inspection = await inspectModelFile(path);
    expect(inspection.status).toBe('ready');
    expect(inspection.reason).toBeNull();
    expect(inspection.bytes).toBeGreaterThan(MODEL_MINIMUM_BYTES);
  });

  it('writes the magic as the four bytes 6c 6d 67 67 on disk', async () => {
    // The one place an endianness mistake hides. If this reversed, every real model
    // would read as corrupt and every corrupt one as ready.
    const path = await writeModel(join(models, 'x.bin'));
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(GGML_MAGIC, 0);
    expect([...buffer]).toEqual([0x6c, 0x6d, 0x67, 0x67]);
    expect((await inspectModelFile(path)).status).toBe('ready');
  });

  it('calls an absent file notInstalled, NOT corrupt', async () => {
    const inspection = await inspectModelFile(join(models, 'nothing-here.bin'));
    expect(inspection.status).toBe('notInstalled');
    expect(inspection.bytes).toBe(0);
    expect(inspection.reason).toBe('the file is not there any more');
  });

  it('calls an empty path notInstalled without touching the disk', async () => {
    expect((await inspectModelFile('')).status).toBe('notInstalled');
  });

  it('calls a half-finished download CORRUPT, not notInstalled', async () => {
    // The whole point. A 200 MB fragment of a 539 MB model is PRESENT: telling the user
    // to obtain a model they already have is the wrong instruction.
    const path = join(models, 'truncated.bin');
    const buffer = Buffer.alloc(3 * 1024 * 1024);
    buffer.writeUInt32LE(GGML_MAGIC, 0);
    await writeFile(path, buffer);
    const inspection = await inspectModelFile(path);
    expect(inspection.status).toBe('corrupt');
    expect(inspection.reason).toBe('the file is only 3 MB — it looks like a download that did not finish');
  });

  it('calls a big file with the wrong magic corrupt', async () => {
    const path = join(models, 'not-a-model.bin');
    await writeFile(path, Buffer.alloc(MODEL_MINIMUM_BYTES + 16, 0x41));
    const inspection = await inspectModelFile(path);
    expect(inspection.status).toBe('corrupt');
    expect(inspection.reason).toBe('the file is not a whisper.cpp ggml model');
  });

  it('calls a directory notInstalled rather than throwing', async () => {
    expect((await inspectModelFile(models)).status).toBe('notInstalled');
  });

  it('does not read the whole file — 200 inspections of a 40 MB file are fast', async () => {
    const path = await writeModel(join(models, 'big.bin'), 40 * 1024 * 1024);
    const began = Date.now();
    for (let index = 0; index < 200; index += 1) await inspectModelFile(path);
    expect(Date.now() - began).toBeLessThan(2_000);
  });
});

describe('resolve — three steps, in order', () => {
  it('prefers the explicit setting', async () => {
    const chosen = await writeModel(join(root, 'somewhere-else.bin'));
    await writeModel(join(models, 'ggml-uzbek-stt-v1-q5_0.bin'));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    expect(await store.resolve('uzbek', settings({ uzbekModelPath: chosen }))).toBe(chosen);
  });

  it('falls back to discovery when the setting points at nothing', async () => {
    const discovered = await writeModel(join(models, 'ggml-uzbek-stt-v1-q5_0.bin'));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    const resolved = await store.resolve(
      'uzbek',
      settings({ uzbekModelPath: join(root, 'gone.bin') }),
    );
    // A user whose external drive is unplugged still has the bundled model. Refusing
    // here would report a broken install for a path they cannot even see to clear.
    expect(resolved).toBe(discovered);
    expect(store.notes.some((note) => note.includes('configured path is unusable'))).toBe(true);
  });

  it('lets the models directory beat the directory beside the executable', async () => {
    // So a newer model dropped in by hand wins over the one the installer shipped.
    const mine = await writeModel(join(models, 'ggml-uzbek-stt-v1-q5_0.bin'));
    await writeModel(join(bundled, 'ggml-uzbek-stt-v1-q5_0.bin'));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    expect(await store.resolve('uzbek', settings())).toBe(mine);
  });

  it('finds the bundled copy when the models directory is empty', async () => {
    const shipped = await writeModel(join(bundled, 'ggml-uzbek-stt-v1-q5_0.bin'));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    expect(await store.resolve('uzbek', settings())).toBe(shipped);
  });

  it('prefers uzbek-stt-v1 over navoi-medium when both are present', async () => {
    // 21.68% WER against navoi's 25.19%. Order in KNOWN_MODEL_FILES is meaningful.
    const better = await writeModel(join(models, 'ggml-uzbek-stt-v1-q5_0.bin'));
    await writeModel(join(models, 'ggml-navoi-medium-q5_0.bin'));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    expect(await store.resolve('uzbek', settings())).toBe(better);
  });

  it('returns null and says so when nothing usable exists', async () => {
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    expect(await store.resolve('uzbek', settings())).toBeNull();
    expect(store.notes.some((note) => note.includes('nothing usable found'))).toBe(true);
  });

  it('skips a corrupt candidate and records why', async () => {
    await writeFile(join(models, 'ggml-uzbek-stt-v1-q5_0.bin'), Buffer.alloc(1024));
    const shipped = await writeModel(join(bundled, 'ggml-uzbek-stt-v1-q5_0.bin'));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    expect(await store.resolve('uzbek', settings())).toBe(shipped);
    expect(store.notes.some((note) => note.includes('is unusable'))).toBe(true);
  });

  it('never writes the setting back — readiness and the raw setting are different questions', async () => {
    await writeModel(join(models, 'ggml-uzbek-stt-v1-q5_0.bin'));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    const current = settings();
    await store.resolve('uzbek', current);
    expect(current.uzbekModelPath).toBe('');
  });

  it('resolves english and russian to the same large-v3-turbo file', async () => {
    const turbo = await writeModel(join(models, 'ggml-large-v3-turbo-q5_0.bin'));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    // D-W2: English ships on the Russian model because SpeechTranscriber has no
    // Windows equivalent.
    expect(await store.resolve('russian', settings())).toBe(turbo);
  });
});

describe('status', () => {
  it('reports ready when the installer copy is there but the models directory is not', async () => {
    await writeModel(join(bundled, 'ggml-large-v3-turbo-q5_0.bin'));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    expect(await store.status('large_v3_turbo')).toBe('ready');
  });

  it('reports notInstalled when there is nothing anywhere', async () => {
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    expect(await store.status('large_v3_turbo')).toBe('notInstalled');
  });

  it('reports corrupt — not notInstalled — when a file is there and broken', async () => {
    await writeFile(join(models, 'ggml-large-v3-turbo-q5_0.bin'), Buffer.alloc(4096));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    expect(await store.status('large_v3_turbo')).toBe('corrupt');
  });
});

describe('ensure', () => {
  // Both branches of PUBLIC_MODELS_LIVE, as the Mac's ModelDownloadsTests do for
  // `uzbekEngineIsPublic`. `fetch` is stubbed either way: a unit test never reaches the network,
  // and before this stub the live branch did (and failed on a 404 from a private repository).
  it('downloads the Uzbek model from the public host only once that host is live', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      asked.push(String(url));
      return new Response(null, { status: 404 });
    });
    try {
      const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
      if (PUBLIC_MODELS_LIVE) {
        await expect(store.ensure('uzbek_stt_v1')).rejects.toThrow(/failed to download: HTTP 404/);
        expect(asked).toEqual([`${PUBLIC_MODELS_BASE}ggml-uzbek-stt-v1-q5_0.bin`]);
      } else {
        await expect(store.ensure('uzbek_stt_v1')).rejects.toThrow(/ships inside the installer/);
        expect(asked).toEqual([]);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not refetch a file that is already there and correct', async () => {
    // No sha256 recorded for small_en, so present-and-plausible is the whole check —
    // and it must not reach the network.
    await writeModel(join(models, 'ggml-small.en-q5_1.bin'));
    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    const path = await store.ensure('small_en');
    expect(path).toBe(join(models, 'ggml-small.en-q5_1.bin'));
    expect(store.notes.some((note) => note.includes('no checksum to verify against'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------
// What lands, and what is left behind when nothing lands
// ---------------------------------------------------------------------------------
//
// The sha256 above is computed on the in-memory buffer. NOTHING downstream ever hashes
// what actually reached the disk — `inspectModelFile` reads four bytes and a stat — so
// every guarantee about the installed file rests on the write and the rename.

describe('the download lands atomically', () => {
  const SMALL_EN = 'ggml-small.en-q5_1.bin';

  /** A response body delivered in chunks, with an optional pause between them. */
  function respondWith(payload: Buffer, pauseMs = 0): Response {
    const half = Math.floor(payload.length / 2);
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(payload.length) },
      body: (async function* () {
        yield new Uint8Array(payload.subarray(0, half));
        if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
        yield new Uint8Array(payload.subarray(half));
      })(),
    } as unknown as Response;
  }

  async function partialsIn(directory: string): Promise<string[]> {
    return (await readdir(directory)).filter((name) => name.endsWith('.partial'));
  }

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('gives every attempt its own temporary, so two in flight cannot interleave', async () => {
    // `${destination}.partial` was ONE NAME shared by every writer of this model. Two
    // ensures at once — two windows, a retry racing the attempt it replaced, a second
    // instance — wrote into the same file and the rename published a mixture of both.
    const first = Buffer.alloc(MODEL_MINIMUM_BYTES + 4096, 0x11);
    first.writeUInt32LE(GGML_MAGIC, 0);
    const second = Buffer.alloc(MODEL_MINIMUM_BYTES + 4096, 0x22);
    second.writeUInt32LE(GGML_MAGIC, 0);

    let call = 0;
    const seenPartials = new Set<string>();
    globalThis.fetch = (async () => {
      call += 1;
      // Deliver in two chunks with a pause, so both downloads are mid-write together.
      return respondWith(call === 1 ? first : second, 40);
    }) as typeof fetch;

    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    const both = Promise.all([store.ensure('small_en'), store.ensure('small_en')]);
    // Catch them while both writes are open.
    await new Promise((resolve) => setTimeout(resolve, 60));
    for (const name of await partialsIn(models)) seenPartials.add(name);
    await both;

    expect(seenPartials.size).toBeGreaterThan(0);
    expect(seenPartials.has(`${SMALL_EN}.partial`)).toBe(false);

    // Whatever landed is one of the two payloads, byte for byte — not a blend.
    const landed = await readFile(join(models, SMALL_EN));
    expect([first.toString('hex'), second.toString('hex')]).toContain(landed.toString('hex'));
    expect(await partialsIn(models)).toEqual([]);
  });

  it('leaves no partial behind when the write fails', async () => {
    // 539 MB of nothing on a laptop that may well have been short of space when the
    // write failed. `resolve` never sees it — the name does not end in `.bin` — so
    // nothing else would ever clean it up.
    const payload = Buffer.alloc(MODEL_MINIMUM_BYTES + 4096, 0x33);
    payload.writeUInt32LE(GGML_MAGIC, 0);
    globalThis.fetch = (async () => respondWith(payload)) as typeof fetch;

    // The models directory is replaced by a FILE, so `open(temporary, 'w')` fails.
    await rm(models, { recursive: true, force: true });
    await writeFile(models, 'not a directory');

    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    await expect(store.ensure('small_en')).rejects.toThrow();

    // Nothing to assert about the directory itself — it is a file. What matters is that
    // the failure propagated rather than leaving a half-written model behind a name the
    // next `ensure` would have appended to.
    await rm(models, { force: true });
    await mkdir(models, { recursive: true });
    expect(await partialsIn(models)).toEqual([]);
  });
});
