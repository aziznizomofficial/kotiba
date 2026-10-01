// REGRESSION (final win review 2026-09-30, fixed): the language detector latches "no opinion" after its host restarts.
//
// `createAcousticClassifier` sets `loaded = true` once and never clears it: it passes no
// `onExit` to its host (stt-engine.ts does — `forgetResidentModel`) and ignores the host's
// `no_model` refusal. kotiba-stt.exe (main.cpp handleDetect) answers `no_model` for a fresh
// process. So after the detector's kotiba-stt dies ONCE (a crash, End task, a kill for a hang),
// the client respawns it, every `detect` is refused, and every dictation for the rest of the
// session routes as "no opinion" → the fallback language: Uzbek audio goes to the unified engine.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { GGML_MAGIC, MODEL_MINIMUM_BYTES, type AudioBuffer } from '../../src/contracts/index.js';
import { createAcousticClassifier, type SttHost } from '../../src/engines/index.js';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-review-det-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The client's view of a real kotiba-stt: a respawned process has no model. */
function restartingHost() {
  let modelLoaded = false;
  const host: SttHost = {
    async request(header: Record<string, unknown>) {
      const id = String(header['id']);
      if (header['op'] === 'load') {
        modelLoaded = true;
        return { ok: true, id };
      }
      if (header['op'] === 'detect') {
        return modelLoaded
          ? { ok: true, id, posterior: { tr: 0.63, az: 0.17 } }
          : { ok: false, id, code: 'no_model', error: 'no model is loaded — send `load` first' };
      }
      return { ok: false, id, code: 'unknown_op' };
    },
    immediate: async () => ({ ok: false, code: 'unknown_op' }),
    greeting: async () => null,
    isRunning: true,
    restarts: 0,
    dispose: async () => undefined,
  } as unknown as SttHost;
  return { host, crash: () => (modelLoaded = false) };
}

test('after the detector host dies once, detection comes back on the next press', async () => {
  const path = join(root, 'ggml-base-q5_1.bin');
  const bytes = Buffer.alloc(MODEL_MINIMUM_BYTES + 1024);
  bytes.writeUInt32LE(GGML_MAGIC, 0);
  await writeFile(path, bytes);
  const { host, crash } = restartingHost();
  const classifier = createAcousticClassifier({ modelPath: path, hostPath: 'x', host });
  const audio: AudioBuffer = { samples: new Float32Array(16000).fill(0.2), droppedSamples: 0 };

  expect(await classifier.posterior(audio)).toEqual({ tr: 0.63, az: 0.17 });
  crash(); // the process died; host-client respawns a fresh, empty one on the next request
  await classifier.posterior(audio); // this press may legitimately have no opinion…
  expect(await classifier.posterior(audio)).toEqual({ tr: 0.63, az: 0.17 }); // …but not every press after it
});
