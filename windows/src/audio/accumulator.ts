// The capture accumulator — one take's growing store, with the Mac's semantics.
//
// Sources/KotibaAudio/AudioRingBuffer.swift:28. The macOS ring is lock-free SPSC because
// its producer is a Core Audio render callback that may not allocate or block. Here the
// producer is an `AudioWorkletProcessor` in another process and the samples arrive as
// already-copied messages, so the lock-free machinery has no job to do — but the
// USER-VISIBLE behaviour it defined does, and that is what this reproduces:
//
//   - a ceiling (30 minutes), stated and reported rather than a buffer size;
//   - overflow drops the NEWEST samples and keeps the OLDEST;
//   - what was dropped is COUNTED, never silently discarded, because a truncation with
//     no telemetry is how a short transcript gets blamed on the engine;
//   - the count resets per dictation, at `reset()`, not at drain.
//
// Pure. No Node, no Electron, no DOM.

import { SAMPLE_RATE } from '../contracts/index.js';

/**
 * The ceiling of one take: 30 minutes of 16 kHz audio, 28.8 M samples, 115 MB.
 *
 * A DELIBERATE LIMIT, NOT A BUFFER SIZE — the Mac's `CapturePipeline.ceilingSeconds`. The
 * old capacity here was the Mac's 120-second ring expression rounded up to a power of two,
 * 2^23 samples, and at 16 kHz that is 524 s: the "long holds forget what I said" truncation
 * the Mac measured at 174.76 s, with a bigger number. The store now grows as the take
 * does, and reaching the ceiling is REPORTED (`onLimit` on the take), so the dictation is
 * finished as though the key had come up and the user is told why.
 */
export const CAPTURE_CEILING_SECONDS = 30 * 60;

/** Samples in a take of `ceilingSeconds`. */
export function capacityFor(ceilingSeconds: number): number {
  const samples = Math.trunc(SAMPLE_RATE * ceilingSeconds);
  if (samples <= 0) throw new RangeError('ceilingSeconds must be positive');
  return samples;
}

/** Everything one dictation captured, plus what it lost. */
export interface Captured {
  readonly samples: Float32Array;
  readonly droppedSamples: number;
}

export class CaptureAccumulator {
  readonly capacity: number;
  #blocks: Float32Array[] = [];
  #length = 0;
  #dropped = 0;

  constructor(ceilingSeconds: number = CAPTURE_CEILING_SECONDS) {
    this.capacity = capacityFor(ceilingSeconds);
  }

  /** The ceiling has been reached: from here on every sample is dropped and counted. */
  get isFull(): boolean {
    return this.#length >= this.capacity;
  }

  /** How many samples are held. */
  get length(): number {
    return this.#length;
  }

  /**
   * How many samples this dictation lost. Never self-resets — `reset()` clears it, and
   * `reset()` runs at `start()`, so the count is per dictation exactly as on macOS.
   */
  get dropped(): number {
    return this.#dropped;
  }

  /**
   * Append one block. Returns how many samples were taken.
   *
   * Overflow keeps the OLDEST audio and drops the NEWEST — pinned on macOS by the test
   * "the buffer keeps the OLDEST audio, not the newest". The producer never retries and
   * never blocks: a block that does not fit is genuinely lost and genuinely counted.
   */
  write(block: Float32Array): number {
    const room = this.capacity - this.#length;
    if (room <= 0) {
      this.#dropped += block.length;
      return 0;
    }
    if (block.length <= room) {
      this.#blocks.push(block);
      this.#length += block.length;
      return block.length;
    }
    this.#blocks.push(block.subarray(0, room));
    this.#length += room;
    this.#dropped += block.length - room;
    return room;
  }

  /**
   * Everything captured, in order, as one contiguous buffer. Does NOT reset — `start()`
   * does, exactly as on macOS, so a `stop()` called twice yields the same audio rather
   * than yielding it once and then lying about silence.
   */
  drain(): Captured {
    const samples = new Float32Array(this.#length);
    let offset = 0;
    for (const block of this.#blocks) {
      samples.set(block, offset);
      offset += block.length;
    }
    return { samples, droppedSamples: this.#dropped };
  }

  /** Clears BOTH the pending samples and the dropped counter. */
  reset(): void {
    this.#blocks = [];
    this.#length = 0;
    this.#dropped = 0;
  }
}
