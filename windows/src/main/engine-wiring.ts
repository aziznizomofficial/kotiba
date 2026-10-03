// How the engines get built. ONE copy, called by both composition roots.
//
// There were two: `src/main/index.ts` (the app) and `src/main/check.ts` (`--check`). They
// were written to agree and had already drifted — `--check` grew the comment explaining
// why `createClassifier` is not optional some days after the app had gone without it —
// and the whole point of `--check` is that it exercises what the app runs. Two copies of
// the wiring means `--check` can pass on a pipeline the app never builds.
//
// ---------------------------------------------------------------------------------
// WHAT A MODEL'S LANGUAGES ARE DERIVED FROM
// ---------------------------------------------------------------------------------
//
// Both roots used to answer it like this:
//
//     supportedLanguagesFor: (engineId) =>
//       engineId.includes('uzbek') || engineId.includes('navoi') ? ['uz'] : ['en', 'ru']
//
// A substring match on a FILE NAME, deciding a value the family engine branches on
// (`manager.ts:199` skips any member whose `supportedLanguages` lacks the language being
// asked for, and `manager.ts:154` builds the readiness `availableLanguages` out of the
// same sets). A user who picks their own Uzbek `.bin` with any other name gets an engine
// that claims English and Russian, is skipped for every Uzbek dictation, and reports
// Uzbek as unavailable — with a model file sitting right there, valid and loaded.
//
// The languages belong to the ROLE, not to the name of the file filling it. The manager
// already knows the role — it calls `models.resolve(role, settings)` for all four, in
// `build()`, immediately before it constructs each engine. So the store it is handed is
// wrapped: every resolution records `role` against the engine id the manager will derive
// from that path, and `supportedLanguagesFor` reads the recording.
//
// That is an exact join through the manager's own resolution, one line before the engine
// exists, so it cannot go stale across a `reconfigure` — a table refreshed on a settings
// change could, and would be wrong exactly when a user has just changed a model path.

import { availableParallelism } from 'node:os';

import type {
  EngineManager,
  Language,
  ModelId,
  ModelRole,
  ModelStore,
  Settings,
} from '../contracts/index.js';
import { KNOWN_MODEL_FILES } from '../contracts/index.js';

/**
 * The engine id the manager derives from a model path, character for character
 * (`manager.ts`: `whisper-${basename without .bin}`).
 *
 * Duplicated deliberately and asserted in `test/main/engine-wiring.test.ts`: it is the
 * key of the join below, and a silent divergence would send every engine down the
 * unknown-role path.
 */
export function engineIdForModelPath(modelPath: string): string {
  return `whisper-${modelPath.replace(/^.*[\\/]/, '').replace(/\.bin$/, '')}`;
}

/**
 * Which languages a role's engine will accept.
 *
 * The same table as `manager.ts`'s private `languagesForRole`, which is not exported.
 * Five lines duplicated is the right trade against a filename heuristic; if the manager
 * ever passes the role into `CreateSttEngine`, both this and the join above go away.
 *
 * `detector` is empty on purpose: it is never asked to transcribe.
 */
export function languagesForRole(role: ModelRole): readonly Language[] {
  switch (role) {
    case 'uzbek':
      return ['uz'];
    case 'fastEnglish':
      return ['en'];
    case 'russian':
      return ['en', 'ru'];
    case 'detector':
      return [];
  }
}

/** Which slot a catalogue model fills. Direct, not derived from the file name. */
export const ROLE_FOR_MODEL: Readonly<Record<ModelId, ModelRole>> = {
  uzbek_stt_v1: 'uzbek',
  large_v3_turbo: 'russian',
  base_detector: 'detector',
  small_en: 'fastEnglish',
};

/**
 * The shipped file names, by role, as a fallback for the join.
 *
 * This is `KNOWN_MODEL_FILES` inverted — an exact, whole-name identity map maintained in
 * `src/contracts`, not a substring test. It only ever answers for an engine the manager
 * built without resolving (which nothing does today); it exists so the unknown case
 * below is genuinely unreachable for every model this app ships or downloads.
 */
const ROLE_FOR_ENGINE_ID: ReadonlyMap<string, ModelRole> = new Map(
  Object.entries(KNOWN_MODEL_FILES).flatMap(([role, fileNames]) =>
    fileNames.map((fileName) => [engineIdForModelPath(fileName), role as ModelRole] as const),
  ),
);

