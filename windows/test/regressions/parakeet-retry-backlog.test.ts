// REGRESSION (final win review 2026-09-30, fixed): `ParakeetStream.retryAt` is set by `requeue` and never reset.
//
// Scenario: the hold starts while Parakeet cannot serve (still downloading / not yet on disk),
// so each commit attempt requeues and pushes `retryAt` to pendingLength + 2 s. The bundle lands
// mid-hold. The first commit then succeeds — and every later one is refused until the backlog
// is back above the stale `retryAt`, so the backlog never drains: key-up is left with ~all of it
// instead of ≤ 14 s. The Swift (`ParakeetStream.requeue`, ParakeetEngine.swift) has no such gate.

import { expect, test } from 'vitest';

import { SAMPLE_RATE, type AudioBuffer } from '../../src/contracts/index.js';
import type { BundleStore } from '../../src/engines/bundle-store.js';
import { ParakeetEngine, type ParakeetRuntime } from '../../src/engines/parakeet.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('once the model lands mid-hold, the backlog drains in windows (tail ≤ 14 s at key-up)', async () => {
  let installed = false;
  const store = {
    directoryFor: () => '/p',
    pathOf: (_: unknown, name: string) => `/p/${name}`,
    isInstalled: async () => installed,
    locate: async () => (installed ? '/p' : null),
    ensure: () => new Promise<string>(() => undefined),
  } as unknown as BundleStore;
  const decoded: number[] = [];
  const runtime: ParakeetRuntime = {
    transcribeSamples: async (samples) => {
      if (samples.length !== SAMPLE_RATE) decoded.push(samples.length);
      return 'words';
    },
    dispose: async () => undefined,
  };
  const engine = new ParakeetEngine({ store, threads: 1, idleUnloadMs: null, autoDownload: false, loadRuntime: async () => runtime });
  const stream = engine.openStream();
  const chunk = (): Float32Array => {
    const c = new Float32Array(SAMPLE_RATE / 10);
    for (let i = 0; i < c.length; i += 1) c[i] = 0.1 * Math.sin(i / 5);
    return c;
  };
  const all: Float32Array[] = [];
  const feed = async (seconds: number): Promise<void> => {
    for (let i = 0; i < seconds * 10; i += 1) {
      const c = chunk();
      all.push(c);
      stream.append(c);
      await flush();
      await flush();
    }
  };
  await feed(40); // 40 s held while the model is not on disk
  installed = true; // the download lands
  await feed(20); // 20 s more
  for (let i = 0; i < 20; i += 1) await flush();
  const total = all.reduce((n, c) => n + c.length, 0);
  const committed = decoded.reduce((n, s) => n + s, 0);
  // 60 s held: with the backlog drained, at most one window (14 s) is left for key-up.
  expect((total - committed) / SAMPLE_RATE).toBeLessThanOrEqual(14);
  const samples = new Float32Array(total);
  let at = 0;
  for (const c of all) {
    samples.set(c, at);
    at += c.length;
  }
  await stream.finish({ samples, droppedSamples: 0 } as AudioBuffer, 'en');
});
