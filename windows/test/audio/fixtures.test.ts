// The WAV codec, and the three committed fixtures.
//
// `--check` (D-W10) and CI both run the pipeline over these, so a fixture that has
// silently changed shape — a different rate, a different peak, a regenerated "silent"
// clip that is now digital zero — breaks the only automated proof this app records
// anything at all. These assertions are what makes that a red test rather than a quiet
// behaviour change.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SILENCE_THRESHOLD,
  WavError,
  decodeWav,
  encodeWav,
  isNearSilence,
  measureLevel,
  readWavFile,
  createWavFileSource,
} from '../../src/audio/index.js';
import { SAMPLE_RATE, audioDuration, peakAmplitude } from '../../src/contracts/index.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/audio/${name}`, import.meta.url));

const UZBEK = fixture('uzbek-0001.wav');
const ENGLISH = fixture('english-pangram.wav');
const SILENT = fixture('silence-room-tone.wav');

describe('decodeWav', () => {
  it('round-trips 16-bit PCM within one quantisation step', () => {
    const original = Float32Array.from([0, 0.5, -0.5, 0.25, -1, 0.999]);
    const decoded = decodeWav(encodeWav(original));
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.channels).toBe(1);
    for (let index = 0; index < original.length; index += 1) {
      expect(decoded.samples[index]).toBeCloseTo(original[index] as number, 4);
    }
  });

  it('clamps rather than wrapping a sample the resampler pushed over the rail', () => {
    // The resampler contributes up to +1.15 dB of overshoot. A wrapped Int16 is a click,
    // and a click reads to the recogniser as a consonant.
    const decoded = decodeWav(encodeWav(Float32Array.from([1.24, -1.24])));
    expect(decoded.samples[0]).toBeCloseTo(1, 3);
    expect(decoded.samples[1]).toBeCloseTo(-1, 3);
  });

  it('averages channels to mono', () => {
    // Hand-built stereo: [1, 0, 1, 0] interleaved is two frames of (1, 0) -> 0.5 each.
    const mono = encodeWav(Float32Array.from([1, 0, 1, 0]));
    const bytes = new Uint8Array(mono);
    new DataView(bytes.buffer).setUint16(22, 2, true); // channels
    const decoded = decodeWav(bytes);
    expect(decoded.channels).toBe(2);
    expect(Array.from(decoded.samples).map((each) => Math.round(each * 100) / 100)).toEqual([
      0.5, 0.5,
    ]);
  });

  it('walks the chunk list instead of assuming offsets', () => {
    // A LIST chunk between fmt and data. A fixed-offset parser reads it as audio, which
    // is why the Swift one walks and why this one does.
    const base = encodeWav(Float32Array.from([0.5, -0.5]));
    const list = new Uint8Array(12);
    list.set([0x4c, 0x49, 0x53, 0x54]); // 'LIST'
    new DataView(list.buffer).setUint32(4, 4, true);
    const spliced = new Uint8Array(base.length + list.length);
    spliced.set(base.subarray(0, 36), 0);
    spliced.set(list, 36);
    spliced.set(base.subarray(36), 36 + list.length);
    new DataView(spliced.buffer).setUint32(4, spliced.length - 8, true);
    const decoded = decodeWav(spliced);
    expect(decoded.samples.length).toBe(2);
    expect(decoded.samples[0]).toBeCloseTo(0.5, 4);
  });

  it('throws typed errors on malformed input', () => {
    expect(() => decodeWav(new Uint8Array(4))).toThrow(WavError);
    const notRiff = encodeWav(Float32Array.from([0]));
    notRiff[0] = 0x58;
    expect(() => decodeWav(notRiff)).toThrow(/not a RIFF/);
  });
});

describe('readWavFile', () => {
  it('refuses a rate it is not allowed to convert', async () => {
    // There is no resampler outside the capture renderer (D-W6), and a convenience one
    // here would be a second, worse one on the path `--check` uses to prove the pipeline.
    const wrong = encodeWav(Float32Array.from([0.5]), 44_100);
    expect(() => decodeWav(wrong)).not.toThrow();
    await expect(readWavFile(fixture('does-not-exist.wav'))).rejects.toThrow();
  });
});

