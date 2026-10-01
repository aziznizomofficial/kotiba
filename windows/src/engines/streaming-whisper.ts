// C2. Uzbek transcribed while the key is still held, so key-release pays only for the tail —
// a port of `StreamingWhisperSession` and `StreamingWhisperEngine`
// (Sources/KotibaEngines/StreamingWhisperSession.swift), decision for decision.
//
// A whole-utterance decode starts at release and costs the full encoder window plus every
// token of the utterance. This session takes the capture stream instead and does three kinds
// of work behind the speaker:
//
//   * COMMIT — `SpeechSegmenter` found a real pause after at least 20 s. That segment is
//     final and is decoded now, with the text before it carried in as the prompt.
//   * SPECULATE — the speaker went quiet for `speculativePause` (0.1 s). They may be about to
//     let go, so the pending audio is decoded now, provisionally, with an encoder window
//     fitted to it. If they let go without saying more, that decode IS the tail and release
//     costs a join. A newer pause supersedes it (aborted in the host — whisper polls the
//     flag); one that finished becomes the `prefix`, and release decodes only what came after
//     it — provided the pause it ended at lasted `cutPause` (0.2 s), because a 0.1 s pause is
//     often a stop inside a word.
//   * TAIL — at `finish()`, whatever is left after the last commit, unless a speculation
//     already covers exactly that audio.
//
// It is a `TranscriptionStream`, the contract Parakeet's stream meets, so the session drives
// both the same way. As that contract demands, the finalised recording is authoritative:
// whatever the stream cannot vouch for — another language, lost samples, a stream never fed —
// is decoded in batch instead.
//
// What is Windows-specific is only WHERE things run: Silero answers from `kotiba-stt.exe`'s
// reader thread (so asynchronously — the segmenter is fed its probabilities in order through
// one chain), and the abort is a message to the host rather than a pointer whisper polls.

import {
  EngineFailure,
  engineError,
  type AudioBuffer,
  type Language,
  type StreamingSttEngine,
  type TranscriptionStream,
  type TranscriptResult,
} from '../contracts/index.js';
import {
  DEFAULT_SPEECH_SEGMENTER,
  EnergyFrameClassifier,
  SAMPLE_RATE,
  SpeechSegmenter,
  fittedAudioContext,
  joinSegments,
  looksLikeALoop,
  sameRange,
  segmentPrompt,
  type SampleRange,
  type SpeechSegmenterConfiguration,
  type Span,
} from '../core/stt/speech-segmenter.js';

import type { HostSpeechDetector, SegmentDecode, SegmentDecodingEngine } from './stt-engine.js';

/** What the session needs from a decoder. `SegmentDecoding` in the Swift. */
export type SegmentDecoder = Pick<SegmentDecodingEngine, 'engineId' | 'mixesWindowsSafely' | 'decodeSegment' | 'transcribe'>;

/** A speech detector the session can await — Silero in the host, or energy in-process. */
export interface AsyncSpeechDetector {
  readonly frameSamples: number;
  probabilities(samples: Float32Array): Promise<number[]>;
  close(): Promise<void>;
}

/** The energy gate, as an `AsyncSpeechDetector`. The fallback when Silero is absent. */
export function energyDetector(): AsyncSpeechDetector {
  const classifier = new EnergyFrameClassifier();
  return {
    frameSamples: classifier.frameSamples,
    probabilities: async (samples) => classifier.probabilities(samples),
    close: async () => undefined,
  };
}

export interface StreamingWhisperConfiguration {
  readonly segmenter: SpeechSegmenterConfiguration;
  /** `vocabularyHint` — the same string the batch path sends as `initialPrompt`. */
  readonly hint: string | null;
  /** Characters of transcribed text carried into each segment's prompt. 0 turns it off. */
  readonly carryCharacters: number;
  /** Decode provisionally at short pauses. */
  readonly speculate: boolean;
  /** At release, keep the last finished speculation and decode only what came after it. */
  readonly cutAtLastPause: boolean;
  /**
   * Release cuts only at a pause at least this long, however soon the pause was decoded. A
   * pause decode starts at `segmenter.speculativePause`; one that short is often the closure
   * inside a word, and cutting there cost 0.26 WER points at release on the last syllable
   * (C2 §5, P2 §3), where the decode itself — adopted whole — cost nothing.
   */
  readonly cutPause: number;
  /** No speech detected, yet audio this loud: decode it whole rather than return nothing. */
  readonly fallbackPeak: number;
  /**
   * A pause decode already RUNNING is not aborted by a newer pause; the newest pause waits and
   * is decoded when it finishes (one at a time, never a queue). For a decoder slower than the
   * pauses come — Cohere on a CPU (C4 §14.4): at 0.15–0.2 s per second of audio, every pause
   * restarted a decode of the whole uncommitted region, and the user waited at release for the
   * last restart. Off for whisper, whose decodes keep up (the Mac's behaviour, C2).
   */
  readonly coalesceSpeculations: boolean;
}

