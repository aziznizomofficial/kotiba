// C2. Where a streaming Uzbek decoder may cut the audio while the user is still talking — a
// port of `SpeechSegmenter` and `EnergyFrameClassifier` (Sources/KotibaCore/SpeechSegmenter.swift),
// rule for rule and default for default. docs/research/C2-uzbek-latency.md §4 measured them.
//
// PURE. One change of SHAPE, none of behaviour: on the Mac the frame classifier is called
// synchronously inside `append`; on Windows Silero runs in `kotiba-stt.exe`, so its answer
// arrives asynchronously. So this takes the per-frame probabilities the caller already has
// (`appendFrames`) and the raw sample count separately (`advance`), and the streaming session
// feeds both in order. `append(samples, classifier)` does the Mac's one-call version for a
// synchronous classifier (energy), and the two produce identical events.
//
// The three rules, each measured on the 344-clip Uzbek harness:
//
//   * ONLY CUT IN A REAL PAUSE: `commitPause` of continuous non-speech, and the cut goes
//     `trailingPadding` after the last speech frame, never at it.
//   * DO NOT CUT TOO EARLY: `minimumSegment` 20 s — 3 s cost 1.28 WER points, 20 s cost 0.09.
//   * NEVER OUTGROW ONE WHISPER WINDOW: past `maximumSegment` the cut is forced into the
//     longest pause of the last third.

export const SAMPLE_RATE = 16_000;

/** Says, frame by frame, how likely each stretch of audio is to be speech. */
export interface SpeechFrameClassifier {
  /** Samples per frame at 16 kHz. Silero: 512 (32 ms). Energy: 320 (20 ms). */
  readonly frameSamples: number;
  /** One probability per whole frame of `samples`. State carries over between calls. */
  probabilities(samples: Float32Array): number[];
  /** A new utterance. */
  reset(): void;
}

/**
 * A causal energy gate: level above a tracked noise floor, mapped onto 0…1 so it can share
 * the segmenter's thresholds with Silero. 12 dB over the floor is 0.5. The fallback when
 * the 885 KB Silero model is absent — it cannot tell a quiet word from a noisy room, which
 * cost whole phrases on the harness (C2 §4), so it is the fallback and never the default.
 */
export class EnergyFrameClassifier implements SpeechFrameClassifier {
  readonly frameSamples = 320;
  /** Below this absolute level nothing is speech. */
  absoluteFloorDB = -55;
  /** How fast the noise floor may rise, per second. It falls instantly. */
  floorRiseDBPerSecond = 3;
  private floorDB: number | null = null;

  probabilities(samples: Float32Array): number[] {
    const out: number[] = [];
    for (let i = 0; i + this.frameSamples <= samples.length; i += this.frameSamples) {
      let sum = 0;
      for (let j = i; j < i + this.frameSamples; j += 1) sum += samples[j]! * samples[j]!;
      // Float32 arithmetic in the Swift; the difference is far below any threshold here.
      const db = 20 * Math.log10(Math.max(Math.sqrt(sum / this.frameSamples), 1e-7));
      const rise = (this.floorRiseDBPerSecond * this.frameSamples) / SAMPLE_RATE;
      const floor = this.floorDB === null ? db : db < this.floorDB ? db : this.floorDB + rise;
      this.floorDB = floor;
      out.push(db < this.absoluteFloorDB ? 0 : Math.min(1, Math.max(0, (db - floor - 2) / 20)));
    }
    return out;
  }

  reset(): void {
    this.floorDB = null;
  }
}

export interface SpeechSegmenterConfiguration {
  /** A frame becomes speech above this probability… */
  readonly onsetProbability: number;
  /** …and stays speech until it falls below this one. Silero's own defaults. */
  readonly releaseProbability: number;
  /** Silence needed before a segment is committed for good. */
  readonly commitPause: number;
  /** Once the pending region is this long, `relaxedCommitPause` is enough to commit. */
  readonly relaxAfter: number;
  readonly relaxedCommitPause: number;
  /**
   * Silence after which the pending audio is worth a speculative decode — the speaker may be
   * about to let go. 0.1 s, down from 0.2 (P2 §3): a release 300 ms after the last word used
   * to find the decode 100 ms old and now finds it 200 ms old, which took the 5–12 s bucket's
   * p50 from 122 to 31 ms on the Mac's tuning clips at the same WER (21.95 %). A pause this
   * short is often a stop inside a word, so the session decodes there but does not CUT there
   * — see `StreamingWhisperConfiguration.cutPause`.
   */
  readonly speculativePause: number;
  /** A committed segment is at least this long — the accuracy knob (C2 §4). */
  readonly minimumSegment: number;
  /** No segment is longer than this; past it the cut is forced. */
  readonly maximumSegment: number;
  /** Kept before detected speech. 0.2 s clipped "oʻn" from "oʻn ming beraman". */
  readonly padding: number;
  /**
   * Kept after speech. Must not exceed `speculativePause`, or a speculation would never match
   * the tail. 0.1 with it (was 0.2): the fitted window adds ~5 s of encoded silence after the
   * span anyway, and the harness scored the same at release + 300 ms.
   */
  readonly trailingPadding: number;
  /** Less speech than this in a region is a click, not a word. */
  readonly minimumSpeech: number;
}

