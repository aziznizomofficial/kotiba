// The pill's voice animation — three of them, the user's choice in Settings. The port of
// `PillStyleRenderer` and `VoiceAnimationEngine` (Sources/KotibaUI/PillStyles.swift), which
// are themselves ports of the review page's `drawStyle` (artifact FL5k6kE9qtA3tcSiguvF67,
// "Kotiba pill styles"): #25 "Siri filled", #26 "Siri lobes" (the default) and #34 "Bars ·
// glow", the three the owner kept. Which one runs is the `pillStyle` setting, read live.
//
// Coordinates are the page's: the whole capsule is the canvas, `inset` is 0.6 of the height
// (the round ends), everything else is a fraction of the height or of the span between the
// ends. The page counted the lobes' physics in 60 Hz frames; here those run as fixed 60 Hz
// ticks off the frame clock, so a 144 Hz monitor neither speeds up a lobe nor shortens its
// life. The other two are pure functions of the clock and the level.

import type { PillAnimationStyle } from '../main/pill-model.js';

interface Lobe {
  x: number;
  w: number;
  life: number;
  speed: number;
  color: number;
}

/** mulberry32 — a seedable generator so the lobes' randomness can be pinned in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

const LOBE_COLORS = ['126,240,200', '70,200,180', '200,255,235'] as const;

/** Siri filled's three waves: colour, frequency, speed, phase — the page's, constant for constant. */
const FILLED_WAVES = [
  ['rgba(126,240,200,0.55)', 5, 4, 0],
  ['rgba(60,190,170,0.5)', 4, 5.5, 1.3],
  ['rgba(190,255,230,0.4)', 6.5, 3.2, 2.6],
] as const;

const rgba = (a: number): string => `rgba(126,240,200,${String(Math.min(1, Math.max(0, a)))})`;

/**
 * Where a style sits under Reduce Motion: one still frame at a calm, legible level. Nothing
 * moves, the voice included — a shape that jumps with each syllable is motion too.
 */
export const STILL_LEVEL: Readonly<Record<PillAnimationStyle, number>> = {
  sirilobes: 0.12,
  sirifilled: 0.3,
  barsglow: 0.35,
};

/** The classic Siri attenuation: calm at both ends of `x` ∈ -2…2, full in the middle. */
export function attenuation(x: number, k = 2): number {
  return (k / (k + x ** 4)) ** k;
}

/**
 * A speech-like level for a pill nobody is talking into — the picker's previews. The review
 * page's `rawLevel` (syllable bursts inside phrases, with pauses), returned in the meter's
 * own units — the page's envelope squared back through the square-root curve — so it takes
 * exactly the path a real voice does. The Mac's `SimulatedVoice`.
 */
export function simulatedVoiceLevel(t: number): number {
  const phrase = Math.sin(t * 0.9) + Math.sin(t * 0.37 + 1) > -0.6 ? 1 : 0.08;
  const syllable = Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 0.5)) ** 0.7;
  const envelope = Math.min(1, phrase * (0.08 + 0.55 * syllable) + 0.02);
  return (envelope / 2) ** 2 + 0.004;
}

/** The clock, the envelope and the lobes, advanced once per display frame. */
export class VoiceAnimation {
  t = 0;
  level = 0;
  processing = false;
  lobes: Lobe[] = [];
  readonly #rand: () => number;
  #last: number | null = null;
  #tickDebt = 0;

  constructor(seed: number = Math.floor(Math.random() * 2 ** 32)) {
    this.#rand = mulberry32(seed);
  }

