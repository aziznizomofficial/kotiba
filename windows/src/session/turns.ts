// N pastes before N+1.
//
// The port of `InsertionTurns` (Sources/KotibaPlatform/InsertionOrder.swift).
//
// The second key-down no longer waits for the first dictation to finish — that was "Still
// finishing the last one.", refused on every press that came in under the previous
// transcription. But two dictations in flight finish in whatever order their engines
// return: a 40-second Uzbek hold can easily land after a two-word English one pressed a
// second later. Pasting in finishing order would put the user's sentences in the wrong
// order in their document, which is worse than being slow.
//
// So every dictation takes a ticket at key-down, and its first insert waits for its turn.
// The turn passes when the dictation has inserted — or when it has ended without inserting
// anything (silence, a failure, a cancel), which is why `finish` must be called on every
// path, and is idempotent so calling it twice is harmless.
//
// Only the FIRST insert waits. A later `replace` (the polish pass rewriting what was
// pasted) is in place, verified against the text it replaces, and does not move the
// insertion point, so holding the next dictation's paste behind a polish buys nothing.
//
// PURE apart from a timer, which is injected.

/**
 * How long a dictation may hold everyone behind it. Past it the queue moves on, out of
 * order — the price of not wedging every later dictation behind one that is stuck.
 *
 * Five minutes, the Mac's: capture has no length limit any more and transcription time
 * grows with it, so a short patience would let the next short dictation overtake exactly
 * the long one the user cares most about. The session's own stages carry deadlines, so a
 * run still going after five minutes is wedged.
 */
export const PASTE_PATIENCE_MS = 300_000;

export interface TurnTimer {
  (run: () => void, ms: number): { cancel(): void };
}

const defaultTimer: TurnTimer = (run, ms) => {
  const handle = setTimeout(run, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
};

export class InsertionTurns {
  #issued = 0;
  /** The ticket whose insert may go now. Everything below it has finished. */
  #serving = 1;
  readonly #finished = new Set<number>();
  readonly #waiters = new Map<number, (() => void)[]>();
  readonly #patienceMs: number;
  readonly #timer: TurnTimer;
  /** How many times the queue gave up on a wedged dictation. Observability. */
  overtakes = 0;

  constructor(options: { readonly patienceMs?: number; readonly timer?: TurnTimer } = {}) {
    this.#patienceMs = options.patienceMs ?? PASTE_PATIENCE_MS;
    this.#timer = options.timer ?? defaultTimer;
  }

  /** Take a place in line. Call at key-down, synchronously — press order IS ticket order. */
  issue(): number {
    this.#issued += 1;
    return this.#issued;
  }

  /** Wait until every earlier ticket has inserted or ended. */
  async waitForTurn(ticket: number): Promise<void> {
    if (ticket <= this.#serving) return;
    await new Promise<void>((resolve) => {
      const deadline = this.#timer(() => this.#giveUp(ticket), this.#patienceMs);
      const list = this.#waiters.get(ticket) ?? [];
      list.push(() => {
        deadline.cancel();
        resolve();
      });
      this.#waiters.set(ticket, list);
    });
  }

  /** This ticket has inserted, or will not. Advances the line past every finished ticket. */
  finish(ticket: number): void {
    if (ticket < this.#serving) return;
    this.#finished.add(ticket);
    while (this.#finished.has(this.#serving)) {
      this.#finished.delete(this.#serving);
      this.#serving += 1;
    }
    this.#wake();
  }

  #giveUp(ticket: number): void {
    if (ticket <= this.#serving) return;
    this.overtakes += 1;
    // Everything ahead of `ticket` is treated as done. If one of them does paste later it
    // pastes out of order — the price of not wedging every later dictation behind it.
    for (let t = this.#serving; t < ticket; t += 1) this.#finished.add(t);
    this.finish(this.#serving);
  }

  #wake(): void {
    for (const [ticket, waiters] of [...this.#waiters.entries()]) {
      if (ticket > this.#serving) continue;
      this.#waiters.delete(ticket);
      for (const wake of waiters) wake();
    }
  }
}
