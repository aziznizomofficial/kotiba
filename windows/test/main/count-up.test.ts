// The tiles' count-up: the curve lands exactly, and a count stays in its final unit.

import { describe, expect, it } from 'vitest';

import { formatCount, formatDuration, formatMillis } from '../../src/core/stats/index.js';
import { countEase, countFormat, durationFormat, millisFormat } from '../../src/main/count-up.js';

describe('counting up', () => {
  it('starts at 0, ends exactly at 1, and never goes back', () => {
    expect(countEase(0)).toBe(0);
    expect(countEase(1)).toBe(1);
    let previous = 0;
    for (let i = 1; i <= 100; i += 1) {
      const value = countEase(i / 100);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
    // An ease-out: most of the way there by half time.
    expect(countEase(0.5)).toBeGreaterThan(0.85);
  });

  it('stays in the final unit the whole way, and ends on the final text', () => {
    expect(millisFormat(2_100)(850)).toBe('0.8 s');
    expect(millisFormat(2_100)(2_100)).toBe(formatMillis(2_100));
    expect(millisFormat(184)(92)).toBe('92 ms');
    expect(durationFormat(25_200)(90)).toBe('0.0 h');
    expect(durationFormat(25_200)(25_200)).toBe(formatDuration(25_200));
    expect(durationFormat(1_800)(1_800)).toBe(formatDuration(1_800));
    expect(countFormat()(34_741)).toBe(formatCount(34_741));
  });
});
