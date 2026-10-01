// Arabic on Windows (C4 + the owner's rule): every decision `ArabicEngine` makes around its two
// decoders — which one, when it fetches, the first-run speed check and the automatic switch, the
// manual override, the decode-loop guard, and the 28 s cap on what a decoder is ever handed —
// against FAKE runtimes. The real decoders are measured by `scripts/measure/arabic-stream.mjs`.

import { describe as suite, expect, test } from 'vitest';

import {
  EngineFailure,
  SAMPLE_RATE,
  type ArabicEngineChoice,
  type AudioBuffer,
  type BundleId,
  type BundleState,
  type SttEngine,
} from '../../src/contracts/index.js';
import { ArabicEngine, DEFAULT_SPEED_THRESHOLD_MS, type ArabicSpeedCheck } from '../../src/engines/arabic.js';
import { ArabicAborted, type ArabicRuntime, type ArabicRuntimeOptions } from '../../src/engines/arabic-runtime.js';
import type { BundleProgress, BundleStore } from '../../src/engines/bundle-store.js';
import type { StreamingWhisperSession } from '../../src/engines/streaming-whisper.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await flush();
}

function buffer(seconds: number): AudioBuffer {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i += 1) samples[i] = 0.1 * Math.sin(i / 7);
  return { samples, droppedSamples: 0 };
}

class FakeStore implements BundleStore {
  installed = new Set<BundleId>();
  ensures: BundleId[] = [];
  private finishers = new Map<BundleId, () => void>();
  readonly notes: string[] = [];
  directoryFor(id: BundleId): string {
    return `/models/${id}`;
  }
  pathOf(id: BundleId, name: string): string {
    return `/models/${id}/${name}`;
  }
  async isInstalled(id: BundleId): Promise<boolean> {
    return this.installed.has(id);
  }
  async locate(id: BundleId): Promise<string | null> {
    return this.installed.has(id) ? `/models/${id}` : null;
  }
  ensure(id: BundleId, onProgress?: (progress: BundleProgress) => void): Promise<string> {
    this.ensures.push(id);
    onProgress?.({ id, receivedBytes: 1, totalBytes: 2 });
    return new Promise((resolve) => {
      this.finishers.set(id, () => {
        this.installed.add(id);
        resolve(`/models/${id}`);
      });
    });
  }
  finish(id: BundleId): void {
    this.finishers.get(id)?.();
  }
}

