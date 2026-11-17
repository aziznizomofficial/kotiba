// Key-up on Windows, where every engine is its own process: what overlaps, and what is bounded.
//
//   * With the language-ID model routing (P4), the stream this press speculated on finishes
//     BESIDE the detection — the Mac's `speculativeFinishes` — so key-up waits for the longer of
//     the two instead of their sum.
//   * The routed engine's transcription is bounded (`transcribeDeadlineMs`): an engine process
//     that hangs fails the dictation with a sentence instead of leaving the pill on
//     "Transcribing…" for minutes.

import { describe as suite, expect, test } from 'vitest';

import { DEFAULT_POLISH_GUARD, DEFAULT_SESSION_CONFIG, transcribeDeadlineMs } from '../../src/contracts/index.js';
import type {
  AudioBuffer,
  EngineFamily,
  Language,
  LanguagePosterior,
  StreamingSttEngine,
  TranscriptionStream,
  TranscriptResult,
} from '../../src/contracts/index.js';
import { createLanguageIDRouter, languagePolicy, type LanguageModel } from '../../src/core/routing/index.js';
import { createDictationSession } from '../../src/session/index.js';

import { FakeEngine, FakeInserter, ManualClock, SPEECH, fakePorts, flush } from './fakes.js';

/** The transparent stand-in model of language-id.test.ts. */
const MODEL: LanguageModel = {
  acoustic: [0, 1, 2, 3, 4].map((i) => Array.from({ length: 8 }, (_, k) => (k === i ? 1 : 0))),
  transcript: [0, 1, 2, 3].map(() =>
    [0, 1, 2, 3, 4].map((i) => Array.from({ length: 11 }, (_, k) => (k === 2 * i ? 1.5 : k === 2 * i + 1 ? -1.5 : 0))),
  ),
};

class TimedStream implements TranscriptionStream {
  finishCalls = 0;
  finishedAt: number | null = null;
  cancelled = false;
  constructor(
    private readonly clock: ManualClock,
    private readonly text: string,
    private readonly language: Language,
    private readonly delayMs: number,
  ) {}
  append(): void {}
  async finish(_audio: AudioBuffer, _language: Language): Promise<TranscriptResult> {
    this.finishCalls += 1;
    await this.clock.sleep(this.delayMs).promise;
    this.finishedAt = this.clock.now();
    return { raw: this.text, language: this.language, engineId: 'stream' };
  }
  cancel(): void {
    this.cancelled = true;
  }
}

class StreamingFake extends FakeEngine implements StreamingSttEngine {
  readonly streams: TimedStream[] = [];
  streamDelayMs = 300;
  constructor(
    engineId: string,
    languages: ReadonlySet<Language>,
    private readonly manual: ManualClock,
    private readonly streamText: string,
    private readonly streamLanguage: Language,
  ) {
    super(engineId, languages, manual);
  }
  openStream(): TimedStream {
    const stream = new TimedStream(this.manual, this.streamText, this.streamLanguage, this.streamDelayMs);
    this.streams.push(stream);
    return stream;
  }
}

function harness(options: { readonly posterior: LanguagePosterior; readonly detectMs: number; readonly unifiedReady?: boolean }) {
  const clock = new ManualClock();
  const ports = fakePorts({ clock });
  const chunkListeners: ((samples: Float32Array) => void)[] = [];
  const unified = new StreamingFake('parakeet', new Set<Language>(['en', 'ru']), clock, 'The streamed words.', 'en');
  unified.ready = options.unifiedReady ?? true;
  const uzbek = new FakeEngine('uzbek', new Set<Language>(['uz']), clock);
  uzbek.text = 'Salom dunyo.';
  const engines = new Map<EngineFamily, FakeEngine>([
    ['unified', unified],
    ['uzbek', uzbek],
  ]);
  const enabled: Language[] = ['en', 'ru', 'uz'];
  const policy = languagePolicy({ model: MODEL, enabled });
  let detectedAt: number | null = null;
  const inserter = new FakeInserter();
  const session = createDictationSession({
    audio: {
      start: async () => undefined,
      stop: async () => SPEECH,
      onChunk: (listener) => {
        chunkListeners.push(listener);
        return () => undefined;
      },
    },
    router: createLanguageIDRouter({
      classifier: {
        posterior: async () => {
          await clock.sleep(options.detectMs).promise;
          detectedAt = clock.now();
          return options.posterior;
        },
      },
      policy,
    }),
    languageID: policy,
    speculativeLanguage: 'en',
    engineFor: (family) => engines.get(family) ?? null,
    insert: (text) => inserter.insert(text),
    replace: (previous, text) => inserter.replace(previous, text),
    normalise: (text) => text,
    routing: ports.routing,
    text: ports.text,
    config: DEFAULT_SESSION_CONFIG,
    clock,
    languages: enabled,
  });
  return {
    session,
    clock,
    unified,
    uzbek,
    inserter,
    detectedAt: () => detectedAt,
    start: async () => {
      await session.arm();
      for (const listener of chunkListeners) listener(new Float32Array(1600));
      return session.finish({
        pin: null,
        polisher: null,
        polishInstructions: null,
        polishGuard: DEFAULT_POLISH_GUARD,
        insertAfterPolish: false,
      });
    },
  };
}

