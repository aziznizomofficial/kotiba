// Every window the app owns. Imports `electron`, and only `src/main` and `src/renderer` may.
//
// Four windows, and one of them has a property the product depends on absolutely.
//
// THE HUD MUST NEVER TAKE KEY FOCUS. On macOS that is a `.nonactivatingPanel` with
// `becomesKeyOnlyIfNeeded` that is shown with `orderFrontRegardless()` and never with
// `makeKeyAndOrderFront`. On Windows it is WS_EX_NOACTIVATE plus WS_EX_TOOLWINDOW,
// click-through via WS_EX_TRANSPARENT, always-on-top above full-screen apps, visible
// across virtual desktops — and `SetForegroundWindow` never called on it.
//
// A HUD that steals focus moves the caret out of the application being dictated into,
// and then the words are typed into the HUD's own web page and the product does not work
// at all. Electron exposes each of those flags, and `showInactive()` is the one show
// method that does not activate. `show()` and `focus()` are therefore never called on
// it — `guardAgainstFocus` makes that a property of the running window rather than a
// promise about the code.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BrowserWindow, app, screen, shell } from 'electron';

import { t } from '../core/i18n/index.js';

import {
  CAPTURE_PAGE_HTML,
  CAPTURE_RENDERER_SOURCE,
  CAPTURE_WORKLET_SOURCE,
} from '../audio/index.js';

import { captureBootstrap } from './audio-host.js';
import { preloadScript, rendererFile } from './paths.js';
import { PILL_CANVAS_HEIGHT, PILL_CANVAS_WIDTH, PILL_MAX_MESSAGE_WIDTH, pillCanvasBounds, pillMaxMessageWidth } from './pill-model.js';
import {
  MAIN_WINDOW_HEIGHT,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  MAIN_WINDOW_WIDTH,
  TITLE_BAR_HEIGHT,
} from './settings-model.js';

