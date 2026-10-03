// Step 4L in the session — the language decision after transcription (P4, D-14), the Mac's
// `decideLanguage`. The router is the real language-ID router and the real policy; the classifier
// and the engines are fakes, and so is the MODEL: a transparent stand-in — the acoustic score is
// the language's own log-share, each transcript adds 1.5 × log(1 + known) − 1.5 × log(1 + unknown)
// of that language's list — so these cases test what the SESSION does with a decision, and do not
// move when `fit-lid.py` refits the shipped weights (language-id.json pins those).

import { describe as suite, expect, test } from 'vitest';

import { DEFAULT_POLISH_GUARD, DEFAULT_SESSION_CONFIG } from '../../src/contracts/index.js';
import type { AudioBuffer, EngineFamily, Language, LanguagePosterior, TranscriptResult } from '../../src/contracts/index.js';
import { createLanguageIDRouter, languagePolicy, type LanguageModel } from '../../src/core/routing/index.js';
import { createDictationSession } from '../../src/session/index.js';

import { FakeAudio, FakeEngine, FakeInserter, ManualClock, fakePorts } from './fakes.js';

/** Parakeet, which can be held to one script: answers `respelled` when asked to. */
class FakeParakeet extends FakeEngine {
  respelled: string | null = null;
  respellCalls: Language[] = [];

  async transcribeWrittenIn(audio: AudioBuffer, language: Language): Promise<TranscriptResult> {
    this.respellCalls.push(language);
    if (this.respelled === null) return this.transcribe(audio, language);
    return { raw: this.respelled, language, engineId: this.engineId };
  }
}

/** The stand-in model: one-hot acoustic rows, and known-minus-unknown words per list, for every engine. */
const MODEL: LanguageModel = {
  acoustic: [0, 1, 2, 3, 4].map((i) => Array.from({ length: 8 }, (_, k) => (k === i ? 1 : 0))),
  transcript: [0, 1, 2, 3].map(() =>
    [0, 1, 2, 3, 4].map((i) => Array.from({ length: 11 }, (_, k) => (k === 2 * i ? 1.5 : k === 2 * i + 1 ? -1.5 : 0))),
  ),
};

function harness(options: { readonly posterior: LanguagePosterior; readonly enabled?: readonly Language[] }) {
  const clock = new ManualClock();
  const ports = fakePorts({ clock });
  const audio = new FakeAudio(clock);
  // 3 s of speech, so the acoustic evidence's seconds feature is a real one.
  const samples = new Float32Array(3 * 16_000);
  samples.fill(0.2);
  audio.buffer = { samples, droppedSamples: 0 };
  const inserter = new FakeInserter();
  const parakeet = new FakeParakeet('parakeet', new Set<Language>(['en', 'ru']), clock);
  const engines = new Map<EngineFamily, FakeEngine>([
    ['unified', parakeet],
    ['uzbek', new FakeEngine('uzbek', new Set<Language>(['uz']), clock)],
    ['turkish', new FakeEngine('turbo-tr', new Set<Language>(['tr']), clock)],
    ['arabic', new FakeEngine('cohere', new Set<Language>(['ar']), clock)],
  ]);
  const enabled = options.enabled ?? ['en', 'ru', 'uz', 'tr', 'ar'];
  const policy = languagePolicy({ model: MODEL, enabled });
  let classified = 0;
  const session = createDictationSession({
    audio: { start: () => audio.start(), stop: () => audio.stop() },
    router: createLanguageIDRouter({
      classifier: {
        posterior: async () => {
          classified += 1;
          return options.posterior;
        },
      },
      policy,
    }),
    languageID: policy,
    engineFor: (family) => engines.get(family) ?? null,
    insert: (text) => inserter.insert(text),
    replace: (previous, text) => inserter.replace(previous, text),
    normalise: (text) => text,
    routing: ports.routing,
    text: ports.text,
    config: DEFAULT_SESSION_CONFIG,
    clock,
    languages: enabled,
    optionalLanguages: enabled.filter((language) => language === 'tr' || language === 'ar'),
  });
  return {
    session,
    clock,
    engines,
    parakeet,
    inserter,
    classified: () => classified,
    finish: async (pin: Language | null = null) => {
      await session.arm();
      return session.finish({
        pin,
        polisher: null,
        polishInstructions: null,
        polishGuard: DEFAULT_POLISH_GUARD,
        insertAfterPolish: false,
      });
    },
  };
}

