// The pipeline, built. Everything `src/main/index.ts` used to do inline between opening
// the settings file and handing a `DictationController` to the tray.
//
// IT IS A SEPARATE FILE SO IT CAN BE TESTED. The old version lived inside `start()`,
// which needs `app.whenReady()`, four `BrowserWindow`s and a `Tray` before it reaches the
// first factory — so nothing tested it, and `src/platform/index.ts` shipped as seven
// `notImplemented` stubs behind a green gate. Every one of those became a tidy blocker
// row via `attempt`, `ready` came out false, no controller was built, and the packaged
// app showed the user seven problems and could never dictate.
//
// `test/main/compose.test.ts` builds this against the REAL `src/platform`, the REAL
// `src/engines` and the REAL `src/audio`, faking only the three native helper processes
// and the capture window, and asserts `ready === true` with an empty blocker list. That
// test fails on a stubbed platform, which is the only property that matters here.
//
// THE STRUCTURAL RULE, unchanged: a module that is missing or that refuses to start
// becomes a BLOCKER, never a crash. This is a tray app — there is no window to show a
// stack trace in, and a program that vanishes on launch gives its user nothing to act on.

import type {
  AudioCapture,
  Blocker,
  DiagnosticsSink,
  EngineManager,
  FocusSource,
  HistoryStore,
  HotkeySource,
  Inserter,
  ModelStore,
  SecretStore,
  Settings,
  SettingsStore,
} from '../contracts/index.js';
import { CREDENTIAL_SERVICE, DEFAULT_SETTINGS } from '../contracts/index.js';
import { t } from '../core/i18n/index.js';
import type { AudioHost } from '../audio/index.js';
import type { Ducker } from '../platform/index.js';

import { join } from 'node:path';

import { GEMMA4_E2B_AR, QWEN3_1_7B, SILERO_VAD } from '../contracts/index.js';

import type { EnginesModule } from './engine-wiring.js';
import { createEngines, logicalProcessorCount } from './engine-wiring.js';

/**
 * Build something, or record why it could not be built.
 *
 * Nine modules land at different times and three of them are child processes that can
 * refuse to spawn on a machine nobody here can log into. `attempt` is what turns each of
 * those into a row the user can read, instead of an app that does not open.
 *
 * ITS ONE BLIND SPOT, and it cost the port a release: a whole MODULE that is still a stub
 * fails here seven times over and reads as seven unrelated machine problems. Nothing but
 * a test that builds the real thing can tell those two apart, which is why one exists.
 */
export function attempt<T>(
  blocker: Blocker,
  build: () => T,
  record: (blocker: Blocker) => void,
): T | null {
  try {
    return build();
  } catch (error: unknown) {
    const why = error instanceof Error ? error.message : String(error);
    record({ ...blocker, detail: blocker.detail === null ? why : `${blocker.detail} — ${why}` });
    return null;
  }
}

/** What `ducker` is when its helper could not even be constructed. Does nothing, ever. */
const INERT_DUCKER_FALLBACK: Ducker = {
  duck: () => undefined,
  restore: () => undefined,
  restoreImmediately: async () => undefined,
  recoverFromCrash: async () => undefined,
  settle: async () => undefined,
  decision: 'inert',
};

/** Every path the pipeline needs, already searched for. See `./paths.ts`. */
export interface CompositionPaths {
  /** `%APPDATA%\Kotiba`. The settings blob lives here. */
  readonly supportDirectory: string;
  readonly historyPath: string;
  readonly diagnosticsPath: string;
  readonly modelsDirectory: string;
  readonly bundledDirectory: string;
  readonly sttHelperPath: string;
  readonly hookHelperPath: string;
  readonly inputHelperPath: string;
}

/** The platform module, by the names the barrel exports. */
export type PlatformModule = Pick<
  typeof import('../platform/index.js'),
  | 'createSettingsStore'
  | 'createSecretStore'
  | 'createHistoryStore'
  | 'createDiagnosticsSink'
  | 'createInputHelper'
  | 'createWindowsHotkeySource'
  | 'createWindowsInserter'
  | 'createWindowsFocusSource'
  | 'createDucker'
  | 'helperDuckingBackend'
  | 'fileMarkerStore'
