// Fakes for every seam the session drives.
//
// The whole reason `src/session` is written against interfaces is so that this file can
// exist: nine modules, none of them built, and a full dictation runs in a millisecond.
// Nothing here reads a file, spawns a process or opens a device.

import {
  DEFAULT_SETTINGS,
  SAMPLE_RATE,
  engineFamilyFor,
} from '../../src/contracts/index.js';
import type {
  AcousticClassifier,
  AppId,
  AudioBuffer,
  AudioCapture,
  AudioTake,
  AudioTakeOptions,
  BuiltInModeTable,
  DictationRecord,
  DiagnosticsSink,
  EngineFamily,
  EngineReadiness,
  FocusSource,
  ForegroundApp,
  HistoryEntry,
  HistoryStore,
  HotkeyBinding,
  HotkeyEvent,
  HotkeySource,
  HotkeyRecordingResult,
  Inserter,
  InsertionOutcome,
  Language,
  LanguageRouter,
  Mode,
  ModeKey,
  ModelDownloadProgress,
  ModelId,
  ModelInspection,
  ModelRole,
  ModelStatus,
  ModelStore,
  Polisher,
  PolishRejection,
  PromptContext,
  RouteDecision,
  RouteVerdict,
  SecretStore,
  Settings,
  SettingsLoad,
  SettingsStore,
  SttEngine,
  TranscriptResult,
  EngineManager,
  Unsubscribe,
} from '../../src/contracts/index.js';
import { readsAsEnglish, transcriptDoubt } from '../../src/core/routing/index.js';
import type { Capitaliser, Clock, SessionPorts } from '../../src/session/index.js';

// ---------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------

/** A buffer of `seconds` at a constant magnitude. `peak` drives both silence gates. */
export function tone(seconds: number, peak: number, droppedSamples = 0): AudioBuffer {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i += 1) samples[i] = i % 2 === 0 ? peak : -peak;
  return { samples, droppedSamples };
}

export const SPEECH = tone(2, 0.4);
/** The 7.4 s silent recording from the brief. Peak 0.001, well under the 0.012 gate. */
export const SILENCE_7_4 = tone(7.4, 0.001);
export const NO_AUDIO: AudioBuffer = { samples: new Float32Array(0), droppedSamples: 0 };

export class FakeAudio implements AudioCapture {
  buffer: AudioBuffer = SPEECH;
  startDelayMs = 0;
  startError: Error | null = null;
  stopError: Error | null = null;
  starts = 0;
  stops = 0;
  warmUps = 0;
  isWarm = true;
  lastWarmUpError: string | null = null;
  warmUpNeedsTheUser: boolean | undefined = undefined;
  /** Set by `start()`, cleared by `stop()`. A leaked capture is a leaked microphone. */
  capturing = false;

  constructor(private readonly clock?: Clock) {}

  async warmUp(): Promise<void> {
    this.warmUps += 1;
  }

  async start(): Promise<void> {
    this.starts += 1;
    if (this.startDelayMs > 0 && this.clock !== undefined) {
      await this.clock.sleep(this.startDelayMs).promise;
    }
    if (this.startError !== null) throw this.startError;
    this.capturing = true;
  }

  async stop(): Promise<AudioBuffer> {
    this.stops += 1;
    if (this.stopError !== null) throw this.stopError;
    this.capturing = false;
    return this.buffer;
  }

  currentPeak(): number {
    return 0;
  }

  /** Every take handed out, in press order. Each one replays `buffer` unless given its own. */
  readonly takes: FakeTake[] = [];
  /** Queue per-take buffers: the Nth take gets the Nth, then `buffer` again. */
  readonly takeBuffers: AudioBuffer[] = [];

  openTake(options: AudioTakeOptions = {}): AudioTake {
    const take = new FakeTake(this, this.takeBuffers.shift() ?? this.buffer, options);
    this.takes.push(take);
    return take;
  }

