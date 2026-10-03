// The language-ID model on Windows (P4, D-14): the ONNX twin of the Mac's EcapaLanguageIdentifier,
// in its own engine process. Logic against a fake runtime; the real host process against a
// missing model (a load error, never a crash); and — when `KOTIBA_LID_MODEL` names the 86 MB
// `ecapa-voxlingua107-lid.onnx` — the real graph, in this thread and in the host, which must agree.

import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AudioBuffer } from '../../src/contracts/index.js';
import { EngineProcessExit, forkLauncher } from '../../src/engines/engine-process.js';
import {
  ECAPA_LABELS,
  ECAPA_MAXIMUM_SAMPLES,
  ECAPA_MINIMUM_SAMPLES,
  LANGUAGE_ID_MINIMUM_BYTES,
  createLanguageIdentifier,
  ecapaInput,
  loadLanguageIDRuntime,
  posteriorFromLogp,
  resolveLanguageIDPath,
  startLanguageIDProcess,
  type LanguageIDRuntime,
} from '../../src/engines/language-id.js';

const HOST = fileURLToPath(new URL('../../src/engines/engine-host.ts', import.meta.url));
const TS = ['--import', fileURLToPath(new URL('../support/ts-resolve.mjs', import.meta.url)), '--no-warnings'];
const MODEL = process.env['KOTIBA_LID_MODEL'] ?? '';

const audio = (seconds: number, value = 0.1): AudioBuffer => ({
  samples: new Float32Array(Math.round(seconds * 16_000)).fill(value),
  droppedSamples: 0,
});

/** A log-softmax with all the mass on one label. */
function logpFor(label: string): Float32Array {
  const out = new Float32Array(ECAPA_LABELS.length).fill(-30);
  out[ECAPA_LABELS.indexOf(label)] = 0;
  return out;
}

