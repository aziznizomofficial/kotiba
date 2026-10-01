// The pill, the springs and the status words — the pure halves of the HUD and the window,
// tested without a window. Ports of the Mac's pill mapping tests, plus the spring-to-CSS
// conversion that is Windows' own.

import { describe, expect, it } from 'vitest';

import type { DictationRecord } from '../../src/contracts/index.js';
import { FEEDBACK_GAIN, FEEDBACK_TONES, feedbackFor } from '../../src/main/feedback-model.js';
import { liveStatus, withoutHealing } from '../../src/main/live-status.js';
import { SPRINGS, cssSpring, settleTime, springCustomProperties, springValue } from '../../src/main/motion.js';
import {
  DEFAULT_PILL_STYLE,
  HEARD_NOTHING_MESSAGE,
  PILL_ANIMATION_STYLES,
  PILL_BOTTOM_GAP,
  PILL_CANVAS_HEIGHT,
  PILL_CANVAS_WIDTH,
  PILL_HEIGHT,
  PILL_SHADOW_ROOM,
  PILL_WIDTH,
  modeGlyph,
  pillCanvasBounds,
  pillDwellMs,
  pillState,
  pillStyleName,
  resolvePillStyle,
} from '../../src/main/pill-model.js';
import { DEFAULT_SETTINGS } from '../../src/contracts/index.js';

const record: DictationRecord = {
  audioSeconds: 2,
  errors: [],
  outcome: 'done',
  peakAmplitude: 0.4,
  route: { language: 'uz', source: 'acoustic', clusterMass: 0.4 } as unknown as DictationRecord['route'],
  stageMillis: { arming: 50, transcribing: 150, inserting: 34 },
  startedAt: '2026-09-29T10:00:00Z',
};

describe('the pill', () => {
  it('is the Mac capsule: 160 × 36', () => {
    expect([PILL_WIDTH, PILL_HEIGHT]).toEqual([160, 36]);
  });

  it('names the microphone when a heard-nothing take was quiet, and only then', () => {
    const quietMic = { name: 'Test iPhone Microphone', transport: 'continuity', sampleRate: 48_000, overrodeDefault: false } as const;
    expect(pillState({ kind: 'heardNothing', quietMic }, null)).toEqual({
      kind: 'attention',
      message: 'Mic very quiet — using Test iPhone?',
    });
    expect(pillState({ kind: 'heardNothing' }, null)).toEqual({ kind: 'attention', message: HEARD_NOTHING_MESSAGE });
  });

  it('maps every status the way the Mac does', () => {
    expect(pillState({ kind: 'listening' }, null)).toEqual({ kind: 'listening' });
    expect(pillState({ kind: 'working', stage: 'transcribing' }, null)).toEqual({ kind: 'processing' });
    expect(pillState({ kind: 'preparing', what: 'Uzbek model' }, null)).toEqual({ kind: 'processing' });
    // Key-up to paste: every stage but arming.
    expect(pillState({ kind: 'succeeded', text: 'x' }, record)).toEqual({ kind: 'success', millis: 184 });
    expect(pillState({ kind: 'heardNothing' }, null)).toEqual({ kind: 'attention', message: HEARD_NOTHING_MESSAGE });
    // The pill says its few words; the sentence stays on Home.
    expect(pillState({ kind: 'failed', message: 'Could not paste — the app refused', pill: 'Couldn’t paste' }, null)).toEqual({
      kind: 'attention',
      message: 'Couldn’t paste',
    });
    expect(pillState({ kind: 'failed', message: 'a model failed to load' }, null)).toEqual({
      kind: 'attention',
      message: 'Didn’t finish — see Home',
    });
    expect(pillState({ kind: 'idle' }, null)).toEqual({ kind: 'hidden' });
  });

  it('folds an outcome after the Mac\'s dwell, and never a live state', () => {
    expect(pillDwellMs({ kind: 'success', millis: 1 })).toBe(900);
    expect(pillDwellMs({ kind: 'attention', message: 'x' })).toBe(2_200);
    expect(pillDwellMs({ kind: 'listening' })).toBeNull();
  });

  it('sits at the bottom centre of the work area, above the taskbar', () => {
    // 1920 × 1080 with a 48 px taskbar at the bottom: the work area stops above it.
    const workArea = { x: 0, y: 0, width: 1920, height: 1032 };
    const bounds = pillCanvasBounds(workArea);
    expect(bounds.width).toBe(PILL_CANVAS_WIDTH);
    expect(bounds.height).toBe(PILL_CANVAS_HEIGHT);
    expect(bounds.x + bounds.width / 2).toBe(960);
    // The capsule's bottom edge is the canvas bottom less the shadow room.
    const capsuleBottom = bounds.y + bounds.height - PILL_SHADOW_ROOM;
    expect(capsuleBottom).toBe(workArea.height - PILL_BOTTOM_GAP);
    expect(capsuleBottom).toBeLessThan(workArea.height);
    // A second monitor to the left, taskbar on top: still that monitor's bottom centre.
    const left = pillCanvasBounds({ x: -1280, y: 40, width: 1280, height: 984 });
    expect(left.x + left.width / 2).toBe(-640);
    expect(left.y + left.height - PILL_SHADOW_ROOM).toBe(40 + 984 - PILL_BOTTOM_GAP);
  });

  it('offers the owner\'s three styles, Siri lobes unless the user chose otherwise', () => {
    // The Mac's `PillAnimationStyle`, case for case and raw value for raw value.
    expect(PILL_ANIMATION_STYLES).toEqual(['sirifilled', 'sirilobes', 'barsglow']);
    expect(DEFAULT_PILL_STYLE).toBe('sirilobes');
    expect(DEFAULT_SETTINGS.pillStyle).toBe('sirilobes');
    expect(new Set(PILL_ANIMATION_STYLES.map(pillStyleName)).size).toBe(3);
  });

  it('reads a stored style it does not know as the default, never as a failure', () => {
    expect(resolvePillStyle('barsglow')).toBe('barsglow');
    expect(resolvePillStyle('waveDots')).toBe('sirilobes');
    expect(resolvePillStyle('')).toBe('sirilobes');
    expect(resolvePillStyle(undefined)).toBe('sirilobes');
  });

  it('keeps a glyph per mode for the Modes page', () => {
    expect(modeGlyph('super')).toBe('sparkles');
    expect(modeGlyph('message')).toBe('bubble');
    expect(modeGlyph('note')).toBe('note');
    expect(modeGlyph('transcription')).toBe('cursor');
  });
});