export const DEFAULT_SPEECH_SEGMENTER: SpeechSegmenterConfiguration = {
  onsetProbability: 0.5,
  releaseProbability: 0.35,
  commitPause: 0.5,
  relaxAfter: 22.0,
  relaxedCommitPause: 0.25,
  speculativePause: 0.1,
  minimumSegment: 20.0,
  maximumSegment: 24.0,
  padding: 0.5,
  trailingPadding: 0.1,
  minimumSpeech: 0.1,
};

/** A half-open range of absolute sample indices since the start of the utterance. */
export interface SampleRange {
  readonly lower: number;
  readonly upper: number;
}

/** A stretch of audio the decoder should see. */
export interface Span {
  /** The whole region this span was cut from — what the next span starts after. */
  readonly region: SampleRange;
  /** The padded speech inside it. This is what is decoded. */
  readonly speech: SampleRange;
}

export type SegmentEvent =
  /** Final: everything in `span.region` is settled and will never be re-cut. */
  | { readonly kind: 'commit'; readonly span: Span }
  /** Provisional: the speaker has gone quiet, and if they let go now this is the tail. */
  | { readonly kind: 'pause'; readonly span: Span };

export function sameRange(a: SampleRange, b: SampleRange): boolean {
  return a.lower === b.lower && a.upper === b.upper;
}