  async dispose(): Promise<void> {}
}

/** One press's audio, from `FakeAudio`. Counts through the parent so old assertions hold. */
export class FakeTake implements AudioTake {
  capturing = false;
  constructor(
    private readonly parent: FakeAudio,
    readonly buffer: AudioBuffer,
    readonly options: AudioTakeOptions,
  ) {}
  async start(): Promise<void> {
    await this.parent.start();
    this.capturing = true;
  }
  async stop(): Promise<AudioBuffer> {
    this.parent.stops += 1;
    if (this.parent.stopError !== null) throw this.parent.stopError;
    this.parent.capturing = false;
    this.capturing = false;
    return this.buffer;
  }
  onChunk(): () => void {
    return () => undefined;
  }
}

// ---------------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------------

export class FakeEngine implements SttEngine {
  ready = true;
  prepareCalls = 0;
  transcribeCalls = 0;
  prepareError: Error | null = null;
  transcribeError: Error | null = null;
  /** A prepare that succeeds and leaves the engine cold. The wrapper that lies. */
  prepareLeavesCold = false;
  text = 'hello world';
  delayMs = 0;

  constructor(
    readonly engineId: string,
    readonly supportedLanguages: ReadonlySet<Language>,
    private readonly clock?: Clock,
  ) {}

  async isReady(): Promise<boolean> {
    return this.ready;
  }

  async prepare(): Promise<void> {
    this.prepareCalls += 1;
    if (this.prepareError !== null) throw this.prepareError;
    if (!this.prepareLeavesCold) this.ready = true;
  }

  /**
   * Per-call answers, consumed in call order — overlapping dictations each get their own
   * text and their own transcription time. Empty means `text` / `delayMs`.
   */
  readonly script: { readonly text: string; readonly delayMs: number }[] = [];

  /** The abort signal the last `transcribe` was handed, if any. */
  lastSignal: AbortSignal | undefined = undefined;

  async transcribe(_audio: AudioBuffer, language: Language, signal?: AbortSignal): Promise<TranscriptResult> {
    this.transcribeCalls += 1;
    this.lastSignal = signal;
    const scripted = this.script.shift();
    const text = scripted?.text ?? this.text;
    const delayMs = scripted?.delayMs ?? this.delayMs;
    if (delayMs > 0 && this.clock !== undefined) {
      await this.clock.sleep(delayMs).promise;
    }
    if (this.transcribeError !== null) throw this.transcribeError;
    return { raw: text, language, engineId: this.engineId };
  }

  async dispose(): Promise<void> {}
}

export class FakeEngineManager implements EngineManager {
  readonly engines = new Map<EngineFamily, SttEngine | null>();
  classifier: AcousticClassifier | null = null;
  prepareCalls = 0;
  prepareError: Error | null = null;
  /**
   * Block `prepare()` until this resolves — a model that is genuinely cold.
   *
   * The 7.8 s Uzbek load is the whole reason the key-up path must not await this, and a
   * gate the test opens by hand is how that is asserted without waiting 7.8 seconds.
   */
  prepareGate: Promise<void> | null = null;
  readinessValue: EngineReadiness = {
    uzbek: 'ready',
    unified: 'ready',
    detector: 'ready',
    turkish: 'ready',
    arabic: 'ready',
    availableLanguages: new Set<Language>(['en', 'ru', 'uz']),
  };

  engineFor(family: EngineFamily): SttEngine | null {
    return this.engines.get(family) ?? null;
  }

  detector(): AcousticClassifier | null {
    return this.classifier;
  }

  /** P4: the language-ID model, when a test loads one. */
  identifier: AcousticClassifier | null = null;

  languageIdentifier(): AcousticClassifier | null {
    return this.identifier;
  }

  async prepare(): Promise<void> {
    this.prepareCalls += 1;
    if (this.prepareGate !== null) await this.prepareGate;
    if (this.prepareError !== null) throw this.prepareError;
  }

