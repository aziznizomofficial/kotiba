// REGRESSION (final win review 2026-09-30, fixed): the 30-minute ceiling throws the streamed transcript away.
//
// At the ceiling the Mac's `CapturePipeline.Take.accept` keeps what fits, yields ONLY the kept
// samples to the live stream, and stops taking audio (`reachedLimit`) — nothing is counted as
// dropped. Windows' `Take.accept` (src/audio/capture.ts) hands every chunk to the live stream
// BEFORE the store refuses it, and the store counts the refusal as `droppedSamples`. The
// chunks that arrive between `onLimit` and the stop reply (an IPC round trip plus the
// worklet drain) therefore make BOTH stream `finish()`es abandon everything they decoded
// during the hold and decode the whole thirty minutes in batch:
//   * StreamingWhisperSession.finish: `audio.droppedSamples > 0 || fed > audio.samples.length`
//   * ParakeetStream.finish:          `audio.droppedSamples === 0` is required for `usable`
// For Uzbek that batch is one `transcribe` request to kotiba-stt, whose timeout is a fixed
// 120 s (host-client DEFAULT_REQUEST_TIMEOUT_MS) — thirty minutes of whisper on a CPU does
// not fit, the host is killed, and the whole dictation fails with nothing inserted.

import { describe, expect, it } from 'vitest';

import { createMicrophoneCapture } from '../../src/audio/index.js';
import type { AudioHost, AudioHostCommand, AudioHostEvent, AudioHostReply } from '../../src/audio/index.js';
import type { AudioBuffer, Language, TranscriptResult } from '../../src/contracts/index.js';
import { StreamingWhisperSession } from '../../src/engines/streaming-whisper.js';
import type { SegmentDecode, SegmentDecodeOptions } from '../../src/engines/stt-engine.js';

const rate = 16_000;

class StreamingHost implements AudioHost {
  #listeners: ((event: AudioHostEvent) => void)[] = [];
  segment = 0;
  capturing = false;
  readonly totals = new Map<number, number>();

  async send(command: AudioHostCommand): Promise<AudioHostReply> {
    switch (command.kind) {
      case 'warmUp':
        return { kind: 'warmedUp', sampleRate: rate, deviceLabel: 'Fake' };
      case 'start':
        this.segment = command.segment;
        this.totals.set(command.segment, 0);
        this.capturing = true;
        return { kind: 'ok' };
      case 'stop':
        this.capturing = false;
        return {
          kind: 'stopped',
          segment: command.segment,
          totalSamples: this.totals.get(command.segment) ?? -1,
          droppedSamples: 0,
        };
      default:
        return { kind: 'ok' };
    }
  }

  onEvent(listener: (event: AudioHostEvent) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((each) => each !== listener);
    };
  }

  speak(samples: Float32Array): void {
    if (!this.capturing) return;
    this.totals.set(this.segment, (this.totals.get(this.segment) ?? 0) + samples.length);
    for (const listener of [...this.#listeners]) listener({ kind: 'chunk', segment: this.segment, samples });
  }
}

/** Voiced bursts: speech the energy gate hears. */
function voice(start: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const n = start + i;
    out[i] = n % (rate / 5) < (rate * 4) / 25 ? 0.14 * Math.sin((2 * Math.PI * 220 * n) / rate) : 0.001;
  }
  return out;
}

class FakeDecoder {
  readonly engineId = 'fake';
  batchCalls = 0;
  mixesWindowsSafely(): boolean {
    return true;
  }
  async transcribe(_audio: AudioBuffer, language: Language): Promise<TranscriptResult> {
    this.batchCalls += 1;
    return { raw: 'batch', language, engineId: this.engineId };
  }
  async decodeSegment(samples: Float32Array, options: SegmentDecodeOptions): Promise<SegmentDecode> {
    return { text: `seg${String(samples.length)}`, audioContext: options.audioContext, milliseconds: 1 };
  }
}

describe('REVIEW: the capture ceiling and the live stream', () => {
  it('audio past the ceiling is neither streamed nor counted as lost (Mac parity)', async () => {
    const host = new StreamingHost();
    const microphone = createMicrophoneCapture({ host, warmHoldMs: 10, ceilingSeconds: 1 });
    let limits = 0;
    let streamed = 0;
    const take = microphone.openTake({ onLimit: () => (limits += 1) });
    await take.start();
    take.onChunk((samples) => (streamed += samples.length));
    // 1.5 s: the last 0.5 s is what arrives between `onLimit` and the stop reply.
    for (let at = 0; at < 24_000; at += 1_600) host.speak(voice(at, 1_600));
    const buffer = await take.stop();
    expect(limits).toBe(1);
    expect(buffer.samples.length).toBe(16_000);
    // The stream must describe exactly the recording it will be finished against.
    expect(streamed).toBe(buffer.samples.length);
    // Reaching a deliberate limit is not "the recording is shorter than what was said".
    expect(buffer.droppedSamples).toBe(0);
  });

  it('a streamed Uzbek dictation that reaches the ceiling is NOT re-decoded whole in batch', async () => {
    const host = new StreamingHost();
    const microphone = createMicrophoneCapture({ host, warmHoldMs: 10, ceilingSeconds: 3 });
    const decoder = new FakeDecoder();
    const stream = new StreamingWhisperSession({ engine: decoder, language: 'uz' });
    const take = microphone.openTake({});
    await take.start();
    const off = take.onChunk((samples) => stream.append(samples.slice()));
    for (let at = 0; at < 4 * rate; at += 1_600) host.speak(voice(at, 1_600));
    const buffer = await take.stop();
    off();
    await stream.finish(buffer, 'uz');
    expect(stream.report.tail).not.toBe('batch');
    expect(decoder.batchCalls).toBe(0);
  });
});
