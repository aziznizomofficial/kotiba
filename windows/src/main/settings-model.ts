// The app window, as data: seven sections, every card, every control, every caption.
// PURE — no electron, no fs.
//
// 1.0 replaces the old seven-tab Settings window with the Mac's app window — Home,
// History, Statistics, Modes, Languages, Hotkey, Settings — and ports every control the
// old window had into it (Sources/KotibaUI/MainWindow.swift and Panes/*).
//
// WHY THIS IS STILL A TABLE. "A missing setting is a missing feature", and the only way to
// know none is missing is to be able to ASK. With the controls as data, one test walks
// `APP_SECTIONS`, one walks `SETTINGS_KEYS`, and between them nothing that is persisted
// goes unrendered by accident and nothing rendered writes a key that does not exist. The
// cards the Mac draws by hand — the hero, the charts, the engine and mode cards — are
// `custom` controls here: the table still says where they are and which keys they write.
//
// EVERY CONTROL PERSISTS ON CHANGE. There is no OK, Cancel or Apply anywhere: closing the
// window is not a commit, it is just closing the window. `SETTINGS_COMMIT` records that as
// an assertion a test can hold.

import type { SecretStore, Settings } from '../contracts/index.js';
import { DEFAULT_SETTINGS } from '../contracts/index.js';

import { t } from '../core/i18n/index.js';

import { LIFECYCLE_COPY } from './lifecycle.js';

/** There is no OK/Cancel model. A test asserts this constant, so it cannot drift silently. */
export const SETTINGS_COMMIT = 'immediate' as const;

