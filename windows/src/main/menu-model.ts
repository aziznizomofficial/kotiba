// The tray menu, as data. PURE — no electron, no fs.
//
// Ported from `MenuContent` (Apps/macOS/KotibaMacApp.swift:51), mapped in
// docs/windows/inventory/ui-parity.md § "MenuContent — the complete menu".
//
// Item ORDER is behaviour, not layout: the tests assert it, and a user who has learnt
// where "Uzbek" sits reaches for it without reading. The macOS order is reproduced
// exactly, with ONE addition — a "History…" item, which the Windows brief asks for and
// macOS does not have (there, history is reachable only through Settings › History).
//
// macOS draws selection with a literal "✓ " PREFIX inside the button title rather than
// a system checkmark, because a SwiftUI `Menu` of `Button`s has no checkmark. A Windows
// `Menu` has real `type: 'checkbox'` items, so the tick is a FLAG here and the label
// stays clean. That is a rendering difference with the same meaning; encoding "✓ " into
// a Windows menu label would draw a tick AND a glyph.

import type { Blocker, DictationStatus } from '../contracts/index.js';
import type { Language, Mode, ModeKey } from '../contracts/index.js';

import { builtInModeName, speechLanguageName, t } from '../core/i18n/index.js';

import { LIFECYCLE_COPY } from './lifecycle.js';


/** Where a click goes. The shell switches on this; it never parses a label. */
export type MenuAction =
  | { readonly kind: 'openMain' }
  | { readonly kind: 'copyLast' }
  | { readonly kind: 'showBlocker'; readonly blockerId: string }
  | { readonly kind: 'clearPickedMode' }
  | { readonly kind: 'setMode'; readonly key: ModeKey }
  | { readonly kind: 'setPinnedLanguage'; readonly language: Language | null }
  | { readonly kind: 'openHistory' }
  | { readonly kind: 'openSettings' }
  | { readonly kind: 'quit' }
  /** "Turn Off Always On & Quit" — the one exit from an always-on Kotiba. */
  | { readonly kind: 'quitForReal' };

export type MenuItem =
  | { readonly kind: 'separator' }
  | { readonly kind: 'header'; readonly label: string }
  | {
      readonly kind: 'item';
      readonly id: string;
      readonly label: string;
      readonly action: MenuAction;
      /** Renders as a checkbox item when true or false; a plain item when absent. */
      readonly checked?: boolean;
      readonly enabled: boolean;
      /** Electron accelerator, e.g. `CmdOrCtrl+,`. `null` for most items. */
      readonly accelerator: string | null;
    };

/** Everything the menu is built from. One snapshot, no live reads. */
export interface MenuInputs {
  readonly status: DictationStatus;
  /** `null` or empty suppresses the "Copy last" item entirely, as macOS does. */
  readonly lastTranscript: string | null;
  readonly blockers: readonly Blocker[];
  readonly modeFollowsApp: boolean;
  /** `null` is "Automatic" — a real choice, and the tick lands on Automatic. */
  readonly userPickedMode: ModeKey | null;
  /** What `resolveMode()` last answered. Ticked when `modeFollowsApp` is off. */
  readonly activeModeKey: ModeKey;
  /** Exactly `super`, `note`, `message` in that order — never `transcription`. */
  readonly selectableModes: readonly Mode[];
  readonly pinnedLanguage: Language | null;
  /** Only languages whose model resolves. English is always present. */
  readonly pinnableLanguages: readonly Language[];
  /** The order the languages are listed in (default, then recent use); see core/languages. */
  readonly languageOrder: readonly Language[];
  /** Decides the last item: "Quit Kotiba", or "Turn Off Always On & Quit". */
  readonly alwaysOn: boolean;
}

/** macOS truncates the Copy-last preview at 40 characters, then appends an ellipsis. */
export const COPY_LAST_PREVIEW_LENGTH = 40;

/** The literal glyph macOS prepends to a blocker row. Kept — it is what users recognise. */
export const BLOCKER_PREFIX = '⚠ ';

/**
 * The MENU's language names, which are deliberately DIFFERENT from the window's. macOS
 * `DictationController.name(of:)` says English/Russian/Uzbek here and
 * English/Русский/Oʻzbekcha everywhere else (`LANGUAGE_NAMES` in the renderer).
 */
export const MENU_LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  get en(): string {
    return speechLanguageName('en');
  },
  get ru(): string {
    return speechLanguageName('ru');
  },
  get uz(): string {
    return speechLanguageName('uz');
  },
  get tr(): string {
    return speechLanguageName('tr');
  },
  get ar(): string {
    return speechLanguageName('ar');
  },
};

export function copyLastPreview(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const glyphs = [...flat];
  if (glyphs.length <= COPY_LAST_PREVIEW_LENGTH) return flat;
  return `${glyphs.slice(0, COPY_LAST_PREVIEW_LENGTH).join('')}…`;
}