  async reconfigure(): Promise<void> {}

  async readiness(): Promise<EngineReadiness> {
    return this.readinessValue;
  }

  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------------

export class FakeInserter implements Inserter {
  /** Every `insert(text)`, in order. */
  readonly inserted: string[] = [];
  /** Every `replace(previous, text)`, in order. */
  readonly replaced: { previous: string; text: string }[] = [];
  insertOutcome: InsertionOutcome = { kind: 'inserted' };
  replaceOutcome: InsertionOutcome = { kind: 'inserted' };
  insertThrows: Error | null = null;

  async insert(text: string): Promise<InsertionOutcome> {
    if (this.insertThrows !== null) throw this.insertThrows;
    this.inserted.push(text);
    return this.insertOutcome;
  }

  async replace(previous: string, text: string): Promise<InsertionOutcome> {
    this.replaced.push({ previous, text });
    return this.replaceOutcome;
  }

  async dispose(): Promise<void> {}
}

export class FakeFocus implements FocusSource {
  app: ForegroundApp = { appId: 'telegram', displayName: 'Telegram' };
  throws: Error | null = null;

  async foreground(): Promise<ForegroundApp> {
    if (this.throws !== null) throw this.throws;
    return this.app;
  }
}

/**
 * The hook, as the controller sees it — INCLUDING its events.
 *
 * `onEvent` used to discard the listener and return a no-op unsubscribe. That made every
 * controller test pass while nothing in the app connected the hook to the gesture at all:
 * the tests called `press()` and `release()` themselves, so the missing subscription was
 * invisible from both sides. A fake that swallows the one thing its real counterpart
 * exists to deliver is not a fake, it is a hole.
 */
export class FakeHotkey implements HotkeySource {
  failure: string | null = null;
  started = false;
  /** Every binding it was told to watch, in order. Empty means nobody ever told it. */
  readonly bindings: HotkeyBinding[] = [];
  private readonly listeners = new Set<(event: HotkeyEvent) => void>();

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  onEvent(listener: (event: HotkeyEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async setBinding(binding: HotkeyBinding): Promise<void> {
    this.bindings.push(binding);
  }
  recording: ((result: HotkeyRecordingResult) => void) | null = null;
  startRecording(listener: (result: HotkeyRecordingResult) => void): void {
    this.recording = listener;
  }
  stopRecording(): void {
    this.recording = null;
  }

  /** How many listeners are attached. Zero is the bug this fake was hiding. */
  get subscribers(): number {
    return this.listeners.size;
  }

  /** Deliver one event exactly as `src/platform/hotkey.ts` would. */
  emit(event: HotkeyEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** The gesture, from the key rather than from a method call. */
  down(): void {
    this.emit({ kind: 'pressed' });
  }
  up(): void {
    this.emit({ kind: 'released' });
  }
  chord(): void {
    this.emit({ kind: 'cancelled', reason: 'chord' });
  }
}

// ---------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------

export class FakeSettings implements SettingsStore {
  loadFailure: string | null = null;
  private settings: Settings;
  private readonly listeners = new Set<(settings: Settings) => void>();

  constructor(patch: Partial<Settings> = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...patch };
  }

  current(): Settings {
    return this.settings;
  }

  async load(): Promise<SettingsLoad> {
    return { settings: this.settings, dropped: [], failure: null };
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...patch };
    for (const listener of this.listeners) listener(this.settings);
    return this.settings;
  }

  onChange(listener: (settings: Settings) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class FakeSecrets implements SecretStore {
  readonly values = new Map<string, string>();
  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }
  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }
  async remove(account: string): Promise<void> {
    this.values.delete(account);
  }
}

export class FakeHistory implements HistoryStore {
  readonly entries: HistoryEntry[] = [];
  opened = false;
  insertError: Error | null = null;
  prunedTo: number | null = null;

