// src/main — Electron main, tray, IPC, autostart, --check.  OWNER: t10
//
// The composition root. It builds every factory from `src/contracts`, wires them into a
// `DictationController`, owns the hidden audio window and the child processes, and
// reports a helper that will not start in the tray rather than silently.
//
// This module and `src/renderer` are the only two that may import `electron`.
//
// THE ONE STRUCTURAL RULE HERE: a module that is missing or that refuses to start
// becomes a BLOCKER, never a crash. This is a tray app — there is no window to show a
// stack trace in, and a program that vanishes on launch gives its user nothing to act
// on. Every seam below is built inside `attempt`, and every failure ends up as a
// sentence the user can read on Home (and Settings › Permissions) and in the tray menu.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { BrowserWindow, app, clipboard, ipcMain, shell } from 'electron';

import { appLanguage, resolveAppLanguage, setAppLanguage, t } from '../core/i18n/index.js';
import { defaultLanguageOrder, languageCounts, orderLanguages } from '../core/languages/order.js';

import type {
  Blocker,
  BundleId,
  BundleState,
  DiagnosticsSink,
  DictationController,
  DictationStatus,
  EngineManager,
  HistoryStore,
  Language,
  Mode,
  ModeKey,
  ModelId,
  ModelRole,
  ModelStatus,
  ModelStore,
  HotkeySource,
  SecretStore,
  Settings,
  SettingsStore,
} from '../contracts/index.js';
import {
  BUNDLE_CATALOGUE,
  BUNDLE_IDS,
  LANGUAGES,
  bundleBytes,
  isLanguage,
  CREDENTIAL_SERVICE,
  DEFAULT_SETTINGS,
  LEGACY_CREDENTIAL_SERVICE,
  LEGACY_SUPPORT_DIRECTORY_NAME,
  MODEL_CATALOGUE,
  PUBLIC_MODELS_BASE,
  PUBLIC_MODELS_LIVE,
  MODEL_IDS,
  MODEL_ROLES,
  SETTINGS_KEYS,
} from '../contracts/index.js';

import type { SessionPorts } from '../session/index.js';
import type { Ducker } from '../platform/index.js';

import { createWindowAudioHost } from './audio-host.js';
import { reconcileLaunchAtLogin, setLaunchAtLogin } from './autostart.js';
import type { QuitCause } from './lifecycle.js';
import { loginItemWanted, quitDecision, watchdogWanted } from './lifecycle.js';
import { feedbackFor } from './feedback-model.js';
import type { PillFrame } from './pill-model.js';
import { PILL_HIDE_AFTER_FOLD_MS, PILL_LINGER_MS, pillState, resolvePillStyle } from './pill-model.js';
import type { WatchdogHandle } from './watchdog.js';
import { WATCHDOG_SCRIPT_NAME, WATCHDOG_SOURCE, WATCHDOG_STATE_NAME, startWatchdog } from './watchdog.js';
import type { CheckReport } from './check.js';
import { checkExitCode, formatCheckHuman, formatCheckJson, runCheck } from './check.js';
import type { OnDeviceEngines } from './compose.js';
import { attempt, composePipeline } from './compose.js';
import { ROLE_FOR_MODEL } from './engine-wiring.js';
import type { AppSnapshot, ModelReport, ModelSlotState } from './ipc.js';
import { IPC_AUDIO, IPC_INVOKE, IPC_SEND } from './ipc.js';
import type { LaunchOptions } from './launch.js';
import {
  SECOND_INSTANCE_MESSAGE,
  mayOpenWindows,
  parseLaunchOptions,
} from './launch.js';
import type { MenuAction } from './menu-model.js';
import { shouldShowOnboarding } from './onboarding-model.js';
import { secretIsPresent } from './settings-model.js';
import { SOUND_SETTINGS_URI } from '../core/input-device/index.js';
import { isAllowedExternalLink } from './about-model.js';
import type { AcceptedDownload, DownloadRow, DownloadState } from './downloads-model.js';
import { withoutHealing } from './live-status.js';
import {
  bundleRowState,
  gettingReadyPercent,
  launchResume,
  modelRowState,
  parseDownloadIds,
  uzbekRowState,
  wantedDownloads,
  withAccepted,
} from './downloads-model.js';
import { removableModelFiles } from './languages-model.js';
import { autoDetectReady } from '../core/settings/models.js';
import { settleLanguages } from '../core/settings/parse.js';
import { utilityLauncher } from './utility-launcher.js';
import { ARABIC_SPEED_CHECK_FILE, arabicBackend, arabicMayDownload, speedCheckFileStore } from './arabic-wiring.js';
import {
  arabicSpeedClipSearch,
  bundledModelsDirectory,
  describeAllResources,
  diagnosticsPath,
  fixturesAudioDirectory,
  historyPath,
  hookExecutablePath,
  hostExecutablePath,
  inputExecutablePath,
  kotibaDirectories,
  localDirectory,
  modelsDirectory,
  supportDirectory,
} from './paths.js';
import type { TrayController } from './tray.js';
import { createTray } from './tray.js';
import { createAudioWindow, createHudWindow, createMainWindow, hideHud, hudMaxMessageWidth, showHud } from './windows.js';

export { runCheck } from './check.js';
export type { CheckReport } from './check.js';
export { setLaunchAtLogin };

// ---------------------------------------------------------------------------------
// Failure that does not kill the app
// ---------------------------------------------------------------------------------
//
// `attempt` moved to `./compose.ts` with the pipeline it wraps, and is re-exported here
// because this is the module people look in for it.

export { attempt };

/**
 * A line of prose about how the app resolved something, on stderr.
 *
 * stderr and not a Blocker: a note is not a thing the user can act on, and a resolver
 * that found its model on the second candidate is information for whoever is reading a
 * log, not a row in the settings pane. It exists so "no engine is configured" is never
 * again the whole of what the app said about a path it could not find.
 */
function diagnosticNote(note: string): void {
  process.stderr.write(`kotiba: ${note}\n`);
}

// ---------------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------------

/**
 * One instance only.
 *
 * Two copies would share a hotkey and race two pastes into the same caret, which is not
 * a tidiness argument — it is a corrupted document. macOS refuses a duplicate silently
 * because there the older copy is visibly the same icon in the same place; here a
 * double-clicked shortcut that does nothing at all reads as a broken install and gets
 * clicked again, so the second copy SAYS WHY before it goes.
 */
export function acquireSingleInstance(): boolean {
  return app.requestSingleInstanceLock();
}

/** The system's preferred languages, best first — what an `appLanguage` of `''` follows. */
function systemLanguages(): readonly string[] {
  try {
    const preferred = app.getPreferredSystemLanguages();
    if (preferred.length > 0) return preferred;
  } catch {
    /* fall through to the locale */
  }
  try {
    return [app.getLocale()];
  } catch {
    return [];
  }
}

/**
 * Set the main process's interface language from the setting: the tray menu and tooltip, the
 * blockers, the pill's sentences and the error messages are all worded here. Returns whether it
 * changed, so a caller can re-push what it had already worded.
 */
function applyInterfaceLanguage(setting: string): boolean {
  return setAppLanguage(resolveAppLanguage(setting, systemLanguages()));
}

async function refuseSecondInstance(): Promise<void> {
  const { Notification } = await import('electron');
  if (Notification.isSupported()) {
    // A notification rather than a modal: a dialog owned by a process that is about to
    // exit is a dialog with nothing behind it.
    // Settings are not read in a copy that is leaving, so it speaks the system's language.
    applyInterfaceLanguage('');
    new Notification({ title: t('launch.secondTitle'), body: t('launch.secondMessage') }).show();
  } else {
    console.error(SECOND_INSTANCE_MESSAGE);
  }
  app.quit();
}

// ---------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------

interface Shell {
  /** Only the SHELL's own blockers. The controller owns the pipeline's. */
  readonly blockers: Blocker[];
  controller: DictationController | null;
  /** For `refreshReadiness`, which re-asks which languages can be dictated right now. */
  engines: EngineManager | null;
  settings: Settings;
  modes: Readonly<Record<string, Mode>>;
  tray: TrayController | null;
  lastTranscript: string | null;
  /** The name of a model being fetched — input 3 of the tray icon's four. */
  downloading: string | null;
  level: number;
  userPickedMode: ModeKey | null;
  activeModeKey: ModeKey;
  availableLanguages: readonly Language[];
  /** The tray's Language section order: default, then by the last 30 days' usage. */
  languageOrder: readonly Language[];
  /** The record of the last finished dictation, for the pill's time and the window. */
  lastRecord: DictationController['lastRecord'];
  /** Push the whole state to every window. Set once the windows exist. */
  push: () => void;
  /** The hook, for the recorder. */
  hotkey: HotkeySource | null;
  /** Persists a patch; set once the store exists. */
  settingsWriter: ((patch: Partial<Settings>) => Promise<Settings>) | null;
  /** The main window's level feed, when it wants one. */
  levelSink: ((level: number) => void) | null;
  /** Parakeet and Qwen, as built by the composition root. */
  onDevice: OnDeviceEngines | null;
  /** What each first-use bundle is doing. One writer: the bundle's owner, through `onBundleState`. */
  bundles: Record<BundleId, BundleState>;
  /** C4: which Arabic engine is active and why. One writer: the engine, through `onStatus`. */
  arabic: import('../engines/index.js').ArabicEngineStatus | null;
  /** The Uzbek row of the models list. Re-read by `refreshModelRows`. */
  uzbekDownload: DownloadState;
  /** whisper turbo's row (Turkish / Arabic, D-W25). Re-read by `refreshModelRows`. */
  turboDownload: DownloadState;
  /** The model store, for the Uzbek row and its download. Set once the pipeline exists. */
  models: ModelStore | null;
  /** Accepted downloads run one after another, in this chain — one link at a time on the network. */
  downloadQueue: Promise<void>;
  /** What is queued or running, so a second accept does not fetch the same model twice. */
  queued: Set<AcceptedDownload>;
}

