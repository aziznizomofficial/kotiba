// Every persisted setting, with the value the app ships with.
//
// Ported from `AppSettings` (Sources/KotibaUI/Settings.swift:18) and its mirror struct
// `Snapshot` (:293), mapped in docs/windows/inventory/settings-modes.md.
//
// macOS keeps all 28 fields in ONE JSON blob under a single UserDefaults key
// (`uz.kotiba.settings.v1`), not 28 keys. Windows keeps the same single blob in a file.
// The property names ARE the JSON keys — macOS uses synthesised CodingKeys with no
// renaming anywhere, so `whisperUseGPU` and `polishBaseURL` keep their macOS
// capitalisation here even where TypeScript convention would differ. Renaming a field
// is a storage-format change, not a style change.

import type { Language } from './language.js';

/** A find/replace rule the user configured. All four keys are required on decode. */
export interface Replacement {
  readonly find: string;
  readonly replaceWith: string;
  /** The Settings UI never varies this; it is always written as false. */
  readonly matchCase: boolean;
  /** The Settings UI never varies this; it is always written as true. */
  readonly wholeWord: boolean;
}

/** `Replacement`'s init defaults. The UI exposes no control for either flag. */
export const DEFAULT_REPLACEMENT_FLAGS = { matchCase: false, wholeWord: true } as const;

/**
 * Per-language ASR bias terms, keyed by `Language` raw value.
 *
 * Typed over `string` and not `Language` on purpose: a code this build does not know
 * SURVIVES storage and is dropped only when the map is converted to a `Vocabulary`.
 */
export type VocabularyMap = Readonly<Record<string, readonly string[]>>;

/**
 * The push-to-talk binding. WINDOWS-ONLY — macOS has no hotkey setting at all, it
 * displays "Hold right ⌘" as static text (D-W4 changes that: there is no Command key,
 * so the gesture moves and has to be configurable from the first release).
 *
 * `vk` is a Win32 virtual-key code, the same number `kotiba-hook.exe` prints on its
 * stdout as `DOWN 163` / `UP 163`.
 */
export interface HotkeyBinding {
  /** Win32 VK code. `VK_RCONTROL` is 0xA3 == 163. */
  readonly vk: number;
  /** What the UI shows, e.g. "Right Ctrl". Never parsed; display only. */
  readonly label: string;
}

/**
 * Every model Kotiba downloads by itself (D-W25, superseding D-W23's checklist), in the order
 * they are fetched. The CORE — Parakeet Ultra (English and Russian) and Qwen3-1.7B (the modes),
 * plus Kotib STT (Uzbek) should the installer's copy be missing — starts once onboarding is
 * finished or skipped, with no question asked. Turkish brings whisper large-v3-turbo; Arabic
 * brings Cohere, turbo (its language head and fallback) and Gemma 4 E2B (its modes) — each the
 * moment the language is turned on.
 */
export const DOWNLOADABLE_MODELS = [
  'parakeet_ultra',
  'uzbek_stt_v1',
  'qwen3_1_7b',
  'large_v3_turbo',
  'cohere_arabic',
  'gemma4_e2b_ar',
] as const;
export type AcceptedDownload = (typeof DOWNLOADABLE_MODELS)[number];

/** D-W4: Right Ctrl, not Right Alt — Right Alt is AltGr on the audience's layouts. */
export const DEFAULT_HOTKEY: HotkeyBinding = { vk: 163, label: 'Right Ctrl' };

/**
 * The complete settings schema: the 28 macOS fields, then four Windows-only ones.
 *
 * Read-only because a `SettingsStore` hands out immutable snapshots; a writer takes a
 * `Partial<Settings>` patch rather than mutating one in place.
 */
export interface Settings {
  // ---- the 28 macOS fields, in Snapshot declaration order -------------------------

  /** Router fallback, and a hard pin when no detector model is loaded. */
  readonly defaultLanguage: Language;

  /**
   * `null` means Automatic and is a REAL user choice, not "unset".
   *
   * This is the ONE field a loader must assign unconditionally. macOS `Snapshot.apply`
   * uses `if let` for the other 27 and a straight assignment for this one; using the
   * common path here makes a cleared language pin silently resurrect on next launch —
   * and the pin is the only way a user can overrule a router measured at 83.1% recall.
   */
  readonly pinnedLanguage: Language | null;

