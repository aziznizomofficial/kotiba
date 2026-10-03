// Parakeet on Windows: the pure decoder arithmetic, and the engine's lifecycle and stream
// against a FAKE runtime. The real model's accuracy is not asserted here — it is measured
// by `scripts/measure/parakeet-bench.mjs` against C1's FLEURS sets (docs/windows/
// 03-ENGINE-PARITY.md §10) — but every decision the engine makes around the model is.

import { describe as suite, expect, test } from 'vitest';

import { EngineFailure, SAMPLE_RATE, type AudioBuffer, type BundleState } from '../../src/contracts/index.js';
import { DEFAULT_SEGMENTER, segmentCut } from '../../src/core/stt/segmenter.js';
import { argmax, greedyTdt, parseVocabulary, piecesToText, scriptSuppression, writtenLanguage } from '../../src/core/stt/tdt.js';
import type { BundleStore } from '../../src/engines/bundle-store.js';
import { ParakeetEngine, resolveOrtThreads, type ParakeetRuntime } from '../../src/engines/parakeet.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** Enough turns for every commit the stream has queued to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await flush();
}

function buffer(seconds: number, dropped = 0): AudioBuffer {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i += 1) samples[i] = 0.1 * Math.sin(i / 7);
  return { samples, droppedSamples: dropped } as AudioBuffer;
}

// ---------------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------------

suite('the segmenter (StreamSegmenter, line for line)', () => {
  test('nothing is cut before 14 s are pending', () => {
    expect(segmentCut(new Float32Array(14 * SAMPLE_RATE - 1))).toBeNull();
  });

  test('cuts in the middle of the quietest 200 ms between 6 s and 14 s', () => {
    const pending = new Float32Array(15 * SAMPLE_RATE).fill(0.5);
    // A pause from 9.00 s to 9.30 s.
    pending.fill(0, 9 * SAMPLE_RATE, Math.round(9.3 * SAMPLE_RATE));
    const cut = segmentCut(pending)!;
    expect(cut / SAMPLE_RATE).toBeGreaterThanOrEqual(9.0);
    expect(cut / SAMPLE_RATE).toBeLessThanOrEqual(9.3);
    // Frame-aligned, as the Swift's is.
    expect(cut % 320).toBe(0);
  });

  test('on a tie the LATEST quiet window wins, so the remainder is as short as it can be', () => {
    const silent = new Float32Array(15 * SAMPLE_RATE);
    // All silence ties everywhere: the last window, [13.8 s, 14 s), centred at 13.9 s.
    expect(segmentCut(silent)).toBe(Math.round(13.9 * SAMPLE_RATE));
  });

  test('never looks past commitAfter', () => {
    const pending = new Float32Array(20 * SAMPLE_RATE).fill(0.5);
    pending.fill(0, 16 * SAMPLE_RATE, 17 * SAMPLE_RATE);
    expect(segmentCut(pending)!).toBeLessThanOrEqual(DEFAULT_SEGMENTER.commitAfter * SAMPLE_RATE);
  });
});

