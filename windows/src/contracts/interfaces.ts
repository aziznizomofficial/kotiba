// Every seam in the app, and a factory type for each so a composition root can wire
// them without any module importing another module's implementation.
//
// The rule these exist to serve: `src/core/**` and `src/contracts/**` are pure
// functions over plain data. Everything that needs an operating system — a file, a
// process, a device, a window — arrives through one of these, and the pure code never
// learns which one it got. That is what lets the golden-parity suite run on a Linux
// runner in seconds, and it is the same rule that made `ai-balance/windows` testable
// from a Mac.
//
// A factory is `(deps) => T`, sync where it can be. Anything that opens a file, spawns
// a process or touches a device does that in an explicit `start`/`open`/`prepare`, not
// in the constructor — a constructor that can fail is a constructor whose failure has
// nowhere to go.

import type { AudioBuffer, InputDeviceInfo } from './audio.js';
import type { DictationRecord } from './diagnostics.js';
import type { HistoryEntry } from './history.js';
import type { HotkeyBinding, Settings, SettingsLoad } from './settings.js';
import type { HotkeyEvent, HotkeyRecordingResult } from './hotkey.js';
import type { EngineFamily, Language } from './language.js';
import type { AppId, Mode, ModeDecision } from './modes.js';
import type { ModelId, ModelInspection, ModelStatus, ModelDownloadProgress } from './models.js';
import type { InsertionOutcome } from './errors.js';
import type { LanguagePosterior, RouteDecision } from './routing.js';
import type { DictationStatus, SessionConfig } from './state.js';
import type { TranscriptResult, WhisperParams } from './transcript.js';

/** Unsubscribe. Every `on…` returns one; a listener that cannot be removed is a leak. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------------

/**
 * One speech engine.
 *
 * THE INVARIANT, and it broke Uzbek and Russian on every default install once already:
 * `isReady()` answers "is the model resident", NOT "will this engine work".
 * **FALSE IS NOT A FAILURE.** A lazily-loaded engine is legitimately not ready before
 * first use. A caller that finds `false` must call `prepare()` and RE-ASK; only a
 * `prepare()` that THROWS means unusable, and its error is the diagnosis. Refusing on
 * `isReady() === false` pointed the user at a model file that was present and valid.
 *
 * And assume every wrapper lies until its own test says otherwise: the macOS composite
 * engine computed readiness as an OR over its members, so it read ready forever and
 * re-broke Russian one level below the fix.
 */
