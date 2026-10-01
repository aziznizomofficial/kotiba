// The wiring both composition roots share, and the two things it decides.
//
// WHAT WENT WRONG, twice over, once in each root:
//
//   1. `supportedLanguagesFor: (engineId) => engineId.includes('uzbek') ||
//      engineId.includes('navoi') ? ['uz'] : ['en','ru']` — a model's languages read out
//      of its FILE NAME. `manager.ts:199` skips any family member whose
//      `supportedLanguages` lacks the language being asked for, and `manager.ts:154`
//      builds the readiness list out of the same sets, so a user who chose their own
//      Uzbek `.bin` under any other name got an engine that claimed English and Russian,
//      was skipped for every Uzbek dictation, and reported Uzbek unavailable — with a
//      valid model file sitting right there.
//   2. Neither root passed `cpuCount`, so `deps.cpuCount ?? 4` stood on every machine:
//      four through `resolveThreadCount` is two decode threads, on a laptop and on a
//      sixteen-core desktop alike.
//
// Both are asserted here against a fake engines module, because what is being tested is
// what the ROOT hands the manager — not what the manager then does with it.

import { describe, expect, it } from 'vitest';

import type { Language, ModelRole, ModelStore, Settings } from '../../src/contracts/index.js';
import { DEFAULT_SETTINGS, KNOWN_MODEL_FILES } from '../../src/contracts/index.js';
import {
  createEngines,
  engineIdForModelPath,
  languagesForRole,
  logicalProcessorCount,
  recordingModelStore,
  ROLE_FOR_MODEL,
  type EnginesModule,
} from '../../src/main/engine-wiring.js';

/** A model store that resolves each role to a path the caller chose. */
function storeResolving(byRole: Partial<Record<ModelRole, string>>): ModelStore {
  return {
    inspect: async (path) => ({ status: 'ready', path, bytes: 1, reason: null }),
    resolve: async (role) => byRole[role] ?? null,
    ensure: async () => '',
    status: async () => 'ready',
    notes: [],
  };
}

/**
 * Just enough of `src/engines` to capture what the root passed.
 *
 * `createEngineManagerWith` is driven by hand rather than really run: the manager's own
 * `build()` is `test/engines/manager.test.ts`'s subject, and what matters here is the
 * `deps` object that reaches it.
 */
function recordingEngines(): {
  readonly module: EnginesModule;
  readonly captured: {
    cpuCount?: number | undefined;
    hasClassifier?: boolean;
    models?: ModelStore;
    languagesFor?: (engineId: string) => Iterable<Language>;
  };
} {
  const captured: {
    cpuCount?: number | undefined;
    hasClassifier?: boolean;
    models?: ModelStore;
    languagesFor?: (engineId: string) => Iterable<Language>;
  } = {};
  const module = {
    bindSttEngineFactory: (deps: { supportedLanguagesFor: (id: string) => Iterable<Language> }) => {
      captured.languagesFor = deps.supportedLanguagesFor;
      return () => ({}) as never;
    },
    createAcousticClassifier: () => ({}) as never,
    createEngineManagerWith: (deps: {
      cpuCount?: number;
      createClassifier?: unknown;
      models: ModelStore;
    }) => {
      captured.cpuCount = deps.cpuCount;
      captured.hasClassifier = deps.createClassifier !== undefined;
      captured.models = deps.models;
      return {} as never;
    },
  } as unknown as EnginesModule;
  return { module, captured };
}

const settings: Settings = DEFAULT_SETTINGS;

describe('the engine id join', () => {
  it('derives the same id the manager does', () => {
    // `manager.ts`: `whisper-${modelPath.replace(/^.*[\\/]/, '').replace(/\.bin$/, '')}`.
    // If this ever diverges, every engine takes the unknown-role path and the join is
    // silently dead, so it is asserted character for character.
    expect(engineIdForModelPath('C:\\Users\\a\\ggml-uzbek-stt-v1-q5_0.bin')).toBe(
      'whisper-ggml-uzbek-stt-v1-q5_0',
    );
    expect(engineIdForModelPath('/home/a/models/ggml-large-v3-turbo-q5_0.bin')).toBe(
      'whisper-ggml-large-v3-turbo-q5_0',
    );
  });

  it('maps a role to the languages that role can produce', () => {
    expect(languagesForRole('uzbek')).toEqual(['uz']);
    expect(languagesForRole('russian')).toEqual(['en', 'ru']);
    expect(languagesForRole('fastEnglish')).toEqual(['en']);
    // The detector never transcribes.
    expect(languagesForRole('detector')).toEqual([]);
  });

  it('names which slot each catalogue model fills, without reading a file name', () => {
    expect(ROLE_FOR_MODEL.uzbek_stt_v1).toBe('uzbek');
    expect(ROLE_FOR_MODEL.large_v3_turbo).toBe('russian');
    expect(ROLE_FOR_MODEL.base_detector).toBe('detector');
    expect(ROLE_FOR_MODEL.small_en).toBe('fastEnglish');
  });
});