/** Swift's `Double.rounded()` — half away from zero. `Math.round` rounds half up. */
function roundHalfAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export class SpeechSegmenter {
  readonly configuration: SpeechSegmenterConfiguration;
  readonly frameSamples: number;

  /** Samples consumed so far, including a partial frame not yet analysed. */
  sampleCount = 0;

  /** Where the last frame classified as speech ends, in samples; 0 before any speech. */
  lastSpeechEnd = 0;

  private pending: Float32Array = new Float32Array(0);
  private readonly speechFrames: boolean[] = [];
  private readonly levels: number[] = [];
  private inSpeech = false;
  private regionStartFrame = 0;
  private silentRun = 0;
  private pauseReported = false;
  private regionSpeechFrames = 0;
  private regionFirstSpeech: number | null = null;
  private regionLastSpeech: number | null = null;

  constructor(frameSamples: number, configuration: SpeechSegmenterConfiguration = DEFAULT_SPEECH_SEGMENTER) {
    this.configuration = configuration;
    this.frameSamples = Math.max(1, frameSamples);
  }

  /** Where the uncommitted region starts. */
  get committedUpTo(): number {
    return this.regionStartFrame * this.frameSamples;
  }

  private frames(seconds: number): number {
    return roundHalfAway((seconds * SAMPLE_RATE) / this.frameSamples);
  }

  /** The Mac's `append`, for a synchronous classifier. */
  append(samples: Float32Array, classifier: SpeechFrameClassifier): SegmentEvent[] {
    this.advance(samples.length);
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    const whole = Math.floor(joined.length / this.frameSamples) * this.frameSamples;
    this.pending = joined.slice(whole);
    if (whole === 0) return [];
    return this.appendFrames(classifier.probabilities(joined.subarray(0, whole)));
  }

  /** Samples arrived. Counted at once: `tail()` ends at the last sample received. */
  advance(samples: number): void {
    this.sampleCount += samples;
  }

  /** Per-frame probabilities for the next consecutive whole frames, in order. */
  appendFrames(probabilities: readonly number[]): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    for (const probability of probabilities) {
      const event = this.analyse(probability);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /**
   * The uncommitted remainder, as the tail to decode at key-release — or `null` when there
   * is no speech in it at all, which is the case that should cost nothing.
   */
  tail(): Span | null {
    const end = this.sampleCount;
    const speech = this.regionSpeech(end);
    if (speech === null) return null;
    return { region: { lower: this.committedUpTo, upper: end }, speech };
  }

  private analyse(probability: number): SegmentEvent | null {
    this.levels.push(probability);
    const threshold = this.inSpeech ? this.configuration.releaseProbability : this.configuration.onsetProbability;
    const speech = probability >= threshold;
    this.inSpeech = speech;
    this.speechFrames.push(speech);
    if (speech) {
      this.silentRun = 0;
      this.pauseReported = false;
      const index = this.speechFrames.length - 1;
      this.lastSpeechEnd = (index + 1) * this.frameSamples;
      this.regionSpeechFrames += 1;
      if (this.regionFirstSpeech === null) this.regionFirstSpeech = index;
      this.regionLastSpeech = index;
    } else {
      this.silentRun += 1;
    }
    return this.decide();
  }

  private decide(): SegmentEvent | null {
    const c = this.configuration;
    const now = this.speechFrames.length;
    const regionLength = now - this.regionStartFrame;
    const hasSpeech = this.regionSpeechFrames >= this.frames(c.minimumSpeech);

    const pauseNeeded = regionLength >= this.frames(c.relaxAfter) ? c.relaxedCommitPause : c.commitPause;
    if (hasSpeech && this.silentRun >= this.frames(pauseNeeded) && regionLength >= this.frames(c.minimumSegment)) {
      // Cut `trailingPadding` after the last speech frame, never past the middle of the
      // pause: the next segment's onset gets the other half.
      const lastSpeech = now - this.silentRun;
      const cut = lastSpeech + Math.min(this.frames(c.trailingPadding), Math.floor(this.silentRun / 2));
      return this.commit(cut, now);
    }

    if (regionLength >= this.frames(c.maximumSegment)) {
      // A long stretch with no speech is let go without a decode.
      if (!hasSpeech) {
        this.commit(now, now);
        return null;
      }
      return this.commit(this.forcedCut(now), now);
    }

    // Not before the trailing padding has been captured either: the span reported here
    // must equal the one `tail()` gives at release, or the session cannot adopt the
    // decode. With Silero's 32 ms frames 0.2 s rounded to 192 ms — 128 samples short — and
    // every speculation silently failed to match until this `max` (C2 §5); at 0.1 s it is
    // 3 frames (96 ms) against 4 (128 ms) of padding, and the `max` still decides.
    const trailFrames = Math.ceil((c.trailingPadding * SAMPLE_RATE) / this.frameSamples);
    if (hasSpeech && !this.pauseReported && this.silentRun >= Math.max(this.frames(c.speculativePause), trailFrames)) {
      this.pauseReported = true;
      const end = now * this.frameSamples;
      const speech = this.regionSpeech(end);
      if (speech !== null) {
        return { kind: 'pause', span: { region: { lower: this.committedUpTo, upper: end }, speech } };
      }
    }
    return null;
  }

  /** Moves the region start to `cutFrame` and reports what was cut off, if it held speech. */
  private commit(cutFrame: number, now: number): SegmentEvent | null {
    const cut = Math.min(now, Math.max(this.regionStartFrame + 1, cutFrame));
    const region = { lower: this.committedUpTo, upper: cut * this.frameSamples };
    const speech =
      this.regionSpeechFrames >= this.frames(this.configuration.minimumSpeech)
        ? this.speechSpan(this.regionStartFrame, cut, region.upper)
        : null;
    this.regionStartFrame = cut;
    // What remains after the cut is re-counted: a forced cut can leave speech on both sides.
    this.regionSpeechFrames = 0;
    this.regionFirstSpeech = null;
    this.regionLastSpeech = null;
    for (let i = cut; i < now; i += 1) {
      if (!this.speechFrames[i]) continue;
      this.regionSpeechFrames += 1;
      if (this.regionFirstSpeech === null) this.regionFirstSpeech = i;
      this.regionLastSpeech = i;
    }
    // The pause that produced this cut is spent; the next one must be a new pause.
    this.pauseReported = this.regionSpeechFrames === 0;
    if (speech === null) return null;
    return { kind: 'commit', span: { region, speech } };
  }

  /** The middle of the longest pause in the last third, or its least speech-like frame. */
  private forcedCut(now: number): number {
    const window = Math.max(1, Math.floor((now - this.regionStartFrame) / 3));
    const lower = now - window;
    let bestStart = -1;
    let bestLength = 0;
    let runStart = -1;
    for (let i = lower; i < now; i += 1) {
      if (!this.speechFrames[i]) {
        if (runStart < 0) runStart = i;
        const length = i - runStart + 1;
        if (length > bestLength) {
          bestLength = length;
          bestStart = runStart;
        }
      } else {
        runStart = -1;
      }
    }
    if (bestLength >= 3) return bestStart + Math.floor(bestLength / 2);
    let quietest = lower;
    for (let i = lower; i < now; i += 1) if (this.levels[i]! < this.levels[quietest]!) quietest = i;
    return quietest + 1;
  }

  private regionSpeech(sampleEnd: number): SampleRange | null {
    if (
      this.regionSpeechFrames < this.frames(this.configuration.minimumSpeech) ||
      this.regionFirstSpeech === null ||
      this.regionLastSpeech === null
    ) {
      return null;
    }
    return this.padded(this.regionFirstSpeech, this.regionLastSpeech, this.committedUpTo, sampleEnd);
  }

  private speechSpan(lower: number, upper: number, sampleEnd: number): SampleRange | null {
    if (lower >= upper) return null;
    let first = -1;
    let last = -1;
    for (let i = lower; i < upper; i += 1) {
      if (!this.speechFrames[i]) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0) return null;
    return this.padded(first, last, lower * this.frameSamples, sampleEnd);
  }

  private padded(first: number, last: number, regionStart: number, sampleEnd: number): SampleRange | null {
    const lead = Math.trunc(this.configuration.padding * SAMPLE_RATE);
    const trail = Math.trunc(this.configuration.trailingPadding * SAMPLE_RATE);
    const start = Math.max(regionStart, first * this.frameSamples - lead);
    const end = Math.min(sampleEnd, (last + 1) * this.frameSamples + trail);
    return start < end ? { lower: start, upper: end } : null;
  }
}

// ---------------------------------------------------------------------------------
// SegmentText — join, prompt carry, loop detection (Sources/KotibaCore/StreamingTranscription.swift)
// ---------------------------------------------------------------------------------

/** Decoded segments joined with single spaces, empties dropped. No case or punctuation repair. */
export function joinSegments(segments: readonly string[]): string {
  return segments
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
    .join(' ');
}

/**
 * The decoder prompt for the next segment: the style hint, then the end of what has been
 * transcribed so far, cut at a word boundary. Hint first: whisper keeps the LAST half-context
 * of prompt tokens, and the text nearest the audio is what carries a sentence across a cut.
 */
export function segmentPrompt(hint: string | null, previous: string, carry: number): string | null {
  const parts: string[] = [];
  if (hint !== null && hint !== '') parts.push(hint);
  if (carry > 0) {
    const trimmed = previous.trim();
    const characters = [...trimmed];
    if (characters.length > carry) {
      const cut = characters.length - carry;
      const tail = characters.slice(cut);
      if (/\s/u.test(characters[cut - 1]!)) {
        parts.push(tail.join(''));
      } else {
        const space = tail.findIndex((ch) => /\s/u.test(ch));
        parts.push(space >= 0 ? tail.slice(space + 1).join('') : tail.join(''));
      }
    } else if (trimmed !== '') {
      parts.push(trimmed);
    }
  }
  return parts.length === 0 ? null : parts.join(' ');
}

function normalisedWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{Alphabetic}\p{N}'ʻ]+/u)
    .filter((word) => word !== '');
}

