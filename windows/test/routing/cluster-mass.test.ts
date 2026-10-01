// cluster-mass.json — the acoustic tier, asserted row by row.
//
// This is the file that decides whether Uzbek works. `uz` never wins on argmax: clean
// Uzbek scores tr 0.63 / az 0.17 / uz 0.00, so the decision is the summed mass of seven
// language codes against a threshold, and every one of those codes is a measured
// membership choice — `ug`, `tt` and `ba` are Turkic and are deliberately NOT in the
// set. The fixture asks the membership question of each of them one at a time.

import { describe, expect, it } from 'vitest';
import { DEFAULT_TURKIC_THRESHOLD, TURKIC_CLUSTER } from '../../src/contracts/index.js';
import { clusterMass, isUzbek } from '../../src/core/routing/index.js';
import {
  MASS_DECIMALS,
  PROBABILITY_DECIMALS,
  bool,
  decimalLiterals,
  int,
  loadGolden,
  object,
  posterior,
  rows,
  sameNumber,
  str,
} from './golden.js';

const golden = loadGolden('cluster-mass');
const cases = rows(golden, 'cases');

describe('cluster-mass.json', () => {
  it('is the file this build was written against', () => {
    expect(golden['fixture']).toBe('cluster-mass');
    expect(golden['massTolerance']).toBe('1e-9');
    // A truncated file must fail loudly rather than pass 12 rows.
    expect(cases.length).toBe(golden['count']);
    expect(cases.length).toBe(129);
  });

  it('compares by the generator’s own decimal text, not by a tolerance', () => {
    // Every decimal literal the generator printed survives parse → toFixed unchanged,
    // so `sameNumber` is byte comparison and not an epsilon. If this ever fails, the
    // comparison in every other test in this directory has quietly become approximate.
    for (const { literal, digits } of decimalLiterals('cluster-mass')) {
      expect(Number(literal).toFixed(digits)).toBe(literal);
    }
  });

  it('holds the constants the router is built on', () => {
    const constants = object(golden, 'constants');
    sameNumber(DEFAULT_TURKIC_THRESHOLD, int(constants, 'defaultThreshold'), PROBABILITY_DECIMALS);
    expect(str(constants, 'comparison')).toBe('>=');
    // Sorted, because the fixture sorts. Seven codes, and no more: `ug` (Uyghur),
    // `tt` (Tatar) and `ba` (Bashkir) are Turkic and are not here.
    expect([...TURKIC_CLUSTER].sort()).toEqual(constants['turkicCluster']);
    expect(TURKIC_CLUSTER.length).toBe(7);
  });

  for (const [index, row] of cases.entries()) {
    const name = str(row, 'name');
    const threshold = int(row, 'threshold');
    it(`[${index}] ${name} @ ${threshold}`, () => {
      const p = posterior(row, 'posterior');
      sameNumber(clusterMass(p), int(row, 'mass'), MASS_DECIMALS);
      expect(isUzbek(p, threshold)).toBe(bool(row, 'isUzbek'));
    });
  }
});