  async open(): Promise<void> {
    this.opened = true;
  }
  async insert(entry: HistoryEntry): Promise<void> {
    if (this.insertError !== null) throw this.insertError;
    this.entries.push(entry);
  }
  async delete(id: string): Promise<void> {
    const at = this.entries.findIndex((e) => e.id === id);
    if (at >= 0) this.entries.splice(at, 1);
  }
  async prune(keeping: number): Promise<number> {
    this.prunedTo = keeping;
    return 0;
  }
  async count(): Promise<number> {
    return this.entries.length;
  }
  /** P4: what History counts per language, for the prior's one-time seed. */
  async countsByLanguage(): Promise<Partial<Record<Language, number>>> {
    const counts: Partial<Record<Language, number>> = {};
    for (const entry of this.entries) counts[entry.language] = (counts[entry.language] ?? 0) + 1;
    return counts;
  }
  async recent(limit = 50): Promise<readonly HistoryEntry[]> {
    return this.entries.slice(-limit);
  }
  async search(): Promise<readonly HistoryEntry[]> {
    return [];
  }
  async close(): Promise<void> {}
}

export class FakeDiagnostics implements DiagnosticsSink {
  readonly appended: DictationRecord[] = [];
  opened = false;
  openError: Error | null = null;
  appendError: Error | null = null;

  async open(): Promise<void> {
    if (this.openError !== null) throw this.openError;
    this.opened = true;
  }
  async append(record: DictationRecord): Promise<void> {
    if (this.appendError !== null) throw this.appendError;
    this.appended.push(record);
  }
  async records(): Promise<readonly DictationRecord[]> {
    return this.appended;
  }
  async summary(): Promise<string> {
    return '';
  }
  async exportSummary(): Promise<string> {
    return '';
  }
  async clear(): Promise<void> {}
  async close(): Promise<void> {}
}

export class FakeModels implements ModelStore {
  readonly notes: readonly string[] = [];
  async inspect(path: string): Promise<ModelInspection> {
    return { status: 'ready', path, bytes: 1, reason: null };
  }
  async resolve(_role: ModelRole): Promise<string | null> {
    return null;
  }
  async ensure(_id: ModelId, _onProgress?: (p: ModelDownloadProgress) => void): Promise<string> {
    return '';
  }
  async status(_id: ModelId): Promise<ModelStatus> {
    return 'ready';
  }
}

// ---------------------------------------------------------------------------------
// Polishers
// ---------------------------------------------------------------------------------

export class FakePolisher implements Polisher {
  calls = 0;
  /** Every (text, language, instructions) it was asked to polish. */
  readonly seen: { text: string; language: Language; instructions: string }[] = [];
  output: string | ((text: string) => string) = (text) => `${text}.`;
  error: Error | null = null;
  delayMs = 0;

  constructor(
    readonly id = 'fake-polisher',
    readonly supportedLanguages: ReadonlySet<Language> = new Set<Language>(['en', 'ru', 'uz']),
    private readonly clock?: Clock,
  ) {}

  async polish(text: string, language: Language, instructions: string): Promise<string> {
    this.calls += 1;
    this.seen.push({ text, language, instructions });
    if (this.delayMs > 0 && this.clock !== undefined) {
      await this.clock.sleep(this.delayMs).promise;
    }
    if (this.error !== null) throw this.error;
    return typeof this.output === 'function' ? this.output(text) : this.output;
  }
}

// ---------------------------------------------------------------------------------
// A manual clock
// ---------------------------------------------------------------------------------

/**
 * Time only moves when a test moves it.
 *
 * The deadline paths — a polish that overruns 8 s, a reroute that overruns 10 s — are
 * otherwise untestable without actually waiting, and a test that actually waits is a
 * test people delete.
 */
export class ManualClock implements Clock {
  private millis = Date.UTC(2026, 7, 19, 12, 0, 0);
  private waiting: { at: number; resolve: () => void; cancelled: boolean }[] = [];

