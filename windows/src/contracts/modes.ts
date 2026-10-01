// Modes: what the polish model is told to do, and which app selects which mode.
//
// Ported from Sources/KotibaCore/Modes.swift and Sources/KotibaCore/BuiltInModes.swift,
// mapped in docs/windows/inventory/settings-modes.md.
//
// DELIBERATELY NOT PORTED (02-BEHAVIOUR §3 — do not port dead code). macOS has a full
// `Mode: Codable`, a `JSONValue` tree, `unknownFields`, a `ModeRegistry` with
// duplicate/empty validation, and a doc comment describing `<key>.json` files. NOTHING
// in the Mac app ever reads or writes a mode from disk: the four shipped modes are
// compiled-in literals. So there is no mode file format here, and the fields with zero
// readers (`version`, `voiceModelID`, `polishModelID`, `unknownFields`) are absent.

import type { Language } from './language.js';

/** The four compiled-in modes. There is no fifth and no way to add one. */
export const MODE_KEYS = ['message', 'super', 'note', 'transcription'] as const;
export type ModeKey = (typeof MODE_KEYS)[number];

/**
 * The identity Windows matches an application by.
 *
 * macOS matches `NSWorkspace.frontmostApplication.bundleIdentifier` — a stable,
 * localisation-proof reverse-DNS string — by LONGEST PREFIX on a dot boundary.
 * Windows has no equivalent for unpackaged Win32 apps, so 02-BEHAVIOUR §4 says to
 * decide the analogue once and write it down. THE DECISION:
 *
 *   An `AppId` is the foreground window's process executable BASENAME, lowercased,
 *   with `.exe` removed — `telegram`, `slack`, `code`, `1password`, `chrome`. Where a
 *   packaged app exposes an AppUserModelID, that AUMID lowercased is also an `AppId`.
 *   Matching is EXACT EQUALITY, never prefix matching: there is no dot hierarchy on
 *   Windows for a prefix to mean anything, and `hasPrefix` over flat names would make
 *   `note` match `notepad`.
 *
 * Matching on window title or localised display name is what this design rejects —
 * that is the fragility the bundle-id scheme was chosen to avoid.
 */
export type AppId = string;

/**
 * What kind of text the frontmost application takes. Drives `{{appFormat}}` in every
 * prompt AND the credential gate.
 */
export const APP_TEXT_FORMATS = [
  'plainText',
  'chatMessage',
  'email',
  'terminalCommand',
  'code',
  'markdown',
  'searchQuery',
  'password',
  'unknown',
] as const;
export type AppTextFormat = (typeof APP_TEXT_FORMATS)[number];

/**
 * The two shipped literals per format: the noun phrase and the guidance sentence, both
 * interpolated verbatim into `{{appFormat}}` as `"<label>. <guidance>"`.
 */
export interface AppTextFormatCopy {
  readonly label: string;
  readonly guidance: string;
}

/** `AppTextFormat` → its two strings. Owned by `src/core/settings` (t05). */
export type AppTextFormatTable = Readonly<Record<AppTextFormat, AppTextFormatCopy>>;

/**
 * One row of the application-knowledge table: an app, and the kind of text it takes.
 * Order in the table is not significant on Windows — matching is exact, not longest-prefix.
 */
export interface AppKnowledgeEntry {
  readonly app: AppId;
  readonly format: AppTextFormat;
}

/**
 * THE CREDENTIAL GATE, and it is a security property, not a nicety.
 *
 * `isSensitive(format)` is `format === 'password'` — exactly one format, nothing else.
 * When the frontmost application is a password manager, `resolveMode()` forces the raw,
 * prompt-less `transcription` mode and suppresses polish ENTIRELY, so a password
 * dictated into a vault is never sent to whatever endpoint the user configured. The
 * macOS comment records that this defect shipped once already.
 *
 * An app that is not in the table gets `unknown`, and its password field IS sent to the
 * polisher. The table is the whole defence.
 */
export const SENSITIVE_APP_TEXT_FORMAT: AppTextFormat = 'password';

/**
 * A dictation mode.
 *
 * `polishes` is derived, not stored: a mode polishes iff it has a prompt. macOS made it
 * depend on `polishModelID` too, which made it false for every shipped mode.
 */
