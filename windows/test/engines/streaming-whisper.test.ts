// C2. The streaming Uzbek session's scheduling, checked without a model — ported from the
// Mac's suite (Tests/KotibaEnginesTests/StreamingWhisperSessionTests.swift). A fake decoder
// answers `w<n>` by call index and records every prompt and window, so the tests say
// exactly which audio was decoded when, with what context, and what key-release had left.

import { describe as suite, expect, test } from 'vitest';

import { EngineFailure, engineError, type AudioBuffer, type Language, type TranscriptResult } from '../../src/contracts/index.js';
import { DEFAULT_SPEECH_SEGMENTER } from '../../src/core/stt/speech-segmenter.js';
import {
  DEFAULT_STREAMING_WHISPER,
  StreamingWhisperSession,
  createStreamingWhisperEngine,
  type StreamingWhisperConfiguration,
} from '../../src/engines/streaming-whisper.js';
import type { SegmentDecode, SegmentDecodeOptions, SegmentDecodingEngine } from '../../src/engines/stt-engine.js';

const rate = 16_000;

function room(seconds: number): Float32Array {
  const out = new Float32Array(Math.trunc(seconds * rate));
  let state = 3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < out.length; i += 1) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & mask;
    out[i] = (Number(state >> 40n) / (1 << 24) - 0.5) * 0.002;
  }
  return out;
}

function voice(seconds: number): Float32Array {
  const out = room(seconds);
  const period = rate / 5;
  const on = (rate * 4) / 25;
  for (let i = 0; i < out.length; i += 1) {
    if (i % period < on) out[i] = out[i]! + 0.14 * Math.fround(Math.sin((2 * Math.PI * 220 * i) / rate));
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const SHORT: Partial<StreamingWhisperConfiguration> = {
  segmenter: { ...DEFAULT_SPEECH_SEGMENTER, minimumSegment: 3, relaxAfter: 8 },
};

class FakeDecoder {
  readonly engineId = 'fake';
  readonly calls: { seconds: number; prompt: string | null; window: number }[] = [];
  aborted = 0;
  batchCalls = 0;
  delayMs = 0;
  scripted: string[] = [];
  failNext = 0;
  safeWindows = true;

  mixesWindowsSafely(): boolean {
    return this.safeWindows;
  }

  async transcribe(_audio: AudioBuffer, language: Language): Promise<TranscriptResult> {
    this.batchCalls += 1;
    return { raw: 'batch', language, engineId: this.engineId };
  }

  async decodeSegment(samples: Float32Array, options: SegmentDecodeOptions): Promise<SegmentDecode> {
    const index = this.calls.length;
    this.calls.push({ seconds: samples.length / rate, prompt: options.prompt, window: options.audioContext });
    if (this.delayMs > 0) {
      // Poll the abort the way the host's whisper polls it between decoder steps.
      for (let step = 0; step < 10; step += 1) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs / 10));
        if (options.signal?.aborted === true) {
          this.aborted += 1;
          throw new EngineFailure(engineError.transcriptionFailed('aborted'));
        }
      }
    }
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new EngineFailure(engineError.transcriptionFailed('scripted failure'));
    }
    const text = index < this.scripted.length ? this.scripted[index]! : `w${index}`;
    return { text, audioContext: options.audioContext, milliseconds: 1 };
  }
}

function session(decoder: FakeDecoder, configuration: Partial<StreamingWhisperConfiguration> = SHORT): StreamingWhisperSession {
  return new StreamingWhisperSession({ engine: decoder, language: 'uz', configuration });
}

async function feed(stream: StreamingWhisperSession, audio: Float32Array, settle = true): Promise<void> {
  for (let i = 0; i < audio.length; i += 320) {
    stream.append(audio.subarray(i, i + 320));
    if (settle) await stream.settled();
  }
}

async function release(stream: StreamingWhisperSession, audio: Float32Array): Promise<TranscriptResult> {
  return stream.finish({ samples: audio, droppedSamples: 0 }, 'uz');
}