/**
 * The whole menu, in order.
 *
 * The order and every conditional here is transcribed from the Swift; the numbered
 * comments are its numbered sections.
 */
export function buildTrayMenu(inputs: MenuInputs): readonly MenuItem[] {
  const items: MenuItem[] = [];

  // 0. "Open Kotiba", first, as on the Mac 1.0 menu: the app window is the app now.
  items.push(
    {
      kind: 'item',
      id: 'open',
      label: t('menu.open'),
      action: { kind: 'openMain' },
      enabled: true,
      accelerator: null,
    },
    { kind: 'separator' },
  );

  // 1. Copy last — present only when there is something to copy.
  const last = inputs.lastTranscript;
  if (last !== null && last.length > 0) {
    items.push({
      kind: 'item',
      id: 'copy-last',
      label: t('menu.copyLast', { text: copyLastPreview(last) }),
      action: { kind: 'copyLast' },
      enabled: true,
      accelerator: null,
    });
  }

  // 2. One row per blocker. macOS shows blockers with no settings URL too — they are
  //    still the only explanation the user gets — so every row is ENABLED and clicking
  //    one opens Home, where the detail sentence and its Fix button live.
  if (inputs.blockers.length > 0) {
    items.push({ kind: 'separator' });
    for (const blocker of inputs.blockers) {
      items.push({
        kind: 'item',
        id: `blocker-${blocker.id}`,
        label: `${BLOCKER_PREFIX}${blocker.headline}`,
        action: { kind: 'showBlocker', blockerId: blocker.id },
        enabled: true,
        accelerator: null,
      });
    }
  }

  // 3–5. Mode.
  items.push({ kind: 'separator' }, { kind: 'header', label: t('menu.mode') });
  if (inputs.modeFollowsApp) {
    // ABSENT when modeFollowsApp is off, exactly as macOS has it: with app-following
    // off there is nothing for "Automatic" to mean.
    items.push({
      kind: 'item',
      id: 'mode-automatic',
      label: t('common.automatic'),
      action: { kind: 'clearPickedMode' },
      checked: inputs.userPickedMode === null,
      enabled: true,
      accelerator: null,
    });
  }
  for (const mode of inputs.selectableModes) {
    const checked = inputs.modeFollowsApp
      ? inputs.userPickedMode === mode.key
      : inputs.activeModeKey === mode.key;
    items.push({
      kind: 'item',
      id: `mode-${mode.key}`,
      label: builtInModeName(mode.key) ?? mode.name,
      action: { kind: 'setMode', key: mode.key },
      checked,
      enabled: true,
      accelerator: null,
    });
  }

  // 6–8. Language.
  items.push({ kind: 'separator' }, { kind: 'header', label: t('menu.language') });
  items.push({
    kind: 'item',
    id: 'language-automatic',
    label: t('common.automatic'),
    action: { kind: 'setPinnedLanguage', language: null },
    checked: inputs.pinnedLanguage === null,
    enabled: true,
    accelerator: null,
  });
  const listed = (language: Language): number => {
    const index = inputs.languageOrder.indexOf(language);
    return index < 0 ? inputs.languageOrder.length : index;
  };
  for (const language of [...inputs.pinnableLanguages].sort((a, b) => listed(a) - listed(b))) {
    items.push({
      kind: 'item',
      id: `language-${language}`,
      label: MENU_LANGUAGE_NAMES[language],
      action: { kind: 'setPinnedLanguage', language },
      checked: inputs.pinnedLanguage === language,
      enabled: true,
      accelerator: null,
    });
  }

  // 9. The tail. "History…" is the Windows addition; Settings and Quit are macOS's,
  //    with Windows accelerators (there is no ⌘).
  items.push({ kind: 'separator' });
  items.push({
    kind: 'item',
    id: 'history',
    label: t('menu.history'),
    action: { kind: 'openHistory' },
    enabled: true,
    accelerator: null,
  });
  items.push({
    kind: 'item',
    id: 'settings',
    label: t('menu.settings'),
    action: { kind: 'openSettings' },
    enabled: true,
    accelerator: 'Ctrl+,',
  });
  // With always-on, Quit only hides — so the menu does not offer a Quit that would not
  // quit. It offers the one that does, named for what it does. The Mac's two items.
  items.push(
    inputs.alwaysOn
      ? {
          kind: 'item',
          id: 'quit-for-real',
          label: LIFECYCLE_COPY.trayQuitForReal,
          action: { kind: 'quitForReal' },
          enabled: true,
          accelerator: null,
        }
      : {
          kind: 'item',
          id: 'quit',
          label: LIFECYCLE_COPY.trayQuit,
          action: { kind: 'quit' },
          enabled: true,
          accelerator: 'Ctrl+Q',
        },
  );

  return items;
}
