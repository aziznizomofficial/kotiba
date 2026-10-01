// The Arabic fallback engine's arithmetic: NeMo's 80-bin log-mel front end and the greedy CTC
// decode. PURE — the ONNX session that turns features into log-probabilities lives in
// `src/engines/arabic-runtime.ts`.
//
// WHAT IT SERVES. NVIDIA's FastConformer-Hybrid Arabic (115 M, `stt_ar_fastconformer_hybrid_
// large_pcd_v1.0`), int8 ONNX as OpenVoiceOS exported it in onnx-asr's `nemo-conformer-ctc`
// layout — C4 §7.3.1: 12.9 % MSA WER (tied with whisper turbo), punctuation F1 61, a key-release
// tail of 74–94 ms on a CPU. It is what Arabic falls back to on a Windows PC too slow for Cohere
// (the first-run speed check in `arabic.ts`).
//
// WHY THE FRONT END IS HERE AND NOT AN ONNX FILE. Parakeet's export ships `nemo128.onnx`; this
// one ships only the acoustic model, and onnx-asr builds its `nemo80.onnx` at package time — it
// is not published anywhere a pinned URL could fetch it. So this is a port of onnx-asr's own
// NumPy twin of that graph (`NemoPreprocessorNumpy`, onnx-asr 0.12, MIT), step for step:
//
//     pre-emphasis 0.97 → zero-pad 256 each side → 512-sample frames every 160 → symmetric
//     Hann(400) centred in 512 → |rfft|² → slaney mel (80, 0–8 kHz) → ln(x + 2⁻²⁴)
//     → per-bin mean / unbiased std over the valid frames (std + 1e-5) → zero past them
//
// and the filterbank is librosa's `filters.mel(sr=16000, n_fft=512, n_mels=80, norm='slaney')`,
// computed rather than shipped. Checked against onnx-asr's stored `fbanks.npz['nemo80']` and its
// NumPy features on real FLEURS audio (`test/core/nemo-ctc.test.ts` records the tolerance).

export const NEMO_SAMPLE_RATE = 16_000;
export const NEMO_N_FFT = 512;
export const NEMO_WINDOW = 400;
export const NEMO_HOP = 160;
export const NEMO_PREEMPHASIS = 0.97;
const LOG_GUARD = 2 ** -24;
const STD_GUARD = 1e-5;

// ---------------------------------------------------------------------------------
// The filterbank
// ---------------------------------------------------------------------------------

/** librosa's slaney mel scale: linear to 1 kHz, logarithmic above. */
function hzToMel(hz: number): number {
  const linear = (3 * hz) / 200;
  if (hz < 1000) return linear;
  return 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27);
}

function melToHz(mel: number): number {
  if (mel < 15) return (200 * mel) / 3;
  return 1000 * Math.exp((Math.log(6.4) / 27) * (mel - 15));
}

/**
 * `librosa.filters.mel(sr, n_fft, n_mels, fmin=0, fmax=sr/2, htk=False, norm='slaney')`,
 * TRANSPOSED to `[bin][mel]` (onnx-asr stores it that way: `fbanks.npz['nemo80']` is 257 × 80).
 */