describe('the graph’s input and output', () => {
  it('pads anything under 0.25 s with silence and keeps the first 30 s, as the Mac does', () => {
    expect(ecapaInput(new Float32Array(100).fill(1)).length).toBe(ECAPA_MINIMUM_SAMPLES);
    expect(ecapaInput(new Float32Array(100).fill(1))[99]).toBe(1);
    expect(ecapaInput(new Float32Array(100).fill(1))[100]).toBe(0);
    expect(ecapaInput(new Float32Array(ECAPA_MAXIMUM_SAMPLES + 5)).length).toBe(ECAPA_MAXIMUM_SAMPLES);
    const middle = new Float32Array(16_000);
    expect(ecapaInput(middle)).toBe(middle);
  });

  it('turns 107 log-posteriors into a normalised posterior keyed by code, and the wrong shape into none', () => {
    expect(ECAPA_LABELS).toHaveLength(107);
    for (const code of ['uz', 'tr', 'ar', 'en', 'ru']) expect(ECAPA_LABELS).toContain(code);
    const posterior = posteriorFromLogp(logpFor('uz'));
    expect(Object.keys(posterior)).toHaveLength(107);
    expect(posterior['uz']).toBeGreaterThan(0.999);
    expect(Object.values(posterior).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(posteriorFromLogp(new Float32Array(10))).toEqual({});
  });
});

describe('createLanguageIdentifier', () => {
  it('loads once, answers in order, and never throws: a failed pass is no opinion', async () => {
    const notes: string[] = [];
    let loads = 0;
    let fail = false;
    const runtime: LanguageIDRuntime = {
      logPosterior: async () => {
        if (fail) throw new Error('boom');
        return logpFor('en');
      },
      dispose: async () => undefined,
    };
    const identifier = createLanguageIdentifier({
      modelPath: '/m.onnx',
      onNote: (note) => notes.push(note),
      loadRuntime: async () => {
        loads += 1;
        return runtime;
      },
    });
    expect(identifier.isReady()).toBe(false);
    await identifier.prepare();
    expect(identifier.isReady()).toBe(true);
    expect((await identifier.posterior(audio(2)))['en']).toBeGreaterThan(0.999);
    expect((await identifier.posterior(audio(2)))['en']).toBeGreaterThan(0.999);
    expect(loads).toBe(1);
    expect(await identifier.posterior({ samples: new Float32Array(0), droppedSamples: 0 })).toEqual({});
    fail = true;
    expect(await identifier.posterior(audio(2))).toEqual({});
    expect(notes.at(-1)).toBe('language ID: no opinion — boom');
    await identifier.dispose();
    expect(await identifier.posterior(audio(2))).toEqual({});
  });

  it('a model that will not load is no opinion at key-up, and prepare says why', async () => {
    const identifier = createLanguageIdentifier({
      modelPath: '/m.onnx',
      loadRuntime: async () => {
        throw new Error('not a model');
      },
    });
    await expect(identifier.prepare()).rejects.toThrow('not a model');
    expect(await identifier.posterior(audio(1))).toEqual({});
  });

  it('the real engine-host.js serves lid: a missing model is a load error, not a crash', async () => {
    const error = await startLanguageIDProcess('/nonexistent-lid.onnx', { threads: 1 }, forkLauncher(HOST, { execArgv: TS })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EngineProcessExit);
  }, 30_000);
});

describe('resolveLanguageIDPath', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kotiba-lid-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A sparse file of `bytes` — the floor is a size, so no 86 MB is written. */
  async function file(path: string, bytes: number): Promise<string> {
    await writeFile(path, '');
    await truncate(path, bytes);
    return path;
  }

  const store = (located: string | null) => ({
    locate: async () => located,
    directoryFor: () => join(root, 'models', 'ecapa-voxlingua107-lid'),
  });

  it('the setting first, then the store’s verified copy, then the bare file in the models directory', async () => {
    await mkdir(join(root, 'models'), { recursive: true });
    const explicit = await file(join(root, 'mine.onnx'), LANGUAGE_ID_MINIMUM_BYTES);
    expect(await resolveLanguageIDPath({ languageIDModelPath: explicit }, store('/shipped/dir'))).toBe(explicit);
    // A setting naming a truncated file is passed over, never trusted.
    const small = await file(join(root, 'small.onnx'), 1024);
    expect(await resolveLanguageIDPath({ languageIDModelPath: small }, store('/shipped/dir'))).toBe(
      join('/shipped/dir', 'ecapa-voxlingua107-lid.onnx'),
    );
    expect(await resolveLanguageIDPath({ languageIDModelPath: '' }, store(null))).toBeNull();
    const loose = await file(join(root, 'models', 'ecapa-voxlingua107-lid.onnx'), LANGUAGE_ID_MINIMUM_BYTES + 1);
    expect(await resolveLanguageIDPath({ languageIDModelPath: '' }, store(null))).toBe(loose);
    expect(await resolveLanguageIDPath({ languageIDModelPath: '' }, null)).toBeNull();
  });
});

describe.skipIf(MODEL === '')('the real graph (KOTIBA_LID_MODEL)', () => {
  it('answers 107 languages that sum to one, the same in this thread and in the host process', async () => {
    const samples = new Float32Array(3 * 16_000);
    for (let i = 0; i < samples.length; i += 1) samples[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / 16_000);
    const local = await loadLanguageIDRuntime(MODEL, { threads: 2 });
    const remote = await startLanguageIDProcess(MODEL, { threads: 2 }, forkLauncher(HOST, { execArgv: TS }));
    try {
      const a = posteriorFromLogp(await local.logPosterior(samples));
      const b = posteriorFromLogp(await remote.logPosterior(samples));
      expect(Object.keys(a)).toHaveLength(107);
      expect(Object.values(a).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
      for (const code of ECAPA_LABELS) expect(b[code]).toBeCloseTo(a[code]!, 9);
    } finally {
      await local.dispose();
      await remote.dispose();
    }
  }, 60_000);
});