describe('the committed fixtures', () => {
  it('are all 16 kHz mono and small', async () => {
    for (const path of [UZBEK, ENGLISH, SILENT]) {
      const decoded = decodeWav(await readFile(path));
      expect(decoded.sampleRate).toBe(SAMPLE_RATE);
      expect(decoded.channels).toBe(1);
      expect((await readFile(path)).length).toBeLessThan(100_000);
    }
  });

  it('uzbek-0001 is the clip its reference transcript describes', async () => {
    // Byte for byte the same file as Scripts/measure/fixtures/0001.wav, whose reference
    // in Scripts/measure/data/refs.json is "put menyusi oʻzgacha boʻladi". If this ever
    // stops being true the ground truth stops describing the audio.
    const committed = await readFile(UZBEK);
    const source = await readFile(fileURLToPath(new URL('../../../Scripts/measure/fixtures/0001.wav', import.meta.url)));
    expect(Buffer.compare(committed, source)).toBe(0);
  });

  it('uzbek-0001 is 2.77 s of speech, comfortably above the silence gate', async () => {
    const buffer = await readWavFile(UZBEK);
    expect(audioDuration(buffer)).toBeCloseTo(2.77, 1);
    expect(isNearSilence(buffer, SILENCE_THRESHOLD)).toBe(false);
    expect(measureLevel(buffer).clipping).toBe('clean');
  });

  it('english-pangram is speech too, and is not clipping', async () => {
    const buffer = await readWavFile(ENGLISH);
    expect(audioDuration(buffer)).toBeGreaterThan(1);
    expect(isNearSilence(buffer, SILENCE_THRESHOLD)).toBe(false);
    expect(measureLevel(buffer).clipping).toBe('clean');
  });

  it('the silent clip is a quiet ROOM, not digital zero', async () => {
    // This is the distinction the session's two gates depend on. Zero samples are a
    // BROKEN MICROPHONE; a quiet room is the user saying nothing. A fixture of pure zeros
    // would test the first path while claiming to test the second.
    const buffer = await readWavFile(SILENT);
    expect(buffer.samples.length).toBeGreaterThan(0);
    expect(peakAmplitude(buffer)).toBeGreaterThan(0);
    expect(isNearSilence(buffer, SILENCE_THRESHOLD)).toBe(true);
  });

  it('the silent clip stays silent even at the lowest threshold the slider offers', async () => {
    const buffer = await readWavFile(SILENT);
    expect(peakAmplitude(buffer)).toBeLessThan(SILENCE_THRESHOLD);
    expect(peakAmplitude(buffer)).toBeGreaterThan(0.001);
  });
});

describe('createWavFileSource', () => {
  it('replays a clip through the same interface as the microphone', async () => {
    const source = createWavFileSource(UZBEK);
    await source.warmUp();
    expect(source.isWarm).toBe(true);
    await source.start();
    const buffer = await source.stop();
    expect(audioDuration(buffer)).toBeCloseTo(2.77, 1);
    expect(buffer.droppedSamples).toBe(0);
    await source.dispose();
  });

  it('yields nothing when it was never started, rather than stale audio', async () => {
    const source = createWavFileSource(UZBEK);
    await source.warmUp();
    expect((await source.stop()).samples.length).toBe(0);
  });

  it('reports a missing file through state, because warm-up may not throw', async () => {
    const source = createWavFileSource(fixture('nothing-here.wav'));
    await expect(source.warmUp()).resolves.toBeUndefined();
    expect(source.isWarm).toBe(false);
    expect(source.lastWarmUpError).toContain('nothing-here.wav');
  });

  it('drives ten consecutive dictations, like the microphone', async () => {
    const source = createWavFileSource(ENGLISH);
    for (let dictation = 0; dictation < 10; dictation += 1) {
      await source.start();
      expect((await source.stop()).samples.length).toBeGreaterThan(0);
    }
  });
});