/**
 * Logical processors, for `EngineManagerDeps.cpuCount`.
 *
 * NEITHER ROOT SUPPLIED IT, so `deps.cpuCount ?? 4` stood on every machine: four logical
 * processors through `resolveThreadCount` is two decode threads, on a laptop and on a
 * sixteen-core desktop alike, and one thread in the acoustic detector. That is the
 * single largest free latency win in the app and it was being declined by omission.
 *
 * `availableParallelism()` and not `cpus().length`: it honours a cgroup or affinity mask,
 * which is what a CI runner and a machine with Kotiba pinned to a core set actually give.
 *
 * The value handed over is the LOGICAL count, which is what `EngineManagerDeps.cpuCount`
 * documents itself as ("Logical processors. See `resolveDecodeCores` for why this is not
 * fed raw"). Halving it for SMT and E-cores is `resolveDecodeCores`, and it belongs to
 * `src/engines` on the far side of that field — doing it here as well would halve twice
 * and land back on one thread.
 */
export function logicalProcessorCount(): number {
  const count = availableParallelism();
  return Number.isFinite(count) && count > 0 ? count : 4;
}

/**
 * A `ModelStore` that remembers which role each resolved path was resolved FOR.
 *
 * Everything else passes straight through. `notes` is a getter rather than a copy: the
 * store appends to it as it resolves, and a snapshot taken at wrap time would be empty
 * forever.
 */
export function recordingModelStore(
  models: ModelStore,
  roles: Map<string, ModelRole>,
  onNote: (note: string) => void = () => {},
): ModelStore {
  return {
    inspect: (path) => models.inspect(path),
    async resolve(role, settings) {
      const path = await models.resolve(role, settings);
      if (path === null) return null;
      const engineId = engineIdForModelPath(path);
      const claimed = roles.get(engineId);
      // FIRST CLAIM WINS, and a second one is said out loud. The key is a BASENAME, so a
      // user who points `russianModelPath` at a copy of the Uzbek model on another drive
      // produces one engine id for two roles. Letting the later role overwrite would give
      // the Uzbek family a member claiming `['en','ru']`, which `manager.ts:199` then
      // skips for every `uz` — the exact failure the filename heuristic caused, arriving
      // through a different door. `resolvePaths` runs uzbek first, so first-wins keeps
      // the more specific role.
      if (claimed !== undefined && claimed !== role) {
        onNote(
          `engines: ${path.replace(/^.*[\\/]/, '')} is configured for both ${claimed} and ${role} — ` +
            `treating it as the ${claimed} model`,
        );
        return path;
      }
      roles.set(engineId, role);
      return path;
    },
    ensure: (id, onProgress) => models.ensure(id, onProgress),
    status: (id) => models.status(id),
    get notes(): readonly string[] {
      return models.notes;
    },
  };
}

export interface EngineWiringOptions {
  readonly settings: Settings;
  readonly models: ModelStore;
  /** `kotiba-stt.exe`. Already searched for by `paths.ts`, which says where it looked. */
  readonly hostPath: string;
  /** Prose for the log and the diagnostics pane. Never branched on. */
  readonly onNote: (note: string) => void;
  /** Injected by the tests. Production reads the machine. */
  readonly cpuCount?: number;
  /**
   * Parakeet Ultra, heading the unified family. Built by `compose.ts` — the app and
   * `--check` both pass whatever it built, so the two roots cannot disagree about which
   * engine serves English and Russian.
   */
  readonly unifiedLead?: import('../engines/index.js').UnifiedLead;
  /** Cohere / FastConformer, heading the Arabic family (C4). Built by `compose.ts`. */
  readonly arabicLead?: import('../engines/manager.js').EngineManagerDeps['arabicLead'];
  /**
   * `ggml-silero-v6.2.0.bin`, when installed — and the switch for the streaming Uzbek engine
   * (C2): with it given, the Uzbek role's engine is built with flash attention off and
   * wrapped to stream; without it, Uzbek is batch exactly as before. A stream still runs on
   * the energy gate while the file is absent.
   */
  readonly speechDetectorPath?: () => Promise<string | null>;
  /**
   * Where the language-ID model is looked for (P4): the bundle store the installer's copy and a
   * download live in, read through `resolveLanguageIDPath` with the setting. Given, and the module
   * has `createLanguageIdentifier`, the manager loads the model and the controller routes through
   * the language decision; absent, whisper base routes as before.
   */
  readonly bundles?: import('../engines/index.js').BundleStore;
  /** Runs the language-ID model in its own process (D-W22). Absent: in this one. */
  readonly engineLauncher?: import('../engines/index.js').EngineLauncher;
}

/**
 * The engines module, as both roots reach it (`await import('../engines/index.js')`).
 *
 * A `typeof import` rather than a hand-written interface: the point of this file is that
 * the two roots cannot disagree about the wiring, and a hand-copied shape is one more
 * thing to drift from the module it describes. The import is type-only and erased, so
 * `--check` still loads `src/engines` dynamically and nothing else does.
 */
