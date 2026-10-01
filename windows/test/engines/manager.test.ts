// The engine manager: which model serves which language, and the readiness that must
// not lie.
//
// The macOS composite computed `isReady()` as an OR over its members. Apple's engine is
// prepared at startup and never unloads, so it read TRUE FOREVER whatever state the
// Russian model was in — the session's cold-start retry never fired and Russian stayed
// broken one level below the fix that was supposed to have fixed it.

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEngineManagerWith,
  createModelStore,
  roleFor,
  type CreateSttEngineForRole,
} from '../../src/engines/index.js';
import {
  DEFAULT_SETTINGS,
  EngineFailure,
  engineError,
  GGML_MAGIC,
  MODEL_MINIMUM_BYTES,
  type AudioBuffer,
  type CreateSttEngine,
  type Language,
  type Settings,
  type SttEngine,
  type TranscriptResult,
} from '../../src/contracts/index.js';

let root = '';
let models = '';
let bundled = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-manager-'));
  models = join(root, 'models');
  bundled = join(root, 'app');
  await mkdir(models, { recursive: true });
  await mkdir(bundled, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeModel(name: string, into = models): Promise<string> {
  const path = join(into, name);
  const buffer = Buffer.alloc(MODEL_MINIMUM_BYTES + 1024);
  buffer.writeUInt32LE(GGML_MAGIC, 0);
  await writeFile(path, buffer);
  return path;
}

const UZBEK = 'ggml-uzbek-stt-v1-q5_0.bin';
const TURBO = 'ggml-large-v3-turbo-q5_0.bin';
const BASE = 'ggml-base-q5_1.bin';
const SMALL_EN = 'ggml-small.en-q5_1.bin';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

const audio: AudioBuffer = { samples: new Float32Array(32000).fill(0.3), droppedSamples: 0 };

/**
 * A fake engine whose readiness and load behaviour the test drives directly. The real
 * one is exercised against a real process in stt-engine.test.ts; here the subject is the
 * WRAPPER, and a wrapper is exactly the thing that lies.
 */
interface Fake extends SttEngine {
  loadCount: number;
  failLoad: boolean;
  setReady(ready: boolean): void;
  /** The idle-unload seam. Optional in reality, so one test deletes it. */
  unload?(): Promise<void>;
}

function fakeEngineFactory(configure?: (engine: Fake, modelPath: string) => void): {
  createEngine: CreateSttEngine;
  engines: Fake[];
} {
  const engines: Fake[] = [];
  const createEngine: CreateSttEngine = (options) => {
    let ready = false;
    const languages: Language[] = options.modelPath.includes('uzbek')
      ? ['uz']
      : options.modelPath.includes('small.en')
        ? ['en']
        : ['en', 'ru'];

    const engine: Fake = {
      engineId: options.engineId,
      supportedLanguages: new Set(languages),
      loadCount: 0,
      failLoad: false,
      setReady: (value: boolean) => {
        ready = value;
      },
      isReady: async () => ready,
      prepare: async () => {
        engine.loadCount += 1;
        if (engine.failLoad) {
          throw new EngineFailure(engineError.modelCorrupt(options.modelPath, 'test refusal'));
        }
        ready = true;
      },
      transcribe: async (_audio: AudioBuffer, language: Language): Promise<TranscriptResult> => {
        if (!ready) throw new EngineFailure(engineError.notReady('not loaded'));
        return { raw: `${options.engineId}:${language}`, language, engineId: options.engineId };
      },
      unload: async () => {
        ready = false;
      },
      dispose: async () => {
        ready = false;
      },
    };
    configure?.(engine, options.modelPath);
    engines.push(engine);
    return engine;
  };
  return { createEngine, engines };
}

/**
 * A fake engine wired the way BOTH composition roots were: languages guessed from the
 * model's FILENAME, `includes('uzbek') || includes('navoi') ? ['uz'] : ['en','ru']`.
 *
 * It also records what the manager told it, so the two halves of FINDING 7 can be
 * asserted separately: that the manager now STATES the role's languages, and that its
 * routing no longer depends on the engine agreeing.
 */
function rootHeuristicFactory(): {
  createEngine: CreateSttEngineForRole;
  told: { engineId: string; languages: Language[] }[];
  transcribedBy: string[];
  /** What the real engine would have put on the wire as `initial_prompt`, per decode. */
  prompts: { engineId: string; language: Language; prompt: string | null }[];
  /** The construction-time value, which the diagnostics pane shows. */
  constructedWith: { engineId: string; initialPrompt: string | null }[];
} {
  const told: { engineId: string; languages: Language[] }[] = [];
  const transcribedBy: string[] = [];
  const prompts: { engineId: string; language: Language; prompt: string | null }[] = [];
  const constructedWith: { engineId: string; initialPrompt: string | null }[] = [];
  const createEngine: CreateSttEngineForRole = (options) => {
    told.push({
      engineId: options.engineId,
      languages: [...(options.supportedLanguages ?? [])],
    });
    constructedWith.push({
      engineId: options.engineId,
      initialPrompt: options.params.initialPrompt,
    });
    const guessed: Language[] =
      options.modelPath.includes('uzbek') || options.modelPath.includes('navoi')
        ? ['uz']
        : ['en', 'ru'];
    let ready = false;
    return {
      engineId: options.engineId,
      // The LIE, verbatim from src/main/index.ts and src/main/check.ts.
      supportedLanguages: new Set(guessed),
      isReady: async () => ready,
      prepare: async () => {
        ready = true;
      },
      transcribe: async (_audio: AudioBuffer, language: Language): Promise<TranscriptResult> => {
        transcribedBy.push(options.engineId);
        // Exactly what the real engine does on the way to the host: ask per call.
        prompts.push({
          engineId: options.engineId,
          language,
          prompt: options.initialPromptFor?.(language) ?? null,
        });
        return { raw: `${options.engineId}:${language}`, language, engineId: options.engineId };
      },
      dispose: async () => {
        ready = false;
      },
    };
  };
  return { createEngine, told, transcribedBy, prompts, constructedWith };
}

function manager(
  current: Settings,
  // `engines` is optional so a factory that watches something else can be passed. Note
  // the default is still a plain `CreateSttEngine`: the widened options field is
  // OPTIONAL, so the contract factory stays assignable and this is where that is proved.
  factory: { createEngine: CreateSttEngineForRole; engines?: Fake[] } = fakeEngineFactory(),
  extra = {},
) {
  return {
    manager: createEngineManagerWith({
      settings: current,
      models: createModelStore({ modelsDirectory: models, bundledDirectory: bundled }),
      createEngine: factory.createEngine,
      cpuCount: 4,
      ...extra,
    }),
    engines: factory.engines ?? [],
  };
}

describe('roleFor — which model serves which language', () => {
  it('sends Uzbek to the Uzbek model', () => {
    expect(roleFor('uz', settings())).toBe('uzbek');
  });

  it('sends BOTH English and Russian to large-v3-turbo by default (D-W2)', () => {
    expect(roleFor('ru', settings())).toBe('russian');
    expect(roleFor('en', settings())).toBe('russian');
  });

  it('sends English to small.en only when Fast English is on', () => {
    expect(roleFor('en', settings({ fastEnglish: true }))).toBe('fastEnglish');
    // Russian never moves: small.en cannot do it.
    expect(roleFor('ru', settings({ fastEnglish: true }))).toBe('russian');
  });
});

describe('readiness does not lie', () => {
  it('is NOT an OR over members — one warm member does not make the slot ready', async () => {
    await writeModel(UZBEK);
    await writeModel(TURBO);
    await writeModel(SMALL_EN);
    const { manager: subject, engines } = manager(settings({ fastEnglish: true }));
    await subject.prepare({ eagerly: false, language: 'en' });

    const unified = subject.engineFor('unified');
    // The unified slot's two; the turbo file's Turkish and Arabic members (`-tr`, `-ar`) are
    // other families' and are not asked here.
    const members = engines.filter(
      (engine) => engine.engineId.includes('small.en') || engine.engineId === 'whisper-ggml-large-v3-turbo-q5_0',
    );
    expect(members.length).toBe(2);

    // Exactly the macOS shape: one member warm, one cold.
    members[0]?.setReady(true);
    members[1]?.setReady(false);
    expect(await unified?.isReady()).toBe(false);

    members[1]?.setReady(true);
    expect(await unified?.isReady()).toBe(true);

    await subject.dispose();
  });

  it('an empty slot is not ready — an OR over nothing is false by luck, not by intent', async () => {
    const { manager: subject } = manager(settings());
    await subject.prepare({ eagerly: true });
    expect(await subject.engineFor('uzbek')?.isReady()).toBe(false);
    await subject.dispose();
  });

  it('asks the model store, not the engines — a cold model is still an available language', async () => {
    await writeModel(UZBEK);
    await writeModel(TURBO);
    await writeModel(BASE);
    const { manager: subject } = manager(settings());
    // Nothing has been prepared. Every engine is cold.
    const readiness = await subject.readiness();
    expect(readiness.uzbek).toBe('ready');
    expect(readiness.unified).toBe('ready');
    expect(readiness.detector).toBe('ready');
    expect([...readiness.availableLanguages].sort()).toEqual(['en', 'ru', 'uz']);
    await subject.dispose();
  });

  it('reports a corrupt model as corrupt, not as notInstalled', async () => {
    await writeFile(join(models, UZBEK), Buffer.alloc(4096));
    await writeModel(TURBO);
    const { manager: subject } = manager(settings());
    const readiness = await subject.readiness();
    expect(readiness.uzbek).toBe('corrupt');
    expect(readiness.availableLanguages.has('uz')).toBe(false);
    await subject.dispose();
  });

  it('does not let Fast English make the unified slot look ready for Russian', async () => {
    // The OR bug, one name further down: small.en cannot do Russian.
    await writeModel(SMALL_EN);
    const { manager: subject } = manager(settings({ fastEnglish: true }));
    const readiness = await subject.readiness();
    expect(readiness.unified).toBe('notInstalled');
    expect(readiness.availableLanguages.has('en')).toBe(true);
    expect(readiness.availableLanguages.has('ru')).toBe(false);
    await subject.dispose();
  });

  it('reports the detector as notInstalled when there is nothing to detect (one language on)', async () => {
    await writeModel(BASE);
    const { manager: subject } = manager(settings({ enabledLanguages: ['en'] }));
    expect((await subject.readiness()).detector).toBe('notInstalled');
    await subject.dispose();
  });
});

describe('the family slot loads its own cold members', () => {
  it('loads a cold member on transcribe rather than skipping it', async () => {
    // Before this fix, every Russian dictation failed on stock defaults because nothing
    // on this path ever called prepare().
    await writeModel(TURBO);
    const { manager: subject, engines } = manager(settings());
    await subject.reconfigure(settings());
    const unified = subject.engineFor('unified');
    expect(await unified?.isReady()).toBe(false);

    const result = await unified?.transcribe(audio, 'ru');
    expect(result?.raw).toContain(':ru');
    expect(engines[0]?.loadCount).toBe(1);
    await subject.dispose();
  });

  it('prefers small.en for English when Fast English is on, and keeps turbo for Russian', async () => {
    await writeModel(TURBO);
    await writeModel(SMALL_EN);
    const { manager: subject } = manager(settings({ fastEnglish: true }));
    await subject.reconfigure(settings({ fastEnglish: true }));
    const unified = subject.engineFor('unified');
    expect((await unified?.transcribe(audio, 'en'))?.raw).toContain('small.en');
    expect((await unified?.transcribe(audio, 'ru'))?.raw).toContain('turbo');
    await subject.dispose();
  });

  it('falls past a member that refuses to load, to one that will', async () => {
    await writeModel(TURBO);
    await writeModel(SMALL_EN);
    const factory = fakeEngineFactory((engine, modelPath) => {
      if (modelPath.includes('small.en')) engine.failLoad = true;
    });
    const { manager: subject } = manager(settings({ fastEnglish: true }), factory);
    await subject.reconfigure(settings({ fastEnglish: true }));
    const result = await subject.engineFor('unified')?.transcribe(audio, 'en');
    expect(result?.raw).toContain('turbo');
    await subject.dispose();
  });

  it('says noEngineInstalled — a setup fact — when no member claims the language', async () => {
    await writeModel(SMALL_EN);
    const { manager: subject } = manager(settings({ fastEnglish: true }));
    await subject.reconfigure(settings({ fastEnglish: true }));
    // Reporting this as languageUnsupported told the user the router had misrouted when
    // all they had done was never choose a model.
    await expect(subject.engineFor('unified')?.transcribe(audio, 'ru')).rejects.toThrow(
      /no ru model is installed/,
    );
    await subject.dispose();
  });

  it('prepares every member, and one failing does not stop the others', async () => {
    await writeModel(TURBO);
    await writeModel(SMALL_EN);
    const factory = fakeEngineFactory((engine, modelPath) => {
      if (modelPath.includes('small.en')) engine.failLoad = true;
    });
    const { manager: subject } = manager(settings({ fastEnglish: true }), factory);
    await subject.reconfigure(settings({ fastEnglish: true }));
    // Only a TOTAL failure is a failure: an app with no Russian model must still
    // dictate English, and vice versa.
    await expect(subject.engineFor('unified')?.prepare()).resolves.toBeUndefined();
    await subject.dispose();
  });

  it('throws when EVERY member fails', async () => {
    await writeModel(TURBO);
    const factory = fakeEngineFactory((engine) => {
      engine.failLoad = true;
    });
    const { manager: subject } = manager(settings(), factory);
    await subject.reconfigure(settings());
    await expect(subject.engineFor('unified')?.prepare()).rejects.toThrow();
    await subject.dispose();
  });
});

// ---------------------------------------------------------------------------------
// FINDING 7 — languages come from the ROLE, never from the filename
// ---------------------------------------------------------------------------------
//
// Both composition roots computed an engine's languages from its model FILENAME:
//
//     supportedLanguagesFor: (engineId) =>
//       engineId.includes('uzbek') || engineId.includes('navoi') ? ['uz'] : ['en', 'ru']
//
// while the manager was already holding `languagesForRole(role)` and never passing it on.
// Two silent failures follow, in opposite directions, and both are decided by a string
// the user chose when they saved a file.

describe('languages by role, not by filename', () => {
  it('THE REGRESSION: Fast English does not send Russian audio to small.en', async () => {
    // `whisper-ggml-small.en-q5_1` contains neither 'uzbek' nor 'navoi', so the root's
    // heuristic gave it ['en','ru'] — and with Fast English on it is the FIRST member of
    // the unified family, so it won the scan for Russian. An English-only model then
    // decoded Russian audio and returned a confident transcript. No error, no note.
    await writeModel(TURBO);
    await writeModel(SMALL_EN);
    const factory = rootHeuristicFactory();
    const { manager: subject } = manager(settings({ fastEnglish: true }), factory);
    await subject.reconfigure(settings({ fastEnglish: true }));

    const russian = await subject.engineFor('unified')?.transcribe(audio, 'ru');
    expect(russian?.engineId).toContain('turbo');
    expect(factory.transcribedBy).not.toContain('whisper-ggml-small.en-q5_1');

    // And English still prefers small.en — the preference is the point of the setting.
    const english = await subject.engineFor('unified')?.transcribe(audio, 'en');
    expect(english?.engineId).toContain('small.en');
    await subject.dispose();
  });

  it('THE REGRESSION: an Uzbek model whose file is not named "uzbek" still does Uzbek', async () => {
    // A user who renames the file, or points `uzbekModelPath` at any other valid ggml,
    // got a uzbek family whose only member claimed ['en','ru'] — so every Uzbek
    // dictation threw noEngineInstalled('uz') against a model that was right there.
    const renamed = await writeModel('ggml-my-own-model-q5_0.bin');
    const factory = rootHeuristicFactory();
    const { manager: subject } = manager(settings({ uzbekModelPath: renamed }), factory);
    await subject.reconfigure(settings({ uzbekModelPath: renamed }));

    const uzbek = subject.engineFor('uzbek');
    expect(uzbek?.supportedLanguages.has('uz')).toBe(true);
    const result = await uzbek?.transcribe(audio, 'uz');
    expect(result?.raw).toContain(':uz');
    await subject.dispose();
  });

  it('states each engine\'s languages to the factory, from the role it resolved', async () => {
    await writeModel(UZBEK);
    await writeModel(TURBO);
    await writeModel(SMALL_EN);
    const factory = rootHeuristicFactory();
    const { manager: subject } = manager(settings({ fastEnglish: true }), factory);
    await subject.reconfigure(settings({ fastEnglish: true }));

    const told = new Map(factory.told.map((entry) => [entry.engineId, entry.languages]));
    expect(told.get('whisper-ggml-uzbek-stt-v1-q5_0')).toEqual(['uz']);
    expect(told.get('whisper-ggml-small.en-q5_1')).toEqual(['en']);
    expect(told.get('whisper-ggml-large-v3-turbo-q5_0')).toEqual(['en', 'ru']);
    await subject.dispose();
  });

  it('a family reports the union of its ROLES, not of its engines\' claims', async () => {
    await writeModel(SMALL_EN);
    const factory = rootHeuristicFactory();
    const { manager: subject } = manager(settings({ fastEnglish: true }), factory);
    await subject.reconfigure(settings({ fastEnglish: true }));
    // The engine claims ['en','ru']. The role says ['en'], and the role is the fact.
    expect([...(subject.engineFor('unified')?.supportedLanguages ?? [])]).toEqual(['en']);
    await subject.dispose();
  });
});

// ---------------------------------------------------------------------------------
// The vocabulary has to actually reach whisper
// ---------------------------------------------------------------------------------
//
// `initialPrompt` was hard-coded `null` where the params are built, so the vocabulary
// pane wrote terms that reached nothing while its help text promised they would bias the
// decoder. 02-BEHAVIOUR §4 measures what it costs on the 344-clip Uzbek set: the exemplar
// sentence alone moves punctuation emission 68.3% → 88.4%, terms plus exemplar → 91.0%.

describe('the vocabulary hint', () => {
  const EXEMPLAR_UZ = 'Bu yerda ismlar toʻgʻri yozilgan.';

  async function decode(current: Settings, language: Language, family: 'uzbek' | 'unified') {
    const factory = rootHeuristicFactory();
    const { manager: subject } = manager(current, factory);
    await subject.reconfigure(current);
    await subject.engineFor(family)?.transcribe(audio, language);
    return { factory, subject };
  }

  it('THE REGRESSION: an Uzbek decode carries the exemplar even with no terms set', async () => {
    // Most people never open the vocabulary pane. 20 points of punctuation for nothing —
    // and punctuation is also every capital after the first, because the capitaliser
    // finds sentence starts by looking for `.`, `!` and `?`.
    await writeModel(UZBEK);
    const { factory, subject } = await decode(settings(), 'uz', 'uzbek');
    expect(factory.prompts.at(-1)?.prompt).toBe(EXEMPLAR_UZ);
    await subject.dispose();
  });

  it('punctuates the terms and appends the exemplar', async () => {
    await writeModel(UZBEK);
    const { factory, subject } = await decode(
      settings({ vocabulary: { uz: ['Kotiba', 'Toshkent'] } }),
      'uz',
      'uzbek',
    );
    expect(factory.prompts.at(-1)?.prompt).toBe(`Kotiba, Toshkent. ${EXEMPLAR_UZ}`);
    await subject.dispose();
  });

  it('tidies the terms, because nothing on the settings path does', async () => {
    // Raw, `['', ' Kotiba ', 'kotiba']` becomes ", Kotiba , kotiba." — a model of badly typed
    // prose handed to the decoder as an example of what to produce.
    await writeModel(UZBEK);
    const { factory, subject } = await decode(
      settings({ vocabulary: { uz: ['', '  Kotiba  ', 'kotiba', 'Toshkent'] } }),
      'uz',
      'uzbek',
    );
    expect(factory.prompts.at(-1)?.prompt).toBe(`Kotiba, Toshkent. ${EXEMPLAR_UZ}`);
    await subject.dispose();
  });

  it('is PER LANGUAGE on the one engine that spans two of them', async () => {
    // D-W2 puts English and Russian on the same large-v3-turbo. The hint is decoder
    // CONTEXT, so a Russian exemplar in front of English audio biases the decoder toward
    // Russian — which is the shape of the failure this whole app is built around. A
    // per-engine prompt cannot get this right; the manager answers per call.
    await writeModel(TURBO);
    const current = settings({ vocabulary: { ru: ['Мирзо'], en: ['Telegram'] } });
    const factory = rootHeuristicFactory();
    const { manager: subject } = manager(current, factory);
    await subject.reconfigure(current);

    const unified = subject.engineFor('unified');
    await unified?.transcribe(audio, 'ru');
    await unified?.transcribe(audio, 'en');

    expect(factory.prompts[0]).toEqual({
      engineId: 'whisper-ggml-large-v3-turbo-q5_0',
      language: 'ru',
      prompt: 'Мирзо. Здесь имена написаны правильно.',
    });
    // No exemplar for English: whisper is not the English engine on macOS, and nothing
    // measured licenses inventing one here.
    expect(factory.prompts[1]?.prompt).toBe('Telegram.');
    await subject.dispose();
  });

  it('sends no prompt at all for English with no terms — null, never the empty string', async () => {
    // `null` and `''` are different instructions: null leaves the field at nullptr, an
    // empty string prepends nothing but still switches the decoder's code path.
    await writeModel(TURBO);
    const { factory, subject } = await decode(settings(), 'en', 'unified');
    expect(factory.prompts.at(-1)?.prompt).toBeNull();
    await subject.dispose();
  });

  it('records the primary language\'s hint in the constructed params, so a dump is honest', async () => {
    await writeModel(UZBEK);
    const factory = rootHeuristicFactory();
    const { manager: subject } = manager(settings(), factory);
    await subject.reconfigure(settings());
    expect(factory.constructedWith.at(-1)?.initialPrompt).toBe(EXEMPLAR_UZ);
    await subject.dispose();
  });

  it('picks up an edited vocabulary without re-reading 539 MB off disk', async () => {
    // The hint is read at DECODE time from the live settings. Rebuilding the engine to
    // pick up a new word would cost a model reload — about 7.8 s on the macOS measurement
    // — for typing a name into a settings pane.
    await writeModel(UZBEK);
    const factory = rootHeuristicFactory();
    const { manager: subject } = manager(settings(), factory);
    await subject.reconfigure(settings());
    const before = subject.engineFor('uzbek');
    const builtEngines = factory.told.length;

    await subject.reconfigure(settings({ vocabulary: { uz: ['Navoiy'] } }));
    expect(subject.engineFor('uzbek')).toBe(before);
    expect(factory.told.length).toBe(builtEngines);

    await subject.engineFor('uzbek')?.transcribe(audio, 'uz');
    expect(factory.prompts.at(-1)?.prompt).toBe(`Navoiy. ${EXEMPLAR_UZ}`);
    await subject.dispose();
  });
});

describe('preloadAllLanguages', () => {
  it('loads only the family about to be used when it is off', async () => {
    await writeModel(UZBEK);
    await writeModel(TURBO);
    const { manager: subject, engines } = manager(settings());
    await subject.prepare({ eagerly: false, language: 'uz' });
    const uzbek = engines.find((engine) => engine.engineId.includes('uzbek'));
    const turbo = engines.find((engine) => engine.engineId.includes('turbo'));
    expect(await uzbek?.isReady()).toBe(true);
    // Both whisper models resident took the macOS app from 110 MB to 1.47 GB.
    expect(await turbo?.isReady()).toBe(false);
    await subject.dispose();
  });

  it('loads every configured family when it is on', async () => {
    await writeModel(UZBEK);
    await writeModel(TURBO);
    const { manager: subject, engines } = manager(settings({ preloadAllLanguages: true }));
    await subject.prepare({ eagerly: true });
    // Every CORE family: Turkish and Arabic are opt-in (C4) and load on their first press — a
    // second 800 MB copy of turbo resident for a language nobody may use is not a preload.
    for (const engine of engines) {
      const optional = engine.engineId.endsWith('-tr') || engine.engineId.endsWith('-ar');
      expect(await engine.isReady()).toBe(!optional);
    }
    await subject.dispose();
  });

  it('preloads the families concurrently, not one model read after the other', async () => {
    // Eager preload with both models present is ~1.4 GB off disk. Serially the user
    // waits for the sum; concurrently, for the slower of the two.
    await writeModel(UZBEK);
    await writeModel(TURBO);
    const order: string[] = [];
    const factory = fakeEngineFactory((engine) => {
      const inner = engine.prepare.bind(engine);
      engine.prepare = async () => {
        order.push(`enter:${engine.engineId}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await inner();
        order.push(`exit:${engine.engineId}`);
      };
    });
    const { manager: subject } = manager(settings({ preloadAllLanguages: true }), factory);
    await subject.prepare({ eagerly: true });

    // Both entered before either left. A sequential loop gives enter/exit/enter/exit.
    expect(order.slice(0, 2).every((event) => event.startsWith('enter:'))).toBe(true);
    expect(order.filter((event) => event.startsWith('exit:')).length).toBe(2);
    await subject.dispose();
  });

  it('preloads a family\'s own members concurrently too', async () => {
    await writeModel(TURBO);
    await writeModel(SMALL_EN);
    const order: string[] = [];
    const factory = fakeEngineFactory((engine) => {
      const inner = engine.prepare.bind(engine);
      engine.prepare = async () => {
        order.push(`enter:${engine.engineId}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await inner();
        order.push(`exit:${engine.engineId}`);
      };
    });
    const { manager: subject } = manager(settings({ fastEnglish: true }), factory);
    // One family, two members — small.en and turbo, both in `unified`.
    await subject.prepare({ eagerly: false, language: 'en' });
    expect(order.slice(0, 2).every((event) => event.startsWith('enter:'))).toBe(true);
    await subject.dispose();
  });

  it('does not refuse a press when a preload fails', async () => {
    await writeModel(UZBEK);
    const factory = fakeEngineFactory((engine) => {
      engine.failLoad = true;
    });
    const { manager: subject } = manager(settings(), factory);
    // A preload failure becomes a slow first dictation or a named blocker, never a
    // rejected promise the session has to catch.
    await expect(subject.prepare({ eagerly: true })).resolves.toBeUndefined();
    await subject.dispose();
  });
});

describe('reconfigure', () => {
  it('rebuilds when a model path changes', async () => {
    await writeModel(UZBEK);
    const { manager: subject } = manager(settings());
    await subject.prepare({ eagerly: true });
    expect(subject.engineFor('uzbek')?.engineId).toContain('uzbek-stt-v1');

    const elsewhere = await writeModel('ggml-uzbek-stt-v1-q5_0.bin', bundled);
    await subject.reconfigure(settings({ uzbekModelPath: elsewhere }));
    expect(subject.engineFor('uzbek')?.engineId).toContain('uzbek-stt-v1');
    await subject.dispose();
  });

  it('rebuilds when Fast English is switched on', async () => {
    await writeModel(TURBO);
    await writeModel(SMALL_EN);
    const { manager: subject } = manager(settings());
    await subject.prepare({ eagerly: true });
    expect(subject.engineFor('unified')?.engineId).not.toContain('small.en');

    await subject.reconfigure(settings({ fastEnglish: true }));
    expect(subject.engineFor('unified')?.engineId).toContain('small.en');
    await subject.dispose();
  });

  it('does not resolve while a build from the settings it replaced is still running', async () => {
    // The race: prepare() starts a build, reconfigure(B) installs B and JOINS that build
    // rather than starting its own, and the caller is handed back a manager built from
    // the settings it just replaced — with `await reconfigure(...)` as its evidence that
    // it is not. On the real path that is Fast English switched on in the settings pane
    // while the app is preloading, and the switch silently does nothing.
    await writeModel(TURBO);
    await writeModel(SMALL_EN);

    const store = createModelStore({ modelsDirectory: models, bundledDirectory: bundled });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const slowStore = {
      ...store,
      resolve: async (role: Parameters<typeof store.resolve>[0], current: Settings) => {
        if (first) {
          first = false;
          await held;
        }
        return store.resolve(role, current);
      },
    };

    const factory = fakeEngineFactory();
    const subject = createEngineManagerWith({
      settings: settings(),
      models: slowStore,
      createEngine: factory.createEngine,
      cpuCount: 4,
    });

    const preloading = subject.prepare({ eagerly: true });
    const reconfiguring = subject.reconfigure(settings({ fastEnglish: true }));
    release();

    await reconfiguring;
    expect(subject.engineFor('unified')?.engineId).toContain('small.en');

    await preloading;
    await subject.dispose();
  });

  it('does not rebuild when nothing that matters changed', async () => {
    await writeModel(UZBEK);
    const { manager: subject } = manager(settings());
    await subject.prepare({ eagerly: true });
    const before = subject.engineFor('uzbek');
    await subject.reconfigure(settings({ soundFeedback: true }));
    expect(subject.engineFor('uzbek')).toBe(before);
    await subject.dispose();
  });
});

describe('idle unload — a Windows ADDITION, not parity', () => {
  it('is OFF by default: macOS never unloads a model once loaded', async () => {
    await writeModel(UZBEK);
    const { manager: subject, engines } = manager(settings());
    await subject.prepare({ eagerly: true });
    expect(await engines[0]?.isReady()).toBe(true);
    // No timer, no sweep, nothing to wait for.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await engines[0]?.isReady()).toBe(true);
    await subject.dispose();
  });

  it('frees a model that has not been used, when it is switched on', async () => {
    await writeModel(UZBEK);
    let clock = 1_000_000;
    const { manager: subject, engines } = manager(settings(), fakeEngineFactory(), {
      idleUnload: { enabled: true, afterMs: 60_000 },
      now: () => clock,
    });
    await subject.prepare({ eagerly: true });
    expect(await engines[0]?.isReady()).toBe(true);

    clock += 61_000;
    // The sweep runs on a timer in production; driven directly here so the test does
    // not need a real minute.
    expect(await subject.sweepIdleNow()).toBe(1);
    expect(await engines[0]?.isReady()).toBe(false);
    await subject.dispose();
  });

  it('lets an unloaded model come back — it must be a slow press, not a dead one', async () => {
    // The trap: unloading by DISPOSING kills the host for good, so the press after the
    // timeout fails instead of being slow. That is the opposite of the trade.
    await writeModel(UZBEK);
    let clock = 1_000_000;
    const { manager: subject } = manager(settings(), fakeEngineFactory(), {
      idleUnload: { enabled: true, afterMs: 60_000 },
      now: () => clock,
    });
    await subject.prepare({ eagerly: true });
    clock += 61_000;
    await subject.sweepIdleNow();

    const result = await subject.engineFor('uzbek')?.transcribe(audio, 'uz');
    expect(result?.raw).toContain(':uz');
    await subject.dispose();
  });

  it('leaves an engine with no unload seam alone rather than disposing it', async () => {
    await writeModel(UZBEK);
    let clock = 1_000_000;
    // The fake engine has no `unload`, standing in for any engine that cannot free its
    // weights without dying.
    const { manager: subject, engines } = manager(settings(), fakeEngineFactory((engine) => {
      delete (engine as Partial<{ unload: unknown }>).unload;
    }), {
      idleUnload: { enabled: true, afterMs: 60_000 },
      now: () => clock,
    });
    await subject.prepare({ eagerly: true });
    clock += 61_000;
    expect(await subject.sweepIdleNow()).toBe(0);
    expect(await engines[0]?.isReady()).toBe(true);
    await subject.dispose();
  });

  it('keeps a model that is still in use', async () => {
    await writeModel(UZBEK);
    let clock = 1_000_000;
    const { manager: subject, engines } = manager(settings(), fakeEngineFactory(), {
      idleUnload: { enabled: true, afterMs: 60_000 },
      now: () => clock,
    });
    await subject.prepare({ eagerly: true });
    clock += 30_000;
    await subject.engineFor('uzbek')?.transcribe(audio, 'uz');
    clock += 40_000; // 40 s since the decode — under the 60 s policy
    expect(await subject.sweepIdleNow()).toBe(0);
    expect(await engines[0]?.isReady()).toBe(true);
    await subject.dispose();
  });
});

describe('dispose', () => {
  it('does not let a queued build resurrect the engines it just tore down', async () => {
    // Builds are serialised rather than deduplicated, so one can still be waiting when
    // dispose() runs. Building into a disposed manager leaves host processes nobody owns
    // and nobody will ever shut down.
    await writeModel(UZBEK);
    const { manager: subject } = manager(settings());
    const queued = subject.reconfigure(settings({ fastEnglish: true }));
    await subject.dispose();
    await queued;
    expect(subject.engineFor('uzbek')).toBeNull();
  });

  it('tears every engine down and leaves nothing behind', async () => {
    await writeModel(UZBEK);
    await writeModel(TURBO);
    const { manager: subject, engines } = manager(settings());
    await subject.prepare({ eagerly: true });
    await subject.dispose();
    for (const engine of engines) expect(await engine.isReady()).toBe(false);
    expect(subject.engineFor('uzbek')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// A `null` that does not say why is the whole bug
// ---------------------------------------------------------------------------------
//
// Run 32240326275: three models `ready` by name and byte size, every fixture failing
// with `noEngineInstalled` in 2 ms, and routing reporting `source: "fallback"` with
// `turkicMass: null`. Both were `null` returned by an UNBUILT manager, and both read at
// the call site as a fact about the user's machine rather than as a step that never ran.

describe('the two nulls that lied', () => {
  it('THE REGRESSION: engineFor before a build says the build has not happened', async () => {
    await writeModel(UZBEK);
    await writeModel(TURBO);
    const notes: string[] = [];
    const { manager: subject } = manager(settings(), fakeEngineFactory(), {
      onNote: (note: string) => notes.push(note),
    });

    // Exactly what `--check` did: construct, then ask on the next line.
    expect(subject.engineFor('unified')).toBeNull();
    expect(notes.join('\n')).toContain('before the engines were built');

    // And it is a TRIGGER, not a gate — preparing and re-asking works.
    await subject.prepare({ eagerly: true });
    expect(subject.engineFor('unified')).not.toBeNull();
    await subject.dispose();
  });

  it('a null detector names its own cause instead of degrading in silence', async () => {
    await writeModel(UZBEK);
    await writeModel(TURBO);
    await writeModel(BASE);
    const notes: string[] = [];
    // No `createClassifier` — precisely the wiring both `src/main/index.ts` and
    // `src/main/check.ts` shipped with, which sent every Uzbek clip to `unified`.
    const { manager: subject } = manager(settings(), fakeEngineFactory(), {
      onNote: (note: string) => notes.push(note),
    });
    await subject.prepare({ eagerly: true });

    expect(subject.detector()).toBeNull();
    expect(notes.join('\n')).toContain('no classifier factory was wired in');
    await subject.dispose();
  });

  it('distinguishes "detection is switched off" from "nothing was wired"', async () => {
    await writeModel(UZBEK);
    await writeModel(TURBO);
    await writeModel(BASE);
    const notes: string[] = [];
    const { manager: subject } = manager(settings({ enabledLanguages: ['en', 'ru'] }), fakeEngineFactory(), {
      onNote: (note: string) => notes.push(note),
      createClassifier: () => ({
        async classify() {
          return { turkicMass: 1, language: 'uz' as const };
        },
        async dispose() {
          /* nothing */
        },
      }),
    });
    await subject.prepare({ eagerly: true });

    expect(subject.detector()).toBeNull();
    expect(notes.join('\n')).toContain('nothing to detect');
    expect(notes.join('\n')).not.toContain('no classifier factory was wired in');
    await subject.dispose();
  });

  it('builds the detector when one IS wired, so routing can be acoustic', async () => {
    await writeModel(UZBEK);
    await writeModel(TURBO);
    await writeModel(BASE);
    const { manager: subject } = manager(settings(), fakeEngineFactory(), {
      createClassifier: () => ({
        async classify() {
          return { turkicMass: 1, language: 'uz' as const };
        },
        async dispose() {
          /* nothing */
        },
      }),
    });
    await subject.prepare({ eagerly: true });

    expect(subject.detector()).not.toBeNull();
    await subject.dispose();
  });
});