export interface SttEngine {
  /** Stable and human-readable, e.g. `whisper-ggml-uzbek-stt-v1-q5_0`. Recorded. */
  readonly engineId: string;
  readonly supportedLanguages: ReadonlySet<Language>;
  /** Is the model resident. Not a gate — a trigger. */
  isReady(): Promise<boolean>;
  /** Load the model. Throws `EngineFailure`, and only a throw is terminal. */
  prepare(): Promise<void>;
  /**
   * Throws `EngineFailure`. `signal` ends the decode early where the engine can (the whisper
   * host polls it between decoder steps); an engine that cannot simply finishes.
   */
  transcribe(audio: AudioBuffer, language: Language, signal?: AbortSignal): Promise<TranscriptResult>;
  /**
   * The Mac's `ScriptRespelling` (P4): an engine that writes more than one script — Parakeet,
   * whose decoder picks Latin or Cyrillic per token — decodes the same audio again held to
   * `language`'s script. The language decision uses it when it decided English for a transcript
   * written in Cyrillic (`Инсайд зе контент фоль.` for "Inside the content folder"), or the
   * reverse for Russian. Never on the ordinary path: there the free choice is what keeps an
   * English word inside Russian speech in Latin. Absent on every engine with one script.
   */
  transcribeWrittenIn?(audio: AudioBuffer, language: Language): Promise<TranscriptResult>;
  /** D-W7: the engine is a child process, so it must be stoppable. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Turns audio into a language posterior. NEEDS NOT be normalised — the consumer divides
 * by the total. Non-throwing: failure is an EMPTY map, meaning "no opinion".
 */
export interface AcousticClassifier {
  posterior(audio: AudioBuffer): Promise<LanguagePosterior>;
}

/**
 * Decides which engine runs. Non-throwing: a router must ALWAYS return a decision.
 * A `pin` short-circuits everything, costs nothing, and is absolute.
 */
export interface LanguageRouter {
  route(audio: AudioBuffer, pin: Language | null): Promise<RouteDecision>;
}

/** Which engines exist, whether they are loaded, and what is stopping them. */
export interface EngineReadiness {
  readonly uzbek: ModelStatus;
  readonly unified: ModelStatus;
  readonly detector: ModelStatus;
  /** C4: whisper turbo's status — Turkish runs on it. Regardless of whether Turkish is on. */
  readonly turkish: ModelStatus;
  /** C4: `ready` when Cohere/FastConformer OR the whisper fallback can serve Arabic. */
  readonly arabic: ModelStatus;
  /** Languages a dictation can actually be produced in right now. */
  readonly availableLanguages: ReadonlySet<Language>;
}

/**
 * Owns the engines and the detector across their whole lifetime: builds them from
 * settings, rebuilds them when the model paths or the whisper options change, and
 * preloads on a press when the setting asks for it.
 */
export interface EngineManager {
  /** `null` when nothing is configured for that family. */
  engineFor(family: EngineFamily): SttEngine | null;
  /** `null` when auto-detect is off or no detector model is usable. */
  detector(): AcousticClassifier | null;
  /**
   * C4 / the Mac's `TurkishCheck` and `ArabicCheck`: whisper turbo's own language head, asked
   * through the Turkish engine — or Arabic's whisper member — that already holds turbo: the
   * second opinion that tells Turkish from Uzbek, and finds the Arabic whisper base half-heard.
   * `null` when neither family is built. Optional in the type so a fake that is about something
   * else need not have it.
   */
  languageHead?(): AcousticClassifier | null;
  /**
   * The language-ID model (P4, D-14) — VoxLingua107 ECAPA, loaded — or `null` while it is not
   * installed (or would not load). When it is here it is the router's classifier, and key-up
   * decides the language after reading the transcripts (session step 4L); `detector()` (whisper
   * base) is what routes without it. Optional in the type, like `languageHead`.
   */
  languageIdentifier?(): AcousticClassifier | null;
  /**
   * Attempt to load. `eagerly` preloads every configured language rather than only the
   * one about to be used.
   */
  prepare(options: { readonly eagerly: boolean; readonly language?: Language }): Promise<void>;
  /** Re-read the settings and rebuild anything whose inputs changed. */
  reconfigure(settings: Settings): Promise<void>;
  readiness(): Promise<EngineReadiness>;
  dispose(): Promise<void>;
}

export type CreateSttEngine = (options: {
  readonly engineId: string;
  readonly modelPath: string;
  readonly params: WhisperParams;
}) => SttEngine;

export type CreateEngineManager = (deps: {
  readonly settings: Settings;
  readonly models: ModelStore;
  readonly createEngine: CreateSttEngine;
}) => EngineManager;

// ---------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------

/**
 * The microphone. D-W6: a hidden renderer running `getUserMedia` into an `AudioWorklet`
 * on `new AudioContext({ sampleRate: 16000 })`, so the browser's own high-quality
 * resampler produces the 16 kHz mono float whisper wants. Hand-writing a resampler is
 * how the macOS bug that threw away Uzbek sibilants recurs.
 */
export interface AudioCapture {
  /**
   * Prepare the graph WITHOUT capturing. Called on every foreground, never once from a
   * constructor, and it CANNOT throw — a warm-up failure is reported through state.
   *
   * It must re-check the device every time. The macOS bug this replaced attached the
   * sink once forever, so after a device change the graph had dropped its connections,
   * `prepare()` kept succeeding, and 12 of 159 activations captured zero samples and
   * were reported to the user as "I did not hear anything".
   */
  warmUp(): Promise<void>;
  /** Safe to call when already capturing. Throws `MicrophoneFailure`. */
  start(): Promise<void>;
  /** Everything captured since `start()`. Returns an empty buffer when not capturing. */
  stop(): Promise<AudioBuffer>;
  /**
   * A take of its own — one per press. `start()` on a take while an earlier take is still
   * open SEALS the earlier one at that sample and carries on under the new take, on the
   * same running capture: nothing restarts, nothing is lost at the seam, nothing is
   * shared. This is what lets a press land while the previous dictation is still being
   * transcribed (the Mac's `MicrophoneSource.take`). `start`/`stop` above are one take,
   * for callers that never overlap.
   */
  openTake(options?: AudioTakeOptions): AudioTake;
  /** For the level meter. Cheap, synchronous, called on a timer. */
  currentPeak(): number;
  readonly isWarm: boolean;
  /** The human sentence from the last failed warm-up, or `null`. */
  readonly lastWarmUpError: string | null;
  /**
   * Whether that failure is one only the user can clear — the microphone permission, or no
   * input device at all. Every other cold microphone (a device that changed, a stream that
   * ended) is rebuilt by the next press and is not something to put in front of the user as
   * a problem. Optional: a source that cannot tell is treated as needing the user, which is
   * what every source was before. The Mac's `DictationMicrophone.warmUpNeedsTheUser`.
   */
  readonly warmUpNeedsTheUser?: boolean;
  dispose(): Promise<void>;
}

export interface AudioTakeOptions {
  /**
   * Called once, when the take reaches its ceiling (30 minutes). Audio past it is not kept
   * and is counted in `droppedSamples`; the owner finishes the dictation and says why.
   */
  readonly onLimit?: () => void;
}

/** One press's audio. */
export interface AudioTake {
  /** Open the microphone for this take. Throws `MicrophoneFailure`. */
  start(): Promise<void>;
  /** Everything this take captured, and what it lost. Empty if it never started. */
  stop(): Promise<AudioBuffer>;
  /**
   * The live 16 kHz stream of this take, ~100 ms chunks in order, as they arrive. The
   * take's own store is built from exactly these, so what `stop()` returns and what this
   * delivered are the same samples.
   */
  onChunk(listener: (samples: Float32Array) => void): Unsubscribe;
}

export type CreateAudioCapture = (options: { readonly ceilingSeconds?: number }) => AudioCapture;

// ---------------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------------

/** The application the text is going into. */
export interface ForegroundApp {
  /** See `AppId` — executable basename, lowercased, `.exe` stripped. */
  readonly appId: AppId | null;
  /** For display only. Never matched against. */
  readonly displayName: string | null;
}

/** Who is in front. The credential gate reads this, so it must never guess. */
export interface FocusSource {
  foreground(): Promise<ForegroundApp>;
}

/**
 * Writes text into the foreground application.
 *
 * Paste is the PRIMARY path, not a fallback: keystroke synthesis cannot type Uzbek on a
 * machine with no Uzbek Latin layout, because no keycode produces the okina U+02BB.
 * `replace` is what makes the polish pass real — it used to refuse unconditionally, so
 * every polish ever computed was discarded after being paid for and the whole mode
 * system did nothing while appearing to work.
 */
export interface Inserter {
  insert(text: string): Promise<InsertionOutcome>;
  /**
   * Replace text this app inserted with its polished form, VERIFYING first that the
   * characters immediately before the caret are exactly what was inserted. Replacement
   * destroys what it selects, so an unverified select-last-N eats anything the user
   * typed in between.
   */
  replace(previous: string, text: string): Promise<InsertionOutcome>;
  dispose(): Promise<void>;
}

/** The push-to-talk hook, as a process this app owns and restarts. */
export interface HotkeySource {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: HotkeyEvent) => void): Unsubscribe;
  /** Change the bound key without a restart of the app. */
  setBinding(binding: HotkeyBinding): Promise<void>;
  /**
   * "Record new key": until `stopRecording`, every transition feeds the recorder instead
   * of the tracker, so pressing the current hotkey to re-record it does not dictate. The
   * Mac's `PushToTalkMonitor.isSuspended`. The listener sees every result; the source
   * stops recording by itself on `recorded` and `cancelled`.
   */
  startRecording(listener: (result: HotkeyRecordingResult) => void): void;
  stopRecording(): void;
  /** `null` while healthy; a sentence when the helper is down. Surfaced in the tray. */
  readonly failure: string | null;
}

