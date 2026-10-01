// The four compiled-in modes, the application-knowledge table, and mode resolution.
//
// PURE. There is NO mode file format — macOS has a full `Mode: Codable`, a `JSONValue`
// tree, `unknownFields` and a doc comment describing `<key>.json`, and nothing in the
// Mac app ever reads or writes a mode from disk. Building a loader here would ship a
// feature the Mac app does not have, with a decoder whose own default (requireTranscript
// true) would reject all four of its own shipped prompts. The dead fields — `version`,
// `voiceModelID`, `polishModelID`, `unknownFields` — are absent from `Mode` by contract.

import {
  BUILT_IN_MODE_ORDER,
  CREDENTIAL_MODE_KEY,
  PROMPT_CONTEXT_FALLBACKS,
  PROMPT_VARIABLES,
  SELECTABLE_MODE_ORDER,
  SENSITIVE_APP_TEXT_FORMAT,
  type AppId,
  type AppKnowledgeEntry,
  type AppTextFormat,
  type AppTextFormatTable,
  type BuiltInModeTable,
  type Mode,
  type ModeDecision,
  type ModeKey,
  type PromptContext,
  type PromptVariable,
  type Settings,
} from '../../contracts/index.js';

import { MESSAGE_TASK, NOTE_TASK, SUPER_TASK, preamble } from './prompts.js';

// ---------------------------------------------------------------------------------
// The four modes
// ---------------------------------------------------------------------------------

/**
 * `activationApps`, translated to Windows.
 *
 * The MATCHING RULE is parity; the STRINGS are not. macOS matches reverse-DNS bundle
 * identifiers by longest prefix on a dot boundary. An `AppId` on Windows is a flat
 * executable basename, so there is no dot hierarchy for a prefix to mean anything and
 * matching is exact — `hasPrefix` over flat names would make `note` match `notepad`.
 *
 * These lists are inert out of the box: `modeFollowsApp` ships false, so `resolveMode`
 * never reaches the app-follow tier unless the user turns the toggle on.
 */
const MESSAGE_ACTIVATION_APPS: readonly AppId[] = [
  'slack',
  'discord',
  'telegram',
  'unigram',
  'whatsapp',
  'signal',
  'teams',
  'ms-teams',
];

const NOTE_ACTIVATION_APPS: readonly AppId[] = [
  'obsidian',
  'notion',
  'logseq',
  'joplin',
  'typora',
  'anytype',
  'onenote',
  'onenoteim',
];

/**
 * The complete built-in mode table.
 *
 * A function and not a const because macOS's are computed vars that rebuild on every
 * access — and because a caller that mutates a shared table would change the prompts
 * for every later dictation.
 *
 * `autocapitalizeInsert` is TRUE on all four, INCLUDING `super`, the mode that keeps
 * every word. The prompt speaks to the model; the flag gates the deterministic
 * sentence-capitaliser, a different layer. The cost of reading one as the other is
 * concrete — the Uzbek model emits zero capitals across 24 real dictations, so switching
 * the capitaliser off in the default mode makes every Uzbek dictation arrive entirely
 * lower case.
 */
