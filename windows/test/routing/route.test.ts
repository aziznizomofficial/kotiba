// route.json — the whole route decision, in the order the session takes it.
//
// Four sections, and each pins a different way this goes wrong:
//
//   decisions  the three tiers. A pin is absolute and carries NO mass; an empty
//              posterior falls back rather than guessing; an ALL-ZERO posterior is not
//              empty and does reach the acoustic tier, where it scores 0.
//   buffers    the near-silence gate. The samples are Float32, so 0.1326 is 0.132599995
//              by the time it is a Double — a port holding samples as JS numbers
//              reproduces 0.1326 and is wrong here and in every peak it ever reports.
//   verdicts   the script check, and what the session is permitted to do about it:
//              never overrule a pin, never move away from Uzbek, always bounded at 10 s.
//   reruns     the plausibility gate on the second answer. Pasting `[BLANK_AUDIO]` or a
//              repetition loop over a correct Russian transcript is worse than the
//              mis-route it was meant to fix.

import { describe, expect, it } from 'vitest';
import type {
  AcousticClassifier,
  AudioBuffer,
  Language,
  LanguagePosterior,
  RouteDecision,
  RouteSource,
} from '../../src/contracts/index.js';
import {
  DEFAULT_TURKIC_THRESHOLD,
  ENGINE_FAMILIES,
  REROUTE_DEADLINE_MS,
  REROUTE_DEADLINE_PER_SECOND,
  rerouteDeadlineMs,
  LANGUAGES,
  ROUTE_SOURCES,
  SAMPLE_RATE,
  audioDuration,
  droppedSeconds,
  engineFamilyFor,
  peakAmplitude,
} from '../../src/contracts/index.js';
import {
  ARABIC_VERIFIED_FROM,
  ARABIC_VERIFIED_FROM_UNFAMILIAR,
  DEFAULT_ARABIC_CANDIDATE_FROM,
  DEFAULT_ARABIC_CANDIDATE_MINIMUM_SECONDS,
  DEFAULT_ARABIC_FROM,
  DEFAULT_TURKISH_CANDIDATE_FROM,
  DEFAULT_TURKISH_MINIMUM_SECONDS,
  TURKISH_HEAD_MARGIN,
  TURKISH_VERIFIED_FROM,
  TURKISH_VERIFIED_FROM_UNFAMILIAR,
} from '../../src/contracts/index.js';
import {
  REPETITION_RUN_LIMIT,
  REROUTE_DEADLINE_SECONDS,
  decideRoute,
  isTurkishVerified,
  isArabicVerified,
  isCandidateVerified,
  isUsableRerun,
  createTieredRouter,
  optionalLanguageRules,
  posteriorShare,
  recoveryPlan,
  rerouteDecision,
  reroutedDecision,
  verifyRoute,
} from '../../src/core/routing/index.js';
import {
  MASS_DECIMALS,
  PROBABILITY_DECIMALS,
  bool,
  decimalLiterals,
  int,
  loadGolden,
  numOrNull,
  object,
  optionalStr,
  posterior,
  rows,
  sameNumber,
  str,
  strOrNull,
} from './golden.js';

const golden = loadGolden('route');
const constants = object(golden, 'constants');

function fixedClassifier(value: LanguagePosterior): AcousticClassifier {
  return { posterior: () => Promise.resolve(value) };
}

/** `RoutingFixtures.buffer(seconds:peak:)` — a constant-amplitude Float32 buffer. */
function buffer(seconds: number, peak: number, dropped = 0): AudioBuffer {
  const samples = new Float32Array(Math.trunc(seconds * SAMPLE_RATE));
  samples.fill(peak);
  return { samples, droppedSamples: dropped };
}

/** Every decision row is routed over this one, exactly as the generator does. */
const ROUTED_OVER = buffer(2.0, 0.1326);

