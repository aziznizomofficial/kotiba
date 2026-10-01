// C2. The segmenter decides where a streaming Uzbek decode may cut — ported from the Mac's
// Band 1 suite (Tests/KotibaCoreTests/SpeechSegmenterTests.swift), same synthetic audio, same
// expectations: a tone for speech, low noise for the room, so every cut point is known to
// the sample.

import { describe as suite, expect, test } from 'vitest';

import {
  DEFAULT_SPEECH_SEGMENTER,
  EnergyFrameClassifier,
  SpeechSegmenter,
  fittedAudioContext,
  joinSegments,
  looksLikeALoop,
  segmentPrompt,
  type SegmentEvent,
  type SpeechFrameClassifier,
  type SpeechSegmenterConfiguration,
  type Span,
} from '../../src/core/stt/speech-segmenter.js';

const rate = 16_000;

/** The Swift's LCG, bit for bit: 64-bit wrapping arithmetic in BigInt. */
function room(seconds: number, seed = 7n): Float32Array {
  const out = new Float32Array(Math.trunc(seconds * rate));
  let state = seed;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < out.length; i += 1) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & mask;
    out[i] = (Number(state >> 40n) / (1 << 24) - 0.5) * 0.002;
  }
  return out;
}

/** Syllables: a 220 Hz tone at about -20 dBFS, 160 ms on and 40 ms off, over the room. */
function voice(seconds: number): Float32Array {
  const bed = room(seconds, 11n);
  for (let i = 0; i < bed.length; i += 1) {
    const inSyllable = i % (rate / 5) < (rate * 4) / 25;
    if (inSyllable) bed[i] = bed[i]! + 0.14 * Math.fround(Math.sin((2 * Math.PI * 220 * i) / rate));
  }
  return bed;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const short: SpeechSegmenterConfiguration = { ...DEFAULT_SPEECH_SEGMENTER, minimumSegment: 3, relaxAfter: 8 };

function run(
  audio: Float32Array,
  chunk = 320,
  configuration: SpeechSegmenterConfiguration = short,
  classifier: SpeechFrameClassifier = new EnergyFrameClassifier(),
): { events: SegmentEvent[]; segmenter: SpeechSegmenter } {
  const segmenter = new SpeechSegmenter(classifier.frameSamples, configuration);
  const events: SegmentEvent[] = [];
  for (let i = 0; i < audio.length; i += chunk) events.push(...segmenter.append(audio.subarray(i, i + chunk), classifier));
  return { events, segmenter };
}

const commits = (events: SegmentEvent[]): Span[] => events.filter((e) => e.kind === 'commit').map((e) => e.span);
const pauses = (events: SegmentEvent[]): Span[] => events.filter((e) => e.kind === 'pause').map((e) => e.span);
const seconds = (sample: number): number => sample / rate;

suite('speech segmenter — where a streaming decode may cut', () => {
  test('a quiet room is never speech, so release costs nothing and nothing is decoded', () => {
    const { events, segmenter } = run(room(10));
    expect(events).toEqual([]);
    expect(segmenter.tail()).toBeNull();
  });

  test('a real pause after enough speech commits it, cut inside the pause', () => {
    const { events, segmenter } = run(concat(room(0.5), voice(4), room(0.8), voice(2)));
    const committed = commits(events);
    expect(committed).toHaveLength(1);
    const span = committed[0]!;
    // Speech ran 0.5–4.46 s (the last 40 ms is a syllable gap); padding is 0.5 s before and
    // `trailingPadding` (0.1 s) after.
    const trailing = DEFAULT_SPEECH_SEGMENTER.trailingPadding;
    expect(Math.abs(seconds(span.speech.lower) - 0.0)).toBeLessThan(0.03);
    expect(Math.abs(seconds(span.speech.upper) - (4.46 + trailing))).toBeLessThan(0.03);
    expect(seconds(span.region.upper)).toBeGreaterThan(4.5);
    expect(seconds(span.region.upper)).toBeLessThan(5.3);
    const tail = segmenter.tail()!;
    expect(tail.region.lower).toBe(span.region.upper);
    expect(Math.abs(seconds(tail.speech.lower) - 4.8)).toBeLessThan(0.03);
  });

  test('a short pause is a speculation, not a commit', () => {
    const { events } = run(concat(voice(4), room(0.3), voice(1)));
    expect(commits(events)).toEqual([]);
    const trailing = DEFAULT_SPEECH_SEGMENTER.trailingPadding;
    expect(Math.abs(seconds(pauses(events)[0]!.speech.upper) - (3.96 + trailing))).toBeLessThan(0.03);
  });

  test('a speculation reported at a pause equals the tail if the speaker says nothing more', () => {
    const { events, segmenter } = run(concat(voice(2), room(0.35)));
    expect(pauses(events).at(-1)!.speech).toEqual(segmenter.tail()!.speech);
  });

  test('with 512-sample (Silero) frames too, a pause span equals the tail it will become', () => {
    const inner = new EnergyFrameClassifier();
    const frames512: SpeechFrameClassifier = {
      frameSamples: 512,
      probabilities(samples) {
        const out: number[] = [];
        for (let i = 0; i + 512 <= samples.length; i += 512) out.push(inner.probabilities(samples.subarray(i, i + 320))[0] ?? 0);
        return out;
      },
      reset: () => inner.reset(),
    };
    const { events, segmenter } = run(concat(voice(2), room(0.6)), 512, short, frames512);
    expect(pauses(events).at(-1)!.speech).toEqual(segmenter.tail()!.speech);
  });

  test('segments shorter than the minimum are not committed, however long the pause', () => {
    expect(commits(run(concat(voice(1), room(1), voice(0.5), room(0.4))).events)).toEqual([]);
  });

  test('speech that never pauses is force-cut before it outgrows one Whisper window', () => {
    const { events, segmenter } = run(voice(40));
    const committed = commits(events);
    expect(committed.length).toBeGreaterThan(0);
    for (const span of committed) expect(seconds(span.region.upper - span.region.lower)).toBeLessThanOrEqual(24.01);
    const tail = segmenter.tail()!;
    expect(committed[0]!.region.lower).toBe(0);
    for (let i = 1; i < committed.length; i += 1) expect(committed[i]!.region.lower).toBe(committed[i - 1]!.region.upper);
    expect(committed.at(-1)!.region.upper).toBe(tail.region.lower);
  });

  test('a long pending region commits at a shorter pause, so the tail stays short', () => {
    expect(commits(run(concat(voice(9), room(0.3), voice(2))).events)).toHaveLength(1);
  });

  test('by default a typical dictation stays whole and a long hold is still cut', () => {
    const typical = concat(...Array.from({ length: 5 }, () => concat(voice(3), room(0.7))));
    const a = run(typical, 320, DEFAULT_SPEECH_SEGMENTER);
    expect(commits(a.events)).toEqual([]);
    expect(a.segmenter.tail()).not.toBeNull();
    const long = concat(...Array.from({ length: 20 }, () => concat(voice(3), room(0.7))));
    const cuts = commits(run(long, 320, DEFAULT_SPEECH_SEGMENTER).events);
    expect(cuts.length).toBeGreaterThanOrEqual(2);
    for (const span of cuts) {
      expect(seconds(span.region.upper - span.region.lower)).toBeGreaterThanOrEqual(20);
      expect(seconds(span.region.upper - span.region.lower)).toBeLessThanOrEqual(24.01);
    }
  });

  test('a click is not a word', () => {
    const { events, segmenter } = run(concat(room(1), voice(0.02), room(1)));
    expect(events).toEqual([]);
    expect(segmenter.tail()).toBeNull();
  });

  test('the decision does not depend on how capture chunks the audio', () => {
    const audio = concat(room(0.4), voice(3.5), room(0.7), voice(2), room(0.3), voice(1));
    const a = run(audio, 1);
    const b = run(audio, 4096);
    const c = run(audio, 160);
    expect(a.events).toEqual(b.events);
    expect(a.events).toEqual(c.events);
    expect(a.segmenter.tail()).toEqual(b.segmenter.tail());
  });

  test('a steady noise that starts loud is absorbed into the floor, not read as speech', () => {
    const hum = new Float32Array(rate * 6).map((_, i) => 0.02 * Math.sin((2 * Math.PI * 50 * i) / rate));
    const { events, segmenter } = run(hum);
    expect(events).toEqual([]);
    expect(segmenter.tail()).toBeNull();
  });

  test('probabilities fed separately (the async Silero path) decide exactly as one call does', () => {
    const audio = concat(room(0.4), voice(3.5), room(0.7), voice(2), room(0.3));
    const direct = run(audio, 1600);
    const classifier = new EnergyFrameClassifier();
    const segmenter = new SpeechSegmenter(320, short);
    const events: SegmentEvent[] = [];
    for (let i = 0; i < audio.length; i += 1600) {
      const chunk = audio.subarray(i, i + 1600);
      segmenter.advance(chunk.length);
      events.push(...segmenter.appendFrames(classifier.probabilities(chunk)));
    }
    expect(events).toEqual(direct.events);
    expect(segmenter.tail()).toEqual(direct.segmenter.tail());
  });
});

suite('segment text — joining, prompting and loop detection', () => {
  test('segments join with one space and empties vanish', () => {
    expect(joinSegments(['salom, ', '', '  qalaysiz?'])).toBe('salom, qalaysiz?');
    expect(joinSegments([])).toBe('');
  });

  test('the hint goes first and the carried text is cut at a word boundary', () => {
    expect(segmentPrompt('Bu yerda.', "birinchi gap. ikkinchi gap juda uzun bo'ldi", 20)).toBe("Bu yerda. gap juda uzun bo'ldi");
    expect(segmentPrompt(null, '', 200)).toBeNull();
    expect(segmentPrompt('Bu.', 'abc', 0)).toBe('Bu.');
  });

  test("a phrase repeated three times is a loop; a real 'ha ha ha' is not", () => {
    expect(looksLikeALoop('men bordim men bordim men bordim', '')).toBe(true);
    expect(looksLikeALoop('rahmat rahmat rahmat rahmat rahmat', '')).toBe(true);
    expect(looksLikeALoop('ha ha ha, tushundim', '')).toBe(false);
    expect(looksLikeALoop('bugun havo juda yaxshi', '')).toBe(false);
  });

  test('a segment that just re-reads the end of its prompt is a loop', () => {
    const previous = "biz ertaga ertalab soat to'qqizda uchrashamiz, keyin ishga boramiz.";
    expect(looksLikeALoop('keyin ishga boramiz, ertalab soat', previous)).toBe(false);
    expect(looksLikeALoop("soat to'qqizda uchrashamiz, keyin ishga", previous)).toBe(true);
    expect(looksLikeALoop('keyin ishga', previous)).toBe(false);
  });
});

suite('the encoder window', () => {
  test('a fitted window is always a multiple of 256 — whisper.cpp does not mask the pad', () => {
    expect(fittedAudioContext(2 * 16_000, 64)).toBe(256);
    expect(fittedAudioContext(10 * 16_000, 64)).toBe(768);
    expect(fittedAudioContext(20 * 16_000, 64)).toBe(1280);
    for (let s = 0.5; s <= 27; s += 0.37) {
      const n = fittedAudioContext(Math.trunc(s * 16_000), 64);
      expect(n === 0 || n % 256 === 0).toBe(true);
    }
  });

  test("past the model's window it falls back to the full one, never beyond it", () => {
    expect(fittedAudioContext(26 * 16_000, 64)).toBe(0);
    // The shipped rule: 256 positions (5.1 s) of margin.
    expect(fittedAudioContext(Math.trunc(2.8 * 16_000))).toBe(512);
    expect(fittedAudioContext(Math.trunc(8.8 * 16_000))).toBe(768);
  });
});
