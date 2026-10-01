// Level, clipping and silence measurement.
//
// Ported from the parts of the macOS app that measure a finished buffer:
// Sources/KotibaAudio/LevelMeter.swift (the live meter) and the audio-facing rules in
// Sources/KotibaCore/DictationSession.swift:290-380 (peak, saturation, heard-nothing).
//
// SCOPE. This module MEASURES. It does not decide. `DictationSession` (t09) owns the
// two decisions — an empty capture is a broken microphone, and a peak below
// `settings.silenceThreshold` is `heardNothing` — because on macOS they live in
// DictationSession.finish() and nowhere else. What lives here is everything needed to
// make them, exposed as plain numbers over plain data.
//
// Pure. No Node, no Electron, no DOM. Everything here runs with no microphone.

import { peakAmplitude, type AudioBuffer } from '../contracts/index.js';

/**
 * `abs(sample) >= SATURATED` is "flat against the rail".
 * Sources/KotibaCore/DictationSession.swift:331.
 */
export const SATURATED = 0.999;

/**
 * Peak at or above this triggers a clipping or hot note.
 * `DictationSession.clippingThreshold`, Sources/KotibaCore/DictationSession.swift:96.
 * The macOS test pins only that it sits strictly between 0.9 and 1.0.
 */
export const CLIPPING_THRESHOLD = 0.99;

/**
 * Above this share of saturated samples the note is "clipping" (actionable); below it
 * the note is "hot" (recorded only). `DictationSession.flatteningFraction`,
 * Sources/KotibaCore/DictationSession.swift:105.
 *
 * Derived from a 344-clip Uzbek WER set: 0% -> 25.19%, 1.1% -> 25.20%, 8.3% -> 26.77%,
 * 28.6% -> 33.54%. So 1.1% of samples on the rail costs 0.01 WER points and is not
 * worth a warning; 8.3% costs 1.5 points and is. The macOS test pins
 * 0.011 < flatteningFraction < 0.083.
 */
export const FLATTENING_FRACTION = 0.02;

/**
 * The default whole-buffer peak below which a recording counts as silence.
 * `DictationSession.config.silenceThreshold` and `settings.silenceThreshold`
 * (Sources/KotibaUI/Settings.swift:117). The session passes the user's value; this is
 * only the default, repeated here so an audio test need not import settings.
 */
export const SILENCE_THRESHOLD = 0.012;

/** The legal range the settings UI must offer. Sources/KotibaUI/SettingsView.swift:118. */
export const SILENCE_THRESHOLD_RANGE = { min: 0.001, max: 0.1 } as const;

/**
 * Fraction of samples flat against the rail (`Math.abs(s) >= 0.999`).
 *
 * 0 for an empty buffer — not NaN. The macOS code divides by `count` after an `isEmpty`
 * guard, and a NaN here propagates into a diagnostics record and into a comparison that
 * is then false in both directions.
 */
export function saturatedFraction(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let saturated = 0;
  for (const sample of samples) {
    if (Math.abs(sample) >= SATURATED) saturated += 1;
  }
  return saturated / samples.length;
}

/**
 * What the input level was, for one finished dictation.
 *
 * Every dictation records this, because the utterance that started this measurement
 * peaked at 1.240 and flattened into nonsense before the app ever saw it, and nothing in
 * the record said so.
 */
export interface LevelReport {
  /** Whole-buffer peak absolute amplitude. A float peak CAN exceed 1.0. */
  readonly peak: number;
  /** Share of samples with `abs(s) >= 0.999`. */
  readonly saturatedFraction: number;
  /**
   * `'clean'` — peak below 0.99, nothing to say.
   *
   * `'hot'` — peak at or above 0.99 but under 2% of samples flat. Measured to cost
   * nothing; recorded rather than warned about. A high-quality resampler contributes up
   * to +1.15 dB of overshoot of its own, so a peak over 1.0 alone means nothing.
   *
   * `'clipping'` — peak at or above 0.99 AND at least 2% of samples flat against the
   * rail. About 1.5 points of word error.
   */
  readonly clipping: 'clean' | 'hot' | 'clipping';
}