const ARABIC = 'يا أيها الناس توبوا إلى الله توبة نصوحا';

suite('step 4L — the language decision after transcription', () => {
  test('the audio leans English, Parakeet writes no known words, the asked Arabic engine writes Arabic: Arabic', async () => {
    const h = harness({ posterior: { en: 0.6, ar: 0.3, _: 0.1 } });
    h.parakeet.text = 'Morvalen tikoshar penduvi.';
    h.engines.get('arabic')!.text = ARABIC;
    const record = await h.finish();
    expect(record.route).toMatchObject({ language: 'ar', family: 'arabic', source: 'languageID' });
    // The acoustic evidence the route started from is carried through the reroute.
    expect(record.route?.acoustic?.logProbabilities).toHaveLength(6);
    expect(record.route?.probabilities?.['ar']).toBeGreaterThan(0.5);
    expect(record.raw).toBe(ARABIC);
    expect(record.engineID).toBe('cohere');
    expect(record.secondOpinion).toBe('ar');
    expect(Object.keys(record.languageAfterTranscript ?? {}).sort()).toEqual(['ar', 'en', 'ru', 'tr', 'uz']);
    expect(record.stageMillis.rerouting).toBeDefined();
    expect(record.errors.some((error) => error.startsWith('route said en; the transcripts of en, ar read as ar'))).toBe(true);
    // Nothing of the old chain ran: no transcript-check doubt, no Uzbek engine asked.
    expect(record.unifiedDoubt).toBeUndefined();
    expect(h.engines.get('uzbek')!.transcribeCalls).toBe(0);
    expect(h.inserter.inserted).toEqual([ARABIC]);
  });

  test('up to three engines: Parakeet and then the Uzbek engine read nothing they know, so Arabic is asked too', async () => {
    const h = harness({ posterior: { en: 0.5, uz: 0.3, ar: 0.15, _: 0.05 } });
    h.parakeet.text = 'Morvalen tikoshar penduvi.';
    h.engines.get('uzbek')!.text = 'Zorvathin kelumbar dastiqo.';
    h.engines.get('arabic')!.text = ARABIC;
    const record = await h.finish();
    expect(h.engines.get('uzbek')!.transcribeCalls).toBe(1);
    expect(h.engines.get('arabic')!.transcribeCalls).toBe(1);
    expect(h.engines.get('turkish')!.transcribeCalls).toBe(0);
    // The first engine asked is what the record names as the second opinion.
    expect(record.secondOpinion).toBe('uz');
    expect(record.route).toMatchObject({ language: 'ar', source: 'languageID' });
    expect(record.raw).toBe(ARABIC);
    expect(record.errors.some((error) => error.startsWith('route said en; the transcripts of en, uz, ar read as ar'))).toBe(true);
  });

  test('an engine that times out is not asked again, and the first transcript stands', async () => {
    const h = harness({ posterior: { en: 0.6, ar: 0.3, _: 0.1 } });
    h.parakeet.text = 'Morvalen tikoshar penduvi.';
    h.engines.get('arabic')!.text = ARABIC;
    h.engines.get('arabic')!.delayMs = 60_000;
    const finishing = h.finish();
    await h.clock.advance(DEFAULT_SESSION_CONFIG.rerouteDeadlineMs + 1);
    const record = await finishing;
    expect(record.route).toMatchObject({ language: 'en', source: 'acoustic' });
    expect(record.raw).toBe('Morvalen tikoshar penduvi.');
    expect(record.errors.some((error) => error.startsWith('the ar engine did not answer within'))).toBe(true);
    expect(h.engines.get('arabic')!.lastSignal?.aborted).toBe(true);
  });

  test('the asked engine’s answer is unusable: the first transcript stands, and the record says why', async () => {
    const h = harness({ posterior: { en: 0.6, ar: 0.3, _: 0.1 } });
    h.parakeet.text = 'Morvalen tikoshar penduvi.';
    h.engines.get('arabic')!.text = '[BLANK_AUDIO]';
    const record = await h.finish();
    expect(record.route).toMatchObject({ language: 'en', source: 'acoustic' });
    expect(record.raw).toBe('Morvalen tikoshar penduvi.');
    expect(record.secondOpinion).toBe('ar');
    expect(record.errors).toContain("the ar engine's opinion was not usable.");
  });

  test('English written in Cyrillic is decoded again, held to Latin', async () => {
    const h = harness({ posterior: { en: 0.97, ru: 0.01, _: 0.02 } });
    h.parakeet.text = 'Инсайд зе контент фоль.';
    h.parakeet.respelled = 'Inside the content folder.';
    const record = await h.finish();
    expect(h.parakeet.respellCalls).toEqual(['en']);
    expect(record.route).toMatchObject({ language: 'en', family: 'unified' });
    expect(record.raw).toBe('Inside the content folder.');
    expect(record.stageMillis.respelling).toBeDefined();
    expect(record.errors).toContain("parakeet wrote en speech in the other script; decoded again in en's.");
    // 4a would have relabelled this Russian from its script; 4L's decision names English.
    expect(record.route?.language).not.toBe('ru');
    expect(record.secondOpinion).toBeUndefined();
  });

  test('a respelling still in the wrong script is not taken', async () => {
    const h = harness({ posterior: { en: 0.97, ru: 0.01, _: 0.02 } });
    h.parakeet.text = 'Инсайд зе контент фоль.';
    h.parakeet.respelled = 'Инсайд зе контент.';
    const record = await h.finish();
    expect(h.parakeet.respellCalls).toEqual(['en']);
    expect(record.raw).toBe('Инсайд зе контент фоль.');
  });

  test('clear Uzbek read as Uzbek: no second opinion, the posterior recorded', async () => {
    const h = harness({ posterior: { uz: 0.92, tr: 0.04, _: 0.04 } });
    h.engines.get('uzbek')!.text = "assalomu alaykum, do'stlar, qalaysizlar, ahvollar yaxshimi?";
    const record = await h.finish();
    expect(record.route).toMatchObject({ language: 'uz', source: 'acoustic' });
    expect(record.secondOpinion).toBeUndefined();
    expect(record.languageAfterTranscript?.['uz']).toBeGreaterThan(0.99);
    expect(h.engines.get('turkish')!.transcribeCalls).toBe(0);
    expect(h.parakeet.transcribeCalls).toBe(0);
  });

  test('a pin is never moved: no classifier, no reading, no second engine, no respelling', async () => {
    const h = harness({ posterior: { en: 0.6, ar: 0.3, _: 0.1 } });
    h.parakeet.text = 'Инсайд зе контент фоль.';
    h.parakeet.respelled = 'Inside the content folder.';
    h.engines.get('arabic')!.text = ARABIC;
    const record = await h.finish('en');
    expect(h.classified()).toBe(0);
    expect(record.route).toMatchObject({ language: 'en', source: 'pin' });
    expect(record.raw).toBe('Инсайд зе контент фоль.');
    expect(record.languageAfterTranscript).toBeUndefined();
    expect(record.secondOpinion).toBeUndefined();
    expect(h.parakeet.respellCalls).toEqual([]);
    expect(h.engines.get('arabic')!.transcribeCalls).toBe(0);
  });

  test('a language that is off is never asked', async () => {
    const h = harness({ posterior: { en: 0.6, ar: 0.3, _: 0.1 }, enabled: ['en', 'ru', 'uz'] });
    h.parakeet.text = 'Morvalen tikoshar penduvi.';
    h.engines.get('arabic')!.text = ARABIC;
    const record = await h.finish();
    expect(h.engines.get('arabic')!.transcribeCalls).toBe(0);
    expect(record.route?.language).not.toBe('ar');
    expect(Object.keys(record.languageAfterTranscript ?? {}).sort()).toEqual(['en', 'ru', 'uz']);
  });
});
