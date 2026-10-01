// The capsule — 160 × 36, black, with the voice animation across its whole width. The port
// of `PillView` (Sources/KotibaUI/HUD.swift). Used by the floating HUD window, by the Home
// hero while listening, and by onboarding's demos, exactly as the Mac reuses its view.
//
// The animation is the `pillStyle` setting (one of the three in src/main/pill-model.ts), drawn
// by `pill-styles.ts` on `requestAnimationFrame`, clipped to the capsule's own shape so its
// round ends are part of the drawing. The loop STOPS whenever the capsule is not showing
// the animation: an idle pill costs nothing.
//
// A message sizes the capsule by measurement, not by `auto`: `fitPillMessage` measures the
// words with the canvas in the message's own font and returns the capsule's width and height,
// which are set as numbers so the morph spring animates between two known sizes (CSS cannot
// transition to or from `auto`). The words wrap at the measured width, balanced, centred.

import type { PillAnimationStyle, PillState } from '../main/pill-model.js';
import {
  DEFAULT_PILL_STYLE,
  PILL_HEIGHT,
  PILL_MAX_MESSAGE_WIDTH,
  PILL_MESSAGE,
  PILL_WIDTH,
  fitPillMessage,
  pillAccessibleText,
} from '../main/pill-model.js';

import { h } from './components.js';
import { icon } from './icons.js';
import { VoiceAnimation, drawStyle, simulatedVoiceLevel } from './pill-styles.js';

export interface Pill {
  readonly element: HTMLElement;
  set(state: PillState, visible: boolean): void;
  /** Switch the animation; the next frame draws the new one. */
  setStyle(style: PillAnimationStyle): void;
  /** How wide a message may make the capsule (the monitor less its margins; 360 at most). */
  setMaxMessageWidth(width: number): void;
  /** The level, 0…1, as the meter publishes it at 20 Hz. Read per frame. */
  setLevel(level: number): void;
  dispose(): void;
}

const reduceMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface PillOptions {
  /** The style to draw — a function, so a pill reading the live setting follows it. */
  readonly style?: PillAnimationStyle | (() => PillAnimationStyle);
  /**
   * Speak a simulated voice instead of `setLevel`'s — the Settings picker's previews, while
   * nobody is dictating. A function, so a preview can switch to the real voice mid-dictation.
   */
  readonly simulated?: boolean | (() => boolean);
}

/** The message font, as the canvas wants it; `.pill .attention-face .message` in style.css. */
const MESSAGE_FONT = `500 ${String(PILL_MESSAGE.fontSize)}px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif`;

let measuringContext: CanvasRenderingContext2D | null = null;

/** The width of `text` in the message font, by the same text engine that will draw it. */
export function measureMessage(text: string): number {
  measuringContext ??= document.createElement('canvas').getContext('2d');
  if (measuringContext === null) return text.length * 7;
  measuringContext.font = MESSAGE_FONT;
  return measuringContext.measureText(text).width;
}