function newShell(): Shell {
  return {
    blockers: [],
    controller: null,
    engines: null,
    settings: DEFAULT_SETTINGS,
    modes: {},
    tray: null,
    lastTranscript: null,
    downloading: null,
    level: 0,
    userPickedMode: null,
    activeModeKey: DEFAULT_SETTINGS.defaultModeKey as ModeKey,
    availableLanguages: ['en'],
    languageOrder: defaultLanguageOrder(),
    lastRecord: null,
    push: () => undefined,
    hotkey: null,
    settingsWriter: null,
    levelSink: null,
    onDevice: null,
    bundles: {
      parakeet_ultra: { kind: 'notDownloaded' },
      qwen3_1_7b: { kind: 'notDownloaded' },
      silero_vad: { kind: 'notDownloaded' },
      cohere_arabic: { kind: 'notDownloaded' },
      fastconformer_ar: { kind: 'notDownloaded' },
      gemma4_e2b_ar: { kind: 'notDownloaded' },
    },
    uzbekDownload: { kind: 'included' },
    turboDownload: { kind: 'notDownloaded' },
    arabic: null,
    models: null,
    downloadQueue: Promise.resolve(),
    queued: new Set(),
  };
}

// ---------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------

/** Normal launch: tray, hidden audio window, hook, engines, and the first-run window. */
export async function main(): Promise<void> {
  const options = parseLaunchOptions(process.argv.slice(1));

  // `--check` never touches the window layer at all, so it runs before `whenReady` and
  // on a machine with no display.
  if (options.check) {
    const report = await runCheck({
      fixturePath: options.fixturesDirectory ?? fixturesAudioDirectory(),
      modelsDirectory: options.modelsDirectory ?? modelsDirectory(),
      bundledDirectory: bundledModelsDirectory(),
    });
    reportCheck(report);
    // Both, and in this order. `process.exitCode` is the value Node uses if the process
    // ever unwinds normally instead; `app.exit` is what actually ends an Electron main
    // process that has no window and no message loop to return to. Setting only the
    // first would let a stray handle keep the process alive; calling only the second
    // leaves nothing behind if Electron declines to exit immediately.
    process.exitCode = checkExitCode(report);
    app.exit(checkExitCode(report));
    return;
  }

  if (!acquireSingleInstance()) {
    await refuseSecondInstance();
    return;
  }

  await app.whenReady();
  await start(options);
}

/**
 * stdout gets the JSON, stderr the prose — so `| jq` works and a human can read the log.
 *
 * `writeSync` on the raw descriptors, not `process.stdout.write`: on Windows a stdio
 * stream connected to a PIPE is asynchronous, and `app.exit()` on the next line ends the
 * process without draining it. A truncated report from a check that then exits non-zero
 * is the worst of both — CI fails and the log does not say why.
 */
export function reportCheck(report: CheckReport): void {
  writeSync(1, `${formatCheckJson(report)}\n`);
  writeSync(2, `${formatCheckHuman(report)}\n`);
}

