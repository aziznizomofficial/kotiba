// The shipped Windows defaults, and the one place they deliberately differ from macOS.
//
// PURE. `DEFAULT_SETTINGS` in contracts is the MACOS table, field for field, and the
// golden fixture pins it — it must not move. This file is the Windows overlay, and it
// carries exactly one override.

import { DEFAULT_SETTINGS, type Settings } from '../../contracts/index.js';

/**
 * WINDOWS DELTA — `preloadAllLanguages` ships TRUE.
 *
 * macOS ships it false and the inventory is blunt about the cost: "It was the only
 * thing hiding the cold-start defect on the developer's machine; on any fresh install
 * Uzbek and Russian are configured-but-not-resident"
 * (docs/windows/inventory/session.md:440). With it off, the step-4b script-check
 * reroute finds the Uzbek engine cold and gives up with "the Uzbek engine is not
 * loaded" — so the routing recovery the app advertises does not exist on a stock
 * install (docs/windows/inventory/routing.md:662).
 *
 * The macOS objection to turning it on was resident memory: both whisper models took
 * the app from 110 MB to 1.47 GB. On Windows that objection is weaker and the defect
 * is worse:
 *
 *   * D-W3 bundles all three models inside the installer, so there is no "the user has
 *     not set up the second language yet" state to hide behind — every install has
 *     Uzbek and Russian configured from the first launch.
 *   * D-W2 puts ENGLISH on `large-v3-turbo`, the same file Russian uses, so the two
 *     resident models are the Uzbek engine and one shared unified engine — not three.
 *   * A cold load measured ~7.8 s from disk on macOS. A CPU-only Windows laptop pays
 *     that or worse, in front of the user, on the first Uzbek dictation of every
 *     session — which is the dictation that decides whether they keep the app.
 *
 * §8 of 02-BEHAVIOUR labels idle unload as a deliberate Windows ADDITION for the
 * low-RAM case; that is the pressure valve for the memory cost, and it is t06's. This
 * default and that addition are the same decision seen from two ends.
 */
export const WINDOWS_SETTINGS_DELTAS = {
  preloadAllLanguages: true,
} as const satisfies Partial<Settings>;

/** The values a fresh Windows install starts from. */
export const WINDOWS_DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  ...WINDOWS_SETTINGS_DELTAS,
};

/**
 * The stored schema version. Bumping it means `migrateSettingsBlob` grows a step.
 *
 * macOS versions the storage KEY (`uz.kotiba.settings.v1`) and has no migration path at
 * all — a v2 key would simply start empty. Windows keeps the versioned file name for
 * parity AND records the version inside, because a blob that cannot say what shape it
 * is in can only be migrated by guessing.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** The reserved key the version lives under, alongside the settings fields. */
export const SETTINGS_SCHEMA_VERSION_KEY = 'schemaVersion';