export function createPill(options: PillOptions = {}): Pill {
  let styleSource = options.style ?? DEFAULT_PILL_STYLE;
  const currentStyle = (): PillAnimationStyle => (typeof styleSource === 'function' ? styleSource() : styleSource);
  let maxMessageWidth: number = PILL_MAX_MESSAGE_WIDTH;
  const canvas = h('canvas', { attrs: { width: String(PILL_WIDTH), height: String(PILL_HEIGHT) } });
  const waveFace = h('div', { class: 'face wave-face on' }, [canvas]);
  const millis = h('span', {});
  const successFace = h('div', { class: 'face success-face' }, [
    h('span', { class: 'mini-check' }, [checkMark(10)]),
    millis,
  ]);
  const message = h('span', { class: 'message' });
  const attentionIcon = h('span', {}, [icon('alert', 15, 2.2)]);
  const attentionFace = h('div', { class: 'face attention-face' }, [attentionIcon, message]);
  const element = h('div', { class: 'pill', attrs: { role: 'status', 'aria-live': 'polite' } }, [
    waveFace,
    successFace,
    attentionFace,
  ]);

  const animation = new VoiceAnimation();
  const epoch = performance.now();
  let level = 0;
  let processing = false;
  let running = false;
  let frame = 0;

  const draw = (now: number): void => {
    const context = canvas.getContext('2d');
    if (context === null) return;
    const ratio = window.devicePixelRatio || 1;
    const width = PILL_WIDTH;
    const height = PILL_HEIGHT;
    if (canvas.width !== Math.round(width * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const style = currentStyle();
    const simulated = typeof options.simulated === 'function' ? options.simulated() : options.simulated === true;
    const input = simulated ? simulatedVoiceLevel((now - epoch) / 1000) : level;
    animation.advance(now, input, processing, style, reduceMotion());
    context.save();
    context.beginPath();
    context.roundRect(0, 0, width, height, height / 2);
    context.clip();
    drawStyle(style, animation, context, width, height, ratio);
    context.restore();
  };

  const loop = (now: number): void => {
    if (!running) return;
    draw(now);
    frame = requestAnimationFrame(loop);
  };

  const start = (): void => {
    if (running) return;
    running = true;
    frame = requestAnimationFrame(loop);
  };

  const stop = (): void => {
    running = false;
    cancelAnimationFrame(frame);
    animation.pause();
  };

  const show = (face: HTMLElement): void => {
    for (const each of [waveFace, successFace, attentionFace]) each.classList.toggle('on', each === face);
  };

  /** The capsule's size, as numbers: the spring animates width and height between them. */
  const size = (width: number, height: number): void => {
    element.style.width = `${String(width)}px`;
    element.style.height = `${String(height)}px`;
    element.style.borderRadius = `${String(height / 2)}px`;
  };
  size(PILL_WIDTH, PILL_HEIGHT);

  let lastMessage: string | null = null;
  const fitMessage = (text: string): void => {
    const layout = fitPillMessage(text, measureMessage, maxMessageWidth);
    message.style.width = `${String(layout.textWidth)}px`;
    size(layout.width, layout.height);
  };

  return {
    element,
    set(state, visible) {
      element.classList.toggle('visible', visible && state.kind !== 'hidden');
      element.classList.toggle('listening', state.kind === 'listening');
      element.classList.toggle('attention', state.kind === 'attention');
      element.setAttribute('aria-label', pillAccessibleText(state));
      switch (state.kind) {
        case 'listening':
        case 'processing':
          processing = state.kind === 'processing';
          lastMessage = null;
          size(PILL_WIDTH, PILL_HEIGHT);
          show(waveFace);
          if (visible) start();
          else stop();
          break;
        case 'success':
          stop();
          lastMessage = null;
          size(PILL_WIDTH, PILL_HEIGHT);
          millis.textContent = state.millis === null ? '' : `${String(Math.round(state.millis))} ms`;
          // Redraw the check each time, so it draws itself in again.
          successFace.firstElementChild?.replaceChildren(checkMark(10));
          show(successFace);
          break;
        case 'attention':
          stop();
          if (message.textContent !== state.message) {
            message.textContent = state.message;
            attentionIcon.replaceChildren(icon('alert', 15, 2.2));
          }
          if (lastMessage !== state.message) {
            lastMessage = state.message;
            fitMessage(state.message);
          }
          show(attentionFace);
          break;
        case 'hidden':
          stop();
          break;
      }
    },
    setStyle(style: PillAnimationStyle) {
      styleSource = style;
    },
    setMaxMessageWidth(width: number) {
      if (!Number.isFinite(width) || width === maxMessageWidth) return;
      maxMessageWidth = width;
      if (lastMessage !== null) fitMessage(lastMessage);
    },
    setLevel(next: number) {
      level = Number.isFinite(next) ? next : 0;
    },
    dispose() {
      stop();
    },
  };
}

/** A check that draws itself in, in accent ink. */
export function checkMark(size: number, color = '#03140D'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 12.5 9 18.5 21 5.5');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '3.2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.classList.add('check-path');
  svg.append(path);
  return svg;
}