suite('streaming Whisper session — scheduling, without a model', () => {
  test('speech, a pause, speech: one commit behind the speaker, one tail at release', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder, { ...SHORT, speculate: false, hint: 'Hint.' });
    const first = concat(voice(4), room(0.8));
    await feed(stream, first);
    expect(decoder.calls).toHaveLength(1);
    const second = voice(2);
    await feed(stream, second);
    const transcript = await release(stream, concat(first, second));
    expect(transcript.raw).toBe('w0 w1');
    expect(decoder.calls.map((call) => call.prompt)).toEqual(['Hint.', 'Hint. w0']);
    expect(stream.report.tail).toBe('decoded');
    expect(stream.report.commits).toBe(1);
  });

  test('stop talking, wait, let go: the speculation is the tail and release decodes nothing', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder);
    const audio = concat(voice(2), room(0.35));
    await feed(stream, audio);
    expect(decoder.calls).toHaveLength(1);
    expect((await release(stream, audio)).raw).toBe('w0');
    expect(decoder.calls).toHaveLength(1);
    expect(stream.report.tail).toBe('speculation');
    expect(stream.report.tailSeconds).toBe(0);
  });

  test('a commit over audio already speculated adopts it instead of decoding twice', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder);
    const audio = concat(voice(4), room(0.8), voice(1), room(0.3));
    await feed(stream, audio);
    expect((await release(stream, audio)).raw).toBe('w0 w1');
    expect(decoder.calls).toHaveLength(2);
  });

  test('a speculation still running at release is aborted, so the tail never queues behind it', async () => {
    const decoder = new FakeDecoder();
    decoder.delayMs = 400;
    const stream = session(decoder);
    const a = concat(voice(2), room(0.25));
    await feed(stream, a, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const b = voice(1);
    await feed(stream, b, false);
    decoder.delayMs = 0;
    const transcript = await release(stream, concat(a, b));
    for (let i = 0; i < 50 && decoder.aborted === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decoder.aborted).toBe(1);
    expect(stream.report.tail).toBe('decoded');
    expect(transcript.raw).toBe('w1');
  });

  test('coalesced (C4 §14.4): a newer pause never aborts a running decode; it waits its turn', async () => {
    const decoder = new FakeDecoder();
    decoder.delayMs = 300;
    const stream = session(decoder, { coalesceSpeculations: true });
    // Two pauses while the first pause decode runs: neither aborts it; the newest is decoded next.
    const parts = [concat(voice(2), room(0.15)), concat(voice(0.6), room(0.15)), concat(voice(0.6), room(0.35))];
    for (const part of parts) {
      await feed(stream, part, false);
      await new Promise((resolve) => setTimeout(resolve, 60)); // the first decode is under way
    }
    const audio = concat(...parts);
    await stream.settled();
    for (let i = 0; i < 100 && decoder.calls.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    await stream.settled();
    expect(decoder.aborted).toBe(0);
    // The first pause's decode, then ONE more over everything up to the newest pause.
    expect(decoder.calls).toHaveLength(2);
    expect(decoder.calls[1]!.seconds).toBeGreaterThan(decoder.calls[0]!.seconds);
    decoder.delayMs = 0;
    const transcript = await release(stream, audio);
    expect(stream.report.tail).toBe('speculation');
    expect(transcript.raw).toBe('w1');
  });

  test('coalesced: at release a running pause decode of the tail’s region is waited for, not thrown away', async () => {
    const decoder = new FakeDecoder();
    decoder.delayMs = 300;
    const stream = session(decoder, { coalesceSpeculations: true, cutPause: DEFAULT_SPEECH_SEGMENTER.speculativePause });
    const a = concat(voice(2), room(0.25));
    await feed(stream, a, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const b = voice(1);
    await feed(stream, b, false);
    decoder.delayMs = 0;
    const transcript = await release(stream, concat(a, b));
    expect(decoder.aborted).toBe(0);
    // The pause decode is kept as the prefix; only the last second is decoded after release.
    expect(stream.report.tail).toBe('prefix');
    expect(transcript.raw).toBe('w0 w1');
    expect(decoder.calls[1]!.seconds).toBeLessThan(1.5);
  });

  test('pause, more speech, let go: the pause decode is kept and only the rest is decoded', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder, { hint: 'Hint.' }); // 20 s segments: no commit here
    const audio = concat(voice(3), room(0.35), voice(1.5));
    await feed(stream, audio);
    expect((await release(stream, audio)).raw).toBe('w0 w1');
    expect(decoder.calls).toHaveLength(2);
    expect(decoder.calls[1]!.prompt).toBe('Hint. w0');
    expect(decoder.calls[1]!.seconds).toBeLessThan(2.2);
    expect(stream.report.tail).toBe('prefix');
  });

  test('release cuts at a pause decode only where the pause lasted cutPause', async () => {
    // The Mac's `cutsOnlyAtLongPauses`. 0.12 s of silence is decoded (speculativePause 0.1)
    // but is no cut: release decodes the whole region. 0.35 s is a cut: release keeps the
    // pause decode and decodes only the rest. Default configuration throughout.
    expect(DEFAULT_SPEECH_SEGMENTER.speculativePause).toBe(0.1);
    expect(DEFAULT_SPEECH_SEGMENTER.trailingPadding).toBe(0.1);
    expect(DEFAULT_STREAMING_WHISPER.cutPause).toBe(0.2);
    for (const [pause, expected, raw] of [
      [0.12, 'decoded', 'w1'],
      [0.35, 'prefix', 'w0 w1'],
    ] as const) {
      const decoder = new FakeDecoder();
      const stream = session(decoder, {});
      const audio = concat(voice(3), room(pause), voice(1.5));
      await feed(stream, audio);
      expect(decoder.calls, `pause ${pause} s`).toHaveLength(1); // the pause WAS decoded
      expect((await release(stream, audio)).raw, `pause ${pause} s`).toBe(raw);
      expect(stream.report.tail, `pause ${pause} s`).toBe(expected);
      if (expected === 'prefix') expect(decoder.calls[1]!.seconds).toBeLessThan(2.2); // only the rest
      else expect(decoder.calls[1]!.seconds).toBeGreaterThan(4.5); // the whole region again
    }
  });

  test('a short pause after a long one: release still cuts at the long one', async () => {
    // The Mac's `cutsOnlyAtLongPauses`, second half. Two pause decodes finish — at the 0.35 s
    // pause (a cut point) and at the 0.12 s one after it (not) — and the cut is at the first.
    const decoder = new FakeDecoder();
    const stream = session(decoder, {});
    const audio = concat(voice(3), room(0.35), voice(1.5), room(0.12), voice(1));
    await feed(stream, audio);
    expect(decoder.calls).toHaveLength(2);
    const raw = (await release(stream, audio)).raw;
    expect(stream.report.tail).toBe('prefix');
    expect(raw.startsWith('w0 ')).toBe(true);
    expect(decoder.calls).toHaveLength(3);
    expect(decoder.calls[2]!.seconds).toBeGreaterThan(2.4); // everything after the long pause
    expect(decoder.calls[2]!.seconds).toBeLessThan(3.2);
  });

  test('a cutPause no longer than speculativePause cuts at every pause decode', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder, { cutPause: DEFAULT_SPEECH_SEGMENTER.speculativePause });
    const audio = concat(voice(3), room(0.12), voice(1.5));
    await feed(stream, audio);
    expect((await release(stream, audio)).raw).toBe('w0 w1');
    expect(stream.report.tail).toBe('prefix');
  });

  test('with the prefix cut off, the whole region is decoded at release', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder, { cutAtLastPause: false });
    const audio = concat(voice(3), room(0.35), voice(1.5));
    await feed(stream, audio);
    expect((await release(stream, audio)).raw).toBe('w1');
    expect(stream.report.tail).toBe('decoded');
  });

  test('a segment that echoes its prompt is re-decoded without the carried text', async () => {
    const decoder = new FakeDecoder();
    decoder.scripted = ['biz ertaga ertalab uchrashamiz va ishga boramiz', 'uchrashamiz va ishga boramiz', 'keyin dam olamiz'];
    const stream = session(decoder, { ...SHORT, speculate: false, hint: 'Hint.' });
    const audio = concat(voice(4), room(0.8), voice(2));
    await feed(stream, audio);
    expect((await release(stream, audio)).raw).toBe('biz ertaga ertalab uchrashamiz va ishga boramiz keyin dam olamiz');
    expect(decoder.calls).toHaveLength(3);
    expect(decoder.calls[2]!.prompt).toBe('Hint.');
    expect(stream.report.retries).toBe(1);
  });

  test('one retry recovers a transient failure', async () => {
    const decoder = new FakeDecoder();
    decoder.failNext = 1;
    const stream = session(decoder, { ...SHORT, speculate: false });
    const audio = concat(voice(4), room(0.8), voice(2));
    await feed(stream, audio);
    expect((await release(stream, audio)).raw).toBe('w1 w2');
  });

  test('silence only: release returns an empty transcript and decodes nothing', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder);
    const audio = room(3);
    await feed(stream, audio);
    expect((await release(stream, audio)).raw).toBe('');
    expect(decoder.calls).toEqual([]);
    expect(stream.report.tail).toBe('none');
  });

  test('loud audio with no detected speech is decoded whole, never pasted as nothing', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder);
    // A steady tone: the energy gate absorbs it into the floor, whisper still gets it.
    const hum = new Float32Array(rate * 3).map((_, i) => 0.05 * Math.sin((2 * Math.PI * 50 * i) / rate));
    await feed(stream, hum);
    expect((await release(stream, hum)).raw).toBe('w0');
    expect(stream.report.tail).toBe('fallback');
  });

  test('cancel ends the stream: nothing it decoded can reach a later finish', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder, { ...SHORT, speculate: false });
    const audio = concat(voice(4), room(0.8));
    await feed(stream, audio);
    stream.cancel();
    await expect(release(stream, audio)).rejects.toThrow(/already finished/);
  });

  test('the recording is authoritative: what the stream did not see is appended at key-up', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder);
    const audio = concat(voice(2), room(0.4));
    await feed(stream, audio.subarray(0, 16_000)); // capture lagged by 1.4 s
    expect((await release(stream, audio)).raw).toBe('w0');
    expect(decoder.batchCalls).toBe(0);
  });

  test('another language, lost samples, or a stream never fed all fall back to batch', async () => {
    for (const scenario of [0, 1, 2]) {
      const decoder = new FakeDecoder();
      const stream = session(decoder);
      const audio = voice(2);
      if (scenario !== 2) await feed(stream, audio);
      const result = await stream.finish(
        { samples: audio, droppedSamples: scenario === 1 ? 320 : 0 },
        scenario === 0 ? 'ru' : 'uz',
      );
      expect(result.raw).toBe('batch');
      expect(stream.report.tail).toBe('batch');
    }
  });

  test('a segment that fails twice sends the whole recording to batch, never a hole', async () => {
    const decoder = new FakeDecoder();
    decoder.failNext = 2;
    const stream = session(decoder, { ...SHORT, speculate: false });
    const audio = concat(voice(4), room(0.8), voice(2));
    await feed(stream, audio);
    expect((await release(stream, audio)).raw).toBe('batch');
  });

  // Core review 2026-09-30, item 1: every tail path pasted `text ?? ''`.
  test('a tail that fails to decode twice sends the recording to batch — never commits with a hole', async () => {
    // The commit decodes; the tail fails twice (the first attempt and its retry).
    const decoder = new FakeDecoder();
    decoder.scripted = ['w0'];
    const stream = session(decoder, { ...SHORT, speculate: false });
    const first = concat(voice(4), room(0.8));
    await feed(stream, first);
    decoder.failNext = 2;
    const second = voice(2);
    await feed(stream, second);
    expect((await release(stream, concat(first, second))).raw).toBe('batch');
    expect(stream.report.tail).toBe('batch');
    expect(decoder.batchCalls).toBe(1);
  });

  test('a tail that fails once is decoded again, not pasted without it', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder, { ...SHORT, speculate: false });
    const first = concat(voice(4), room(0.8));
    await feed(stream, first);
    decoder.failNext = 1;
    const second = voice(2);
    await feed(stream, second);
    expect((await release(stream, concat(first, second))).raw).toBe('w0 w2');
    expect(stream.report.tail).toBe('decoded');
    expect(decoder.batchCalls).toBe(0);
  });

  test('a failed pause decode at release is decoded again, not pasted as nothing', async () => {
    const decoder = new FakeDecoder();
    decoder.failNext = 1;
    const stream = session(decoder);
    const audio = concat(voice(2), room(0.35));
    await feed(stream, audio);
    const transcript = await release(stream, audio);
    expect(transcript.raw).toBe('w1');
    expect(stream.report.tail).toBe('decoded');
    expect(decoder.batchCalls).toBe(0);
  });

  test('commits take the full window, the tail a fitted one — unless the engine cannot mix', async () => {
    for (const safe of [true, false]) {
      const decoder = new FakeDecoder();
      decoder.safeWindows = safe;
      const stream = session(decoder, { ...SHORT, speculate: false });
      const audio = concat(voice(4), room(0.8), voice(2));
      await feed(stream, audio);
      await release(stream, audio);
      const windows = decoder.calls.map((call) => call.window);
      expect(windows[0]).toBe(0);
      if (safe) expect(windows[1]! % 256 === 0 && windows[1]! > 0).toBe(true);
      else expect(windows[1]).toBe(0);
    }
  });

  test('committed text is offered to incremental polish as it lands', async () => {
    const decoder = new FakeDecoder();
    const stream = session(decoder, { ...SHORT, speculate: false });
    const commits: string[] = [];
    stream.onCommit((text) => commits.push(text));
    const audio = concat(voice(4), room(0.8), voice(2));
    await feed(stream, audio);
    expect(commits).toEqual(['w0']);
    await release(stream, audio);
    expect(commits).toEqual(['w0']);
  });
});