  /** Explicit path. Empty means "not set up"; auto-discovery never writes this field. */
  readonly uzbekModelPath: string;
  readonly russianModelPath: string;

  /** macOS spelling kept deliberately — the property name is the JSON key. */
  readonly whisperUseGPU: boolean;

  /**
   * Beam width for the UNIFIED family (English + Russian on `large-v3-turbo`).
   *
   * D-W11: the Uzbek family is fixed at 1 on Windows regardless of this value — D-08
   * measured beam 5 on `uzbek_stt_v1` at 21.65% WER against greedy's 21.68% for +21%
   * to +39% latency. See `BEAM_SIZE_BY_FAMILY` in `./transcript.js`, which is the
   * authority; this setting only moves the unified number.
   */
  readonly whisperBeamSize: number;

  /** Both whisper models resident took the macOS app from 110 MB to 1.47 GB. */
  readonly preloadAllLanguages: boolean;

  readonly detectorModelPath: string;

  /** Turkic cluster mass at or above which a recording routes to the Uzbek engine. */
  readonly turkicThreshold: number;

  /** Whole-buffer peak below which a recording counts as silence. */
  readonly silenceThreshold: number;

  /** Off, because the app is used in meetings. */
  readonly soundFeedback: boolean;

  readonly vocabulary: VocabularyMap;
  readonly replacements: readonly Replacement[];

  /** ANDed with `Mode.autocapitalizeInsert`; BOTH must be true for the capitaliser to run. */
  readonly autoCapitalise: boolean;

  /** The KEY, not the display name. Overrides the built-in registry's own default. */
  readonly defaultModeKey: string;

  /** OFF by default, which makes every mode's `activationApps` list inert out of the box. */
  readonly modeFollowsApp: boolean;

  readonly polishEnabled: boolean;
  readonly preferOnDeviceModel: boolean;

  /** 7 of 14 real polishes of real Uzbek changed words the speaker did not say. */
  readonly polishUzbek: boolean;

  readonly polishBaseURL: string;
  readonly polishModel: string;
  /** No UI exposes this. Free tiers meter per model, so a second one doubles the day. */
  readonly polishFallbackModel: string;
  /** The credential-store ACCOUNT name. Never the key itself. */
  readonly polishKeyAccount: string;
  /** Applied as `max(1, polishTimeoutSeconds)` seconds; UI slider is 2…30 step 1. */
  readonly polishTimeoutSeconds: number;

  readonly keepHistory: boolean;
  /** 0 means keep everything. No UI control exists for it. */
  readonly historyLimit: number;
  readonly diagnosticsEnabled: boolean;

  // ---- WINDOWS-ONLY. No macOS twin; each is forced by a decision in 00-DECISIONS ----

  /** D-W4. macOS has no hotkey setting; on Windows the gesture changed, so it must exist. */
  readonly hotkey: HotkeyBinding;

  /**
   * D-W2. Before Parakeet, English ran on `large-v3-turbo`, the SLOWEST language on
   * Windows where it is the fastest on macOS. Turning this on switches English to
   * `ggml-small.en-q5_1`, fetched on demand, until Parakeet is here. Not bundled; not the default.
   */
  readonly fastEnglish: boolean;

  /** Start Kotiba with Windows. Off until the user asks for it. */
  readonly launchAtLogin: boolean;

  /** Set once the first-run window has been dismissed. macOS has no onboarding flow. */
  readonly onboardingCompleted: boolean;

  // ---- 1.0: the platform slice, shared with macOS by name ----------------------------
  //
  // macOS `AppSettings` gained these three in 1.0 with exactly these property names, so a
  // blob moved between the two keeps them. They are NOT Windows-only; they sit after the
  // Windows block only because they arrived after it.

  /**
   * Keep Kotiba running no matter what: closing or quitting only hides the window, the
   * tray icon and the hotkey keep working, a crash is relaunched by the watchdog, and it
   * starts at login. Only "Turn off Always on & quit" really exits. OFF by default, as on
   * macOS — onboarding pre-sets it ON and marks it recommended, which is where the user
   * actually meets it.
   */
  readonly alwaysOn: boolean;