suite('key-up: the speculated stream finishes beside the language decision (P4)', () => {
  test('the route agrees: the stream was finishing while the detection ran, and its answer is the transcript', async () => {
    const h = harness({ posterior: { en: 0.97, _: 0.03 }, detectMs: 200 });
    const t0 = h.clock.now();
    const finishing = h.start();
    // The stream takes 300 ms, the detection 200 ms: overlapped, key-up is done at 300, not 500.
    await h.clock.advance(200);
    await h.clock.advance(100);
    const record = await finishing;
    const stream = h.unified.streams[0]!;
    expect(stream.finishCalls).toBe(1);
    expect(h.detectedAt()! - t0).toBe(200);
    expect(stream.finishedAt! - t0).toBe(300);
    expect(record.route?.language).toBe('en');
    expect(record.raw).toBe('The streamed words.');
    expect(h.unified.transcribeCalls).toBe(0);
    expect(h.inserter.inserted).toEqual(['The streamed words.']);
  });

  test('a cold engine is not finished early: nothing is loaded behind the detection', async () => {
    const h = harness({ posterior: { en: 0.97, _: 0.03 }, detectMs: 200, unifiedReady: false });
    const finishing = h.start();
    await h.clock.advance(100);
    expect(h.unified.streams[0]!.finishCalls).toBe(0);
    for (let i = 0; i < 10; i += 1) await h.clock.advance(1000);
    const record = await finishing;
    // Prepared at step 4, then finished there, as before.
    expect(h.unified.prepareCalls).toBe(1);
    expect(h.unified.streams[0]!.finishCalls).toBe(1);
    expect(record.raw).toBe('The streamed words.');
  });

  test('the route goes elsewhere: the early finish is not delivered, and the stream is let go', async () => {
    const h = harness({ posterior: { uz: 0.97, _: 0.03 }, detectMs: 50 });
    const finishing = h.start();
    for (let i = 0; i < 10; i += 1) await h.clock.advance(1000);
    const record = await finishing;
    expect(record.route?.language).toBe('uz');
    expect(record.raw).toBe('Salom dunyo.');
    expect(h.uzbek.transcribeCalls).toBe(1);
    expect(h.unified.streams[0]!.cancelled).toBe(true);
  });
});

suite('key-up: the routed transcription is bounded (Windows)', () => {
  test('an engine that never answers fails the dictation with a sentence at the deadline, and is told to stop', async () => {
    const h = harness({ posterior: { uz: 0.97, _: 0.03 }, detectMs: 0 });
    h.uzbek.delayMs = 10 * 60_000;
    const finishing = h.start();
    const deadline = transcribeDeadlineMs(SPEECH.samples.length / 16_000);
    // Past the detection: the transcription starts, and with it the deadline.
    await h.clock.advance(0);
    expect(h.uzbek.transcribeCalls).toBe(1);
    await h.clock.advance(deadline - 1);
    let settled = false;
    void finishing.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    await h.clock.advance(2);
    const record = await finishing;
    expect(record.outcome).toBe('failed');
    expect(h.session.state).toMatchObject({ kind: 'failed', error: { kind: 'transcriptionFailed' } });
    expect(record.errors.some((error) => /uzbek did not answer within 30 s/.test(error))).toBe(true);
    expect(h.uzbek.lastSignal?.aborted).toBe(true);
    expect(h.inserter.inserted).toEqual([]);
  });

  test('the ceiling grows with the recording: 2 s per second of audio over a 30 s floor', () => {
    expect(transcribeDeadlineMs(2)).toBe(30_000);
    expect(transcribeDeadlineMs(15)).toBe(30_000);
    expect(transcribeDeadlineMs(60)).toBe(120_000);
    expect(transcribeDeadlineMs(600, 1_000)).toBe(1_200_000);
  });
});
