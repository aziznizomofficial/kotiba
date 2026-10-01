// A number counting up to its value — the Home and Statistics tiles, the first time they
// appear. PURE: the curve, the timing and the formatting; `statTile` in the renderer drives it
// from `requestAnimationFrame`. The port of the Mac's `StatTile` counting (Sources/KotibaUI/
// Components.swift) and `Theme.Motion.count`.

import { formatDecimal, t } from '../core/i18n/index.js';
import { formatCount } from '../core/stats/index.js';

/** How long a count takes, and how far apart the tiles of one row start. The Mac's numbers. */
export const COUNT_UP_MS = 850;
export const COUNT_UP_STAGGER_MS = 70;

/**
 * The Mac's `timingCurve(0.22, 1, 0.36, 1)` — a soft ease-out that lands rather than stops.
 * Solved for x by Newton's method, as a CSS `cubic-bezier` is; exact at 0 and 1, so the last
 * frame is the final number and not one digit short of it.
 */
export function countEase(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  if (t === 0 || t === 1) return t;
  const [x1, y1, x2, y2] = [0.22, 1, 0.36, 1];
  const bezier = (u: number, a: number, b: number): number =>
    3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
  const slope = (u: number, a: number, b: number): number =>
    3 * (1 - u) * (1 - u) * a + 6 * (1 - u) * u * (b - a) + 3 * u * u * (1 - b);
  let u = t;
  for (let i = 0; i < 8; i += 1) {
    const d = slope(u, x1, x2);
    if (Math.abs(d) < 1e-6) break;
    u -= (bezier(u, x1, x2) - t) / d;
    u = Math.min(1, Math.max(0, u));
  }
  return bezier(u, y1, y2);
}

// A count passes through every value between 0 and the final one, and must stay in the final
// one's unit the whole way: "850 ms" turning into "1.0 s", or minutes into hours, halfway
// through reads as a glitch. These pick the unit from the final value.

export function countFormat(): (value: number) => string {
  return (value) => formatCount(Math.round(value));
}

export function millisFormat(final: number): (value: number) => string {
  if (final >= 10_000) return (value) => t('unit.s', { value: formatDecimal(value / 1000, 0) });
  if (final >= 1000) return (value) => t('unit.s', { value: formatDecimal(value / 1000, 1) });
  return (value) => t('unit.ms', { value: String(Math.round(value)) });
}

export function durationFormat(final: number): (value: number) => string {
  const total = Math.round(final);
  if (total < 60) return (value) => t('unit.s', { value: String(Math.round(value)) });
  if (Math.floor(total / 60) < 60) return (value) => t('unit.min', { value: String(Math.floor(value / 60)) });
  const hours = Math.floor(total / 60) / 60;
  return hours < 10
    ? (value) => t('unit.h', { value: formatDecimal(Math.floor(value / 60) / 60, 1) })
    : (value) => t('unit.h', { value: String(Math.round(Math.floor(value / 60) / 60)) });
}
