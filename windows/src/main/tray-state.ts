// The tray icon's state machine, and nothing else. PURE — no electron, no fs.
//
// Ported from `menuIcon` (Apps/macOS/KotibaMacApp.swift:38), mapped in
// docs/windows/inventory/ui-parity.md § "menuIcon — the status item's four visual states".
//
// THE ICON HAS FOUR INPUTS, NOT TWO. A port that renders only idle/recording shows a
// healthy icon on a machine that cannot dictate Uzbek at all:
//
//   1. the dictation lifecycle   (`listening`, `working`)
//   2. model PREPARATION         (`preparing` — a cold 539 MB load at launch)
//   3. model DOWNLOADING         (macOS `download()` also sets readiness = .preparing)
//   4. the blocker list          (non-empty on nearly every fresh install)
//
// Inputs 2 and 3 arrive as the same `preparing` status on macOS, which is why the
// caller passes `downloading` separately: on Windows it is worth a distinct TOOLTIP,
// but it must NOT get a distinct glyph — see `TRAY_IMAGE_BY_STATE`.

import type { Blocker, DictationStatus } from '../contracts/index.js';
import { t } from '../core/i18n/index.js';

import { stageName } from './live-status.js';

/**
 * The four states the status item expresses.
 *
 * `recording` and `working` deliberately collapse onto ONE drawing (see
 * `TRAY_IMAGE_BY_STATE`): the macOS comment states outright that a fourth silhouette at
 * 18 points would be invisible, and the HUD is what reports the difference. They stay
 * separate here because the tooltip and the tests distinguish them.
 */
export const TRAY_ICON_STATES = ['idle', 'recording', 'working', 'error'] as const;
export type TrayIconState = (typeof TRAY_ICON_STATES)[number];

/** The three drawings. macOS: MenuBarNib / MenuBarNibFilled / MenuBarNibSlash. */
export const TRAY_IMAGES = ['nib', 'nib-filled', 'nib-slash'] as const;
export type TrayImage = (typeof TRAY_IMAGES)[number];

/**
 * Four states, three drawings. Changing this table changes what the user sees; adding a
 * fourth drawing is a divergence from macOS, not an improvement.
 */
export const TRAY_IMAGE_BY_STATE: Readonly<Record<TrayIconState, TrayImage>> = {
  idle: 'nib',
  recording: 'nib-filled',
  working: 'nib-filled',
  error: 'nib-slash',
};

/** Everything the icon is computed from. */
export interface TrayInputs {
  /** Already `isRunning ? dictation : readiness` — the two-dimensional status, resolved. */
  readonly status: DictationStatus;
  readonly blockers: readonly Blocker[];
  /** The name of a model being fetched right now, or `null`. Input 3. */
  readonly downloading: string | null;
}

/**
 * The state machine, transcribed from the Swift `switch` and in the same order.
 *
 * The default arm — `idle`, `succeeded`, `heardNothing` — is where the blocker list
 * enters: an idle app with any blocker is slashed, because on a default install it
 * genuinely cannot dictate Uzbek.
 */
export function trayIconState(inputs: TrayInputs): TrayIconState {
  const { status, blockers, downloading } = inputs;
  switch (status.kind) {
    case 'listening':
      return 'recording';
    case 'preparing':
    case 'working':
      return 'working';
    case 'failed':
      return 'error';
    case 'idle':
    case 'succeeded':
    case 'heardNothing':
      // A download is a readiness state macOS also renders solid, and it can be in
      // flight while `status` has already settled back to idle.
      if (downloading !== null) return 'working';
      return blockers.length === 0 ? 'idle' : 'error';
  }
}

export function trayImageFor(inputs: TrayInputs): TrayImage {
  return TRAY_IMAGE_BY_STATE[trayIconState(inputs)];
}

/**
 * WINDOWS ADDITION, and a deliberate one: macOS has no tooltip because a menu-bar item
 * has nowhere to put one, and the icon is "the entire status display". A Windows tray
 * icon has a tooltip slot that is empty if nobody fills it, and the four states are
 * otherwise indistinguishable at 16 px for a user who has not read the manual.
 *
 * It adds no state and no control — it renders the state that already exists.
 */
export function trayTooltip(inputs: TrayInputs): string {
  const { status, blockers, downloading } = inputs;
  if (status.kind === 'listening') return t('tray.listening');
  if (status.kind === 'preparing') return t('tray.loading', { what: status.what });
  if (status.kind === 'working') return t('tray.working', { stage: stageName(status.stage) });
  if (status.kind === 'failed') return t('tray.working', { stage: status.message });
  if (downloading !== null) return t('tray.downloading', { what: downloading });
  if (blockers.length === 0) return t('tray.ready');
  const first = blockers[0];
  const rest = blockers.length - 1;
  const suffix = rest > 0 ? t('tray.andMore', { count: rest }) : '';
  return t('tray.working', { stage: `${first === undefined ? t('tray.somethingNeedsAttention') : first.headline}${suffix}` });
}

/**
 * Windows tray icons get NO template-image tinting. macOS recolours one 18x18 asset for
 * light, dark and the highlighted-menu state; Windows draws the bitmap exactly as given,
 * so a dark-ink icon is invisible on a dark taskbar and vice versa.
 *
 * Two assets per drawing, therefore, and the shell must re-pick on every theme change.
 */
export const TRAY_THEMES = ['light', 'dark'] as const;
export type TrayTheme = (typeof TRAY_THEMES)[number];

/**
 * The taskbar's own background, not the app's: a LIGHT taskbar needs DARK ink.
 * Inverting this is the bug that makes the icon vanish on exactly one of the two.
 */
export function trayInkFor(theme: TrayTheme): '#000000' | '#ffffff' {
  return theme === 'light' ? '#000000' : '#ffffff';
}

/** Asset key: drawing plus theme, e.g. `nib-filled@dark`. */
export function trayAssetKey(image: TrayImage, theme: TrayTheme): string {
  return `${image}@${theme}`;
}
