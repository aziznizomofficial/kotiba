// The unified family with Parakeet at its head — the Mac's `.unified` slot on Windows.
//
// Four properties, each a way this goes wrong silently:
//   * a lead that is still downloading must hand the dictation to whisper, not fail it;
//   * a resident lead must NOT drag the 800 MB whisper model into memory behind it;
//   * readiness must neither demand the fallback (plain AND) nor lie (plain OR);
//   * a rebuild must keep the lead — it is not built from a path, and dropping it drops a load.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe as suite, expect, test } from 'vitest';

import {
  DEFAULT_SETTINGS,
  EngineFailure,
  GGML_MAGIC,
  MODEL_MINIMUM_BYTES,
  engineError,
  isStreamingEngine,
  type AudioBuffer,
  type Language,
  type ModelStatus,
  type StreamingSttEngine,
  type TranscriptionStream,
  type TranscriptResult,
} from '../../src/contracts/index.js';
import { createEngineManagerWith, createModelStore, type CreateSttEngineForRole } from '../../src/engines/index.js';

let root = '';
let models = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-lead-'));
  models = join(root, 'models');
  await mkdir(models, { recursive: true });
  const buffer = Buffer.alloc(MODEL_MINIMUM_BYTES + 1024);
  buffer.writeUInt32LE(GGML_MAGIC, 0);
  await writeFile(join(models, 'ggml-large-v3-turbo-q5_0.bin'), buffer);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const audio: AudioBuffer = { samples: new Float32Array(32000).fill(0.3), droppedSamples: 0 };

class Whisper {
  ready = false;
  prepares = 0;
  transcribes = 0;
  disposed = 0;
}

function whisperFactory(): { createEngine: CreateSttEngineForRole; made: Whisper[] } {
  const made: Whisper[] = [];
  return {
    made,
    createEngine: (options) => {
      const state = new Whisper();
      made.push(state);
      return {
        engineId: options.engineId,
        supportedLanguages: new Set<Language>(options.supportedLanguages ?? ['en', 'ru']),
        isReady: async () => state.ready,
        prepare: async () => {
          state.prepares += 1;
          state.ready = true;
        },
        transcribe: async (_audio: AudioBuffer, language: Language): Promise<TranscriptResult> => {
          state.transcribes += 1;
          return { raw: 'whisper text', language, engineId: options.engineId };
        },
        dispose: async () => {
          state.disposed += 1;
        },
      };
    },
  };
}

class Lead implements StreamingSttEngine {
  readonly engineId = 'parakeet-ultra';
  readonly supportedLanguages: ReadonlySet<Language> = new Set<Language>(['en', 'ru']);
  installed = false;
  ready = false;
  prepares = 0;
  disposed = 0;
  streamFails = false;
  async isReady(): Promise<boolean> {
    return this.ready;
  }
  async prepare(): Promise<void> {
    this.prepares += 1;
    if (!this.installed) throw new EngineFailure(engineError.notReady('Parakeet Ultra is still downloading'));
    this.ready = true;
  }
  async transcribe(_audio: AudioBuffer, language: Language): Promise<TranscriptResult> {
    if (!this.ready) throw new EngineFailure(engineError.notReady('not loaded'));
    return { raw: 'Parakeet text.', language, engineId: this.engineId };
  }
  openStream(): TranscriptionStream {
    return {
      append: () => undefined,
      cancel: () => undefined,
      finish: async (_audio, language) => {
        if (this.streamFails || !this.installed) throw new EngineFailure(engineError.notReady('still downloading'));
        return { raw: 'Streamed Parakeet.', language, engineId: this.engineId };
      },
    };
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

function build(lead: Lead) {
  const whisper = whisperFactory();
  const manager = createEngineManagerWith({
    settings: { ...DEFAULT_SETTINGS },
    models: createModelStore({ modelsDirectory: models, bundledDirectory: '' }),
    createEngine: whisper.createEngine,
    cpuCount: 4,
    unifiedLead: {
      engine: lead,
      status: async (): Promise<ModelStatus> => (lead.installed ? 'ready' : 'notInstalled'),
    },
  });
  return { manager, whisper };
}

suite('the unified family, led by Parakeet', () => {
  test('the lead is the first member, and the family streams', async () => {
    const lead = new Lead();
    const { manager } = build(lead);
    await manager.prepare({ eagerly: false, language: 'en' });
    const unified = manager.engineFor('unified')!;
    expect(unified.engineId).toBe('unified(parakeet-ultra, whisper-ggml-large-v3-turbo-q5_0)');
    expect(isStreamingEngine(unified)).toBe(true);
  });

  test('still downloading: whisper prepares and serves; nothing fails', async () => {
    const lead = new Lead();
    const { manager, whisper } = build(lead);
    await manager.prepare({ eagerly: false, language: 'en' });
    expect(whisper.made[0]!.prepares).toBe(1);
    const unified = manager.engineFor('unified')!;
    expect((await unified.transcribe(audio, 'ru')).engineId).toBe('whisper-ggml-large-v3-turbo-q5_0');
    // The stream falls back to the family's batch path on the same audio.
    const stream = (unified as StreamingSttEngine).openStream();
    expect((await stream.finish(audio, 'en')).engineId).toBe('whisper-ggml-large-v3-turbo-q5_0');
  });

  test('a resident lead leaves the whisper fallback cold, and the family reads READY', async () => {
    const lead = new Lead();
    lead.installed = true;
    const { manager, whisper } = build(lead);
    await manager.prepare({ eagerly: true });
    expect(lead.prepares).toBe(1);
    expect(whisper.made[0]!.prepares).toBe(0);
    const unified = manager.engineFor('unified')!;
    expect(await unified.isReady()).toBe(true);
    expect((await unified.transcribe(audio, 'en')).engineId).toBe('parakeet-ultra');
    const stream = (unified as StreamingSttEngine).openStream();
    expect((await stream.finish(audio, 'ru')).raw).toBe('Streamed Parakeet.');
  });

  test('readiness does not lie: a cold lead makes the family not ready', async () => {
    const lead = new Lead();
    const { manager } = build(lead);
    await manager.prepare({ eagerly: false, language: 'en' });
    expect(await manager.engineFor('unified')!.isReady()).toBe(false);
  });

  test('a stream that fails at key-up hands the same audio to the family', async () => {
    const lead = new Lead();
    lead.installed = true;
    lead.streamFails = true;
    const { manager } = build(lead);
    await manager.prepare({ eagerly: false, language: 'en' });
    const stream = (manager.engineFor('unified') as StreamingSttEngine).openStream();
    expect((await stream.finish(audio, 'en')).engineId).toBe('parakeet-ultra');
  });

  test('English and Russian are available from the lead alone, once it is on disk', async () => {
    const lead = new Lead();
    lead.installed = true;
    await rm(join(models, 'ggml-large-v3-turbo-q5_0.bin'));
    const { manager } = build(lead);
    const readiness = await manager.readiness();
    expect(readiness.unified).toBe('ready');
    expect([...readiness.availableLanguages].sort()).toEqual(['en', 'ru']);
  });

  test('a rebuild keeps the lead; only dispose releases it', async () => {
    const lead = new Lead();
    lead.installed = true;
    const { manager } = build(lead);
    await manager.prepare({ eagerly: false, language: 'en' });
    await manager.reconfigure({ ...DEFAULT_SETTINGS, whisperBeamSize: 3 });
    expect(lead.disposed).toBe(0);
    expect(manager.engineFor('unified')!.engineId.startsWith('unified(parakeet-ultra')).toBe(true);
    await manager.dispose();
    expect(lead.disposed).toBe(1);
  });
});