export function slaneyMelFilterbank(melCount = 80, nFft = NEMO_N_FFT, sampleRate = NEMO_SAMPLE_RATE): Float64Array[] {
  const bins = Math.floor(nFft / 2) + 1;
  const fftFreqs = Array.from({ length: bins }, (_, k) => (k * sampleRate) / nFft);
  const low = hzToMel(0);
  const high = hzToMel(sampleRate / 2);
  const melF = Array.from({ length: melCount + 2 }, (_, i) => melToHz(low + ((high - low) * i) / (melCount + 1)));
  const out = Array.from({ length: bins }, () => new Float64Array(melCount));
  for (let m = 0; m < melCount; m += 1) {
    const lower = melF[m]!;
    const centre = melF[m + 1]!;
    const upper = melF[m + 2]!;
    const enorm = 2 / (upper - lower);
    for (let k = 0; k < bins; k += 1) {
      const f = fftFreqs[k]!;
      const rising = (f - lower) / (centre - lower);
      const falling = (upper - f) / (upper - centre);
      const weight = Math.max(0, Math.min(rising, falling));
      out[k]![m] = weight * enorm;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------
// The FFT (radix-2, in place) — 512 points, a thousand times per 10 s of audio
// ---------------------------------------------------------------------------------

interface FftPlan {
  readonly size: number;
  readonly cos: Float64Array;
  readonly sin: Float64Array;
  readonly reversed: Uint32Array;
}

function planFft(size: number): FftPlan {
  if ((size & (size - 1)) !== 0) throw new Error(`FFT size ${size} is not a power of two`);
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i += 1) {
    cos[i] = Math.cos((-2 * Math.PI * i) / size);
    sin[i] = Math.sin((-2 * Math.PI * i) / size);
  }
  const bits = Math.round(Math.log2(size));
  const reversed = new Uint32Array(size);
  for (let i = 0; i < size; i += 1) {
    let r = 0;
    for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  return { size, cos, sin, reversed };
}

/** |FFT|² of a real frame, bins 0…size/2. `re`/`im` are scratch of length `size`. */
function powerSpectrum(plan: FftPlan, frame: Float64Array, re: Float64Array, im: Float64Array, out: Float64Array): void {
  const n = plan.size;
  for (let i = 0; i < n; i += 1) {
    re[plan.reversed[i]!] = frame[i]!;
    im[i] = 0;
  }
  for (let length = 2; length <= n; length <<= 1) {
    const half = length >> 1;
    const step = n / length;
    for (let start = 0; start < n; start += length) {
      for (let j = 0; j < half; j += 1) {
        const wr = plan.cos[j * step]!;
        const wi = plan.sin[j * step]!;
        const a = start + j;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
  for (let k = 0; k <= n / 2; k += 1) out[k] = re[k]! * re[k]! + im[k]! * im[k]!;
}

// ---------------------------------------------------------------------------------
// The front end
// ---------------------------------------------------------------------------------

export interface NemoFeatures {
  /** `[mels][frames]`, row-major — the `[1, 80, T]` tensor the encoder takes, minus the batch. */
  readonly data: Float32Array;
  readonly mels: number;
  /** Frames in `data` (`floor(n / 160) + 1`). */
  readonly frames: number;
  /** Valid frames (`floor(n / 160)`) — the encoder's `length` input. */
  readonly length: number;
}

let cachedBank: { readonly mels: number; readonly bank: Float64Array[] } | null = null;
let cachedPlan: FftPlan | null = null;
let cachedWindow: Float64Array | null = null;

/** `np.pad(np.hanning(400), 56)` — NumPy's SYMMETRIC Hann, centred in the 512-sample frame. */
function paddedHann(): Float64Array {
  if (cachedWindow !== null) return cachedWindow;
  const window = new Float64Array(NEMO_N_FFT);
  const offset = (NEMO_N_FFT - NEMO_WINDOW) / 2;
  for (let i = 0; i < NEMO_WINDOW; i += 1) window[offset + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NEMO_WINDOW - 1));
  cachedWindow = window;
  return window;
}

/** 16 kHz mono in, normalised log-mel out. `NemoPreprocessorNumpy.__call__` for a batch of one. */
export function nemoLogMel(samples: ArrayLike<number>, mels = 80): NemoFeatures {
  const n = samples.length;
  if (cachedBank === null || cachedBank.mels !== mels) cachedBank = { mels, bank: slaneyMelFilterbank(mels) };
  const bank = cachedBank.bank;
  cachedPlan ??= planFft(NEMO_N_FFT);
  const plan = cachedPlan;
  const window = paddedHann();

  // Pre-emphasis, then 256 zeros each side.
  const pad = NEMO_N_FFT / 2;
  const padded = new Float64Array(n + 2 * pad);
  for (let i = 0; i < n; i += 1) {
    const previous = i === 0 ? 0 : (samples[i - 1] ?? 0);
    padded[pad + i] = (samples[i] ?? 0) - NEMO_PREEMPHASIS * previous;
  }

  const frames = Math.floor((padded.length - NEMO_N_FFT) / NEMO_HOP) + 1;
  const length = Math.floor(n / NEMO_HOP);
  const bins = NEMO_N_FFT / 2 + 1;
  const logMel = new Float64Array(mels * frames);
  const frame = new Float64Array(NEMO_N_FFT);
  const re = new Float64Array(NEMO_N_FFT);
  const im = new Float64Array(NEMO_N_FFT);
  const power = new Float64Array(bins);
  for (let t = 0; t < frames; t += 1) {
    const start = t * NEMO_HOP;
    for (let i = 0; i < NEMO_N_FFT; i += 1) frame[i] = padded[start + i]! * window[i]!;
    powerSpectrum(plan, frame, re, im, power);
    for (let m = 0; m < mels; m += 1) {
      let energy = 0;
      for (let k = 0; k < bins; k += 1) energy += power[k]! * bank[k]![m]!;
      logMel[m * frames + t] = Math.log(energy + LOG_GUARD);
    }
  }

  // Per-bin normalisation over the valid frames; everything past them is zero.
  const data = new Float32Array(mels * frames);
  for (let m = 0; m < mels; m += 1) {
    const row = m * frames;
    let sum = 0;
    for (let t = 0; t < length; t += 1) sum += logMel[row + t]!;
    const mean = length > 0 ? sum / length : 0;
    let squares = 0;
    for (let t = 0; t < length; t += 1) squares += (logMel[row + t]! - mean) ** 2;
    // NumPy divides by `length - 1`: one valid frame is a division by zero there (NaN); the
    // engine never feeds under a second, so it cannot arise — guarded all the same.
    const std = length > 1 ? Math.sqrt(squares / (length - 1)) : 0;
    for (let t = 0; t < length; t += 1) data[row + t] = (logMel[row + t]! - mean) / (std + STD_GUARD);
  }
  return { data, mels, frames, length };
}

/** The encoder's output length for `length` valid feature frames: `(length - 1) // 8 + 1`. */
export function ctcFramesFor(length: number, subsampling = 8): number {
  return Math.floor((length - 1) / subsampling) + 1;
}

// ---------------------------------------------------------------------------------
// Greedy CTC
// ---------------------------------------------------------------------------------

/**
 * `_AsrWithCtcDecoding._decoding` for one utterance: per-frame argmax (the FIRST maximum), keep a
 * token that is not blank AND differs from the frame before it (blank counts as "before" for
 * frame 0). `logprobs` is `[frames][vocab]`, row-major.
 */
export function greedyCtc(logprobs: ArrayLike<number>, frames: number, vocab: number, blank: number, valid = frames): number[] {
  const tokens: number[] = [];
  let previous = blank;
  const limit = Math.min(frames, valid);
  for (let t = 0; t < limit; t += 1) {
    const base = t * vocab;
    let best = 0;
    let bestValue = logprobs[base] ?? -Infinity;
    for (let v = 1; v < vocab; v += 1) {
      const value = logprobs[base + v] ?? -Infinity;
      if (value > bestValue) {
        bestValue = value;
        best = v;
      }
    }
    if (best !== blank && best !== previous) tokens.push(best);
    previous = best;
  }
  return tokens;
}