export type CreateFocusSource = () => FocusSource;
export type CreateInserter = (options: { readonly helperPath: string }) => Inserter;
export type CreateHotkeySource = (options: {
  readonly helperPath: string;
  readonly binding: HotkeyBinding;
}) => HotkeySource;

// ---------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------

/**
 * The settings blob, and nothing else.
 *
 * `load()` must SALVAGE PER KEY: one unreadable value costs itself, not the other 31.
 * And it must NEVER write on a failed read — the raw bytes are copied aside first and
 * the original is left alone, because writing defaults back destroys the only copy of
 * the user's configuration, and the model paths are the hardest state here to rebuild.
 */
export interface SettingsStore {
  /** The current snapshot. Immutable; a writer takes a patch. */
  current(): Settings;
  load(): Promise<SettingsLoad>;
  /** Persists immediately. Returns the new snapshot. */
  update(patch: Partial<Settings>): Promise<Settings>;
  onChange(listener: (settings: Settings) => void): Unsubscribe;
  /** The sentence from the last salvaged or failed load, or `null`. */
  readonly loadFailure: string | null;
}

/**
 * The API key, which is deliberately NOT in the settings blob — anything in that blob
 * could end up in a support bundle. Windows Credential Manager / DPAPI is the analogue
 * of the macOS Keychain, and the key must never fall back into a file.
 *
 * Setting an EMPTY value deletes, and a failed delete is surfaced, never swallowed: a
 * key that looks deleted and is not keeps sending text to the endpoint.
 */