export function builtInModes(): BuiltInModeTable {
  return {
    message: {
      key: 'message',
      name: 'Message',
      prompt: preamble(MESSAGE_TASK),
      language: null,
      contextFromSelection: false,
      contextFromClipboard: false,
      contextFromActiveApplication: true,
      activationApps: MESSAGE_ACTIVATION_APPS,
      autocapitalizeInsert: true,
      restructures: true,
    },
    super: {
      key: 'super',
      name: 'Super',
      prompt: preamble(SUPER_TASK),
      language: null,
      contextFromSelection: false,
      contextFromClipboard: false,
      contextFromActiveApplication: true,
      activationApps: [],
      autocapitalizeInsert: true,
      restructures: false,
    },
    note: {
      key: 'note',
      name: 'Note',
      prompt: preamble(NOTE_TASK),
      language: null,
      contextFromSelection: false,
      contextFromClipboard: false,
      contextFromActiveApplication: true,
      activationApps: NOTE_ACTIVATION_APPS,
      autocapitalizeInsert: true,
      restructures: true,
    },
    /**
     * The credential mode. `prompt: null` ⇒ `modePolishes` false ⇒ no polisher is built
     * ⇒ nothing leaves the machine. That is the ENTIRE password defence.
     *
     * The display name is "Raw" while the key is "transcription" — the one mode where
     * the two differ. Excluded from the tray list; reachable only through the gate.
     */
    transcription: {
      key: 'transcription',
      name: 'Raw',
      prompt: null,
      language: null,
      contextFromSelection: false,
      contextFromClipboard: false,
      contextFromActiveApplication: true,
      activationApps: [],
      autocapitalizeInsert: true,
      restructures: false,
    },
  };
}

/** Settings › Modes render order. macOS `BuiltInModes.all`. */
export function builtInModeList(modes: BuiltInModeTable = builtInModes()): readonly Mode[] {
  return BUILT_IN_MODE_ORDER.map((key) => modes[key]);
}

/**
 * The tray-menu list: `super`, `note`, `message`, in that order.
 *
 * A DIFFERENT hard-coded order from `BUILT_IN_MODE_ORDER`, and `transcription` is
 * deliberately absent — it is reached only through the credential gate and offering it
 * would let a user pick "never polish" without understanding what they had turned off.
 */
export function selectableModes(modes: BuiltInModeTable = builtInModes()): readonly Mode[] {
  return SELECTABLE_MODE_ORDER.map((key) => modes[key]);
}

// ---------------------------------------------------------------------------------
// Application knowledge
// ---------------------------------------------------------------------------------

/** `AppTextFormat` → the two literals that go into `{{appFormat}}` verbatim. */
export function appTextFormats(): AppTextFormatTable {
  return {
    plainText: { label: 'plain text', guidance: 'Plain prose. No markdown.' },
    chatMessage: {
      label: 'a short chat message',
      guidance: 'A chat message: short, no greeting or sign-off, no markdown headings.',
    },
    email: {
      label: 'an email',
      guidance: 'An email body. Complete sentences. No subject line unless dictated.',
    },
    terminalCommand: {
      label: 'a shell command',
      guidance: 'A shell command. Output the command only, with no prose and no code fence.',
    },
    code: {
      label: 'source code',
      guidance: 'Source code or a code comment. Preserve identifiers exactly.',
    },
    markdown: { label: 'markdown', guidance: 'Markdown is appropriate here.' },
    searchQuery: {
      label: 'a search query',
      guidance: 'A search query: keywords, no punctuation, no sentence.',
    },
    password: {
      label: 'a password or secret',
      guidance: 'A credential field. Transcribe literally, change nothing, add no punctuation.',
    },
    unknown: { label: 'text', guidance: 'Format as ordinary text.' },
  };
}

/**
 * THE SENSITIVE-APPLICATION TABLE. This is a security property and the whole defence:
 * an app that is not here gets `unknown`, and its password field IS sent to whatever
 * polish endpoint the user configured.
 *
 * ── DELIBERATE DIVERGENCE FROM macOS ──────────────────────────────────────────────
 *
 * macOS carries a real defect here and t02's golden fixture pins it as-is, correctly,
 * because that is what a parity fixture is for. `AppKnowledge` matches bundle ids by
 * exact-match-or-dot-boundary, and its password prefix is `com.agilebits.onepassword`.
 * The real bundle identifier of 1Password 7 is `com.agilebits.onepassword7`, and a
 * trailing `7` is not a dot boundary — so 1Password 8 matches and is protected, and
 * 1Password 7 comes back `unknown`, NOT sensitive, and a password dictated into it goes
 * to the polish endpoint.
 *
 * Windows does NOT reproduce that. The table below is keyed on executable name and
 * names every versioned variant explicitly, and `test/settings/credential-gate.test.ts`
 * fails if any of them stops matching. This is not parity and it is not an oversight:
 * a version-numbered miss in a security gate is a bug wherever it runs, and the Windows
 * table is written flat and exhaustive precisely so no version suffix can fall through.
 *
 * ── WHAT IS NOT COVERED, AND WHY ──────────────────────────────────────────────────
 *
 * A browser's BUILT-IN password manager cannot be identified this way. Chrome's
 * password page, Edge's wallet and Firefox's Lockwise all run inside the ordinary
 * browser process — same executable, same AppId — so marking them sensitive would mean
 * marking every browser sensitive and killing polish for most of the web. macOS has the
 * same gap for the same reason and maps browsers to `plainText`; so does this table.
 * Identifying them needs the focused element's role from UI Automation, which is
 * `src/platform`'s to supply and a different gate from this one.
 */
