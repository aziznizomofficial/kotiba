// What the pill shows, as a value. PURE — the port of `PillState` (Sources/KotibaUI/HUD.swift),
// so the pill renders from data and can be tested without a window.
//
// A 160 × 36 black capsule that rises from the bottom centre of the active monitor, above the
// taskbar, carrying one thing: the voice animation across its whole width (the owner's review
// of 2026-09-30 took the language code and the mode glyph off it, and moved it down from the
// top). Listening is the live, level-driven animation — the `pillStyle` setting, one of the
// three the owner kept; processing is the same animation settled and quieter; success is a
// check and the key-up-to-paste time, then the capsule sinks away; heard-nothing and failure
// turn amber and sink away.
//
// A message is a glance, not a report: a few words ("Couldn’t paste"), the reason on Home.
// The capsule still has to hold the longest of them in four languages, so `fitPillMessage`
// measures the words and grows the capsule — wider first, up to 360 px or the monitor less
// its margins, then onto a second line with the breaks balanced — on the morph spring.
// Nothing is cut mid-word and nothing spills past the capsule.

import type { DictationRecord, DictationStatus, Language } from '../contracts/index.js';
import type { AppLanguage } from '../core/i18n/index.js';
import { t } from '../core/i18n/index.js';
import { quietMicPillName } from '../core/input-device/index.js';
import { releaseToPasteMillis } from '../core/stats/index.js';

export type PillState =
  | { readonly kind: 'listening' }
  /** A model loading, transcription, polish, paste — anything between key-up and text. */
  | { readonly kind: 'processing' }
  /** Pasted. `millis` is key-up to paste, when the record has it. */
  | { readonly kind: 'success'; readonly millis: number | null }
  /** Heard nothing, or something failed. Amber either way; the message says which. */
  | { readonly kind: 'attention'; readonly message: string }
  /** Nothing to show: the capsule folds away. */
  | { readonly kind: 'hidden' };

/** The Mac's words, verbatim — in English; the pill shows them in the interface language. */
export const HEARD_NOTHING_MESSAGE = 'Didn’t catch that — hold the key';

export const PILL_WIDTH = 160;
export const PILL_HEIGHT = 36;
/** How wide a message may push the capsule before it wraps. */
export const PILL_MAX_MESSAGE_WIDTH = 360;
/** The transparent canvas the capsule animates inside: room for the widest message and its shadow. */
export const PILL_CANVAS_WIDTH = 400;
export const PILL_CANVAS_HEIGHT = 110;
/** Canvas kept BELOW the capsule, so its shadow is drawn rather than cut off by the window edge. */
export const PILL_SHADOW_ROOM = 24;
/**
 * Gap between the bottom of the work area (the top of a bottom taskbar) and the capsule. The
 * Mac's gap: a little more than the pill's old distance from the top of the screen — a menu
 * bar (24) plus 6, plus 8 — so it sits above the taskbar without feeling low.
 */
export const PILL_BOTTOM_GAP = 38;

/**
 * Where the canvas goes in a work area: bottom centre. The work area, not the display bounds:
 * a taskbar must never cover the pill, wherever it is docked.
 */
export function pillCanvasBounds(workArea: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(workArea.x + workArea.width / 2 - PILL_CANVAS_WIDTH / 2),
    y: Math.round(workArea.y + workArea.height - PILL_BOTTOM_GAP - PILL_CANVAS_HEIGHT + PILL_SHADOW_ROOM),
    width: PILL_CANVAS_WIDTH,
    height: PILL_CANVAS_HEIGHT,
  };
}

/**
 * The pill's voice animation: the three the owner kept from the review page "Kotiba pill
 * styles" (artifact FL5k6kE9qtA3tcSiguvF67) — #25 "Siri filled", #26 "Siri lobes", #34
 * "Bars · glow" — drawn by `src/renderer/pill-styles.ts` under the same names as the Mac's
 * `PillAnimationStyle`, which are also what both settings files store.
 */
export const PILL_ANIMATION_STYLES = ['sirifilled', 'sirilobes', 'barsglow'] as const;
export type PillAnimationStyle = (typeof PILL_ANIMATION_STYLES)[number];

