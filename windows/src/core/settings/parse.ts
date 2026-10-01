// Reading and writing the settings blob. PURE — this file never touches a filesystem.
//
// It is handed bytes and returns a `SettingsLoad`; it is handed a `Settings` and returns
// the bytes to write. Every interesting bug in this layer lives in the salvage, and the
// salvage is only cheap to test when there is no file involved.

import {
  CORE_LANGUAGES,
  SETTINGS_LOAD_MESSAGES,
  type Language,
  type Settings,
  type SettingsLoad,
} from '../../contracts/index.js';
import { languageSubset, orderedLanguages, subsetFallback } from '../routing/language-subset.js';

import {
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION_KEY,
  WINDOWS_DEFAULT_SETTINGS,
} from './defaults.js';
import { SETTINGS_FIELD_NAMES, isSettingsKey, validateSettingsField } from './schema.js';

/** A plain JSON object. Not `any`; the salvage reads it key by key. */
type Blob = Record<string, unknown>;

function isPlainObject(value: unknown): value is Blob {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Nothing was readable: defaults stand, and the caller must NOT write them back. */
function totalFailure(): SettingsLoad {
  return {
    settings: WINDOWS_DEFAULT_SETTINGS,
    dropped: [],
    failure: SETTINGS_LOAD_MESSAGES.unreadable,
  };
}

// ---------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------

/**
 * One schema step. Takes the raw object at version `n`, returns it at version `n + 1`.
 * It may drop, rename or rewrite keys; it must not throw.
 */
type Migration = (blob: Blob) => Blob;

/**
 * Indexed by the version being migrated FROM.
 *
 * `0` is "a blob with no `schemaVersion`", which is both a pre-versioning Windows file
 * and a macOS blob exported by hand. The step is deliberately an identity plus a
 * version stamp: v1 IS the macOS field set plus four Windows-only keys, and those four
 * are absent from such a blob, so they take their defaults through the ordinary
 * missing-key path. A transform that manufactured them would be inventing data.
 *
 * A future v2 appends here; nothing else changes.
 */
const MIGRATIONS: readonly Migration[] = [(blob) => blob];

/** What the version key says, or 0 when it is absent or nonsense. */
export function schemaVersionOf(blob: Blob): number {
  const raw = blob[SETTINGS_SCHEMA_VERSION_KEY];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Bring a blob up to `SETTINGS_SCHEMA_VERSION`.
 *
 * A version from the FUTURE is left alone rather than rejected: every key is validated
 * individually below, so a newer file degrades to "the keys this build understands"
 * instead of to nothing. Refusing it would throw away a configuration this build could
 * mostly read — the same mistake as decoding the blob atomically.
 */
export function migrateSettingsBlob(blob: Blob): {
  readonly blob: Blob;
  readonly from: number;
  readonly to: number;
} {
  const from = schemaVersionOf(blob);
  let current: Blob = blob;
  for (let version = from; version < SETTINGS_SCHEMA_VERSION; version += 1) {
    const step = MIGRATIONS[version];
    if (step === undefined) break;
    current = step(current);
  }
  return { blob: current, from, to: Math.max(from, SETTINGS_SCHEMA_VERSION) };
}

// ---------------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------------

/** Copy the survivors onto the defaults. */
function apply(survivors: Blob): Settings {
  const out: Record<string, unknown> = { ...WINDOWS_DEFAULT_SETTINGS };

  for (const key of SETTINGS_FIELD_NAMES) {
    // pinnedLanguage is handled below, UNCONDITIONALLY. It must not go through here.
    if (key === 'pinnedLanguage') continue;
    if (Object.prototype.hasOwnProperty.call(survivors, key)) {
      out[key] = survivors[key];
    }
  }

  // THE ONE FIELD ASSIGNED UNCONDITIONALLY.
  //
  // `null` means Automatic and is a real user choice, not an absence. macOS assigns
  // this straight through where the other 31 use `if let`; reproducing the common path
  // here makes a cleared language pin silently resurrect on the next launch — and the
  // pin is the user's only override on a router measured at 83.1% recall on Uzbek
  // (58.4% under two seconds).
  //
  // The TypeScript shape of the same trap is `?? WINDOWS_DEFAULT_SETTINGS.pinnedLanguage`
  // over a value that is legitimately null, or a truthiness test. Neither appears here:
  // an absent key and a stored null both mean Automatic, and both land as null.
  const pinned = survivors['pinnedLanguage'];
  out['pinnedLanguage'] = pinned === undefined ? null : pinned;

  return settleLanguages(out as unknown as Settings);
}

/**
 * The two keys `enabledLanguages` replaced, read from the raw blob (they are no longer settings
 * keys, so the salvage loop skips them): the Mac's `Snapshot` migration, rule for rule.
 *
 *   * `optionalLanguages` (Turkish/Arabic only), with no `enabledLanguages` beside it → the core
 *     three plus those.
 *   * `autoDetectLanguage: false` with no pin → a pin on the default language, which is what
 *     "off" meant (the switch is gone: the per-language toggles and Automatic say it now).
 */
function migrateLegacyLanguages(blob: Blob, survivors: Blob): void {
  if (!Object.prototype.hasOwnProperty.call(survivors, 'enabledLanguages')) {
    const legacy = blob['optionalLanguages'];
    if (Array.isArray(legacy)) {
      const optional = legacy.filter((code): code is Language => code === 'tr' || code === 'ar');
      survivors['enabledLanguages'] = [...CORE_LANGUAGES, ...optional];
    }
  }
  if (blob['autoDetectLanguage'] === false && (survivors['pinnedLanguage'] ?? null) === null) {
    survivors['pinnedLanguage'] = survivors['defaultLanguage'] ?? WINDOWS_DEFAULT_SETTINGS.defaultLanguage;
  }
}

/**
 * `enabledLanguages` in `Language` order without duplicates; a pin on a language that is off is
 * released and the default moves to one that is on — neither may route to it.
 */
export function settleLanguages(settings: Settings): Settings {
  const on = languageSubset(settings.enabledLanguages);
  const enabledLanguages = orderedLanguages(on);
  const pinnedLanguage = settings.pinnedLanguage !== null && on.languages.has(settings.pinnedLanguage) ? settings.pinnedLanguage : null;
  const defaultLanguage = subsetFallback(on, settings.defaultLanguage);
  return { ...settings, enabledLanguages, pinnedLanguage, defaultLanguage };
}

/**
 * Decode a stored blob, SALVAGING PER KEY.
 *
 * (a) Try the whole object. (b) On failure, validate each known key ALONE; a key that
 * fails alone is dropped, named in `dropped`, and left at its default. (c) The
 * survivors are applied.
 *
 * One unreadable value must cost itself and not the other 31. The model paths are the
 * hardest state in this app to reconstruct, and losing them presents to the user as
 * "No Uzbek model" — a complaint pointing at the wrong cause entirely.
 *
 * An UNKNOWN key from a newer build is not a failure and is never reported as dropped:
 * every field is optional, so an object of nothing but unknown keys is a valid, empty
 * settings blob.
 *
 * `raw` may be the file's text or an already-parsed value. Text that is not JSON, and a
 * value that is not a JSON object, are both total failures: defaults stand, `failure`
 * says so, and — this is the part that matters — the CALLER MUST NOT WRITE. macOS
 * returns from `load()` without touching the stored blob, having copied the raw bytes
 * aside first, because writing defaults back destroys the only copy of the user's
 * configuration.
 */
export function parseSettings(raw: unknown): SettingsLoad {
  let value: unknown = raw;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return totalFailure();
    }
  }

  if (!isPlainObject(value)) return totalFailure();

  const { blob } = migrateSettingsBlob(value);

  // Per-key salvage. An empty survivor set is NOT a total failure — it is 32 keys
  // at their defaults with every one of them named, which is strictly more information
  // than "the saved settings could not be read".
  const survivors: Blob = {};
  const dropped: string[] = [];

  for (const key of Object.keys(blob)) {
    if (key === SETTINGS_SCHEMA_VERSION_KEY) continue;
    if (!isSettingsKey(key)) continue; // A newer build's key. Tolerated, not dropped.

    const checked = validateSettingsField(key, blob[key]);
    if (checked.ok) {
      survivors[key] = checked.value;
    } else {
      dropped.push(key);
    }
  }

  migrateLegacyLanguages(blob, survivors);

  const sorted = [...dropped].sort();
  return {
    settings: apply(survivors),
    dropped: sorted,
    failure: sorted.length === 0 ? null : SETTINGS_LOAD_MESSAGES.droppedPrefix + sorted.join(', '),
  };
}