/**
 * Measure a finished buffer. Called once per dictation, by the session.
 *
 * The classification deliberately does NOT trust the peak alone. A peak above 1.0 means
 * hot OR flattened, and warning on the peak alone fires on a condition that was measured
 * to cost nothing — which trains the user to ignore the one that costs 1.5 WER points.
 */
export function measureLevel(buffer: AudioBuffer): LevelReport {
  const peak = peakAmplitude(buffer);
  const fraction = saturatedFraction(buffer.samples);
  if (peak < CLIPPING_THRESHOLD) {
    return { peak, saturatedFraction: fraction, clipping: 'clean' };
  }
  return {
    peak,
    saturatedFraction: fraction,
    clipping: fraction >= FLATTENING_FRACTION ? 'clipping' : 'hot',
  };
}

/**
 * The sentence the session records for a hot or clipping input, or `null` when there is
 * nothing to say. From Sources/KotibaCore/DictationSession.swift:335-347, with the one
 * change the platform forces: the input volume lives in a different panel on Windows.
 *
 * Peak is formatted to two decimals and the percentage to one, exactly as on macOS, so a
 * diagnostics record reads the same on both platforms.
 */
export function clippingNote(report: LevelReport): string | null {
  const peak = report.peak.toFixed(2);
  const percent = (report.saturatedFraction * 100).toFixed(1);
  switch (report.clipping) {
    case 'clean':
      return null;
    case 'clipping':
      return (
        `input is clipping — peak ${peak}, and ${percent}% of samples are flat against ` +
        'the rail. Measured cost at this much flattening is about 1.5 points of word ' +
        'error. Lower the input volume in Settings › System › Sound › Input.'
      );
    case 'hot':
      return (
        `input is hot — peak ${peak} above full scale, but only ${percent}% of samples ` +
        'are flat, and that much was measured to cost nothing. Recorded rather than ' +
        'warned about.'
      );
  }
}

/**
 * Whether the whole-buffer peak falls below `threshold`.
 *
 * THE GATE IS THE PEAK OVER THE WHOLE BUFFER — not RMS, not per-window energy. One loud
 * click anywhere in a 60 s recording defeats it, and that is the shipped behaviour.
 * Nothing trims leading or trailing silence anywhere before transcription.
 *
 * TRUE FOR AN EMPTY BUFFER, because the peak of an empty buffer is 0. That is exactly
 * why the caller must test emptiness FIRST: an empty capture is a broken microphone, and
 * reporting it as the user's silence is the bug that told a user with a dead audio graph
 * that they had said nothing, seven times in one session.
 */
export function isNearSilence(buffer: AudioBuffer, threshold: number): boolean {
  return peakAmplitude(buffer) < threshold;
}

/**
 * Instant attack, exponential release, applied ONCE PER AUDIO BLOCK and not per UI poll.
 * Sources/KotibaAudio/LevelMeter.swift:30.
 */
export const METER_RELEASE = 0.8;
export const METER_ATTACK = 0.2;

/** How often the HUD reads `currentPeak()`. Sources/KotibaUI/DictationController.swift:1175. */
export const METER_POLL_MS = 50;

/**
 * The live meter the HUD polls.
 *
 * The decay exists so a 50 ms poll cannot land between syllables and render silence
 * mid-sentence; tying it to the poll instead of the block makes the meter flicker. It is
 * separate from the capture buffer for the reason the macOS atomic meter is: reading a
 * level must never consume a sample the transcription needs.
 */
export class LevelMeter {
  #smoothed = 0;

  /** One audio block. `peak` is that block's own maximum absolute sample. */
  publishPeak(peak: number): void {
    const previous = this.#smoothed;
    this.#smoothed = peak > previous ? peak : previous * METER_RELEASE + peak * METER_ATTACK;
  }

  publish(samples: Float32Array): void {
    let peak = 0;
    for (const sample of samples) {
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
    this.publishPeak(peak);
  }

  /** Clamped to 0…1 on read, as on macOS. */
  get level(): number {
    return Math.min(1, Math.max(0, this.#smoothed));
  }

  reset(): void {
    this.#smoothed = 0;
  }
}
