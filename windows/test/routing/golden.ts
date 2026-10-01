// Loading the golden fixtures, and the one rule that makes comparing them honest.
//
// The generator (Sources/kotiba-golden/JSON.swift) writes every Double with
// `String(format: "%.Nf")` — fixed point, trailing zeros kept, `-0` folded to `0` —
// and NOT with shortest-round-trip. So the contract a port has to meet is the DECIMAL
// TEXT in the file, not a binary64 bit pattern: `ClusterMass.mass` sums a Swift
// `Dictionary`'s values, whose iteration order is derived from a per-process hash seed,
// so the last bit of a seven-term sum is not reproducible even in Swift.
//
// `sameNumber` therefore compares `toFixed(decimals)` strings. That is not a loosened
// assertion, and it is not a tolerance: `numberLiteralsRoundTrip` below proves that for
// every decimal literal in these files, `Number(literal).toFixed(digits) === literal`,
// so comparing the two `toFixed` strings is EXACTLY comparing the bytes the generator
// wrote. A difference of one unit in the ninth decimal fails, loudly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GOLDEN_DIR = fileURLToPath(new URL('../../fixtures/golden/', import.meta.url));

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function loadGolden(name: string): Record<string, Json> {
  return JSON.parse(readText(name)) as Record<string, Json>;
}

export function readText(name: string): string {
  return readFileSync(GOLDEN_DIR + name + '.json', 'utf8');
}

/**
 * Every decimal literal in the file, with the number of digits the generator printed.
 * Used to prove the `toFixed` comparison is byte-exact rather than approximate.
 */
export function decimalLiterals(name: string): { literal: string; digits: number }[] {
  return [...readText(name).matchAll(/-?\d+\.\d+/g)].map((match) => ({
    literal: match[0],
    digits: match[0].split('.')[1]!.length,
  }));
}

/**
 * `String(format: "%.<decimals>f")` — including the `-0` fold, so a sum that happens to
 * underflow negative does not change the bytes.
 */
export function fixed(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  return text.startsWith('-') && Number(text) === 0 ? text.slice(1) : text;
}

/** The emitted decimal text of both numbers, at the generator's own precision. */
export function sameNumber(actual: number, expected: number, decimals: number): void {
  const a = fixed(actual, decimals);
  const b = fixed(expected, decimals);
  if (a !== b) {
    throw new Error(
      `number differs at ${decimals} decimals: got ${a} (${actual}), fixture says ${b} (${expected})`,
    );
  }
}

/** `num(_:)` defaults to nine decimals; masses, durations and peaks all use it. */
export const MASS_DECIMALS = 9;
/** `num(_, decimals: 6)` — thresholds and posterior probabilities. */
export const PROBABILITY_DECIMALS = 6;

// --- typed accessors, so a truncated or renamed fixture fails here and not later ---

export function rows(fixture: Record<string, Json>, key: string): Record<string, Json>[] {
  const value = fixture[key];
  if (!Array.isArray(value)) throw new Error(`fixture has no array at "${key}"`);
  return value as Record<string, Json>[];
}

export function str(row: Record<string, Json>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`"${key}" is not a string: ${String(value)}`);
  return value;
}

export function strOrNull(row: Record<string, Json>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return str(row, key);
}

/** For a key the generator emits on some rows and omits on others. */
export function optionalStr(row: Record<string, Json>, key: string): string | null {
  return row[key] === undefined ? null : str(row, key);
}

export function int(row: Record<string, Json>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`"${key}" is not a number: ${String(value)}`);
  return value;
}

export function numOrNull(row: Record<string, Json>, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  return int(row, key);
}

export function bool(row: Record<string, Json>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new Error(`"${key}" is not a boolean: ${String(value)}`);
  return value;
}

export function posterior(row: Record<string, Json>, key: string): Record<string, number> {
  const value = row[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`"${key}" is not an object`);
  }
  return value as Record<string, number>;
}

export function object(row: Record<string, Json>, key: string): Record<string, Json> {
  return posterior(row, key) as unknown as Record<string, Json>;
}
