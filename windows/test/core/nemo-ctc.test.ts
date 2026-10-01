// The Arabic FastConformer's front end and decoder (src/core/stt/nemo-ctc.ts), against onnx-asr
// 0.12 — the pipeline C4 §3.2 measured at 12.9 % MSA WER with these weights.
//
// The reference numbers were produced once by onnx-asr's own `NemoPreprocessorNumpy("nemo80")`
// and its stored filterbank (`fbanks.npz['nemo80']`) on the synthetic signal below, and are
// written here as literals so the test needs no Python. On five real FLEURS ar_eg clips (3–15 s)
// the whole TS pipeline — this front end, ONNX Runtime, `greedyCtc`, `piecesToText` — produced
// text IDENTICAL to `onnx_asr.load_model('nemo-conformer-ctc', …).recognize` (5 of 5; the check
// is `scripts/measure/arabic-stream.mjs --compare`, which needs the model and is not in the gate).

import { describe, expect, it } from 'vitest';

import { ctcFramesFor, greedyCtc, nemoLogMel, slaneyMelFilterbank } from '../../src/core/stt/nemo-ctc.js';

/** 0.3·chirp(200 → 2000 Hz) + 0.05·sin(3 kHz), one second, float32 — the reference signal. */
function referenceSignal(): Float32Array {
  const n = 16_000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / 16_000;
    out[i] = Math.fround(0.3 * Math.sin(2 * Math.PI * (200 + 1800 * t) * t) + 0.05 * Math.sin(2 * Math.PI * 3000 * t));
  }
  return out;
}

describe('the slaney mel filterbank', () => {
  it('matches onnx-asr’s stored nemo80 bank at each filter’s peak and in total', () => {
    const bank = slaneyMelFilterbank(80);
    expect(bank).toHaveLength(257);
    // [mel] → [peak bin, value there, column sum], from fbanks.npz['nemo80'].
    const reference: Record<number, [number, number, number]> = {
      0: [1, 0.022534562274813652, 0.031172271817922592],
      10: [13, 0.024415135383605957, 0.033052846789360046],
      40: [55, 0.014444186352193356, 0.032116297632455826],
      79: [246, 0.0032521525863558054, 0.03193053603172302],
    };
    for (const [mel, [peak, value, sum]] of Object.entries(reference)) {
      const m = Number(mel);
      const column = bank.map((row) => row[m] ?? 0);
      expect(column.indexOf(Math.max(...column))).toBe(peak);
      expect(column[peak]).toBeCloseTo(value, 7);
      expect(column.reduce((a, b) => a + b, 0)).toBeCloseTo(sum, 6);
    }
    const total = bank.reduce((all, row) => all + row.reduce((a, b) => a + Math.abs(b), 0), 0);
    expect(total).toBeCloseTo(2.558260917663574, 5);
  });
});

describe('nemoLogMel', () => {
  it('has NeMo’s shape: floor(n/160)+1 frames, floor(n/160) of them valid, zero past them', () => {
    const features = nemoLogMel(referenceSignal());
    expect(features.mels).toBe(80);
    expect(features.frames).toBe(101);
    expect(features.length).toBe(100);
    for (let m = 0; m < 80; m += 1) expect(features.data[m * features.frames + 100]).toBe(0);
  });

  it('matches onnx-asr’s NumPy features within 2e-5', () => {
    const features = nemoLogMel(referenceSignal());
    const reference: Record<string, number> = {
      '0,0': 7.38767, '0,5': 0.10843, '0,50': -0.24054, '0,99': 4.9215,
      '10,0': 2.15996, '10,5': 3.62787, '10,50': -0.41861, '10,99': 1.24235,
      '40,0': -0.12821, '40,5': -0.52262, '40,50': 0.6549, '40,99': 0.916,
      '79,0': 8.98211, '79,5': -0.15099, '79,50': -0.15098, '79,99': 2.63716,
    };
    for (const [key, value] of Object.entries(reference)) {
      const [m, t] = key.split(',').map(Number) as [number, number];
      expect(Math.abs((features.data[m * features.frames + t] ?? NaN) - value)).toBeLessThan(2e-5);
    }
  });

  it('normalises each bin to mean 0 and unit (unbiased) deviation over the valid frames', () => {
    const features = nemoLogMel(referenceSignal());
    for (const m of [3, 33, 66]) {
      const row = Array.from(features.data.subarray(m * features.frames, m * features.frames + features.length));
      const mean = row.reduce((a, b) => a + b, 0) / row.length;
      const variance = row.reduce((a, b) => a + (b - mean) ** 2, 0) / (row.length - 1);
      expect(mean).toBeCloseTo(0, 5);
      expect(Math.sqrt(variance)).toBeCloseTo(1, 3);
    }
  });
});

describe('greedy CTC', () => {
  const vocab = 4;
  const blank = 3;
  const frames = (ids: number[]): Float32Array => {
    const out = new Float32Array(ids.length * vocab).fill(-10);
    ids.forEach((id, t) => {
      out[t * vocab + id] = 0;
    });
    return out;
  };

  it('collapses repeats, drops blanks, and keeps a repeat that a blank separates', () => {
    expect(greedyCtc(frames([0, 0, 3, 1, 1, 3, 1, 2]), 8, vocab, blank)).toEqual([0, 1, 1, 2]);
  });

  it('stops at the valid length, not the tensor’s', () => {
    expect(greedyCtc(frames([0, 1, 2, 2]), 4, vocab, blank, 2)).toEqual([0, 1]);
  });

  it('takes the FIRST maximum on a tie, as numpy.argmax does', () => {
    const tie = new Float32Array([0, 0, -1, -1]);
    expect(greedyCtc(tie, 1, vocab, blank)).toEqual([0]);
  });

  it('computes the encoder’s length as (n - 1) // 8 + 1', () => {
    expect(ctcFramesFor(100)).toBe(13);
    expect(ctcFramesFor(8)).toBe(1);
    expect(ctcFramesFor(9)).toBe(2);
  });
});
