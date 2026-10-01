// src/core/settings — schema, defaults, salvage, modes.  OWNER: t05
//
// PURE. No Electron, no `node:fs`. **This module never touches a file.** It takes the
// bytes someone else read and returns a `SettingsLoad`; it takes a `Settings` and
// returns the bytes to write. The reading and writing live in `src/platform`
// (`createSettingsStore`). That split is what lets the salvage behaviour — which is the
// part with the interesting bugs — be tested without a filesystem.
//
// THE MODE FILE FORMAT DOES NOT EXIST. macOS has a full `Mode: Codable`, a `JSONValue`
// tree, `unknownFields` and a doc comment describing `<key>.json`, and NOTHING in the
// Mac app ever reads or writes a mode from disk. The four modes are compiled-in
// literals. Building a loader here would ship a feature the Mac app does not have, with
// a decoder whose default would reject all four of its own shipped prompts.

export {
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION_KEY,
  WINDOWS_DEFAULT_SETTINGS,
  WINDOWS_SETTINGS_DELTAS,
} from './defaults.js';

export {
  SETTINGS_FIELD_NAMES,
  SETTINGS_FIELD_SCHEMAS,
  isSettingsKey,
  validateSettingsField,
} from './schema.js';

export {
  migrateSettingsBlob,
  parseSettings,
  schemaVersionOf,
  serialiseSettings,
  settleLanguages,
  sortDeep,
  stableStringify,
} from './parse.js';

export {
  MissingWindowsPathError,
  WINDOWS_SEPARATOR,
  joinWindowsPath,
  kotibaPaths,
  localAppDataDirectory,
  roamingAppDataDirectory,
  type KotibaPaths,
  type WindowsEnvironment,
} from './paths.js';

export {
  KNOWN_MODEL_FILENAMES,
  MODEL_PATH_SOURCES,
  autoDetectReady,
  detectionWanted,
  enabledSubset,
  availableLanguages,
  resolveModelPath,
  type ModelPathSource,
  type ModelResolution,
  type ModelUsablePredicate,
} from './models.js';

export {
  MESSAGE_TASK,
  NOTE_TASK,
  PREAMBLE_HEAD,
  PREAMBLE_TAIL,
  SUPER_TASK,
  preamble,
} from './prompts.js';

export {
  SENSITIVE_APPS,
  appKnowledge,
  appTextFormats,
  builtInModeList,
  builtInModes,
  formatForApp,
  isSensitiveApp,
  modeForApp,
  polishInstructions,
  promptContext,
  renderPrompt,
  resolveMode,
  selectableModes,
} from './modes.js';

export { groupByLocalDay, localDayKey, type TimeZone } from './day.js';