describe('route.json', () => {
  it('is the file this build was written against', () => {
    expect(golden['fixture']).toBe('route');
    expect(golden['massTolerance']).toBe('1e-9');
    expect(rows(golden, 'decisions').length).toBe(golden['decisionCount']);
    expect(rows(golden, 'buffers').length).toBe(golden['bufferCount']);
    expect(rows(golden, 'verdicts').length).toBe(golden['verdictCount']);
    expect(rows(golden, 'reruns').length).toBe(golden['rerunCount']);
    // 154 decisions: the pins now include tr and ar; 870 verdicts: every route language × source.
    expect([154, 67, 870, 13]).toEqual([
      golden['decisionCount'],
      golden['bufferCount'],
      golden['verdictCount'],
      golden['rerunCount'],
    ]);
  });

  it('compares by the generator’s own decimal text, not by a tolerance', () => {
    for (const { literal, digits } of decimalLiterals('route')) {
      expect(Number(literal).toFixed(digits)).toBe(literal);
    }
  });

  it('holds the constants the router and the recovery are built on', () => {
    expect(int(constants, 'sampleRate')).toBe(SAMPLE_RATE);
    expect(str(constants, 'silenceComparison')).toBe('peakAmplitude >= silenceThreshold');
    expect(int(constants, 'rerouteDeadlineSeconds')).toBe(REROUTE_DEADLINE_SECONDS);
    expect(REROUTE_DEADLINE_MS).toBe(REROUTE_DEADLINE_SECONDS * 1000);
    // The ceiling scales with the recording, as on the Mac since the 2026-09-30 review.
    sameNumber(REROUTE_DEADLINE_PER_SECOND, int(constants, 'rerouteDeadlinePerSecondOfAudio'), 6);
    expect(str(constants, 'rerouteDeadlineRule')).toBe(
      'max(rerouteDeadlineSeconds, audioSeconds * rerouteDeadlinePerSecondOfAudio)',
    );
    expect(rerouteDeadlineMs(4)).toBe(10_000);
    expect(rerouteDeadlineMs(20)).toBe(10_000);
    expect(rerouteDeadlineMs(60)).toBe(30_000);
    expect(rerouteDeadlineMs(25.5)).toBe(12_750);
    // The floor a test shortens stays a floor.
    expect(rerouteDeadlineMs(1, 50)).toBe(500);
    expect(int(constants, 'repetitionRunLimit')).toBe(REPETITION_RUN_LIMIT);
    expect(str(constants, 'recoveryDirection')).toBe('uzbek only');
    expect(bool(constants, 'pinIsAbsolute')).toBe(true);
    expect(constants['routeSources']).toEqual([...ROUTE_SOURCES]);
    expect(constants['engineFamilies']).toEqual([...ENGINE_FAMILIES]);
    const families = object(constants, 'familyForLanguage');
    for (const language of LANGUAGES) {
      expect(engineFamilyFor(language)).toBe(str(families, language));
    }
  });
});

// ---------------------------------------------------------------------------------
// decisions — the three tiers
// ---------------------------------------------------------------------------------

describe('route.json → decisions', () => {
  for (const [index, row] of rows(golden, 'decisions').entries()) {
    const name = str(row, 'posteriorName');
    const pin = strOrNull(row, 'pin') as Language | null;
    // The generator runs two loops. The second one — no classifier, and a classifier
    // that answers with an empty map — is the only one that carries a `fallback` key,
    // and it is the only one whose fallback language is not English.
    const fallbackRow = optionalStr(row, 'fallback') as Language | null;
    const label = `[${index}] ${name}${fallbackRow === null ? '' : ` → fallback ${fallbackRow}`}, pin ${String(pin)}`;

    it(label, async () => {
      const p = posterior(row, 'posterior');
      const classifier =
        fallbackRow !== null && name === 'no classifier' ? null : fixedClassifier(p);
      const router = createTieredRouter({
        classifier,
        threshold: int(row, 'threshold'),
        fallbackLanguage: fallbackRow ?? 'en',
      });

      const decision = await router.route(ROUTED_OVER, pin);
      expect(decision.language).toBe(str(row, 'language'));
      expect(decision.family).toBe(str(row, 'family'));
      expect(decision.source).toBe(str(row, 'source'));

      const mass = numOrNull(row, 'turkicMass');
      if (mass === null) {
        expect(decision.turkicMass).toBeNull();
      } else {
        expect(decision.turkicMass).not.toBeNull();
        sameNumber(decision.turkicMass as number, mass, MASS_DECIMALS);
      }
      sameNumber(int(row, 'threshold'), DEFAULT_TURKIC_THRESHOLD, PROBABILITY_DECIMALS);
    });
  }
});

