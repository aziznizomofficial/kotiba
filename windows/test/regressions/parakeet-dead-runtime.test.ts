// REGRESSION (final win review 2026-09-30, fixed): a Parakeet engine process that died between or during dictations.
//
// `ParakeetEngine.isReady()` answers `runtime !== null` and never asks `runtime.alive()`. The
// family (`manager.ts` transcribe) trusts `isReady()`, calls `member.engine.transcribe` with no
// try/catch, and `decode()` only THEN notices the dead runtime and rejects — so the dictation
// fails instead of reloading (or falling back to whisper). The checklist's step 8.1b ("End task
// on 'Kotiba speech engine', dictate English: it arrives") hits this on the batch path.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { DEFAULT_SETTINGS, SAMPLE_RATE, type AudioBuffer, type StreamingSttEngine } from '../../src/contracts/index.js';
import type { BundleStore } from '../../src/engines/bundle-store.js';
import { createEngineManagerWith, createModelStore } from '../../src/engines/index.js';
import { ParakeetEngine, type ParakeetRuntime } from '../../src/engines/parakeet.js';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-review-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const store: BundleStore = {
  directoryFor: () => '/p',
  pathOf: (_id: unknown, name: string) => `/p/${name}`,
  isInstalled: async () => true,
  locate: async () => '/p',
  ensure: async () => '/p',
} as unknown as BundleStore;

class ProcessRuntime implements ParakeetRuntime {
  dead = false;
  /** Die in the middle of the next real decode (not the 1 s warm-up). */
  crashOnNextDecode = false;
  async transcribeSamples(samples: Float32Array): Promise<string> {
    if (this.dead) throw new Error('the parakeet engine process stopped (crashed)');
    if (this.crashOnNextDecode && samples.length > SAMPLE_RATE) {
      this.dead = true;
      throw new Error('the parakeet engine process stopped (crashed)');
    }
    return 'Hello there.';
  }
  alive(): boolean {
    return !this.dead;
  }
  async dispose(): Promise<void> {}
}

function setup() {
  const runtimes: ProcessRuntime[] = [];
  const engine = new ParakeetEngine({
    store,
    threads: 1,
    idleUnloadMs: null,
    autoDownload: false,
    loadRuntime: async () => {
      const runtime = new ProcessRuntime();
      runtimes.push(runtime);
      return runtime;
    },
  });
  const manager = createEngineManagerWith({
    settings: { ...DEFAULT_SETTINGS },
    models: createModelStore({ modelsDirectory: root, bundledDirectory: '' }),
    createEngine: () => {
      throw new Error('no whisper in this test');
    },
    cpuCount: 4,
    unifiedLead: { engine, status: async () => 'ready' },
  });
  return { engine, manager, runtimes };
}

const audio = (seconds: number): AudioBuffer =>
  ({ samples: new Float32Array(seconds * SAMPLE_RATE).fill(0.2), droppedSamples: 0 }) as AudioBuffer;

test('a process killed while idle: the next BATCH dictation reloads instead of failing', async () => {
  const { manager, runtimes } = setup();
  await manager.prepare({ eagerly: false, language: 'en' });
  expect(runtimes).toHaveLength(1);
  runtimes[0]!.dead = true; // End task on "Kotiba speech engine"
  const unified = manager.engineFor('unified')!;
  await expect(unified.transcribe(audio(3), 'en')).resolves.toMatchObject({ engineId: 'parakeet-ultra' });
});

test('a process that crashes DURING the key-up decode: the family retries on a fresh process', async () => {
  const { manager, runtimes } = setup();
  await manager.prepare({ eagerly: false, language: 'en' });
  runtimes[0]!.crashOnNextDecode = true;
  const stream = (manager.engineFor('unified') as StreamingSttEngine).openStream();
  await expect(stream.finish(audio(3), 'en')).resolves.toMatchObject({ engineId: 'parakeet-ultra' });
});