export const SENSITIVE_APPS: readonly AppId[] = [
  // 1Password. Both 7 and 8 install their binary as `1Password.exe`, so the bare name
  // is the one that fires in practice; the numbered and helper names are here because
  // an AppUserModelID is also an AppId and the macOS bug was exactly a version suffix
  // slipping past a matcher.
  '1password',
  '1password7',
  '1password8',
  'agile1pagent',
  '1password-browsersupport',
  'agilebits.onepassword',
  'agilebits.onepassword7',
  // Bitwarden.
  'bitwarden',
  'bitwarden-desktop',
  // KeePass and the KeePassXC fork. `keepass` and `keepass2` are different executables
  // shipped by the same project; `keepassx` is the older cross-platform fork.
  'keepass',
  'keepass2',
  'keepassx',
  'keepassxc',
  // Dashlane.
  'dashlane',
  'dashlanedesktop',
  // LastPass.
  'lastpass',
  'lastpassdesktop',
  // Windows' own credential surfaces. `CredentialUIBroker.exe` hosts the modern
  // credential prompt and `credwiz.exe` is the Credential Manager backup/restore
  // wizard. The Control Panel applet itself is hosted by rundll32 and cannot be
  // distinguished by executable name — a known gap, not an omission.
  'credentialuibroker',
  'credwiz',
  // The rest of the field, so a user's choice of vault does not decide whether the
  // gate holds.
  'keeper',
  'keeperpasswordmanager',
  'nordpass',
  'roboform',
  'enpass',
  'protonpass',
  'proton pass',
  'sticky password',
  'passwordsafe',
  'pwsafe',
];

/**
 * The full table: which app takes which kind of text.
 *
 * Drives `{{appFormat}}` in every prompt AND the credential gate. Order is not
 * significant — matching is exact equality, so there is nothing for order to break.
 */
export function appKnowledge(): readonly AppKnowledgeEntry[] {
  const entry = (format: AppTextFormat) => (app: AppId): AppKnowledgeEntry => ({ app, format });

  return [
    ...SENSITIVE_APPS.map(entry('password')),

    ...[
      'windowsterminal',
      'wt',
      'cmd',
      'powershell',
      'pwsh',
      'conemu64',
      'cmder',
      'alacritty',
      'wezterm-gui',
      'mintty',
      'hyper',
    ].map(entry('terminalCommand')),

    ...[
      'code',
      'code - insiders',
      'codium',
      'cursor',
      'windsurf',
      'zed',
      'devenv',
      'idea64',
      'pycharm64',
      'webstorm64',
      'clion64',
      'goland64',
      'rider64',
      'phpstorm64',
      'rubymine64',
      'datagrip64',
      'sublime_text',
      'notepad++',
    ].map(entry('code')),

    ...[
      'slack',
      'discord',
      'telegram',
      'unigram',
      'whatsapp',
      'signal',
      'teams',
      'ms-teams',
      'element',
      'viber',
      'skype',
    ].map(entry('chatMessage')),

    ...['outlook', 'olk', 'thunderbird', 'mailspring', 'emclient', 'bluemail'].map(entry('email')),

    ...['obsidian', 'notion', 'logseq', 'joplin', 'typora', 'anytype', 'marktext'].map(
      entry('markdown'),
    ),

    // Browsers are plainText, exactly as on macOS. See the note on SENSITIVE_APPS for
    // why their built-in password managers are not — and cannot be — covered here.
    ...[
      'notepad',
      'wordpad',
      'winword',
      'onenote',
      'onenoteim',
      'chrome',
      'msedge',
      'firefox',
      'brave',
      'opera',
      'vivaldi',
      'arc',
      'zen',
    ].map(entry('plainText')),
  ];
}

