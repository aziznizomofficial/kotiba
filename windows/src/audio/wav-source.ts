// A committed WAV clip standing in for the microphone.
//
// Port of Sources/KotibaAudio/WAVFileSource.swift:153. Same interface as the live capture,
// no device, no permission, no browser — which is what makes `--check` (D-W10) able to
// run the whole pipeline on a runner that has no audio hardware, and what makes a test
// able to drive ten consecutive dictations without a dialog.
//
// Deterministic by construction. No test may ever open the real microphone.

import type { AudioBuffer, AudioCapture, AudioTake, AudioTakeOptions } from '../contracts/index.js';
import { peakAmplitude } from '../contracts/index.js';
import { readWavFile } from './wav.js';

const EMPTY: AudioBuffer = { samples: new Float32Array(0), droppedSamples: 0 };

class WavFileSource implements AudioCapture {
  readonly #load: () => Promise<AudioBuffer>;
  #buffer: AudioBuffer | null;
  #started = false;
  #warmUpCount = 0;
  #warm = false;
  #lastWarmUpError: string | null = null;

  constructor(load: () => Promise<AudioBuffer>, buffer: AudioBuffer | null = null) {
    this.#load = load;
    this.#buffer = buffer;
  }

  get isWarm(): boolean {
    return this.#warm;
  }

  get lastWarmUpError(): string | null {
    return this.#lastWarmUpError;
  }

  /** Counted so a test can assert warm-up happens on every foreground rather than once. */
  get warmUpCount(): number {
    return this.#warmUpCount;
  }

  async warmUp(): Promise<void> {
    this.#warmUpCount += 1;
    try {
      this.#buffer ??= await this.#load();
      this.#warm = true;
      this.#lastWarmUpError = null;
    } catch (error) {
      // Same contract as the microphone: warm-up reports through state, never by throwing.
      this.#warm = false;
      this.#lastWarmUpError = error instanceof Error ? error.message : String(error);
    }
  }

  async start(): Promise<void> {
    if (!this.#warm) await this.warmUp();
    this.#started = true;
  }

  /** Nothing when it was never started, rather than stale audio. */
  async stop(): Promise<AudioBuffer> {
    if (!this.#started) return EMPTY;
    this.#started = false;
    return this.#buffer ?? EMPTY;
  }

  /**
   * One take replays the whole clip, delivered as ONE chunk at stop — a file has no live
   * stream. Takes do not overlap here (`--check` presses once), so there is nothing to
   * seal.
   */
  openTake(_options?: AudioTakeOptions): AudioTake {
    const listeners = new Set<(samples: Float32Array) => void>();
    let started = false;
    return {
      start: async () => {
        await this.start();
        started = true;
      },
      stop: async () => {
        if (!started) return EMPTY;
        started = false;
        const buffer = await this.stop();
        for (const listener of listeners) listener(buffer.samples);
        return buffer;
      },
      onChunk: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  /**
   * The clip's own whole-buffer peak, so a HUD driven by a fixture is not dead flat.
   * There is no live meter here — nothing is arriving.
   */
  currentPeak(): number {
    return this.#buffer === null ? 0 : Math.min(1, peakAmplitude(this.#buffer));
  }

  async dispose(): Promise<void> {
    this.#buffer = null;
    this.#warm = false;
  }
}

/** A capture source that replays one 16 kHz mono WAV. Loaded lazily, on the first warm-up. */
export function createWavFileSource(path: string): AudioCapture {
  return new WavFileSource(() => readWavFile(path));
}

/** The same, over samples already in memory — for tests that generate their own audio. */
export function createBufferSource(buffer: AudioBuffer): AudioCapture {
  return new WavFileSource(async () => buffer, buffer);
}
