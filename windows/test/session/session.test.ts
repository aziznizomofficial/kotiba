// The per-dictation state machine.
//
// Every test here is one of the failures the brief names, or one of the two structural
// rules. Nothing is asserted that a fake could not tell us — the measured behaviour of
// the normaliser, the router and the guards belongs to t03/t04 and their goldens.

import { describe as suite, expect, test } from 'vitest';
import { DEFAULT_POLISH_GUARD, DEFAULT_SESSION_CONFIG, SAMPLE_RATE, dictationErrorHeadline } from '../../src/contracts/index.js';
import type {
  EngineFamily,
  Language,
  RouteDecision,
  SessionConfig,
} from '../../src/contracts/index.js';
import { createDictationSession, isEmptyTranscript } from '../../src/session/index.js';
import type { DictationSession, FinishOptions } from '../../src/session/index.js';
import {
  FakeAudio,
  FakeEngine,
  FakeInserter,
  FakePolisher,
  ManualClock,
  NO_AUDIO,
  SILENCE_7_4,
  SPEECH,
  fakePorts,
  flush,
  tone,
} from './fakes.js';
import type { PortOverrides } from './fakes.js';

interface Harness {
  readonly session: DictationSession;
  readonly audio: FakeAudio;
  readonly inserter: FakeInserter;
  readonly unified: FakeEngine;
  readonly uzbek: FakeEngine;
  readonly clock: ManualClock;
  readonly normaliseCalls: { text: string; language: Language }[];
  finish(options?: Partial<FinishOptions>): ReturnType<DictationSession['finish']>;
}

function harness(
  options: {
    readonly ports?: PortOverrides;
    readonly config?: Partial<SessionConfig>;
    readonly route?: RouteDecision;
    readonly normalise?: (text: string, language: Language) => string;
    /** No engine registered for the Uzbek family at all. */
    readonly uzbekAbsent?: boolean;
    /** D-W25: how far a language's engine download has got. */
    readonly gettingReady?: (language: Language) => number | null;
  } = {},
): Harness {
  const clock = new ManualClock();
  const ports = fakePorts({ ...options.ports, clock, route: options.route ?? options.ports?.route });
  const audio = new FakeAudio(clock);
  const inserter = new FakeInserter();
  const unified = new FakeEngine('unified-v3-turbo', new Set<Language>(['en', 'ru']), clock);
  const uzbek = new FakeEngine('whisper-ggml-uzbek-stt-v1-q5_0', new Set<Language>(['uz']), clock);
  const engines = new Map<EngineFamily, FakeEngine>([
    ['unified', unified],
    ['uzbek', uzbek],
  ]);
  if (options.uzbekAbsent === true) engines.delete('uzbek');
  const normaliseCalls: { text: string; language: Language }[] = [];
  const router = ports.createRouter({
    classifier: null,
    threshold: 0.05,
    fallbackLanguage: 'en',
  });

  const session = createDictationSession({
    audio: { start: () => audio.start(), stop: () => audio.stop() },
    router,
    engineFor: (family) => engines.get(family) ?? null,
    ...(options.gettingReady === undefined ? {} : { gettingReady: options.gettingReady }),
    insert: (text) => inserter.insert(text),
    replace: (previous, text) => inserter.replace(previous, text),
    normalise: (text, language) => {
      normaliseCalls.push({ text, language });
      return options.normalise === undefined ? text : options.normalise(text, language);
    },
    routing: ports.routing,
    text: ports.text,
    config: { ...DEFAULT_SESSION_CONFIG, ...options.config },
    clock,
  });

  return {
    session,
    audio,
    inserter,
    unified,
    uzbek,
    clock,
    normaliseCalls,
    finish: (patch = {}) =>
      session.finish({
        pin: null,
        polisher: null,
        polishInstructions: null,
        polishGuard: DEFAULT_POLISH_GUARD,
        insertAfterPolish: false,
        ...patch,
      }),
  };
}

// ---------------------------------------------------------------------------------

suite('the microphone in the record', () => {
  const device = { name: 'Test iPhone Microphone', transport: 'continuity', sampleRate: 48_000, overrodeDefault: false } as const;

  test('a heard-nothing take records which device was listening', async () => {
    const h = harness();
    h.audio.buffer = { ...tone(2, 0.008), device };
    await h.session.arm();
    const record = await h.finish();
    expect(record.outcome).toBe('heardNothing');
    expect(record.inputDevice).toEqual(device);
  });

  test('a source that does not know leaves the field out', async () => {
    const h = harness();
    await h.session.arm();
    const record = await h.finish();
    expect(Object.prototype.hasOwnProperty.call(record, 'inputDevice')).toBe(false);
  });
});