describe('the recording model store', () => {
  it('remembers which role each path was resolved for, and passes everything else through', async () => {
    const roles = new Map<string, ModelRole>();
    const wrapped = recordingModelStore(storeResolving({ uzbek: '/m/anything.bin' }), roles);

    expect(await wrapped.resolve('uzbek', settings)).toBe('/m/anything.bin');
    expect(roles.get('whisper-anything')).toBe('uzbek');
    // A role with no usable file records nothing — there is no engine to key.
    expect(await wrapped.resolve('russian', settings)).toBeNull();
    expect(roles.size).toBe(1);
  });
});

describe('the recording model store, when one file fills two roles', () => {
  it('keeps the first claim and says the second one out loud', async () => {
    // A user who points `russianModelPath` at a copy of the Uzbek model on another drive
    // produces ONE engine id for two roles. If the later role overwrote, the uzbek family
    // would get a member claiming ['en','ru'], `manager.ts:199` would skip it for every
    // 'uz', and the user would be told Uzbek is unavailable with the model right there —
    // the filename heuristic's failure, back through a different door.
    const roles = new Map<string, ModelRole>();
    const notes: string[] = [];
    const wrapped = recordingModelStore(
      storeResolving({ uzbek: '/a/ggml-uzbek-stt-v1-q5_0.bin', russian: '/b/ggml-uzbek-stt-v1-q5_0.bin' }),
      roles,
      (note) => notes.push(note),
    );

    // `resolvePaths` runs uzbek first, so first-wins keeps the more specific role.
    await wrapped.resolve('uzbek', settings);
    await wrapped.resolve('russian', settings);

    expect(roles.get('whisper-ggml-uzbek-stt-v1-q5_0')).toBe('uzbek');
    expect(notes.join('\n')).toContain('both uzbek and russian');
  });
});

describe('what the root hands the engine manager', () => {
  it('reads a model’s languages from its ROLE, whatever the file is called', async () => {
    // THE REGRESSION TEST. `my-model.bin` contains neither 'uzbek' nor 'navoi', so the old
    // heuristic answered ['en','ru'] — and the Uzbek family engine then skipped the only
    // member it had.
    const { module, captured } = recordingEngines();
    createEngines(module, {
      settings,
      models: storeResolving({ uzbek: '/m/my-model.bin', russian: '/m/whatever.bin' }),
      hostPath: 'kotiba-stt.exe',
      onNote: () => {},
    });

    // The manager resolves every role in `build()`, one line before it constructs each
    // engine. That is what fills the join.
    const store = captured.models;
    expect(store).toBeDefined();
    await store?.resolve('uzbek', settings);
    await store?.resolve('russian', settings);

    expect([...(captured.languagesFor?.('whisper-my-model') ?? [])]).toEqual(['uz']);
    expect([...(captured.languagesFor?.('whisper-whatever') ?? [])]).toEqual(['en', 'ru']);
  });

  it('still knows a shipped model before anything has been resolved', () => {
    // The static half of the join: `KNOWN_MODEL_FILES` inverted, which is an exact
    // whole-name identity map from `src/contracts` rather than a substring test.
    const { module, captured } = recordingEngines();
    createEngines(module, {
      settings,
      models: storeResolving({}),
      hostPath: 'kotiba-stt.exe',
      onNote: () => {},
    });

    const uzbekId = engineIdForModelPath(KNOWN_MODEL_FILES.uzbek[0]);
    const russianId = engineIdForModelPath(KNOWN_MODEL_FILES.russian[0]);
    expect([...(captured.languagesFor?.(uzbekId) ?? [])]).toEqual(['uz']);
    expect([...(captured.languagesFor?.(russianId) ?? [])]).toEqual(['en', 'ru']);
  });

  it('says so out loud when it cannot place an engine, instead of guessing quietly', () => {
    const notes: string[] = [];
    const { module, captured } = recordingEngines();
    createEngines(module, {
      settings,
      models: storeResolving({}),
      hostPath: 'kotiba-stt.exe',
      onNote: (note) => notes.push(note),
    });

    captured.languagesFor?.('whisper-something-nobody-resolved');
    // A wrong set makes a perfectly good model invisible to the family that needs it,
    // and silence is how that reads to a user as "the model is not installed".
    expect(notes.join('\n')).toContain('whisper-something-nobody-resolved');
    expect(notes.join('\n')).toContain('no known role');
  });

  it('passes the machine’s processor count instead of leaving the ?? 4 default', () => {
    const { module, captured } = recordingEngines();
    createEngines(module, {
      settings,
      models: storeResolving({}),
      hostPath: 'kotiba-stt.exe',
      onNote: () => {},
    });

    // NOT undefined, which is what both roots passed and what left every machine on two
    // decode threads and the detector on one.
    expect(captured.cpuCount).toBeDefined();
    expect(captured.cpuCount).toBe(logicalProcessorCount());
    expect(logicalProcessorCount()).toBeGreaterThan(0);
  });

  it('always builds the detector, which is not optional in a shipped app', () => {
    // Omitting `createClassifier` makes `detector()` return null, the tiered router falls
    // through to `settings.defaultLanguage`, and it reports that as `source: 'fallback'`
    // with `turkicMass: null` — a routing RESULT rather than a component that was never
    // built. Every Uzbek dictation went to the unified engine and nothing said so.
    const { module, captured } = recordingEngines();
    createEngines(module, {
      settings,
      models: storeResolving({}),
      hostPath: 'kotiba-stt.exe',
      onNote: () => {},
    });

    expect(captured.hasClassifier).toBe(true);
  });
});
