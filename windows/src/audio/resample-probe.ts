// Proving the resampler, rather than assuming it.
//
// D-W6 hands resampling to the browser on the strength of an argument — that Chromium's
// is high quality and the macOS one was not. An argument is what the macOS app had too:
// `AVAudioConverter` was assumed to be fine and was silently running at quality 64 with
// the Normal algorithm, which rolled speech off from about 6 kHz and folded content above
// Nyquist back down into the top mel bins. That is where Uzbek keeps sh, ch, q, x and gʻ.
// The bug (commit 97272d7) survived every test and every WER measurement, because the
// evaluation corpus is already 16 kHz and never goes through the resampler at all.
//
// So: a measurement, with the macOS numbers as the acceptance bar.
//
//   6.0 kHz tone   -2.13 dB before the fix,  -0.00 dB after   -> must be flat
//   7.0 kHz tone   -5.17 dB before,          -0.04 dB after   -> must be flat
//   8.5 kHz tone  aliased in at -14 dB,      -63 dB after     -> must be rejected
//
// Everything in this file is pure arithmetic over Float32Array. The signals, the analysis
// and the verdict run in a unit test with no browser; the resampler under test is
// supplied by the caller, so the same instrument measures Chromium (through
// `RESAMPLE_PROBE_SOURCE`, in the capture window) and measures a deliberately bad
// resampler in a test, which is how we know the instrument can fail.

/** Tone amplitude used throughout, well clear of the rail. */
const AMPLITUDE = 0.5;

/** A pure tone at `frequency`, `seconds` long, at `rate`. */
export function tone(frequency: number, seconds: number, rate: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  const step = (2 * Math.PI * frequency) / rate;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = AMPLITUDE * Math.sin(step * index);
  }
  return samples;
}

/**
 * A linear sine sweep from `from` to `to`. Used as the single stimulus a human would
 * reach for; the per-tone measurements are what the assertions key off, because a sweep's
 * energy at any one frequency is spread over time and harder to bound.
 */
export function sweep(from: number, to: number, seconds: number, rate: number): Float32Array {
  const count = Math.round(seconds * rate);
  const samples = new Float32Array(count);
  let phase = 0;
  for (let index = 0; index < count; index += 1) {
    const t = index / count;
    const frequency = from + (to - from) * t;
    phase += (2 * Math.PI * frequency) / rate;
    samples[index] = AMPLITUDE * Math.sin(phase);
  }
  return samples;
}

/**
 * Magnitude at one frequency, by the Goertzel algorithm, over a Hann-windowed block.
 *
 * Goertzel rather than a full FFT because we need three bins, not 4096, and because a
 * hand-rolled FFT is another thing that can be wrong in a file whose whole job is to
 * catch something being quietly wrong. The Hann window is what keeps a 6 kHz tone's
 * leakage from filling the 8.5 kHz bin and reading as alias rejection failure.
 *
 * Returns amplitude in the same units as the input, so a 0.5-amplitude tone reads 0.5.
 */
export function magnitudeAt(samples: Float32Array, frequency: number, rate: number): number {
  const count = samples.length;
  if (count === 0) return 0;
  const k = (2 * Math.PI * frequency) / rate;
  const coefficient = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  let windowPower = 0;
  for (let index = 0; index < count; index += 1) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / count);
    windowPower += w;
    const s0 = (samples[index] as number) * w + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * Math.cos(k);
  const imaginary = s2 * Math.sin(k);
  return (2 * Math.sqrt(real * real + imaginary * imaginary)) / windowPower;
}

/** `20 * log10(x)`, floored at -200 dB so digital silence is a number and not `-Infinity`. */
export function decibels(amplitude: number): number {
  return amplitude <= 0 ? -200 : Math.max(-200, 20 * Math.log10(amplitude));
}

/** Anything that turns `rate`-Hz mono samples into 16 kHz mono samples. */
export type Resampler = (samples: Float32Array, rate: number) => Promise<Float32Array>;

