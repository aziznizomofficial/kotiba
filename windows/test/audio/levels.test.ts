// Level, clipping and silence, against generated buffers. No microphone, no Electron.

import { describe, expect, it } from 'vitest';
import {
  CLIPPING_THRESHOLD,
  FLATTENING_FRACTION,
  LevelMeter,
  METER_ATTACK,
  METER_RELEASE,
  SILENCE_THRESHOLD,
  SILENCE_THRESHOLD_RANGE,
  clippingNote,
  isNearSilence,
  measureLevel,
  saturatedFraction,
} from '../../src/audio/index.js';
import { SAMPLE_RATE, peakAmplitude, type AudioBuffer } from '../../src/contracts/index.js';

function buffer(samples: number[] | Float32Array): AudioBuffer {
  return { samples: Float32Array.from(samples), droppedSamples: 0 };
}

/** A tone, so a test buffer looks like audio rather than like a constant. */
function tone(amplitude: number, seconds = 0.1): Float32Array {
  const count = Math.round(seconds * SAMPLE_RATE);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE);
  }
  return samples;
}

describe('the thresholds are the macOS ones', () => {
  // The macOS tests pin ranges rather than values, because the values are tuning and the
  // ranges are what the behaviour depends on. Same here.
  it('clips strictly between 0.9 and 1.0', () => {
    expect(CLIPPING_THRESHOLD).toBeGreaterThan(0.9);
    expect(CLIPPING_THRESHOLD).toBeLessThan(1);
  });

  it('flattens strictly between 0.011 and 0.083', () => {
    expect(FLATTENING_FRACTION).toBeGreaterThan(0.011);
    expect(FLATTENING_FRACTION).toBeLessThan(0.083);
  });

  it('silences at 0.012, inside the range the slider offers', () => {
    expect(SILENCE_THRESHOLD).toBe(0.012);
    expect(SILENCE_THRESHOLD).toBeGreaterThanOrEqual(SILENCE_THRESHOLD_RANGE.min);
    expect(SILENCE_THRESHOLD).toBeLessThanOrEqual(SILENCE_THRESHOLD_RANGE.max);
  });
});

describe('saturatedFraction', () => {
  it('is 0 for an empty buffer, not NaN', () => {
    expect(saturatedFraction(new Float32Array(0))).toBe(0);
  });

  it('counts both rails', () => {
    expect(saturatedFraction(Float32Array.from([1, -1, 0, 0]))).toBe(0.5);
  });

  it('counts 0.999 itself and not 0.998', () => {
    expect(saturatedFraction(Float32Array.from([0.999]))).toBe(1);
    expect(saturatedFraction(Float32Array.from([0.998]))).toBe(0);
  });
});

describe('measureLevel', () => {
  it('records the peak for every dictation, clipped or not', () => {
    expect(measureLevel(buffer(tone(0.147))).peak).toBeCloseTo(0.147, 3);
  });

  it('calls a quiet recording clean', () => {
    // 0.147 is the macOS "this is quiet" case: it succeeds and says nothing.
    const report = measureLevel(buffer(tone(0.147)));
    expect(report.clipping).toBe('clean');
    expect(clippingNote(report)).toBeNull();
  });

  it('calls a hot recording hot, not clipping, when little is flat', () => {
    // The real defect: this app's own resampler overshoots by up to +1.15 dB, so a peak
    // over 1.0 alone means nothing. One sample on the rail out of a thousand is 0.1%.
    const samples = tone(0.5);
    samples[0] = 1.24;
    const report = measureLevel(buffer(samples));
    expect(report.peak).toBeCloseTo(1.24, 5);
    expect(report.saturatedFraction).toBeLessThan(FLATTENING_FRACTION);
    expect(report.clipping).toBe('hot');
    expect(clippingNote(report)).toContain('input is hot');
    expect(clippingNote(report)).toContain('cost nothing');
  });

  it('calls a flattened recording clipping, and says what it costs', () => {
    // 10% of samples on the rail — past the 2% where the WER curve turns.
    const samples = tone(0.5);
    for (let index = 0; index < samples.length; index += 10) samples[index] = 1;
    const report = measureLevel(buffer(samples));
    expect(report.saturatedFraction).toBeCloseTo(0.1, 6);
    expect(report.clipping).toBe('clipping');
    const note = clippingNote(report);
    expect(note).toContain('input is clipping');
    expect(note).toContain('1.5 points of word error');
  });

  it('switches from hot to clipping exactly at 2%', () => {
    const at = (fraction: number): string => {
      const samples = new Float32Array(1000).fill(0.5);
      for (let index = 0; index < Math.round(fraction * 1000); index += 1) samples[index] = 1;
      return measureLevel(buffer(samples)).clipping;
    };
    expect(at(0.019)).toBe('hot');
    expect(at(0.02)).toBe('clipping');
  });

  it('formats the peak and the percentage the way the macOS record does', () => {
    const samples = new Float32Array(1000).fill(1.2);
    const note = clippingNote(measureLevel(buffer(samples)));
    expect(note).toContain('peak 1.20');
    expect(note).toContain('100.0%');
  });

  it('reports the utterance that started all of this', () => {
    // Peak 1.240, most of it flat: the real dictation that flattened into nonsense
    // before the app ever saw it, with nothing in the record to say so.
    const samples = new Float32Array(16_000).fill(1.24);
    const report = measureLevel(buffer(samples));
    expect(report.peak).toBeCloseTo(1.24, 5);
    expect(report.clipping).toBe('clipping');
  });
});