// ---------------------------------------------------------------------------------
// optional — Turkish and Arabic (the Mac's D-11, C4)
// ---------------------------------------------------------------------------------

describe('route.json → optional', () => {
  const optional = object(golden, 'optional');
  const c = object(optional, 'constants');

  it('holds the Mac’s thresholds and the fixture’s counts', () => {
    sameNumber(DEFAULT_ARABIC_FROM, int(c, 'arabicFrom'), PROBABILITY_DECIMALS);
    sameNumber(DEFAULT_TURKISH_CANDIDATE_FROM, int(c, 'turkishCandidateFrom'), PROBABILITY_DECIMALS);
    sameNumber(DEFAULT_TURKISH_MINIMUM_SECONDS, int(c, 'turkishMinimumSeconds'), PROBABILITY_DECIMALS);
    sameNumber(TURKISH_VERIFIED_FROM, int(c, 'turkishVerifiedFrom'), PROBABILITY_DECIMALS);
    sameNumber(TURKISH_VERIFIED_FROM_UNFAMILIAR, int(c, 'turkishVerifiedFromUnfamiliar'), PROBABILITY_DECIMALS);
    expect(int(c, 'turkishHeadMargin')).toBe(TURKISH_HEAD_MARGIN);
    sameNumber(DEFAULT_ARABIC_CANDIDATE_FROM, int(c, 'arabicCandidateFrom'), PROBABILITY_DECIMALS);
    sameNumber(DEFAULT_ARABIC_CANDIDATE_MINIMUM_SECONDS, int(c, 'arabicCandidateMinimumSeconds'), PROBABILITY_DECIMALS);
    sameNumber(ARABIC_VERIFIED_FROM, int(c, 'arabicVerifiedFrom'), PROBABILITY_DECIMALS);
    sameNumber(ARABIC_VERIFIED_FROM_UNFAMILIAR, int(c, 'arabicVerifiedFromUnfamiliar'), PROBABILITY_DECIMALS);
    expect(str(c, 'order')).toBe(
      'pin, then Arabic, then the Turkic cluster (Turkish candidate, else Arabic candidate), then unified (Arabic candidate)',
    );
    expect(rows(optional, 'decisions')).toHaveLength(optional['decisionCount'] as number);
    expect(rows(optional, 'turkishCheck')).toHaveLength(optional['turkishCheckCount'] as number);
  });

  for (const [index, row] of rows(optional, 'decisions').entries()) {
    const enabled = (row['enabled'] as string[]).join('+') || 'none';
    it(`[${index}] ${str(row, 'posteriorName')} — on: ${enabled}, ${int(row, 'seconds')} s`, async () => {
      const rules = optionalLanguageRules(row['enabled'] as Language[]);
      const p = posterior(row, 'posterior');
      const seconds = int(row, 'seconds');
      const decided = decideRoute(p, seconds, DEFAULT_TURKIC_THRESHOLD, rules);
      // And the router, end to end, over a buffer of that length.
      const routed = await createTieredRouter({
        classifier: fixedClassifier(p),
        threshold: DEFAULT_TURKIC_THRESHOLD,
        fallbackLanguage: 'en',
        optional: rules,
      }).route(buffer(seconds, 0.1), null);
      for (const d of [decided, routed]) {
        expect(d.language).toBe(str(row, 'language'));
        expect(d.family).toBe(str(row, 'family'));
        expect(d.source).toBe(str(row, 'source'));
        expect(d.candidate ?? null).toBe(strOrNull(row, 'candidate'));
        for (const key of ['turkicMass', 'turkishShare', 'arabicShare'] as const) {
          const expected = numOrNull(row, key);
          const actual = d[key] ?? null;
          if (expected === null) expect(actual).toBeNull();
          else sameNumber(actual as number, expected, MASS_DECIMALS);
        }
      }
    });
  }

  for (const [index, row] of rows(optional, 'turkishCheck').entries()) {
    it(`TurkishCheck [${index}] ${str(row, 'posteriorName')}`, () => {
      const p = posterior(row, 'posterior');
      sameNumber(posteriorShare('tr', p), int(row, 'turkishShare'), MASS_DECIMALS);
      expect(isTurkishVerified(p, true)).toBe(bool(row, 'isTurkish'));
      expect(isTurkishVerified(p, false)).toBe(bool(row, 'isTurkishUnfamiliar'));
      sameNumber(posteriorShare('ar', p), int(row, 'arabicShare'), MASS_DECIMALS);
      expect(isArabicVerified(p, true)).toBe(bool(row, 'isArabic'));
      expect(isArabicVerified(p, false)).toBe(bool(row, 'isArabicUnfamiliar'));
      expect(isCandidateVerified('ar', p, false)).toBe(bool(row, 'isArabicUnfamiliar'));
      expect(isCandidateVerified('tr', p, true)).toBe(bool(row, 'isTurkish'));
    });
  }

  it('an Arabic reroute records the head’s ar share', () => {
    const first = decideRoute({ ar: 0.4, fr: 0.35, en: 0.25 }, 4, DEFAULT_TURKIC_THRESHOLD, optionalLanguageRules(['ar']));
    expect(first).toMatchObject({ family: 'unified', candidate: 'ar' });
    const settled = reroutedDecision(first, 'ar', 'arabicCheck', null, 0.99);
    expect(settled).toMatchObject({ language: 'ar', family: 'arabic', source: 'arabicCheck', arabicVerified: 0.99 });
    expect(settled.candidate).toBeUndefined();
  });

  it('a reroute keeps what the detector heard, and records the verifier', () => {
    const first = decideRoute({ tr: 0.995, az: 0.003, en: 0.002 }, 12, DEFAULT_TURKIC_THRESHOLD, optionalLanguageRules(['tr']));
    expect(first.candidate).toBe('tr');
    const settled = reroutedDecision(first, 'tr', 'turkishCheck', 0.9946);
    expect(settled).toMatchObject({ language: 'tr', family: 'turkish', source: 'turkishCheck', turkishVerified: 0.9946 });
    expect(settled.turkicMass).toBe(first.turkicMass);
    expect(settled.turkishShare).toBe(first.turkishShare);
    expect(settled.candidate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------
// buffers — the near-silence gate
// ---------------------------------------------------------------------------------

describe('route.json → buffers', () => {
  // Float, not Double: the Swift buffer is `[Float]`, so the gate compares Float32
  // against Float32. Widening either side first changes nothing on this corpus and is
  // wrong the first time a peak lands between the two representations.
  const silenceThreshold = Math.fround(int(constants, 'silenceThreshold'));

  for (const [index, row] of rows(golden, 'buffers').entries()) {
    const seconds = int(row, 'requestedSeconds');
    const peak = int(row, 'peakAmplitude');
    const dropped = row['droppedSamples'] === undefined ? null : int(row, 'droppedSamples');

    it(`[${index}] ${seconds}s at peak ${peak}${dropped === null ? '' : `, ${dropped} dropped`}`, () => {
      // The generator's own peaks, before Float32 truncation. Reconstructed from the
      // emitted value so the test cannot silently drift from the fixture's inputs.
      const requestedPeak = Number(peak.toPrecision(6));
      const b = buffer(seconds, requestedPeak, dropped ?? 0);

      expect(b.samples.length).toBe(int(row, 'sampleCount'));
      sameNumber(audioDuration(b), int(row, 'duration'), MASS_DECIMALS);
      sameNumber(peakAmplitude(b), peak, MASS_DECIMALS);
      expect(peakAmplitude(b) >= silenceThreshold).toBe(bool(row, 'clearsSilenceGate'));

      if (dropped !== null) {
        expect(b.droppedSamples).toBe(dropped);
        sameNumber(droppedSeconds(b), int(row, 'droppedSeconds'), MASS_DECIMALS);
      }
    });
  }
});

// ---------------------------------------------------------------------------------
// verdicts — the script check, and what the session may do about it
// ---------------------------------------------------------------------------------

describe('route.json → verdicts', () => {
  for (const [index, row] of rows(golden, 'verdicts').entries()) {
    const transcript = str(row, 'transcript');
    const language = str(row, 'routeLanguage') as Language;
    const source = str(row, 'routeSource') as RouteSource;
    const mass = numOrNull(row, 'turkicMass');

    it(`[${index}] ${str(row, 'exercises')} — route ${language}/${source}`, () => {
      const decision: RouteDecision = {
        language,
        family: engineFamilyFor(language),
        source,
        turkicMass: mass,
      };
      const verdict = verifyRoute(decision, transcript);

      expect(verdict.kind).toBe(str(row, 'verdict'));
      const observed = strOrNull(row, 'observed');
      const suggests = strOrNull(row, 'suggests');
      if (verdict.kind === 'suspect') {
        expect(verdict.observed).toBe(observed);
        expect(verdict.suggests).toBe(suggests);
      } else {
        expect(observed).toBeNull();
        expect(suggests).toBeNull();
      }

      const plan = recoveryPlan(decision, verdict);
      const expected = object(row, 'recovery');
      expect(plan.attempted).toBe(bool(expected, 'attempted'));
      expect(plan.blockedByPin).toBe(bool(expected, 'blockedByPin'));
      expect(plan.reTranscribesToward).toBe(strOrNull(expected, 'reTranscribesToward'));
      expect(plan.resultingSourceOnSuccess).toBe(strOrNull(expected, 'resultingSourceOnSuccess'));
      expect(plan.deadlineSeconds).toBe(int(expected, 'deadlineSeconds'));

      const carried = numOrNull(expected, 'turkicMassOnSuccess');
      if (carried === null) {
        expect(plan.turkicMassOnSuccess).toBeNull();
      } else {
        expect(plan.turkicMassOnSuccess).not.toBeNull();
        sameNumber(plan.turkicMassOnSuccess as number, carried, MASS_DECIMALS);
      }

      // And the decision the recovery would install, when it is allowed to run. The
      // ORIGINAL acoustic mass is carried through, so the record still says what the
      // acoustic pass thought — a reroute that reports `null` has erased the evidence
      // for the route it replaced.
      if (plan.attempted) {
        const rerouted = rerouteDecision(decision, plan.reTranscribesToward as Language);
        expect(rerouted.language).toBe(str(expected, 'reTranscribesToward'));
        expect(rerouted.family).toBe('uzbek');
        expect(rerouted.source).toBe(str(expected, 'resultingSourceOnSuccess'));
        if (carried === null) {
          expect(rerouted.turkicMass).toBeNull();
        } else {
          sameNumber(rerouted.turkicMass as number, carried, MASS_DECIMALS);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------------
// reruns — the plausibility gate on the second answer
// ---------------------------------------------------------------------------------

describe('route.json → reruns', () => {
  for (const [index, row] of rows(golden, 'reruns').entries()) {
    it(`[${index}] ${str(row, 'exercises')}`, () => {
      expect(isUsableRerun(str(row, 'secondAnswer'))).toBe(bool(row, 'isUsable'));
    });
  }
});
