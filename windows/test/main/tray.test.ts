// The tray icon's four inputs, the menu's order, and the two inks.
//
// "An icon that only shows idle/recording looks healthy on a machine that cannot dictate
// Uzbek at all" — so the blocker input gets as much attention here as the dictation one.

import { describe, expect, it } from 'vitest';

import type { Blocker, DictationStatus, Language, Mode } from '../../src/contracts/index.js';
import { inkCoverage, rasteriseTrayIcon, TRAY_ICON_SIZES, trayIconPng } from '../../src/main/icons.js';
import { buildTrayMenu, copyLastPreview, MENU_LANGUAGE_NAMES } from '../../src/main/menu-model.js';
import type { MenuItem } from '../../src/main/menu-model.js';
import {
  TRAY_ICON_STATES,
  TRAY_IMAGES,
  trayIconState,
  trayImageFor,
  trayInkFor,
  trayTooltip,
} from '../../src/main/tray-state.js';

const NO_BLOCKERS: readonly Blocker[] = [];
const ONE_BLOCKER: readonly Blocker[] = [
  { id: 'uzbek-model', headline: 'No Uzbek model', detail: 'Download it in Settings › Languages.' },
];

function inputs(
  status: DictationStatus,
  blockers: readonly Blocker[] = NO_BLOCKERS,
  downloading: string | null = null,
) {
  return { status, blockers, downloading };
}

describe('the tray icon has four inputs, not two', () => {
  it('1. the dictation lifecycle', () => {
    expect(trayIconState(inputs({ kind: 'listening' }))).toBe('recording');
    expect(trayIconState(inputs({ kind: 'working', stage: 'transcribing' }))).toBe('working');
    expect(trayIconState(inputs({ kind: 'failed', message: 'Pasting timed out.' }))).toBe('error');
  });

  it('2. model preparation turns the icon solid with nobody speaking', () => {
    expect(trayIconState(inputs({ kind: 'preparing', what: 'Uzbek model' }))).toBe('working');
  });

  it('3. a download is a preparing state too, even once the dictation settled', () => {
    // macOS `download()` sets readiness = .preparing(entry.name), so the icon is solid
    // through a fetch that nobody started by pressing anything.
    expect(trayIconState(inputs({ kind: 'idle' }, NO_BLOCKERS, 'whisper base q5_1'))).toBe('working');
    expect(trayIconState(inputs({ kind: 'succeeded', text: 'hi' }, NO_BLOCKERS, 'x'))).toBe('working');
  });

  it('4. THE ONE A PORT DROPS: idle with any blocker is not healthy', () => {
    expect(trayIconState(inputs({ kind: 'idle' }, NO_BLOCKERS))).toBe('idle');
    expect(trayIconState(inputs({ kind: 'idle' }, ONE_BLOCKER))).toBe('error');
    // A fresh install is idle AND blocked, and the icon must say so.
    expect(trayImageFor(inputs({ kind: 'idle' }, ONE_BLOCKER))).toBe('nib-slash');
  });

  it('succeeded and heardNothing take the blocker branch, as macOS does', () => {
    expect(trayIconState(inputs({ kind: 'succeeded', text: 'hi' }, ONE_BLOCKER))).toBe('error');
    expect(trayIconState(inputs({ kind: 'heardNothing' }, ONE_BLOCKER))).toBe('error');
    expect(trayIconState(inputs({ kind: 'heardNothing' }, NO_BLOCKERS))).toBe('idle');
  });

  it('a dictation in flight beats a blocker — status is already the resolved one', () => {
    expect(trayIconState(inputs({ kind: 'listening' }, ONE_BLOCKER))).toBe('recording');
  });

  it('recording and working share ONE drawing, deliberately', () => {
    // A fourth silhouette at tray size would be invisible; the HUD reports the difference.
    expect(trayImageFor(inputs({ kind: 'listening' }))).toBe('nib-filled');
    expect(trayImageFor(inputs({ kind: 'preparing', what: 'Uzbek model' }))).toBe('nib-filled');
    expect(new Set(TRAY_ICON_STATES.map((s) => s)).size).toBe(4);
    expect(TRAY_IMAGES).toHaveLength(3);
  });
});