suite('the TDT decoder (onnx-asr NemoConformerTdt)', () => {
  /** A scripted decoder-joint: per call, which token and which duration win. */
  function scripted(frames: number, answers: readonly (readonly [number, number])[], vocabSize = 5) {
    const calls: { frame: number; previous: number; state: number }[] = [];
    let at = 0;
    return {
      calls,
      decoder: {
        frames,
        vocabSize,
        blank: vocabSize - 1,
        initialState: () => 0,
        step: async (frame: number, previous: number, state: number) => {
          calls.push({ frame, previous, state });
          const [token, duration] = answers[at] ?? [vocabSize - 1, 1];
          at += 1;
          const output = new Array<number>(vocabSize + 5).fill(0);
          output[token] = 1;
          output[vocabSize + duration] = 1;
          return { output, state: state + 1 };
        },
      },
    };
  }

  test('a token with a duration jumps that many frames; blank advances one', async () => {
    const { decoder, calls } = scripted(6, [
      [0, 2],
      [4, 0],
      [1, 3],
    ]);
    expect(await greedyTdt(decoder)).toEqual([0, 1]);
    expect(calls.map((call) => call.frame)).toEqual([0, 2, 3]);
  });

  test('a duration-0 token stays on the frame and conditions the next call on itself', async () => {
    const { decoder, calls } = scripted(1, [
      [2, 0],
      [3, 0],
      [4, 0],
    ]);
    expect(await greedyTdt(decoder)).toEqual([2, 3]);
    expect(calls.map((call) => call.previous)).toEqual([4, 2, 3]);
    // The state advances only when a token is kept: blank keeps the old one.
    expect(calls.map((call) => call.state)).toEqual([0, 1, 2]);
  });

  test('P4 respelling: held to one script, the best ALLOWED piece wins and the blank stays allowed', async () => {
    const vocabulary = parseVocabulary(['▁the 0', '▁зе 1', '. 2', 'ин 3', '<blk> 4'].join('\n'));
    const english = scriptSuppression(vocabulary, 'en');
    const russian = scriptSuppression(vocabulary, 'ru');
    expect([...english]).toEqual([0, 1, 0, 1, 0]);
    expect([...russian]).toEqual([1, 0, 0, 0, 0]);
    // A decoder-joint whose first choice is always the Cyrillic piece (1), then the Latin one (0).
    const decoder = {
      frames: 2,
      vocabSize: 5,
      blank: 4,
      initialState: () => 0,
      step: async (_frame: number, _previous: number, state: number) => ({
        output: [0.5, 0.9, 0.1, 0.2, 0.3, 0, 1, 0, 0, 0],
        state,
      }),
    };
    expect(await greedyTdt(decoder)).toEqual([1, 1]);
    expect(await greedyTdt(decoder, 10, english)).toEqual([0, 0]);
    expect(await greedyTdt(decoder, 10, russian)).toEqual([1, 1]);
  });

  test('the per-frame cap stops a duration-0 loop', async () => {
    const { decoder } = scripted(1, Array.from({ length: 50 }, () => [1, 0] as const));
    expect(await greedyTdt(decoder, 10)).toHaveLength(10);
  });

  test('argmax is the FIRST maximum, as numpy has it', () => {
    expect(argmax([1, 3, 3, 0])).toBe(1);
    expect(argmax([0, 0, 5, 5, 1], 2, 5)).toBe(0);
  });

  test('pieces become text with onnx-asr\'s spacing — Cyrillic included', () => {
    const vocabulary = parseVocabulary(['<unk> 0', '▁При 1', 'вет 2', ', 3', '▁мир 4', '. 5', '▁hello 6', '<blk> 7'].join('\n'));
    expect(vocabulary.blank).toBe(7);
    expect(vocabulary.size).toBe(8);
    expect(piecesToText([1, 2, 3, 4, 5], vocabulary)).toBe('Привет, мир.');
    // A leading space goes; a space before punctuation goes.
    expect(piecesToText([6, 3], vocabulary)).toBe('hello,');
    // `<unk>` never reaches the text.
    expect(piecesToText([6, 0, 3, 4], vocabulary)).toBe('hello, мир');
  });

  test('the written language is the majority script; Russian with English terms stays Russian', () => {
    expect(writtenLanguage('Давай сделаем deploy сегодня', 'en')).toBe('ru');
    expect(writtenLanguage('Hello there', 'ru')).toBe('en');
    expect(writtenLanguage('42 !', 'ru')).toBe('ru');
  });

  test('encoder threads: the physical-core estimate, capped at 8', () => {
    expect(resolveOrtThreads(2)).toBe(2);
    expect(resolveOrtThreads(8)).toBe(4);
    expect(resolveOrtThreads(12)).toBe(6);
    expect(resolveOrtThreads(32)).toBe(8);
    expect(resolveOrtThreads(0)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------
// The engine, with a fake runtime and a fake store
// ---------------------------------------------------------------------------------

class FakeStore implements BundleStore {
  installed = false;
  ensures = 0;
  finishDownload: (() => void) | null = null;
  failDownload: ((error: Error) => void) | null = null;
  readonly notes: string[] = [];
  directoryFor(): string {
    return '/models/parakeet';
  }
  pathOf(_id: unknown, name: string): string {
    return `/models/parakeet/${name}`;
  }
  async isInstalled(): Promise<boolean> {
    return this.installed;
  }
  async locate(): Promise<string | null> {
    return this.installed ? '/models/parakeet' : null;
  }
  ensure(): Promise<string> {
    this.ensures += 1;
    return new Promise<string>((resolve, reject) => {
      this.finishDownload = () => {
        this.installed = true;
        resolve('/models/parakeet');
      };
      this.failDownload = reject;
    });
  }
}

class FakeRuntime implements ParakeetRuntime {
  readonly decoded: number[] = [];
  disposed = false;
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly answer: (samples: Float32Array) => string = (samples) => `piece of ${samples.length}`) {}
  async transcribeSamples(samples: Float32Array): Promise<string> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await flush();
    this.inFlight -= 1;
    this.decoded.push(samples.length);
    return this.answer(samples);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function engineWith(options: {
  readonly store?: FakeStore;
  readonly runtime?: FakeRuntime;
  readonly autoDownload?: boolean | (() => boolean);
  readonly states?: BundleState[];
}) {
  const store = options.store ?? new FakeStore();
  const runtime = options.runtime ?? new FakeRuntime();
  let loads = 0;
  const engine = new ParakeetEngine({
    store,
    threads: 2,
    idleUnloadMs: null,
    autoDownload: options.autoDownload ?? true,
    loadRuntime: async () => {
      loads += 1;
      return runtime;
    },
    onStateChange: (state) => options.states?.push(state),
  });
  return { engine, store, runtime, loads: () => loads };
}

suite('ParakeetEngine', () => {
  test('P4 respelling: transcribeWrittenIn decodes again held to the language’s script', async () => {
    const scripts: (string | null | undefined)[] = [];
    const runtime = new FakeRuntime();
    runtime.transcribeSamples = async (_samples: Float32Array, script?: string | null) => {
      scripts.push(script);
      return script === 'en' ? 'Inside the content folder.' : 'Инсайд зе контент фоль.';
    };
    const store = new FakeStore();
    store.installed = true;
    const { engine } = engineWith({ store, runtime });
    const audio: AudioBuffer = { samples: new Float32Array(SAMPLE_RATE), droppedSamples: 0 };
    // Not loaded yet: it loads, as the Mac's does.
    const again = await engine.transcribeWrittenIn(audio, 'en');
    expect(again).toMatchObject({ raw: 'Inside the content folder.', language: 'en' });
    expect((await engine.transcribe(audio, 'en')).raw).toBe('Инсайд зе контент фоль.');
    // After the load's own warm-up pass (no script): the respelling, then an ordinary decode.
    expect(scripts.slice(-2)).toEqual(['en', null]);
    await expect(engine.transcribeWrittenIn(audio, 'uz')).rejects.toBeInstanceOf(EngineFailure);
  });

  test('not downloaded: prepare THROWS notReady and starts the one download', async () => {
    const states: BundleState[] = [];
    const { engine, store } = engineWith({ states });
    await expect(engine.prepare()).rejects.toBeInstanceOf(EngineFailure);
    await expect(engine.prepare()).rejects.toThrow(/still downloading/);
    expect(store.ensures).toBe(1);
    expect(states[0]?.kind).toBe('downloading');

    // The download lands: the engine loads itself, without waiting for a dictation.
    store.finishDownload?.();
    await flush();
    await flush();
    await flush();
    expect(await engine.isReady()).toBe(true);
    expect(states.map((state) => state.kind)).toContain('loaded');
  });

  test('autoDownload as a question: asked at the moment of need, so a later yes counts (D-W23)', async () => {
    let accepted = false;
    const { engine, store } = engineWith({ autoDownload: () => accepted });
    await expect(engine.prepare()).rejects.toThrow(/not downloaded/);
    expect(store.ensures).toBe(0);
    accepted = true;
    await expect(engine.prepare()).rejects.toThrow(/still downloading/);
    expect(store.ensures).toBe(1);
  });

  test('autoDownload off: says so, and fetches nothing', async () => {
    const { engine, store } = engineWith({ autoDownload: false });
    await expect(engine.prepare()).rejects.toThrow(/not downloaded/);
    expect(store.ensures).toBe(0);
  });

  test('a failed download is reported, and the next prepare tries again', async () => {
    const states: BundleState[] = [];
    const { engine, store } = engineWith({ states });
    await expect(engine.prepare()).rejects.toThrow();
    store.failDownload?.(new Error('HTTP 503'));
    await flush();
    expect(states[states.length - 1]).toEqual({ kind: 'failed', reason: 'HTTP 503' });
    await expect(engine.prepare()).rejects.toThrow(/last attempt failed: HTTP 503/);
    expect(store.ensures).toBe(2);
  });

  test('installed: loads once, however many callers arrive while it loads', async () => {
    const store = new FakeStore();
    store.installed = true;
    const { engine, loads } = engineWith({ store });
    await Promise.all([engine.prepare(), engine.prepare(), engine.prepare()]);
    expect(loads()).toBe(1);
    expect(await engine.isReady()).toBe(true);
  });

  test('transcribe reports the WRITTEN language, pads a tap to one second, and refuses Uzbek', async () => {
    const store = new FakeStore();
    store.installed = true;
    const runtime = new FakeRuntime(() => 'Привет, это deploy.');
    const { engine } = engineWith({ store, runtime });
    await engine.prepare();
    const result = await engine.transcribe(buffer(0.2), 'en');
    expect(result).toEqual({ raw: 'Привет, это deploy.', language: 'ru', engineId: 'parakeet-ultra' });
    expect(runtime.decoded[runtime.decoded.length - 1]).toBe(SAMPLE_RATE);
    await expect(engine.transcribe(buffer(1), 'uz')).rejects.toThrow(/does not support uz/);
  });

  test('decodes are serialised: a stream commit never overlaps the key-up decode', async () => {
    const store = new FakeStore();
    store.installed = true;
    const runtime = new FakeRuntime();
    const { engine } = engineWith({ store, runtime });
    await engine.prepare();
    await Promise.all([engine.decode(new Float32Array(16000)), engine.decode(new Float32Array(16000)), engine.decode(new Float32Array(16000))]);
    expect(runtime.maxInFlight).toBe(1);
  });

  test('unload gives the runtime back, and the next prepare reloads', async () => {
    const store = new FakeStore();
    store.installed = true;
    const { engine, runtime, loads } = engineWith({ store });
    await engine.prepare();
    await engine.unload();
    expect(runtime.disposed).toBe(true);
    expect(await engine.isReady()).toBe(false);
    await engine.prepare();
    expect(loads()).toBe(2);
  });
});

suite('ParakeetStream', () => {
  async function loaded(runtime = new FakeRuntime()) {
    const store = new FakeStore();
    store.installed = true;
    const made = engineWith({ store, runtime });
    await made.engine.prepare();
    runtime.decoded.length = 0;
    return made;
  }

  function feed(stream: { append(samples: Float32Array): void }, audio: AudioBuffer): void {
    for (let at = 0; at < audio.samples.length; at += 1600) stream.append(audio.samples.slice(at, at + 1600));
  }

  test('a long hold commits windows during capture; key-up decodes only the rest', async () => {
    const { engine, runtime } = await loaded();
    const stream = engine.openStream();
    const committed: string[] = [];
    stream.onCommit?.((text) => committed.push(text));
    const audio = buffer(40);
    feed(stream, audio);
    await flush();
    await flush();
    feed(stream, { samples: new Float32Array(0), droppedSamples: 0 } as AudioBuffer);
    await flush();
    const commitsDuringHold = runtime.decoded.length;
    expect(commitsDuringHold).toBeGreaterThanOrEqual(2);
    expect(committed.length).toBe(commitsDuringHold);

    const result = await stream.finish(audio, 'en');
    // Every sample decoded exactly once, and the pieces joined in order.
    expect(runtime.decoded.reduce((sum, n) => sum + n, 0)).toBe(audio.samples.length);
    expect(result.raw.split(' piece of ').length).toBe(runtime.decoded.length);
    // What is left at key-up is at most one window.
    expect(runtime.decoded[runtime.decoded.length - 1]!).toBeLessThanOrEqual(14 * SAMPLE_RATE);
  });

  test('a short hold commits nothing and is one batch decode', async () => {
    const { engine, runtime } = await loaded();
    const stream = engine.openStream();
    const audio = buffer(8);
    feed(stream, audio);
    await flush();
    await stream.finish(audio, 'en');
    expect(runtime.decoded).toEqual([audio.samples.length]);
  });

  test('lost samples: the committed text is thrown away and the whole recording decoded', async () => {
    const { engine, runtime } = await loaded();
    const stream = engine.openStream();
    const audio = buffer(30);
    feed(stream, audio);
    await settle();
    expect(runtime.decoded.length).toBeGreaterThan(0);
    runtime.decoded.length = 0;
    await stream.finish({ ...audio, droppedSamples: 800 } as AudioBuffer, 'en');
    expect(runtime.decoded).toEqual([audio.samples.length]);
  });

  test('a recording shorter than what was committed is decoded whole', async () => {
    const { engine, runtime } = await loaded();
    const stream = engine.openStream();
    feed(stream, buffer(30));
    await settle();
    runtime.decoded.length = 0;
    const shorter = buffer(10);
    await stream.finish(shorter, 'en');
    expect(runtime.decoded).toEqual([shorter.samples.length]);
  });

  test('a cold engine: the commit is put back, nothing is lost, key-up decodes it all', async () => {
    const store = new FakeStore();
    const runtime = new FakeRuntime();
    const { engine } = engineWith({ store, runtime, autoDownload: false });
    const stream = engine.openStream();
    const audio = buffer(20);
    feed(stream, audio);
    await flush();
    // Not installed: nothing decoded during the hold, and finish reports why.
    expect(runtime.decoded).toEqual([]);
    await expect(stream.finish(audio, 'en')).rejects.toThrow(/not downloaded/);
    store.installed = true;
    const again = engine.openStream();
    feed(again, audio);
    await flush();
    await flush();
    const result = await again.finish(audio, 'en');
    expect(runtime.decoded.reduce((sum, n) => sum + n, 0)).toBe(audio.samples.length + SAMPLE_RATE); // + the warm-up
    expect(result.raw.length).toBeGreaterThan(0);
  });

  // Core review 2026-09-30, item 2: a commit landing while key-up waited started the next
  // window and `finish` pasted the text without it.
  test('key-up waits for every window, and none starts once it is waiting', async () => {
    const { engine, runtime } = await loaded();
    const stream = engine.openStream();
    const audio = buffer(30);
    feed(stream, audio); // faster than the runtime answers: a backlog behind the first window
    const result = await stream.finish(audio, 'en');
    expect(runtime.decoded.reduce((sum, n) => sum + n, 0)).toBe(audio.samples.length);
    // One piece of text per decode: nothing decoded was left out of the paste.
    expect(result.raw.split('piece of ').length - 1).toBe(runtime.decoded.length);
  });

  test("a cancelled stream's finish decodes nothing — not even the batch it used to fall back to", async () => {
    const { engine, runtime } = await loaded();
    const stream = engine.openStream();
    const audio = buffer(30);
    feed(stream, audio);
    await settle();
    const before = runtime.decoded.length;
    stream.cancel();
    await expect(stream.finish(audio, 'en')).rejects.toThrow(/cancelled/);
    expect(runtime.decoded.length).toBe(before);
  });

  test('cancel drops everything and commits nothing more', async () => {
    const { engine, runtime } = await loaded();
    const stream = engine.openStream();
    stream.cancel();
    feed(stream, buffer(30));
    await flush();
    expect(runtime.decoded).toEqual([]);
  });
});