/** The seven sections, in the Mac's sidebar order. */
export const SECTION_IDS = [
  'home',
  'history',
  'statistics',
  'modes',
  'languages',
  'hotkey',
  'settings',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** Window geometry. The Mac's default 1000 × 680, minimum 720 × 480. */
export const MAIN_WINDOW_WIDTH = 1000;
export const MAIN_WINDOW_HEIGHT = 680;
export const MAIN_WINDOW_MIN_WIDTH = 720;
export const MAIN_WINDOW_MIN_HEIGHT = 480;
/** Below this window width the sidebar folds to an icon rail on its own. */
export const RAIL_BELOW = 860;
/** Content never grows wider than this; the rest is black margin. */
export const READABLE_WIDTH = 860;
/** The frameless title bar's height; the native caption buttons sit in it, right. */
export const TITLE_BAR_HEIGHT = 40;

export interface PickerOption {
  readonly value: string | number;
  readonly label: string;
}

/** The custom cards, by what they render. Each names the keys it writes, if any. */
export const CUSTOM_KINDS = [
  /** Home's first row: the V19 "Globe" promo (src/renderer/promo-globe.ts). */
  'promo',
  'hero',
  'blockers',
  'quietMic',
  'quickPickers',
  'lastDictation',
  'todayTiles',
  'historyList',
  'statTiles',
  'periodChart',
  'shareBars',
  'stageChart',
  'statsFootnote',
  'modeNow',
  'modeCards',
  'polishStatus',
  'engineCards',
  /** The five dictation languages' on/off, and the fallback among those that are on. */
  'languageToggles',
  'hotkeyRecorder',
  'hotkeyPresets',
  'hotkeyWarnings',
  'quitForReal',
  'diagnosticsReport',
  'runSetupAgain',
  /** Licence and model credits (Settings › About). Static text, no state. */
  'about',
  /** A paragraph and nothing else. */
  'note',
  /** The interface language: four flagged choices, switched live (writes `appLanguage`). */
  'appLanguage',
  /** The pill's voice animation: three cards, each a live preview (writes `pillStyle`). */
  'pillStyle',
  /** Statistics' period: Today · Week · Month · All time, driving the whole page (writes `statsPeriod`). */
  'statsPeriod',
] as const;
export type CustomKind = (typeof CUSTOM_KINDS)[number];

/**
 * One control. `settingKey` is the whole persistence contract: a control that names a key
 * writes that key and nothing else, immediately. `null` is a readout or an action.
 */
export type SettingsControl =
  | {
      readonly kind: 'toggle';
      readonly id: string;
      readonly settingKey: keyof Settings;
      readonly label: string;
      readonly caption: string | null;
    }
  | {
      readonly kind: 'slider';
      readonly id: string;
      readonly settingKey: keyof Settings;
      readonly label: string;
      readonly min: number;
      readonly max: number;
      readonly step: number;
      /** How the value is printed beside the label. */
      readonly format: 'percent' | 'seconds' | 'threshold';
      readonly caption: string | null;
    }
  | {
      readonly kind: 'picker';
      readonly id: string;
      readonly settingKey: keyof Settings;
      readonly label: string;
      readonly options: readonly PickerOption[];
      /** `segmented` is the sliding chip picker; `menu` a drop-down, for long lists. */
      readonly style: 'segmented' | 'menu';
      readonly caption: string | null;
    }
  | {
      readonly kind: 'text';
      readonly id: string;
      readonly settingKey: keyof Settings;
      readonly label: string;
      readonly placeholder: string;
      readonly caption: string | null;
    }
  /** The API key. Never in the settings blob — the credential store holds it. */
  | {
      readonly kind: 'secret';
      readonly id: string;
      readonly settingKey: null;
      readonly account: keyof Settings;
      readonly label: string;
      readonly caption: string | null;
    }
  | {
      readonly kind: 'vocabulary' | 'replacements';
      readonly id: string;
      readonly settingKey: keyof Settings;
      readonly label: string;
      readonly caption: string | null;
    }
  | {
      readonly kind: 'custom';
      readonly custom: CustomKind;
      readonly id: string;
      /** The keys this card writes. Empty for a readout. */
      readonly writes: readonly (keyof Settings)[];
      readonly settingKey: null;
      readonly label: string;
      readonly caption: string | null;
    };

export interface SettingsCard {
  /** `null` renders an untitled card. */
  readonly title: string | null;
  readonly subtitle?: string;
  /** Icon name from the renderer's set. */
  readonly icon?: string;
  /** `bare` draws the controls with no card around them (tiles, the search row). */
  readonly bare?: boolean;
  readonly controls: readonly SettingsControl[];
}

export interface AppSection {
  readonly id: SectionId;
  readonly title: string;
  readonly icon: string;
  /** Under the title. `null` for none; Home and Statistics compute theirs. */
  readonly subtitle: string | null;
  readonly cards: readonly SettingsCard[];
}

// ---------------------------------------------------------------------------------
// The copy. The Mac's sentences, with Windows nouns — PC for Mac, tray for menu bar.
// ---------------------------------------------------------------------------------

export const COPY = {
  get historySubtitle(): string {
    return t('copy.historySubtitle');
  },
  get historySearch(): string {
    return t('copy.historySearch');
  },
  get modesSubtitle(): string {
    return t('copy.modesSubtitle');
  },
  get modeFollowsApp(): string {
    return t('copy.modeFollowsApp');
  },
  get polishTitle(): string {
    return t('copy.polishTitle');
  },
  get polishSubtitle(): string {
    return t('copy.polishSubtitle');
  },
  get polish(): string {
    return t('copy.polish');
  },
  get polishUzbek(): string {
    return t('copy.polishUzbek');
  },
  get polishKey(): string {
    return t('copy.polishKey');
  },
  get polishTimeout(): string {
    return t('copy.polishTimeout');
  },
  get languagesSubtitle(): string {
    return t('copy.languagesSubtitle');
  },
  get fastEnglish(): string {
    return t('copy.fastEnglish');
  },
  get gpu(): string {
    return t('copy.gpu');
  },
  get beamSize(): string {
    return t('copy.beamSize');
  },
  get preloadAll(): string {
    return t('copy.preloadAll');
  },
  get vocabularyTitle(): string {
    return t('copy.vocabularyTitle');
  },
  get vocabulary(): string {
    return t('copy.vocabulary');
  },
  get replacements(): string {
    return t('copy.replacements');
  },
  get hotkeySubtitle(): string {
    return t('copy.hotkeySubtitle');
  },
  get hotkeyShortcuts(): string {
    return t('copy.hotkeyShortcuts');
  },
  get soundFeedback(): string {
    return t('copy.soundFeedback');
  },
  get ducking(): string {
    return t('copy.ducking');
  },
  get duckingDetail(): string {
    return t('copy.duckingDetail');
  },
  get silenceThreshold(): string {
    return t('copy.silenceThreshold');
  },
  get keepHistoryDetail(): string {
    return t('copy.keepHistoryDetail');
  },
  get historyLimitDetail(): string {
    return t('copy.historyLimitDetail');
  },
  get diagnostics(): string {
    return t('copy.diagnostics');
  },
  get runSetupAgain(): string {
    return t('copy.runSetupAgain');
  },
  get permissionsGranted(): string {
    return t('copy.permissionsGranted');
  },
} as const;

/** Two accuracy choices, and the values are the beam widths. */
function beamOptions(): readonly PickerOption[] {
  return [
  { value: 1, label: t('s.fast') },
  { value: 5, label: t('s.careful') },
  ];
}

function historyLimitOptions(): readonly PickerOption[] {
  return [
  { value: 0, label: t('s.everything') },
  { value: 100, label: t('s.last_100') },
  { value: 1000, label: t('s.last_1_000') },
  { value: 10_000, label: t('s.last_10_000') },
  ];
}

function custom(
  kind: CustomKind,
  label: string,
  writes: readonly (keyof Settings)[] = [],
  caption: string | null = null,
): SettingsControl {
  return { kind: 'custom', custom: kind, id: `custom.${kind}`, writes, settingKey: null, label, caption };
}

/** Built on demand: every label is looked up in the interface language of the moment. */
function sections(): readonly AppSection[] {
  return [
  {
    id: 'home',
    title: t('s.home'),
    icon: 'home',
    subtitle: null,
    cards: [
      // First row: the promo (V19 "Globe", owner's pick 2026-10-02), always playing while it can be
      // seen. The hero stays as the second row: the live status, the pill as the meter while
      // listening, and the hotkey hint; the calm notices keep their place under it.
      { title: null, bare: true, controls: [custom('promo', t('home.promo.label'))] },
      { title: null, bare: true, controls: [custom('hero', t('s.status'))] },
      // What the user has to do, as small calm notices — not a titled "Needs your attention"
      // panel (owner's review, 2026-09-30). Hidden whole when there is nothing to do.
      { title: null, bare: true, controls: [custom('blockers', t('s.blockers'))] },
      // A microphone that barely registered a real hold: which one, and the button for Sound
      // settings. Hidden whole when there is nothing to say (the Mac's `QuietMicNotice`).
      { title: null, bare: true, controls: [custom('quietMic', t('s.blockers'))] },
      // Mode (tray semantics: pins) and Language (the pin, a real choice).
      { title: null, controls: [custom('quickPickers', t('s.mode_and_language'), ['pinnedLanguage'])] },
      { title: t('s.last_dictation'), icon: 'quote', controls: [custom('lastDictation', t('s.last_dictation'))] },
      { title: null, bare: true, controls: [custom('todayTiles', t('s.today'))] },
    ],
  },
  {
    id: 'history',
    title: t('s.history'),
    icon: 'history',
    subtitle: COPY.historySubtitle,
    cards: [
      {
        title: null,
        bare: true,
        // The search row carries its own "Keep history" switch, beside the field, as the
        // Mac's does.
        controls: [custom('historyList', COPY.historySearch, ['keepHistory'])],
      },
    ],
  },
  {
    id: 'statistics',
    title: t('s.statistics'),
    icon: 'chart',
    subtitle: null,
    cards: [
      // One period drives the page: the totals, the splits, the timings and the chart below.
      { title: null, bare: true, controls: [custom('statsPeriod', t('s.statistics'), ['statsPeriod'])] },
      { title: null, bare: true, controls: [custom('statTiles', t('s.totals'))] },
      // The card draws its own head: the title follows the period's bars (by hour, per day…).
      { title: null, controls: [custom('periodChart', t('s.dictations_per_day'))] },
      { title: null, bare: true, controls: [custom('shareBars', t('s.by_language_and_by_mode'))] },
      {
        title: t('s.where_the_time_goes'),
        subtitle: t('s.median_per_stage_after_you_let'),
        icon: 'stopwatch',
        controls: [custom('stageChart', t('s.where_the_time_goes'))],
      },
      { title: null, bare: true, controls: [custom('statsFootnote', t('s.where_these_numbers_come_from'))] },
    ],
  },
  {
    id: 'modes',
    title: t('s.modes'),
    icon: 'wand',
    subtitle: COPY.modesSubtitle,
    cards: [
      {
        title: null,
        controls: [
          {
            kind: 'toggle',
            id: 'modes.followsApp',
            settingKey: 'modeFollowsApp',
            label: t('s.let_the_app_i_am_in'),
            caption: COPY.modeFollowsApp,
          },
          custom('modeNow', t('s.right_now')),
        ],
      },
      // "Make default" writes the FALLBACK only — `setDefaultMode`, never `setMode`, which
      // would pin and silently switch off app-following behind the toggle above.
      { title: null, bare: true, controls: [custom('modeCards', t('s.modes'), ['defaultModeKey'])] },
      {
        title: COPY.polishTitle,
        subtitle: COPY.polishSubtitle,
        icon: 'sparkles',
        controls: [
          {
            kind: 'toggle',
            id: 'polish.enabled',
            settingKey: 'polishEnabled',
            label: t('s.fix_spelling_grammar_and_punctuation'),
            caption: COPY.polish,
          },
          custom('polishStatus', t('s.what_will_run')),
          {
            kind: 'toggle',
            id: 'polish.uzbek',
            settingKey: 'polishUzbek',
            label: t('s.let_a_model_rewrite_uzbek_too'),
            caption: COPY.polishUzbek,
          },
          {
            kind: 'text',
            id: 'polish.baseURL',
            settingKey: 'polishBaseURL',
            label: t('s.endpoint'),
            placeholder: 'https://api.groq.com/openai/v1',
            caption: null,
          },
          {
            kind: 'text',
            id: 'polish.model',
            settingKey: 'polishModel',
            label: t('s.model'),
            placeholder: 'openai/gpt-oss-120b',
            caption: null,
          },
          {
            kind: 'secret',
            id: 'polish.apiKey',
            settingKey: null,
            account: 'polishKeyAccount',
            label: t('s.api_key'),
            caption: COPY.polishKey,
          },
          {
            kind: 'slider',
            id: 'polish.timeout',
            settingKey: 'polishTimeoutSeconds',
            label: t('s.give_up_after'),
            min: 2,
            max: 30,
            step: 1,
            format: 'seconds',
            caption: COPY.polishTimeout,
          },
        ],
      },
    ],
  },
  {
    id: 'languages',
    title: t('s.languages'),
    icon: 'globe',
    subtitle: COPY.languagesSubtitle,
    cards: [
      {
        title: t('lang.toggles.title'),
        icon: 'globe',
        controls: [
          // Every dictation language's on/off (the last one on cannot go), then the fallback
          // among those that are on. Automatic detection is simply what the pin's Automatic
          // does among them — there is no separate switch for it any more.
          custom('languageToggles', t('lang.toggles.title'), ['enabledLanguages', 'defaultLanguage']),
        ],
      },
      {
        title: t('s.which_language'),
        icon: 'globe',
        controls: [
          // The pin, drawn by `quickPickers`' twin inside the card.
          custom('quickPickers', t('s.language'), ['pinnedLanguage']),
        ],
      },
      // English (with Fast English), Русский and Oʻzbekcha, each with its model slot:
      // choose, download where a public copy exists, remove.
      {
        title: null,
        bare: true,
        controls: [
          custom('engineCards', t('s.engines'), [
            'fastEnglish',
            'russianModelPath',
            'uzbekModelPath',
            'detectorModelPath',
            // C4: Arabic's engine override.
            'arabicEngine',
          ]),
        ],
      },
      {
        title: t('s.whisper_engine'),
        subtitle: t('s.all_three_languages'),
        icon: 'cpu',
        controls: [
          { kind: 'toggle', id: 'languages.gpu', settingKey: 'whisperUseGPU', label: t('s.use_the_gpu'), caption: COPY.gpu },
          {
            kind: 'picker',
            id: 'languages.beamSize',
            settingKey: 'whisperBeamSize',
            label: t('s.accuracy'),
            options: beamOptions(),
            style: 'segmented',
            caption: COPY.beamSize,
          },
          {
            kind: 'toggle',
            id: 'languages.preloadAll',
            settingKey: 'preloadAllLanguages',
            label: t('s.load_every_language_up_front'),
            caption: COPY.preloadAll,
          },
        ],
      },
      {
        title: COPY.vocabularyTitle,
        subtitle: COPY.vocabulary,
        icon: 'book',
        controls: [
          { kind: 'vocabulary', id: 'text.vocabulary', settingKey: 'vocabulary', label: t('s.terms'), caption: null },
          {
            kind: 'replacements',
            id: 'text.replacements',
            settingKey: 'replacements',
            label: t('s.replacements'),
            caption: COPY.replacements,
          },
          {
            kind: 'toggle',
            id: 'text.autoCapitalise',
            settingKey: 'autoCapitalise',
            label: t('s.capitalise_sentences'),
            caption: null,
          },
        ],
      },
    ],
  },
  {
    id: 'hotkey',
    title: t('s.hotkey'),
    icon: 'keyboard',
    subtitle: COPY.hotkeySubtitle,
    cards: [
      { title: null, controls: [custom('hotkeyRecorder', t('s.record_new_key'), ['hotkey'])] },
      { title: t('s.presets'), icon: 'keyboard', controls: [custom('hotkeyPresets', t('s.presets'), ['hotkey'])] },
      { title: t('s.heads_up'), icon: 'warning', controls: [custom('hotkeyWarnings', t('s.heads_up'))] },
      {
        title: t('s.shortcuts_are_not_dictations'),
        icon: 'command',
        controls: [custom('note', t('s.shortcuts'), [], COPY.hotkeyShortcuts)],
      },
    ],
  },
  {
    id: 'settings',
    title: t('s.settings'),
    icon: 'gear',
    subtitle: null,
    cards: [
      // First: the one setting that changes every word on every page, switched live.
      {
        title: t('s.app_language'),
        icon: 'globe',
        controls: [custom('appLanguage', t('s.app_language'), ['appLanguage'], t('s.app_language_detail'))],
      },
      // How the pill moves while you talk — the three the owner kept, each shown moving.
      {
        title: t('settings.pill.title'),
        icon: 'waveform',
        controls: [custom('pillStyle', t('settings.pill.title'), ['pillStyle'], t('settings.pill.detail'))],
      },
      {
        title: t('s.always_there'),
        icon: 'infinity',
        controls: [
          {
            kind: 'toggle',
            id: 'settings.alwaysOn',
            settingKey: 'alwaysOn',
            label: LIFECYCLE_COPY.alwaysOnTitle,
            caption: LIFECYCLE_COPY.alwaysOnDetail,
          },
          {
            kind: 'toggle',
            id: 'settings.launchAtLogin',
            settingKey: 'launchAtLogin',
            label: LIFECYCLE_COPY.loginTitle,
            caption: LIFECYCLE_COPY.loginDetail,
          },
          custom('quitForReal', LIFECYCLE_COPY.quitForRealTitle, ['alwaysOn'], LIFECYCLE_COPY.quitForRealDetail),
        ],
      },
      {
        title: t('s.sound'),
        icon: 'speaker',
        controls: [
          { kind: 'toggle', id: 'settings.sound', settingKey: 'soundFeedback', label: COPY.soundFeedback, caption: null },
          { kind: 'toggle', id: 'settings.ducking', settingKey: 'duckingEnabled', label: COPY.ducking, caption: COPY.duckingDetail },
          {
            kind: 'slider',
            id: 'settings.duckLevel',
            settingKey: 'duckLevel',
            label: t('s.lower_to'),
            min: 0,
            max: 0.8,
            step: 0.05,
            format: 'percent',
            caption: null,
          },
        ],
      },
      {
        title: t('s.microphone'),
        icon: 'mic',
        controls: [
          {
            kind: 'slider',
            id: 'settings.silenceThreshold',
            settingKey: 'silenceThreshold',
            label: t('s.silence_threshold'),
            min: 0.001,
            max: 0.1,
            step: 0.001,
            format: 'threshold',
            caption: COPY.silenceThreshold,
          },
        ],
      },
      {
        title: t('s.history'),
        icon: 'history',
        controls: [
          { kind: 'toggle', id: 'settings.keepHistory', settingKey: 'keepHistory', label: t('s.keep_history'), caption: COPY.keepHistoryDetail },
          {
            kind: 'picker',
            id: 'settings.historyLimit',
            settingKey: 'historyLimit',
            label: t('s.keep'),
            options: historyLimitOptions(),
            style: 'menu',
            caption: COPY.historyLimitDetail,
          },
        ],
      },
      {
        title: t('s.permissions'),
        icon: 'shield',
        controls: [custom('blockers', t('s.permissions'), [], COPY.permissionsGranted)],
      },
      {
        title: t('s.diagnostics'),
        icon: 'stethoscope',
        controls: [
          {
            kind: 'toggle',
            id: 'settings.diagnostics',
            settingKey: 'diagnosticsEnabled',
            label: t('s.record_what_happened_on_every_dictation'),
            caption: COPY.diagnostics,
          },
          custom('diagnosticsReport', t('s.summary')),
        ],
      },
      {
        title: t('s.setup'),
        icon: 'sparkles',
        controls: [custom('runSetupAgain', t('s.run_the_first_run_setup_again'), ['onboardingCompleted'], COPY.runSetupAgain)],
      },
      {
        title: t('s.about'),
        icon: 'info',
        controls: [custom('about', t('s.kotiba_is_free_and_open_source'), [], t('s.mit_licence'))],
      },
    ],
  },
  ];
}

/**
 * The sections, with every custom card's id qualified by its section — Home and Settings
 * both show the blockers, Home and Languages both show the language pin, and the renderer
 * keys on ids.
 */
export function appSections(): readonly AppSection[] {
  return sections().map((section) => ({
  ...section,
  cards: section.cards.map((card) => ({
    ...card,
    controls: card.controls.map((control) =>
      control.kind === 'custom' ? { ...control, id: `${section.id}.${control.custom}` } : control,
    ),
  })),
  }));
}

/**
 * The sections in the language the module loaded in (English, unless something switched
 * first). For STRUCTURE — ids, keys, order — which no language changes. A page draws from
 * `appSections()`, so its words follow the current language.
 */
export const APP_SECTIONS: readonly AppSection[] = appSections();

/**
 * Keys written from two places on purpose, as on the Mac: "Keep history" sits beside the
 * History search AND in Settings › History.
 */
export const KEYS_WITH_TWO_CONTROLS: readonly (keyof Settings)[] = ['keepHistory'];

/** Every control, flattened, in section → card → declaration order. */
export function allControls(): readonly SettingsControl[] {
  return APP_SECTIONS.flatMap((section) => section.cards.flatMap((card) => card.controls));
}

/** Every settings key some control writes. */
export function boundSettingsKeys(): ReadonlySet<keyof Settings> {
  const keys = new Set<keyof Settings>();
  for (const control of allControls()) {
    if (control.settingKey !== null) keys.add(control.settingKey);
    if (control.kind === 'custom') for (const key of control.writes) keys.add(key);
  }
  return keys;
}

/**
 * The keys that are persisted, functional and DELIBERATELY have no control — the Mac's
 * too, plus `preferOnDeviceModel`, whose subject (an on-device polish model) does not
 * exist on Windows. Adding controls for these is scope, not parity; dropping the FIELDS
 * breaks the routing threshold and the fallback-model chain.
 */
export const SETTINGS_WITHOUT_CONTROLS: readonly (keyof Settings)[] = [
  'turkicThreshold',
  'polishFallbackModel',
  'polishKeyAccount', // named by the secret control; not typed by the user
  'preferOnDeviceModel', // no on-device model exists on Windows
  'acceptedDownloads', // written by onboarding's Download models step and the Download buttons
  'turkishDictations', // a count the controller keeps for the Turkish check, not a choice
  'arabicDictations', // the same for the Arabic check
];

/** Handy for the renderer: the shipped value of a key. */
export function shippedDefault<K extends keyof Settings>(key: K): Settings[K] {
  return DEFAULT_SETTINGS[key];
}

/** "Good morning" / "Good afternoon" / "Good evening", by the local hour. The Mac's bands. */
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return t('s.good_morning');
  if (hour >= 12 && hour < 18) return t('s.good_afternoon');
  return t('s.good_evening');
}