export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  remove(account: string): Promise<void>;
}

/** D-W5: JSONL plus an in-memory index. See `./history.js` for what search must NOT do. */
export interface HistoryStore {
  open(): Promise<void>;
  insert(entry: HistoryEntry): Promise<void>;
  delete(id: string): Promise<void>;
  /** `limit <= 0` keeps everything. Returns how many were removed. */
  prune(keeping: number): Promise<number>;
  count(): Promise<number>;
  recent(limit?: number): Promise<readonly HistoryEntry[]>;
  /**
   * Substring search over raw/result/polished. No stemming, no diacritic folding, and
   * user input is TEXT, not query syntax — someone who types a hyphen must get results,
   * not a parse error.
   */
  search(text: string, limit?: number): Promise<readonly HistoryEntry[]>;
  /**
   * Dictations per language — what seeds the language decision's prior for a user who had a
   * history before the counts existed (P4, the Mac's `HistoryStore.countsByLanguage`). Optional
   * so a fake that is about something else need not count.
   */
  countsByLanguage?(): Promise<Partial<Record<Language, number>>>;
  close(): Promise<void>;
}

/** Append-only JSONL. One corrupt line costs that line, never the file. */
export interface DiagnosticsSink {
  open(): Promise<void>;
  append(record: DictationRecord): Promise<void>;
  records(): Promise<readonly DictationRecord[]>;
  /** Contains the outcome, engine id, stage names and errors — and NO transcript text. */
  summary(limit?: number): Promise<string>;
  /** Writes `summary()` to a file in `directory` and returns its path. */
  exportSummary(directory: string): Promise<string>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/** Which model file fills which role. */
export const MODEL_ROLES = ['uzbek', 'russian', 'detector', 'fastEnglish'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Finds, verifies and fetches model files.
 *
 * `resolve` is THREE STEPS IN ORDER and the order is load-bearing: (1) the explicit
 * setting, if usable; (2) a known filename in `<support>\models`; (3) the same filename
 * in the directory shipped alongside the executable. Step 2 must beat step 3 so a newer
 * model dropped in by hand wins over the bundled one — and discovery must NEVER write
 * the setting back. Readiness and the raw setting are different questions.
 */
export interface ModelStore {
  /** Four magic bytes and a size floor. Not a hash — this sits in front of every readiness question. */
  inspect(path: string): Promise<ModelInspection>;
  /** The resolved path, or `null` when nothing usable was found. */
  resolve(role: ModelRole, settings: Settings): Promise<string | null>;
  /** Idempotent BY CHECKSUM, not by existence: a stale file is refetched, and a corrupt download never lands. */
  ensure(id: ModelId, onProgress?: (progress: ModelDownloadProgress) => void): Promise<string>;
  status(id: ModelId): Promise<ModelStatus>;
  /** Every decision and refusal, in order, for the diagnostics pane. */
  readonly notes: readonly string[];
}

export type CreateSettingsStore = (options: { readonly directory: string }) => SettingsStore;
export type CreateSecretStore = (options: { readonly service: string }) => SecretStore;
export type CreateHistoryStore = (options: { readonly path: string }) => HistoryStore;
export type CreateDiagnosticsSink = (options: {
  readonly path: string;
  readonly appVersion: string;
  readonly maxBytes?: number;
}) => DiagnosticsSink;
export type CreateModelStore = (options: {
  readonly modelsDirectory: string;
  readonly bundledDirectory: string;
}) => ModelStore;

// ---------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------

/** Something stopping the app from working, shown in the tray and the Settings pane. */
export interface Blocker {
  /** Stable, machine-readable. Never matched against the headline. */
  readonly id: BlockerId;
  /** One sentence naming the problem. */
  readonly headline: string;
  /** What the user should do about it, or `null` when there is nothing to do. */
  readonly detail: string | null;
}

export const BLOCKER_IDS = [
  'microphone',
  'uzbek-model',
  'russian-model',
  'detector-model',
  'hotkey',
  'history-store',
  'diagnostics-store',
  'settings',
  /** The rename migration could not move the old Kotib's files — it is still running. */
  'renamed-legacy-running',
] as const;
export type BlockerId = (typeof BLOCKER_IDS)[number];

/**
 * The @Observable owner: one dictation per press, and everything the tray and the HUD read.
 *
 * ADMISSION IS `isRunning`, NOT `isBusy(status)`. The macOS bug: the gate moved onto a
 * variable cleared only in a method with no callers, so every press after the first was
 * refused with "Still finishing the last one." for the life of the process. Name the
 * running condition ONCE, clear it on EVERY exit path, and drive **ten** consecutive
 * dictations in the test — two would not have caught it.
 */
export interface DictationController {
  /** `isRunning ? dictation : readiness`. The dictation always wins while one is in flight. */
  readonly status: DictationStatus;
  readonly isRunning: boolean;
  /** The record of the last finished dictation, for the diagnostics pane. */
  readonly lastRecord: DictationRecord | null;
  /**
   * The microphone that barely registered a real hold and has not been reported within the
   * hour — Home's "very quiet" notice. Cleared by a dictation that comes out as text or by
   * `dismissQuietMic()`.
   */
  readonly quietMic: InputDeviceInfo | null;
  dismissQuietMic(): void;

  /** Open the stores, warm the microphone, start the hook, preload what settings ask for. */
  start(): Promise<void>;
  /** Re-check permissions, devices and models. Called on every foreground. Must not refuse a press. */
  recheck(): Promise<void>;

  press(): void;
  release(): void;
  /** D-W4: live on Windows, unlike macOS, because a chord during the hold must not dictate. */
  cancel(reason: string): void;

  /** Re-read settings into the pipeline and persist. */
  settingsChanged(): Promise<void>;

  /** Which mode this dictation would use right now, and which tier chose it. */
  resolveMode(): Promise<ModeDecision>;
  /** Sets the in-memory pick AND the persisted default — the tray menu's behaviour. */
  setMode(key: string): Promise<void>;
  /** Sets ONLY the persisted default — the Settings picker's behaviour. Must not latch a pin. */
  setDefaultMode(key: string): Promise<void>;
  clearPickedMode(): void;
  /** `null` means Automatic, and it is a real choice. */
  setPinnedLanguage(language: Language | null): Promise<void>;

  blockers(): readonly Blocker[];
  onStatusChange(listener: (status: DictationStatus) => void): Unsubscribe;
  dispose(): Promise<void>;
}

export type CreateDictationController = (deps: {
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
  readonly modes: Readonly<Record<string, Mode>>;
  readonly config: SessionConfig;
}) => DictationController;

// ---------------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------------

/**
 * What `kotiba.exe --check` reports. D-W10: it runs the whole pipeline over a committed
 * WAV fixture and exits, and it must distinguish "models not installed" from "model
 * file corrupt" **by this typed field**, never by matching an error message.
 */
export interface CheckResult {
  readonly ok: boolean;
  readonly models: Readonly<Record<ModelId, ModelStatus>>;
  /** What the pipeline produced for the fixture, when it got that far. */
  readonly transcript: string | null;
  readonly route: RouteDecision | null;
  /** One sentence per thing that went wrong. Empty iff `ok`. */
  readonly failures: readonly string[];
}
