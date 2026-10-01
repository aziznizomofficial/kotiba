// One engine over one model.
//
// THE INVARIANT under test: `isReady()` answers "is the model resident", not "will this
// engine work". FALSE IS NOT A FAILURE. Refusing on `isReady() === false` pointed the
// user at a model file that was present and valid, on every default install.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSttEngineWithHost,
  createSttHost,
  whisperParamsFor,
  type SttHost,
} from '../../src/engines/index.js';
import {
  asEngineError,
  DEFAULT_SETTINGS,
  GGML_MAGIC,
  MODEL_MINIMUM_BYTES,
  type AudioBuffer,
} from '../../src/contracts/index.js';

const FAKE_HOST = join(dirname(fileURLToPath(import.meta.url)), 'fake-host.mjs');

let root = '';
const toDispose: { dispose: () => Promise<void> }[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-engine-'));
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  while (toDispose.length > 0) await toDispose.pop()?.dispose();
  await rm(root, { recursive: true, force: true });
});

async function writeModel(name: string): Promise<string> {
  const path = join(root, name);
  const buffer = Buffer.alloc(MODEL_MINIMUM_BYTES + 1024);
  buffer.writeUInt32LE(GGML_MAGIC, 0);
  await writeFile(path, buffer);
  return path;
}

function fakeHost(behaviour: Record<string, unknown> = {}): SttHost {
  const host = createSttHost({
    hostPath: 'node',
    spawnProcess: (): ChildProcessWithoutNullStreams =>
      spawn(process.execPath, [FAKE_HOST, JSON.stringify(behaviour)], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  });
  toDispose.push(host);
  return host;
}

function engine(modelPath: string, host: SttHost, languages: readonly ('en' | 'ru' | 'uz')[] = ['uz']) {
  return createSttEngineWithHost({
    engineId: 'whisper-test',
    modelPath,
    params: whisperParamsFor({
      language: languages[0] ?? 'uz',
      family: languages.includes('uz') ? 'uzbek' : 'unified',
      settings: DEFAULT_SETTINGS,
      initialPrompt: null,
      cpuCount: 8,
    }),
    hostPath: 'node',
    host,
    supportedLanguages: languages,
  });
}

/**
 * An engine that OWNS its host, as the real one does. `fakeHost()` above hands in a host
 * built elsewhere, which is the shape a test wants for driving the protocol — but it is
 * not the shape that exercises the engine noticing its own host die.
 */
function engineOwningHost(modelPath: string, behaviour: Record<string, unknown> = {}) {
  const target = createSttEngineWithHost({
    engineId: 'whisper-owned',
    modelPath,
    params: whisperParamsFor({
      language: 'uz',
      family: 'uzbek',
      settings: DEFAULT_SETTINGS,
      initialPrompt: null,
      cpuCount: 8,
    }),
    hostPath: 'node',
    supportedLanguages: ['uz'],
    hostOptions: {
      spawnProcess: (): ChildProcessWithoutNullStreams =>
        spawn(process.execPath, [FAKE_HOST, JSON.stringify(behaviour)], {
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
    },
  });
  toDispose.push(target);
  return target;
}

const audio = (seconds: number, value = 0.25): AudioBuffer => ({
  samples: new Float32Array(Math.round(16000 * seconds)).fill(value),
  droppedSamples: 0,
});

describe('readiness is a trigger, not a gate', () => {
  it('starts not ready, and that is not a failure', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost());
    expect(await target.isReady()).toBe(false);
  });

  it('becomes ready after prepare, and re-asking is how the caller finds out', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost());
    await target.prepare();
    expect(await target.isReady()).toBe(true);
  });

  it('transcribes from cold — a cold model is a SLOW first dictation, not a failure', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost());
    expect(await target.isReady()).toBe(false);
    const result = await target.transcribe(audio(2), 'uz');
    expect(result.raw).toContain('lang=uz');
    expect(await target.isReady()).toBe(true);
  });
});