describe('the springs', () => {
  it('start at rest and settle on the target', () => {
    for (const spring of Object.values(SPRINGS)) {
      expect(springValue(spring, 0)).toBe(0);
      expect(Math.abs(1 - springValue(spring, settleTime(spring)))).toBeLessThan(0.0015);
    }
  });

  it('only the bouncy ones overshoot — smooth never does', () => {
    const peak = (spring: { duration: number; bounce: number }): number => {
      let max = 0;
      for (let t = 0; t < 2; t += 0.001) max = Math.max(max, springValue(spring, t));
      return max;
    };
    expect(peak(SPRINGS.smooth)).toBeLessThanOrEqual(1);
    expect(peak(SPRINGS.pop)).toBeGreaterThan(1.02);
  });

  it('become a CSS linear() easing that starts at 0 and ends exactly at 1', () => {
    const css = cssSpring(SPRINGS.snappy);
    expect(css.easing.startsWith('linear(0, ')).toBe(true);
    expect(css.easing.endsWith(', 1)')).toBe(true);
    expect(css.durationMs).toBeGreaterThan(200);
    const properties = springCustomProperties();
    expect(Object.keys(properties)).toContain('--spring-pop');
    expect(properties['--spring-pop-ms']).toMatch(/^\d+ms$/u);
  });
});

describe('the status in words', () => {
  it('ready, almost ready, listening — the sidebar and the hero agree', () => {
    expect(liveStatus({ kind: 'idle' }, [], 'right Ctrl')).toMatchObject({
      title: 'Ready',
      detail: 'Hold right Ctrl anywhere, speak, and let go.',
      busy: false,
    });
    // Calm, not an alarm: the notices under the hero say what to do (owner, 2026-09-30).
    expect(
      liveStatus({ kind: 'idle' }, [{ id: 'microphone', headline: 'x', detail: null }], 'right Ctrl'),
    ).toMatchObject({ title: 'Almost ready', detail: 'Hold right Ctrl anywhere, speak, and let go.', tone: 'neutral' });
    // Loading finishes by itself and is not coloured like a problem.
    expect(liveStatus({ kind: 'preparing', what: 'Uzbek model' }, [], 'F13').tone).toBe('neutral');
    expect(liveStatus({ kind: 'listening' }, [], 'F13')).toMatchObject({ title: 'Listening', busy: true });
    expect(liveStatus({ kind: 'working', stage: 'transcribing' }, [], 'F13').title).toBe('Transcribing');
  });
});

describe('the four sounds', () => {
  it('sound at key-down, key-up, a chord and a failure — the Mac\'s four moments', () => {
    expect(feedbackFor(null, { kind: 'listening' })).toBe('start');
    expect(feedbackFor('listening', { kind: 'working', stage: 'transcribing' })).toBe('stop');
    expect(feedbackFor('listening', { kind: 'idle' })).toBe('cancel');
    expect(feedbackFor('working', { kind: 'failed', message: 'x' })).toBe('failure');
    expect(feedbackFor('working', { kind: 'succeeded', text: 'x' })).toBeNull();
    expect(feedbackFor('listening', { kind: 'listening' })).toBeNull();
  });

  it('every event has a short, quiet sound', () => {
    for (const tones of Object.values(FEEDBACK_TONES)) {
      expect(tones.length).toBeGreaterThan(0);
      for (const tone of tones) expect(tone.ms).toBeLessThanOrEqual(150);
    }
    expect(FEEDBACK_GAIN).toBeLessThanOrEqual(0.1);
  });
});

describe('what counts as a blocker', () => {
  it('a missing model whose download is running is held back, and comes back if it fails', () => {
    const uzbek = { id: 'uzbek-model', headline: 'No Uzbek model', detail: null } as const;
    const hotkey = { id: 'hotkey', headline: 'x', detail: null } as const;
    const downloading = { kind: 'downloading', receivedBytes: 1, totalBytes: 2 } as const;
    expect(withoutHealing([uzbek, hotkey], [{ id: 'uzbek_stt_v1', state: downloading }])).toEqual([hotkey]);
    expect(withoutHealing([uzbek, hotkey], [{ id: 'uzbek_stt_v1', state: { kind: 'failed', reason: 'offline' } }])).toEqual([
      uzbek,
      hotkey,
    ]);
    // Another model downloading does not hide it.
    expect(withoutHealing([uzbek], [{ id: 'qwen3_1_7b', state: downloading }])).toEqual([uzbek]);
  });
});
