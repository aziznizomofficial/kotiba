// The input device in the diagnostics record, and the gate on the "very quiet" hint. The
// port of Tests/KotibaCoreTests/InputDeviceTests.swift. Every device is invented; nothing
// opens audio.

import { describe, expect, it } from 'vitest';

import type { DictationRecord, InputDeviceInfo } from '../../src/contracts/index.js';
import { EMPTY_DICTATION_RECORD } from '../../src/contracts/index.js';
import {
  QUIET_MIC_COOLDOWN_MS,
  classifyTransport,
  createQuietMicLimiter,
  quietMicKind,
  quietMicPillName,
  quietMicSuspect,
  redactedDeviceDescription,
  refineTransport,
} from '../../src/core/input-device/index.js';

const phone: InputDeviceInfo = { name: 'Test iPhone Microphone', transport: 'continuity', sampleRate: 48_000, overrodeDefault: false };
const laptop: InputDeviceInfo = { name: 'Microphone Array (Test)', transport: 'builtIn', sampleRate: 48_000, overrodeDefault: false };

function take(overrides: Partial<DictationRecord> = {}): DictationRecord {
  return {
    ...EMPTY_DICTATION_RECORD,
    startedAt: '2026-10-01T10:00:00Z',
    outcome: 'heardNothing',
    audioSeconds: 8,
    peakAmplitude: 0.008,
    inputDevice: phone,
    ...overrides,
  };
}

describe('transport from a label', () => {
  it('reads what a browser can say, and defaults to other rather than guessing', () => {
    expect(classifyTransport('Aziz’s iPhone Microphone')).toBe('continuity');
    expect(classifyTransport('Headset (AirPods Pro) Hands-Free')).toBe('bluetooth');
    expect(classifyTransport('USB Audio Device')).toBe('usb');
    expect(classifyTransport('Microphone Array (Realtek(R) Audio)')).toBe('builtIn');
    expect(classifyTransport('Voicemeeter Out B1')).toBe('virtual');
    expect(classifyTransport('Blue Yeti')).toBe('other');
    expect(classifyTransport('')).toBe('other');
  });

  it('refines by name, but never overrides built-in or continuity', () => {
    expect(refineTransport('usb', 'Test iPhone Microphone')).toBe('continuity');
    expect(refineTransport('builtIn', 'iPhone')).toBe('builtIn');
    expect(refineTransport('usb', 'Blue Yeti')).toBe('usb');
  });
});

describe('the quiet-microphone gate', () => {
  it('a 1.5 s+ heard-nothing take under peak 0.03 with a known device qualifies', () => {
    expect(quietMicSuspect(take())).toBe(phone);
    // The measured burst: peaks 0.005–0.016, 8–13 s holds.
    for (const peak of [0.005, 0.016, 0.0299]) expect(quietMicSuspect(take({ audioSeconds: 13, peakAmplitude: peak }))).not.toBeNull();
    expect(quietMicSuspect(take({ audioSeconds: 1.5 }))).not.toBeNull();
  });

  it.each([
    ['a tap, not a hold', take({ audioSeconds: 1.49 })],
    ['loud enough to have been speech', take({ peakAmplitude: 0.03 })],
    ['a dictation that worked', take({ outcome: 'done' })],
    ['a failure', take({ outcome: 'failed' })],
    ['device not known', (() => { const { inputDevice: _unused, ...rest } = take(); return rest as DictationRecord; })()],
  ])('does not qualify: %s', (_why, record) => {
    expect(quietMicSuspect(record)).toBeNull();
  });

  it('says once per device per hour, and a different device is its own count', () => {
    const limiter = createQuietMicLimiter();
    const t0 = 1_785_000_000_000;
    expect(limiter.admit(phone, t0)).toBe(true);
    expect(limiter.admit(phone, t0 + 60_000)).toBe(false);
    expect(limiter.admit(phone, t0 + QUIET_MIC_COOLDOWN_MS - 1)).toBe(false);
    expect(limiter.admit(laptop, t0 + 61_000)).toBe(true);
    expect(limiter.admit(phone, t0 + QUIET_MIC_COOLDOWN_MS)).toBe(true);
    expect(limiter.admit(phone, t0 + QUIET_MIC_COOLDOWN_MS + 1)).toBe(false);
  });

  it('names the device in the pill in at most two short words', () => {
    expect(quietMicPillName('Test iPhone Microphone')).toBe('Test iPhone');
    expect(quietMicPillName('iPhone Microphone')).toBe('iPhone');
    expect(quietMicPillName('Microphone')).toBe('Microphone');
    const long = quietMicPillName('Wwwwwwwwwwwwwwwwww Wwwwwwwwwwwwww');
    expect([...long].length).toBeLessThanOrEqual(14);
    expect(long.endsWith('…')).toBe(true);
    expect(quietMicPillName('Sony WH-1000XM4 Hands-Free AG Audio').split(' ').length).toBeLessThanOrEqual(2);
  });

  it('explains the device by what it is', () => {
    expect(quietMicKind(phone)).toBe('continuity');
    expect(quietMicKind({ name: 'Phone Link iPhone', transport: 'usb' })).toBe('continuity');
    expect(quietMicKind(laptop)).toBe('builtIn');
    expect(quietMicKind({ name: 'Blue Yeti', transport: 'usb' })).toBe('external');
    expect(quietMicKind({ name: 'AirPods', transport: 'bluetooth' })).toBe('external');
  });
});

describe('what a summary may say about a device', () => {
  it('the kind, the rate and the override — never the name', () => {
    expect(redactedDeviceDescription({ ...phone, overrodeDefault: true })).toBe('continuity, 48000 Hz, overrode system default');
    expect(redactedDeviceDescription({ name: 'X', transport: 'usb' })).toBe('usb');
    expect(redactedDeviceDescription(phone)).not.toContain('iPhone');
  });
});