export const DEFAULT_STREAMING_WHISPER: StreamingWhisperConfiguration = {
  segmenter: DEFAULT_SPEECH_SEGMENTER,
  hint: null,
  carryCharacters: 200,
  speculate: true,
  cutAtLastPause: true,
  cutPause: 0.2,
  fallbackPeak: 0.02,
  coalesceSpeculations: false,
};

export type TailKind = 'none' | 'speculation' | 'prefix' | 'decoded' | 'fallback' | 'batch';

/** What one utterance cost, for diagnostics and the probe. */
export interface StreamingReport {
  commits: number;
  speculations: number;
  aborted: number;
  retries: number;
  /** How the tail was settled. */
  tail: TailKind;
  /** Seconds of speech decoded after release. */
  tailSeconds: number;
  finishMilliseconds: number;
}

interface Speculation {
  readonly span: Span;
  readonly result: Promise<string | null>;
  readonly abort: AbortController;
  /** Its decode has started (it is past the commit chain) and has not finished. */
  running: boolean;
}

type Kind = 'commit' | 'speculation' | 'tail';

export class StreamingWhisperSession implements TranscriptionStream {
  readonly language: Language;
  readonly report: StreamingReport = {
    commits: 0,
    speculations: 0,
    aborted: 0,
    retries: 0,
    tail: 'none',
    tailSeconds: 0,
    finishMilliseconds: 0,
  };

  private readonly engine: SegmentDecoder;
  private readonly configuration: StreamingWhisperConfiguration;
  private readonly detectorReady: Promise<AsyncSpeechDetector>;
  private segmenter: SpeechSegmenter | null = null;
  /** Every sample received, from `base` on. Committed audio is dropped as the session goes. */
  private samples = new Float32Array(SAMPLE_RATE * 30);
  private length = 0;
  private base = 0;
  private received = 0;
  /** Samples not yet handed to the detector. */
  private unanalysed = 0;
  /** Detector calls and the segmenter decisions that follow them, strictly in order. */
  private analysis: Promise<void> = Promise.resolve();
  private texts: string[] = [];
  /** Commits decode strictly in order: each one's prompt is the text of those before it. */
  private chain: Promise<void> = Promise.resolve();
  private failure: string | null = null;
  private speculation: Speculation | null = null;
  /** `coalesceSpeculations`: the newest pause, waiting for the running decode to finish. */
  private waitingPause: Span | null = null;
  private prefix: { readonly span: Span; readonly text: string } | null = null;
  /**
   * Where speech ended before a pause that lasted `cutPause` (the `speech.upper` of the span
   * a pause decode was made of). Only a pause decode ending at one of these is a cut.
   */
  private cutPoints = new Set<number>();
  /**
   * Every finished pause decode of the uncommitted region, oldest first. `prefix` is the
   * last of them; release cuts at the newest one that ends at a cut point, which need not be
   * the newest — a 0.1 s pause decode after it is shown as progress but is no place to cut.
   */
  private finishedPauses: { readonly span: Span; readonly text: string }[] = [];
  private sessionAbort = new AbortController();
  private running = true;
  private fittedAllowed: boolean | null = null;
  private generation = 0;
  private readonly listeners = new Set<(text: string) => void>();

  constructor(options: {
    readonly engine: SegmentDecoder;
    readonly language?: Language;
    readonly configuration?: Partial<StreamingWhisperConfiguration>;
    /** Resolved lazily: opening a stream must never wait on anything. */
    readonly detector?: Promise<AsyncSpeechDetector>;
  }) {
    this.engine = options.engine;
    this.language = options.language ?? 'uz';
    this.configuration = { ...DEFAULT_STREAMING_WHISPER, ...options.configuration };
    this.detectorReady = (options.detector ?? Promise.resolve(energyDetector())).catch(() => energyDetector());
  }

  /** Whether a running pause decode survives a newer pause (for the engine's tests). */
  get coalescesSpeculations(): boolean {
    return this.configuration.coalesceSpeculations;
  }

