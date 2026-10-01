// Every voice animation the user can choose draws, listening and processing, without
// a canvas — the drawing is fed a context that records what it was asked to do. The Mac's
// "every style draws a frame without trapping" (Tests/KotibaUITests/UIPolishTests.swift).

import { describe, expect, it } from 'vitest';

import { PILL_ANIMATION_STYLES, PILL_HEIGHT, PILL_WIDTH } from '../../src/main/pill-model.js';
import { STILL_LEVEL, VoiceAnimation, attenuation, drawStyle, simulatedVoiceLevel } from '../../src/renderer/pill-styles.js';

function recordingContext(): { ctx: CanvasRenderingContext2D; painted: () => number } {
  let painted = 0;
  const gradient = { addColorStop: () => undefined };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, name) {
      if (name in target) return target[name as string];
      if (name === 'createRadialGradient' || name === 'createLinearGradient') return () => gradient;
      return (...args: unknown[]) => {
        if (name === 'fill' || name === 'stroke' || name === 'fillRect') painted += 1;
        for (const value of args) {
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${String(name)} got ${String(value)}`);
        }
      };
    },
    set(target, name, value) {
      target[name as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, painted: () => painted };
}

describe('the pill styles', () => {
  for (const style of PILL_ANIMATION_STYLES) {
    it(`${style} draws, listening then processing`, () => {
      const animation = new VoiceAnimation();
      const { ctx, painted } = recordingContext();
      for (let frame = 0; frame < 120; frame += 1) {
        const processing = frame >= 80;
        animation.advance(frame * (1000 / 60), processing ? 0 : 0.22, processing, style, false);
        drawStyle(style, animation, ctx, PILL_WIDTH, PILL_HEIGHT, 2);
      }
      expect(painted()).toBeGreaterThan(0);
      expect(Number.isFinite(animation.level)).toBe(true);
    });
  }

  it('under Reduce Motion every style is one still frame, whatever the voice does', () => {
    for (const style of PILL_ANIMATION_STYLES) {
      const animation = new VoiceAnimation(1);
      animation.advance(0, 0.3, false, style, true);
      const first = { t: animation.t, level: animation.level };
      animation.advance(1300, 0.01, false, style, true);
      expect(animation.t).toBe(2.2);
      expect({ t: animation.t, level: animation.level }).toEqual(first);
      expect(animation.level).toBe(STILL_LEVEL[style]);
      expect(animation.lobes).toHaveLength(style === 'sirilobes' ? 3 : 0);
    }
  });

  it('follows the clock, not the frame rate: 60 Hz and 144 Hz land in the same place', () => {
    for (const style of PILL_ANIMATION_STYLES) {
      const slow = new VoiceAnimation(3);
      const fast = new VoiceAnimation(3);
      for (let f = 0; f <= 120; f += 1) slow.advance((f * 1000) / 60, 0.1, false, style, false);
      for (let f = 0; f <= 288; f += 1) fast.advance((f * 1000) / 144, 0.1, false, style, false);
      expect(Math.abs(slow.t - fast.t)).toBeLessThan(1e-9);
      expect(Math.abs(slow.level - fast.level)).toBeLessThan(0.02);
      // The lobes tick at 60 Hz whatever the display does: the same seed spawns the same ones,
      // give or take the one whose spawn roll landed on a level a hair different.
      expect(Math.abs(slow.lobes.length - fast.lobes.length)).toBeLessThanOrEqual(1);
    }
  });

  it('the previews\' simulated voice speaks in phrases and pauses, in the meter\'s units', () => {
    const samples = Array.from({ length: 400 }, (_, i) => simulatedVoiceLevel(i * 0.05));
    expect(samples.every((v) => v > 0 && v < 0.3)).toBe(true);
    const envelopes = samples.map((v) => Math.min(1, Math.sqrt(v - 0.004) * 2));
    expect(Math.max(...envelopes)).toBeGreaterThan(0.5);
    expect(Math.min(...envelopes)).toBeLessThan(0.15);
  });

  it('the Siri attenuation is calm at both ends and full in the middle', () => {
    expect(attenuation(0)).toBe(1);
    expect(attenuation(2)).toBeLessThan(0.05);
    expect(attenuation(-2)).toBe(attenuation(2));
  });
});