export interface Mode {
  readonly key: ModeKey;
  /** What the UI shows. `transcription` is the one key whose name differs: "Raw". */
  readonly name: string;
  /**
   * The full rendered-from-template prompt, or `null` for a mode that never polishes.
   * `null` is the entire password defence: no prompt means no polisher means nothing
   * leaves the machine.
   */
  readonly prompt: string | null;
  /** All four shipped modes leave this `null`; a mode never forces a language. */
  readonly language: Language | null;
  readonly contextFromSelection: boolean;
  readonly contextFromClipboard: boolean;
  readonly contextFromActiveApplication: boolean;
  /** Apps that select this mode, and only when `modeFollowsApp` is on. */
  readonly activationApps: readonly AppId[];
  /**
   * ANDed with `settings.autoCapitalise`. TRUE for all four shipped modes, including
   * `super`, the mode that keeps every word — the flag gates the deterministic capitaliser,
   * a different layer from anything the model is told. Off, every Uzbek dictation arrives
   * entirely lower case, because the Uzbek model emits zero capitals.
   */
  readonly autocapitalizeInsert: boolean;
  /**
   * Whether the mode is allowed to rewrite rather than tidy. Drives three things at
   * once: the wide `PolishGuard`, the cloud model first in the polish chain, and
   * insert-after-polish instead of insert-then-replace.
   */
  readonly restructures: boolean;
}

/** A mode polishes iff it has a prompt. */
export function modePolishes(mode: Mode): boolean {
  return mode.prompt !== null;
}

/** The complete built-in mode table. Compiled-in literals, owned by `src/core/settings` (t05). */
export type BuiltInModeTable = Readonly<Record<ModeKey, Mode>>;

/**
 * Render order of the Settings › Modes picker. macOS `BuiltInModes.all`.
 * Note this is NOT the menu order.
 */
export const BUILT_IN_MODE_ORDER: readonly ModeKey[] = [
  'message',
  'super',
  'note',
  'transcription',
];

/**
 * The tray-menu order, which is a DIFFERENT hard-coded order and deliberately excludes
 * `transcription` — it is reached only through the credential gate, never offered.
 */
export const SELECTABLE_MODE_ORDER: readonly ModeKey[] = ['super', 'note', 'message'];

/**
 * The effective shipped default.
 *
 * macOS has a genuine contradiction here that both of its tests assert: the built-in
 * registry declares `"message"`, and `settings.defaultModeKey` ships `"super"` and
 * overwrites it one line after the registry is built. The user-visible default is Super.
 */
export const REGISTRY_DEFAULT_MODE_KEY: ModeKey = 'message';
export const SHIPPED_DEFAULT_MODE_KEY: ModeKey = 'super';

/** The mode the credential gate forces. Prompt-less by construction. */
export const CREDENTIAL_MODE_KEY: ModeKey = 'transcription';

/**
 * The 12 variables a prompt template may use. Anything else in a template is a
 * validation error. Keep this list and `PromptContext` in step or a validated variable
 * renders empty.
 */
export const PROMPT_VARIABLES = [
  'transcript',
  'selection',
  'clipboard',
  'app',
  'window',
  'datetime',
  'locale',
  'language',
  'appFormat',
  'user',
  'field',
  'names',
] as const;
export type PromptVariable = (typeof PROMPT_VARIABLES)[number];

/**
 * The values a template renders against. Every field is a string; a missing value
 * renders empty rather than failing.
 *
 * `transcript` is deliberately EMPTY in the shipping app — the transcript goes to the
 * model as the user turn, not inside the system prompt. `window` has no producer
 * anywhere and always renders empty.
 */
export type PromptContext = Readonly<Record<PromptVariable, string>>;

/** The fallback strings that appear in every prompt the model sees. */
export const PROMPT_CONTEXT_FALLBACKS = {
  emptyField: 'an unnamed field',
  emptyNames: 'none visible',
  unknownApp: 'an unknown application',
  unknownUser: 'the speaker',
} as const;

/** `datetime` is rendered with this format. */
export const PROMPT_DATETIME_FORMAT = 'yyyy-MM-dd HH:mm';

/**
 * How a mode was chosen. `resolveMode()` has four tiers, in strict order, and the first
 * one is absolute — nothing below it can override the credential gate.
 */
export const MODE_SOURCES = ['credentialField', 'userPicked', 'settingsDefault', 'appFollow'] as const;
export type ModeSource = (typeof MODE_SOURCES)[number];

/** What `resolveMode()` answers: the mode, and which tier decided it. */
export interface ModeDecision {
  readonly mode: Mode;
  readonly source: ModeSource;
}