  onCommit(listener: (text: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- TranscriptionStream ----------------------------------------------------------

  /** Cheap: buffering and segmentation. The first decode loads the model if it is cold. */
  append(chunk: Float32Array): void {
    if (!this.running || chunk.length === 0) return;
    this.push(chunk);
    this.received += chunk.length;
    this.unanalysed += chunk.length;
    this.scheduleAnalysis();
  }

  async finish(audio: AudioBuffer, language: Language): Promise<TranscriptResult> {
    if (!this.running) throw new EngineFailure(engineError.transcriptionFailed('stream already finished'));
    const fed = this.received;
    if (language !== this.language || audio.droppedSamples > 0 || fed === 0 || fed > audio.samples.length) {
      this.discard();
      this.report.tail = 'batch';
      return this.engine.transcribe(audio, language);
    }
    if (fed < audio.samples.length) this.append(audio.samples.subarray(fed));
    this.running = false;
    const started = Date.now();
    try {
      await this.analysis;
      const segmenter = this.segmenter;
      const tail = segmenter?.tail() ?? null;
      if (tail !== null) {
        this.report.tailSeconds = (tail.speech.upper - tail.speech.lower) / SAMPLE_RATE;
        const speculation = this.speculation;
        if (speculation !== null && sameRange(speculation.span.speech, tail.speech)) {
          // The speaker stopped, waited, and let go: the tail was decoded while they waited.
          this.speculation = null;
          await this.chain;
          const text = await speculation.result;
          if (text !== null) {
            this.report.tail = 'speculation';
            this.texts.push(text);
            this.report.tailSeconds = 0;
          } else {
            // The pause decode failed (nothing aborts the current one but a newer pause, a
            // commit or standing down, and each of those clears it first). `?? ''` here pasted
            // the commits with the last sentence missing, or reported a spoken dictation as
            // heard-nothing: the tail is decoded after all.
            this.report.tail = 'decoded';
            this.texts.push((await this.decodeTail(tail.speech)) ?? '');
          }
        } else {
          this.waitingPause = null;
          const cutAnywhere = this.configuration.cutPause <= this.configuration.segmenter.speculativePause;
          if (
            speculation !== null &&
            this.configuration.coalesceSpeculations &&
            speculation.span.region.lower === tail.region.lower &&
            (cutAnywhere || this.cutPoints.has(speculation.span.speech.upper))
          ) {
            // A slow decoder's last pause decode is most of the tail: let it finish and cut there
            // (`cuttablePrefix`) rather than throw it away and decode everything again.
            await speculation.result;
          } else if (speculation !== null) {
            speculation.abort.abort();
            this.report.aborted += 1;
          }
          this.speculation = null;
          await this.chain;
          const prefix = this.cuttablePrefix(tail);
          if (prefix !== null) {
            // The speaker paused, the pause was decoded, then they said more and let go
            // without pausing again. Keep what the pause decode said; decode the rest.
            this.report.tail = 'prefix';
            this.texts.push(prefix.text);
            const rest = { lower: prefix.span.speech.upper, upper: tail.speech.upper };
            this.report.tailSeconds = (rest.upper - rest.lower) / SAMPLE_RATE;
            this.texts.push((await this.decodeTail(rest)) ?? '');
          } else {
            this.report.tail = 'decoded';
            this.texts.push((await this.decodeTail(tail.speech)) ?? '');
          }
        }
      } else {
        this.speculation?.abort.abort();
        this.speculation = null;
        await this.chain;
        // No speech detected anywhere, yet something audible was recorded — singing, speech
        // under loud music. An empty paste after the user spoke is the "it forgot what I
        // said" bug, so the audio goes to the model whole and whisper's own gate decides.
        const whole = { lower: this.base, upper: this.base + this.length };
        const all = this.slice(whole);
        if (joinSegments(this.texts) === '' && all.length >= SAMPLE_RATE / 2 && peak(all) >= this.configuration.fallbackPeak) {
          this.report.tail = 'fallback';
          this.report.tailSeconds = all.length / SAMPLE_RATE;
          this.texts.push((await this.decodeTail(whole)) ?? '');
        }
      }

      if (this.failure !== null) {
        this.discard();
        this.report.tail = 'batch';
        return this.engine.transcribe(audio, language);
      }
      return { raw: joinSegments(this.texts), language, engineId: this.engine.engineId };
    } finally {
      this.report.finishMilliseconds = Date.now() - started;
      void this.detectorReady.then((detector) => detector.close()).catch(() => undefined);
    }
  }

  cancel(): void {
    this.discard();
  }

  /**
   * The newest finished pause decode that ends at a cut point (a pause of `cutPause`), when
   * the tail may be cut at it:
   * the same region, the same start, and at least a quarter-second said after it — or the
   * "rest" is a sliver of silence that whisper answers by repeating its prompt (22 % → 39 %
   * WER on the harness before that guard).
   */
  private cuttablePrefix(tail: Span): { readonly span: Span; readonly text: string } | null {
    const c = this.configuration;
    const cutAnywhere = c.cutPause <= c.segmenter.speculativePause;
    let prefix: { readonly span: Span; readonly text: string } | null = null;
    for (let i = this.finishedPauses.length - 1; i >= 0 && prefix === null; i -= 1) {
      const candidate = this.finishedPauses[i];
      if (candidate !== undefined && (cutAnywhere || this.cutPoints.has(candidate.span.speech.upper))) {
        prefix = candidate;
      }
    }
    if (!c.cutAtLastPause || prefix === null) return null;
    if (prefix.span.region.lower !== tail.region.lower || prefix.span.speech.lower !== tail.speech.lower) return null;
    if (tail.speech.upper - prefix.span.speech.upper < SAMPLE_RATE / 4) return null;
    return prefix;
  }

  /** Waits until no analysis, commit or speculation is running. For the probe and tests. */
  async settled(): Promise<void> {
    await this.analysis;
    await this.chain;
    await this.speculation?.result;
  }

  // ---- analysis ----------------------------------------------------------------------

  private scheduleAnalysis(): void {
    const generation = this.generation;
    this.analysis = this.analysis.then(async () => {
      if (generation !== this.generation) return;
      const detector = await this.detectorReady;
      const segmenter = (this.segmenter ??= new SpeechSegmenter(detector.frameSamples, this.configuration.segmenter));
      // Whole frames only; the remainder waits for the next chunk (or is never analysed,
      // exactly as the Swift's pending partial frame is not).
      const whole = Math.floor(this.unanalysed / detector.frameSamples) * detector.frameSamples;
      segmenter.advance(this.received - segmenter.sampleCount);
      if (whole === 0) {
        this.noteCutPoint(segmenter);
        return;
      }
      const start = this.received - this.unanalysed;
      this.unanalysed -= whole;
      const frames = this.slice({ lower: start, upper: start + whole });
      let probabilities: number[];
      try {
        probabilities = await detector.probabilities(frames);
      } catch {
        // The detector's host went away. Speech, never silence: a word read as silence is
        // trimmed out of the decode.
        probabilities = new Array<number>(whole / detector.frameSamples).fill(1);
      }
      if (generation !== this.generation) return;
      for (const event of segmenter.appendFrames(probabilities)) {
        if (event.kind === 'commit') this.enqueueCommit(event.span);
        else this.speculate(event.span);
      }
      this.noteCutPoint(segmenter);
      // A speculation is NOT aborted when the speaker carries on. It is still a correct decode
      // of everything up to that pause, and once it finishes it becomes `prefix`.
      this.dropCommittedAudio();
    });
  }

  /**
   * The current speculation's pause has now lasted `cutPause`: no speech since its span's
   * speech ended, and `cutPause` of samples after the last speech frame. Asked after every
   * batch of frames, as the Mac asks after every `append`, and against the same count — the
   * segmenter's `sampleCount`, a partial frame included.
   */
  private noteCutPoint(segmenter: SpeechSegmenter): void {
    const speculation = this.speculation;
    if (
      speculation !== null &&
      segmenter.lastSpeechEnd <= speculation.span.speech.upper &&
      segmenter.sampleCount - segmenter.lastSpeechEnd >= Math.trunc(this.configuration.cutPause * SAMPLE_RATE)
    ) {
      this.cutPoints.add(speculation.span.speech.upper);
    }
  }

  // ---- work behind the speaker -------------------------------------------------------

  private enqueueCommit(span: Span): void {
    const audio = this.slice(span.speech);
    // A speculation over exactly this audio is this commit's decode, done or under way.
    let adopted: Promise<string | null> | null = null;
    const speculation = this.speculation;
    if (speculation !== null) {
      if (sameRange(speculation.span.speech, span.speech)) {
        adopted = speculation.result;
      } else {
        speculation.abort.abort();
        this.report.aborted += 1;
      }
      this.speculation = null;
    }
    this.prefix = null; // the region it described has just been committed
    this.finishedPauses = [];
    this.waitingPause = null;
    const previous = this.chain;
    const abort = this.sessionAbort;
    const generation = this.generation;
    this.chain = (async () => {
      await previous;
      if (adopted !== null) {
        const text = await adopted;
        if (text !== null) {
          if (generation !== this.generation) return;
          this.committed(text);
          return;
        }
      }
      if (abort.signal.aborted) return;
      let text = await this.decodeGuarded(audio, 'commit', abort.signal);
      // One retry for a real failure, never for an abort: a lost segment is worse than a
      // slow one.
      if (text === null && !abort.signal.aborted) {
        text = await this.decodeGuarded(audio, 'commit', abort.signal);
        if (text === null && generation === this.generation) {
          this.failure = `a ${(audio.length / SAMPLE_RATE).toFixed(1)} s segment failed to decode twice`;
        }
      }
      if (generation !== this.generation) return;
      this.committed(text ?? '');
    })();
  }

  private committed(text: string): void {
    this.texts.push(text);
    this.report.commits += 1;
    if (text.trim() === '') return;
    for (const listener of [...this.listeners]) {
      try {
        listener(text);
      } catch {
        // A listener must never cost the stream its text.
      }
    }
  }

  private speculate(span: Span): void {
    if (!this.configuration.speculate) return;
    const current = this.speculation;
    if (current !== null) {
      if (sameRange(current.span.speech, span.speech)) return;
      if (this.configuration.coalesceSpeculations && current.running) {
        this.waitingPause = span;
        return;
      }
      current.abort.abort();
      this.report.aborted += 1;
    }
    this.waitingPause = null;
    const audio = this.slice(span.speech);
    const abort = new AbortController();
    const previous = this.chain;
    const generation = this.generation;
    const own: { speculation: Speculation | null } = { speculation: null };
    const result = (async (): Promise<string | null> => {
      await previous;
      if (abort.signal.aborted) return null;
      if (own.speculation !== null) own.speculation.running = true;
      const text = await this.decodeGuarded(audio, 'speculation', abort.signal);
      if (own.speculation !== null) own.speculation.running = false;
      // Finished and still about the uncommitted region: it is the newest prefix.
      if (
        text !== null &&
        !abort.signal.aborted &&
        generation === this.generation &&
        span.region.lower === (this.segmenter?.committedUpTo ?? -1) &&
        (this.prefix?.span.speech.upper ?? 0) < span.speech.upper
      ) {
        this.prefix = { span, text };
        this.finishedPauses.push({ span, text });
      }
      // The newest pause waited for this one (`coalesceSpeculations`): its turn now.
      const waiting = this.waitingPause;
      if (waiting !== null && this.running && generation === this.generation && this.speculation === own.speculation) {
        this.waitingPause = null;
        this.speculation = null; // finished: it lives on as `prefix`, nothing to abort
        this.speculate(waiting);
      }
      return text;
    })();
    this.report.speculations += 1;
    own.speculation = { span, result, abort, running: false };
    this.speculation = own.speculation;
  }

  /**
   * The tail, after release: one retry, as a commit gets, and then `failure`, so `finish`
   * sends the recording to batch. Every tail path used to paste `text ?? ''` — the contract
   * above ("whatever the stream cannot vouch for … is decoded in batch instead") held for
   * commits and not for the one segment every dictation has. (Core review 2026-09-30.)
   */
  private async decodeTail(range: SampleRange): Promise<string | null> {
    const audio = this.slice(range);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const text = await this.decodeGuarded(audio, 'tail', null);
      if (text !== null) return text;
    }
    this.failure = `the last ${((range.upper - range.lower) / SAMPLE_RATE).toFixed(1)} s failed to decode twice`;
    return null;
  }

  /**
   * One decode with the running text as prompt, re-run without it if the result looks like
   * the decoder looping on its own prompt. `null` means it failed or was aborted.
   */
  private async decodeGuarded(audio: Float32Array, kind: Kind, signal: AbortSignal | null): Promise<string | null> {
    const previous = joinSegments(this.texts);
    const prompt = segmentPrompt(this.configuration.hint, previous, this.configuration.carryCharacters);
    this.fittedAllowed ??= this.engine.mixesWindowsSafely();
    // Commits run while the speaker talks, so they take the model's full window, the setting
    // it was measured best at; speculations and the tail are what the user waits for, so
    // they take a window fitted to the audio plus 5 s of silence (C2 §3).
    const window = this.fittedAllowed && kind !== 'commit' ? fittedAudioContext(Math.max(audio.length, SAMPLE_RATE)) : 0;
    try {
      let decode: SegmentDecode = await this.engine.decodeSegment(audio, {
        language: this.language,
        prompt,
        audioContext: window,
        ...(signal === null ? {} : { signal }),
      });
      if (previous !== '' && looksLikeALoop(decode.text, previous)) {
        const bare = segmentPrompt(this.configuration.hint, '', 0);
        const again = await this.engine.decodeSegment(audio, {
          language: this.language,
          prompt: bare,
          audioContext: window,
          ...(signal === null ? {} : { signal }),
        });
        // Both decodes were paid for, and the cost says so, as on the Mac.
        decode = { ...again, milliseconds: decode.milliseconds + again.milliseconds };
        this.report.retries += 1;
      }
      return decode.text;
    } catch {
      return null;
    }
  }

  // ---- buffer ------------------------------------------------------------------------

  private push(chunk: Float32Array): void {
    const needed = this.length + chunk.length;
    if (needed > this.samples.length) {
      const grown = new Float32Array(Math.max(needed, this.samples.length * 2));
      grown.set(this.samples.subarray(0, this.length));
      this.samples = grown;
    }
    this.samples.set(chunk, this.length);
    this.length = needed;
  }

  /** A copy of absolute samples `range`, clamped to what is still held. */
  private slice(range: SampleRange): Float32Array {
    const lower = Math.max(range.lower - this.base, 0);
    const upper = Math.min(range.upper - this.base, this.length);
    return lower < upper ? this.samples.slice(lower, upper) : new Float32Array(0);
  }

  private dropCommittedAudio(): void {
    // Keep everything not yet analysed or committed; amortise the copy.
    const keepFrom = Math.min(this.segmenter?.committedUpTo ?? 0, this.received - this.unanalysed);
    const drop = keepFrom - this.base;
    if (drop <= SAMPLE_RATE * 5) return;
    this.samples.copyWithin(0, drop, this.length);
    this.length -= drop;
    this.base = keepFrom;
  }

  private discard(): void {
    this.generation += 1;
    this.sessionAbort.abort();
    this.speculation?.abort.abort();
    this.speculation = null;
    this.prefix = null;
    this.finishedPauses = [];
    this.cutPoints = new Set<number>();
    this.sessionAbort = new AbortController();
    this.chain = Promise.resolve();
    this.analysis = Promise.resolve();
    this.failure = null;
    this.texts = [];
    this.length = 0;
    this.base = 0;
    this.received = 0;
    this.unanalysed = 0;
    this.segmenter = null;
    this.running = false;
    this.listeners.clear();
    void this.detectorReady.then((detector) => detector.close()).catch(() => undefined);
  }
}

function peak(samples: Float32Array): number {
  let max = 0;
  for (const sample of samples) max = Math.max(max, Math.abs(sample));
  return max;
}

// ---------------------------------------------------------------------------------
// The engine the Uzbek family holds
// ---------------------------------------------------------------------------------

/**
 * The Uzbek whisper engine, able to stream. A wrapper rather than a change to the engine,
 * because the family picks "the first member that can stream" and the same engine type
 * also serves Russian, where nothing here was measured. Batch calls pass straight through.
 *
 * The engine should be built with flash attention OFF (`flashAttention: false`); with it on,
 * every stream decodes with the full window — correct, but the tail loses its ~3× saving.
 */
export function createStreamingWhisperEngine(options: {
  readonly engine: SegmentDecodingEngine;
  readonly language?: Language;
  /** `ggml-silero-v6.2.0.bin`, when installed. Absent, each stream uses the energy gate. */
  readonly speechDetectorPath: () => Promise<string | null>;
  /** The vocabulary hint, read per stream so a new term reaches the next dictation. */
  readonly hint?: () => string | null;
  readonly configuration?: Partial<StreamingWhisperConfiguration>;
}): StreamingSttEngine & SegmentDecodingEngine {
  const { engine } = options;
  const openDetector = async (): Promise<AsyncSpeechDetector> => {
    const path = await options.speechDetectorPath();
    if (path === null) return energyDetector();
    const silero: HostSpeechDetector = await engine.openSpeechDetector(path);
    return silero;
  };
  return {
    ...engine,
    engineId: engine.engineId,
    supportedLanguages: engine.supportedLanguages,
    openStream(): TranscriptionStream {
      return new StreamingWhisperSession({
        engine,
        language: options.language ?? 'uz',
        configuration: { ...options.configuration, hint: options.hint?.() ?? options.configuration?.hint ?? null },
        detector: openDetector(),
      });
    },
  };
}