describe('prepare', () => {
  it('is idempotent — a second call with a live model returns immediately', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost());
    await target.prepare();
    const began = Date.now();
    await target.prepare();
    expect(Date.now() - began).toBeLessThan(50);
  });

  it('deduplicates concurrent callers — two must not both map 539 MB', async () => {
    const path = await writeModel('m.bin');
    const host = fakeHost({ delayMs: 30 });
    const target = engine(path, host);
    await Promise.all([target.prepare(), target.prepare(), target.prepare()]);
    expect(await target.isReady()).toBe(true);
  });

  it('RETRIES after a failure rather than latching broken for the process lifetime', async () => {
    const missing = join(root, 'not-there.bin');
    const target = engine(missing, fakeHost());
    await expect(target.prepare()).rejects.toThrow();

    // The file appears — a download finished, a drive was plugged back in.
    const buffer = Buffer.alloc(MODEL_MINIMUM_BYTES + 1024);
    buffer.writeUInt32LE(GGML_MAGIC, 0);
    await writeFile(missing, buffer);

    await target.prepare();
    expect(await target.isReady()).toBe(true);
  });

  it('distinguishes a missing model from a corrupt one, by TYPE', async () => {
    const missing = engine(join(root, 'nope.bin'), fakeHost());
    const missingError = await missing.prepare().catch((error: unknown) => error);
    expect(asEngineError(missingError)?.kind).toBe('modelMissing');

    const truncated = join(root, 'half.bin');
    await writeFile(truncated, Buffer.alloc(4096));
    const corrupt = engine(truncated, fakeHost());
    const corruptError = await corrupt.prepare().catch((error: unknown) => error);
    expect(asEngineError(corruptError)?.kind).toBe('modelCorrupt');
  });

  it('reports a model whisper.cpp itself refuses as corrupt, with its reason verbatim', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost({ loadFails: true }));
    const error = await target.prepare().catch((caught: unknown) => caught);
    const failure = asEngineError(error);
    expect(failure?.kind).toBe('modelCorrupt');
    expect(failure?.reason).toContain('whisper.cpp could not load it');
  });
});