// ---------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------
async function start(options: LaunchOptions): Promise<void> {
  const state = newShell();
  const record = (blocker: Blocker): void => {
    if (!state.blockers.some((existing) => existing.id === blocker.id)) state.blockers.push(blocker);
  };

  const platform = await import('../platform/index.js');
  const engineModule = await import('../engines/index.js');
  const audioModule = await import('../audio/index.js');
  const sessionModule = await import('../session/index.js');
  const core = await import('../core/settings/index.js');
  const routingCore = await import('../core/routing/index.js');
  const textCore = await import('../core/text/index.js');
  const modesCore = await import('../core/modes/index.js');
  const polishModule = await import('../polish/index.js');
  const renameMigration = await import('../platform/rename-migration.js');

  // Kotib → Kotiba, before anything opens a settings, history or diagnostics file: the
  // pipeline below creates the new directories the moment it composes. See
  // `src/platform/rename-migration.ts`.
  const legacyPaths = kotibaDirectories(process.env, LEGACY_SUPPORT_DIRECTORY_NAME);
  const currentPaths = kotibaDirectories();
  const migration = await renameMigration.migrateKotibDirectories({
    directories: [
      { legacy: legacyPaths.roamingDirectory, current: currentPaths.roamingDirectory },
      { legacy: legacyPaths.localDirectory, current: currentPaths.localDirectory },
    ],
    markerDirectory: currentPaths.roamingDirectory,
  });
  if (!migration.alreadyDone) {
    const moved = migration.renamed.length + migration.merged.length;
    if (moved > 0 || migration.problems.length > 0) {
      diagnosticNote(`rename migration: moved ${String(moved)}, set aside ${String(migration.setAside.length)}` +
        (migration.problems.length > 0 ? `; ${migration.problems.join('; ')}` : ''));
    }
    if (migration.problems.length > 0) {
      record({
        id: 'renamed-legacy-running',
        headline: t('blk.the_old_kotib_is_still_running'),
        detail: t('blk.kotiba_is_kotib_s_new_name'),
      });
    }
  }

  // THE PURE SEAM. `SessionPorts` is the half of the session's dependencies that has no
  // interface in `src/contracts` — the routing checks, the delivery pipeline, the two
  // polish guards, mode resolution. Everything on the object below is a plain function
  // out of `src/core`.
  const ports: SessionPorts = {
    routing: {
      verifyRoute: routingCore.verifyRoute,
      nonRussianCyrillicCount: routingCore.nonRussianCyrillicCount,
      isUsableRerun: routingCore.isUsableRerun,
      transcriptDoubt: routingCore.transcriptDoubt,
      readsAsEnglish: routingCore.readsAsEnglish,
    },
    createRouter: routingCore.createTieredRouter,
    text: {
      deliver: textCore.deliver,
      createCapitaliser: textCore.createCapitaliser,
      checkPolishGuard: textCore.checkPolishGuard,
      checkUzbekPolishGuard: textCore.checkUzbekPolishGuard,
      // The deterministic half of every built-in mode but Raw (C3 §3).
      cleanUp: modesCore.cleanUp,
    },
    modes: {
      resolveMode: core.resolveMode,
      isSensitiveApp: core.isSensitiveApp,
      formatForApp: core.formatForApp,
      polishInstructions: core.polishInstructions,
      promptContext: core.promptContext,
    },
    // The Mac's `makePolisher` without a cloud endpoint: every built-in mode gets its
    // deterministic half, and Qwen3-1.7B once its GGUF is on disk (C3 §7). Asked per
    // dictation, so a download that lands mid-session is used from the next press.
    createPolishChain: polishModule.createOnDevicePolishChain({
      model: () =>
        state.onDevice !== null && state.bundles.qwen3_1_7b.kind !== 'notDownloaded' &&
        state.bundles.qwen3_1_7b.kind !== 'downloading' && state.bundles.qwen3_1_7b.kind !== 'failed'
          ? state.onDevice.llama
          : null,
      // Arabic's own modes model (C4 §14.5): only while Arabic is on and its GGUF is here.
      arabicModel: () =>
        state.onDevice !== null && state.settings.enabledLanguages.includes('ar') &&
        (state.bundles.gemma4_e2b_ar.kind === 'downloaded' || state.bundles.gemma4_e2b_ar.kind === 'loaded')
          ? state.onDevice.arabicModes
          : null,
    }),
    locale: app.getLocale(),
  };

  state.modes = core.builtInModes();

  // Said once per launch, hit or miss — the same table `--check` prints.
  diagnosticNote(describeAllResources());

  // ---- windows --------------------------------------------------------------------
  // The hidden capture window is created even under `--background`: it is not a window
  // the user can see, it IS the microphone (D-W6), and dictation must work at sign-in.
  const capture = createAudioWindow({
    onGone: (why) => {
      record({ id: 'microphone', headline: t('blk.the_microphone_stopped'), detail: why });
      state.push();
    },
  });
  const hud = createHudWindow();
  /** Set once a quit is allowed; the main window then closes instead of hiding. */
  let quitting = false;
  const mainWindow = createMainWindow({ mayClose: () => quitting });

  // ---- the pipeline ---------------------------------------------------------------
  const pipeline = await composePipeline({
    platform,
    engines: engineModule,
    audio: audioModule,
    paths: {
      supportDirectory: supportDirectory(),
      historyPath: historyPath(),
      diagnosticsPath: diagnosticsPath(),
      modelsDirectory: modelsDirectory(),
      bundledDirectory: bundledModelsDirectory(),
      sttHelperPath: hostExecutablePath(),
      hookHelperPath: hookExecutablePath(),
      inputHelperPath: inputExecutablePath(),
    },
    appVersion: app.getVersion(),
    createAudioHost: () =>
      createWindowAudioHost({
        webContents: capture.window.webContents,
        ipc: ipcMain,
        ready: capture.ready,
      }),
    onNote: diagnosticNote,
    record,
    // Every process Kotiba runs — main, the renderers, the audio service. The ducker never
    // lowers them, so a start/stop sound of our own is not ducked under the user's music.
    ownPids: () => new Set([process.pid, ...app.getAppMetrics().map((metric) => metric.pid)]),
    duckingMarkerPath: join(localDirectory(), platform.DUCKING_MARKER_NAME),
    // Parakeet (English + Russian) and Qwen3-1.7B (the modes), fetched on first use.
    onDevice: {
      ParakeetEngine: engineModule.ParakeetEngine,
      ArabicEngine: engineModule.ArabicEngine,
      createBundleStore: engineModule.createBundleStore,
      resolveOrtThreads: engineModule.resolveOrtThreads,
      LlamaPolisher: polishModule.LlamaPolisher,
      resolveLlamaThreads: polishModule.resolveLlamaThreads,
      RemoteLlamaPolisher: polishModule.RemoteLlamaPolisher,
    },
    // D-W22: each engine in its own utility process, so a native crash in ONNX Runtime or
    // llama.cpp costs that engine a restart, not the app — and neither's model load can
    // stall this process's event loop at key-down.
    engineLauncher: utilityLauncher(),
    onBundleState: (id, next) => setBundleState(state, id, next),
    // D-W25: Parakeet is core — it may fetch itself when a dictation wants it once onboarding
    // is over (finished or skipped), as the launch resume does. Asked at that moment.
    autoDownload: () => state.settings.onboardingCompleted,
    // C4: Arabic's engine, read live — the Languages page changes all of these at runtime.
    arabic: {
      autoDownload: () => arabicMayDownload(state.settings),
      choice: () => state.settings.arabicEngine,
      backend: () => arabicBackend(state.settings),
      speedChecks: speedCheckFileStore(join(modelsDirectory(), ARABIC_SPEED_CHECK_FILE)),
      speedClip: async () => {
        const path = arabicSpeedClipSearch().path;
        return path === null ? null : (await audioModule.readWavFile(path)).samples;
      },
      onStatus: (status) => {
        state.arabic = status;
        state.push();
      },
    },
  });
  state.onDevice = pipeline.onDevice;
  state.models = pipeline.models;
  // After onboarding: fetch (or resume) the core and the files of any optional language that
  // is on — nothing before onboarding is over (D-W25).
  void refreshBundles(state)
    .then(() => refreshModelRows(state))
    .then(() => resumeDownloads(state));
  // Silero for the streaming Uzbek session (C2) SHIPS IN THE INSTALLER (885 KB) — it is
  // never downloaded. Missing means a broken install or a dev tree without
  // `fetch-models.mjs`; each Uzbek stream then cuts on the energy gate, and the log says so.
  void pipeline.onDevice?.bundles.locate('silero_vad').then((directory) => {
    if (directory === null) diagnosticNote('silero: not in the installed resources — Uzbek streams cut on the energy gate');
  });

  const { settingsStore, secrets, history, diagnostics, models } = pipeline;
  // The polish key, once the settings (and so the account name) have come across.
  if (!migration.alreadyDone && secrets !== null) {
    void renameMigration
      .migrateKotibSecrets({
        legacy: platform.createSecretStore({ service: LEGACY_CREDENTIAL_SERVICE }),
        current: secrets,
        accounts: [DEFAULT_SETTINGS.polishKeyAccount, pipeline.settings.polishKeyAccount],
      })
      .then(({ copied, problems }) => {
        if (copied.length > 0 || problems.length > 0) {
          diagnosticNote(`rename migration: credentials copied to ${CREDENTIAL_SERVICE}: ` +
            `${copied.join(', ') || 'none'}${problems.length > 0 ? `; ${problems.join('; ')}` : ''}`);
        }
      });
  }
  const ducker: Ducker = pipeline.ducker;
  state.engines = pipeline.engines;
  state.hotkey = pipeline.hotkey;
  state.settingsWriter = settingsStore === null ? null : (patch) => settingsStore.update(patch);
  // The window's hero pill is a live meter too, at the same 20 Hz.
  state.levelSink = (level) => {
    if (!mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.webContents.send(IPC_SEND.levelChanged, level);
    }
  };
  state.settings = pipeline.settings;
  applyInterfaceLanguage(state.settings.appLanguage);
  state.activeModeKey = pipeline.settings.defaultModeKey as ModeKey;

  // Before the first press: a crash or End Task mid-hold left someone's music lowered,
  // and this is the first moment anything can put it back.
  void ducker.recoverFromCrash();

  const complete = pipeline.complete;
  const controller =
    complete === null
      ? null
      : attempt(
          { id: 'microphone', headline: t('blk.dictation_is_not_running'), detail: null },
          () =>
            sessionModule.createDictationController({
              ports,
              ...complete,
              // The REAL ducker, installed here and nowhere else: a controller built by a
              // test holds the inert one and can never move this machine's volume.
              ducking: ducker,
              // D-W25: a press for a language whose engine is still downloading says how far
              // it has got, rather than "not ready".
              gettingReady: (language) => gettingReadyPercent(language, downloadRows(state), state.queued),
              modes: state.modes,
              config: {
                silenceThreshold: state.settings.silenceThreshold,
                polishDeadlineMs: Math.max(1, state.settings.polishTimeoutSeconds) * 1000,
                rerouteDeadlineMs: 10_000,
              },
            }),
          record,
        );
  state.controller = controller;

  // ---- always on --------------------------------------------------------------------
  const lifecycle = createLifecycle({ state, mainWindow, options, ducker });

  // ---- tray -----------------------------------------------------------------------
  const tray = createTray({
    onAction: (action) => void dispatch(action, state, mainWindow, options, lifecycle),
    onLeftClick: () => openWindow(mainWindow, options, 'home'),
  });
  state.tray = tray;

  // ---- one push, to every surface ---------------------------------------------------
  let hideTimer: NodeJS.Timeout | null = null;
  let presented = false;
  let hideGeneration = 0;
  const sendPill = (): void => {
    if (!hud.isDestroyed()) hud.webContents.send(IPC_SEND.pillFrame, pillFrame(state, presented));
  };
  const presentPill = (): void => {
    hideGeneration += 1;
    presented = true;
    showHud(hud);
    sendPill();
  };
  /** Spring the capsule back up, then take the window away — the Mac's `HUDPanel.hide`. */
  const dismissPill = (): void => {
    hideGeneration += 1;
    const mine = hideGeneration;
    presented = false;
    sendPill();
    setTimeout(() => {
      if (mine === hideGeneration) hideHud(hud);
    }, PILL_HIDE_AFTER_FOLD_MS);
  };
  state.push = (): void => {
    refreshTray(state);
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_SEND.appState, appSnapshot(state));
    sendPill();
  };

  let previousKind: DictationStatus['kind'] | null = null;
  const unsubscribe = controller?.onStatusChange((status: DictationStatus) => {
    state.lastRecord = controller.lastRecord;
    // The Mac's `Feedback.play`, at the same four moments, off unless asked for.
    const sound = feedbackFor(previousKind, status);
    previousKind = status.kind;
    if (sound !== null && state.settings.soundFeedback && !hud.isDestroyed()) {
      hud.webContents.send(IPC_SEND.feedback, sound);
    }
    if (status.kind === 'succeeded') {
      state.lastTranscript = status.text;
      void refreshLanguageOrder(state, diagnostics);
    }
    state.push();

    if (status.kind === 'listening') {
      if (hideTimer !== null) clearTimeout(hideTimer);
      hideTimer = null;
      presentPill();
      return;
    }
    // A chord cancelled the hold: nothing was said and nothing is inserted, so the pill
    // goes at once rather than lingering over a dictation that never was.
    if (status.kind === 'idle' && presented && !controller.isRunning) {
      if (hideTimer !== null) clearTimeout(hideTimer);
      hideTimer = null;
      dismissPill();
      return;
    }
    // THE LINGER IS MEASURED FROM THE OUTCOME, never from key-up: a cold Uzbek load is
    // about 7.8 s and would otherwise eat the whole visible window.
    if (status.kind === 'succeeded' || status.kind === 'heardNothing' || status.kind === 'failed') {
      if (hideTimer !== null) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        hideTimer = null;
        // Not while another dictation is already being spoken or finished.
        if (controller.status.kind === 'listening' || controller.status.kind === 'working') return;
        dismissPill();
      }, PILL_LINGER_MS);
    }
  });

  registerIpc({ state, settingsStore, secrets, history, diagnostics, models, mainWindow, lifecycle });
  void refreshLanguageOrder(state, diagnostics);
  wireAudioChannel(capture.window, state, hud);

  lifecycle.applySettings(state.settings);

  try {
    await controller?.start();
  } catch (error: unknown) {
    record({
      id: 'microphone',
      headline: t('blk.kotiba_could_not_finish_starting_up'),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  // The first readiness read of the launch.
  await refreshReadiness(state);

  // ---- first run --------------------------------------------------------------------
  // Hidden at launch — it is a tray app — except on the first run, when onboarding covers
  // the window and nothing else would show the user the app exists. Never at sign-in.
  if (
    shouldShowOnboarding({
      onboardingCompleted: state.settings.onboardingCompleted,
      background: options.background,
    })
  ) {
    openWindow(mainWindow, options, 'home');
  }

  // Every foreground, not once: a warm-up that failed once must be re-attempted, or the
  // microphone stays failed for the life of the process.
  mainWindow.on('focus', () => {
    void state.controller?.recheck().then(() => refreshReadiness(state));
  });

  // Windows is signing out, restarting or shutting down: that always wins, and the
  // watchdog must not bring the app back into a session that is ending.
  // BOTH events, and the first is the one that matters: `before-quit` refuses ordinary
  // quits while Always on is on, and a refusal during a session end would hold up the
  // user's sign-out. `query-session-end` arrives before Windows asks the app to go.
  mainWindow.on('query-session-end', () => {
    void lifecycle.sessionEnding();
  });
  mainWindow.on('session-end', () => {
    void lifecycle.sessionEnding();
  });

  // A tray app has no window keeping it alive. Without this the app exits the moment the
  // last window closes.
  app.on('window-all-closed', () => {
    /* deliberately empty — the tray is the app */
  });
  app.on('second-instance', () => openWindow(mainWindow, options, 'home'));
  let cleanedUp = false;
  app.on('before-quit', (event) => {
    if (!lifecycle.mayQuit()) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    // From here the main window must be allowed to close: its `close` handler hides it
    // otherwise, and a window that refuses to close CANCELS the quit — which used to
    // leave a process with no tray and no microphone holding the single-instance lock.
    quitting = true;
    if (cleanedUp) return;
    // ONCE, and awaited, then quit again. The ducker's restore has to reach its helper
    // BEFORE the pipeline kills that helper, or the music stays low and the marker that
    // would repair it at the next launch is gone too.
    event.preventDefault();
    void (async () => {
      if (hideTimer !== null) clearTimeout(hideTimer);
      unsubscribe?.();
      tray.destroy();
      const cap = <T>(work: Promise<T>): Promise<unknown> =>
        Promise.race([work, new Promise((resolve) => setTimeout(resolve, QUIT_CLEANUP_MS))]);
      await cap(ducker.restoreImmediately().catch(() => undefined));
      await cap(controller?.dispose().catch(() => undefined) ?? Promise.resolve());
      // The shared `kotiba-input.exe` belongs to the composition, not to the controller.
      await cap(pipeline.dispose().catch(() => undefined));
      cleanedUp = true;
      app.quit();
    })();
  });
}

/**
 * How long each quit step may take. A dictation still transcribing is not worth holding
 * a quit — or a Windows sign-out — hostage for longer than this.
 */
const QUIT_CLEANUP_MS = 2_000;

/** "Record new key" gives up on its own after this, and push-to-talk comes back. */
const HOTKEY_RECORDING_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------------
// Rendering the current state
// ---------------------------------------------------------------------------------

/**
 * Everything wrong, in the order a user can act on it: the pipeline's problems first —
 * a missing model is something they can fix — then the shell's own start-up failures.
 */
export function allBlockers(
  state: {
    readonly controller: DictationController | null;
    readonly blockers: readonly Blocker[];
  },
  downloads: readonly DownloadRow[] = [],
): readonly Blocker[] {
  const fromController = state.controller?.blockers() ?? [];
  const seen = new Set(fromController.map((blocker) => blocker.id));
  // A model whose download is running is not "missing": held back until it lands or fails.
  return withoutHealing([...fromController, ...state.blockers.filter((blocker) => !seen.has(blocker.id))], downloads);
}

function selectableModes(state: Shell): readonly Mode[] {
  // The tray order, which is NOT the registry order, and never `transcription`.
  return (['super', 'note', 'message'] as const)
    .map((key) => state.modes[key])
    .filter((mode): mode is Mode => mode !== undefined);
}

/**
 * Re-ask the pipeline what it can do right now, then redraw.
 *
 * TWO SHADOW COPIES LIVED IN `Shell` AND BOTH WENT STALE:
 *
 *   * `availableLanguages` was written in ONE place — the `models:inspect` handler, which
 *     only runs while the Languages pane is open. A user who never opened that pane, or
 *     who finished a model download and closed the window, had a tray whose "Pin language"
 *     submenu offered English alone, on a machine with all three models installed.
 *   * `activeModeKey` and `userPickedMode` were written by the tray's own dispatch, so a
 *     mode changed in Settings › Modes moved the setting and left the tray and the HUD
 *     showing the previous one until something else happened to redraw them.
 *
 * The fix for both is the same: the controller owns the mode (`resolveMode` is the four
 * tiers, and the credential gate above them, which the shell must not reimplement) and
 * the manager owns readiness. Read them; do not mirror them.
 *
 * `readiness()` stats the model files, so this is NOT called per status change during a
 * dictation — it is called when something that can CHANGE readiness happened: start-up,
 * "Check again", a settings write, a finished download, a model chosen or cleared.
 */
async function refreshReadiness(state: Shell): Promise<void> {
  const controller = state.controller;
  if (controller !== null) {
    try {
      const decision = await controller.resolveMode();
      // THE CREDENTIAL GATE IS PER-DICTATION AND IS NOT STATE. It fires on whatever is in
      // front at the moment of asking, and this function is called from settings writes
      // and finished downloads — so a user who happens to have a password manager focused
      // while a download lands would otherwise see the tray's active mode replaced and
      // their own pick silently cleared. The previous answer stands; the next dictation
      // applies the gate where it belongs.
      if (decision.source !== 'credentialField') {
        state.activeModeKey = decision.mode.key as ModeKey;
        // The tray's "Automatic" row is checked when nothing is pinned, and `userPicked`
        // is the only tier that means a pin.
        state.userPickedMode =
          decision.source === 'userPicked' ? (decision.mode.key as ModeKey) : null;
      }
    } catch {
      // A mode that cannot be resolved is not worth a blocker: the previous answer is
      // still on screen and the next dictation resolves it again.
    }
  }
  if (state.engines !== null) {
    try {
      const readiness = await state.engines.readiness();
      state.availableLanguages = LANGUAGES.filter((language) =>
        readiness.availableLanguages.has(language),
      );
    } catch {
      /* the previous list stands */
    }
  }
  state.push();
}

/**
 * Re-sort the tray's Language section from the diagnostics log (default order, then the last
 * 30 days' use, with hysteresis — `core/languages/order.ts`). Run at start and after a finished
 * dictation; the window's pickers do their own at page open, so nothing here can shuffle a
 * picker somebody is looking at.
 */
async function refreshLanguageOrder(state: Shell, diagnostics: DiagnosticsSink | null): Promise<void> {
  try {
    const records = (await diagnostics?.records()) ?? [];
    const next = orderLanguages({ counts: languageCounts(records, Date.now()), previous: state.languageOrder });
    if (next.join() === state.languageOrder.join()) return;
    state.languageOrder = next;
    state.push();
  } catch {
    /* the previous order stands */
  }
}

function refreshTray(state: Shell): void {
  state.tray?.update({
    status: state.controller?.status ?? { kind: 'idle' },
    blockers: allBlockers(state, downloadRows(state)),
    downloading: state.downloading,
    lastTranscript: state.lastTranscript,
    modeFollowsApp: state.settings.modeFollowsApp,
    userPickedMode: state.userPickedMode,
    activeModeKey: state.activeModeKey,
    selectableModes: selectableModes(state),
    pinnedLanguage: state.settings.pinnedLanguage,
    pinnableLanguages: state.availableLanguages,
    languageOrder: state.languageOrder,
    alwaysOn: state.settings.alwaysOn,
  });
}

/**
 * Polish, in words — what will run. Stated, so a dictation that "does nothing" is
 * explained. Derived from the same two facts the chain is built from (`polishEnabled`,
 * `preferOnDeviceModel`, and whether the GGUF is on disk), so the pane cannot claim a
 * model the dictation does not get.
 */
export function polishStatus(settings: Settings, modesModel: BundleState): string {
  if (!settings.polishEnabled) return t('polish.off');
  const rules = t('polish.rules');
  if (!settings.preferOnDeviceModel) return `${rules} ${t('polish.modelOff')}`;
  switch (modesModel.kind) {
    case 'downloaded':
    case 'loaded':
      return `${rules} ${t('polish.modelReady')}`;
    case 'downloading':
      return `${rules} ${t('polish.modelDownloading', { percent: percent(modesModel) })}`;
    case 'failed':
      return `${rules} ${t('polish.modelFailed', { why: modesModel.reason })}`;
    case 'notDownloaded':
      return `${rules} ${t('polish.modelNeeded', { mb: String(Math.round(bundleBytes(BUNDLE_CATALOGUE.qwen3_1_7b) / 1_000_000)) })}`;
  }
}

function percent(state: Extract<BundleState, { kind: 'downloading' }>): string {
  return state.totalBytes > 0 ? `${Math.floor((100 * state.receivedBytes) / state.totalBytes)} %` : '…';
}

/**
 * The one writer of `state.bundles`. Progress arrives per network chunk — thousands a
 * second — so the window is pushed only when the whole percent moves or the kind changes.
 */
function setBundleState(state: Shell, id: BundleId, next: BundleState): void {
  const previous = state.bundles[id];
  state.bundles[id] = next;
  const moved =
    previous.kind !== next.kind ||
    (previous.kind === 'downloading' &&
      next.kind === 'downloading' &&
      percent(previous) !== percent(next));
  if (moved) {
    state.push();
    if (next.kind === 'downloaded' || next.kind === 'loaded') void refreshReadiness(state);
  }
}

/** Launch, and after anything that may have put a bundle on disk: ask the disk. */
async function refreshBundles(state: Shell): Promise<void> {
  const onDevice = state.onDevice;
  if (onDevice === null) return;
  if (onDevice.parakeet !== null) setBundleState(state, 'parakeet_ultra', await onDevice.parakeet.refreshState());
  if (onDevice.arabic !== null) state.arabic = await onDevice.arabic.refreshState();
  const modes = state.bundles.qwen3_1_7b;
  if (modes.kind !== 'downloading') {
    const installed = await onDevice.bundles.isInstalled('qwen3_1_7b');
    setBundleState(state, 'qwen3_1_7b', installed ? (onDevice.llama.isLoaded ? { kind: 'loaded' } : { kind: 'downloaded' }) : modes.kind === 'failed' ? modes : { kind: 'notDownloaded' });
  }
  const arabicModes = state.bundles.gemma4_e2b_ar;
  if (arabicModes.kind !== 'downloading') {
    const installed = await onDevice.bundles.isInstalled('gemma4_e2b_ar');
    setBundleState(
      state,
      'gemma4_e2b_ar',
      installed ? (onDevice.arabicModes.isLoaded ? { kind: 'loaded' } : { kind: 'downloaded' }) : arabicModes.kind === 'failed' ? arabicModes : { kind: 'notDownloaded' },
    );
  }
}

/** Fetch a first-use bundle on the user's say-so — the Languages and Modes panes' buttons. */
async function downloadBundle(state: Shell, id: BundleId): Promise<void> {
  const onDevice = state.onDevice;
  if (onDevice === null) throw new Error('the on-device engines are not part of this build');
  if (id === 'parakeet_ultra') {
    if (onDevice.parakeet === null) throw new Error('Parakeet could not be started on this PC');
    await onDevice.parakeet.download();
    return;
  }
  if (id === 'cohere_arabic' || id === 'fastconformer_ar') {
    // Through the engine, so it hears about its own weights landing and loads them.
    if (onDevice.arabic === null) throw new Error('the Arabic engine could not be started on this PC');
    await onDevice.arabic.download(id === 'cohere_arabic' ? 'cohere' : 'fastConformer');
    return;
  }
  const total = bundleBytes(BUNDLE_CATALOGUE[id]);
  setBundleState(state, id, { kind: 'downloading', receivedBytes: 0, totalBytes: total });
  try {
    await onDevice.bundles.ensure(id, (progress) =>
      setBundleState(state, id, { kind: 'downloading', receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes }),
    );
    setBundleState(state, id, { kind: 'downloaded' });
  } catch (error: unknown) {
    setBundleState(state, id, { kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * The paths removing `language`'s model files would delete: the files only it uses while it is
 * off (`removableModelFiles`), in Kotiba's own models directory and present. Never a file the
 * user chose elsewhere, never the installer's read-only copy.
 */
function languageFilePaths(state: Shell, language: Language): string[] {
  const root = modelsDirectory();
  const paths: string[] = [];
  for (const file of removableModelFiles(language, state.settings.enabledLanguages)) {
    const path =
      file.kind === 'model'
        ? join(root, MODEL_CATALOGUE[file.id].fileName)
        : (state.onDevice?.bundles.directoryFor(file.id) ?? null);
    if (path === null || !path.toLowerCase().startsWith(root.toLowerCase())) continue;
    if (existsSync(path)) paths.push(path);
  }
  return paths;
}

/** A file's size, or a directory's (a bundle is a directory). */
async function bytesAt(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const entry of await readdir(path)) total += await bytesAt(join(path, entry));
    return total;
  } catch {
    return 0;
  }
}

function appSnapshot(state: Shell): AppSnapshot {
  return {
    status: state.controller?.status ?? { kind: 'idle' },
    blockers: allBlockers(state, downloadRows(state)),
    lastRecord: state.lastRecord,
    quietMic: state.controller?.quietMic ?? null,
    lastTranscript: state.lastTranscript,
    userPickedMode: state.userPickedMode,
    activeModeKey: state.activeModeKey,
    pinnedLanguage: state.settings.pinnedLanguage,
    pinnableLanguages: state.availableLanguages,
    downloading: state.downloading,
    alwaysOn: state.settings.alwaysOn,
    polishStatus: polishStatus(state.settings, state.bundles.qwen3_1_7b),
    onDevice: { parakeet: state.bundles.parakeet_ultra, modesModel: state.bundles.qwen3_1_7b, arabicModesModel: state.bundles.gemma4_e2b_ar },
    downloads: downloadRows(state),
    arabic: state.arabic,
  };
}

// ---------------------------------------------------------------------------------
// Model downloads (D-W23, D-W25)
// ---------------------------------------------------------------------------------

/**
 * Every downloadable model's row, in fetch order — wanted or not, so the Languages page can say
 * what turning Turkish or Arabic on would download. The pages draw only the wanted ones.
 */
function downloadRows(state: Shell): DownloadRow[] {
  return [
    { id: 'parakeet_ultra', state: bundleRowState(state.bundles.parakeet_ultra) },
    { id: 'uzbek_stt_v1', state: state.uzbekDownload },
    { id: 'qwen3_1_7b', state: bundleRowState(state.bundles.qwen3_1_7b) },
    { id: 'large_v3_turbo', state: state.turboDownload },
    { id: 'cohere_arabic', state: bundleRowState(state.bundles.cohere_arabic) },
    { id: 'gemma4_e2b_ar', state: bundleRowState(state.bundles.gemma4_e2b_ar) },
  ];
}

/** Whether this project's own model host answers yet — the Uzbek row's download depends on it. */
const UZBEK_DOWNLOADABLE =
  PUBLIC_MODELS_LIVE || !(MODEL_CATALOGUE.uzbek_stt_v1.url ?? '').startsWith(PUBLIC_MODELS_BASE);

/** The two model files fetched through the model store, rather than as bundles. */
type StoreDownload = 'uzbek_stt_v1' | 'large_v3_turbo';
const storeProgress: Partial<Record<StoreDownload, { receivedBytes: number; totalBytes: number }>> = {};
const storeErrors: Partial<Record<StoreDownload, string>> = {};

/** Re-read the Uzbek and turbo rows from disk: installed by the installer, by a download, or not. */
async function refreshModelRows(state: Shell): Promise<void> {
  const models = state.models;
  if (models === null) return;
  const status = await models.status('uzbek_stt_v1').catch((): ModelStatus => 'notInstalled');
  const inModels = await models.inspect(join(modelsDirectory(), MODEL_CATALOGUE.uzbek_stt_v1.fileName));
  const uzbek = uzbekRowState({
    status,
    inInstaller: status === 'ready' && inModels.status !== 'ready',
    downloadable: UZBEK_DOWNLOADABLE,
    downloading: storeProgress.uzbek_stt_v1 ?? null,
    error: storeErrors.uzbek_stt_v1 ?? null,
  });
  const turbo = modelRowState({
    status: await models.status('large_v3_turbo').catch((): ModelStatus => 'notInstalled'),
    downloading: storeProgress.large_v3_turbo ?? null,
    error: storeErrors.large_v3_turbo ?? null,
  });
  if (JSON.stringify([uzbek, turbo]) !== JSON.stringify([state.uzbekDownload, state.turboDownload])) {
    state.uzbekDownload = uzbek;
    state.turboDownload = turbo;
    state.push();
  }
}

/**
 * The Uzbek model or whisper turbo through the model store: sha256-verified, lands only when it
 * matches. A landed file is written into its setting (the Languages pane's Download did the same)
 * and the engines are rebuilt, so Turkish — or Arabic's head — works from the next press.
 */
async function downloadModel(state: Shell, id: StoreDownload): Promise<void> {
  const models = state.models;
  if (models === null) return;
  const total = MODEL_CATALOGUE[id].bytes ?? 0;
  storeProgress[id] = { receivedBytes: 0, totalBytes: total };
  delete storeErrors[id];
  let lastPercent = -1;
  try {
    const path = await models.ensure(id, (progress) => {
      storeProgress[id] = { receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes ?? total };
      const percent = total > 0 ? Math.floor((100 * progress.receivedBytes) / total) : 0;
      if (percent !== lastPercent) {
        lastPercent = percent;
        void refreshModelRows(state);
      }
    });
    const key = id === 'uzbek_stt_v1' ? 'uzbekModelPath' : 'russianModelPath';
    state.settings = (await state.settingsWriter?.({ [key]: path })) ?? { ...state.settings, [key]: path };
    await state.controller?.settingsChanged();
  } catch (error: unknown) {
    storeErrors[id] = error instanceof Error ? error.message : String(error);
  } finally {
    delete storeProgress[id];
    await refreshModelRows(state);
    await refreshReadiness(state);
  }
}

/**
 * Queue downloads, one after another. Each model's own failure lands in its row (`failed`, with
 * the reason) and never stops the next one. A model already queued or running is not queued twice.
 */
function startDownloads(state: Shell, ids: readonly AcceptedDownload[]): void {
  for (const id of ids) {
    if (state.queued.has(id)) continue;
    state.queued.add(id);
    state.downloadQueue = state.downloadQueue.then(async () => {
      try {
        // Turned off while it waited in the queue: Arabic's 1.77 GB is not fetched for nobody.
        if (!wantedDownloads(state.settings.enabledLanguages).includes(id)) return;
        if (id === 'uzbek_stt_v1' || id === 'large_v3_turbo') await downloadModel(state, id);
        else await downloadBundle(state, id);
      } catch (error: unknown) {
        diagnosticNote(`downloads: ${id} — ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        state.queued.delete(id);
        await refreshBundles(state);
        await refreshReadiness(state);
      }
    });
  }
  state.push();
}

/**
 * Fetch what the languages that are on need and is not here yet (D-W25): at launch, when
 * onboarding ends (finished or skipped), and whenever the languages change. No question asked —
 * the core is every user's, and an optional language's files are what turning it on means.
 */
function resumeDownloads(state: Shell): void {
  const present = new Set(
    downloadRows(state)
      .filter((row) => row.state.kind === 'installed' || row.state.kind === 'included' || row.state.kind === 'unavailable')
      .map((row) => row.id),
  );
  const ids = launchResume({
    onboardingCompleted: state.settings.onboardingCompleted,
    enabledLanguages: state.settings.enabledLanguages,
    present: (id) => present.has(id),
  }).filter((id) => !state.queued.has(id));
  if (ids.length === 0) return;
  diagnosticNote(`downloads: fetching ${ids.join(', ')}`);
  startDownloads(state, ids);
}

/** Record a yes. Written before the download starts, so a quit mid-way resumes next launch. */
async function acceptDownloads(
  state: Shell,
  settingsStore: SettingsStore | null,
  ids: readonly AcceptedDownload[],
): Promise<void> {
  const acceptedDownloads = withAccepted(state.settings.acceptedDownloads, ids);
  state.settings =
    (await settingsStore?.update({ acceptedDownloads })) ?? { ...state.settings, acceptedDownloads };
}

function pillFrame(state: Shell, presented: boolean): PillFrame {
  const status = state.controller?.status ?? { kind: 'idle' };
  return {
    state: pillState(status, state.lastRecord),
    presented,
    language: appLanguage(),
    style: resolvePillStyle(state.settings.pillStyle),
    maxMessageWidth: hudMaxMessageWidth(),
  };
}

// ---------------------------------------------------------------------------------
// Always on
// ---------------------------------------------------------------------------------

/** What Quit means, the login entry, and the crash watchdog. See `./lifecycle.ts`. */
interface Lifecycle {
  /** Bring the Run entry and the watchdog in line with the settings. Idempotent. */
  applySettings(settings: Settings): void;
  /** An ordinary quit: hides with Always on, exits without. */
  requestQuit(cause: QuitCause): void;
  /** "Turn off Always on and quit" — the one user exit from an always-on Kotiba. */
  quitForReal(): Promise<void>;
  /** Windows is ending the session. */
  sessionEnding(): Promise<void>;
  /** Asked by `before-quit`. */
  mayQuit(): boolean;
}

function createLifecycle(deps: {
  readonly state: Shell;
  readonly mainWindow: BrowserWindow;
  readonly options: LaunchOptions;
  readonly ducker: Ducker;
}): Lifecycle {
  const { state, mainWindow, options } = deps;
  let watchdog: WatchdogHandle | null = null;
  /** Set only by a quit that is allowed to exit. */
  let allowed = false;

  const stopWatchdog = async (): Promise<void> => {
    const running = watchdog;
    watchdog = null;
    await running?.stop();
  };

  const startWatchdogIfWanted = (settings: Settings): void => {
    if (!watchdogWanted(settings, options.check)) {
      void stopWatchdog();
      return;
    }
    if (watchdog !== null) return;
    // Only a PACKAGED app relaunches: a dev run's `process.execPath` is a bare Electron,
    // and relaunching it with `--background` would start an empty shell.
    if (!app.isPackaged) {
      diagnosticNote('always-on: the crash watchdog runs only in the installed app');
      return;
    }
    try {
      const directory = localDirectory();
      mkdirSync(directory, { recursive: true });
      const script = join(directory, WATCHDOG_SCRIPT_NAME);
      writeFileSync(script, WATCHDOG_SOURCE, 'utf8');
      watchdog = startWatchdog({
        scriptPath: script,
        statePath: join(directory, WATCHDOG_STATE_NAME),
        executable: process.execPath,
        relaunchArgs: ['--background'],
        watchedPid: process.pid,
        spawnProcess: (command, args, spawnOptions) => spawn(command, [...args], spawnOptions),
      });
    } catch (error: unknown) {
      diagnosticNote(
        `always-on: the crash watchdog would not start — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const exit = async (): Promise<void> => {
    allowed = true;
    // Told BEFORE the process goes, so the watchdog reads a deliberate exit.
    await stopWatchdog();
    app.quit();
  };

  return {
    applySettings(settings: Settings): void {
      // One Run entry, wanted by either setting — always-on starts at login itself.
      reconcileLaunchAtLogin(loginItemWanted(settings, app.isPackaged));
      startWatchdogIfWanted(settings);
    },
    requestQuit(cause: QuitCause): void {
      if (quitDecision({ alwaysOn: state.settings.alwaysOn, cause }) === 'hide') {
        mainWindow.hide();
        return;
      }
      void exit();
    },
    async quitForReal(): Promise<void> {
      state.settings = { ...state.settings, alwaysOn: false };
      try {
        await state.settingsWriter?.({ alwaysOn: false });
      } catch {
        /* the exit still happens; the next launch reads whatever was saved */
      }
      reconcileLaunchAtLogin(loginItemWanted(state.settings, app.isPackaged));
      await exit();
    },
    async sessionEnding(): Promise<void> {
      allowed = true;
      await stopWatchdog();
    },
    mayQuit(): boolean {
      return allowed || quitDecision({ alwaysOn: state.settings.alwaysOn, cause: 'user' }) === 'exit';
    },
  };
}

/**
 * The ONE place a window is opened.
 *
 * `--background` and `--check` must genuinely not open one, and putting the check here
 * makes that a property of the code rather than a promise about the call sites.
 */
export function openWindow(window: BrowserWindow, options: LaunchOptions, tab?: string): void {
  if (!mayOpenWindows({ ...options, background: false })) return;
  if (tab !== undefined) window.webContents.send(IPC_SEND.showTab, tab);
  window.show();
  window.focus();
}

async function dispatch(
  action: MenuAction,
  state: Shell,
  mainWindow: BrowserWindow,
  options: LaunchOptions,
  lifecycle: Lifecycle,
): Promise<void> {
  switch (action.kind) {
    case 'openMain':
      openWindow(mainWindow, options, 'home');
      return;
    case 'copyLast':
      // Clobbers the clipboard with no restore, exactly as macOS's does.
      if (state.lastTranscript !== null) clipboard.writeText(state.lastTranscript);
      return;
    case 'showBlocker':
      // The blocker's sentence and its Fix button live on Home.
      openWindow(mainWindow, options, 'home');
      return;
    case 'clearPickedMode':
      state.controller?.clearPickedMode();
      await refreshReadiness(state);
      return;
    case 'setMode':
      // Pins: sets the pick AND the persisted default, which is the tray's behaviour.
      await state.controller?.setMode(action.key);
      state.settings = { ...state.settings, defaultModeKey: action.key };
      await refreshReadiness(state);
      return;
    case 'setPinnedLanguage':
      // `null` is a real persisted choice, not "unset".
      await state.controller?.setPinnedLanguage(action.language);
      state.settings = { ...state.settings, pinnedLanguage: action.language };
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_SEND.settingsChanged, state.settings);
      state.push();
      return;
    case 'openHistory':
      openWindow(mainWindow, options, 'history');
      return;
    case 'openSettings':
      openWindow(mainWindow, options, 'settings');
      return;
    case 'quit':
      lifecycle.requestQuit('user');
      return;
    case 'quitForReal':
      await lifecycle.quitForReal();
      return;
  }
}

function registerIpc(deps: {
  readonly state: Shell;
  readonly settingsStore: SettingsStore | null;
  readonly secrets: SecretStore | null;
  readonly history: HistoryStore | null;
  readonly diagnostics: DiagnosticsSink | null;
  readonly models: ModelStore;
  readonly mainWindow: BrowserWindow;
  readonly lifecycle: Lifecycle;
}): void {
  const { state, settingsStore, secrets, history, diagnostics, models, mainWindow, lifecycle } = deps;
  const settingsWindow = mainWindow;

  const secretPresent = (): Promise<boolean> => secretIsPresent(secrets, state.settings.polishKeyAccount);

  ipcMain.handle(IPC_INVOKE.settingsGet, async () => ({
    settings: state.settings,
    loadFailure: settingsStore?.loadFailure ?? null,
    secretPresent: await secretPresent(),
  }));

  /**
   * ONE KEY, WRITTEN AND SAVED IMMEDIATELY.
   *
   * There is deliberately no write-the-whole-form channel: thirteen of twenty-one macOS
   * controls once relied on window-close and lost data on quit, and a `settings:write-all`
   * is exactly how that regression comes back.
   */
  ipcMain.handle(IPC_INVOKE.settingsSet, async (_event, payload: unknown) => {
    const write = payload as { key?: unknown; value?: unknown };
    const key = write.key;
    if (typeof key !== 'string' || !(SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new Error(`settings: ${String(key)} is not a setting`);
    }
    let patch = { [key]: write.value } as Partial<Settings>;
    if (key === 'enabledLanguages') {
      // At least one language stays on (the page disables the last toggle; this refuses too),
      // and a language turned off cannot stay pinned or be the fallback — a press would go to a
      // language the user just said they do not dictate in (the Mac's `setLanguage`).
      const wanted = Array.isArray(write.value) ? write.value.filter(isLanguage) : [];
      if (wanted.length === 0) return state.settings;
      const settled = settleLanguages({ ...state.settings, enabledLanguages: wanted });
      patch = {
        enabledLanguages: settled.enabledLanguages,
        pinnedLanguage: settled.pinnedLanguage,
        defaultLanguage: settled.defaultLanguage,
      };
    }
    state.settings = (await settingsStore?.update(patch)) ?? { ...state.settings, ...patch };
    // The interface language: everything main words — tray, tooltip, blockers, pill — is
    // re-worded by the `state.push()` below, and the pages re-render from `settingsChanged`.
    if (key === 'appLanguage') applyInterfaceLanguage(state.settings.appLanguage);
    if (key === 'launchAtLogin' || key === 'alwaysOn') lifecycle.applySettings(state.settings);
    if (key === 'enabledLanguages' && !state.settings.enabledLanguages.includes('ar')) {
      // Arabic's own modes model goes with Arabic (the engines are released by the manager).
      await state.onDevice?.arabicModes.unload().catch(() => undefined);
    }
    // D-W25: a language turned on brings everything it needs — Turkish whisper turbo; Arabic
    // Cohere, turbo and Gemma — now, with its progress on the page. (Before onboarding is over
    // this queues nothing; onboarding's own languages step starts them.)
    if (key === 'enabledLanguages') resumeDownloads(state);
    // The Arabic engine reads these live; a change may mean a different engine now.
    if (key === 'arabicEngine' || key === 'whisperUseGPU' || key === 'enabledLanguages') state.onDevice?.arabic?.reconsider();
    await state.controller?.settingsChanged();
    // `defaultModeKey`, `fastEnglish`, `enabledLanguages` and the three model paths all
    // reach here, and every one of them changes what the tray and the HUD should say. The
    // shell used to keep its own copy of the mode, so a change made in Settings › Modes
    // left the tray showing the previous one.
    await refreshReadiness(state);
    settingsWindow.webContents.send(IPC_SEND.settingsChanged, state.settings);
    state.push();
    return state.settings;
  });

  ipcMain.handle(IPC_INVOKE.secretGet, () => secretPresent());
  ipcMain.handle(IPC_INVOKE.secretSet, async (_event, value: unknown) => {
    await secrets?.set(state.settings.polishKeyAccount, String(value));
    return secretPresent();
  });
  ipcMain.handle(IPC_INVOKE.secretRemove, async () => {
    // A failed delete is surfaced, never swallowed: a key that looks deleted and is not
    // keeps sending text to the endpoint. The throw reaches the pane and is shown in red.
    await secrets?.remove(state.settings.polishKeyAccount);
    return secretPresent();
  });

  ipcMain.handle(IPC_INVOKE.blockersGet, () => ({ blockers: allBlockers(state, downloadRows(state)) }));
  ipcMain.handle(IPC_INVOKE.recheck, async () => {
    // The expensive one, as macOS's "Check again" is: it re-warms the microphone and
    // re-prepares the engines rather than only recomputing the list.
    await state.controller?.recheck();
    await refreshReadiness(state);
    return { blockers: allBlockers(state, downloadRows(state)) };
  });

  // ---- models ---------------------------------------------------------------------
  //
  // The Languages pane asks for all four slots at once rather than one call per slot:
  // each answer needs a stat and four magic bytes, and four round trips on every render
  // of a pane the user is scrolling is four times the work for the same picture.

  const ROLE_SETTING: Readonly<Record<ModelRole, keyof Settings>> = {
    uzbek: 'uzbekModelPath',
    russian: 'russianModelPath',
    detector: 'detectorModelPath',
    // Fast English has no path setting of its own — it is fetched into the models
    // directory and found by auto-discovery. Reported against the Uzbek key would be
    // wrong, so it names its own and the write path refuses it below.
    fastEnglish: 'fastEnglish',
  };

  // `ROLE_FOR_MODEL` is `./engine-wiring.ts`'s, shared with the engine wiring rather
  // than declared twice: which slot a catalogue model fills is one fact.

  /** Last download failure PER SLOT. macOS shares one string across both downloads. */
  const downloadErrors: Partial<Record<ModelRole, string>> = {};

  const slotFor = async (role: ModelRole): Promise<ModelSlotState> => {
    const configured = String(state.settings[ROLE_SETTING[role]] ?? '');
    const resolved = await models.resolve(role, state.settings);
    // Readiness is the four magic bytes and an 8 MiB floor, NOT existence: a truncated
    // download must read as broken rather than showing a green tick and clearing the
    // blocker, with the user's only feedback a multi-second load failure per launch.
    const inspection = await models.inspect(resolved ?? configured);
    return {
      role,
      configuredPath: configured,
      resolvedPath: resolved,
      inspection,
      downloading: state.downloading !== null,
      error: downloadErrors[role] ?? null,
    };
  };

  ipcMain.handle(IPC_INVOKE.modelsInspect, async (): Promise<ModelReport> => {
    const slots = await Promise.all(MODEL_ROLES.map(slotFor));
    const statuses = Object.fromEntries(
      await Promise.all(MODEL_IDS.map(async (id) => [id, await models.status(id)] as const)),
    ) as Record<ModelId, ModelStatus>;
    const uzbek = slots.find((slot) => slot.role === 'uzbek');
    const detector = slots.find((slot) => slot.role === 'detector');
    // ONE WRITER for `availableLanguages`, and it is not this handler. It used to compute
    // its own answer here and assign it, which made a pane that happened to be open the
    // only thing that ever refreshed the tray's language list.
    await refreshReadiness(state);
    return {
      slots,
      statuses,
      autoDetectReady: autoDetectReady({
        settings: state.settings,
        detectorPath: detector?.inspection.status === 'ready' ? detector.inspection.path : null,
        uzbekPath: uzbek?.inspection.status === 'ready' ? uzbek.inspection.path : null,
      }),
      availableLanguages: state.availableLanguages,
    };
  });

  ipcMain.handle(IPC_INVOKE.modelsDownload, async (_event, id: unknown) => {
    const modelId = id as ModelId;
    const spec = MODEL_CATALOGUE[modelId];
    if (spec === undefined) throw new Error(`models: ${String(id)} is not a model`);
    if (state.downloading !== null) {
      // macOS refuses a second concurrent download with this exact sentence.
      throw new Error('another download is already running');
    }
    const role = ROLE_FOR_MODEL[modelId];

    // INPUT 3 OF THE TRAY ICON'S FOUR: a download is a readiness state, and the icon
    // goes solid for it even though nobody has pressed anything.
    state.downloading = spec.name;
    state.push();
    try {
      const path = await models.ensure(modelId);
      delete downloadErrors[role];
      // The successful path is written into the setting — the one place discovery and
      // configuration meet. Fast English has no path key and is found by discovery.
      const key = ROLE_SETTING[role];
      if (key !== 'fastEnglish') {
        state.settings =
          (await settingsStore?.update({ [key]: path } as Partial<Settings>)) ?? state.settings;
      }
      return path;
    } catch (error: unknown) {
      // macOS keeps ONE shared error string and renders it under the Russian heading
      // whatever failed — a failed DETECTOR download surfaces its message beneath the
      // Russian model. That is a bug worth not copying: each slot keeps its own.
      downloadErrors[role] = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      state.downloading = null;
      // A finished download is the single most likely reason a language became available,
      // and it is the case the shell used to learn about only if the pane stayed open.
      await refreshReadiness(state);
    }
  });

  // The first-use bundles: Parakeet (Languages pane) and Qwen (Modes pane). Validated
  // against the catalogue: the renderer names a bundle, it never names a URL.
  ipcMain.handle(IPC_INVOKE.onDeviceDownload, async (_event, id: unknown) => {
    if (!(BUNDLE_IDS as readonly unknown[]).includes(id)) throw new Error(`models: ${String(id)} is not a bundle`);
    // A Download button is a yes, and is remembered as one: a quit half-way resumes.
    // FastConformer is Arabic's second engine: the Arabic yes covers it (`cohere_arabic`).
    const [accepted] = parseDownloadIds([id === 'fastconformer_ar' ? 'cohere_arabic' : id]);
    if (accepted !== undefined) await acceptDownloads(state, settingsStore, [accepted]);
    await downloadBundle(state, id as BundleId);
    await refreshBundles(state);
    await refreshReadiness(state);
  });

  // Start these now: onboarding's languages step (everything the chosen languages need — the
  // core included — so it is under way while setup finishes), a row's Download / Try again, and
  // the readiness card's Try again. Remembered, then queued; progress shows wherever rows are drawn.
  ipcMain.handle(IPC_INVOKE.downloadsAccept, async (_event, payload: unknown) => {
    const ids = parseDownloadIds(payload);
    if (ids.length === 0) return;
    await acceptDownloads(state, settingsStore, ids);
    startDownloads(state, ids);
    state.push();
  });

  // A language that is off: what removing its model files would free, and the removal itself
  // (the Mac's `removableModelBytes` / `removeModelFiles`). Only files in Kotiba's own models
  // directory, and only those no language that is on still uses (`removableModelFiles`). The
  // page confirms in place before asking.
  ipcMain.handle(IPC_INVOKE.languageRemovable, async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const language of LANGUAGES) {
      let total = 0;
      for (const path of languageFilePaths(state, language)) total += await bytesAt(path);
      out[language] = total;
    }
    return out;
  });
  ipcMain.handle(IPC_INVOKE.languageRemoveModels, async (_event, language: unknown) => {
    if (!isLanguage(language)) throw new Error(`models: ${String(language)} is not a language`);
    const paths = languageFilePaths(state, language);
    if (paths.length === 0) return;
    // Let go of them first: an engine holding a file open keeps Windows from deleting it.
    await state.controller?.settingsChanged();
    if (language === 'ar') await state.onDevice?.arabicModes.unload().catch(() => undefined);
    for (const path of paths) {
      try {
        await rm(path, { recursive: true, force: true });
        diagnosticNote(`models: removed ${path} (${language} is off)`);
      } catch (error: unknown) {
        throw new Error(`could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await refreshBundles(state);
    await refreshModelRows(state);
    await refreshReadiness(state);
    state.push();
  });

  ipcMain.handle(IPC_INVOKE.modesList, () =>
    Object.values(state.modes).map((mode) => ({
      key: mode.key,
      name: mode.name,
      polishes: mode.prompt !== null,
      activationApps: mode.activationApps,
    })),
  );

  ipcMain.handle(IPC_INVOKE.historyRecent, async () => ({
    entries: (await history?.recent(100)) ?? [],
    searched: false,
  }));
  ipcMain.handle(IPC_INVOKE.historySearch, async (_event, query: unknown) => {
    const text = String(query ?? '');
    if (text.length === 0) return { entries: (await history?.recent(100)) ?? [], searched: false };
    return { entries: (await history?.search(text, 100)) ?? [], searched: true };
  });
  ipcMain.handle(IPC_INVOKE.historyDelete, async (_event, id: unknown) => {
    await history?.delete(String(id));
  });
  ipcMain.handle(IPC_INVOKE.historyCopy, (_event, text: unknown) => {
    clipboard.writeText(String(text));
  });

  ipcMain.handle(IPC_INVOKE.diagnosticsSummary, async () => {
    if (!state.settings.diagnosticsEnabled) {
      return t('diag.off');
    }
    try {
      return (await diagnostics?.summary(40)) ?? t('diag.cannotOpen');
    } catch (error: unknown) {
      return t('diag.cannotRead', { why: error instanceof Error ? error.message : String(error) });
    }
  });
  ipcMain.handle(IPC_INVOKE.diagnosticsReveal, () => shell.openPath(localDirectory()));

  /**
   * Onboarding finished or skipped. Always on arrives pre-set ON from the page and is
   * written HERE, with the flag, as the Mac writes both on finish — never earlier, so a
   * user who quits mid-setup has not been signed up for a watchdog.
   */
  ipcMain.handle(IPC_INVOKE.onboardingDone, async (_event, payload: unknown) => {
    const alwaysOn = (payload as { alwaysOn?: unknown } | null)?.alwaysOn;
    const patch: Partial<Settings> =
      typeof alwaysOn === 'boolean' ? { onboardingCompleted: true, alwaysOn } : { onboardingCompleted: true };
    state.settings = (await settingsStore?.update(patch)) ?? { ...state.settings, ...patch };
    lifecycle.applySettings(state.settings);
    // D-W25: finished or skipped, the core (and any optional language that is on) starts now —
    // the "Getting Kotiba ready" card on Home shows it.
    resumeDownloads(state);
    await state.controller?.settingsChanged();
    await state.controller?.recheck();
    mainWindow.webContents.send(IPC_SEND.settingsChanged, state.settings);
    state.push();
  });

  ipcMain.handle(IPC_INVOKE.onboardingRestart, async () => {
    state.settings =
      (await settingsStore?.update({ onboardingCompleted: false })) ?? { ...state.settings, onboardingCompleted: false };
    mainWindow.webContents.send(IPC_SEND.settingsChanged, state.settings);
  });

  ipcMain.handle(IPC_INVOKE.hudSnapshot, () => pillFrame(state, true));

  ipcMain.handle(IPC_INVOKE.appSnapshot, () => appSnapshot(state));

  ipcMain.handle(IPC_INVOKE.usageRecords, async () => {
    try {
      return (await diagnostics?.records()) ?? [];
    } catch {
      return [];
    }
  });

  // ---- mode and language, from the window (the tray's semantics, and the fallback's)
  ipcMain.handle(IPC_INVOKE.modeSet, async (_event, key: unknown) => {
    await state.controller?.setMode(String(key));
    state.settings = settingsStore?.current() ?? { ...state.settings, defaultModeKey: String(key) };
    await refreshReadiness(state);
  });
  ipcMain.handle(IPC_INVOKE.modeClear, async () => {
    state.controller?.clearPickedMode();
    await refreshReadiness(state);
  });
  ipcMain.handle(IPC_INVOKE.modeDefault, async (_event, key: unknown) => {
    // The FALLBACK only. Never `setMode`, which would pin and silently switch off
    // app-following behind its own toggle.
    await state.controller?.setDefaultMode(String(key));
    state.settings = settingsStore?.current() ?? { ...state.settings, defaultModeKey: String(key) };
    mainWindow.webContents.send(IPC_SEND.settingsChanged, state.settings);
    await refreshReadiness(state);
  });
  ipcMain.handle(IPC_INVOKE.languagePin, async (_event, language: unknown) => {
    // A known language — and an optional one only while it is turned on (C4).
    const pin =
      isLanguage(language) && state.settings.enabledLanguages.includes(language)
        ? language
        : null;
    await state.controller?.setPinnedLanguage(pin);
    state.settings = { ...state.settings, pinnedLanguage: pin };
    mainWindow.webContents.send(IPC_SEND.settingsChanged, state.settings);
    await refreshReadiness(state);
  });

  // ---- the hotkey recorder: fed by the hook, so it records exactly what the hook sees
  //
  // RECORDING IS A MODE THE WHOLE MACHINE IS IN: while it is open every key goes to the
  // recorder and push-to-talk is off. So it ends with the window — hidden, closed or left
  // for another app — and on its own after half a minute, and the page is told. Left
  // armed behind a hidden window, the next lone modifier pressed anywhere became the new
  // hotkey and dictation was dead until then.
  let recordingTimer: NodeJS.Timeout | null = null;
  const endRecording = (tellPage: boolean): void => {
    if (recordingTimer === null) return;
    clearTimeout(recordingTimer);
    recordingTimer = null;
    state.hotkey?.stopRecording();
    if (tellPage && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_SEND.hotkeyRecording, { kind: 'cancelled' });
    }
  };
  ipcMain.handle(IPC_INVOKE.hotkeyRecordStart, () => {
    endRecording(false);
    recordingTimer = setTimeout(() => endRecording(true), HOTKEY_RECORDING_TIMEOUT_MS);
    state.hotkey?.startRecording((result) => {
      if (result.kind === 'recorded' || result.kind === 'cancelled') {
        if (recordingTimer !== null) clearTimeout(recordingTimer);
        recordingTimer = null;
      }
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_SEND.hotkeyRecording, result);
    });
  });
  ipcMain.handle(IPC_INVOKE.hotkeyRecordStop, () => {
    endRecording(false);
  });
  mainWindow.on('hide', () => endRecording(true));
  mainWindow.on('blur', () => endRecording(true));

  // ---- quitting ---------------------------------------------------------------------
  ipcMain.handle(IPC_INVOKE.quit, () => lifecycle.requestQuit('user'));
  ipcMain.handle(IPC_INVOKE.quitForReal, () => lifecycle.quitForReal());

  ipcMain.handle(IPC_INVOKE.openMicrophoneSettings, () =>
    shell.openExternal('ms-settings:privacy-microphone'),
  );
  // The quiet-microphone notice: a fixed address, never one the page names.
  ipcMain.handle(IPC_INVOKE.openSoundSettings, () => shell.openExternal(SOUND_SETTINGS_URI));
  ipcMain.handle(IPC_INVOKE.quietMicDismiss, () => {
    state.controller?.dismissQuietMic();
    state.push();
  });

  // The About card's links. EXACT membership in the allow-list, checked here in main — the
  // renderer's own check is a convenience, this one is the boundary. A refusal throws, so a
  // page that asked for something else sees the failure rather than a silent nothing.
  ipcMain.handle(IPC_INVOKE.openExternal, async (_event, url: unknown) => {
    if (!isAllowedExternalLink(url)) throw new Error('links: that address is not one Kotiba opens');
    await shell.openExternal(url);
  });
  ipcMain.handle(IPC_INVOKE.appVersion, () => app.getVersion());
}

/**
 * The hidden renderer's channel (D-W6): the level to the pill and the window, and a
 * capture failure turned into a BLOCKER rather than a silently dead microphone.
 */
function wireAudioChannel(audioWindow: BrowserWindow, state: Shell, hud: BrowserWindow): void {
  const showLevel = (peak: unknown): void => {
    state.level = typeof peak === 'number' ? peak : 0;
    if (!hud.isDestroyed()) hud.webContents.send(IPC_SEND.levelChanged, state.level);
    state.levelSink?.(state.level);
  };
  ipcMain.on(IPC_AUDIO.event, (_event, payload: unknown) => {
    const message = payload as { kind?: unknown; peak?: unknown; why?: unknown };
    if (message.kind === 'level') {
      showLevel(message.peak);
      return;
    }
    // A device change or a stream that ended is NOT a blocker: the capture module drops
    // `isWarm` and rebuilds the graph on the next press. It is worth a line in the log.
    if (message.kind === 'deviceChanged' || message.kind === 'streamEnded') {
      diagnosticNote(`audio: ${String(message.kind)} — ${String(message.why ?? '')}`);
    }
  });
  ipcMain.on(IPC_AUDIO.peak, (_event, peak: unknown) => {
    showLevel(peak);
  });
  ipcMain.on(IPC_AUDIO.failed, (_event, reason: unknown) => {
    if (!state.blockers.some((blocker) => blocker.id === 'microphone')) {
      state.blockers.push({
        id: 'microphone',
        headline: t('blk.the_microphone_is_not_ready'),
        detail: String(reason),
      });
    }
    state.push();
  });
  audioWindow.on('closed', () => {
    // The microphone IS a window here. If it goes, say so.
    state.blockers.push({
      id: 'microphone',
      headline: t('blk.the_microphone_stopped'),
      detail: t('blk.the_audio_process_closed_unexpectedly_quit'),
    });
    state.push();
  });
}

// ---------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------
//
// `package.json` names `dist/src/main/index.js` as `main` and is frozen (t01 only), so
// this module is both the composition root and the thing Electron runs. The guard is
// what keeps `import`ing it from a test harmless: outside Electron there is no
// `process.versions.electron`, so nothing starts.

if (process.versions.electron !== undefined) {
  void main();
}