describe('the tooltip renders the state that already exists', () => {
  it('names the thing being loaded', () => {
    expect(trayTooltip(inputs({ kind: 'preparing', what: 'Uzbek model' }))).toContain('Uzbek model');
  });

  it('names the first blocker and counts the rest', () => {
    const many: Blocker[] = [
      { id: 'uzbek-model', headline: 'No Uzbek model', detail: null },
      { id: 'microphone', headline: 'The microphone is not ready', detail: null },
    ];
    const tooltip = trayTooltip(inputs({ kind: 'idle' }, many));
    expect(tooltip).toContain('No Uzbek model');
    expect(tooltip).toContain('and 1 more');
  });

  it('never leaves the slot empty', () => {
    for (const status of [
      { kind: 'idle' } as const,
      { kind: 'listening' } as const,
      { kind: 'heardNothing' } as const,
      { kind: 'succeeded', text: 'x' } as const,
    ]) {
      expect(trayTooltip(inputs(status)).length).toBeGreaterThan(6);
    }
  });
});

describe('the two inks', () => {
  it('a LIGHT taskbar gets DARK ink — inverting this is the invisible-icon bug', () => {
    expect(trayInkFor('light')).toBe('#000000');
    expect(trayInkFor('dark')).toBe('#ffffff');
  });

  it('the two inks differ in colour and agree in shape', () => {
    const light = rasteriseTrayIcon('nib', 'light', 16);
    const dark = rasteriseTrayIcon('nib', 'dark', 16);
    expect(light.equals(dark)).toBe(false);
    // Same coverage: the alpha channel is the drawing, and only the RGB moved.
    for (let i = 3; i < light.length; i += 4) expect(light[i]).toBe(dark[i]);
  });

  it('every drawing is visible at every size in both inks', () => {
    // A drawing that rasterises to nothing looks exactly like a crashed app.
    for (const image of TRAY_IMAGES) {
      for (const theme of ['light', 'dark'] as const) {
        for (const size of TRAY_ICON_SIZES) {
          const coverage = inkCoverage(image, theme, size);
          expect(coverage).toBeGreaterThan(0.05);
          expect(coverage).toBeLessThan(0.9);
        }
      }
    }
  });

  it('the three drawings are actually different drawings', () => {
    const [a, b, c] = TRAY_IMAGES.map((image) => rasteriseTrayIcon(image, 'dark', 24));
    expect(a?.equals(b ?? Buffer.alloc(0))).toBe(false);
    expect(a?.equals(c ?? Buffer.alloc(0))).toBe(false);
    expect(b?.equals(c ?? Buffer.alloc(0))).toBe(false);
  });

  it('emits a real PNG', () => {
    const png = trayIconPng('nib', 'dark', 16);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
  });
});

// ---------------------------------------------------------------------------------

function mode(key: 'super' | 'note' | 'message', name: string): Mode {
  return {
    key,
    name,
    prompt: 'x',
    language: null,
    contextFromSelection: false,
    contextFromClipboard: false,
    contextFromActiveApplication: false,
    activationApps: [],
    autocapitalizeInsert: true,
    restructures: false,
  };
}

const MODES = [mode('super', 'Super'), mode('note', 'Note'), mode('message', 'Message')];

function menu(overrides: Partial<Parameters<typeof buildTrayMenu>[0]> = {}): readonly MenuItem[] {
  return buildTrayMenu({
    status: { kind: 'idle' },
    lastTranscript: null,
    blockers: NO_BLOCKERS,
    modeFollowsApp: false,
    userPickedMode: null,
    activeModeKey: 'super',
    selectableModes: MODES,
    pinnedLanguage: null,
    pinnableLanguages: ['en'],
    languageOrder: ['uz', 'en', 'ru'],
    alwaysOn: false,
    ...overrides,
  });
}

function ids(items: readonly MenuItem[]): string[] {
  return items.flatMap((item) => (item.kind === 'item' ? [item.id] : []));
}