export interface ResampleMeasurement {
  /** The tone that was fed in, in Hz at the input rate. */
  readonly frequency: number;
  /**
   * For a tone below 8 kHz: its level at the output, in dB relative to the input. 0 dB is
   * perfect. For a tone above 8 kHz: the level of whatever landed at the frequency it
   * would alias to, which is what must be far down.
   */
  readonly dB: number;
  /** Where the energy was looked for in the 16 kHz output. */
  readonly measuredAt: number;
}

export interface ResampleReport {
  readonly inputRate: number;
  readonly passband: readonly ResampleMeasurement[];
  readonly alias: ResampleMeasurement;
  /** Every acceptance rule that failed, as a sentence. Empty means the resampler passed. */
  readonly failures: readonly string[];
}

/**
 * How flat the passband must be. macOS after its fix measures -0.00 dB at 6 kHz and
 * -0.04 dB at 7 kHz; -1 dB is loose enough for a different implementation's window
 * shape and tight enough to catch the -2.13 / -5.17 dB roll-off that was the defect.
 */
export const PASSBAND_TOLERANCE_DB = 1;

/**
 * How far down an above-Nyquist tone must land. macOS after its fix measures -63 dB.
 * The defect measured -14 dB. 60 dB is the bar D-W6 claims and is what is asserted.
 */
export const ALIAS_REJECTION_DB = 60;

/** Tones the passband must pass. 7 kHz is the top of what a 16 kHz recogniser can use. */
export const PASSBAND_TONES = [1_000, 4_000, 6_000, 7_000] as const;

/** The tone that must NOT survive. 8.5 kHz at 48 kHz in folds to 7.5 kHz at 16 kHz out. */
export const ALIAS_TONE = 8_500;

/** Where an out-of-band tone lands after decimation to 16 kHz, by symmetry about 8 kHz. */
export function aliasFrequency(frequency: number): number {
  const nyquist = 8_000;
  const folded = Math.abs(((frequency + nyquist) % 16_000) - nyquist);
  return folded;
}

/**
 * Feed tones through `resample` and report what came out.
 *
 * `seconds` is 0.5 by default: long enough that the Goertzel bins are sharp, short enough
 * that running it inside a hidden window costs nothing noticeable.
 */
export async function measureResampler(
  resample: Resampler,
  inputRate = 48_000,
  seconds = 0.5,
): Promise<ResampleReport> {
  const failures: string[] = [];

  const passband: ResampleMeasurement[] = [];
  for (const frequency of PASSBAND_TONES) {
    const input = tone(frequency, seconds, inputRate);
    const output = await resample(input, inputRate);
    const before = magnitudeAt(input, frequency, inputRate);
    const after = magnitudeAt(output, frequency, 16_000);
    const dB = decibels(after) - decibels(before);
    passband.push({ frequency, dB, measuredAt: frequency });
    if (dB < -PASSBAND_TOLERANCE_DB) {
      failures.push(
        `${frequency} Hz came through ${dB.toFixed(2)} dB down, past the ${PASSBAND_TOLERANCE_DB} dB ` +
          'the passband allows. This is the shape of the macOS defect: speech rolled off from ' +
          'about 6 kHz, which is where Uzbek keeps sh, ch, q, x and gʻ.',
      );
    }
  }

  const aliasAt = aliasFrequency(ALIAS_TONE);
  const aliasInput = tone(ALIAS_TONE, seconds, inputRate);
  const aliasOutput = await resample(aliasInput, inputRate);
  const reference = magnitudeAt(aliasInput, ALIAS_TONE, inputRate);
  const folded = magnitudeAt(aliasOutput, aliasAt, 16_000);
  const aliasDb = decibels(folded) - decibels(reference);
  const alias: ResampleMeasurement = { frequency: ALIAS_TONE, dB: aliasDb, measuredAt: aliasAt };
  if (aliasDb > -ALIAS_REJECTION_DB) {
    failures.push(
      `a ${ALIAS_TONE} Hz tone folded down to ${aliasAt} Hz at ${aliasDb.toFixed(1)} dB, short of the ` +
        `${ALIAS_REJECTION_DB} dB rejection required. Above-Nyquist content is landing in the top ` +
        'mel bins as if it were speech.',
    );
  }

  return { inputRate, passband, alias, failures };
}

