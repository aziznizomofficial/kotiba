// C4 / the Mac's D-11 in the session: step 3b (a Turkish candidate settled by turbo's language
// head — Turkish on its word, Uzbek otherwise) and step 4b′ (Arabic script from a route that was
// not Arabic, re-transcribed on the Arabic engine when Arabic is on and nothing is pinned).

import { describe as suite, expect, test } from 'vitest';

import { DEFAULT_POLISH_GUARD, DEFAULT_SESSION_CONFIG } from '../../src/contracts/index.js';
import type { AcousticClassifier, EngineFamily, Language, LanguagePosterior, RouteDecision } from '../../src/contracts/index.js';
import { createDictationSession } from '../../src/session/index.js';

import { FakeAudio, FakeEngine, FakeInserter, ManualClock, fakePorts } from './fakes.js';
import type { PortOverrides } from './fakes.js';

function harness(options: {
  readonly route: RouteDecision;
  readonly verifier?: AcousticClassifier | null;
  readonly ports?: PortOverrides;
  readonly enabled?: readonly Language[];
  readonly familiar?: boolean;
}) {
  const clock = new ManualClock();
  const ports = fakePorts({ ...options.ports, clock, route: options.route });
  const audio = new FakeAudio(clock);
  const inserter = new FakeInserter();
  const engines = new Map<EngineFamily, FakeEngine>([
    ['unified', new FakeEngine('unified', new Set<Language>(['en', 'ru']), clock)],
    ['uzbek', new FakeEngine('uzbek', new Set<Language>(['uz']), clock)],
    ['turkish', new FakeEngine('turbo-tr', new Set<Language>(['tr']), clock)],
    ['arabic', new FakeEngine('cohere', new Set<Language>(['ar']), clock)],
  ]);
  engines.get('uzbek')!.text = 'uzbek text';
  engines.get('turkish')!.text = 'Türkçe metin';
  engines.get('arabic')!.text = 'نص عربي';
  const verifierCalls: number[] = [];
  const session = createDictationSession({
    audio: { start: () => audio.start(), stop: () => audio.stop() },
    router: ports.createRouter({ classifier: null, threshold: 0.05, fallbackLanguage: 'en' }),
    engineFor: (family) => engines.get(family) ?? null,
    insert: (text) => inserter.insert(text),
    replace: (previous, text) => inserter.replace(previous, text),
    normalise: (text) => text,
    routing: ports.routing,
    text: ports.text,
    config: DEFAULT_SESSION_CONFIG,
    clock,
    languageHead: () =>
      options.verifier === undefined || options.verifier === null
        ? null
        : {
            posterior: (audio) => {
              verifierCalls.push(audio.samples.length);
              return options.verifier!.posterior(audio);
            },
          },
    optionalLanguages: options.enabled ?? ['tr', 'ar'],
    turkishFamiliar: options.familiar ?? true,
    arabicFamiliar: options.familiar ?? true,
  });
  return {
    session,
    audio,
    engines,
    inserter,
    verifierCalls,
    finish: (pin: Language | null = null) =>
      session.finish({
        pin,
        polisher: null,
        polishInstructions: null,
        polishGuard: DEFAULT_POLISH_GUARD,
        insertAfterPolish: false,
      }),
  };
}

const candidate: RouteDecision = {
  language: 'uz',
  family: 'uzbek',
  source: 'acoustic',
  turkicMass: 0.998,
  turkishShare: 0.995,
  arabicShare: 0,
  candidate: 'tr',
};

const answers = (posterior: LanguagePosterior): AcousticClassifier => ({ posterior: async () => posterior });

suite('step 3b — TurkishCheck', () => {
  test('turbo says Turkish: routed tr/turkishCheck, the share recorded, decoded by the Turkish engine', async () => {
    const h = harness({ route: candidate, verifier: answers({ tr: 0.9946, az: 0.004, en: 0.0014 }) });
    await h.session.arm();
    const record = await h.finish();
    expect(h.verifierCalls).toHaveLength(1);
    expect(record.route).toMatchObject({ language: 'tr', family: 'turkish', source: 'turkishCheck', turkicMass: 0.998 });
    expect(record.route?.turkishVerified).toBeCloseTo(0.9946, 6);
    expect(record.route?.candidate).toBeUndefined();
    expect(record.raw).toBe('Türkçe metin');
    expect(record.turkishCheckWaitMillis).toBeDefined();
  });

  test('the check reads the speech and 0.3 s after it, not the silence the key was held through', async () => {
    const h = harness({ route: candidate, verifier: answers({ tr: 0.9946 }) });
    // 6 s of speech, then 2.4 s of silence before key-up (C4 §13's one clip the fitted head let
    // fall under 0.99 had exactly that).
    const samples = new Float32Array(Math.round(8.4 * 16_000));
    samples.fill(0.2, 0, 6 * 16_000);
    h.audio.buffer = { samples, droppedSamples: 0 };
    await h.session.arm();
    const record = await h.finish();
    expect(h.verifierCalls).toEqual([Math.round(6.3 * 16_000)]);
    expect(record.route?.language).toBe('tr');
  });

  test('a first Turkish dictation needs 0.995; once the user has dictated Turkish, 0.99', async () => {
    const first = harness({ route: candidate, verifier: answers({ tr: 0.993, az: 0.007 }), familiar: false });
    await first.session.arm();
    expect((await first.finish()).route?.language).toBe('uz');
    const later = harness({ route: candidate, verifier: answers({ tr: 0.993, az: 0.007 }), familiar: true });
    await later.session.arm();
    expect((await later.finish()).route?.language).toBe('tr');
  });

  test('turbo says Uzbek: the route stays Uzbek, acoustic, with what turbo said', async () => {
    const h = harness({ route: candidate, verifier: answers({ tr: 0.042, uz: 0.9 }) });
    await h.session.arm();
    const record = await h.finish();
    expect(record.route).toMatchObject({ language: 'uz', source: 'acoustic' });
    expect(record.route?.turkishVerified).toBeCloseTo(0.042 / 0.942, 6);
    expect(record.raw).toBe('uzbek text');
  });

  test('no answer, or no verifier: Uzbek — the owner’s rule for an uncertain one', async () => {
    const silent = harness({ route: candidate, verifier: answers({}) });
    await silent.session.arm();
    const record = await silent.finish();
    expect(record.route?.language).toBe('uz');
    expect(record.errors).toContain('the Turkish check could not answer; routed to Uzbek.');

    const none = harness({ route: candidate, verifier: null });
    await none.session.arm();
    expect((await none.finish()).route?.language).toBe('uz');
  });

  test('a route with no candidate never asks turbo', async () => {
    const h = harness({ route: { ...candidate, candidate: null }, verifier: answers({ tr: 1 }) });
    await h.session.arm();
    await h.finish();
    expect(h.verifierCalls).toEqual([]);
  });
});