  advance(nowMs: number, level: number, processing: boolean, style: PillAnimationStyle, reduceMotion: boolean): void {
    const dt = Math.min(1 / 30, Math.max(0, (nowMs - (this.#last ?? nowMs)) / 1000));
    this.#last = nowMs;
    this.processing = processing;
    if (reduceMotion) {
      // A static, calm frame: the clock parked, the level fixed, and for the lobes three
      // caught mid-swell at fixed places.
      this.t = 2.2;
      this.level = STILL_LEVEL[style];
      this.lobes =
        style === 'sirilobes'
          ? [
              { x: 0.28, w: 0.2, life: 0.5, speed: 0, color: 0 },
              { x: 0.52, w: 0.16, life: 0.5, speed: 0, color: 2 },
              { x: 0.74, w: 0.22, life: 0.5, speed: 0, color: 1 },
            ]
          : [];
      return;
    }
    this.t += dt;
    // Square-root loudness with a small gate, attack 28/s, release 7/s. Processing has no
    // voice to follow, so the style idles at a low, steady level.
    const loud = processing ? 0.12 : Math.min(1, Math.sqrt(Math.max(0, level - 0.004)) * 2);
    const attack = loud > this.level ? 28 : 7;
    this.level += (loud - this.level) * Math.min(1, attack * dt);
    if (style !== 'sirilobes') {
      if (this.lobes.length > 0) this.lobes = [];
      return;
    }
    this.#tickDebt += dt * 60;
    while (this.#tickDebt >= 1) {
      this.#tickDebt -= 1;
      this.#tickLobes();
    }
  }

  /** One 60 Hz step, in the page's order: maybe spawn (up to 4 at once), drop the finished, age the rest. */
  #tickLobes(): void {
    const r = this.#rand;
    if (this.lobes.length < 4 && r() < 0.04 + this.level * 0.2) {
      this.lobes.push({ x: 0.2 + r() * 0.6, w: 0.12 + r() * 0.2, life: 0, speed: 0.01 + r() * 0.015, color: Math.floor(r() * 3) % 3 });
    }
    this.lobes = this.lobes.filter((l) => l.life < 1);
    for (const l of this.lobes) l.life += l.speed;
  }

  /** Forget the clock — the pill was hidden, and the next frame must not see a huge `dt`. */
  pause(): void {
    this.#last = null;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), radius);
  ctx.fill();
}

/**
 * Draw one frame of `style` into a `w` × `h` canvas (CSS pixels; the context already carries
 * the device ratio, which `ratio` repeats for the two things a transform does not scale:
 * shadow blur and filter radii).
 */
export function drawStyle(
  style: PillAnimationStyle,
  f: VoiceAnimation,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  ratio: number,
): void {
  const cy = h / 2;
  const inset = h * 0.6;
  const span = w - inset * 2;
  const { t, level: lvl } = f;
  const centreLine = (alpha: number, width: number): void => {
    ctx.lineWidth = Math.max(1, width);
    ctx.strokeStyle = rgba(alpha);
    ctx.beginPath();
    ctx.moveTo(inset, cy);
    ctx.lineTo(inset + span, cy);
    ctx.stroke();
  };
  ctx.save();
  // Processing: the style idles at a low level, drawn quieter so it reads as "working".
  if (f.processing) ctx.globalAlpha = 0.55;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (style) {
    case 'sirifilled': {
      // Three |sin| waves under the Siri attenuation, each filled top and bottom about the
      // centre line; additive, so where they cross the greens brighten toward white.
      const steps = Math.max(40, Math.round(span / 1.5));
      ctx.globalCompositeOperation = 'lighter';
      for (const [color, freq, speed, phase] of FILLED_WAVES) {
        const points: [number, number][] = [];
        for (let k = 0; k <= steps; k += 1) {
          const u = k / steps;
          const x = u * 4 - 2;
          points.push([inset + span * u, attenuation(x) * Math.abs(Math.sin(freq * x - t * speed + phase)) * h * 0.42 * (0.05 + lvl)]);
        }
        ctx.beginPath();
        ctx.moveTo(inset, cy);
        for (const [x, a] of points) ctx.lineTo(x, cy - a);
        for (let k = points.length - 1; k >= 0; k -= 1) {
          const [x, a] = points[k] ?? [inset, 0];
          ctx.lineTo(x, cy + a);
        }
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      centreLine(0.35, h * 0.02);
      break;
    }
    case 'sirilobes': {
      // Two-sided sin² swells, additive so overlaps brighten; a blurred pass underneath is the glow.
      const trace = (l: Lobe, a: number): void => {
        const lx = inset + span * l.x;
        const lw = span * l.w;
        ctx.beginPath();
        for (let k = 0; k <= 40; k += 1) {
          const u = k / 40;
          ctx.lineTo(lx - lw + 2 * lw * u, cy - Math.sin(u * Math.PI) ** 2 * h * 0.4 * a);
        }
        for (let k = 40; k >= 0; k -= 1) {
          const u = k / 40;
          ctx.lineTo(lx - lw + 2 * lw * u, cy + Math.sin(u * Math.PI) ** 2 * h * 0.4 * a);
        }
        ctx.closePath();
      };
      ctx.globalCompositeOperation = 'lighter';
      for (const pass of [0, 1]) {
        ctx.filter = pass === 0 ? `blur(${String(h * 0.16 * ratio)}px)` : 'none';
        for (const l of f.lobes) {
          trace(l, Math.sin(l.life * Math.PI) * (0.1 + lvl));
          ctx.fillStyle = `rgba(${LOBE_COLORS[l.color] ?? LOBE_COLORS[0]},${pass === 0 ? '0.28' : '0.55'})`;
          ctx.fill();
        }
      }
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
      centreLine(0.3, h * 0.018);
      break;
    }
    case 'barsglow': {
      // 21 mirrored bars, taller toward the centre, each wobbling at its own phase, under a
      // glow that grows with the voice: the page's shadow, blur h × (0.1 + 0.5 × level).
      const n = 21;
      const gap = span / n;
      const bw = gap * 0.42;
      ctx.shadowColor = rgba(1);
      ctx.shadowBlur = h * (0.1 + 0.5 * lvl) * ratio;
      for (let i = 0; i < n; i += 1) {
        const d = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
        const shape = Math.cos((d * Math.PI) / 2) ** 1.4;
        const wobble = 0.65 + 0.35 * Math.sin(t * 9 + i * 1.7);
        const bh = Math.max(bw, h * 0.72 * shape * lvl * wobble);
        const x = inset + gap * (i + 0.5);
        ctx.fillStyle = rgba(0.55 + 0.45 * shape);
        roundRect(ctx, x - bw / 2, cy - bh / 2, bw, bh, Math.min(bw, bh) / 2);
      }
      ctx.shadowBlur = 0;
      break;
    }
  }
  ctx.restore();
}