  /**
   * The downloads a Download button (or, before 1.0.1, onboarding's Download models step) was
   * pressed for. WINDOWS-ONLY (D-W23). Since D-W25 it gates nothing — the core downloads after
   * onboarding and a language's files when it is turned on — and is kept so an older settings
   * file still reads.
   */
  readonly acceptedDownloads: readonly AcceptedDownload[];

  /** Lower whatever other apps are playing while the key is held; restore on release. */
  readonly duckingEnabled: boolean;

  /**
   * How loud the playing audio stays while ducked, as a fraction of its level: 0.25 is
   * about −12 dB — clearly out of the way, still audible enough that nobody wonders
   * whether their music stopped. The macOS value and meaning, applied per app session.
   */
  readonly duckLevel: number;

  /**
   * The interface language: `''` follows the system (Русский for a Russian Windows, Oʻzbekcha
   * for an Uzbek one — Latin unless the system asks for Cyrillic — English otherwise), or one
   * of `en`, `ru`, `uz-Latn`, `uz-Cyrl`, chosen on onboarding's first step or in Settings.
   * The macOS field of the same name and meaning. A string, not an enum, on both: a value a
   * newer build wrote reads as `''` here rather than dropping the key. The dictation
   * languages (`defaultLanguage`, `pinnedLanguage`) are a different axis entirely.
   */
  readonly appLanguage: string;

  /**
   * How the pill moves while you talk: `sirifilled`, `sirilobes` or `barsglow`, the three
   * the owner kept, picked in Settings with a live preview of each. The macOS field of the
   * same name and values. A string, not an enum, like `appLanguage`: a style a newer build
   * wrote reads as the default (`resolvePillStyle`) rather than dropping the key.
   */
  readonly pillStyle: string;

  /**
   * The period the Statistics page last showed — `today`, `week`, `month` or `all` — so it
   * opens where the user left it. The macOS field of the same name and values; a string for
   * the same reason as `pillStyle` (`resolveStatsPeriod` reads an unknown one as `week`).
   */
  readonly statsPeriod: string;

  // ---- C4: Turkish and Arabic ---------------------------------------------------------

  /**
   * The dictation languages the user dictates in — any of the five, never none (the Mac's
   * `enabledLanguages`, `LanguageSubset`). Uzbek, English and Russian by default; Turkish and
   * Arabic off until turned on (onboarding pre-ticks one only when Windows itself is set to
   * it). Off means the language is never routed to, not pinnable, not in the tray or the Home
   * row, and its engine is neither preloaded nor kept warm. Never an app-UI language (that is
   * `appLanguage`). Replaces `optionalLanguages`, which loading migrates (`./parse.ts`).
   */
  readonly enabledLanguages: readonly Language[];

  /**
   * Turkish dictations delivered so far, pinned or recognised — the user's own history, which
   * the Turkish check reads: until the first, a candidate needs a `tr` share of 0.995 rather
   * than 0.99 (`TURKISH_VERIFIED_FROM_UNFAMILIAR`; the Mac's D-11). A count, not text, so it
   * survives "keep history" being off.
   */
  readonly turkishDictations: number;

  /**
   * Arabic dictations delivered so far, the same way — the Arabic check reads it: until the
   * first, an Arabic candidate needs an `ar` share of 0.98 from turbo's head rather than 0.95
   * (`ARABIC_VERIFIED_FROM_UNFAMILIAR`; the Mac's `ArabicCheck`, C4 §14.1).
   */
  readonly arabicDictations: number;

  /**
   * WINDOWS-ONLY. Which engine Arabic runs on: `auto` = Cohere unless the first-run speed
   * check found this PC too slow for it, then FastConformer (src/engines/arabic.ts); or the
   * user's own pick from the Languages page.
   */
  readonly arabicEngine: ArabicEngineChoice;
}

/** `auto` (the speed check decides), or the user's explicit pick. */
export const ARABIC_ENGINE_CHOICES = ['auto', 'cohere', 'fastConformer'] as const;
export type ArabicEngineChoice = (typeof ARABIC_ENGINE_CHOICES)[number];

/**
 * The shipped defaults, field for field.
 *
 * These are the compiled-in values a missing key falls back to. A blob written by any
 * version must load: anything absent keeps its value from here, and anything present
 * but unreadable is dropped, named, and left at its value from here.
 */
