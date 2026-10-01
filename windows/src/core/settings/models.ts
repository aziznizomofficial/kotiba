// The three-step model path resolution. PURE — the "does it exist" question is injected.
//
// macOS `AppSettings.locate(_:_:)` (Sources/KotibaUI/Settings.swift:447). This is what
// makes a shipped installer work with no configuration at all.

import type { ModelRole, Settings } from '../../contracts/index.js';

import { joinWindowsPath } from './paths.js';
import { languageSubset, subsetFamilies, type LanguageSubset } from '../routing/language-subset.js';

/**
 * Auto-discovery candidates per role, BEST FIRST. The order inside each list is
 * meaningful and measured.
 */
export const KNOWN_MODEL_FILENAMES: Readonly<Record<ModelRole, readonly string[]>> = {
  /**
   * `uzbek_stt_v1` measured 21.68% WER against `navoi-medium`'s 25.19%, so it wins when
   * both are present. Both files are 539,212,484 bytes with DIFFERENT sha256s, which is
   * why picking the wrong one fails verification in a way that reads like a corrupt
   * download (02-BEHAVIOUR §5).
   */
  uzbek: ['ggml-uzbek-stt-v1-q5_0.bin', 'ggml-navoi-medium-q5_0.bin'],
  /** D-W2: also the ENGLISH engine on Windows. One file, two languages. */
  russian: ['ggml-large-v3-turbo-q5_0.bin'],
  /** 59 MB, 34 ms, never asked to transcribe — only for the ~99-language posterior. */
  detector: ['ggml-base-q5_1.bin'],
  /** D-W2's opt-in Fast English. Not bundled; fetched on demand. */
  fastEnglish: ['ggml-small.en-q5_1.bin'],
};

/** Which settings field holds the explicit override for a role. */
const EXPLICIT_SETTING: Readonly<Record<ModelRole, keyof Settings | null>> = {
  uzbek: 'uzbekModelPath',
  russian: 'russianModelPath',
  detector: 'detectorModelPath',
  /** No settings field exists for it, and inventing one is a schema change. */
  fastEnglish: null,
};

/**
 * "Does a usable model live at this path?"
 *
 * NOT a file-existence check. macOS routes every readiness question through
 * `ModelFile.inspect` — four magic bytes plus an 8 MiB floor — and the inventory is
 * explicit about what happens without it: a half-finished download turns `uzbekReady`
 * true, clears the blocker, shows a green tick, and the only feedback the user ever
 * gets is whisper.cpp guessing at noise 7.8 s into a load, once per launch, forever.
 *
 * Injected rather than imported so this module stays pure; `src/engines` (t06) supplies
 * the real inspection.
 */
export type ModelUsablePredicate = (path: string) => boolean;

/** How a model path was found, for the diagnostics pane. */
export const MODEL_PATH_SOURCES = ['explicit', 'modelsDirectory', 'bundled'] as const;
export type ModelPathSource = (typeof MODEL_PATH_SOURCES)[number];

export interface ModelResolution {
  readonly path: string;
  readonly source: ModelPathSource;
}

/**
 * THREE STEPS, IN ORDER, and the order is load-bearing.
 *
 *   1. The explicit setting, if it is usable.
 *   2. Each known filename in `<roaming>\Kotiba\models`, in list order.
 *   3. The same filenames in the directory shipped alongside the executable.
 *
 * Step 2 MUST beat step 3: a newer model dropped into the models directory by hand has
 * to win over the one inside the install, or a user who was sent a better Uzbek engine
 * cannot use it without an installer. macOS pins this at SettingsTests.swift:263.
 *
 * DISCOVERY NEVER WRITES THE SETTING. `uzbekModelPath` stays empty on a stock install
 * that works perfectly (SettingsTests.swift:178, :259). Readiness and the raw setting
 * are different questions, and conflating them makes the settings file claim a path the
 * user never chose — which then survives an uninstall of the model it names.
 */
export function resolveModelPath(options: {
  readonly role: ModelRole;
  readonly settings: Settings;
  readonly modelsDirectory: string;
  /** The Windows stand-in for the macOS bundle's `Resources/models`. Always LAST. */
  readonly bundledDirectory: string;
  readonly isUsable: ModelUsablePredicate;
}): ModelResolution | null {
  const { role, settings, modelsDirectory, bundledDirectory, isUsable } = options;

  // 1. The explicit setting.
  const settingKey = EXPLICIT_SETTING[role];
  if (settingKey !== null) {
    const explicit = settings[settingKey];
    if (typeof explicit === 'string' && explicit !== '' && isUsable(explicit)) {
      return { path: explicit, source: 'explicit' };
    }
  }

  const names = KNOWN_MODEL_FILENAMES[role];

  // 2. The models directory — before the bundle, deliberately.
  for (const name of names) {
    const candidate = joinWindowsPath(modelsDirectory, name);
    if (isUsable(candidate)) return { path: candidate, source: 'modelsDirectory' };
  }

  // 3. What shipped inside the installer.
  for (const name of names) {
    const candidate = joinWindowsPath(bundledDirectory, name);
    if (isUsable(candidate)) return { path: candidate, source: 'bundled' };
  }

  return null;
}

/** The dictation languages that are on, as the router reads them (the Mac's `languageSubset`). */
export function enabledSubset(settings: Settings): LanguageSubset {
  return languageSubset(settings.enabledLanguages);
}

/**
 * Whether there is anything to detect: more than one engine family on. One language, or English
 * and Russian alone, routes without the detector (`soleRoute`) — the switch that used to say
 * this (`autoDetectLanguage`) is gone; the per-language toggles and Automatic say it now.
 */
export function detectionWanted(settings: Settings): boolean {
  return subsetFamilies(enabledSubset(settings)).size > 1;
}

/**
 * `autoDetectReady`: something to detect, a detector, and — while Uzbek is on — an Uzbek model.
 *
 * A detector with no Uzbek model is not ready while Uzbek is on: routing to an engine that is
 * not there is worse than not routing at all.
 */
export function autoDetectReady(options: {
  readonly settings: Settings;
  readonly detectorPath: string | null;
  readonly uzbekPath: string | null;
}): boolean {
  return (
    detectionWanted(options.settings) &&
    options.detectorPath !== null &&
    (options.uzbekPath !== null || !options.settings.enabledLanguages.includes('uz'))
  );
}

/**
 * Which languages the tray offers to PIN.
 *
 * Always English — D-W2 puts it on `large-v3-turbo`, the same file Russian uses, but the
 * user is never told "you cannot dictate English". Uzbek and Russian appear only when
 * their model resolved, so an unconfigured install can only pin English.
 */
export function availableLanguages(options: {
  readonly uzbekPath: string | null;
  readonly russianPath: string | null;
}): readonly ('en' | 'ru' | 'uz')[] {
  const out: ('en' | 'ru' | 'uz')[] = ['en'];
  if (options.russianPath !== null) out.push('ru');
  if (options.uzbekPath !== null) out.push('uz');
  return out;
}