suite('the happy path', () => {
  test('arms, captures, transcribes, normalises and inserts once', async () => {
    const h = harness();
    await h.session.arm();
    expect(h.session.state.kind).toBe('capturing');

    const record = await h.finish();

    expect(h.session.state.kind).toBe('done');
    expect(record.outcome).toBe('done');
    expect(h.inserter.inserted).toEqual(['hello world']);
    expect(record.raw).toBe('hello world');
    expect(record.result).toBe('hello world');
    expect(record.engineID).toBe('unified-v3-turbo');
    expect(record.route).toEqual({
      language: 'en',
      family: 'unified',
      source: 'fallback',
      turkicMass: null,
    });
  });

  test('the transitions are the eleven states in order, and never cumulative', async () => {
    const h = harness();
    await h.session.arm();
    await h.finish();
    expect(h.session.transitions.map((t) => t.kind)).toEqual([
      'arming',
      'capturing',
      'finalising',
      'routing',
      'transcribing',
      'inserting',
      'done',
    ]);

    // A second dictation on the same session starts a FRESH transition list.
    await h.session.arm();
    await h.finish();
    expect(h.session.transitions.map((t) => t.kind)).toEqual([
      'arming',
      'capturing',
      'finalising',
      'routing',
      'transcribing',
      'inserting',
      'done',
    ]);
  });

  test('the stage timings use the macOS field names and omit stages that did not run', async () => {
    const h = harness();
    await h.session.arm();
    const record = await h.finish();
    expect(Object.keys(record.stageMillis).sort()).toEqual([
      'arming',
      'finalising',
      'inserting',
      'routing',
      'transcribing',
    ]);
    // Absent because they did not run, and that absence is itself the answer to most
    // "why was that slow" questions.
    expect(record.stageMillis.loading).toBeUndefined();
    expect(record.stageMillis.polishing).toBeUndefined();
    expect(record.stageMillis.rerouting).toBeUndefined();
  });

  test('startedAt is ISO-8601 UTC at seconds precision', async () => {
    const h = harness();
    await h.session.arm();
    const record = await h.finish();
    expect(record.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('optional fields are OMITTED when absent, never written as null', async () => {
    const h = harness();
    await h.session.arm();
    const record = await h.finish();
    expect('polished' in record).toBe(false);
    expect('polishID' in record).toBe(false);
    expect('modeKey' in record).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// FAILURE 4 — silence delivered as an empty paste
// ---------------------------------------------------------------------------------

suite('nothing was said', () => {
  test('a 7.4 s silent recording reports heardNothing and inserts nothing', async () => {
    const h = harness();
    h.audio.buffer = SILENCE_7_4;
    await h.session.arm();
    const record = await h.finish();

    expect(h.session.state.kind).toBe('heardNothing');
    expect(record.outcome).toBe('heardNothing');
    expect(record.audioSeconds).toBeCloseTo(7.4, 5);
    expect(h.inserter.inserted).toEqual([]);
    // It never reached an engine: silence is decided before anything is paid for.
    expect(h.unified.transcribeCalls).toBe(0);
  });

  test('a buffer just under the threshold is silence and just over it is not', async () => {
    const under = harness();
    under.audio.buffer = tone(1, 0.0119);
    await under.session.arm();
    expect((await under.finish()).outcome).toBe('heardNothing');

    const over = harness();
    over.audio.buffer = tone(1, 0.012);
    await over.session.arm();
    expect((await over.finish()).outcome).toBe('done');
  });

  test('an EMPTY buffer is a broken microphone, not a quiet room', async () => {
    const h = harness();
    h.audio.buffer = NO_AUDIO;
    await h.session.arm();
    const record = await h.finish();

    expect(h.session.state.kind).toBe('failed');
    expect(record.outcome).toBe('failed');
    expect(record.errors[0]).toContain('the microphone delivered no audio at all');
    expect(record.errors[0]).not.toContain('quiet room —');
  });

  test('THE SECOND GATE: an engine that heard audio and produced no words', async () => {
    // Normalisation is a third source of emptiness — a raw string of punctuation, or a
    // bare marker, can reduce to nothing even though the amplitude gate passed.
    const h = harness({ normalise: () => '   ' });
    h.unified.text = '[BLANK_AUDIO]';

    await h.session.arm();
    const record = await h.finish();

    expect(h.session.state.kind).toBe('heardNothing');
    expect(record.outcome).toBe('heardNothing');
    expect(h.inserter.inserted).toEqual([]);
    expect(record.errors.at(-1)).toContain('returned no words for 2.00s of audio at peak 0.4000');
    // The raw is still recorded: the engine DID answer, and what it answered is the
    // whole diagnosis.
    expect(record.raw).toBe('[BLANK_AUDIO]');
    expect(record.result).toBe('   ');
  });

  test('isEmptyTranscript is whitespace-only, and nothing cleverer', () => {
    expect(isEmptyTranscript('')).toBe(true);
    expect(isEmptyTranscript('   \n\t ')).toBe(true);
    expect(isEmptyTranscript('.')).toBe(false);
    expect(isEmptyTranscript('salom')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// FAILURE 1 and 2 — readiness that guards instead of preparing, and wrappers that lie
// ---------------------------------------------------------------------------------

suite('readiness prepares, then re-asks', () => {
  test('a COLD engine is prepared and used — not refused', async () => {
    const h = harness();
    h.unified.ready = false;
    await h.session.arm();
    const record = await h.finish();

    expect(h.unified.prepareCalls).toBe(1);
    expect(record.outcome).toBe('done');
    expect(h.inserter.inserted).toEqual(['hello world']);
    // The load is visible only as a timing, never as a state — there is no `loading`
    // state, and a cold model must read as a slow first dictation.
    expect(record.stageMillis.loading).toBeDefined();
    expect(h.session.transitions.map((t) => t.kind)).not.toContain('loading');
  });

  test('a warm engine is never prepared again', async () => {
    const h = harness();
    await h.session.arm();
    await h.finish();
    expect(h.unified.prepareCalls).toBe(0);
  });

  test('only a THROWING prepare is terminal, and it keeps the engine reason verbatim', async () => {
    const h = harness();
    h.unified.ready = false;
    h.unified.prepareError = new Error('the model at C:\\models\\turbo.bin cannot be used: bad magic');
    await h.session.arm();
    const record = await h.finish();

    expect(h.session.state.kind).toBe('failed');
    expect(record.outcome).toBe('failed');
    expect(record.errors[0]).toContain('bad magic');
    expect(record.errors[0]).toContain('unified-v3-turbo');
    // Named by LANGUAGE, not by family: `unified` covers English and Russian.
    if (h.session.state.kind !== 'failed') throw new Error('unreachable');
    expect(h.session.state.error.kind).toBe('noEngineReady');
    expect(h.session.state.error.message).toBe('The English engine is not ready yet.');
  });

  test('D-W25: an engine still downloading says how far it has got, not "not ready"', async () => {
    const h = harness({ gettingReady: (language) => (language === 'en' || language === 'ru' ? 42 : null) });
    h.unified.ready = false;
    h.unified.prepareError = new Error('Parakeet Ultra is still downloading');
    await h.session.arm();
    await h.finish();
    if (h.session.state.kind !== 'failed') throw new Error('unreachable');
    expect(h.session.state.error.kind).toBe('noEngineReady');
    if (h.session.state.error.kind !== 'noEngineReady') throw new Error('unreachable');
    expect(h.session.state.error.percent).toBe(42);
    expect(h.session.state.error.message).toBe('The English model is still downloading (42 %). It works as soon as it lands.');
    expect(dictationErrorHeadline(h.session.state.error)).toBe('Still downloading — 42 %');
  });

  test('A WRAPPER THAT LIES: readiness stays false, we SAY SO, and we still transcribe', async () => {
    // `isReady()` is a property of the whole FAMILY. `unified` covers English and
    // Russian, so a family engine that ANDs over its members reports not-ready for as
    // long as the Russian model is missing — and this used to FAIL the dictation, even
    // though `transcribe(buffer, 'en')` would have used the resident English member and
    // worked. The user's only explanation was "gave no reason", for a model they had
    // every intention of never installing.
    //
    // The member that will be used is asked by using it. The disagreement is recorded.
    const h = harness();
    h.unified.ready = false;
    h.unified.prepareLeavesCold = true;
    await h.session.arm();
    const record = await h.finish();

    expect(h.unified.prepareCalls).toBe(1);
    expect(h.unified.transcribeCalls).toBe(1);
    expect(record.outcome).toBe('done');
    expect(record.errors[0]).toContain('still reports not-ready after loading');
    expect(h.inserter.inserted).toEqual(['hello world']);
  });

  test('…and when the member really is missing, the ENGINE says why, not the guard', async () => {
    const h = harness();
    h.unified.ready = false;
    h.unified.prepareLeavesCold = true;
    h.unified.transcribeError = new Error('no Russian weights at models/unified-ru.bin');
    await h.session.arm();
    const record = await h.finish();

    expect(record.outcome).toBe('failed');
    // The engine's own words, which is the whole gain: a missing file, a bad checksum
    // and a revoked permission must not all read as "not ready, and gave no reason".
    expect(record.errors.join(' ')).toContain('no Russian weights');
    expect(h.inserter.inserted).toEqual([]);
  });

  test('no engine at all for the routed family is a loud failure, never a substitution', async () => {
    const clock = new ManualClock();
    const ports = fakePorts({ clock });
    const inserter = new FakeInserter();
    const session = createDictationSession({
      audio: new FakeAudio(clock),
      router: ports.createRouter({ classifier: null, threshold: 0.05, fallbackLanguage: 'uz' }),
      engineFor: () => null,
      insert: (t) => inserter.insert(t),
      replace: (p, t) => inserter.replace(p, t),
      normalise: (t) => t,
      routing: ports.routing,
      text: ports.text,
      config: DEFAULT_SESSION_CONFIG,
      clock,
    });
    await session.arm();
    const record = await session.finish({
      pin: null,
      polisher: null,
      polishInstructions: null,
      polishGuard: DEFAULT_POLISH_GUARD,
      insertAfterPolish: false,
    });
    expect(record.errors[0]).toBe('no engine registered for uzbek');
    expect(inserter.inserted).toEqual([]);
    if (session.state.kind !== 'failed') throw new Error('unreachable');
    expect(session.state.error.message).toContain('No Uzbek model could be loaded');
  });
});

// ---------------------------------------------------------------------------------
// THE ARM/FINISH RACE
// ---------------------------------------------------------------------------------

suite('the arm/finish race', () => {
  test('a key-up that outruns arming WAITS, and the audio is not abandoned', async () => {
    const h = harness();
    h.audio.startDelayMs = 300;

    const armed = h.session.arm();
    await flush();
    expect(h.session.state.kind).toBe('arming');

    // Key-up lands mid-arming. It must park, not return.
    let finished = false;
    const finishing = h.finish().then((r) => {
      finished = true;
      return r;
    });
    await flush();
    expect(finished).toBe(false);

    await h.clock.advance(300);
    await armed;
    const record = await finishing;

    expect(finished).toBe(true);
    expect(record.outcome).toBe('done');
    expect(h.inserter.inserted).toEqual(['hello world']);
    // The capture was closed. A leaked capture is what hands audio to the NEXT dictation.
    expect(h.audio.capturing).toBe(false);
    expect(h.audio.starts).toBe(1);
    expect(h.audio.stops).toBe(1);
  });

  test('the waiter list is drained on the FAILURE path of arming too', async () => {
    const h = harness();
    h.audio.startDelayMs = 200;
    h.audio.startError = new Error('permissionDenied');

    const armed = h.session.arm();
    await flush();
    const finishing = h.finish();
    await flush();

    await h.clock.advance(200);
    await armed;
    // Without the drain on the failure path this never settles and the next press finds
    // a session that never became idle.
    const record = await finishing;

    expect(h.session.state.kind).toBe('failed');
    expect(record.outcome).toBe('failed');
    expect(record.errors[0]).toBe('permissionDenied');
  });

  test('the abandoned audio is never handed to the next dictation', async () => {
    const h = harness();
    h.audio.startDelayMs = 150;

    const first = h.session.arm();
    await flush();
    const firstFinish = h.finish();
    await h.clock.advance(150);
    await first;
    await firstFinish;

    h.audio.startDelayMs = 0;
    h.unified.text = 'the second utterance';
    await h.session.arm();
    await h.finish();

    expect(h.inserter.inserted).toEqual(['hello world', 'the second utterance']);
  });

  test('arming twice before a key-up is a stuck modifier, not a new utterance', async () => {
    const h = harness();
    await h.session.arm();
    await h.session.arm();
    expect(h.audio.starts).toBe(1);
  });

  test('a finish with no arm returns a record rather than throwing', async () => {
    const h = harness();
    const record = await h.finish();
    expect(record.outcome).toBe('incomplete');
    expect(h.inserter.inserted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------
// THE ORDERING RULE
// ---------------------------------------------------------------------------------

suite('insert before polish', () => {
  const polishing = (polisher: FakePolisher): Partial<FinishOptions> => ({
    polisher,
    polishInstructions: 'SUPER PROMPT',
  });

  test('the RAW transcript is inserted first and the polish REPLACES it', async () => {
    const h = harness();
    const polisher = new FakePolisher('groq:llama-3.3-70b', undefined, h.clock);
    polisher.output = 'Hello world.';

    await h.session.arm();
    const record = await h.finish(polishing(polisher));

    expect(h.inserter.inserted).toEqual(['hello world']);
    expect(h.inserter.replaced).toEqual([{ previous: 'hello world', text: 'Hello world.' }]);
    expect(record.polished).toBe('Hello world.');
    expect(record.result).toBe('hello world');
  });

  test('the polished text is NEVER re-normalised or re-capitalised', async () => {
    const h = harness({ normalise: (text) => text.toUpperCase() });
    const polisher = new FakePolisher('p', undefined, h.clock);
    polisher.output = 'polished, in lower case';

    await h.session.arm();
    await h.finish(polishing(polisher));

    // One normalise call — the raw transcript. The polish went in verbatim.
    expect(h.normaliseCalls).toHaveLength(1);
    expect(h.inserter.replaced[0]!.text).toBe('polished, in lower case');
  });

  test('the replace is handed EXACTLY what was inserted', async () => {
    // The Inserter selects back over `previous` and retypes; handing it anything but the
    // literal inserted string eats whatever the user typed in between.
    const h = harness({ normalise: () => 'oʻzbek matni 🇺🇿' });
    const polisher = new FakePolisher('p', undefined, h.clock);
    polisher.output = 'Oʻzbek matni. 🇺🇿';

    await h.session.arm();
    await h.finish(polishing(polisher));

    expect(h.inserter.inserted).toEqual(['oʻzbek matni 🇺🇿']);
    expect(h.inserter.replaced[0]!.previous).toBe(h.inserter.inserted[0]);
  });

  test('a refused replace leaves the raw transcript standing and is NOT a failure', async () => {
    const h = harness();
    h.inserter.replaceOutcome = { kind: 'refused', reason: 'this app does not expose its text field to Kotiba' };
    const polisher = new FakePolisher('p', undefined, h.clock);

    await h.session.arm();
    const record = await h.finish(polishing(polisher));

    expect(record.outcome).toBe('done');
    expect(record.polished).toBeUndefined();
    expect(record.errors).toContain('polish replace refused; raw transcript stands');
  });

  test('a no-op polish is not an error and does not touch the app again', async () => {
    const h = harness();
    const polisher = new FakePolisher('p', undefined, h.clock);
    polisher.output = 'hello world';

    await h.session.arm();
    const record = await h.finish(polishing(polisher));

    expect(h.inserter.replaced).toEqual([]);
    expect(record.errors).toEqual([]);
    expect(record.outcome).toBe('done');
  });

  test('a restructuring mode WAITS and inserts once', async () => {
    const h = harness();
    const polisher = new FakePolisher('p', undefined, h.clock);
    polisher.output = '- one\n- two';

    await h.session.arm();
    const record = await h.finish({ ...polishing(polisher), insertAfterPolish: true });

    expect(h.inserter.inserted).toEqual(['- one\n- two']);
    expect(h.inserter.replaced).toEqual([]);
    expect(record.polished).toBe('- one\n- two');
  });

  test('a restructuring mode whose polish is rejected still inserts the raw transcript', async () => {
    const h = harness({
      ports: { guardRejection: { kind: 'truncated', ratio: 0.2, reason: 'polish deleted content (length ratio 0.20)' } },
    });
    const polisher = new FakePolisher('p', undefined, h.clock);

    await h.session.arm();
    const record = await h.finish({ ...polishing(polisher), insertAfterPolish: true });

    expect(h.inserter.inserted).toEqual(['hello world']);
    expect(record.outcome).toBe('done');
    expect(record.polished).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------
// POLISH FAILS OPEN
// ---------------------------------------------------------------------------------

suite('polish fails open', () => {
  test('a polisher that does not CLAIM the language is skipped, with no extra control flow', async () => {
    const h = harness({ route: { language: 'uz', family: 'uzbek', source: 'pin', turkicMass: null } });
    // `polishUzbek: false` is implemented entirely by removing `uz` from this set.
    const polisher = new FakePolisher('p', new Set<Language>(['en', 'ru']), h.clock);

    await h.session.arm();
    const record = await h.finish({ polisher, polishInstructions: 'PROMPT' });

    expect(polisher.calls).toBe(0);
    expect(record.polished).toBeUndefined();
    expect(record.outcome).toBe('done');
  });

  test('no instructions means no polish, which is the credential gate one layer down', async () => {
    const h = harness();
    const polisher = new FakePolisher('p', undefined, h.clock);
    await h.session.arm();
    await h.finish({ polisher, polishInstructions: null });
    expect(polisher.calls).toBe(0);
  });

  test('a polish that FAILS keeps the raw transcript and records the real error', async () => {
    const h = harness();
    const polisher = new FakePolisher('groq:llama-3.3-70b', undefined, h.clock);
    polisher.error = new Error('401 invalid_api_key');

    await h.session.arm();
    const record = await h.finish({ polisher, polishInstructions: 'PROMPT' });

    expect(record.outcome).toBe('done');
    expect(record.polished).toBeUndefined();
    expect(record.errors).toContain(
      'polish groq:llama-3.3-70b failed: 401 invalid_api_key; raw transcript stands',
    );
    // A failure and a timeout are DIFFERENT records. Collapsing them destroyed the
    // diagnosis: a 40 ms bad-key failure was reported as "polish exceeded 8 seconds".
    expect(record.errors.join(' ')).not.toContain('exceeded');
  });

  test('a polish that OVERRUNS its deadline returns at the deadline', async () => {
    const h = harness({ config: { polishDeadlineMs: 8000 } });
    const polisher = new FakePolisher('p', undefined, h.clock);
    polisher.delayMs = 30_000;

    await h.session.arm();
    const finishing = h.finish({ polisher, polishInstructions: 'PROMPT' });
    await flush();
    await h.clock.advance(8000);
    const record = await finishing;

    expect(record.outcome).toBe('done');
    expect(record.errors).toContain('polish exceeded 8 s; raw transcript stands');
    expect(h.inserter.inserted).toEqual(['hello world']);
  });

  test('a polish that REJECTS after its deadline is abandoned, not unhandled', async () => {
    // The loser of the race keeps running. Without swallowing its settlement this is an
    // unhandled rejection, which in the Electron main process is fatal — and it happens
    // on the commonest failure there is: a slow endpoint that eventually 500s.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const h = harness({ config: { polishDeadlineMs: 8000 } });
      const polisher = new FakePolisher('p', undefined, h.clock);
      polisher.delayMs = 12_000;
      polisher.error = new Error('502 upstream');

      await h.session.arm();
      const finishing = h.finish({ polisher, polishInstructions: 'PROMPT' });
      await flush();
      await h.clock.advance(8000);
      const record = await finishing;
      expect(record.errors).toContain('polish exceeded 8 s; raw transcript stands');

      // Now let the abandoned polish reject.
      await h.clock.advance(10_000);
      await flush();

      expect(rejections).toEqual([]);
      // And it changed nothing: the record was settled at the deadline.
      expect(record.polished).toBeUndefined();
      expect(h.inserter.replaced).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('ten dictations whose polish times out every time still all complete', async () => {
    const h = harness({ config: { polishDeadlineMs: 1000 } });
    const polisher = new FakePolisher('p', undefined, h.clock);
    polisher.delayMs = 60_000;

    for (let i = 0; i < 10; i += 1) {
      h.unified.text = `utterance ${i}`;
      await h.session.arm();
      const finishing = h.finish({ polisher, polishInstructions: 'PROMPT' });
      await flush();
      await h.clock.advance(1000);
      const record = await finishing;
      expect(record.outcome).toBe('done');
    }
    expect(h.inserter.inserted).toHaveLength(10);
  });

  test('the chain drains its remarks whatever the outcome', async () => {
    const h = harness();
    const polisher = new FakePolisher('p', undefined, h.clock);
    polisher.error = new Error('nope');

    await h.session.arm();
    const record = await h.finish({
      polisher,
      polishInstructions: 'PROMPT',
      drainPolishNotes: async () => ['on-device declined; fell back to the cloud model'],
    });

    expect(record.errors).toContain('on-device declined; fell back to the cloud model');
  });
});

// ---------------------------------------------------------------------------------
// THE TWO GUARDS
// ---------------------------------------------------------------------------------

suite('the two polish guards', () => {
  test('the UZBEK guard rejects an invented word before the general one is consulted', async () => {
    const h = harness({
      ports: {
        uzbekRejection: {
          kind: 'inventedWords',
          words: ['keçşurun'],
          reason:
            'the polish introduced 1 word the speaker did not say (keçşurun) — Uzbek transcript kept as spoken',
        },
      },
      // The general guard ACCEPTS this polish; only the Uzbek one sees the problem.
      route: { language: 'uz', family: 'uzbek', source: 'pin', turkicMass: null },
    });
    const polisher = new FakePolisher('p', undefined, h.clock);

    await h.session.arm();
    const record = await h.finish({ polisher, polishInstructions: 'PROMPT' });

    expect(record.polished).toBeUndefined();
    expect(h.inserter.replaced).toEqual([]);
    expect(record.errors.at(-1)).toContain('the speaker did not say (keçşurun)');
    // The Uzbek rejection sentence stands ALONE — it is not suffixed the way the general
    // one is, and diagnostics tooling greps for both.
    expect(record.errors.at(-1)).not.toContain('raw transcript stands');
  });

  test('the general guard rejects and says so, with the suffix', async () => {
    const h = harness({
      ports: {
        guardRejection: {
          kind: 'scriptChanged',
          from: 'latin',
          to: 'cyrillic',
          reason: 'polish changed the script from latin to cyrillic',
        },
      },
    });
    const polisher = new FakePolisher('p', undefined, h.clock);

    await h.session.arm();
    const record = await h.finish({ polisher, polishInstructions: 'PROMPT' });

    expect(record.polished).toBeUndefined();
    expect(record.errors).toContain(
      'polish changed the script from latin to cyrillic; raw transcript stands',
    );
  });

  test('the Uzbek guard is NOT applied to a non-Uzbek route', async () => {
    const h = harness({
      ports: {
        uzbekRejection: { kind: 'inventedWords', words: ['x'], reason: 'invented' },
      },
    });
    const polisher = new FakePolisher('p', undefined, h.clock);
    polisher.output = 'Hello world.';

    await h.session.arm();
    const record = await h.finish({ polisher, polishInstructions: 'PROMPT' });

    expect(record.polished).toBe('Hello world.');
  });

  test('a refusal is not an error state — the dictation is still done', async () => {
    const h = harness({
      ports: { guardRejection: { kind: 'inflated', ratio: 4.1, reason: 'polish ran away (length ratio 4.10)' } },
    });
    const polisher = new FakePolisher('p', undefined, h.clock);
    await h.session.arm();
    const record = await h.finish({ polisher, polishInstructions: 'PROMPT' });
    expect(record.outcome).toBe('done');
    expect(h.session.state.kind).toBe('done');
  });
});

// ---------------------------------------------------------------------------------
// STEP 4b — the mis-route recovery
// ---------------------------------------------------------------------------------

suite('the script-check reroute', () => {
  const suspect = { kind: 'suspect', observed: 'cyrillic', suggests: 'uz' } as const;
  const acousticRu: RouteDecision = {
    language: 'ru',
    family: 'unified',
    source: 'acoustic',
    turkicMass: 0.012,
  };

  test('re-transcribes on Uzbek, carries the ORIGINAL acoustic mass, and says so', async () => {
    const h = harness({ ports: { verdict: suspect }, route: acousticRu });
    h.uzbek.text = 'salom dunyo';

    await h.session.arm();
    const record = await h.finish();

    expect(h.uzbek.transcribeCalls).toBe(1);
    expect(record.route).toEqual({
      language: 'uz',
      family: 'uzbek',
      source: 'scriptCheck',
      turkicMass: 0.012,
    });
    expect(record.raw).toBe('salom dunyo');
    expect(h.inserter.inserted).toEqual(['salom dunyo']);
    expect(record.errors[0]).toContain('route said ru and unified-v3-turbo answered in Cyrillic');
    expect(record.errors).toContain('Transcribed again on the Uzbek engine.');
    expect(record.stageMillis.rerouting).toBeDefined();
  });

  test('A PIN IS NEVER OVERRULED — the note is written and the transcript stands', async () => {
    const h = harness({
      ports: { verdict: suspect },
      route: { language: 'ru', family: 'unified', source: 'pin', turkicMass: null },
    });

    await h.session.arm();
    const record = await h.finish({ pin: 'ru' });

    expect(h.uzbek.transcribeCalls).toBe(0);
    expect(record.raw).toBe('hello world');
    // Said UNCONDITIONALLY, before anything is attempted.
    expect(record.errors[0]).toContain('answered in Cyrillic that is not Russian');
    expect(record.errors[1]).toContain('the language was pinned');
  });

  test('it only ever moves TOWARD Uzbek — a route already on Uzbek is left alone', async () => {
    const h = harness({
      ports: { verdict: suspect },
      route: { language: 'uz', family: 'uzbek', source: 'acoustic', turkicMass: 0.9 },
    });
    await h.session.arm();
    const record = await h.finish();
    expect(record.errors).toEqual([]);
    expect(record.route?.source).toBe('acoustic');
  });

  test('an UNUSABLE rerun is discarded and the first transcript stands', async () => {
    const h = harness({ ports: { verdict: suspect, usableRerun: false }, route: acousticRu });
    h.uzbek.text = 'ha ha ha ha ha ha';

    await h.session.arm();
    const record = await h.finish();

    expect(record.raw).toBe('hello world');
    expect(record.route?.source).toBe('acoustic');
    expect(record.errors.at(-1)).toContain("the Uzbek engine's second answer was not usable");
    expect(record.errors.at(-1)).toContain('the first transcript stands');
  });

  test('the rerun is BOUNDED, and on the deadline the first transcript stands', async () => {
    const h = harness({
      ports: { verdict: suspect },
      route: acousticRu,
      config: { rerouteDeadlineMs: 10_000 },
    });
    h.uzbek.delayMs = 60_000;

    await h.session.arm();
    const finishing = h.finish();
    await flush();
    await h.clock.advance(10_000);
    const record = await finishing;

    expect(record.raw).toBe('hello world');
    expect(record.errors.at(-1)).toBe(
      'the Uzbek engine did not answer within 10 s — the first transcript stands.',
    );
    // …and the abandoned decode is ABORTED, not left occupying the one-at-a-time whisper
    // host that the next Uzbek dictation needs.
    expect(h.uzbek.lastSignal?.aborted).toBe(true);
  });

  test('a rerun that THROWS is recorded as a refusal, not as a timeout', async () => {
    const h = harness({ ports: { verdict: suspect }, route: acousticRu });
    h.uzbek.transcribeError = new Error('the speech engine stopped responding');

    await h.session.arm();
    const record = await h.finish();

    expect(record.errors.at(-1)).toContain('the Uzbek engine refused the second pass');
    expect(record.errors.at(-1)).toContain('stopped responding');
    expect(record.raw).toBe('hello world');
  });

  test('a COLD Uzbek engine is not paged in on the reroute path — it is reported', async () => {
    const h = harness({ ports: { verdict: suspect }, route: acousticRu });
    h.uzbek.ready = false;

    await h.session.arm();
    const record = await h.finish();

    // A cold 539 MB load would consume the whole deadline and the first transcript
    // would stand anyway, having cost ten seconds.
    expect(h.uzbek.prepareCalls).toBe(0);
    expect(h.uzbek.transcribeCalls).toBe(0);
    expect(record.errors.at(-1)).toContain('the Uzbek engine is not loaded');
  });
});

// ---------------------------------------------------------------------------------
// STEP 4a′ — the transcript check
// ---------------------------------------------------------------------------------
//
// The routing port here is the REAL `transcriptDoubt`/`readsAsEnglish` (fakes.ts), so these
// texts are judged by the golden-pinned rule, not by a canned answer. The texts are made up
// or taken from transcript-check.json's own rows.

suite('the transcript check (step 4a′)', () => {
  const acousticEn: RouteDecision = {
    language: 'en',
    family: 'unified',
    source: 'acoustic',
    turkicMass: 0.03,
  };
  /** What the unified engine writes for Uzbek audio: Latin, and almost no English words. */
  const notEnglish = 'Morvalen tikoshar penduvi askarel dunemba.';
  const uzbekAnswer = 'bugun bozorga bordim va non oldim.';

  test('un-English unified text: the Uzbek answer replaces it, route uz/transcriptCheck', async () => {
    const h = harness({ route: acousticEn });
    h.unified.text = notEnglish;
    h.uzbek.text = uzbekAnswer;

    await h.session.arm();
    const record = await h.finish();

    expect(h.unified.transcribeCalls).toBe(1);
    expect(h.uzbek.transcribeCalls).toBe(1);
    expect(record.route).toEqual({
      language: 'uz',
      family: 'uzbek',
      source: 'transcriptCheck',
      // The ORIGINAL acoustic mass, so the record still says what the acoustic pass thought.
      turkicMass: 0.03,
    });
    expect(record.unifiedDoubt).toBe('notEnglish');
    expect(record.raw).toBe(uzbekAnswer);
    expect(record.engineID).toBe('whisper-ggml-uzbek-stt-v1-q5_0');
    expect(h.inserter.inserted).toEqual([uzbekAnswer]);
    // Normalised as Uzbek, not as the language the acoustic pass guessed.
    expect(h.normaliseCalls.at(-1)?.language).toBe('uz');
    expect(record.errors).toEqual([
      "route said en, but unified-v3-turbo's transcript was not English (notEnglish); the " +
        "Uzbek engine's answer stands.",
    ]);
    expect(record.stageMillis.rerouting).toBeDefined();
  });

  test('an Uzbek answer that reads as English: the first transcript stands, the doubt is kept', async () => {
    const h = harness({ route: acousticEn });
    h.unified.text = notEnglish;
    h.uzbek.text = 'Please send the report to the team before lunch.';

    await h.session.arm();
    const record = await h.finish();

    expect(h.uzbek.transcribeCalls).toBe(1);
    expect(record.raw).toBe(notEnglish);
    expect(record.route).toEqual(acousticEn);
    // Written whatever came of it — the rule's firing rate belongs in the diagnostics.
    expect(record.unifiedDoubt).toBe('notEnglish');
    expect(record.errors.at(-1)).toContain('read as English or was unusable');
    expect(record.errors.at(-1)).toContain('the first transcript stands');
  });

  test('an UNUSABLE Uzbek answer is discarded and the first transcript stands', async () => {
    const h = harness({ route: acousticEn, ports: { usableRerun: false } });
    h.unified.text = notEnglish;
    h.uzbek.text = '[BLANK_AUDIO]';

    await h.session.arm();
    const record = await h.finish();

    expect(record.raw).toBe(notEnglish);
    expect(record.route?.source).toBe('acoustic');
    expect(record.unifiedDoubt).toBe('notEnglish');
  });

  test('English unified text: the Uzbek engine is never asked and nothing is recorded', async () => {
    const h = harness({ route: acousticEn });
    h.unified.text = 'I think we should move the meeting to Thursday.';

    await h.session.arm();
    const record = await h.finish();

    expect(h.uzbek.transcribeCalls).toBe(0);
    expect(record.route).toEqual(acousticEn);
    expect('unifiedDoubt' in record).toBe(false);
    expect(record.errors).toEqual([]);
    expect(record.stageMillis.rerouting).toBeUndefined();
  });

  test('Russian (Cyrillic) unified text is not judged', async () => {
    const h = harness({ route: { ...acousticEn, language: 'ru' } });
    h.unified.text = 'Привет, как дела?';

    await h.session.arm();
    const record = await h.finish();

    expect(h.uzbek.transcribeCalls).toBe(0);
    expect('unifiedDoubt' in record).toBe(false);
  });

  test('A PIN IS NEVER CHECKED — not even to record a doubt', async () => {
    const h = harness({ route: { language: 'en', family: 'unified', source: 'pin', turkicMass: null } });
    h.unified.text = notEnglish;

    await h.session.arm();
    const record = await h.finish({ pin: 'en' });

    expect(h.uzbek.transcribeCalls).toBe(0);
    expect(record.raw).toBe(notEnglish);
    expect(record.route?.source).toBe('pin');
    expect('unifiedDoubt' in record).toBe(false);
  });

  test('a COLD Uzbek engine is not paged in: the first transcript stands, the doubt is kept', async () => {
    const h = harness({ route: acousticEn });
    h.unified.text = notEnglish;
    h.uzbek.ready = false;

    await h.session.arm();
    const record = await h.finish();

    expect(h.uzbek.prepareCalls).toBe(0);
    expect(h.uzbek.transcribeCalls).toBe(0);
    expect(record.raw).toBe(notEnglish);
    expect(record.route).toEqual(acousticEn);
    expect(record.unifiedDoubt).toBe('notEnglish');
    expect(record.outcome).toBe('done');
  });

  test('NO Uzbek engine at all: the first transcript stands, the doubt is kept', async () => {
    const h = harness({ route: acousticEn, uzbekAbsent: true });
    h.unified.text = notEnglish;

    await h.session.arm();
    const record = await h.finish();

    expect(record.raw).toBe(notEnglish);
    expect(record.route).toEqual(acousticEn);
    expect(record.unifiedDoubt).toBe('notEnglish');
    expect(record.outcome).toBe('done');
  });

  test('no words at all after speech is a doubt too — and the Uzbek answer is used', async () => {
    const h = harness({ route: acousticEn });
    h.unified.text = '';
    h.uzbek.text = uzbekAnswer;

    await h.session.arm();
    const record = await h.finish();

    expect(record.unifiedDoubt).toBe('noWords');
    expect(record.route?.source).toBe('transcriptCheck');
    expect(record.raw).toBe(uzbekAnswer);
    expect(record.outcome).toBe('done');
  });

  test('…but a bare number is a transcript, not an absence of one', async () => {
    const h = harness({ route: acousticEn });
    h.unified.text = '25';

    await h.session.arm();
    const record = await h.finish();

    expect(h.uzbek.transcribeCalls).toBe(0);
    expect('unifiedDoubt' in record).toBe(false);
  });

  test('the second opinion is BOUNDED, and on the deadline the first transcript stands', async () => {
    const h = harness({ route: acousticEn, config: { rerouteDeadlineMs: 10_000 } });
    h.unified.text = notEnglish;
    h.uzbek.delayMs = 60_000;

    await h.session.arm();
    const finishing = h.finish();
    await flush();
    await h.clock.advance(10_000);
    const record = await finishing;

    expect(record.raw).toBe(notEnglish);
    expect(record.unifiedDoubt).toBe('notEnglish');
    expect(record.errors.at(-1)).toBe(
      'the Uzbek engine did not answer within 10 s — the first transcript stands.',
    );
    // …and the abandoned decode is ABORTED, not left occupying the one-at-a-time whisper
    // host that the next Uzbek dictation needs.
    expect(h.uzbek.lastSignal?.aborted).toBe(true);
  });

  // Core review 2026-09-30, item 12: a fixed 10 s could never finish a second pass over a
  // minute of audio, so the misroute stood every time.
  test('the second opinion’s deadline scales with the recording: 0.5 s per second of audio', async () => {
    const h = harness({ route: acousticEn, config: { rerouteDeadlineMs: 10_000 } });
    h.unified.text = notEnglish;
    h.uzbek.text = uzbekAnswer;
    h.uzbek.delayMs = 25_000;
    // 60 s of speech: a 30 s ceiling.
    const samples = new Float32Array(60 * SAMPLE_RATE);
    for (let i = 0; i < samples.length; i += 1) samples[i] = 0.2 * Math.sin(i / 7);
    h.audio.buffer = { samples, droppedSamples: 0 };

    await h.session.arm();
    const finishing = h.finish();
    await flush();
    await h.clock.advance(25_000);
    const record = await finishing;

    // Answered at 25 s: past the old 10 s ceiling, inside the scaled one.
    expect(record.route?.language).toBe('uz');
    expect(record.raw).toBe(h.uzbek.text);
    expect(record.errors.some((error) => error.includes('did not answer within'))).toBe(false);
  });

  test('a second opinion that THROWS is a refusal, and the first transcript stands', async () => {
    const h = harness({ route: acousticEn });
    h.unified.text = notEnglish;
    h.uzbek.transcribeError = new Error('the speech engine stopped responding');

    await h.session.arm();
    const record = await h.finish();

    expect(record.raw).toBe(notEnglish);
    expect(record.errors.at(-1)).toContain('the Uzbek engine refused the second opinion');
    expect(record.errors.at(-1)).toContain('stopped responding');
  });

  test('step 4b never moves a transcriptCheck route: it only ever moves toward Uzbek', async () => {
    const h = harness({
      route: acousticEn,
      ports: { verdict: { kind: 'suspect', observed: 'latin', suggests: 'uz' } },
    });
    h.unified.text = notEnglish;
    h.uzbek.text = uzbekAnswer;

    await h.session.arm();
    const record = await h.finish();

    expect(h.uzbek.transcribeCalls).toBe(1);
    expect(record.route?.source).toBe('transcriptCheck');
    expect(record.errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------
// CAPTURE NOTES
// ---------------------------------------------------------------------------------

suite('what the record says about the capture', () => {
  test('dropped samples are said out loud and are never fatal', async () => {
    const h = harness();
    h.audio.buffer = tone(2, 0.4, 8000);
    await h.session.arm();
    const record = await h.finish();

    expect(record.outcome).toBe('done');
    expect(record.errors[0]).toBe(
      'capture dropped 8000 samples (0.5s) — the recording is shorter than what was said, ' +
        'because nothing drained the buffer in time',
    );
  });

  test('clipping and merely-hot are told apart by the SATURATED FRACTION', async () => {
    // Every sample at the rail: 100% flat, which is measured to cost about 1.5 points.
    const flattened = harness();
    flattened.audio.buffer = tone(1, 1.0);
    await flattened.session.arm();
    const clipped = await flattened.finish();
    expect(clipped.errors[0]).toContain('input is clipping');
    expect(clipped.errors[0]).toContain('100.0% of samples are flat');

    // A peak above full scale with almost nothing at the rail is the resampler's own
    // overshoot, and was measured to cost nothing.
    const hot = harness();
    const samples = new Float32Array(1000).fill(0.5);
    samples[0] = 1.0;
    hot.audio.buffer = { samples, droppedSamples: 0 };
    await hot.session.arm();
    const record = await hot.finish();
    expect(record.errors[0]).toContain('input is hot');
    expect(record.errors[0]).toContain('0.1% of samples are flat');
  });

  test('an ordinary recording carries no capture notes at all', async () => {
    const h = harness();
    await h.session.arm();
    expect((await h.finish()).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------
// INSERTION
// ---------------------------------------------------------------------------------

suite('insertion', () => {
  test('a refusal is terminal and carries the refusal sentence', async () => {
    const h = harness();
    h.inserter.insertOutcome = { kind: 'refused', reason: 'the clipboard refused the text' };
    await h.session.arm();
    const record = await h.finish();

    expect(h.session.state.kind).toBe('failed');
    expect(record.outcome).toBe('failed');
    expect(record.errors).toContain('insertion refused: the clipboard refused the text');
    if (h.session.state.kind !== 'failed') throw new Error('unreachable');
    expect(h.session.state.error.message).toBe('Could not paste — the clipboard refused the text');
  });

  test('a THROWN insertion is a refusal, not an unhandled rejection', async () => {
    const h = harness();
    h.inserter.insertThrows = new Error('kotiba-input.exe is not running');
    await h.session.arm();
    const record = await h.finish();
    expect(record.outcome).toBe('failed');
    expect(record.errors[0]).toContain('kotiba-input.exe is not running');
  });
});

// ---------------------------------------------------------------------------------
// CANCEL — D-W4
// ---------------------------------------------------------------------------------

suite('cancel', () => {
  test('drops the audio, ends the run, and inserts nothing', async () => {
    const h = harness();
    await h.session.arm();
    await h.session.cancel('a chord during the hold');

    expect(h.audio.capturing).toBe(false);
    expect(h.inserter.inserted).toEqual([]);
    expect(h.session.state.kind).toBe('failed');
  });

  test('a cancel mid-arming releases a parked key-up rather than stranding it', async () => {
    const h = harness();
    h.audio.startDelayMs = 200;
    const armed = h.session.arm();
    await flush();
    const cancelling = h.session.cancel('chord');
    await flush();
    await h.clock.advance(200);
    await armed;
    await cancelling;
    expect(h.inserter.inserted).toEqual([]);
  });

  test('the session is reusable after a cancel', async () => {
    const h = harness();
    await h.session.arm();
    await h.session.cancel('chord');
    await h.session.arm();
    const record = await h.finish();
    expect(record.outcome).toBe('done');
  });
});

// ---------------------------------------------------------------------------------

suite('the session is reusable', () => {
  test('ten consecutive dictations on ONE session all complete', async () => {
    const h = harness();
    for (let i = 0; i < 10; i += 1) {
      h.unified.text = `utterance ${i}`;
      await h.session.arm();
      const record = await h.finish();
      expect(record.outcome).toBe('done');
    }
    expect(h.inserter.inserted).toHaveLength(10);
    expect(h.inserter.inserted[9]).toBe('utterance 9');
  });

  test('arming after a FAILED dictation starts a fresh one', async () => {
    const h = harness();
    h.audio.buffer = NO_AUDIO;
    await h.session.arm();
    expect((await h.finish()).outcome).toBe('failed');

    h.audio.buffer = SPEECH;
    await h.session.arm();
    expect((await h.finish()).outcome).toBe('done');
  });
});