suite('step 4b′ — Arabic script from a route that was not Arabic', () => {
  const arabicScript = { verdict: { kind: 'suspect', observed: 'arabic', suggests: 'ar' } as const };
  const english: RouteDecision = { language: 'en', family: 'unified', source: 'acoustic', turkicMass: 0.01 };

  test('Arabic on, unpinned: re-transcribed on the Arabic engine, route ar/scriptCheck', async () => {
    const h = harness({ route: english, ports: arabicScript });
    await h.session.arm();
    const record = await h.finish();
    expect(h.engines.get('arabic')!.transcribeCalls).toBe(1);
    expect(record.route).toMatchObject({ language: 'ar', family: 'arabic', source: 'scriptCheck', turkicMass: 0.01 });
    expect(record.raw).toBe('نص عربي');
    expect(record.errors).toContain('Transcribed again on the Arabic engine.');
  });

  test('Arabic off: nothing is tried', async () => {
    const h = harness({ route: english, ports: arabicScript, enabled: ['tr'] });
    await h.session.arm();
    await h.finish();
    expect(h.engines.get('arabic')!.transcribeCalls).toBe(0);
  });

  test('a pin is never overruled', async () => {
    const h = harness({ route: { ...english, source: 'pin', turkicMass: null }, ports: arabicScript });
    await h.session.arm();
    const record = await h.finish('en');
    expect(h.engines.get('arabic')!.transcribeCalls).toBe(0);
    expect(record.errors).toContain('the language was pinned, so the transcript stands.');
  });
});

const arabicCandidate: RouteDecision = {
  language: 'en',
  family: 'unified',
  source: 'acoustic',
  turkicMass: 0.01,
  turkishShare: 0.01,
  arabicShare: 0.4,
  candidate: 'ar',
};

suite('step 3b — ArabicCheck (C4 §14.1)', () => {
  test('turbo says Arabic: routed ar/arabicCheck from the unified route, decoded by Cohere', async () => {
    const h = harness({ route: arabicCandidate, verifier: answers({ ar: 0.99, en: 0.01 }) });
    await h.session.arm();
    const record = await h.finish();
    expect(h.verifierCalls).toHaveLength(1);
    expect(record.route).toMatchObject({ language: 'ar', family: 'arabic', source: 'arabicCheck' });
    expect(record.route?.arabicVerified).toBeCloseTo(0.99, 6);
    expect(record.raw).toBe('نص عربي');
  });

  test('turbo unsure: the base route stands, with what turbo heard recorded', async () => {
    const h = harness({ route: { ...arabicCandidate, language: 'uz', family: 'uzbek' }, verifier: answers({ ar: 0.97, uz: 0.03 }), familiar: false });
    await h.session.arm();
    const record = await h.finish();
    expect(record.route).toMatchObject({ language: 'uz', source: 'acoustic' });
    expect(record.route?.arabicVerified).toBeCloseTo(0.97, 6);
    // A user who has dictated Arabic before: 0.95 is the bar.
    const familiar = harness({ route: arabicCandidate, verifier: answers({ ar: 0.97, uz: 0.03 }), familiar: true });
    await familiar.session.arm();
    expect((await familiar.finish()).route?.language).toBe('ar');
  });

  test('no head: the base route, said out loud; a pin is never asked', async () => {
    const headless = harness({ route: arabicCandidate, verifier: null });
    await headless.session.arm();
    expect((await headless.finish()).route?.language).toBe('en');
    const pinned = harness({ route: arabicCandidate, verifier: answers({ ar: 1 }) });
    await pinned.session.arm();
    expect((await pinned.finish('en')).route?.language).toBe('en');
    expect(pinned.verifierCalls).toHaveLength(0);
  });
});