describe('the tray menu', () => {
  it('has the macOS order, plus History', () => {
    expect(ids(menu())).toEqual([
      'open',
      'mode-super',
      'mode-note',
      'mode-message',
      'language-automatic',
      'language-en',
      'history',
      'settings',
      'quit',
    ]);
  });

  it('opens with "Open Kotiba", as the Mac 1.0 menu does', () => {
    const first = menu()[0];
    expect(first).toMatchObject({ kind: 'item', id: 'open', label: 'Open Kotiba', action: { kind: 'openMain' } });
  });

  it('with Always on, the only way out is named for what it does', () => {
    const items = menu({ alwaysOn: true });
    expect(ids(items)).not.toContain('quit');
    expect(items.at(-1)).toMatchObject({
      kind: 'item',
      label: 'Turn Off Always On & Quit',
      action: { kind: 'quitForReal' },
    });
    expect(menu().at(-1)).toMatchObject({ label: 'Quit Kotiba', action: { kind: 'quit' } });
  });

  it('offers Copy last only when there is something to copy', () => {
    expect(ids(menu())).not.toContain('copy-last');
    expect(ids(menu({ lastTranscript: '' }))).not.toContain('copy-last');
    expect(ids(menu({ lastTranscript: 'hello' }))).toContain('copy-last');
  });

  it('truncates the Copy-last preview at 40 characters', () => {
    expect(copyLastPreview('a'.repeat(40))).toBe('a'.repeat(40));
    expect(copyLastPreview('a'.repeat(41))).toBe(`${'a'.repeat(40)}…`);
    expect(copyLastPreview('a'.repeat(41))).toHaveLength(41);
  });

  it('shows every blocker, including the ones with nothing to click', () => {
    // The blocker rows are the app's only explanation of a failure. A row that renders
    // as disabled is a row a user reads as "not my problem".
    const items = menu({ blockers: ONE_BLOCKER });
    const row = items.find((i) => i.kind === 'item' && i.id === 'blocker-uzbek-model');
    expect(row).toBeDefined();
    expect(row?.kind === 'item' && row.enabled).toBe(true);
    expect(row?.kind === 'item' && row.label).toContain('No Uzbek model');
  });

  it('hides Automatic for modes unless app-following is on', () => {
    expect(ids(menu())).not.toContain('mode-automatic');
    expect(ids(menu({ modeFollowsApp: true }))).toContain('mode-automatic');
  });

  it('ticks the active mode when app-following is off, and the picked one when it is on', () => {
    const off = menu({ modeFollowsApp: false, activeModeKey: 'note', userPickedMode: null });
    expect(off.find((i) => i.kind === 'item' && i.id === 'mode-note')).toMatchObject({
      checked: true,
    });

    const on = menu({ modeFollowsApp: true, activeModeKey: 'note', userPickedMode: 'message' });
    expect(on.find((i) => i.kind === 'item' && i.id === 'mode-note')).toMatchObject({
      checked: false,
    });
    expect(on.find((i) => i.kind === 'item' && i.id === 'mode-message')).toMatchObject({
      checked: true,
    });
    expect(on.find((i) => i.kind === 'item' && i.id === 'mode-automatic')).toMatchObject({
      checked: false,
    });
  });

  it('never offers Raw — it is reached only through the credential gate', () => {
    expect(ids(menu())).not.toContain('mode-transcription');
  });

  it('lists only languages whose model resolves, and ticks Automatic for a null pin', () => {
    const items = menu({ pinnableLanguages: ['en', 'uz'], pinnedLanguage: 'uz' });
    expect(ids(items)).toContain('language-uz');
    expect(ids(items)).not.toContain('language-ru');
    expect(items.find((i) => i.kind === 'item' && i.id === 'language-automatic')).toMatchObject({
      checked: false,
    });
    expect(items.find((i) => i.kind === 'item' && i.id === 'language-uz')).toMatchObject({
      checked: true,
    });
  });

  it('lists the languages in the given order, whatever order they were pinnable in', () => {
    const listed = (order: Language[]): string[] =>
      ids(menu({ pinnableLanguages: ['en', 'ru', 'uz'], languageOrder: order })).filter((id) => id !== 'language-automatic' && id.startsWith('language-'));
    expect(listed(['uz', 'en', 'ru'])).toEqual(['language-uz', 'language-en', 'language-ru']);
    expect(listed(['ru', 'uz', 'en'])).toEqual(['language-ru', 'language-uz', 'language-en']);
  });

  it('uses the MENU language names, which are not the Settings ones', () => {
    const items = menu({ pinnableLanguages: ['en', 'ru', 'uz'] });
    const labels = items.flatMap((i) => (i.kind === 'item' ? [i.label] : []));
    expect(labels).toContain('Russian');
    expect(labels).toContain('Uzbek');
    expect(labels).not.toContain('Русский');
    expect(MENU_LANGUAGE_NAMES.uz).toBe('Uzbek');
  });

  it('draws selection as a flag, not as a "✓ " glyph in the label', () => {
    // Windows menus have real checkbox items. Encoding the glyph would draw both.
    for (const item of menu({ pinnableLanguages: ['en'] })) {
      if (item.kind === 'item') expect(item.label).not.toContain('✓');
    }
  });
});