// ---------------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------------

/** Recursively key-sorted, so two equal values produce identical bytes. */
export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isPlainObject(value)) {
    const out: Blob = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * `JSON.stringify` with every object's keys sorted at every level and no whitespace.
 *
 * The diagnostics line depends on this: macOS sets `outputFormatting = [.sortedKeys]`,
 * which is what makes two runs of the same dictation produce identical bytes and a diff
 * of two logs mean something.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/**
 * The bytes to write.
 *
 * Keys are SORTED and the file is indented. macOS encodes with a plain `JSONEncoder`
 * and explicitly warns that key order in the stored blob is arbitrary; that is fine for
 * a plist nobody reads and wrong for a file that is the ONLY way to change four of the
 * settings — `turkicThreshold`, `historyLimit`, `polishFallbackModel` and
 * `detectorModelPath` have no UI anywhere. Sorted and indented, a diff of two settings
 * files is meaningful and a user can find the line they came for.
 *
 * The API key is NOT here and must never be: anything in this file can end up in a
 * support bundle. Only `polishKeyAccount`, which is the credential-store account NAME.
 */
export function serialiseSettings(settings: Settings): string {
  const blob: Blob = { [SETTINGS_SCHEMA_VERSION_KEY]: SETTINGS_SCHEMA_VERSION };
  for (const key of SETTINGS_FIELD_NAMES) {
    blob[key] = settings[key];
  }
  return `${JSON.stringify(sortDeep(blob), null, 2)}\n`;
}
