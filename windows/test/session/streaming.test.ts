// The session's half of streaming: the take's chunks reach the speculated family's stream
// while the key is held, the stream is used at key-up only for the family it speculated
// on, the unified engine's written language beats the router's en/ru guess (step 4a), and
// text committed during the hold is polished during the hold.

import { describe as suite, expect, test } from 'vitest';

import { DEFAULT_POLISH_GUARD, DEFAULT_SESSION_CONFIG } from '../../src/contracts/index.js';
import type {
  AudioBuffer,
  EngineFamily,
  Language,
  RouteDecision,
  StreamingSttEngine,
  TranscriptionStream,
  TranscriptResult,
} from '../../src/contracts/index.js';
import { cleanUp } from '../../src/core/modes/index.js';
import { ModePolisher, type PromptedPolisher } from '../../src/polish/index.js';
import { createDictationSession, type FinishOptions } from '../../src/session/index.js';
import { FakeEngine, FakeInserter, ManualClock, SPEECH, fakePorts } from './fakes.js';

class FakeStream implements TranscriptionStream {
  appended = 0;
  cancelled = false;
  finished = false;
  readonly listeners: ((text: string) => void)[] = [];
  constructor(private readonly text: string, private readonly language: Language) {}
  append(samples: Float32Array): void {
    this.appended += samples.length;
  }
  onCommit(listener: (text: string) => void): () => void {
    this.listeners.push(listener);
    return () => undefined;
  }
  commit(text: string): void {
    for (const listener of this.listeners) listener(text);
  }
  async finish(_audio: AudioBuffer, _language: Language): Promise<TranscriptResult> {
    this.finished = true;
    return { raw: this.text, language: this.language, engineId: 'stream' };
  }
  cancel(): void {
    this.cancelled = true;
  }
}

class StreamingEngine extends FakeEngine implements StreamingSttEngine {
  readonly streams: FakeStream[] = [];
  streamText = 'Streamed words.';
  streamLanguage: Language = 'en';
  openStream(): FakeStream {
    const stream = new FakeStream(this.streamText, this.streamLanguage);
    this.streams.push(stream);
    return stream;
  }
}

function harness(options: {
  readonly route?: RouteDecision;
  readonly pinAtPress?: Language | null;
  readonly speculativeLanguage?: Language | null;
  readonly livePolisher?: ModePolisher | null;
  readonly uzbekStreams?: boolean;
} = {}) {
  const clock = new ManualClock();
  const ports = fakePorts({ clock, ...(options.route === undefined ? {} : { route: options.route }) });
  const chunkListeners: ((samples: Float32Array) => void)[] = [];
  const unified = new StreamingEngine('unified-lead', new Set<Language>(['en', 'ru']), clock);
  const uzbek = options.uzbekStreams
    ? new StreamingEngine('uzbek-streaming', new Set<Language>(['uz']), clock)
    : new FakeEngine('whisper-uzbek', new Set<Language>(['uz']), clock);
  const engines = new Map<EngineFamily, FakeEngine>([
    ['unified', unified],
    ['uzbek', uzbek],
  ]);
  const inserter = new FakeInserter();
  const normalise = (text: string, language: Language): string => cleanUp(text, language);
  const session = createDictationSession({
    audio: {
      start: async () => undefined,
      stop: async () => SPEECH,
      onChunk: (listener) => {
        chunkListeners.push(listener);
        return () => {
          const at = chunkListeners.indexOf(listener);
          if (at >= 0) chunkListeners.splice(at, 1);
        };
      },
    },
    router: ports.createRouter({ classifier: null, threshold: 0.05, fallbackLanguage: 'en' }),
    engineFor: (family) => engines.get(family) ?? null,
    insert: (text) => inserter.insert(text),
    replace: (previous, text) => inserter.replace(previous, text),
    normalise,
    normaliseSegment: (text, language) => cleanUp(text, language, { closesFinalSentence: false }),
    pinAtPress: options.pinAtPress ?? null,
    speculativeLanguage: options.speculativeLanguage ?? null,
    livePolisher: () => options.livePolisher ?? null,
    routing: ports.routing,
    text: ports.text,
    config: DEFAULT_SESSION_CONFIG,
    clock,
  });
  const chunk = (n = 1600): void => {
    for (const listener of [...chunkListeners]) listener(new Float32Array(n));
  };
  const finish = (patch: Partial<FinishOptions> = {}) =>
    session.finish({
      pin: null,
      polisher: null,
      polishInstructions: null,
      polishGuard: DEFAULT_POLISH_GUARD,
      insertAfterPolish: true,
      ...patch,
    });
  return { session, unified, uzbek, inserter, chunk, finish, chunkListeners };
}