/** The preload is the ONLY thing bridging main and a renderer. No node in any page. */
function webPreferences(): Electron.WebPreferences {
  return {
    preload: preloadScript(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
  };
}

/**
 * Anything a page tries to open goes to the user's browser, not to a new Electron window.
 *
 * There is exactly one link in this app — the endpoint documentation — and a
 * `window.open` that produced a chrome-less Electron window with no address bar would be
 * a phishing surface in a program people install from a Telegram message.
 */
function openLinksExternally(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  stayOnPage(window);
}

/**
 * A Kotiba window never navigates away from its own page.
 *
 * Electron's default navigates a window to any file DROPPED on it, and a link or script can
 * do the same — and the page that replaces Kotiba's keeps the preload, i.e. the whole
 * `window.kotiba` bridge (`settings:set`, `secret:set`, `app:quit-for-real`, …), while the
 * real UI is gone until a restart. `loadFile` and `reload()` do not raise `will-navigate`,
 * so the app's own loads are unaffected.
 */
function stayOnPage(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
}

// ---------------------------------------------------------------------------------
// The HUD
// ---------------------------------------------------------------------------------

/**
 * Belt and braces on the one property that matters.
 *
 * `focusable: false` should make this unreachable. It is wired anyway because the cost
 * of being wrong is that every dictation goes into the wrong window, and because a
 * future change to how the HUD is shown would otherwise fail silently and in a way
 * nobody could reproduce from a bug report.
 */
export function guardAgainstFocus(window: BrowserWindow): void {
  window.on('focus', () => {
    window.blur();
  });
}

export function createHudWindow(): BrowserWindow {
  const hud = new BrowserWindow({
    // A fixed canvas a little larger than the widest capsule plus its shadow. The capsule
    // animates INSIDE it (the Mac's `HUDPanel.canvas`), so no state change ever resizes a
    // window — native resizing on every state change would put the window manager on the
    // path of every frame of the pill's spring.
    width: PILL_CANVAS_WIDTH,
    height: PILL_CANVAS_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // WS_EX_NOACTIVATE. Without it a show() activates the window and moves the caret.
    focusable: false,
    // WS_EX_TOOLWINDOW: no taskbar button, no Alt-Tab entry.
    skipTaskbar: true,
    alwaysOnTop: true,
    // The pill draws its own shadow; a native one on a transparent window is a rectangle.
    hasShadow: false,
    acceptFirstMouse: false,
    // Windows' equivalent of a floating utility panel.
    type: 'toolbar',
    // `autoplayPolicy`: the start/stop sounds (Settings › Sound) play from this page with no
    // user gesture in it — there never is one, it cannot be clicked.
    webPreferences: {
      ...webPreferences(),
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // `screen-saver` is the highest level Electron offers, and it is what keeps the pill
  // visible over a full-screen or exclusive-mode application.
  hud.setAlwaysOnTop(true, 'screen-saver');
  // Across virtual desktops. A pill that only exists on desktop 1 is worse than none.
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // WS_EX_TRANSPARENT: it is a readout, never a control. Clicks pass through to the app
  // underneath, which is where the user's caret is.
  hud.setIgnoreMouseEvents(true, { forward: false });
  hud.setFocusable(false);
  guardAgainstFocus(hud);
  openLinksExternally(hud);

  void hud.loadFile(rendererFile('hud'));
  return hud;
}

/**
 * Bottom centre of the display the mouse is on, above the taskbar — where the Mac puts it
 * above the Dock. The work area, not the bounds: a taskbar must not cover the pill.
 */
export function positionHud(hud: BrowserWindow): void {
  const point = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(point);
  hud.setBounds(pillCanvasBounds(workArea), false);
  hudMessageWidth = pillMaxMessageWidth(workArea.width);
}

let hudMessageWidth: number = PILL_MAX_MESSAGE_WIDTH;

/** How wide a message may make the capsule on the monitor the pill was last put on. */
export function hudMaxMessageWidth(): number {
  return hudMessageWidth;
}

/**
 * Show it WITHOUT activating it.
 *
 * `showInactive()` is the whole reason this function exists rather than a call site
 * writing `hud.show()`. The macOS twin is `orderFrontRegardless()`, chosen over
 * `makeKeyAndOrderFront` for exactly the same reason.
 */
export function showHud(hud: BrowserWindow): void {
  positionHud(hud);
  hud.showInactive();
  // Re-asserted on every show: another always-on-top window that appeared since the last
  // one can otherwise sit above it.
  hud.setAlwaysOnTop(true, 'screen-saver');
  // Top of its own level too: another screen-saver-level window (an overlay, a video player's
  // full-screen controls) would otherwise keep the place it had.
  hud.moveTop();
}

export function hideHud(hud: BrowserWindow): void {
  if (hud.isVisible()) hud.hide();
}

// ---------------------------------------------------------------------------------
// The app window
// ---------------------------------------------------------------------------------

/**
 * Home, History, Statistics, Modes, Languages, Hotkey, Settings — and onboarding, which
 * covers it on first run.
 *
 * FRAMELESS, BUT NATIVE WHERE IT COUNTS. `titleBarStyle: 'hidden'` with a
 * `titleBarOverlay` keeps Windows' own minimise / maximise / close buttons — including
 * the Snap Layouts flyout on hovering maximise — drawn over our black strip, and the
 * page marks that strip `-webkit-app-region: drag`, so dragging, double-click to
 * maximise, Win+arrow snapping and Aero Shake all behave as in any Windows app. A
 * hand-drawn set of caption buttons would lose Snap Layouts, which Windows only offers on
 * a real maximise button.
 *
 * Closing is NOT quitting and not a commit: every control has already written and saved,
 * so `close` hides, and Quit is the tray's (or Ctrl+Q's) business.
 */
export function createMainWindow(
  options: {
    readonly onClose?: () => void;
    /** True once a quit is under way: then the window really closes. */
    readonly mayClose?: () => boolean;
  } = {},
): BrowserWindow {
  const main = new BrowserWindow({
    width: MAIN_WINDOW_WIDTH,
    height: MAIN_WINDOW_HEIGHT,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: false,
    title: 'Kotiba',
    backgroundColor: '#000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#000000',
      symbolColor: '#e8e8ea',
      height: TITLE_BAR_HEIGHT,
    },
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });

  main.on('close', (event) => {
    if (options.mayClose?.() === true) return;
    // A tray app whose window destroys itself has to rebuild every page, and the pages
    // each re-query models, history and diagnostics to draw.
    event.preventDefault();
    main.hide();
    options.onClose?.();
  });
  openLinksExternally(main);

  void main.loadFile(rendererFile('main'));
  return main;
}

// ---------------------------------------------------------------------------------
// The hidden audio renderer (D-W6)
// ---------------------------------------------------------------------------------

/**
 * The microphone, which on this port is a web page.
 *
 * D-W6: `getUserMedia` plus an `AudioWorklet` on `new AudioContext({ sampleRate: 16000 })`,
 * so the BROWSER's own high-quality resampler produces the 16 kHz mono float whisper
 * wants. Hand-writing a resampler is how the macOS bug that threw away Uzbek sibilants
 * recurs, and nobody on this project can listen to the output to notice.
 *
 * `backgroundThrottling: false` is not optional. Chromium throttles timers and audio
 * callbacks in a window that is not visible, and this window is NEVER visible — with it
 * left on, capture stutters in a way that reads as a bad microphone.
 *
 * t08 owns what runs inside; this function owns the window and the channel. `ready`
 * resolves once the page is loaded AND t08's source has been injected, which is what
 * `createWindowAudioHost` waits on before it sends its first command.
 */
export interface CaptureWindow {
  readonly window: BrowserWindow;
  /**
   * The CURRENT arming gate. A function, not a promise, because the page can be re-armed.
   *
   * It resolves when the page can accept a command and rejects when it cannot be brought
   * up. After a renderer crash it is replaced with a fresh pending gate while the window
   * reloads, so commands issued in that window WAIT for the new page instead of being
   * posted into a dead one and timing out.
   */
  readonly ready: () => Promise<void>;
}

/** How many times a crashed capture renderer is brought back before we stop trying. */
export const CAPTURE_RELOAD_LIMIT = 3;

/**
 * The page file, written at start-up.
 *
 * NOT `src/renderer/audio.html`, and not a `data:` URL. The page needs two properties at
 * once and those two rule out everything else:
 *
 *   * NO `script-src` RESTRICTION. The `AudioWorklet` module is loaded from a `blob:`
 *     URL, and `audio.html`'s `script-src 'self'` blocks exactly that.
 *   * A TRUSTWORTHY ORIGIN. `getUserMedia` requires a secure context. `file://` is one;
 *     a `data:` URL has an opaque origin and is not, so the microphone is refused before
 *     any permission question is asked.
 *
 * `tsc` copies no assets and `package.json` is frozen (t01 only), so there is no build
 * step that could place this file — writing it is how it comes to exist. It is one line
 * of HTML from `src/audio`, and the temp directory is the right home for a file whose
 * whole content is a compile-time constant.
 */
function capturePageFile(): string {
  const file = join(app.getPath('temp'), 'kotiba-capture.html');
  writeFileSync(file, CAPTURE_PAGE_HTML, 'utf8');
  return file;
}

export function createAudioWindow(
  options: {
    /** Told when the capture renderer dies for good. The shell turns it into a blocker. */
    readonly onGone?: (why: string) => void;
  } = {},
): CaptureWindow {
  const audio = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      ...webPreferences(),
      backgroundThrottling: false,
    },
  });
  stayOnPage(audio);

  // THE ONE PERMISSION THIS APP NEEDS, granted to THIS window and nothing else.
  //
  // Left to the default handler, `getUserMedia` is answered by whatever Electron decides
  // for the whole session; pinned here, the capture window gets the microphone and the
  // Settings, HUD and onboarding pages — which render transcripts and model paths, i.e.
  // content this app did not write — can obtain nothing at all.
  const mayCapture = (contentsId: number | undefined, permission: string): boolean =>
    permission === 'media' && contentsId === audio.webContents.id;

  audio.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(mayCapture(contents?.id, permission));
  });
  // BOTH handlers, and the second is not redundant. `getUserMedia` goes through the
  // REQUEST handler; `navigator.permissions.query({name: 'microphone'})` goes through the
  // CHECK one, and the capture page asks that first and treats `denied` as final. With
  // only the request handler set, whatever Electron's default check answers decides
  // whether warm-up ever gets as far as asking.
  audio.webContents.session.setPermissionCheckHandler((contents, permission) =>
    mayCapture(contents?.id, permission),
  );

  // ---- the arming gate --------------------------------------------------------------
  //
  // Re-created on every load. `AudioHost.send` reads it through `ready()` on each command
  // rather than capturing it once, which is what makes a crash recoverable instead of
  // fifteen-second timeouts for the rest of the session.
  let resolveGate: () => void = () => {};
  let rejectGate: (error: Error) => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  const rearm = (): void => {
    gate = new Promise<void>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    // The rejection is delivered to whoever awaits it inside `AudioHost.send`, and that is
    // the only consumer. A no-op handler keeps Node from calling it unhandled in the
    // window between a failure and the first press.
    gate.catch(() => {
      /* reported through the next command's reply */
    });
  };
  rearm();

  let page: string;
  try {
    page = capturePageFile();
  } catch (error: unknown) {
    // A BLOCKER, NEVER A CRASH — the rule this whole module is built on. The rejection
    // reaches `AudioHost.send`, which answers with a microphone error, which the session
    // already knows how to report. Throwing out of `start()` instead would leave a tray
    // app that vanishes on launch with nothing on screen to act on.
    rejectGate(
      new Error(
        `the capture page could not be written: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return { window: audio, ready: () => gate };
  }

  // `on`, NOT `once`. A capture renderer that crashes is replaced by a fresh one with no
  // `window.__kotibaAudio` and no listener on it, so every load has to be injected into.
  audio.webContents.on('did-finish-load', () => {
    // t08's page, injected: `src/audio` may not import Electron, so its half of D-W6
    // reaches the browser as source. `captureBootstrap` is the glue to the preload, and
    // it waits for that preload to arrive before it reports itself armed.
    audio.webContents
      .executeJavaScript(captureBootstrap(CAPTURE_WORKLET_SOURCE, CAPTURE_RENDERER_SOURCE))
      .then(() => {
        resolveGate();
      })
      .catch((error: unknown) => {
        rejectGate(error instanceof Error ? error : new Error(String(error)));
      });
  });
  audio.webContents.on('did-fail-load', (_event: unknown, code: number, description: string) => {
    rejectGate(new Error(`the capture page did not load (${String(code)}): ${description}`));
  });

  // THE MICROPHONE IS A PROCESS, AND PROCESSES DIE. A `stop` hands back up to 524 seconds
  // of float32 — 33.5 MB — so this is not hypothetical. `closed` does not fire for a
  // crash, so without this the window stays open around a dead renderer, `isDestroyed()`
  // keeps answering false, and every press for the rest of the session is posted into
  // nothing and answered fifteen seconds later with a timeout.
  let reloads = 0;
  audio.webContents.on('render-process-gone', (_event: unknown, details: { reason: string }) => {
    reloads += 1;
    if (reloads > CAPTURE_RELOAD_LIMIT) {
      rejectGate(
        new Error(`the capture window died ${String(reloads)} times (${details.reason})`),
      );
      options.onGone?.(
        t('blk.micKeepsStopping', { why: details.reason }),
      );
      return;
    }
    // A fresh gate FIRST, so a press during the reload waits for the new page rather than
    // being answered by the old page's already-resolved promise.
    rearm();
    audio.webContents.reload();
  });

  void audio.loadFile(page).catch((error: unknown) => {
    rejectGate(error instanceof Error ? error : new Error(String(error)));
  });

  return { window: audio, ready: () => gate };
}