export const DEFAULT_SETTINGS: Settings = {
  defaultLanguage: 'en',
  pinnedLanguage: null,
  uzbekModelPath: '',
  russianModelPath: '',
  whisperUseGPU: true,
  whisperBeamSize: 5,
  preloadAllLanguages: false,
  detectorModelPath: '',
  turkicThreshold: 0.05,
  silenceThreshold: 0.012,
  soundFeedback: false,
  vocabulary: {},
  replacements: [],
  autoCapitalise: true,
  defaultModeKey: 'super',
  modeFollowsApp: false,
  polishEnabled: true,
  preferOnDeviceModel: true,
  polishUzbek: false,
  polishBaseURL: 'https://api.groq.com/openai/v1',
  polishModel: 'openai/gpt-oss-120b',
  polishFallbackModel: 'openai/gpt-oss-20b',
  polishKeyAccount: 'polish-default',
  polishTimeoutSeconds: 8,
  keepHistory: true,
  historyLimit: 0,
  diagnosticsEnabled: true,
  hotkey: DEFAULT_HOTKEY,
  fastEnglish: false,
  launchAtLogin: false,
  onboardingCompleted: false,
  alwaysOn: false,
  acceptedDownloads: [],
  duckingEnabled: true,
  duckLevel: 0.25,
  appLanguage: '',
  pillStyle: 'sirilobes',
  statsPeriod: 'week',
  enabledLanguages: ['en', 'ru', 'uz'],
  turkishDictations: 0,
  arabicDictations: 0,
  arabicEngine: 'auto',
};

/** Every settings key, for the per-key salvage loop and for tests that must cover all of them. */
export const SETTINGS_KEYS: readonly (keyof Settings)[] = Object.keys(
  DEFAULT_SETTINGS,
) as (keyof Settings)[];

/**
 * What a load produced. `dropped` names the keys that could not be read ALONE and were
 * left at their defaults; `failure` is the sentence shown to the user.
 *
 * macOS re-decodes each key as a one-key object to find out which ones are bad, so one
 * unreadable value costs itself and not the other 27 — the model paths are the hardest
 * state in the app to reconstruct. A loader that decodes atomically reproduces the
 * original bug: a user with a future language code sees a factory-fresh app.
 */
export interface SettingsLoad {
  readonly settings: Settings;
  readonly dropped: readonly string[];
  readonly failure: string | null;
}

/** The two load-failure sentences, verbatim. */
export const SETTINGS_LOAD_MESSAGES = {
  unreadable: 'the saved settings could not be read; a copy has been kept',
  /** Followed by the dropped keys, sorted, joined with ", ". */
  droppedPrefix: 'these settings could not be read and were left at their defaults: ',
} as const;

// ---- Where it all lives on Windows ------------------------------------------------
//
// macOS: UserDefaults domain `uz.kotiba.app`, blob key `uz.kotiba.settings.v1`, support
// directory ~/Library/Application Support/Kotiba. Windows has no defaults system, so the
// blob becomes a file. These are names only — `src/platform` joins them to a real path.

/** Directory name under %APPDATA%, i.e. `%APPDATA%\Kotiba`. */
export const SUPPORT_DIRECTORY_NAME = 'Kotiba';
/**
 * The same directories before the app was renamed from Kotib to Kotiba (both `%APPDATA%` and
 * `%LOCALAPPDATA%`). Read once, by `src/platform/rename-migration.ts`, which moves them.
 */
export const LEGACY_SUPPORT_DIRECTORY_NAME = 'Kotib';
/** Models live in `<support>\models` — the same relative layout as macOS. */
export const MODELS_DIRECTORY_NAME = 'models';
/** The whole settings blob, one file. Named for the schema version, as macOS is. */
export const SETTINGS_FILE_NAME = 'settings.v1.json';
/** Where the original bytes are kept when a key failed to decode. Written, never read. */
export const SETTINGS_UNREADABLE_FILE_NAME = 'settings.v1.json.unreadable';
/** D-W5: JSONL with an in-memory index, not SQLite. */
export const HISTORY_FILE_NAME = 'history.jsonl';
export const DIAGNOSTICS_FILE_NAME = 'diagnostics.jsonl';

/** Credential-store target for the polish API key. One target, one account per endpoint. */
export const CREDENTIAL_SERVICE = 'uz.kotiba.app';
/** The target prefix the old Kotib filed the same key under; copied from, never written. */
export const LEGACY_CREDENTIAL_SERVICE = 'uz.kotib.app';