/** A decoder that answers instantly with `text`, or `truncated`, and counts its work. */
class FakeRuntime implements ArabicRuntime {
  readonly kind;
  readonly device: string;
  decoded: number[] = [];
  disposed = false;
  truncateNext = 0;
  constructor(
    kind: 'cohere' | 'fastConformer',
    private readonly answer: (samples: Float32Array) => string = (samples) => `${kind}:${samples.length}`,
    device = 'CPU',
  ) {
    this.kind = kind;
    this.device = device;
  }
  async transcribeSamples(samples: Float32Array, signal?: AbortSignal) {
    if (signal?.aborted === true) throw new ArabicAborted();
    this.decoded.push(samples.length);
    if (this.truncateNext > 0) {
      this.truncateNext -= 1;
      return { text: '', truncated: true, milliseconds: 1 };
    }
    return { text: this.answer(samples), truncated: false, milliseconds: 1 };
  }
  alive(): boolean {
    return !this.disposed;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

interface Rig {
  readonly engine: ArabicEngine;
  readonly store: FakeStore;
  readonly loads: ArabicRuntimeOptions[];
  readonly runtimes: FakeRuntime[];
  readonly saved: ArabicSpeedCheck[];
  readonly states: [BundleId, BundleState][];
  setChoice(choice: ArabicEngineChoice): void;
  setClock(ms: number): void;
}

function rig(options: {
  readonly installed?: BundleId[];
  readonly choice?: ArabicEngineChoice;
  /** How long each timed decode of the standard clip "takes" on this fake PC. */
  readonly clipMs?: number;
  readonly clip?: Float32Array | null;
  readonly verdict?: ArabicSpeedCheck | null;
  readonly autoDownload?: boolean;
  readonly answer?: (kind: 'cohere' | 'fastConformer', samples: Float32Array) => string;
  readonly device?: string;
} = {}): Rig {
  const store = new FakeStore();
  for (const id of options.installed ?? []) store.installed.add(id);
  let choice: ArabicEngineChoice = options.choice ?? 'auto';
  let clock = 0;
  const clip = options.clip === undefined ? new Float32Array(3 * SAMPLE_RATE) : options.clip;
  const loads: ArabicRuntimeOptions[] = [];
  const runtimes: FakeRuntime[] = [];
  const saved: ArabicSpeedCheck[] = [];
  const states: [BundleId, BundleState][] = [];
  const engine = new ArabicEngine({
    store,
    threads: 4,
    idleUnloadMs: null,
    autoDownload: options.autoDownload ?? true,
    choice: () => choice,
    backend: () => 'auto',
    speedClip: async () => clip,
    speedChecks: {
      read: async () => options.verdict ?? null,
      write: async (check) => {
        saved.push(check);
      },
    },
    now: () => clock,
    onBundleState: (id, state) => states.push([id, state]),
    loadRuntime: async (load) => {
      loads.push(load);
      const runtime = new FakeRuntime(load.kind, (samples) => {
        // The speed check's clip "takes" clipMs of this fake PC's clock.
        if (clip !== null && samples === clip) clock += options.clipMs ?? 100;
        return options.answer?.(load.kind, samples) ?? `${load.kind}:${samples.length}`;
      }, options.device);
      runtimes.push(runtime);
      return runtime;
    },
  });
  return {
    engine,
    store,
    loads,
    runtimes,
    saved,
    states,
    setChoice: (next) => {
      choice = next;
    },
    setClock: (ms) => {
      clock = ms;
    },
  };
}

function verdict(slow: boolean, backend: 'auto' | 'cpu' = 'auto'): ArabicSpeedCheck {
  return {
    milliseconds: slow ? 600 : 200,
    thresholdMs: DEFAULT_SPEED_THRESHOLD_MS,
    slow,
    device: 'CPU',
    backend,
    clipSeconds: 3,
    measuredAt: '2026-09-30T00:00:00.000Z',
  };
}

suite('ArabicEngine — which engine', () => {
  test('Cohere by default; nothing downloaded is notReady and starts ONE Cohere download', async () => {
    const { engine, store } = rig();
    await expect(engine.prepare()).rejects.toBeInstanceOf(EngineFailure);
    await expect(engine.prepare()).rejects.toThrow(/still downloading/);
    expect(store.ensures).toEqual(['cohere_arabic']);
    expect(engine.status().wanted).toBe('cohere');
    expect(engine.status().active).toBeNull();
  });

  test('never fetches without consent: autoDownload false is notReady, no request', async () => {
    const { engine, store } = rig({ autoDownload: false });
    await expect(engine.prepare()).rejects.toThrow(/not downloaded/);
    expect(store.ensures).toEqual([]);
  });

  test('the download lands: it loads itself, warms, and serves', async () => {
    const { engine, store, loads } = rig({ clip: null });
    await expect(engine.prepare()).rejects.toBeInstanceOf(EngineFailure);
    store.finish('cohere_arabic');
    await settle();
    expect(loads.map((load) => load.kind)).toEqual(['cohere']);
    expect(await engine.isReady()).toBe(true);
    expect(engine.engineId).toBe('cohere-transcribe-arabic-07-2026-q5_k_m');
  });

  test('a manual pick wins over the speed check, and switching loads the other in the background', async () => {
    const r = rig({ installed: ['cohere_arabic', 'fastconformer_ar'], verdict: verdict(false) });
    await r.engine.prepare();
    expect(r.engine.status().active).toBe('cohere');
    r.setChoice('fastConformer');
    r.engine.reconsider();
    await settle();
    expect(r.engine.status().active).toBe('fastConformer');
    expect(r.engine.status().reason).toBe('chosen');
    // The old one finished what it was doing and was given back.
    expect(r.runtimes[0]?.disposed).toBe(true);
  });

  test('a stored verdict for the OTHER backend does not count (GPU turned off since)', async () => {
    const r = rig({ installed: ['cohere_arabic', 'fastconformer_ar'], verdict: verdict(true, 'cpu') });
    await r.engine.prepare();
    expect(r.engine.wantedKind()).toBe('cohere');
    // …and Cohere then re-checks itself on this backend.
    await settle();
    expect(r.saved).toHaveLength(1);
  });
});

suite('ArabicEngine — the first-run speed check', () => {
  test('fast: Cohere stays, the verdict is saved once, and it is not run again', async () => {
    const r = rig({ installed: ['cohere_arabic'], clipMs: 300 });
    await r.engine.prepare();
    await settle();
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0]).toMatchObject({ milliseconds: 300, slow: false, thresholdMs: 300, backend: 'auto', clipSeconds: 3 });
    expect(r.engine.status()).toMatchObject({ active: 'cohere', reason: 'speedCheckFast' });
    await r.engine.unload();
    await r.engine.prepare();
    await settle();
    expect(r.saved).toHaveLength(1);
  });

  test('slow: Arabic switches itself to FastConformer — fetched under the same consent — and Cohere serves until it lands', async () => {
    const r = rig({ installed: ['cohere_arabic'], clipMs: 600 });
    await r.engine.prepare();
    await settle();
    expect(r.saved[0]).toMatchObject({ milliseconds: 600, slow: true });
    expect(r.engine.wantedKind()).toBe('fastConformer');
    expect(r.store.ensures).toEqual(['fastconformer_ar']);
    // Meanwhile Cohere still answers — a switch never costs a dictation.
    expect((await r.engine.transcribe(buffer(2), 'ar')).raw).toMatch(/^cohere:/u);
    expect(r.engine.status().reason).toBe('fallbackWhileLoading');

    r.store.finish('fastconformer_ar');
    await settle();
    expect(r.engine.status()).toMatchObject({ active: 'fastConformer', reason: 'speedCheckSlow' });
    expect((await r.engine.transcribe(buffer(2), 'ar')).raw).toMatch(/^fastConformer:/u);
    expect(r.runtimes.find((runtime) => runtime.kind === 'cohere')?.disposed).toBe(true);
  });

  test('exactly at the threshold is NOT slow; the faster of two runs decides', async () => {
    const r = rig({ installed: ['cohere_arabic'], clipMs: DEFAULT_SPEED_THRESHOLD_MS });
    await r.engine.prepare();
    await settle();
    expect(r.saved[0]?.slow).toBe(false);
    // Two timed decodes of the clip, after the one-second warm-up.
    const cohere = r.runtimes[0]!;
    expect(cohere.decoded.filter((length) => length === 3 * SAMPLE_RATE)).toHaveLength(2);
  });

  test('no clip installed: no verdict, and Cohere stays', async () => {
    const r = rig({ installed: ['cohere_arabic'], clip: null });
    await r.engine.prepare();
    await settle();
    expect(r.saved).toEqual([]);
    expect(r.engine.status()).toMatchObject({ active: 'cohere', reason: 'notChecked' });
  });

  test('a manual Cohere pick is never demoted by a check', async () => {
    const r = rig({ installed: ['cohere_arabic'], clipMs: 5_000, choice: 'cohere' });
    await r.engine.prepare();
    await settle();
    expect(r.saved).toEqual([]);
    expect(r.engine.wantedKind()).toBe('cohere');
  });
});

