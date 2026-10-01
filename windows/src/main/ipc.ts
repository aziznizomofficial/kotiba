// The main↔renderer wire: channel names and payload types. PURE — the types are shared
// by both sides, so this file may import neither `electron` nor `node:*`.
//
// Four renderers talk to main, and they are not the same conversation:
//
//   settings     reads a snapshot, writes ONE key at a time, listens for changes
//   onboarding   reads the bound hotkey, writes `onboardingCompleted` once
//   hud          listens only — it has no controls and never sends anything
//   audio        the hidden window (D-W6): posts PCM frames and peaks to main
//
// EVERY SETTINGS WRITE IS ONE KEY AND IS PERSISTED IMMEDIATELY. There is no "save the
// form" channel, because there is no form: thirteen of twenty-one macOS controls once
// relied on window-close and lost data on quit. A `settings:write-all` channel is how
// that regression gets reintroduced, so it does not exist.

import type {
  Blocker,
  BundleState,
  DictationRecord,
  DictationStatus,
  HistoryEntry,
  InputDeviceInfo,
  Language,
  ModelId,
  ModelInspection,
  ModelStatus,
  Settings,
} from '../contracts/index.js';

import type { DownloadRow } from './downloads-model.js';
import type { ArabicSnapshot } from './languages-model.js';

/** Renderer → main, request/response (`ipcRenderer.invoke`). */
export const IPC_INVOKE = {
  settingsGet: 'settings:get',
  /** ONE key. See the header. */
  settingsSet: 'settings:set',
  secretGet: 'secret:has',
  secretSet: 'secret:set',
  secretRemove: 'secret:remove',
  blockersGet: 'blockers:get',
  recheck: 'blockers:recheck',
  modelsInspect: 'models:inspect',
  modelsDownload: 'models:download',
  /** Fetch a first-use bundle — `parakeet_ultra` or `qwen3_1_7b`. */
  onDeviceDownload: 'ondevice:download',
  /** Onboarding's Download models step: the accepted ids, persisted, then fetched in turn. */
  downloadsAccept: 'downloads:accept',
  historyRecent: 'history:recent',
  historySearch: 'history:search',
  historyDelete: 'history:delete',
  historyCopy: 'history:copy',
  diagnosticsSummary: 'diagnostics:summary',
  diagnosticsReveal: 'diagnostics:reveal',
  modesList: 'modes:list',
  onboardingDone: 'onboarding:done',
  /** The HUD asks for its first frame when it mounts, rather than waiting for a push. */
  hudSnapshot: 'hud:snapshot',
  /** Everything the app window shows about the running app, in one answer. */
  appSnapshot: 'app:snapshot',
  /** The diagnostics log's records — Statistics and the History rows' timings read them. */
  usageRecords: 'usage:records',
  /** The tray's mode pick: sets the in-memory pick AND the persisted default. */
  modeSet: 'mode:set',
  /** Back to Automatic: drops the in-memory pick. */
  modeClear: 'mode:clear',
  /** Modes › Make default: the persisted fallback ONLY — never a pin. */
  modeDefault: 'mode:default',
  /** The language pin. `null` is Automatic, a real choice. */
  languagePin: 'language:pin',
  /** Bytes each language's own model files would free if removed (0 while it is on). */
  languageRemovable: 'language:removable',
  /** Delete the model files only a language that is off uses (confirmed in the page). */
  languageRemoveModels: 'language:remove-models',
  /** "Record new key": the hook reports every transition to the recorder until stopped. */
  hotkeyRecordStart: 'hotkey:record-start',
  hotkeyRecordStop: 'hotkey:record-stop',
  /** Ctrl+Q in the window. Hides with Always on, quits without. */
  quit: 'app:quit',
  /** "Turn off Always on and quit". */
  quitForReal: 'app:quit-for-real',
  /** Settings › Setup › Run again. */
  onboardingRestart: 'onboarding:restart',
  /** Windows' microphone privacy page, for the one permission this app needs. */
  openMicrophoneSettings: 'app:open-microphone-settings',
  /** The quiet-microphone notice's button: Settings › Sound (`ms-settings:sound`), fixed in main. */
  openSoundSettings: 'app:open-sound-settings',
  /** The quiet-microphone notice's ✕. */
  quietMicDismiss: 'quietmic:dismiss',
  /**
   * Open one of the About card's links in the browser. Main opens it only when it is exactly
   * one of `EXTERNAL_LINKS` (`about-model.ts`); anything else is refused, never opened.
   */
  openExternal: 'app:open-external',
  /** The app's version, for Settings › About. */
  appVersion: 'app:version',
} as const;

