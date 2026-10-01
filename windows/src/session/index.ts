// src/session — the dictation state machine.  OWNER: t09
//
// May use Node. May NOT import `electron`.
//
// TWO STRUCTURAL RULES, and everything else follows from them:
//
//   1. THE RAW TRANSCRIPT IS INSERTED BEFORE POLISH RUNS. Polish is 4–18x the cost of
//      transcription, so the words must not wait for it. The polished text then
//      REPLACES what was inserted, and is never re-normalised or re-capitalised. The
//      exception is a restructuring mode (`message`, `note`), which inverts to
//      insert-after-polish because a rewrite cannot be applied as a replace in an app
//      that will not expose its text field — in real use the replace was refused on
//      FOUR dictations out of EIGHT.
//   2. NOTHING FAILS SILENTLY. There is no path that inserts an empty string and
//      reports success.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT OWN. `isUsableRerun`, `verifyRoute` and
// `nonRussianCyrillicCount` live in `src/core/routing` (t03), which holds the golden
// fixtures that pin them; the delivery normaliser, the capitaliser and the two polish
// guards live in `src/core/text` (t04); mode resolution and the app-knowledge table live
// in `src/core/settings` (t05). t01's stub declared local copies of the first two. A
// second implementation of a rule that has a golden fixture is a second place for it to
// drift, so this module consumes all of them through `ports.ts` instead.

export {
  CLIPPING_THRESHOLD,
  FLATTENING_FRACTION,
  SATURATION_MAGNITUDE,
  createDictationSession,
  describe,
  isEmptyTranscript,
  isoSeconds,
  withDeadline,
} from './session.js';
export type {
  DeadlineOutcome,
  DictationSession,
  FinishOptions,
  SessionDeps,
} from './session.js';

export {
  CAPTURE_LIMIT_STAGE,
  createDictationController,
  pinFor,
  polishPolicyFor,
  promptDatetime,
} from './controller.js';
export type { ContractDeps, ControllerDeps } from './controller.js';

export { INERT_DUCKING, NO_POLISH, systemClock } from './ports.js';
export { InsertionTurns, PASTE_PATIENCE_MS, type TurnTimer } from './turns.js';
export type {
  Capitaliser,
  Clock,
  CreatePolishChain,
  CreateRouter,
  ModesPort,
  PlaybackDucking,
  PolishChain,
  RoutingPort,
  SessionPorts,
  TextPort,
} from './ports.js';