describe('transcribe', () => {
  it('refuses a language it does not support rather than guessing', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost(), ['uz']);
    const error = await target.transcribe(audio(1), 'ru').catch((caught: unknown) => caught);
    expect(asEngineError(error)?.kind).toBe('languageUnsupported');
  });

  it('refuses empty audio', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost());
    const error = await target
      .transcribe({ samples: new Float32Array(0), droppedSamples: 0 }, 'uz')
      .catch((caught: unknown) => caught);
    expect(asEngineError(error)?.kind).toBe('transcriptionFailed');
  });

  it('pads a short utterance to one second before the model sees it', async () => {
    // Without this whisper.cpp returns SUCCESS with zero segments and a short "yes"
    // becomes an empty transcript — the exact v1 defect this project exists to remove.
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost());
    const result = await target.transcribe(audio(0.2), 'uz');
    expect(result.raw).toContain('n=16000');
  });

  it('does not pad audio that is already long enough', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost());
    const result = await target.transcribe(audio(3), 'uz');
    expect(result.raw).toContain('n=48000');
  });

  it('trims the transcript and records the engine id', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost());
    const result = await target.transcribe(audio(2), 'uz');
    expect(result.raw.startsWith(' ')).toBe(false);
    expect(result.raw.endsWith(' ')).toBe(false);
    expect(result.engineId).toBe('whisper-test');
    expect(result.language).toBe('uz');
  });

  it('pins the language on every call and never asks whisper to detect', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost(), ['en', 'ru']);
    expect((await target.transcribe(audio(2), 'ru')).raw).toContain('lang=ru');
    expect((await target.transcribe(audio(2), 'en')).raw).toContain('lang=en');
  });

  it('asks for the prompt per call, so one engine can serve two languages', async () => {
    // D-W2 puts English and Russian on the same large-v3-turbo, and the hint is decoder
    // CONTEXT — a Russian exemplar sentence in front of English audio biases the decoder
    // toward Russian. macOS never had to solve this: each of its whisper engines serves
    // exactly one language (DictationController.swift:330-336).
    const path = await writeModel('m.bin');
    const target = createSttEngineWithHost({
      engineId: 'whisper-two-languages',
      modelPath: path,
      params: whisperParamsFor({
        language: 'ru',
        family: 'unified',
        settings: DEFAULT_SETTINGS,
        initialPrompt: 'built with this one',
        cpuCount: 8,
      }),
      hostPath: 'node',
      host: fakeHost(),
      supportedLanguages: ['en', 'ru'],
      initialPromptFor: (language) => (language === 'ru' ? 'Мирзо. Здесь имена написаны правильно.' : null),
    });
    expect((await target.transcribe(audio(2), 'ru')).raw).toContain(
      'prompt=[Мирзо. Здесь имена написаны правильно.]',
    );
    // `null`, not `''`: an empty prompt is not the same as no prompt to a decoder.
    expect((await target.transcribe(audio(2), 'en')).raw).toContain('prompt=[NONE]');
  });

  it('leaves the constructed prompt alone when no per-call resolver was given', async () => {
    const path = await writeModel('m.bin');
    const target = createSttEngineWithHost({
      engineId: 'whisper-fixed-prompt',
      modelPath: path,
      params: whisperParamsFor({
        language: 'uz',
        family: 'uzbek',
        settings: DEFAULT_SETTINGS,
        initialPrompt: 'Kotiba, Toshkent.',
        cpuCount: 8,
      }),
      hostPath: 'node',
      host: fakeHost(),
      supportedLanguages: ['uz'],
    });
    expect((await target.transcribe(audio(2), 'uz')).raw).toContain('prompt=[Kotiba, Toshkent.]');
  });

  it('serialises ten consecutive dictations without wedging', async () => {
    // Ten, not two. The macOS admission-gate bug refused every press after the first for
    // the life of the process, and two dictations would not have caught it.
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost({ delayMs: 3 }));
    for (let index = 0; index < 10; index += 1) {
      const result = await target.transcribe(audio(1.5), 'uz');
      expect(result.raw).toContain('maxInFlight=1');
    }
  });

  it('reloads rather than refusing forever when the host says it lost the model', async () => {
    const path = await writeModel('m.bin');
    const target = engine(path, fakeHost({ refuse: 'no_model' }));
    await target.prepare();
    expect(await target.isReady()).toBe(true);
    await expect(target.transcribe(audio(2), 'uz')).rejects.toThrow();
    // The next attempt must reload, not sit on a stale "resident" flag.
    expect(await target.isReady()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// One crash must not cost two dictations
// ---------------------------------------------------------------------------------
//
// `isReady()` answers "is the model resident". The weights live in the HOST PROCESS, so
// a flag that outlives the process is a lie — and it is not a harmless one. Press one
// kills the host; press two finds `loaded === true`, skips `prepare()`, and sends a
// transcribe frame to a fresh host with nothing loaded. Only press three recovered.

describe('a dead host takes the resident flag with it', () => {
  it('clears it when the host dies mid-request, and reloads on the next call', async () => {
    const path = await writeModel('m.bin');
    // Request 1 is the `load`; request 2 — the transcribe — takes the process down.
    const target = engineOwningHost(path, { dieOnRequest: 2 });
    await target.prepare();
    expect(await target.isReady()).toBe(true);

    await expect(target.transcribe(audio(2), 'uz')).rejects.toThrow();
    expect(await target.isReady()).toBe(false);

    // And it is a TRIGGER, not a latch: the replacement host loads and dictates. The
    // blob is per-process, so the replacement dies on ITS second request too — the load
    // is its first, which is the whole of what "reloads on the next call" means.
    await target.prepare();
    expect(await target.isReady()).toBe(true);
  });

  it('clears it when the host dies with nothing in flight', async () => {
    // OOM between dictations. Nothing asks the host anything, so nothing discovers the
    // death except the client's own `close` handler — which is why the engine needs to
    // be told rather than to find out.
    const path = await writeModel('m.bin');
    const target = engineOwningHost(path, { exitAfterMs: 80 });
    await target.prepare();
    expect(await target.isReady()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await target.isReady()).toBe(false);
  });

  it('reads the language head over a fitted window when asked, the full one otherwise', async () => {
    const path = await writeModel('turbo.bin');
    const target = createSttEngineWithHost({
      engineId: 'whisper-turbo-tr',
      modelPath: path,
      params: whisperParamsFor({
        language: 'tr',
        family: 'turkish',
        settings: DEFAULT_SETTINGS,
        initialPrompt: null,
        cpuCount: 8,
      }),
      hostPath: 'node',
      host: fakeHost(),
      supportedLanguages: ['tr'],
      flashAttention: false,
    });
    // 3 s is 150 positions; + 256 of silence is 406, rounded up to 512.
    const fitted = await target.detectLanguage(audio(3).samples, { headMargin: 256 });
    expect(fitted['window']).toBeCloseTo(0.0512, 6);
    const full = await target.detectLanguage(audio(3).samples);
    expect(full['window']).toBeUndefined();
    expect(full['tr']).toBeCloseTo(0.63, 6);
  });

  it('says so, rather than dropping the flag in silence', async () => {
    const path = await writeModel('m.bin');
    const notes: string[] = [];
    const target = createSttEngineWithHost({
      engineId: 'whisper-noted',
      modelPath: path,
      params: whisperParamsFor({
        language: 'uz',
        family: 'uzbek',
        settings: DEFAULT_SETTINGS,
        initialPrompt: null,
        cpuCount: 8,
      }),
      hostPath: 'node',
      supportedLanguages: ['uz'],
      onNote: (note) => notes.push(note),
      hostOptions: {
        spawnProcess: (): ChildProcessWithoutNullStreams =>
          spawn(process.execPath, [FAKE_HOST, JSON.stringify({ exitAfterMs: 80 })], {
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
      },
    });
    toDispose.push(target);
    await target.prepare();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(notes.join('\n')).toContain('the model will be reloaded');
  });
});