suite('ArabicEngine — decoding', () => {
  test('never hands a decoder more than 28 s: a long recording is cut, every piece ≤ 28 s', async () => {
    const r = rig({ installed: ['cohere_arabic'], clip: null });
    await r.engine.prepare();
    const result = await r.engine.transcribe(buffer(70), 'ar');
    const pieces = r.runtimes[0]!.decoded.slice(1); // after the warm-up
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const length of pieces) expect(length).toBeLessThanOrEqual(28 * SAMPLE_RATE);
    expect(pieces.reduce((a, b) => a + b, 0)).toBe(70 * SAMPLE_RATE);
    expect(result.language).toBe('ar');
    expect(result.raw.split(' ')).toHaveLength(pieces.length);
  });

  test('the decode-loop guard: a truncated segment is re-decoded by the whisper fallback', async () => {
    const r = rig({ installed: ['cohere_arabic'], clip: null });
    const asked: number[] = [];
    const whisper = {
      engineId: 'whisper-ggml-large-v3-turbo-q5_0-ar',
      supportedLanguages: new Set(['ar']),
      isReady: async () => true,
      prepare: async () => undefined,
      transcribe: async (audio: AudioBuffer) => {
        asked.push(audio.samples.length);
        return { raw: ' نص من ويسبر ', language: 'ar' as const, engineId: 'whisper' };
      },
      dispose: async () => undefined,
    } as unknown as SttEngine;
    r.engine.attachFallback(whisper);
    await r.engine.prepare();
    r.runtimes[0]!.truncateNext = 1;
    const result = await r.engine.transcribe(buffer(5), 'ar');
    expect(asked).toEqual([5 * SAMPLE_RATE]);
    expect(result.raw).toBe('نص من ويسبر');
  });

  test('a truncated segment with no fallback is empty — never the loop’s text', async () => {
    const r = rig({ installed: ['cohere_arabic'], clip: null });
    await r.engine.prepare();
    r.runtimes[0]!.truncateNext = 1;
    expect((await r.engine.transcribe(buffer(5), 'ar')).raw).toBe('');
  });

  test('refuses every language but Arabic, and pads a tap to one second', async () => {
    const r = rig({ installed: ['cohere_arabic'], clip: null });
    await r.engine.prepare();
    await expect(r.engine.transcribe(buffer(1), 'tr')).rejects.toThrow(/does not support tr/);
    await r.engine.transcribe(buffer(0.2), 'ar');
    expect(r.runtimes[0]!.decoded.at(-1)).toBe(SAMPLE_RATE);
  });

  test('Cohere on a CPU keeps a running pause decode (coalesced); on a GPU, and FastConformer, not (C4 §14.4)', async () => {
    const cpu = rig({ installed: ['cohere_arabic'], clip: null });
    await cpu.engine.prepare();
    expect((cpu.engine.openStream() as StreamingWhisperSession).coalescesSpeculations).toBe(true);
    const gpu = rig({ installed: ['cohere_arabic'], clip: null, device: 'Vulkan (AMD Radeon Graphics)' });
    await gpu.engine.prepare();
    expect((gpu.engine.openStream() as StreamingWhisperSession).coalescesSpeculations).toBe(false);
    const fc = rig({ installed: ['fastconformer_ar'], choice: 'fastConformer', clip: null });
    await fc.engine.prepare();
    expect((fc.engine.openStream() as StreamingWhisperSession).coalescesSpeculations).toBe(false);
  });

  test('streams: commits behind the speaker, and release returns the whole text', async () => {
    const r = rig({ installed: ['cohere_arabic'], clip: null, answer: (_kind, samples) => `[${Math.round(samples.length / SAMPLE_RATE)}]` });
    await r.engine.prepare();
    const stream = r.engine.openStream();
    const recording = buffer(40);
    // Speech with a clear pause every ~5 s, so the segmenter has places to cut.
    for (let s = 5; s < 40; s += 5) recording.samples.fill(0, s * SAMPLE_RATE, s * SAMPLE_RATE + SAMPLE_RATE / 2);
    for (let at = 0; at < recording.samples.length; at += 1600) {
      stream.append(recording.samples.slice(at, at + 1600));
      if (at % 16000 === 0) await flush();
    }
    await settle();
    const result = await stream.finish(recording, 'ar');
    expect(result.language).toBe('ar');
    expect(result.raw.length).toBeGreaterThan(0);
    // Nothing the decoder saw was longer than a segment may be.
    for (const length of r.runtimes[0]!.decoded) expect(length).toBeLessThanOrEqual(28 * SAMPLE_RATE);
  });
});

