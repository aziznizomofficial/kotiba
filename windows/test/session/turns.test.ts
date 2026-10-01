// N pastes before N+1 — the port of Tests/KotibaPlatformTests/InsertionOrderTests.swift.

import { describe, expect, it } from 'vitest';

import { InsertionTurns, PASTE_PATIENCE_MS } from '../../src/session/turns.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the paste queue', () => {
  it('tickets are press order, and a later finisher waits for the earlier one', async () => {
    const turns = new InsertionTurns();
    const first = turns.issue();
    const second = turns.issue();
    const order: number[] = [];
    const waiting = turns.waitForTurn(second).then(() => order.push(second));
    await tick();
    expect(order).toEqual([]);
    await turns.waitForTurn(first);
    order.push(first);
    turns.finish(first);
    await waiting;
    expect(order).toEqual([first, second]);
  });

  it('a dictation that inserted nothing still passes the turn, and finish is idempotent', async () => {
    const turns = new InsertionTurns();
    const a = turns.issue();
    const b = turns.issue();
    turns.finish(a);
    turns.finish(a);
    await turns.waitForTurn(b); // resolves: a ended without pasting
    expect(turns.overtakes).toBe(0);
  });

  it('finishing out of order advances past everything finished', async () => {
    const turns = new InsertionTurns();
    const [a, b, c] = [turns.issue(), turns.issue(), turns.issue()];
    turns.finish(b);
    let cWent = false;
    const waiting = turns.waitForTurn(c).then(() => (cWent = true));
    await tick();
    expect(cWent).toBe(false);
    turns.finish(a);
    await waiting;
    expect(cWent).toBe(true);
  });

  it(`a wedged dictation is overtaken after ${String(PASTE_PATIENCE_MS / 60_000)} minutes, and counted`, async () => {
    const timers: { run: () => void; ms: number }[] = [];
    const turns = new InsertionTurns({
      timer: (run, ms) => {
        timers.push({ run, ms });
        return { cancel: () => undefined };
      },
    });
    turns.issue(); // never finishes
    const second = turns.issue();
    let went = false;
    const waiting = turns.waitForTurn(second).then(() => (went = true));
    await tick();
    expect(timers[0]?.ms).toBe(PASTE_PATIENCE_MS);
    timers[0]?.run();
    await waiting;
    expect(went).toBe(true);
    expect(turns.overtakes).toBe(1);
  });
});
