// The four sounds, as data. PURE — the port of `Feedback` (Sources/KotibaUI/Feedback.swift).
//
// This app is used in meetings, so the toggle defaults to off and the sounds are quiet.
// The Mac plays four system sounds (Tink, Pop, Bottle, Funk); Windows has no equivalent
// set a user would recognise, so each is a short synthesised blip played by the pill's
// page with Web Audio — nothing bundled, nothing fetched, and a sound that will not play
// never costs a dictation.

import type { DictationStatus } from '../contracts/index.js';

export type FeedbackEvent = 'start' | 'stop' | 'cancel' | 'failure';

export interface Tone {
  /** Hz at the start and the end of the blip. */
  readonly from: number;
  readonly to: number;
  readonly ms: number;
  /** Delay from the event, for a two-note sound. */
  readonly at: number;
}

/** Peak gain. Quiet on purpose. */
export const FEEDBACK_GAIN = 0.08;

export const FEEDBACK_TONES: Readonly<Record<FeedbackEvent, readonly Tone[]>> = {
  start: [{ from: 880, to: 1320, ms: 70, at: 0 }],
  stop: [{ from: 990, to: 660, ms: 80, at: 0 }],
  cancel: [{ from: 520, to: 360, ms: 110, at: 0 }],
  failure: [
    { from: 330, to: 300, ms: 90, at: 0 },
    { from: 262, to: 240, ms: 120, at: 120 },
  ],
};

/**
 * Which sound a status change makes, given the one before it — the moments the Mac's
 * controller plays them: key-down, key-up, a chord's cancel, and a failure.
 */
export function feedbackFor(previous: DictationStatus['kind'] | null, next: DictationStatus): FeedbackEvent | null {
  if (next.kind === 'listening' && previous !== 'listening') return 'start';
  if (previous === 'listening' && next.kind === 'working') return 'stop';
  if (previous === 'listening' && next.kind === 'idle') return 'cancel';
  if (next.kind === 'failed' && previous !== 'failed') return 'failure';
  return null;
}