export type EnginesModule = Pick<
  typeof import('../engines/index.js'),
  'createEngineManagerWith' | 'bindSttEngineFactory' | 'createAcousticClassifier'
> &
  Partial<
    Pick<typeof import('../engines/index.js'), 'createStreamingWhisperEngine' | 'createLanguageIdentifier' | 'resolveLanguageIDPath'>
  >;

/**
 * Build the engine manager. The app and `--check` both call exactly this.
 *
 * `createClassifier` IS NOT OPTIONAL IN A SHIPPED APP, whatever the type says. It was
 * absent from `src/main/index.ts` once: `manager.detector()` returned `null`, the tiered
 * router fell through to `settings.defaultLanguage`, and it reported that as
 * `source: 'fallback'` with `turkicMass: null` — a routing RESULT rather than a component
 * that was never built. Every Uzbek dictation went to the unified engine and nothing in
 * the app said so. That failure is the one this app exists to prevent, which is why the
 * wiring is a function both roots call instead of a paragraph both roots copy.
 */
export function createEngines(engines: EnginesModule, options: EngineWiringOptions): EngineManager {
  /** engine id → the role the manager resolved its path for. Filled during `build()`. */
  const roles = new Map<string, ModelRole>();

  const supportedLanguagesFor = (engineId: string): Iterable<Language> => {
    const role = roles.get(engineId) ?? ROLE_FOR_ENGINE_ID.get(engineId);
    if (role !== undefined) return languagesForRole(role);
    // Unreachable for anything the manager built, since it resolves a path for every
    // engine it constructs. Said out loud rather than guessed at: a wrong set here makes
    // a perfectly good model invisible to the family that needs it, and silence is how
    // that reads as "the model is not installed".
    options.onNote(
      `engines: ${engineId} was built for no known role — treating it as the unified engine`,
    );
    return languagesForRole('russian');
  };

  const whisper = engines.bindSttEngineFactory({
    hostPath: options.hostPath,
    useGpu: options.settings.whisperUseGPU,
    supportedLanguagesFor,
  });
  const streamUzbek = engines.createStreamingWhisperEngine;
  const speechDetectorPath = options.speechDetectorPath;
  const createEngine: typeof whisper = (engineOptions) => {
    const languages = [...(engineOptions.supportedLanguages ?? supportedLanguagesFor(engineOptions.engineId))];
    // Uzbek (C2) and Turkish (C4 §8: "exactly the shipped StreamingWhisperSession") stream.
    // Arabic's whisper member does not: it is the fallback behind Cohere, batch by design.
    const only = languages.length === 1 ? languages[0] : undefined;
    const streamed = only === 'uz' || only === 'tr' ? only : null;
    if (streamed === null || streamUzbek === undefined || speechDetectorPath === undefined) return whisper(engineOptions);
    // C2's recipe: flash attention OFF (it mixes encoder windows), and the session wrapper in
    // the family slot — batch calls pass straight through.
    const engine = whisper({ ...engineOptions, flashAttention: false }) as import('../engines/index.js').SegmentDecodingEngine;
    return streamUzbek({
      engine,
      language: streamed,
      speechDetectorPath,
      hint: () => engineOptions.initialPromptFor?.(streamed) ?? null,
    });
  };

  return engines.createEngineManagerWith({
    settings: options.settings,
    models: recordingModelStore(options.models, roles, options.onNote),
    createEngine,
    createClassifier: ({ modelPath }) =>
      engines.createAcousticClassifier({
        modelPath,
        hostPath: options.hostPath,
        onNote: (note) => {
          options.onNote(`classifier: ${note}`);
        },
      }),
    ...(options.bundles === undefined || engines.createLanguageIdentifier === undefined || engines.resolveLanguageIDPath === undefined
      ? {}
      : {
          languageIDPath: (current: Settings) => engines.resolveLanguageIDPath!(current, options.bundles ?? null),
          createLanguageIdentifier: ({ modelPath }: { readonly modelPath: string }) =>
            engines.createLanguageIdentifier!({
              modelPath,
              ...(options.engineLauncher === undefined ? {} : { launcher: options.engineLauncher }),
              onNote: (note) => {
                options.onNote(`classifier: ${note}`);
              },
            }),
        }),
    cpuCount: options.cpuCount ?? logicalProcessorCount(),
    onNote: (note) => {
      options.onNote(`engines: ${note}`);
    },
    ...(options.unifiedLead === undefined ? {} : { unifiedLead: options.unifiedLead }),
    ...(options.arabicLead === undefined ? {} : { arabicLead: options.arabicLead }),
  });
}
