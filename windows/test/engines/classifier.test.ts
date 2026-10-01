// The language-ID pass.
//
// The contract is one sentence: NON-THROWING, and a failure is an EMPTY MAP meaning
// "no opinion". Being unsure must never be louder than being right, and it must never
// block a dictation.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAcousticClassifier, createSttHost, type SttHost } from '../../src/engines/index.js';
import { GGML_MAGIC, MODEL_MINIMUM_BYTES, type AudioBuffer } from '../../src/contracts/index.js';

const FAKE_HOST = join(dirname(fileURLToPath(import.meta.url)), 'fake-host.mjs');

let root = '';
const toDispose: { dispose: () => Promise<void> }[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-detector-'));
});

afterEach(async () => {
  while (toDispose.length > 0) await toDispose.pop()?.dispose();
  await rm(root, { recursive: true, force: true });
});

async function writeModel(): Promise<string> {
  const path = join(root, 'ggml-base-q5_1.bin');
  const buffer = Buffer.alloc(MODEL_MINIMUM_BYTES + 1024);
  buffer.writeUInt32LE(GGML_MAGIC, 0);
  await writeFile(path, buffer);
  return path;
}

function fakeHost(behaviour: Record<string, unknown> = {}): SttHost {
  const host = createSttHost({
    hostPath: 'node',
    spawnProcess: (): ChildProcessWithoutNullStreams =>
      spawn(process.execPath, [FAKE_HOST, JSON.stringify(behaviour)], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  });
  toDispose.push(host);
  return host;
}

const audio = (seconds: number): AudioBuffer => ({
  samples: new Float32Array(Math.round(16000 * seconds)).fill(0.2),
  droppedSamples: 0,
});

describe('the detector', () => {
  it('returns the raw posterior, unnormalised, for cluster mass to reduce', async () => {
    const classifier = createAcousticClassifier({
      modelPath: await writeModel(),
      hostPath: 'node',
      host: fakeHost(),
    });
    toDispose.push(classifier);
    const posterior = await classifier.posterior(audio(3));
    // The shape clean Uzbek actually produces: `tr` wins and `uz` does not place. A port
    // that took the argmax would route Uzbek to Turkish and produce garbage.
    expect(posterior['tr']).toBeCloseTo(0.63, 5);
    expect(posterior['az']).toBeCloseTo(0.17, 5);
    expect(posterior['uz']).toBeUndefined();
  });

  it('loads from cold on the first call', async () => {
    const classifier = createAcousticClassifier({
      modelPath: await writeModel(),
      hostPath: 'node',
      host: fakeHost(),
    });
    toDispose.push(classifier);
    expect(Object.keys(await classifier.posterior(audio(2))).length).toBeGreaterThan(0);
  });

  it('gives an EMPTY MAP, not a throw, when the model is missing', async () => {
    const classifier = createAcousticClassifier({
      modelPath: join(root, 'nothing.bin'),
      hostPath: 'node',
      host: fakeHost(),
    });
    toDispose.push(classifier);
    expect(await classifier.posterior(audio(2))).toEqual({});
  });

  it('gives an empty map when the host dies', async () => {
    const classifier = createAcousticClassifier({
      modelPath: await writeModel(),
      hostPath: 'node',
      host: fakeHost({ dieOnStart: true }),
    });
    toDispose.push(classifier);
    expect(await classifier.posterior(audio(2))).toEqual({});
  });

  it('gives an empty map for empty audio without asking the host', async () => {
    const classifier = createAcousticClassifier({
      modelPath: await writeModel(),
      hostPath: 'node',
      host: fakeHost(),
    });
    toDispose.push(classifier);
    expect(
      await classifier.posterior({ samples: new Float32Array(0), droppedSamples: 0 }),
    ).toEqual({});
  });

  it('never blocks a dictation — ten calls against a dead host all resolve', async () => {
    const classifier = createAcousticClassifier({
      modelPath: await writeModel(),
      hostPath: 'node',
      host: fakeHost({ dieOnStart: true }),
    });
    toDispose.push(classifier);
    for (let index = 0; index < 10; index += 1) {
      expect(await classifier.posterior(audio(1))).toEqual({});
    }
  });
});