describe('isNearSilence', () => {
  it('is the whole-buffer peak and nothing else', () => {
    // One loud click in a minute of silence defeats it. That is the shipped behaviour:
    // the gate is a peak, not RMS and not per-window energy.
    const samples = new Float32Array(60 * SAMPLE_RATE);
    samples[42] = 0.9;
    expect(isNearSilence(buffer(samples), SILENCE_THRESHOLD)).toBe(false);
  });

  it('calls a quiet room silent', () => {
    expect(isNearSilence(buffer(tone(0.004)), SILENCE_THRESHOLD)).toBe(true);
  });

  it('is exclusive at the threshold, matching the macOS `>=` guard', () => {
    // macOS: `guard peak >= threshold else { heardNothing }`. So exactly 0.012 is heard.
    expect(isNearSilence(buffer([0.012]), 0.012)).toBe(false);
    expect(isNearSilence(buffer([0.0119]), 0.012)).toBe(true);
  });

  it('is true for an empty buffer — which is why the caller must test emptiness first', () => {
    // The peak of an empty buffer is 0, identical to a quiet room. An empty capture is a
    // BROKEN MICROPHONE and must fail before this function is ever consulted.
    const empty = buffer([]);
    expect(peakAmplitude(empty)).toBe(0);
    expect(isNearSilence(empty, SILENCE_THRESHOLD)).toBe(true);
  });

  it('honours a threshold the user moved', () => {
    expect(isNearSilence(buffer([0.05]), SILENCE_THRESHOLD_RANGE.max)).toBe(true);
    expect(isNearSilence(buffer([0.05]), SILENCE_THRESHOLD_RANGE.min)).toBe(false);
  });
});

describe('LevelMeter', () => {
  it('attacks instantly', () => {
    const meter = new LevelMeter();
    meter.publishPeak(0.7);
    expect(meter.level).toBeCloseTo(0.7, 6);
  });

  it('releases at 0.8/0.2 per block, not per poll', () => {
    const meter = new LevelMeter();
    meter.publishPeak(1);
    meter.publishPeak(0);
    expect(meter.level).toBeCloseTo(METER_RELEASE, 6);
    meter.publishPeak(0);
    expect(meter.level).toBeCloseTo(METER_RELEASE * METER_RELEASE, 6);
  });

  it('mixes in the new block on the way down', () => {
    const meter = new LevelMeter();
    meter.publishPeak(1);
    meter.publishPeak(0.5);
    expect(meter.level).toBeCloseTo(METER_RELEASE + 0.5 * METER_ATTACK, 6);
  });

  it('still reads loud between two syllables', () => {
    // The point of the decay: a 50 ms poll landing in a gap must not render silence.
    // At a ~128-sample quantum on 16 kHz that is roughly six blocks per poll.
    const meter = new LevelMeter();
    meter.publishPeak(0.8);
    for (let block = 0; block < 6; block += 1) meter.publishPeak(0);
    expect(meter.level).toBeGreaterThan(0.2);
  });

  it('clamps on read and resets to zero', () => {
    const meter = new LevelMeter();
    meter.publishPeak(1.24);
    expect(meter.level).toBe(1);
    meter.reset();
    expect(meter.level).toBe(0);
  });

  it('takes the peak of a block, not its mean', () => {
    const meter = new LevelMeter();
    meter.publish(Float32Array.from([0, 0, -0.6, 0]));
    expect(meter.level).toBeCloseTo(0.6, 6);
  });
});