suite('streaming during the hold', () => {
  test('unpinned: the unified stream is fed every chunk and answers at key-up', async () => {
    const h = harness();
    await h.session.arm();
    h.chunk();
    h.chunk();
    const record = await h.finish();
    const stream = h.unified.streams[0]!;
    expect(stream.appended).toBe(3200);
    expect(stream.finished).toBe(true);
    expect(h.unified.transcribeCalls).toBe(0);
    expect(record.raw).toBe('Streamed words.');
    // The listener is let go once the take is over.
    expect(h.chunkListeners).toHaveLength(0);
  });

  test('a route to the other family cancels the stream and decodes in batch', async () => {
    const h = harness({ route: { language: 'uz', family: 'uzbek', source: 'acoustic', turkicMass: 0.4 } });
    await h.session.arm();
    h.chunk();
    const record = await h.finish();
    expect(h.unified.streams[0]!.cancelled).toBe(true);
    expect(h.unified.streams[0]!.finished).toBe(false);
    expect(record.engineID).toBe('whisper-uzbek');
  });

  test('pinned to Uzbek: nothing streams unless the Uzbek engine can — the seam', async () => {
    const batch = harness({ pinAtPress: 'uz' });
    await batch.session.arm();
    expect(batch.unified.streams).toHaveLength(0);
    expect(batch.chunkListeners).toHaveLength(0);

    const streaming = harness({ pinAtPress: 'uz', uzbekStreams: true });
    await streaming.session.arm();
    streaming.chunk();
    await streaming.finish({ pin: 'uz' });
    expect((streaming.uzbek as StreamingEngine).streams[0]!.appended).toBe(1600);
    expect((streaming.uzbek as StreamingEngine).streams[0]!.finished).toBe(true);
  });

  test('heard nothing or a failure still lets the stream go', async () => {
    const h = harness();
    await h.session.arm();
    await h.session.cancel('chord');
    expect(h.unified.streams[0]!.cancelled).toBe(true);
    expect(h.chunkListeners).toHaveLength(0);
  });
});

suite('4a — the unified engine names the language', () => {
  test('Russian written on an English guess becomes a Russian route', async () => {
    const h = harness({ route: { language: 'en', family: 'unified', source: 'acoustic', turkicMass: 0.01 } });
    h.unified.streamText = 'Давай сделаем deploy сегодня.';
    h.unified.streamLanguage = 'ru';
    await h.session.arm();
    const record = await h.finish();
    expect(record.route).toEqual({ language: 'ru', family: 'unified', source: 'scriptCheck', turkicMass: 0.01 });
  });

  test('a pin is never overruled', async () => {
    const h = harness({ route: { language: 'en', family: 'unified', source: 'pin', turkicMass: null } });
    h.unified.streamLanguage = 'ru';
    await h.session.arm();
    const record = await h.finish();
    expect(record.route?.language).toBe('en');
  });
});

