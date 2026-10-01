// The floating pill — what appears while you are talking. Loaded by `hud.html` into a
// transparent, click-through, never-focusable window at the bottom centre of the active
// monitor (`src/main/windows.ts`). The capsule animates INSIDE a fixed canvas, so no
// state change ever resizes the window.
//
// Two rules this page must not break:
//
//   * NOTHING HERE IS FOCUSABLE OR CLICKABLE. No <button>, no <a>, no tabindex, and the
//     whole page is `pointer-events: none` on top of the window's own WS_EX_TRANSPARENT.
//     A HUD that takes the caret means the words go into this page instead of the user's
//     document.
//   * IT IS PURELY OBSERVATIONAL. It draws what main sends and writes nothing back. It
//     is also where the optional start/stop sounds play, because it is the one page that
//     is always alive and never throttled.

import type { FeedbackEvent } from '../main/feedback-model.js';
import { FEEDBACK_GAIN, FEEDBACK_TONES } from '../main/feedback-model.js';
import type { PillFrame } from '../main/pill-model.js';
import { DEFAULT_PILL_STYLE, pillDwellMs } from '../main/pill-model.js';
import { setAppLanguage } from '../core/i18n/index.js';
import { IPC_INVOKE, IPC_SEND } from '../main/ipc.js';
import { springCustomProperties } from '../main/motion.js';

import { invoke, on } from './bridge.js';
import { h } from './components.js';
import { createPill } from './pill.js';

export function mountHud(root: HTMLElement): void {
  for (const [name, value] of Object.entries(springCustomProperties())) {
    document.documentElement.style.setProperty(name, value);
  }
  const pill = createPill({ style: DEFAULT_PILL_STYLE });
  root.replaceChildren(h('div', { class: 'pill-canvas' }, [pill.element]));

  let dwell: number | null = null;
  let lastKey = '';
  const apply = (frame: PillFrame): void => {
    if (frame.language !== undefined && setAppLanguage(frame.language)) document.documentElement.lang = frame.language;
    // The setting and the monitor ride on every frame, so a change in Settings is live.
    if (frame.style !== undefined) pill.setStyle(frame.style);
    if (frame.maxMessageWidth !== undefined) pill.setMaxMessageWidth(frame.maxMessageWidth);
    // An outcome stays for its dwell, then the capsule sinks back down — independently of
    // when main hides the window, exactly as the Mac's `folded` flag works.
    const key = JSON.stringify(frame.state);
    if (key !== lastKey) {
      lastKey = key;
      if (dwell !== null) clearTimeout(dwell);
      dwell = null;
      const ms = pillDwellMs(frame.state);
      if (ms !== null && frame.presented) {
        dwell = window.setTimeout(() => {
          pill.set(frame.state, false);
        }, ms);
      }
    }
    pill.set(frame.state, frame.presented);
  };

  on<PillFrame>(IPC_SEND.pillFrame, apply);
  on<FeedbackEvent>(IPC_SEND.feedback, (event) => playFeedback(event));
  on<number>(IPC_SEND.levelChanged, (level) => pill.setLevel(level));
  void invoke<PillFrame | null>(IPC_INVOKE.hudSnapshot).then((frame) => {
    if (frame !== null && typeof frame === 'object' && 'state' in frame) apply(frame);
  });
}

let context: AudioContext | null = null;

/** A quiet synthesised blip. Fire and forget: a sound that will not play is not an error. */
function playFeedback(event: FeedbackEvent): void {
  try {
    context ??= new AudioContext();
    const audio = context;
    void audio.resume();
    const start = audio.currentTime + 0.01;
    for (const tone of FEEDBACK_TONES[event] ?? []) {
      const at = start + tone.at / 1000;
      const end = at + tone.ms / 1000;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(tone.from, at);
      oscillator.frequency.exponentialRampToValueAtTime(tone.to, end);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(FEEDBACK_GAIN, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(end + 0.02);
    }
  } catch {
    /* no audio device, or none yet: the dictation does not care */
  }
}

const mount = document.getElementById('root');
if (mount !== null) mountHud(mount);