>;

export type ModelStoreModule = Pick<typeof import('../engines/index.js'), 'createModelStore'>;

/**
 * The on-device engines that are fetched on first use: Parakeet Ultra (English + Russian,
 * the unified family's lead) and Qwen3-1.7B (the modes). OPTIONAL IN THE TYPE so a test that
 * is about something else need not build them — and REQUIRED IN BOTH ROOTS, which pass it:
 * `test/main/compose.test.ts` builds with the real modules and asserts Parakeet heads the
 * unified family, because "built, tested, wired into nothing" is this repo's #1 defect.
 */
export type OnDeviceModule = Pick<
  typeof import('../engines/index.js'),
  'ParakeetEngine' | 'createBundleStore' | 'resolveOrtThreads'
> &
  Partial<Pick<typeof import('../engines/index.js'), 'ArabicEngine'>> &
  Pick<typeof import('../polish/index.js'), 'LlamaPolisher' | 'resolveLlamaThreads'> &
  Partial<Pick<typeof import('../polish/index.js'), 'RemoteLlamaPolisher'>>;

/** What was built of the on-device engines. */
export interface OnDeviceEngines {
  readonly bundles: import('../engines/index.js').BundleStore;
  readonly parakeet: import('../engines/index.js').ParakeetEngine | null;
  /** C4: Arabic's engine (Cohere / FastConformer), heading the Arabic family. */
  readonly arabic: import('../engines/index.js').ArabicEngine | null;
  /** In its own process (`RemoteLlamaPolisher`) in the app; in this one for `--check` and tests. */
  readonly llama: import('../polish/index.js').ModesModel;
  /** Arabic's own modes model (Gemma 4 E2B, C4 §14.5) — claims Arabic only; loads on first use. */
  readonly arabicModes: import('../polish/index.js').ModesModel;
}
export type AudioModule = Pick<typeof import('../audio/index.js'), 'createAudioCapture'>;

export interface CompositionDeps {
  readonly platform: PlatformModule;
  readonly engines: EnginesModule & ModelStoreModule;
  readonly audio: AudioModule;
  readonly paths: CompositionPaths;
  readonly appVersion: string;
  /**
   * The hidden capture window, as an `AudioHost` (D-W6). Built by the caller because only
   * `src/main` may own a `BrowserWindow`, and taken as a thunk because it must not be
   * created at all if the composition never gets that far.
   */
  readonly createAudioHost: () => AudioHost;
  /** Prose for the log. Never branched on. */
  readonly onNote: (note: string) => void;
  readonly record: (blocker: Blocker) => void;
  /** One take's ceiling. 30 minutes unless a test says otherwise. */
  readonly ceilingSeconds?: number;
  /** Injected by the tests; production reads the machine. See `logicalProcessorCount`. */
  readonly cpuCount?: number;
  /** Kotiba's own process ids — never ducked. Main passes `app.getAppMetrics()`. */
  readonly ownPids?: () => ReadonlySet<number>;
  /** Where the "ducked from X" marker lives. Beside the history. */
  readonly duckingMarkerPath?: string;
  /** Parakeet and Qwen. See `OnDeviceModule`. */
  readonly onDevice?: OnDeviceModule;
  /**
   * Whether Parakeet may start its own download when a dictation wants it. Asked each time:
   * the app answers "only once the user accepted it" (onboarding's Download models step or a
   * Download button); `--check` answers no. Default on, for tests that build the pipeline.
   */
  readonly autoDownload?: boolean | (() => boolean);
  /**
   * Runs Parakeet and Qwen each in its own OS process (D-W22). The app passes Electron's
   * `utilityProcess` launcher; absent, they run in this process as before.
   */
  readonly engineLauncher?: import('../engines/index.js').EngineLauncher;
  /** Told when a bundle's state changes, so the window can say "downloading 40 %". */
  readonly onBundleState?: (id: import('../contracts/index.js').BundleId, state: import('../contracts/index.js').BundleState) => void;
  /**
   * C4's Arabic engine, what the app knows that the engine cannot: whether it may fetch (Arabic
   * on AND accepted), the user's engine choice and GPU setting (read live), where the speed
   * check's verdict and standard clip live, and who is told when the active engine changes.
   * Absent: every default (tests, `--check` — which never fetches).
   */
  readonly arabic?: Partial<
    Pick<
      import('../engines/index.js').ArabicEngineOptions,
      'autoDownload' | 'choice' | 'backend' | 'speedChecks' | 'speedClip' | 'onStatus'
    >
  >;
}