/** Lazily built once — the table is a constant and rebuilding it per keystroke is waste. */
let knowledgeIndex: Map<AppId, AppTextFormat> | null = null;

function index(): Map<AppId, AppTextFormat> {
  if (knowledgeIndex === null) {
    knowledgeIndex = new Map(appKnowledge().map((row) => [row.app, row.format]));
  }
  return knowledgeIndex;
}

/**
 * EXACT-EQUALITY lookup, lowercased.
 *
 * Not longest-prefix: macOS matches reverse-DNS identifiers where a dot boundary makes
 * a prefix meaningful. A Windows `AppId` is a flat basename, and prefix matching over
 * flat names is actively wrong — `note` would match `notepad`, and worse, a prefix rule
 * on this table would make `keepass` match a random `keepassistant.exe`.
 */
export function formatForApp(appId: AppId | null): AppTextFormat {
  if (appId === null) return 'unknown';
  return index().get(appId.trim().toLowerCase()) ?? 'unknown';
}

/** `formatForApp(appId) === 'password'`. Exactly one format, nothing else. */
export function isSensitiveApp(appId: AppId | null): boolean {
  return formatForApp(appId) === SENSITIVE_APP_TEXT_FORMAT;
}

// ---------------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------------

/**
 * FOUR TIERS OF PRECEDENCE, in strict order.
 *
 *   1. THE CREDENTIAL GATE. Nothing below can override it.
 *   2. A mode the user picked from the tray this session — in memory, never persisted,
 *      nil at every launch.
 *   3. `settings.defaultModeKey`, when `modeFollowsApp` is off. It ships OFF, so this
 *      is the tier that answers for almost every dictation on almost every install.
 *   4. The mode whose `activationApps` names the foreground app.
 */
export function resolveMode(options: {
  readonly modes: BuiltInModeTable;
  readonly settings: Settings;
  readonly userPickedModeKey: string | null;
  readonly foregroundApp: AppId | null;
}): ModeDecision {
  const { modes, settings, userPickedModeKey, foregroundApp } = options;

  // 1. The credential gate. Absolute.
  if (isSensitiveApp(foregroundApp)) {
    return { mode: modes[CREDENTIAL_MODE_KEY], source: 'credentialField' };
  }

  // 2. This session's tray pick.
  if (userPickedModeKey !== null && isModeKey(userPickedModeKey)) {
    return { mode: modes[userPickedModeKey], source: 'userPicked' };
  }

  // 3. The persisted default. `modeFollowsApp` ships false, so this is the usual answer.
  if (!settings.modeFollowsApp) {
    const key = isModeKey(settings.defaultModeKey) ? settings.defaultModeKey : 'super';
    return { mode: modes[key], source: 'settingsDefault' };
  }

  // 4. App-follow.
  const matched = modeForApp(modes, foregroundApp);
  if (matched !== null) return { mode: matched, source: 'appFollow' };

  const fallback = isModeKey(settings.defaultModeKey) ? settings.defaultModeKey : 'super';
  return { mode: modes[fallback], source: 'settingsDefault' };
}

