// src/audio — capture, resample, peak, silence.  OWNER: t08
//
// D-W6: THE MICROPHONE IS A HIDDEN RENDERER, NOT WASAPI. `getUserMedia` plus an
// `AudioWorklet` in an offscreen `BrowserWindow`, with `new AudioContext({ sampleRate:
// 16000 })` so the browser's own high-quality resampler produces the 16 kHz mono float
// whisper wants. This is the one place a native path was tempting and is wrong: the macOS
// resampler had a bug that THREW AWAY UZBEK SIBILANTS, and hand-writing a resampler in a
// codebase nobody here can listen to is how that recurs. `resample-probe.ts` measures the
// browser's rather than trusting it.
//
// May use Node. Does NOT import `electron` — the hidden window is created by `src/main`
// and reaches this module as an `AudioHost` (see `host.ts`), which is also what lets the
// whole state machine be tested with no browser and no microphone.
//
// WHAT IS NOT HERE, DELIBERATELY:
//
//   - The "heard nothing" DECISION and the clipping notes' PLACEMENT. This module
//     measures; `DictationSession` (t09) decides, because that is where macOS decides.
//   - `SilenceTrimmer`, `EnergyDetector`, `MelSpectrogram`. All three are written, tested
//     and called from nowhere in the shipping macOS app. The real "did we hear anything"
//     rule is one whole-buffer peak comparison, and nothing trims silence before
//     transcription.

export {
  CLIPPING_THRESHOLD,
  FLATTENING_FRACTION,
  LevelMeter,
  METER_ATTACK,
  METER_POLL_MS,
  METER_RELEASE,
  SATURATED,
  SILENCE_THRESHOLD,
  SILENCE_THRESHOLD_RANGE,
  clippingNote,
  isNearSilence,
  measureLevel,
  saturatedFraction,
  type LevelReport,
} from './levels.js';

export {
  CAPTURE_CEILING_SECONDS,
  CaptureAccumulator,
  capacityFor,
  type Captured,
} from './accumulator.js';

export { WavError, decodeWav, encodeWav, readWavFile, type DecodedWav } from './wav.js';

export { createBufferSource, createWavFileSource } from './wav-source.js';

export {
  DEVICE_CHANGED_MESSAGE,
  WARM_HOLD_MS,
  createAudioCapture,
  createMicrophoneCapture,
  type MicrophoneCaptureOptions,
} from './capture.js';

export type {
  AudioHost,
  AudioHostCommand,
  AudioHostEvent,
  AudioHostReply,
  Unsubscribe,
} from './host.js';

export {
  CAPTURE_PAGE_HTML,
  CAPTURE_RENDERER_SOURCE,
  CAPTURE_WORKLET_SOURCE,
} from './renderer-source.js';

export {
  ALIAS_REJECTION_DB,
  ALIAS_TONE,
  PASSBAND_TOLERANCE_DB,
  PASSBAND_TONES,
  MEASURED_CHROMIUM,
  RESAMPLE_PROBE_SOURCE,
  aliasFrequency,
  decibels,
  magnitudeAt,
  measureResampler,
  sweep,
  tone,
  type ResampleMeasurement,
  type ResampleReport,
  type Resampler,
} from './resample-probe.js';
