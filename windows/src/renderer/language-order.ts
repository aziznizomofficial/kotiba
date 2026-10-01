// The order the window's dictation-language pickers list their languages in — Home's row, the
// Languages page (its pin picker, fallback picker and engine cards) and onboarding's step.
// The rule is `core/languages/order.ts`; this is WHEN it runs.
//
// A page is built fresh each time it is opened (`app.ts show`), and that is the moment the
// order is recomputed — never while the page is up, so a dictation that lands beside an open
// Home page cannot shuffle the row being read. What the user last saw is remembered here, so
// the hysteresis (a clear lead to swap two neighbours) holds across page visits.
//
// The one exception: the records load a beat after the window's first paint. If a page was
// built before they arrived, it re-sorts ONCE when they do (softly — `flip` in components.ts),
// then stands.

import type { Language } from '../contracts/index.js';
import { languageCounts, orderLanguages } from '../core/languages/order.js';

import type { Scope } from './store.js';
import { store } from './store.js';

let lastShown: readonly Language[] | null = null;

/** The order as of now, remembered as "what the user last saw". */
export function currentLanguageOrder(now: number = Date.now()): Language[] {
  const next = orderLanguages({ counts: languageCounts(store.records, now), previous: lastShown });
  lastShown = next;
  return next;
}

/**
 * The order for a page being built. `apply` is called ONCE more, with the recomputed order,
 * if the records were still loading and the page is still open when they arrive.
 */
export function pageLanguageOrder(scope: Scope, apply: (order: Language[]) => void): Language[] {
  const first = currentLanguageOrder();
  if (!store.recordsLoaded) {
    let off: (() => void) | null = null;
    off = store.subscribe('records', () => {
      if (!store.recordsLoaded) return;
      off?.();
      const next = currentLanguageOrder();
      if (next.join() !== first.join()) apply(next);
    });
    scope.add(() => off?.());
  }
  return first;
}