/**
 * Every seam, all of them built. Exactly the shape `CreateDictationController` takes, so
 * the caller spreads it rather than re-listing nine names — a list that had already
 * drifted once between the readiness check and the constructor.
 *
 * Its existence IS the readiness answer: `complete === null` means something failed, and
 * there is no way to hold this object and be missing a dependency.
 */
export interface ReadyPipeline {
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  readonly engines: EngineManager;
  readonly audio: AudioCapture;
  readonly inserter: Inserter;
  readonly hotkey: HotkeySource;
  readonly focus: FocusSource;
  readonly history: HistoryStore;
  readonly diagnostics: DiagnosticsSink;
  readonly models: ModelStore;
}

export interface Composition {
  /**
   * Lowers other apps while the key is held. Always present: a helper that will not start
   * costs the duck, never the dictation, so a failure here is a note and not a blocker.
   */
  readonly ducker: Ducker;
  readonly settingsStore: SettingsStore | null;
  /** The loaded snapshot, or the defaults when the store could not be opened. */
  readonly settings: Settings;
  readonly secrets: SecretStore | null;
  readonly history: HistoryStore | null;
  readonly diagnostics: DiagnosticsSink | null;
  readonly models: ModelStore;
  readonly audio: AudioCapture | null;
  readonly hotkey: HotkeySource | null;
  readonly inserter: Inserter | null;
  readonly focus: FocusSource | null;
  readonly engines: EngineManager | null;
  /** Parakeet and Qwen, when `deps.onDevice` was given. */
  readonly onDevice: OnDeviceEngines | null;
  /** Non-null iff every seam was built. A controller is constructed from this or not at all. */
  readonly complete: ReadyPipeline | null;
  /** `complete !== null`, named for the readers who ask the question that way. */
  readonly ready: boolean;
  /** Tears down what this module owns and the controller does not. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Build the whole pipeline, recording a blocker for anything that will not start.
 *
 * The order matters in one place only: the settings file is opened and LOADED first,
 * because the hotkey binding and every engine parameter come out of it. Everything after
 * that is independent, and each failure costs only itself.
 */
export async function composePipeline(deps: CompositionDeps): Promise<Composition> {
  const { platform, paths, record } = deps;

  // ---- storage ---------------------------------------------------------------------
  const settingsStore = attempt<SettingsStore>(
    { id: 'settings', headline: t('blk.settings_could_not_be_opened'), detail: null },
    () => platform.createSettingsStore({ directory: paths.supportDirectory }),
    record,
  );

  let settings: Settings = DEFAULT_SETTINGS;
  if (settingsStore !== null) {
    const load = await settingsStore.load();
    settings = load.settings;
    if (load.failure !== null) {
      // A SALVAGE IS NOT A FAILURE TO OPEN. One unreadable key costs itself; the other
      // thirty-one are in hand, the raw bytes are beside the file, and the app runs.
      record({
        id: 'settings',
        headline: t('blk.some_settings_could_not_be_read'),
        detail: t('blk.settingsKept', { why: load.failure }),
      });
    }
  }

  const history = attempt<HistoryStore>(
    {
      id: 'history-store',
      headline: t('blk.history_could_not_be_opened'),
      detail: t('blk.nothing_you_dictate_is_being_saved'),
    },
    () => platform.createHistoryStore({ path: paths.historyPath }),
    record,
  );
  const diagnostics = attempt<DiagnosticsSink>(
    {
      id: 'diagnostics-store',
      headline: t('blk.diagnostics_could_not_be_recorded'),
      detail: t('blk.kotiba_cannot_tell_you_why_a'),
    },
    () =>
      platform.createDiagnosticsSink({
        path: paths.diagnosticsPath,
        appVersion: deps.appVersion,
      }),
    record,
  );
  const secrets = attempt<SecretStore>(
    {
      id: 'settings',
      headline: t('blk.the_credential_store_could_not_be'),
      detail: t('blk.your_polish_api_key_cannot_be'),
    },
    () => platform.createSecretStore({ service: CREDENTIAL_SERVICE }),
    record,
  );

  const models = deps.engines.createModelStore({
    modelsDirectory: paths.modelsDirectory,
    bundledDirectory: paths.bundledDirectory,
  });

  // ---- the microphone ---------------------------------------------------------------
  //
  // `createAudioCapture` REQUIRES a host and throws without one — `capture.ts` says so in
  // the exception's own sentence. It was called with `{ bufferSeconds: 120 }` and nothing
  // else, so it threw on every launch, `audio` was null, and 'The microphone is not
  // ready' was recorded before a single device had been looked at.
  //
  // The host is built OUTSIDE the `attempt` and kept, because it registers two `ipcMain`
  // listeners: created inside, a `createAudioCapture` that threw would leave them behind
  // with nothing attached to them.
  let audioHost: AudioHost | null = null;
  const audio = attempt<AudioCapture>(
    { id: 'microphone', headline: t('blk.the_microphone_is_not_ready'), detail: null },
    () => {
      audioHost = deps.createAudioHost();
      return deps.audio.createAudioCapture({
        ...(deps.ceilingSeconds === undefined ? {} : { ceilingSeconds: deps.ceilingSeconds }),
        host: audioHost,
      } as Parameters<AudioModule['createAudioCapture']>[0]);
    },
    record,
  );

  // ---- the helpers ------------------------------------------------------------------
  //
  // ONE `kotiba-input.exe`, SHARED. The inserter and the focus source both talk to it, and
  // building one each means two child processes, two restarts to supervise and two
  // chances for the foreground read to disagree with the paste about which window is in
  // front. `src/platform` recommends the share in as many words; taking it needs the
  // concrete factories rather than the contract ones, which is what they are exported for.
  const inputHelper = attempt(
    {
      id: 'hotkey',
      headline: t('blk.kotiba_cannot_type_into_other_applications'),
      detail: t('blk.the_helper_that_types_your_words'),
    },
    () =>
      platform.createInputHelper({
        helperPath: paths.inputHelperPath,
        onNote: (note) => {
          deps.onNote(`kotiba-input: ${note}`);
        },
      }),
    record,
  );

  const hotkey = attempt<HotkeySource>(
    {
      id: 'hotkey',
      headline: t('blk.the_dictation_key_is_not_being'),
      detail: t('blk.quitting_and_reopening_kotiba_usually_clears'),
    },
    () =>
      platform.createWindowsHotkeySource({
        helperPath: paths.hookHelperPath,
        binding: settings.hotkey,
        onNote: (note) => {
          deps.onNote(`kotiba-hook: ${note}`);
        },
      }),
    record,
  );

  const inserter =
    inputHelper === null
      ? null
      : attempt<Inserter>(
          {
            id: 'hotkey',
            headline: t('blk.kotiba_cannot_type_into_other_applications'),
            detail: t('blk.the_helper_that_types_your_words'),
          },
          () =>
            platform.createWindowsInserter({
              helperPath: paths.inputHelperPath,
              helper: inputHelper,
            }),
          record,
        );

  const focus =
    inputHelper === null
      ? null
      : attempt<FocusSource>(
          {
            id: 'hotkey',
            headline: t('blk.kotiba_cannot_see_which_application_is'),
            detail: t('blk.modes_will_not_follow_the_app'),
          },
          () =>
            platform.createWindowsFocusSource({
              helperPath: paths.inputHelperPath,
              helper: inputHelper,
            }),
          record,
        );

  // ---- ducking ----------------------------------------------------------------------
  //
  // A SECOND kotiba-input.exe, deliberately not the shared one: a restore ramp is a dozen
  // writes on a 13 ms cadence that start at the same moment as the paste, and the helper
  // answers strictly in order — shared, the ramp would queue behind a long SendInput and
  // the paste behind the ramp. Like the other helpers it spawns on first use, not here.
  let duckHelper: ReturnType<PlatformModule['createInputHelper']> | null = null;
  let ducker: Ducker;
  try {
    const helper = platform.createInputHelper({
      helperPath: paths.inputHelperPath,
      onNote: (note) => {
        deps.onNote(`kotiba-input (ducking): ${note}`);
      },
    });
    duckHelper = helper;
    ducker = platform.createDucker({
      backend: platform.helperDuckingBackend(helper),
      marker: platform.fileMarkerStore(
        deps.duckingMarkerPath ?? `${paths.supportDirectory}/ducking.json`,
      ),
      ownPids: deps.ownPids ?? (() => new Set([process.pid])),
      onNote: deps.onNote,
    });
  } catch (error: unknown) {
    deps.onNote(`ducking is off: ${error instanceof Error ? error.message : String(error)}`);
    ducker = INERT_DUCKER_FALLBACK;
  }

  // ---- the on-device engines ----------------------------------------------------------
  //
  // Built BEFORE the manager, because Parakeet is the unified family's first member. A
  // failure here costs English and Russian their fast engine, never the app: the bundled
  // whisper model behind it still serves both, so it is a note, not a blocker.
  let onDevice: OnDeviceEngines | null = null;
  if (deps.onDevice !== undefined) {
    const module = deps.onDevice;
    const cpus = deps.cpuCount ?? logicalProcessorCount();
    const bundles = module.createBundleStore({
      modelsDirectory: paths.modelsDirectory,
      readOnlyDirectory: paths.bundledDirectory,
    });
    let parakeet: OnDeviceEngines['parakeet'] = null;
    try {
      parakeet = new module.ParakeetEngine({
        store: bundles,
        threads: module.resolveOrtThreads(cpus),
        autoDownload: deps.autoDownload ?? true,
        onNote: deps.onNote,
        onStateChange: (state) => deps.onBundleState?.('parakeet_ultra', state),
        ...(deps.engineLauncher === undefined ? {} : { launcher: deps.engineLauncher }),
      });
    } catch (error: unknown) {
      deps.onNote(`parakeet: not built — ${error instanceof Error ? error.message : String(error)}`);
    }
    let arabic: OnDeviceEngines['arabic'] = null;
    if (module.ArabicEngine !== undefined) {
      try {
        arabic = new module.ArabicEngine({
          store: bundles,
          threads: module.resolveOrtThreads(cpus),
          autoDownload: false,
          ...deps.arabic,
          onNote: deps.onNote,
          onBundleState: (id, state) => deps.onBundleState?.(id, state),
          ...(deps.engineLauncher === undefined ? {} : { launcher: deps.engineLauncher }),
          speechDetectorPath: async () => {
            const directory = await bundles.locate('silero_vad');
            return directory === null ? null : join(directory, SILERO_VAD.files[0]!.localName);
          },
        });
      } catch (error: unknown) {
        deps.onNote(`arabic: not built — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const qwen = QWEN3_1_7B.files[0]!.localName;
    const modelPath = async (): Promise<string | null> => {
      const directory = await bundles.locate('qwen3_1_7b');
      return directory === null ? null : join(directory, qwen);
    };
    const threads = module.resolveLlamaThreads(cpus);
    const inProcess = (): import('../polish/index.js').ModesModel =>
      new module.LlamaPolisher({ modelPath, threads, onNote: deps.onNote });
    const launcher = deps.engineLauncher;
    const llama =
      launcher !== undefined && module.RemoteLlamaPolisher !== undefined
        ? new module.RemoteLlamaPolisher({
            launcher,
            modelPath,
            config: { threads },
            onNote: deps.onNote,
            // Only for a host that cannot START (a packaging fault) — a crash restarts it.
            fallback: inProcess,
          })
        : inProcess();
    // Arabic's own modes model (C4 §14.5): the same machinery, its own GGUF and process,
    // Arabic only. Nothing loads it until an Arabic dictation asks.
    const gemma = GEMMA4_E2B_AR.files[0]!.localName;
    const arabicModesPath = async (): Promise<string | null> => {
      const directory = await bundles.locate('gemma4_e2b_ar');
      return directory === null ? null : join(directory, gemma);
    };
    const arabicOnly = new Set<import('../contracts/index.js').Language>(['ar']);
    const arabicInProcess = (): import('../polish/index.js').ModesModel =>
      new module.LlamaPolisher({ modelPath: arabicModesPath, threads, id: 'gemma-4-e2b-ar', languages: arabicOnly, onNote: deps.onNote });
    const arabicModes =
      launcher !== undefined && module.RemoteLlamaPolisher !== undefined
        ? new module.RemoteLlamaPolisher({
            launcher,
            modelPath: arabicModesPath,
            config: { threads, id: 'gemma-4-e2b-ar' },
            languages: arabicOnly,
            onNote: deps.onNote,
            fallback: arabicInProcess,
          })
        : arabicInProcess();
    onDevice = { bundles, parakeet, arabic, llama, arabicModes };
  }
  const lead = onDevice?.parakeet ?? null;
  const arabicLead = onDevice?.arabic ?? null;
  const bundles = onDevice?.bundles ?? null;

  // ---- the engines ------------------------------------------------------------------
  const engines = attempt<EngineManager>(
    { id: 'uzbek-model', headline: t('blk.the_speech_engine_could_not_be'), detail: null },
    () =>
      createEngines(deps.engines, {
        settings,
        models,
        hostPath: paths.sttHelperPath,
        onNote: deps.onNote,
        ...(deps.cpuCount === undefined ? {} : { cpuCount: deps.cpuCount }),
        ...(lead === null || bundles === null
          ? {}
          : {
              unifiedLead: {
                engine: lead,
                status: async () => ((await bundles.isInstalled('parakeet_ultra')) ? 'ready' : 'notInstalled'),
              },
            }),
        // C4: Arabic's own engine heads its family; whisper turbo is behind it.
        ...(arabicLead === null || bundles === null
          ? {}
          : {
              arabicLead: {
                engine: arabicLead,
                status: async () =>
                  (await bundles.isInstalled('cohere_arabic')) || (await bundles.isInstalled('fastconformer_ar'))
                    ? 'ready'
                    : 'notInstalled',
              },
            }),
        // C2: the Uzbek engine streams, cutting on Silero from the bundle store.
        ...(bundles === null
          ? {}
          : {
              speechDetectorPath: async () => {
                const directory = await bundles.locate('silero_vad');
                return directory === null ? null : join(directory, SILERO_VAD.files[0]!.localName);
              },
              // P4: the language-ID model, from the installer or a download, routes when present.
              bundles,
            }),
        ...(deps.engineLauncher === undefined ? {} : { engineLauncher: deps.engineLauncher }),
      }),
    record,
  );

  const complete: ReadyPipeline | null =
    settingsStore !== null &&
    secrets !== null &&
    engines !== null &&
    audio !== null &&
    inserter !== null &&
    hotkey !== null &&
    focus !== null &&
    history !== null &&
    diagnostics !== null
      ? {
          settings: settingsStore,
          secrets,
          engines,
          audio,
          inserter,
          hotkey,
          focus,
          history,
          diagnostics,
          models,
        }
      : null;

  let disposed = false;
  return {
    ducker,
    settingsStore,
    settings,
    secrets,
    history,
    diagnostics,
    models,
    audio,
    hotkey,
    inserter,
    focus,
    engines,
    onDevice,
    complete,
    ready: complete !== null,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // The shared helper belongs to THIS module: neither the inserter nor the focus
      // source created it, so neither will tear it down, and a `kotiba-input.exe` left
      // running after the app quits is a process the user has no way to find.
      await inputHelper?.dispose();
      await duckHelper?.dispose();
      // The manager disposes Parakeet with its family; the modes' model is this module's.
      await onDevice?.llama.dispose();
      await onDevice?.arabicModes.dispose();
      // Same argument for the capture bridge's two `ipcMain` listeners: the capture
      // module was handed the host, it did not make it, so it does not unmake it.
      (audioHost as { dispose?: () => void } | null)?.dispose?.();
    },
  };
}