/** Main → renderer, fire and forget (`webContents.send`). */
export const IPC_SEND = {
  settingsChanged: 'settings:changed',
  statusChanged: 'status:changed',
  blockersChanged: 'blockers:changed',
  levelChanged: 'level:changed',
  downloadProgress: 'models:progress',
  /** The settings window is asked to reveal a specific tab (tray → History…). */
  showTab: 'settings:show-tab',
  /** The hidden audio window is told to start and stop capturing. */
  audioStart: 'audio:start',
  audioStop: 'audio:stop',
  /**
   * One `AudioHostCommand`, with a correlation id (D-W6).
   *
   * `audioStart`/`audioStop` above are fire-and-forget and cannot carry an ANSWER, which
   * is the half `AudioCapture` needs: `warmUp()` has to learn the context's real sample
   * rate, and `stop()` has to come back holding the samples. `src/audio/host.ts` names
   * five commands and four replies for exactly that reason, and this is the channel they
   * cross on. See `IPC_AUDIO.reply`.
   */
  audioCommand: 'audio:command',
  /** The app window's live state, pushed on every change. See `AppSnapshot`. */
  appState: 'app:state',
  /** One `HotkeyRecordingResult` per transition while recording. */
  hotkeyRecording: 'hotkey:recording',
  /** The pill: what to draw and whether it is presented. See `PillFrame`. */
  pillFrame: 'pill:frame',
  /** One `FeedbackEvent` to sound, sent only when Settings › Sound asks for it. */
  feedback: 'feedback:play',
} as const;

/** Hidden audio renderer → main. Kept separate: it is the only high-rate channel. */
export const IPC_AUDIO = {
  frames: 'audio:frames',
  peak: 'audio:peak',
  failed: 'audio:failed',
  ready: 'audio:ready',
  /** One `AudioHostReply`, carrying the id of the `audioCommand` it answers. */
  reply: 'audio:reply',
  /** One unprompted `AudioHostEvent`: a level, a device change, a stream that ended. */
  event: 'audio:event',
} as const;

export type InvokeChannel = (typeof IPC_INVOKE)[keyof typeof IPC_INVOKE];
export type SendChannel = (typeof IPC_SEND)[keyof typeof IPC_SEND];

/** One model slot's state, for a `modelSlot` control. */
export interface ModelSlotState {
  readonly role: string;
  /** The explicit setting, which may be empty even when a model resolves. */
  readonly configuredPath: string;
  /** What auto-discovery found, or `null`. */
  readonly resolvedPath: string | null;
  readonly inspection: ModelInspection;
  /** In flight right now. */
  readonly downloading: boolean;
  /** The last download error for this slot, or `null`. */
  readonly error: string | null;
}

/** A settings write. `key` is checked against `SETTINGS_KEYS` in main before it lands. */
export interface SettingsWrite {
  readonly key: keyof Settings;
  readonly value: unknown;
}

/** What the app window knows about the running app. Pushed whole; it is small. */
export interface AppSnapshot {
  readonly status: DictationStatus;
  readonly blockers: readonly Blocker[];
  readonly lastRecord: DictationRecord | null;
  /** A microphone that barely registered a real hold — Home's "very quiet" notice — or `null`. */
  readonly quietMic: InputDeviceInfo | null;
  readonly lastTranscript: string | null;
  /** `null` is Automatic. */
  readonly userPickedMode: string | null;
  readonly activeModeKey: string;
  readonly pinnedLanguage: Language | null;
  /** Only languages whose model resolves. */
  readonly pinnableLanguages: readonly Language[];
  /** A model being fetched, by name, or `null`. */
  readonly downloading: string | null;
  /** Whether "Turn off Always on and quit" applies. Mirrors the setting. */
  readonly alwaysOn: boolean;
  /** Polish, in words: what will run. */
  readonly polishStatus: string;
  /**
   * The first-use on-device models: Parakeet (English, Russian), Qwen (the modes) and Arabic's
   * own modes model (Gemma 4 E2B, C4 §14.5).
   */
  readonly onDevice: { readonly parakeet: BundleState; readonly modesModel: BundleState; readonly arabicModesModel: BundleState };
  /** Every downloadable model's row — the Languages page and the readiness card draw this. D-W25. */
  readonly downloads: readonly DownloadRow[];
  /** C4: which Arabic engine serves and why; `null` until the engine has reported. */
  readonly arabic: ArabicSnapshot | null;
}

/** What `settings:get` answers. */
export interface SettingsSnapshot {
  readonly settings: Settings;
  /** The salvage sentence from the last load, or `null`. */
  readonly loadFailure: string | null;
  /** True when a key is stored in Credential Manager. The key itself never crosses. */
  readonly secretPresent: boolean;
}

/** One row of Settings › Modes › "What each mode does". */
export interface ModeSummary {
  readonly key: string;
  readonly name: string;
  /** `false` renders the "no AI" badge. Only Raw has it. */
  readonly polishes: boolean;
  readonly activationApps: readonly string[];
}

/** What `models:inspect` answers, for the whole Languages pane at once. */
export interface ModelReport {
  readonly slots: readonly ModelSlotState[];
  readonly statuses: Readonly<Record<ModelId, ModelStatus>>;
  /** Something to detect (more than one engine family on), a detector, and — while Uzbek is on — its model. */
  readonly autoDetectReady: boolean;
  readonly availableLanguages: readonly Language[];
}

/** What the History pane renders. */
export interface HistoryPage {
  readonly entries: readonly HistoryEntry[];
  /** True when the query matched nothing, so the pane can pick its empty state. */
  readonly searched: boolean;
}

export interface BlockerReport {
  readonly blockers: readonly Blocker[];
}

/**
 * The surface `preload.ts` exposes on `window.kotiba`. Declared here so the renderer can
 * type against it without importing anything from main.
 */
export interface KotibaBridge {
  invoke(channel: InvokeChannel, payload?: unknown): Promise<unknown>;
  on(channel: SendChannel, listener: (payload: unknown) => void): () => void;
}