/**
 * WHAT WAS MEASURED, AND WHEN. Chromium 151, headless, 2026-08-19, through
 * `RESAMPLE_PROBE_SOURCE` below — a tone into a MediaStream into a 16 kHz `AudioContext`,
 * which is the shipping path.
 *
 * | tone    | 48 kHz in | 44.1 kHz in | 16 kHz in (CONTROL) | macOS before | macOS after |
 * |---------|-----------|-------------|---------------------|--------------|-------------|
 * | 1 kHz   |  0.00 dB  |   0.00 dB   |       0.00 dB       |      —       |      —      |
 * | 4 kHz   |  0.00 dB  |   0.00 dB   |       0.00 dB       |      —       |      —      |
 * | 6 kHz   | -0.18 dB  |  -0.10 dB   |       0.00 dB       |   -2.13 dB   |  -0.00 dB   |
 * | 7 kHz   | -3.17 dB  |  -2.98 dB   |      -4.76 dB       |   -5.17 dB   |  -0.04 dB   |
 * | 7.8 kHz |     —     |      —      |     -19.21 dB       |      —       |      —      |
 * | 8.5 kHz | -26.6 dB  |  -29.7 dB   |          —          |    -14 dB    |   -63 dB    |
 *
 * READ THE CONTROL COLUMN FIRST. It is 16 kHz in and 16 kHz out — NO RESAMPLING HAPPENS —
 * and it still loses 4.76 dB at 7 kHz and 19 dB at 7.8 kHz. So the passband roll-off is
 * NOT the resampler. It is the MediaStream capture path itself, which band-limits near
 * the top of the band whatever rate you hand it, and the 48 kHz path is in fact 1.6 dB
 * BETTER at 7 kHz than the path that does no conversion at all.
 *
 * Two conclusions, and they point in different directions:
 *
 *   1. D-W6's resampler argument survives. There is no measurable resampler loss in the
 *      passband, and the 8.5 kHz alias is 12 dB further down than the macOS defect that
 *      destroyed Uzbek sibilants. Hand-writing a resampler would not recover anything
 *      here, and would put a second untested one on the path.
 *
 *   2. The bar in D-W6 is still not met, and the cause is somewhere else. macOS delivers
 *      7 kHz flat and rejects 8.5 kHz by 63 dB; this path delivers 7 kHz about 3 dB down
 *      and rejects by 27. That is a real difference in the band where Uzbek keeps sh, ch,
 *      q, x and gʻ, and if Uzbek accuracy on Windows comes in below the Mac, THIS is the
 *      first thing to re-measure — not the engine, not the parameters.
 *
 * MEASUREMENT CAVEAT, stated because it changes what the numbers licence. The stimulus
 * was a `MediaStreamAudioDestinationNode`, not a real `getUserMedia` device: Chromium's
 * headless build blocks on the permission prompt and the run had to be abandoned. Both
 * routes go through the same WebRTC audio path, and the capture constraints this app sets
 * (`echoCancellation`, `noiseSuppression`, `autoGainControl` all false) may or may not
 * relax the band-limiting seen here. The number to trust is the CONTROL, which proves the
 * roll-off is not conversion; the absolute figures want re-measuring on a real device
 * inside Electron before anyone quotes them.
 */