suite('the engine the Uzbek family holds', () => {
  function fakeEngine(decoder: FakeDecoder, vad: { opened: string[]; fail?: boolean }): SegmentDecodingEngine {
    return {
      engineId: 'whisper-ggml-uzbek-stt-v1-q5_0',
      supportedLanguages: new Set<Language>(['uz']),
      detectLanguage: async () => ({}),
      isReady: async () => true,
      prepare: async () => undefined,
      transcribe: (audio, language) => decoder.transcribe(audio, language),
      unload: async () => undefined,
      dispose: async () => undefined,
      mixesWindowsSafely: () => decoder.mixesWindowsSafely(),
      decodeSegment: (samples, options) => decoder.decodeSegment(samples, options),
      openSpeechDetector: async (path) => {
        vad.opened.push(path);
        if (vad.fail === true) throw new Error('unknown_op');
        // A "Silero" that calls everything speech: 512-sample frames.
        return {
          frameSamples: 512,
          probabilities: async (samples) => new Array<number>(Math.floor(samples.length / 512)).fill(0.9),
          close: async () => undefined,
        };
      },
    };
  }

  test('streams with Silero from the path it is given, and passes batch calls through', async () => {
    const decoder = new FakeDecoder();
    const vad = { opened: [] as string[] };
    const engine = createStreamingWhisperEngine({
      engine: fakeEngine(decoder, vad),
      speechDetectorPath: async () => '/models/ggml-silero-v6.2.0.bin',
      hint: () => 'Bu yerda ismlar toʻgʻri yozilgan.',
    });
    expect(engine.engineId).toBe('whisper-ggml-uzbek-stt-v1-q5_0');
    expect((await engine.transcribe({ samples: voice(1), droppedSamples: 0 }, 'uz')).raw).toBe('batch');
    const stream = engine.openStream() as StreamingWhisperSession;
    const audio = voice(3);
    await feed(stream, audio);
    const result = await stream.finish({ samples: audio, droppedSamples: 0 }, 'uz');
    expect(vad.opened).toEqual(['/models/ggml-silero-v6.2.0.bin']);
    expect(result.raw).toBe('w0');
    expect(decoder.calls[0]!.prompt).toBe('Bu yerda ismlar toʻgʻri yozilgan.');
  });

  test('an old host without VAD, or no Silero file: the energy gate, and it still streams', async () => {
    for (const setup of [{ fail: true, path: '/x.bin' }, { fail: false, path: null }]) {
      const decoder = new FakeDecoder();
      const vad = { opened: [] as string[], fail: setup.fail };
      const engine = createStreamingWhisperEngine({ engine: fakeEngine(decoder, vad), speechDetectorPath: async () => setup.path });
      const stream = engine.openStream() as StreamingWhisperSession;
      const audio = concat(voice(2), room(0.35));
      await feed(stream, audio);
      expect((await stream.finish({ samples: audio, droppedSamples: 0 }, 'uz')).raw).toBe('w0');
    }
  });
});
