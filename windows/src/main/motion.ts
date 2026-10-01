// The five springs, as CSS. PURE — shared by every page.
//
// The Mac's `Theme.Motion` names five SwiftUI springs by (duration, bounce). SwiftUI's
// `spring(duration:bounce:)` is a damped harmonic oscillator with unit mass,
// stiffness (2π / duration)² and damping ratio (1 − bounce). CSS has no spring timing
// function, but it has `linear(...)` with arbitrarily many stops (Chromium 113+, and
// Electron 43 is far past it), and a spring sampled densely into `linear()` IS that spring
// — overshoot included, which `cubic-bezier` cannot express at all. So the same five
// numbers drive the same five motions here, with no animation library.
//
// A spring has no end, only a settling point. The CSS duration is the time the spring takes
// to settle within 0.1% of its target, which is longer than the "perceptual duration" the
// Mac names — exactly as SwiftUI's own animations run past it.

export interface Spring {
  /** Perceptual duration, seconds. SwiftUI's `duration`. */
  readonly duration: number;
  /** 0 = critically damped, towards 1 = bouncier. SwiftUI's `bounce`. */
  readonly bounce: number;
}

/** `Theme.Motion`, number for number. */
export const SPRINGS = {
  /** Controls: a switch, a chip, a hover. Quick, a hint of overshoot. */
  snappy: { duration: 0.26, bounce: 0.12 },
  /** Content changing in place: a list filtering, a card appearing. No overshoot. */
  smooth: { duration: 0.4, bounce: 0 },
  /** The pill arriving, the success check. The one place with real bounce. */
  pop: { duration: 0.42, bounce: 0.3 },
  /** A shape changing size — the pill widening for a message, the sidebar folding. */
  morph: { duration: 0.48, bounce: 0.16 },
  /** Moving between sidebar sections and onboarding steps. */
  section: { duration: 0.34, bounce: 0.04 },
} as const satisfies Record<string, Spring>;

export type SpringName = keyof typeof SPRINGS;

/** Position of a unit step response at time `t` seconds: 0 at rest, 1 at the target. */
export function springValue(spring: Spring, t: number): number {
  const omega = (2 * Math.PI) / spring.duration;
  const zeta = Math.max(0, 1 - spring.bounce);
  if (t <= 0) return 0;
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * omega * t);
    return (
      1 - envelope * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t))
    );
  }
  // Critically damped (bounce 0).
  return 1 - Math.exp(-omega * t) * (1 + omega * t);
}

/** When the spring stays within `epsilon` of its target from then on. Seconds. */
export function settleTime(spring: Spring, epsilon = 0.001): number {
  const step = 1 / 600;
  let lastOutside = 0;
  for (let t = 0; t < 10; t += step) {
    if (Math.abs(1 - springValue(spring, t)) > epsilon) lastOutside = t;
  }
  return lastOutside + step;
}

export interface CssSpring {
  /** A CSS `linear(...)` easing. */
  readonly easing: string;
  /** Milliseconds to run it for. */
  readonly durationMs: number;
}

/** The spring as a CSS easing and a duration. ~60 stops is visually exact. */
export function cssSpring(spring: Spring, stops = 60): CssSpring {
  const total = settleTime(spring);
  const points: string[] = [];
  for (let i = 0; i <= stops; i += 1) {
    const t = (i / stops) * total;
    const value = i === stops ? 1 : springValue(spring, t);
    points.push(Number(value.toFixed(4)).toString());
  }
  return { easing: `linear(${points.join(', ')})`, durationMs: Math.round(total * 1000) };
}

/**
 * The CSS custom properties every page sets on `:root` once, so stylesheets can say
 * `transition: transform var(--spring-snappy-ms) var(--spring-snappy)`.
 */
export function springCustomProperties(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, spring] of Object.entries(SPRINGS)) {
    const css = cssSpring(spring);
    out[`--spring-${name}`] = css.easing;
    out[`--spring-${name}-ms`] = `${String(css.durationMs)}ms`;
  }
  return out;
}