/**
 * Whether a decoded segment looks like the decoder looping: the same n-gram three times
 * running (a single word five times), or a four-word-plus segment wholly contained in the
 * end of the prompt. A caller that sees true re-decodes without the carried text.
 */
export function looksLikeALoop(text: string, previous: string): boolean {
  const words = normalisedWords(text);
  if (words.length === 0) return false;
  for (let n = 1; n <= 4; n += 1) {
    if (words.length < n * 3) continue;
    for (let i = 0; i + n * 3 <= words.length; i += 1) {
      let repeated = true;
      for (let k = 0; k < n && repeated; k += 1) {
        if (words[i + k] !== words[i + n + k] || words[i + k] !== words[i + 2 * n + k]) repeated = false;
      }
      if (!repeated) continue;
      if (n > 1) return true;
      if (i + 5 <= words.length && words.slice(i, i + 5).every((word) => word === words[i])) return true;
    }
  }
  const before = normalisedWords(previous);
  if (words.length >= 4 && before.length >= words.length) {
    const tail = before.slice(-Math.max(words.length * 3, 24));
    for (let start = 0; start + words.length <= tail.length; start += 1) {
      if (words.every((word, k) => tail[start + k] === word)) return true;
    }
  }
  return false;
}

/**
 * `WhisperEngine.AudioContext.fitted(margin:)`: encoder positions for `sampleCount` samples
 * plus `margin`, rounded up to a multiple of 256, or 0 ("the model's window") when that
 * reaches it. 50 positions a second; 256 of margin is the 5 s of encoded silence this
 * fine-tune needs to find end-of-text (no margin: 30.70 % WER against 21.86 %, C2 §3).
 */
export function fittedAudioContext(sampleCount: number, margin = 256, modelWindow = 1500): number {
  const needed = Math.floor((sampleCount + 319) / 320) + Math.max(0, margin);
  const rounded = Math.ceil(needed / 256) * 256;
  return rounded >= modelWindow ? 0 : rounded;
}
