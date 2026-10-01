// Where a streaming engine may cut the recording while the user is still speaking — a port
// of `StreamSegmenter` (Sources/KotibaCore/StreamSegmenter.swift), and its Python twin in
// `Scripts/measure/en-ru/sherpa_bench.py`.
//
// PURE arithmetic over samples. Parakeet reads audio in ~15 s windows, so the cheapest
// possible key-release leaves at most one window undecoded — which means that during a long
// hold, every time 14 s has piled up, some of it is decoded and COMMITTED. The only question
// is where to cut, and the answer is the quietest stretch available: a cut through a word
// loses the word on both sides; a cut through a breath loses nothing. It never looks past
// `commitAfter`, so a committed stretch always fits one window.

export interface StreamSegmenter {
  readonly sampleRate: number;
  /** Commit once this many seconds are pending. Below 15 so a commit is one window. */
  readonly commitAfter: number;
  /** Never cut before this far in: a committed stretch has to carry its own context. */
  readonly earliestCut: number;
  /** Energy is measured over frames this long. */
  readonly frame: number;
  /**
   * The width of the quiet stretch looked for. 200 ms is shorter than any sentence pause
   * and longer than the gaps inside a word, which is the distinction that matters.
   */
  readonly quietRun: number;
}

export const DEFAULT_SEGMENTER: StreamSegmenter = {
  sampleRate: 16_000,
  commitAfter: 14,
  earliestCut: 6,
  frame: 0.02,
  quietRun: 0.2,
};

/**
 * Where to cut `pending`, as an offset from its start — or `null` while it is shorter than
 * `commitAfter` and nothing needs committing yet.
 */
export function segmentCut(pending: ArrayLike<number>, segmenter: StreamSegmenter = DEFAULT_SEGMENTER): number | null {
  const limit = Math.trunc(segmenter.commitAfter * segmenter.sampleRate);
  if (pending.length < limit) return null;

  const frameLength = Math.max(1, Math.trunc(segmenter.frame * segmenter.sampleRate));
  const first = Math.trunc(Math.trunc(segmenter.earliestCut * segmenter.sampleRate) / frameLength);
  const last = Math.trunc(limit / frameLength); // exclusive
  const run = Math.max(1, Math.round(segmenter.quietRun / segmenter.frame));
  if (last - first < run) return first * frameLength;

  // Mean square per frame across the search range.
  const energy = new Float64Array(last - first);
  for (let index = 0; index < energy.length; index += 1) {
    const start = (first + index) * frameLength;
    let sum = 0;
    for (let offset = 0; offset < frameLength; offset += 1) {
      const sample = pending[start + offset] ?? 0;
      sum += sample * sample;
    }
    energy[index] = sum / frameLength;
  }

  // Sliding sum over `run` frames; the quietest window wins, and on a tie the LATEST one,
  // so the committed stretch is as long as it can be and the remainder as short.
  let window = 0;
  for (let index = 0; index < run; index += 1) window += energy[index]!;
  let best = window;
  let bestStart = 0;
  for (let start = 1; start <= energy.length - run; start += 1) {
    window += energy[start + run - 1]! - energy[start - 1]!;
    if (window <= best) {
      best = window;
      bestStart = start;
    }
  }
  return (first + bestStart + Math.trunc(run / 2)) * frameLength;
}

/**
 * `samples` up to `after` seconds past the last 20 ms frame whose RMS reaches 3 % of the
 * recording's peak — the speech and a little after it, not whatever the key was held for
 * after the last word. What the Turkish check reads at key-up: its fitted head window was
 * measured on the speech cut where it ends plus 0–300 ms (the Mac's C4 §13, where a clip with
 * 2.4 s of silence after its speech was the one Turkish clip the fitted head let fall under
 * 0.99). The Mac cuts at its stream's Silero speech end; Windows has no speech detector
 * running at key-up on this route, so the same cut by energy — the rule `kotiba-probe`'s replay
 * trims its clips by. Silence throughout returns the input unchanged.
 */
export function untilSpeechEnds(samples: Float32Array, after = 0.3, sampleRate = 16_000): Float32Array {
  const frame = Math.max(1, Math.trunc(0.02 * sampleRate));
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak === 0 || samples.length <= frame) return samples;
  let end = samples.length;
  while (end > frame) {
    let sum = 0;
    for (let index = end - frame; index < end; index += 1) sum += samples[index]! * samples[index]!;
    if (Math.sqrt(sum / frame) >= 0.03 * peak) break;
    end -= frame;
  }
  return samples.subarray(0, Math.min(samples.length, end + Math.trunc(after * sampleRate)));
}