suite('4a′ — the Uzbek stream is the second opinion when it is the one that streamed', () => {
  // An Uzbek-default user speculates on Uzbek: the ONE stream Windows opens per press is the
  // Uzbek engine's. When the acoustic pass nonetheless routes to the unified engine and that
  // engine's transcript is not English, the stream is finished instead of decoding again.
  const acousticEn: RouteDecision = { language: 'en', family: 'unified', source: 'acoustic', turkicMass: 0.03 };

  test('a doubted unified transcript finishes the kept Uzbek stream, not a batch decode', async () => {
    const h = harness({ route: acousticEn, speculativeLanguage: 'uz', uzbekStreams: true });
    const uzbek = h.uzbek as StreamingEngine;
    h.unified.text = 'Morvalen tikoshar penduvi askarel dunemba.';
    uzbek.streamText = 'bugun bozorga bordim va non oldim.';
    uzbek.streamLanguage = 'uz';
    await h.session.arm();
    h.chunk();
    const record = await h.finish();
    expect(h.unified.streams).toHaveLength(0);
    expect(uzbek.streams[0]!.finished).toBe(true);
    expect(uzbek.streams[0]!.cancelled).toBe(false);
    expect(uzbek.transcribeCalls).toBe(0);
    expect(record.route).toEqual({ language: 'uz', family: 'uzbek', source: 'transcriptCheck', turkicMass: 0.03 });
    expect(record.unifiedDoubt).toBe('notEnglish');
  });

  test('an English unified transcript lets the kept Uzbek stream go, unfinished', async () => {
    const h = harness({ route: acousticEn, speculativeLanguage: 'uz', uzbekStreams: true });
    const uzbek = h.uzbek as StreamingEngine;
    h.unified.text = 'Please send the report to the team before lunch.';
    await h.session.arm();
    const record = await h.finish();
    expect(uzbek.streams[0]!.cancelled).toBe(true);
    expect(uzbek.streams[0]!.finished).toBe(false);
    expect(record.route).toEqual(acousticEn);
  });

  test('a failure before transcription still lets the handed-over stream go', async () => {
    const h = harness({ route: acousticEn, speculativeLanguage: 'uz', uzbekStreams: true });
    const uzbek = h.uzbek as StreamingEngine;
    h.unified.prepareError = new Error('model file missing');
    h.unified.ready = false;
    await h.session.arm();
    const record = await h.finish();
    expect(record.outcome).toBe('failed');
    expect(uzbek.streams[0]!.cancelled).toBe(true);
  });
});

suite('incremental polish during the hold', () => {
  class EchoModel implements PromptedPolisher {
    readonly id = 'echo';
    readonly supportedLanguages: ReadonlySet<Language> = new Set<Language>(['en', 'ru', 'uz']);
    readonly calls: string[] = [];
    async generate(text: string): Promise<string> {
      this.calls.push(text);
      const cut = text.replace(/^So,? /u, '');
      return cut.charAt(0).toUpperCase() + cut.slice(1);
    }
  }

  test('committed sentences are polished before key-up; key-up polishes only the tail', async () => {
    const model = new EchoModel();
    const polisher = new ModePolisher({ behaviour: 'message', engine: model });
    const h = harness({ livePolisher: polisher });
    h.unified.streamText = 'So the seeds came today. We plant them on Friday. Then we water them.';
    await h.session.arm();
    const stream = h.unified.streams[0]!;
    stream.commit('So the seeds came today. We plant them on Friday.');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // "So the seeds came today." is complete and already polished; "We plant…" waits for
    // what follows it, because a sentence end at the very end of a commit is not yet final.
    expect(model.calls).toEqual(['So the seeds came today.']);
    const record = await h.finish({ polisher, polishInstructions: 'x' });
    expect(model.calls).toEqual(['So the seeds came today.', 'We plant them on Friday.', 'Then we water them.']);
    expect(h.inserter.inserted).toEqual(['The seeds came today. We plant them on Friday. Then we water them.']);
    expect(record.polished).toBe('The seeds came today. We plant them on Friday. Then we water them.');
  });

  test('a different language at key-up throws the early work away and polishes the whole', async () => {
    const model = new EchoModel();
    const polisher = new ModePolisher({ behaviour: 'message', engine: model });
    const h = harness({ livePolisher: polisher, route: { language: 'uz', family: 'uzbek', source: 'acoustic', turkicMass: 0.3 } });
    await h.session.arm();
    h.unified.streams[0]!.commit('So the seeds came today. We plant them on Friday.');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const record = await h.finish({ polisher, polishInstructions: 'x' });
    expect(record.engineID).toBe('whisper-uzbek');
    // The whole Uzbek transcript went through the polisher once, from the start.
    expect(model.calls.slice(1)).toEqual(['hello world']);
  });
});