export const MEASURED_CHROMIUM = {
  browser: 'Chromium 151 headless (Playwright), MediaStreamAudioDestinationNode stimulus',
  measured: '2026-08-19',
  /** 48 kHz in. */
  passbandDb: { 1_000: 0.0, 4_000: 0.0, 6_000: -0.18, 7_000: -3.17 },
  aliasDb: -26.6,
  /** 16 kHz in, 16 kHz out: no conversion at all, and the roll-off is still there. */
  controlDb: { 1_000: 0.0, 4_000: 0.0, 6_000: 0.0, 7_000: -4.76, 7_800: -19.21 },
} as const;

/**
 * The probe as source, to be evaluated inside the hidden capture window.
 *
 * It installs `window.__kotibaResampleProbe(frequency, rate)`, which pushes a tone through
 * a MediaStream into a 16 kHz `AudioContext` and returns what came out — THE SAME path
 * `getUserMedia` takes, and therefore the same resampler.
 *
 * DO NOT "SIMPLIFY" THIS INTO AN OfflineAudioContext AND AN AudioBufferSourceNode. That
 * was the first version of this probe and it measured a completely different resampler:
 * `AudioBufferSourceNode`'s playback-rate conversion is linear interpolation with NO
 * anti-alias filter, and it passed an 8.5 kHz tone into the 7.5 kHz bin at 0.00 dB —
 * perfect aliasing, worse than the macOS bug this project exists to have fixed. Anyone
 * who later decodes a WAV and plays it into a 16 kHz context to "convert" it reintroduces
 * that defect, silently, on a path nobody can listen to.
 *
 * `src/main` runs it. Nothing calls it in normal operation.
 */
export const RESAMPLE_PROBE_SOURCE = String.raw`
window.__kotibaResampleProbe = async (frequency, rate, seconds) => {
  const AMPLITUDE = 0.5;
  const worklet = URL.createObjectURL(new Blob([
    'class KotibaProbe extends AudioWorkletProcessor {' +
    '  constructor(){ super(); this.blocks=[]; this.n=0; this.port.onmessage = () => {' +
    '    const out = new Float32Array(this.n); let o = 0;' +
    '    for (const b of this.blocks) { out.set(b, o); o += b.length; }' +
    '    this.port.postMessage(out, [out.buffer]); }; }' +
    '  process(inputs){ const ch = inputs[0] && inputs[0][0];' +
    '    if (ch && ch.length) { const b = new Float32Array(ch.length); b.set(ch);' +
    '      this.blocks.push(b); this.n += b.length; } return true; } }' +
    "registerProcessor('kotiba-probe', KotibaProbe);"
  ], { type: 'text/javascript' }));

  const up = new AudioContext({ sampleRate: rate });
  const down = new AudioContext({ sampleRate: 16000 });
  try {
    if (up.state === 'suspended') await up.resume();
    if (down.state === 'suspended') await down.resume();
    const oscillator = up.createOscillator();
    oscillator.frequency.value = frequency;
    const gain = up.createGain();
    gain.gain.value = AMPLITUDE;
    const destination = up.createMediaStreamDestination();
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();

    await down.audioWorklet.addModule(worklet);
    const node = new AudioWorkletNode(down, 'kotiba-probe', {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1,
    });
    down.createMediaStreamSource(destination.stream).connect(node);

    const captured = await new Promise((resolve) => {
      setTimeout(() => {
        node.port.onmessage = (event) => resolve(event.data);
        node.port.postMessage('drain');
      }, Math.round((seconds || 0.9) * 1000));
    });
    oscillator.stop();
    // The stream takes a moment to settle; the middle of the capture is the measurement.
    const from = Math.floor(captured.length * 0.35);
    const to = Math.floor(captured.length * 0.95);
    return { samples: Array.from(captured.subarray(from, to)), amplitude: AMPLITUDE };
  } finally {
    URL.revokeObjectURL(worklet);
    try { await up.close(); } catch { /* already closed */ }
    try { await down.close(); } catch { /* already closed */ }
  }
};
`;
