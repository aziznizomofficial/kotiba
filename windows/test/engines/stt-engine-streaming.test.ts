// Host 1.1 through the real client and a fake host on real pipes: the encoder window and
// the prompt reach the host, an abort ends a decode early while the host keeps serving,
// Silero answers while a decode is running, and a 1.0 host degrades to "no VAD" rather
// than breaking a dictation.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, GGML_MAGIC, MODEL_MINIMUM_BYTES } from '../../src/contracts/index.js';
import { createSttEngineWithHost, createSttHost, whisperParamsFor, type SttHost } from '../../src/engines/index.js';

const FAKE_HOST = join(dirname(fileURLToPath(import.meta.url)), 'fake-host.mjs');

let root = '';
const toDispose: { dispose: () => Promise<void> }[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-seg-'));
});

afterEach(async () => {
  while (toDispose.length > 0) await toDispose.pop()?.dispose();
  await rm(root, { recursive: true, force: true });
});

function fakeHost(behaviour: Record<string, unknown> = {}): SttHost {
  const host = createSttHost({
    hostPath: 'node',
    spawnProcess: (): ChildProcessWithoutNullStreams =>
      spawn(process.execPath, [FAKE_HOST, JSON.stringify(behaviour)], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  toDispose.push(host);
  return host;
}

async function uzbekEngine(behaviour: Record<string, unknown> = {}) {
  const modelPath = join(root, 'ggml-uzbek-stt-v1-q5_0.bin');
  const buffer = Buffer.alloc(MODEL_MINIMUM_BYTES + 1024);
  buffer.writeUInt32LE(GGML_MAGIC, 0);
  await writeFile(modelPath, buffer);
  const engine = createSttEngineWithHost({
    engineId: 'whisper-ggml-uzbek-stt-v1-q5_0',
    modelPath,
    params: whisperParamsFor({ language: 'uz', family: 'uzbek', settings: DEFAULT_SETTINGS, initialPrompt: null, cpuCount: 4 }),
    hostPath: 'node',
    supportedLanguages: ['uz'],
    flashAttention: false,
    host: fakeHost(behaviour),
  });
  toDispose.push(engine);
  return engine;
}

const speech = (seconds: number, value = 0.3): Float32Array => new Float32Array(Math.round(16_000 * seconds)).fill(value);

describe('segment decoding over the real client', () => {
  it('sends the encoder window and the whole prompt, and says it cannot mix windows only with flash on', async () => {
    const engine = await uzbekEngine();
    expect(engine.mixesWindowsSafely()).toBe(true);
    const decode = await engine.decodeSegment(speech(2), { language: 'uz', prompt: 'Hint. oldingi gap', audioContext: 512 });
    expect(decode.audioContext).toBe(512);
    expect(decode.text).toContain('prompt=[Hint. oldingi gap]');
    expect(decode.text).toContain('lang=uz');
  });

  it('an abort ends a running decode early, and the next one decodes normally', async () => {
    const engine = await uzbekEngine({ transcribeDelayMs: 2000 });
    const controller = new AbortController();
    const started = Date.now();
    const running = engine.decodeSegment(speech(2), { language: 'uz', prompt: null, audioContext: 0, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(running).rejects.toThrow(/aborted/);
    expect(Date.now() - started).toBeLessThan(1500);
    const next = await engine.decodeSegment(speech(1), { language: 'uz', prompt: null, audioContext: 0 });
    expect(next.text).toContain('n=16000');
  });

  it('a batch transcribe given up on (a reroute past its deadline) is aborted on the host too', async () => {
    const engine = await uzbekEngine({ transcribeDelayMs: 2000 });
    const controller = new AbortController();
    const started = Date.now();
    const running = engine.transcribe({ samples: speech(2), droppedSamples: 0 }, 'uz', controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(running).rejects.toThrow(/aborted/);
    // The host is free at once for the next dictation, not after the abandoned 2 s decode.
    expect(Date.now() - started).toBeLessThan(1500);
    const next = await engine.transcribe({ samples: speech(1), droppedSamples: 0 }, 'uz');
    expect(next.raw).toContain('n=16000');
  });

  it('Silero answers at once, even while a decode is running', async () => {
    const engine = await uzbekEngine({ transcribeDelayMs: 600 });
    await engine.prepare();
    const decoding = engine.decodeSegment(speech(2), { language: 'uz', prompt: null, audioContext: 0 });
    const detector = await engine.openSpeechDetector('/models/ggml-silero-v6.2.0.bin');
    const started = Date.now();
    const probs = await detector.probabilities(new Float32Array(512 * 3).fill(0.5));
    expect(Date.now() - started).toBeLessThan(300);
    expect(probs).toEqual([0.9, 0.9, 0.9]);
    await detector.close();
    await decoding;
  });

  it('a 1.0 host has no VAD: opening one throws, so the stream falls back to energy', async () => {
    const engine = await uzbekEngine({ noVad: true });
    await expect(engine.openSpeechDetector('/models/ggml-silero-v6.2.0.bin')).rejects.toThrow(/no operation named 'vad_open'/);
    // And its transcribe still works: nothing about 1.1 is required for a dictation.
    expect((await engine.decodeSegment(speech(1), { language: 'uz', prompt: null, audioContext: 256 })).text).toContain('n=16000');
  });
});
