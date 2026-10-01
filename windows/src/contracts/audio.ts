// The finalised audio a dictation hands to an engine. Ported from
// Sources/KotibaCore/Contracts.swift:37-70.

/** The one definition of the target rate. Everything derives from it. */
export const SAMPLE_RATE = 16_000;

/**
 * What kind of input it is. The strings are what `diagnostics.jsonl` carries and what the Mac
 * writes for the same field (`InputTransport`, Sources/KotibaCore/InputDevice.swift).
 */
export const INPUT_TRANSPORTS = ['builtIn', 'bluetooth', 'usb', 'continuity', 'virtual', 'other'] as const;
export type InputTransport = (typeof INPUT_TRANSPORTS)[number];

/**
 * The input device a take was recorded from. Ported from `InputDeviceInfo` (Mac:
 * Sources/KotibaCore/InputDevice.swift). The name may be personal ("Aziz’s iPhone
 * Microphone") and so never reaches the plain-text diagnostics summary.
 */
export interface InputDeviceInfo {
  readonly name: string;
  readonly transport: InputTransport;
  /** The device's own rate in Hz, before the capture host resampled to 16 kHz. */
  readonly sampleRate?: number;
  /**
   * Whether Kotiba chose the device itself instead of following the system default. Always
   * `false` here: Windows capture passes no device id, so the system default is what it gets.
   */
  readonly overrodeDefault?: boolean;
}

/**
 * A finalised mono 16 kHz Float32 buffer. Engines take this; nothing takes a file path.
 */
export interface AudioBuffer {
  /** Mono, 16 kHz, nominally −1…1 (a high-quality resampler overshoots to ~+1.15 dB). */
  readonly samples: Float32Array;

  /**
   * How many samples capture threw away because nothing drained the ring in time.
   *
   * Non-zero means the recording is SHORT: the user said more than this buffer holds.
   * On macOS this count was written to the microphone-permission field, so lost audio
   * reached the user as "grant microphone access". It has its own field here for that
   * reason — do not fold it into an error string.
   */
  readonly droppedSamples: number;

  /**
   * The microphone this recording came from, when the source knows (the capture host does;
   * a WAV file does not). It travels with the audio because the session is the only place
   * the diagnostics record is written.
   */
  readonly device?: InputDeviceInfo;
}

/** `samples.length / 16000`. */
export function audioDuration(buffer: AudioBuffer): number {
  return buffer.samples.length / SAMPLE_RATE;
}

/** `droppedSamples / 16000`. */
export function droppedSeconds(buffer: AudioBuffer): number {
  return buffer.droppedSamples / SAMPLE_RATE;
}

/**
 * Peak absolute amplitude over the WHOLE buffer.
 *
 * The near-silence gate keys off this, and it is why roughly a third of the predecessor's
 * dictations returned an empty string instead of saying it heard nothing: empty results
 * had a median peak of 0.0018 against 0.1326 for successful ones.
 */
export function peakAmplitude(buffer: AudioBuffer): number {
  let peak = 0;
  for (const sample of buffer.samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}