/** What a fresh install, and a settings file from before the choice existed, runs. */
export const DEFAULT_PILL_STYLE: PillAnimationStyle = 'sirilobes';

/** The stored `pillStyle`, as a style. An id a newer build wrote reads as the default. */
export function resolvePillStyle(stored: string | undefined): PillAnimationStyle {
  return (PILL_ANIMATION_STYLES as readonly string[]).includes(stored ?? '') ? (stored as PillAnimationStyle) : DEFAULT_PILL_STYLE;
}

/** The name the Settings picker shows, in the interface language. */
export function pillStyleName(style: PillAnimationStyle): string {
  switch (style) {
    case 'sirifilled':
      return t('settings.pill.sirifilled');
    case 'sirilobes':
      return t('settings.pill.sirilobes');
    case 'barsglow':
      return t('settings.pill.barsglow');
  }
}

// ---------------------------------------------------------------------------------
// Fitting a message
// ---------------------------------------------------------------------------------

/** The message row's fixed parts, in CSS pixels. `.pill .attention-face` in style.css uses these. */
export const PILL_MESSAGE = {
  iconWidth: 16,
  spacing: 8,
  paddingX: 14,
  paddingY: 9,
  /** `line-height` of the message, exactly, so the height is arithmetic. */
  lineHeight: 16,
  fontSize: 12,
  /** Two is the design; the third is the safety net for a string no test has seen. */
  maxLines: 3,
  /** Canvas `measureText` and the layout engine agree to a fraction of a pixel; this keeps a rounding difference from wrapping. */
  slack: 2,
} as const;

/** Everything in the capsule that is not the words. */
export const PILL_MESSAGE_CHROME = PILL_MESSAGE.paddingX * 2 + PILL_MESSAGE.iconWidth + PILL_MESSAGE.spacing;

export interface PillMessageLayout {
  /** The capsule. */
  readonly width: number;
  readonly height: number;
  /** The width the words wrap at. */
  readonly textWidth: number;
  readonly lines: number;
}

/**
 * How many lines `text` takes at `width`, broken greedily at spaces the way the browser
 * breaks it. A word wider than the line takes a line of its own (the caller keeps the width
 * above the widest word, so no word is ever broken).
 */
export function lineCount(text: string, width: number, measure: (s: string) => number): number {
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  let lines = 1;
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && measure(candidate) > width) {
      lines += 1;
      line = word;
    } else {
      line = candidate;
    }
  }
  return lines;
}

/** The widest single word: no wrap width may go below it without breaking a word. */
export function widestWord(text: string, measure: (s: string) => number): number {
  return Math.max(0, ...text.split(/\s+/u).filter((word) => word.length > 0).map(measure));
}

/**
 * The capsule for a message. The rule, in order — the Mac's `PillMessageLayout.fit`: one line
 * at its natural width when that fits (never narrower than the animation's 160); else two lines
 * at the NARROWEST width that still holds them — which is what balances the breaks, so the
 * message splits roughly in half instead of leaving one word alone; else a third line rather
 * than a cut. `measure` is the width of a string in the message font (canvas `measureText` in
 * the renderer; a table in the tests).
 */
export function fitPillMessage(
  text: string,
  measure: (s: string) => number,
  maxWidth: number = PILL_MAX_MESSAGE_WIDTH,
): PillMessageLayout {
  const { slack, maxLines, lineHeight, paddingY } = PILL_MESSAGE;
  const room = Math.max(40, maxWidth - PILL_MESSAGE_CHROME);
  const natural = Math.ceil(measure(text));
  let width: number;
  let lines: number;
  if (natural + slack <= room) {
    width = natural + slack;
    lines = 1;
  } else {
    const floor = Math.ceil(widestWord(text, measure));
    const target = Math.min(maxLines, Math.max(2, lineCount(text, room - slack, measure)));
    // Bisection on whole pixels: the line count only grows as the width shrinks.
    let low = Math.max(floor - 1, Math.floor(room / (target + 1)));
    let high = room - slack;
    while (high - low > 1) {
      const mid = Math.round((low + high) / 2);
      if (mid >= floor && lineCount(text, mid, measure) <= target) high = mid;
      else low = mid;
    }
    lines = lineCount(text, high, measure);
    width = high + slack;
  }
  const shown = Math.min(lines, maxLines);
  return {
    width: Math.max(PILL_WIDTH, Math.ceil(width + PILL_MESSAGE_CHROME)),
    height: Math.max(PILL_HEIGHT, shown * lineHeight + paddingY * 2),
    textWidth: Math.ceil(width),
    lines,
  };
}

