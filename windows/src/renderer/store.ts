// The app window's state, and the one way it changes.
//
// Everything the pages show comes from four answers main gives — the settings, the app
// snapshot, the diagnostics records and the model report — and each is refreshed by a
// push rather than polled. A page does not re-render when one changes: every control
// registers an updater for the thing it shows, and the updater changes that control in
// place. That is what lets a switch finish its spring while the setting it wrote comes
// back from main, instead of being torn down and redrawn mid-flight.

import type { DictationRecord, HistoryEntry, Settings } from '../contracts/index.js';
import { DEFAULT_SETTINGS } from '../contracts/index.js';
import type { AppSnapshot, ModeSummary, ModelReport, SettingsSnapshot } from '../main/ipc.js';
import { IPC_INVOKE, IPC_SEND } from '../main/ipc.js';
import type { PillAnimationStyle } from '../main/pill-model.js';
import { resolvePillStyle } from '../main/pill-model.js';

import { invoke, on } from './bridge.js';

export type Topic = 'settings' | 'app' | 'records' | 'models' | 'history' | 'level';

const EMPTY_APP: AppSnapshot = {
  status: { kind: 'idle' },
  blockers: [],
  lastRecord: null,
  quietMic: null,
  lastTranscript: null,
  userPickedMode: null,
  activeModeKey: 'super',
  pinnedLanguage: null,
  pinnableLanguages: ['en'],
  downloading: null,
  alwaysOn: false,
  polishStatus: '',
  onDevice: { parakeet: { kind: 'notDownloaded' }, modesModel: { kind: 'notDownloaded' }, arabicModesModel: { kind: 'notDownloaded' } },
  downloads: [],
  arabic: null,
};

class Store {
  settings: Settings = DEFAULT_SETTINGS;
  secretPresent = false;
  loadFailure: string | null = null;
  app: AppSnapshot = EMPTY_APP;
  records: DictationRecord[] = [];
  recordsLoaded = false;
  models: ModelReport | null = null;
  modes: readonly ModeSummary[] = [];
  history: readonly HistoryEntry[] = [];
  level = 0;
  readonly #listeners = new Map<Topic, Set<() => void>>();

  subscribe(topic: Topic, listener: () => void): () => void {
    const set = this.#listeners.get(topic) ?? new Set();
    set.add(listener);
    this.#listeners.set(topic, set);
    return () => set.delete(listener);
  }

  emit(topic: Topic): void {
    for (const listener of [...(this.#listeners.get(topic) ?? [])]) {
      try {
        listener();
      } catch (error) {
        console.error('kotiba: a view updater threw', error);
      }
    }
  }

  /** ONE key, written and saved immediately — there is no "save the form". */
  async write<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    // Optimistic: the control already shows the new value; the answer confirms it.
    this.settings = { ...this.settings, [key]: value };
    this.emit('settings');
    try {
      this.settings = await invoke<Settings>(IPC_INVOKE.settingsSet, { key, value });
    } catch (error: unknown) {
      // Refused: put back what main really holds, so the control does not keep showing a
      // value that was never saved.
      try {
        this.settings = (await invoke<SettingsSnapshot>(IPC_INVOKE.settingsGet)).settings;
      } catch {
        /* the next push corrects it */
      }
      throw error;
    } finally {
      this.emit('settings');
    }
  }

  async load(): Promise<void> {
    const [snapshot, app, modes] = await Promise.all([
      invoke<SettingsSnapshot>(IPC_INVOKE.settingsGet),
      invoke<AppSnapshot>(IPC_INVOKE.appSnapshot),
      invoke<readonly ModeSummary[]>(IPC_INVOKE.modesList),
    ]);
    this.settings = snapshot.settings;
    this.secretPresent = snapshot.secretPresent;
    this.loadFailure = snapshot.loadFailure;
    this.app = app;
    this.modes = modes;
    this.emit('settings');
    this.emit('app');
    void this.reloadRecords();
    void this.reloadModels();
    void this.reloadHistory();
  }

  async reloadRecords(): Promise<void> {
    try {
      this.records = [...(await invoke<readonly DictationRecord[]>(IPC_INVOKE.usageRecords))];
    } catch {
      this.records = [];
    }
    this.recordsLoaded = true;
    this.emit('records');
  }

  async reloadModels(): Promise<void> {
    try {
      this.models = await invoke<ModelReport>(IPC_INVOKE.modelsInspect);
    } catch {
      /* the previous report stands */
    }
    this.emit('models');
  }

  async reloadHistory(): Promise<void> {
    try {
      const page = await invoke<{ entries: readonly HistoryEntry[] }>(IPC_INVOKE.historyRecent);
      this.history = page.entries;
    } catch {
      this.history = [];
    }
    this.emit('history');
  }

  /** Fold in a record the controller has just finished, without waiting for the file. */
  include(record: DictationRecord | null): void {
    if (record === null) return;
    // Start times are whole seconds, and two overlapping dictations can share one.
    const same = (each: DictationRecord): boolean =>
      each.startedAt === record.startedAt && each.result === record.result && each.outcome === record.outcome;
    if (this.records.some(same)) return;
    this.records = [...this.records, record];
    this.emit('records');
  }

  listen(): void {
    on<Settings>(IPC_SEND.settingsChanged, (settings) => {
      this.settings = settings;
      this.emit('settings');
    });
    on<AppSnapshot>(IPC_SEND.appState, (app) => {
      // Compared by start time: every push is a fresh structured clone, so identity would
      // call every status change a new dictation.
      const key = (record: AppSnapshot['lastRecord']): string | null =>
        record === null ? null : `${record.startedAt}|${record.outcome}|${record.result ?? ''}`;
      const previous = key(this.app.lastRecord);
      this.app = app;
      this.emit('app');
      if (app.lastRecord !== null && key(app.lastRecord) !== previous) {
        this.include(app.lastRecord);
        // A finished dictation is new history.
        void this.reloadHistory();
      }
    });
    on<number>(IPC_SEND.levelChanged, (level) => {
      this.level = level;
      this.emit('level');
    });
  }
}

export const store = new Store();

/** The `pillStyle` setting as the store holds it — what every pill in the window draws, live. */
export const livePillStyle = (): PillAnimationStyle => resolvePillStyle(store.settings.pillStyle);

/**
 * A page's subscriptions, dropped together when the page goes. Every updater a control
 * registers goes through one, so a page that is gone cannot be updated into.
 */
export class Scope {
  readonly #drops: (() => void)[] = [];

  watch(topics: readonly Topic[], update: () => void, immediately = true): void {
    for (const topic of topics) this.#drops.push(store.subscribe(topic, update));
    if (immediately) update();
  }

  add(drop: () => void): void {
    this.#drops.push(drop);
  }

  dispose(): void {
    for (const drop of this.#drops.splice(0)) drop();
  }
}
