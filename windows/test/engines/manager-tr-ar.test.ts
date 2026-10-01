// C4: the Turkish and Arabic families in the engine manager.
//
//   * Turkish is the unified slot's turbo FILE with its own job — a member that claims only `tr`,
//     greedy, and never the unified slot's `en`/`ru`.
//   * Arabic is led by its own engine (Cohere / FastConformer) with turbo behind it — the member
//     that serves Arabic before the download lands, and the one the lead is handed for the
//     decode-loop guard.
//   * Neither is "available" until the user turns it on, and neither loads on the eager preload.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe as suite, expect, test } from 'vitest';

import {
  DEFAULT_SETTINGS,
  EngineFailure,
  GGML_MAGIC,
  MODEL_MINIMUM_BYTES,
  TURKISH_HEAD_MARGIN,
  engineError,
  engineFamilyFor,
  type AudioBuffer,
  type Language,
  type ModelStatus,
  type Settings,
  type StreamingSttEngine,
  type SttEngine,
  type TranscriptionStream,
  type TranscriptResult,
} from '../../src/contracts/index.js';
import { createEngineManagerWith, createModelStore, roleFor, type CreateSttEngineForRole } from '../../src/engines/index.js';
import type { WhisperParams } from '../../src/contracts/index.js';

let root = '';
let models = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-tr-ar-'));
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

interface Made {
  readonly engineId: string;
  readonly languages: readonly Language[];
  readonly params: WhisperParams;
  ready: boolean;
}

function whisperFactory(): { createEngine: CreateSttEngineForRole; made: Made[] } {
  const made: Made[] = [];
  return {
    made,
    createEngine: (options) => {
      const state: Made = {
        engineId: options.engineId,
        languages: [...(options.supportedLanguages ?? [])],
        params: options.params,
        ready: false,
      };
      made.push(state);
      return {
        engineId: options.engineId,
        supportedLanguages: new Set<Language>(state.languages),
        isReady: async () => state.ready,
        prepare: async () => {
          state.ready = true;
        },
        transcribe: async (_audio: AudioBuffer, language: Language): Promise<TranscriptResult> => ({
          raw: `whisper:${language}:${options.initialPromptFor?.(language) ?? ''}`,
          language,
          engineId: options.engineId,
        }),
        dispose: async () => undefined,
        // The whisper engine's own language head (`detectLanguage`), answering for its model.
        // `margin` echoes the head window it was asked for (-1: the model's own).
        detectLanguage: async (_samples: Float32Array, detect?: { readonly headMargin?: number }) => ({
          tr: 0.995,
          az: 0.005,
          heardBy: state.engineId.length,
          margin: detect?.headMargin ?? -1,
        }),
      };
    },
  };
}

class ArabicLead implements StreamingSttEngine {
  readonly engineId = 'cohere-transcribe-arabic-07-2026-q5_k_m';
  readonly supportedLanguages: ReadonlySet<Language> = new Set<Language>(['ar']);
  installed = false;
  ready = false;
  fallback: SttEngine | null | undefined = undefined;
  attachFallback(engine: SttEngine | null): void {
    this.fallback = engine;
  }
  async isReady(): Promise<boolean> {
    return this.ready;
  }
  async prepare(): Promise<void> {
    if (!this.installed) throw new EngineFailure(engineError.notReady('Cohere Transcribe Arabic is still downloading'));
    this.ready = true;
  }
  async transcribe(_audio: AudioBuffer, language: Language): Promise<TranscriptResult> {
    return { raw: 'Cohere.', language, engineId: this.engineId };
  }
  openStream(): TranscriptionStream {
    return {
      append: () => undefined,
      cancel: () => undefined,
      finish: async (_audio, language) => {
        if (!this.installed) throw new EngineFailure(engineError.notReady('still downloading'));
        return { raw: 'Streamed Cohere.', language, engineId: this.engineId };
      },
    };
  }
  async dispose(): Promise<void> {
    /* the composition root's */
  }
}

function build(patch: Partial<Settings> = {}, lead: ArabicLead = new ArabicLead()) {
  const whisper = whisperFactory();
  const manager = createEngineManagerWith({
    settings: { ...DEFAULT_SETTINGS, ...patch },
    models: createModelStore({ modelsDirectory: models, bundledDirectory: '' }),
    createEngine: whisper.createEngine,
    cpuCount: 4,
    arabicLead: {
      engine: lead,
      status: async (): Promise<ModelStatus> => (lead.installed ? 'ready' : 'notInstalled'),
    },
  });
  return { manager, whisper, lead };
}

