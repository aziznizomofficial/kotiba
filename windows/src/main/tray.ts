// The tray icon, wired to `./tray-state.ts` and `./menu-model.ts`.
//
// This file contains no decisions: it renders what those two answer, and it re-renders
// on a theme change because Windows does no tinting of its own.

import { Menu, MenuItemConstructorOptions, Tray, nativeImage, nativeTheme } from 'electron';

import { trayIconDataUrl, TRAY_ICON_SIZES } from './icons.js';
import type { MenuAction, MenuInputs, MenuItem } from './menu-model.js';
import { buildTrayMenu } from './menu-model.js';
import type { TrayImage, TrayInputs, TrayTheme } from './tray-state.js';
import { trayImageFor, trayTooltip } from './tray-state.js';

/**
 * A tray image at every DPI the shell asks for.
 *
 * The first size is the base and the rest are representations, so Windows picks the one
 * that matches the user's scaling rather than smearing a 16 px bitmap across 32 px.
 */
export function trayNativeImage(image: TrayImage, theme: TrayTheme): Electron.NativeImage {
  const [base, ...rest] = TRAY_ICON_SIZES;
  const first = base ?? 16;
  const picture = nativeImage.createFromDataURL(trayIconDataUrl(image, theme, first));
  for (const size of rest) {
    picture.addRepresentation({
      scaleFactor: size / first,
      width: size,
      height: size,
      dataURL: trayIconDataUrl(image, theme, size),
    });
  }
  return picture;
}

/**
 * The six icons this app can ever draw, made once each.
 *
 * `update()` is called on EVERY status change — a press produces `listening`, `working`,
 * `succeeded` and `idle` in a couple of seconds, and the level meter and the blocker list
 * redraw around them. Each of those went through `trayNativeImage`, which supersamples
 * four bitmaps at 16 samples a pixel and `deflateSync`s each one into a PNG. That is the
 * same six pictures, redrawn from scratch, several times per dictation — on the main
 * process's thread, while a dictation is in flight.
 *
 * There are three drawings and two inks. Nothing else varies, so nothing else is keyed on.
 */
const iconCache = new Map<string, Electron.NativeImage>();

export function cachedTrayImage(image: TrayImage, theme: TrayTheme): Electron.NativeImage {
  const key = `${image}:${theme}`;
  const found = iconCache.get(key);
  if (found !== undefined) return found;
  const made = trayNativeImage(image, theme);
  iconCache.set(key, made);
  return made;
}

/**
 * Which ink to draw with right now.
 *
 * `shouldUseDarkColors` reports the app's colour scheme, which on Windows follows the
 * "app mode" setting, while the taskbar follows the SEPARATE "Windows mode" setting —
 * they can genuinely disagree, and Electron exposes no reading of the taskbar's own. The
 * app setting is the closer of the two, and the icon re-renders whenever either moves.
 */
export function currentTrayTheme(): TrayTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export interface TrayController {
  /** Re-render icon, tooltip and menu from a fresh snapshot. Cheap; call it freely. */
  update(inputs: TrayInputs & MenuInputs): void;
  destroy(): void;
}

/**
 * Build the tray.
 *
 * `onAction` receives the typed `MenuAction`, never a label — the menu's text is the
 * user's business and the shell's dispatch must not depend on it.
 */
export function createTray(options: {
  readonly onAction: (action: MenuAction) => void;
  readonly onLeftClick: () => void;
}): TrayController {
  let theme = currentTrayTheme();
  let last: (TrayInputs & MenuInputs) | null = null;

  const tray = new Tray(cachedTrayImage('nib', theme));
  tray.setToolTip('Kotiba');
  // A left click on Windows conventionally does the primary thing rather than opening the
  // menu; the right click opens the menu, which Electron wires for us.
  tray.on('click', () => options.onLeftClick());

  function render(): void {
    if (last === null) return;
    tray.setImage(cachedTrayImage(trayImageFor(last), theme));
    tray.setToolTip(trayTooltip(last));
    tray.setContextMenu(Menu.buildFromTemplate(toTemplate(buildTrayMenu(last), options.onAction)));
  }

  // Windows gives the icon no template treatment, so a theme flip with no re-render
  // leaves a white icon on a white taskbar — an app that looks like it has crashed.
  const onThemeChange = (): void => {
    theme = currentTrayTheme();
    render();
  };
  nativeTheme.on('updated', onThemeChange);

  return {
    update(inputs) {
      last = inputs;
      render();
    },
    destroy() {
      nativeTheme.removeListener('updated', onThemeChange);
      tray.destroy();
    },
  };
}

/** `MenuItem` → Electron's template. The only place the two vocabularies meet. */
export function toTemplate(
  items: readonly MenuItem[],
  onAction: (action: MenuAction) => void,
): MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (item.kind === 'separator') return { type: 'separator' };
    if (item.kind === 'header') {
      // macOS uses a Text section header. Windows menus have no header item, so it is a
      // disabled label — visually the same, and it cannot be clicked.
      return { label: item.label, enabled: false };
    }
    return {
      label: item.label,
      enabled: item.enabled,
      // A real checkbox item, not a "✓ " glyph baked into the label: doing both draws both.
      ...(item.checked === undefined
        ? {}
        : { type: 'checkbox' as const, checked: item.checked }),
      ...(item.accelerator === null ? {} : { accelerator: item.accelerator }),
      click: () => onAction(item.action),
    };
  });
}
