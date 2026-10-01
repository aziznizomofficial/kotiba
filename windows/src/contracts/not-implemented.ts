// The one thing every stub in this tree shares.
//
// t01 lands a compiling stub for every module in 01-ARCHITECTURE.md so that nine
// workers can typecheck against the contracts in a worktree where only t01's files
// exist. Each of them replaces exactly one module; until then every entry point
// throws this, loudly and with its own name in the message.

/** Thrown by a module t01 scaffolded and nobody has implemented yet. */
export class NotImplementedError extends Error {
  readonly module: string;

  constructor(module: string) {
    super(`${module} is not implemented yet`);
    this.name = 'NotImplementedError';
    this.module = module;
  }
}

/**
 * `throw notImplemented('core/routing')`.
 *
 * Declared as returning `never` so a stub can stand in for a function of any return
 * type without a cast and without disabling a rule.
 */
export function notImplemented(module: string): never {
  throw new NotImplementedError(module);
}