  now(): number {
    return this.millis;
  }

  sleep(ms: number): { promise: Promise<void>; cancel(): void } {
    const entry: { at: number; resolve: () => void; cancelled: boolean } = {
      at: this.millis + ms,
      resolve: () => undefined,
      cancelled: false,
    };
    const promise = new Promise<void>((resolve) => {
      entry.resolve = () => resolve();
    });
    this.waiting.push(entry);
    return {
      promise,
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  /** Move the clock and release everything due, yielding to the microtask queue. */
  async advance(ms: number): Promise<void> {
    // Flush FIRST: the sleeps this advance is meant to fire are registered inside async
    // bodies that have not necessarily reached their `await` yet, and a clock that moves
    // past a sleep before it is registered never fires it at all.
    await flush();
    this.millis += ms;
    const due = this.waiting.filter((w) => !w.cancelled && w.at <= this.millis);
    this.waiting = this.waiting.filter((w) => w.cancelled || w.at > this.millis);
    for (const entry of due) entry.resolve();
    await flush();
  }

  /** Advance far enough to fire everything currently pending. */
  async settle(): Promise<void> {
    await this.advance(60_000);
  }
}

/**
 * Let every queued microtask run.
 *
 * A fixed number of `await Promise.resolve()` turns is not enough: `finish()` is a chain
 * of a dozen awaits and each one is its own turn, so a hand-counted flush drains part of
 * the pipeline and then a `ManualClock.advance` moves past a sleep that had not been
 * registered yet. A zero-delay timer yields to the MACROTASK queue, which by definition
 * runs only once the microtask queue is empty.
 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

// ---------------------------------------------------------------------------------
// The pure ports
// ---------------------------------------------------------------------------------

/** A capitaliser that upper-cases the first letter. Enough to prove it ran, or did not. */
export const upperFirstCapitaliser: Capitaliser = {
  restore: (text) => (text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1)),
};

export interface PortOverrides {
  readonly verdict?: RouteVerdict;
  readonly usableRerun?: boolean;
  readonly transcriptDoubt?: SessionPorts['routing']['transcriptDoubt'];
  readonly readsAsEnglish?: SessionPorts['routing']['readsAsEnglish'];
  readonly uzbekRejection?: PolishRejection | null;
  readonly guardRejection?: PolishRejection | null;
  readonly route?: RouteDecision;
  readonly modes?: BuiltInModeTable;
  readonly sensitiveApps?: readonly AppId[];
  readonly polishChain?: SessionPorts['createPolishChain'];
  readonly clock?: Clock;
  /** A mode's deterministic clean-up. Absent means the port has none, as before 1.0. */
  readonly cleanUp?: NonNullable<SessionPorts['text']['cleanUp']>;
}

/**
 * A mode table shaped like the shipped one: four modes, `transcription` prompt-less.
 * The real table is t05's; this is the minimum a session needs to be driven.
 */
export function fakeModes(patch: Partial<Record<ModeKey, Partial<Mode>>> = {}): BuiltInModeTable {
  const base = (key: ModeKey, prompt: string | null, restructures: boolean): Mode => ({
    key,
    name: key,
    prompt,
    language: null,
    contextFromSelection: false,
    contextFromClipboard: false,
    contextFromActiveApplication: true,
    activationApps: [],
    autocapitalizeInsert: true,
    restructures,
    ...(patch[key] ?? {}),
  });
  return {
    message: base('message', 'MESSAGE PROMPT', true),
    super: base('super', 'SUPER PROMPT', false),
    note: base('note', 'NOTE PROMPT', true),
    transcription: base('transcription', null, false),
  };
}

/** Every pure seam, with a straightforward default and a per-test override. */
export function fakePorts(overrides: PortOverrides = {}): SessionPorts {
  const modes = overrides.modes ?? fakeModes();
  const sensitive = new Set(overrides.sensitiveApps ?? ['1password', 'bitwarden', 'keepassxc']);
  return {
    routing: {
      verifyRoute: () => overrides.verdict ?? { kind: 'consistent' },
      nonRussianCyrillicCount: () => 6,
      isUsableRerun: () => overrides.usableRerun ?? true,
      // The REAL transcript check, not a canned answer: it is pure, golden-pinned in
      // test/routing, and a fake that always said "no doubt" would hide every existing test
      // whose unified text happens not to read as English.
      transcriptDoubt: overrides.transcriptDoubt ?? transcriptDoubt,
      readsAsEnglish: overrides.readsAsEnglish ?? readsAsEnglish,
    },
    createRouter: ({ fallbackLanguage }): LanguageRouter => ({
      async route(_audio, pin) {
        if (overrides.route !== undefined) return overrides.route;
        if (pin !== null) {
          return { language: pin, family: engineFamilyFor(pin), source: 'pin', turkicMass: null };
        }
        return {
          language: fallbackLanguage,
          family: engineFamilyFor(fallbackLanguage),
          source: 'fallback',
          turkicMass: null,
        };
      },
    }),
    text: {
      // The real pipeline's SHAPE: normalise, replace, then capitalise if a capitaliser
      // was supplied. The measured behaviour of each step is t04's, with its own goldens.
      deliver: ({ text, replacements, capitaliser, cleanUp }) => {
        let out = cleanUp === undefined ? text : cleanUp(text);
        for (const rule of replacements) out = out.split(rule.find).join(rule.replaceWith);
        return capitaliser === null ? out : capitaliser.restore(out);
      },
      createCapitaliser: () => upperFirstCapitaliser,
      checkPolishGuard: () => overrides.guardRejection ?? null,
      checkUzbekPolishGuard: () => overrides.uzbekRejection ?? null,
      ...(overrides.cleanUp === undefined ? {} : { cleanUp: overrides.cleanUp }),
    },
    modes: {
      resolveMode: ({ settings, userPickedModeKey, foregroundApp }) => {
        if (foregroundApp !== null && sensitive.has(foregroundApp)) {
          return { mode: modes.transcription, source: 'credentialField' };
        }
        if (userPickedModeKey !== null && userPickedModeKey in modes) {
          return { mode: modes[userPickedModeKey as ModeKey], source: 'userPicked' };
        }
        if (!settings.modeFollowsApp) {
          const key = (settings.defaultModeKey in modes ? settings.defaultModeKey : 'super') as ModeKey;
          return { mode: modes[key], source: 'settingsDefault' };
        }
        for (const key of ['message', 'super', 'note', 'transcription'] as ModeKey[]) {
          if (foregroundApp !== null && modes[key].activationApps.includes(foregroundApp)) {
            return { mode: modes[key], source: 'appFollow' };
          }
        }
        const fallback = (settings.defaultModeKey in modes ? settings.defaultModeKey : 'super') as ModeKey;
        return { mode: modes[fallback], source: 'settingsDefault' };
      },
      isSensitiveApp: (appId) => appId !== null && sensitive.has(appId),
      formatForApp: (appId) => (appId !== null && sensitive.has(appId) ? 'password' : 'unknown'),
      polishInstructions: ({ mode }) => mode.prompt,
      promptContext: (): PromptContext => ({
        transcript: '',
        selection: '',
        clipboard: '',
        app: 'an unknown application',
        window: '',
        datetime: '2026-08-19 12:00',
        locale: 'en-US',
        language: 'en',
        appFormat: 'Plain text. Write plainly.',
        user: 'the speaker',
        field: 'an unnamed field',
        names: 'none visible',
      }),
    },
    createPolishChain: overrides.polishChain ?? (() => ({ polisher: null, notConfigured: true, reason: null })),
    clock: overrides.clock,
    locale: 'en-US',
  };
}