/** What each mode does, in a sentence — the Mac's `ModeCard.summary`. */
export function modeSummary(key: string): string {
  switch (key) {
    case 'super':
      return t('s.your_words_exactly_only_certain_transcription');
    case 'message':
      return t('s.a_chat_message_you_would_actually');
    case 'note':
      return t('s.a_structured_markdown_note_a_heading');
    case 'transcription':
      return t('s.exactly_what_was_said_no_model');
    default:
      return t('s.a_custom_mode');
  }
}

/**
 * Whether a polish key is saved — for the Settings snapshot, which EVERY window load asks
 * for (`settings:get`). A read that fails is "no key", never a throw.
 *
 * On Windows the read is a `powershell.exe` compiling an `Add-Type` block, and it fails
 * outright where PowerShell cannot do that (Constrained Language Mode under WDAC/AppLocker,
 * a policy-blocked or missing powershell.exe). It used to throw straight through
 * `settings:get`, which rejected the renderer's `store.load()` — whose `.then` is what
 * draws Home and opens onboarding — so the window stayed blank and a first run never saw
 * its setup. Saving and removing a key still surface their own failures.
 */
export async function secretIsPresent(secrets: SecretStore | null, account: string): Promise<boolean> {
  if (secrets === null) return false;
  try {
    const value = await secrets.get(account);
    return value !== null && value.length > 0;
  } catch {
    return false;
  }
}