suite('transcribe.dll in the installed app', () => {
  test('a package resolved inside app.asar is loaded from app.asar.unpacked', async () => {
    const { unpackedTranscribeLibrary } = await import('../../src/engines/arabic-runtime.js');
    const packed = 'C:\\Users\\a\\AppData\\Local\\Programs\\Kotiba\\resources\\app.asar\\node_modules\\@transcribe-cpp\\win32-x64-cpu-vulkan\\package.json';
    const seen: string[] = [];
    const library = unpackedTranscribeLibrary(packed, (path) => (seen.push(path), true), 'win32-x64');
    expect(library).toContain('app.asar.unpacked');
    expect(library).toMatch(/transcribe\.dll$/u);
    expect(seen).toHaveLength(1);
    // A dev tree (no archive), a missing unpacked copy, or an unknown platform: the loader's own search.
    expect(unpackedTranscribeLibrary('/repo/windows/node_modules/@transcribe-cpp/x/package.json', () => true, 'win32-x64')).toBeNull();
    expect(unpackedTranscribeLibrary(packed, () => false, 'win32-x64')).toBeNull();
    expect(unpackedTranscribeLibrary(packed, () => true, 'win32-arm64')).toBeNull();
  });
});

suite('the device line', () => {
  test('names the GPU the model landed on, by kind and description; a CPU is just CPU', async () => {
    const { describeDevice } = await import('../../src/engines/arabic-runtime.js');
    expect(describeDevice({ kind: 'vulkan', deviceType: 'igpu', name: 'Vulkan0', description: 'AMD Radeon Graphics' })).toBe(
      'Vulkan (AMD Radeon Graphics)',
    );
    expect(describeDevice({ kind: 'metal', deviceType: 'gpu', name: 'MTL0', description: 'Apple M4 Pro' })).toBe('Metal (Apple M4 Pro)');
    expect(describeDevice({ kind: 'cpu', deviceType: 'cpu', name: 'CPU', description: 'Apple M4 Pro' })).toBe('CPU');
  });
});