/** Which mode claims this app, or `null`. Exact equality, per the `AppId` decision. */
export function modeForApp(modes: BuiltInModeTable, appId: AppId | null): Mode | null {
  if (appId === null) return null;
  const needle = appId.trim().toLowerCase();
  for (const key of BUILT_IN_MODE_ORDER) {
    const mode = modes[key];
    if (mode.activationApps.includes(needle)) return mode;
  }
  return null;
}

function isModeKey(value: string): value is ModeKey {
  return (BUILT_IN_MODE_ORDER as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------------

const PROMPT_VARIABLE_SET: ReadonlySet<string> = new Set(PROMPT_VARIABLES);

/**
 * Substitute `{{name}}` for each of the 12 known variables.
 *
 * CANNOT FAIL, exactly like macOS's `render`: an unclosed `{{` stops the scan and the
 * remainder is copied verbatim, a name with no value renders empty, and whitespace
 * inside the braces is tolerated (`{{  transcript  }}` works). An UNKNOWN name is left
 * alone rather than blanked — macOS rejects those at validation time, and this port has
 * no template the user can author, so the only way one appears here is a typo in a
 * shipped prompt, where showing it beats hiding it.
 */
export function renderPrompt(template: string, context: PromptContext): string {
  let out = '';
  let cursor = 0;

  for (;;) {
    const open = template.indexOf('{{', cursor);
    if (open === -1) {
      out += template.slice(cursor);
      return out;
    }
    const close = template.indexOf('}}', open + 2);
    if (close === -1) {
      // An unclosed `{{`: stop scanning and copy the rest verbatim.
      out += template.slice(cursor);
      return out;
    }

    out += template.slice(cursor, open);
    const name = template.slice(open + 2, close).trim();
    if (PROMPT_VARIABLE_SET.has(name)) {
      out += context[name as PromptVariable];
    } else {
      out += template.slice(open, close + 2);
    }
    cursor = close + 2;
  }
}

/**
 * Build the render context the shipping app supplies.
 *
 * `transcript` is deliberately EMPTY: it goes to the model as the user turn, not inside
 * the system prompt. `window` has no producer anywhere and always renders empty. The
 * fallback strings are literals that appear in every prompt the model sees.
 */
export function promptContext(options: {
  readonly appId: AppId | null;
  readonly appName?: string | null;
  readonly language: string;
  readonly datetime: string;
  readonly locale: string;
  readonly user?: string | null;
  readonly field?: string | null;
  /** The user's own vocabulary terms first, then any harvested on-screen names. */
  readonly names?: readonly string[];
  readonly selection?: string;
  readonly clipboard?: string;
}): PromptContext {
  const format = formatForApp(options.appId);
  const copy = appTextFormats()[format];
  const names = options.names ?? [];
  const field = options.field ?? '';
  const app = options.appName ?? options.appId;

  return {
    transcript: '',
    selection: options.selection ?? '',
    clipboard: options.clipboard ?? '',
    app: app === null || app === '' ? PROMPT_CONTEXT_FALLBACKS.unknownApp : app,
    window: '',
    datetime: options.datetime,
    locale: options.locale,
    language: options.language,
    appFormat: `${copy.label}. ${copy.guidance}`,
    user:
      options.user === null || options.user === undefined || options.user === ''
        ? PROMPT_CONTEXT_FALLBACKS.unknownUser
        : options.user,
    field: field === '' ? PROMPT_CONTEXT_FALLBACKS.emptyField : field,
    names: names.length === 0 ? PROMPT_CONTEXT_FALLBACKS.emptyNames : names.join(', '),
  };
}

/**
 * The system prompt for one polish, or `null` for a mode that never polishes.
 *
 * `null` is not an edge case to tidy away — it is the credential gate's effect made
 * visible one layer down: no prompt, no polisher, nothing sent.
 */
export function polishInstructions(options: {
  readonly mode: Mode;
  readonly context: PromptContext;
}): string | null {
  if (options.mode.prompt === null) return null;
  return renderPrompt(options.mode.prompt, options.context);
}