/**
 * How wide a message may make the capsule on a monitor whose work area is this wide: 360 px,
 * less on one too narrow to keep 24 px each side, and never past the canvas less its shadow room.
 */
export function pillMaxMessageWidth(workAreaWidth: number): number {
  return Math.min(PILL_MAX_MESSAGE_WIDTH, PILL_CANVAS_WIDTH - 40, Math.max(PILL_WIDTH, workAreaWidth - 48));
}

/**
 * How long the pill lingers after a dictation stops being busy, before it folds away.
 *
 * MEASURED FROM THE OUTCOME, NEVER FROM KEY-UP. A cold Uzbek model load is ~7.8 s; a
 * timer started at key-up would spend the whole visible window on the load and hide the
 * pill at the instant the text appears. The Mac's 2.5 s.
 */
export const PILL_LINGER_MS = 2_500;

/** How long the capsule takes to spring back before the window goes. The Mac's 450 ms. */
export const PILL_HIDE_AFTER_FOLD_MS = 450;

export function pillState(status: DictationStatus, record: DictationRecord | null): PillState {
  switch (status.kind) {
    case 'listening':
      return { kind: 'listening' };
    case 'preparing':
    case 'working':
      return { kind: 'processing' };
    case 'succeeded':
      return { kind: 'success', millis: record === null ? null : releaseToPasteMillis(record) };
    case 'heardNothing':
      // A take that was a real hold and barely registered says which microphone instead —
      // `status.quietMic`, set by the controller at most once per device per hour.
      return {
        kind: 'attention',
        message:
          status.quietMic === undefined
            ? t('pill.heardNothing')
            : t('pill.quietMic', { device: quietMicPillName(status.quietMic.name) }),
      };
    case 'failed':
      // The pill's few words, never the whole sentence: that is Home's.
      return { kind: 'attention', message: status.pill ?? t('pill.failed.generic') };
    case 'idle':
      return { kind: 'hidden' };
  }
}

/**
 * How long an outcome stays before folding back. `null` means "until the state changes".
 * The Mac's 900 ms for a success and 2200 ms for anything amber.
 */
export function pillDwellMs(state: PillState): number | null {
  if (state.kind === 'success') return 900;
  if (state.kind === 'attention') return 2_200;
  return null;
}

export function languageCode(language: Language): string {
  return language.toUpperCase();
}

/** A mode's glyph, for the Modes page. Named for the renderer's icon set. (The pill carried it until 2026-09-30.) */
export function modeGlyph(modeKey: string): 'sparkles' | 'bubble' | 'note' | 'cursor' {
  switch (modeKey) {
    case 'super':
      return 'sparkles';
    case 'message':
      return 'bubble';
    case 'note':
      return 'note';
    default:
      return 'cursor';
  }
}

/** Screen-reader text, as the Mac sets `accessibilityLabel`. */
export function pillAccessibleText(state: PillState): string {
  switch (state.kind) {
    case 'listening':
      return t('pill.listening');
    case 'processing':
      return t('pill.working');
    case 'success':
      return t('pill.pasted');
    case 'attention':
      return state.message;
    case 'hidden':
      return '';
  }
}

/** Everything the pill window renders, in one message. */
export interface PillFrame {
  readonly state: PillState;
  /** The window is on screen; false sinks the capsule back down before the window goes. */
  readonly presented: boolean;
  /**
   * The interface language main is speaking. The pill's screen-reader label is worded in the
   * pill's own page, which has no settings of its own, so the frame carries it. Optional: a
   * frame without it leaves the page's language where it was.
   */
  readonly language?: AppLanguage;
  /** The `pillStyle` setting, so a change in Settings reaches the floating pill live. */
  readonly style?: PillAnimationStyle;
  /** How wide a message may make the capsule on the monitor it is on (`pillMaxMessageWidth`). */
  readonly maxMessageWidth?: number;
}