suite('the families', () => {
  test('tr → turkish, ar → arabic; both on the turbo file’s role', () => {
    expect(engineFamilyFor('tr')).toBe('turkish');
    expect(engineFamilyFor('ar')).toBe('arabic');
    expect(roleFor('tr', DEFAULT_SETTINGS)).toBe('russian');
    expect(roleFor('ar', DEFAULT_SETTINGS)).toBe('russian');
  });

  test('Turkish: one turbo member that claims ONLY tr, greedy, with its own id', async () => {
    const { manager, whisper } = build();
    await manager.reconfigure({ ...DEFAULT_SETTINGS });
    const turkish = manager.engineFor('turkish')!;
    expect(turkish.engineId).toBe('turkish(whisper-ggml-large-v3-turbo-q5_0-tr)');
    expect([...turkish.supportedLanguages]).toEqual(['tr']);
    const member = whisper.made.find((made) => made.engineId.endsWith('-tr'))!;
    expect(member.languages).toEqual(['tr']);
    expect(member.params.strategy).toBe('greedy');
    // The unified slot's member is untouched: en and ru, and the setting's beam.
    const unified = whisper.made.find((made) => made.engineId === 'whisper-ggml-large-v3-turbo-q5_0')!;
    expect(unified.languages).toEqual(['en', 'ru']);
    await expect(turkish.transcribe(audio, 'en')).rejects.toThrow();
  });

  test('Arabic: the lead first, turbo behind it — and the lead is handed that member', async () => {
    const { manager, lead } = build();
    await manager.reconfigure({ ...DEFAULT_SETTINGS });
    const arabic = manager.engineFor('arabic')!;
    expect(arabic.engineId).toBe('arabic(cohere-transcribe-arabic-07-2026-q5_k_m, whisper-ggml-large-v3-turbo-q5_0-ar)');
    expect(lead.fallback?.engineId).toBe('whisper-ggml-large-v3-turbo-q5_0-ar');
  });

  test('Arabic before the download: whisper serves it, with the Arabic prompt (C4 §3.2)', async () => {
    const { manager } = build();
    await manager.prepare({ eagerly: false, language: 'ar' });
    const arabic = manager.engineFor('arabic')!;
    const result = await arabic.transcribe(audio, 'ar');
    expect(result.engineId).toBe('whisper-ggml-large-v3-turbo-q5_0-ar');
    expect(result.raw).toContain('؟');
    const streamed = await (arabic as StreamingSttEngine).openStream().finish(audio, 'ar');
    expect(streamed.engineId).toBe('whisper-ggml-large-v3-turbo-q5_0-ar');
  });

  test('Arabic once downloaded: the lead serves, and whisper stays cold', async () => {
    const lead = new ArabicLead();
    lead.installed = true;
    const { manager, whisper } = build({}, lead);
    await manager.prepare({ eagerly: false, language: 'ar' });
    expect((await manager.engineFor('arabic')!.transcribe(audio, 'ar')).engineId).toBe(lead.engineId);
    expect(whisper.made.find((made) => made.engineId.endsWith('-ar'))?.ready).toBe(false);
  });

  test('the eager preload adds an optional family once it is on', async () => {
    const { manager, whisper } = build({ enabledLanguages: ['en', 'ru', 'uz', 'tr'] });
    await manager.prepare({ eagerly: true });
    expect(whisper.made.find((made) => made.engineId.endsWith('-tr'))?.ready).toBe(true);
    expect(whisper.made.find((made) => made.engineId.endsWith('-ar'))?.ready).toBe(false);
  });

  test('the Turkish verifier asks the Turkish engine’s own language head, over the fitted window', async () => {
    const { manager } = build({ enabledLanguages: ['en', 'ru', 'uz', 'tr'] });
    await manager.reconfigure({ ...DEFAULT_SETTINGS, enabledLanguages: ['en', 'ru', 'uz', 'tr'] });
    const verifier = manager.languageHead?.() ?? null;
    expect(verifier).not.toBeNull();
    // Answered by the `-tr` member (its id's length marks which engine answered).
    expect(await verifier!.posterior(audio)).toEqual({
      tr: 0.995,
      az: 0.005,
      heardBy: 'whisper-ggml-large-v3-turbo-q5_0-tr'.length,
      margin: TURKISH_HEAD_MARGIN,
    });
  });

  test('with only Arabic on, the head is Arabic’s own turbo member (C4 §14.1)', async () => {
    const { manager } = build({ enabledLanguages: ['en', 'ru', 'uz', 'ar'] });
    await manager.reconfigure({ ...DEFAULT_SETTINGS, enabledLanguages: ['en', 'ru', 'uz', 'ar'] });
    const head = manager.languageHead?.() ?? null;
    expect(head).not.toBeNull();
    const answer = await head!.posterior(audio);
    expect(answer['heardBy']).toBe('whisper-ggml-large-v3-turbo-q5_0-ar'.length);
    expect(answer['margin']).toBe(TURKISH_HEAD_MARGIN);
  });

  test('the eager preload loads the core families only', async () => {
    const { manager, whisper } = build();
    await manager.prepare({ eagerly: true });
    expect(whisper.made.find((made) => made.engineId.endsWith('-tr'))?.ready).toBe(false);
    expect(whisper.made.find((made) => made.engineId.endsWith('-ar'))?.ready).toBe(false);
  });
});

suite('readiness', () => {
  test('neither is available until it is turned on', async () => {
    const { manager } = build();
    const off = await manager.readiness();
    expect(off.turkish).toBe('ready');
    expect(off.arabic).toBe('ready');
    expect(off.availableLanguages.has('tr')).toBe(false);
    expect(off.availableLanguages.has('ar')).toBe(false);

    await manager.reconfigure({ ...DEFAULT_SETTINGS, enabledLanguages: ['en', 'ru', 'uz', 'tr', 'ar'] });
    const on = await manager.readiness();
    expect(on.availableLanguages.has('tr')).toBe(true);
    // Available at once: whisper serves Arabic until Cohere lands.
    expect(on.availableLanguages.has('ar')).toBe(true);
  });

  test('no turbo file: Turkish is not available, Arabic only through its own engine', async () => {
    await rm(join(models, 'ggml-large-v3-turbo-q5_0.bin'));
    const lead = new ArabicLead();
    const { manager } = build({ enabledLanguages: ['en', 'ru', 'uz', 'tr', 'ar'] }, lead);
    const without = await manager.readiness();
    expect(without.availableLanguages.has('tr')).toBe(false);
    expect(without.availableLanguages.has('ar')).toBe(false);
    lead.installed = true;
    expect((await manager.readiness()).availableLanguages.has('ar')).toBe(true);
  });
});
