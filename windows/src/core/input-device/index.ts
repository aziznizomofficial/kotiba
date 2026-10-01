// Which microphone a dictation was recorded from, and what to say when it barely heard
// anything. PURE — the port of Sources/KotibaCore/InputDevice.swift.
//
// Real use on 2026-10-01 (Mac): twelve dictations came back "heard nothing" at peaks of
// 0.005–0.016 (normal speech peaks 0.14–0.70) while an iPhone Continuity microphone was
// listed as an input, and nothing in the diagnostics said which device had been listening.
// This is the record of it, and the gate on the hint that tells the person — once, calmly.

import type { DictationRecord, InputDeviceInfo, InputTransport } from '../../contracts/index.js';

// ---------------------------------------------------------------------------------
// What kind of device
// ---------------------------------------------------------------------------------

/**
 * The transport, from the only thing a browser-hosted capture can see: the device label.
 * Chromium exposes no transport type, so this is a HEURISTIC and says so by defaulting to
 * `other` rather than guessing. The Mac reads the real CoreAudio transport.
 */
export function classifyTransport(label: string): InputTransport {
  const lower = label.toLowerCase();
  if (/\b(iphone|ipad)\b/u.test(lower)) return 'continuity';
  if (/bluetooth|hands-free|handsfree|airpods|\bbuds\b/u.test(lower)) return 'bluetooth';
  if (/\busb\b/u.test(lower)) return 'usb';
  if (/microphone array|built-in|internal|realtek|smart sound|conexant/u.test(lower)) return 'builtIn';
  if (/virtual|loopback|voicemeeter|vb-audio|cable/u.test(lower)) return 'virtual';
  return 'other';
}

/** A name can also reveal a phone when the transport heuristic put it elsewhere (a USB label). */
export function refineTransport(reported: InputTransport, name: string): InputTransport {
  if (reported === 'builtIn' || reported === 'continuity') return reported;
  return /\b(iphone|ipad)\b/iu.test(name) ? 'continuity' : reported;
}

/** What the plain-text diagnostics summary may say: everything but the name. */
export function redactedDeviceDescription(device: InputDeviceInfo): string {
  const parts: string[] = [device.transport];
  if (device.sampleRate !== undefined) parts.push(`${Math.round(device.sampleRate)} Hz`);
  if (device.overrodeDefault === true) parts.push('overrode system default');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------------
// The quiet-microphone hint
// ---------------------------------------------------------------------------------

/** A take at least this long was a real hold, not a tap. */
export const QUIET_MIC_MIN_SECONDS = 1.5;
/**
 * …whose peak stayed under this. Normal speech peaks 0.14–0.70 and the silence gate is
 * 0.012; the twelve failures were 0.005–0.016. Above 0.03 someone was audibly speaking and
 * "quiet" would be the wrong diagnosis.
 */
export const QUIET_MIC_PEAK_BELOW = 0.03;
/** Once per device per hour, so a person who keeps trying is not nagged on every attempt. */
export const QUIET_MIC_COOLDOWN_MS = 3_600_000;

/**
 * The device to blame, when `record` is a heard-nothing take that fits the pattern. Null for
 * anything else — including a quiet take whose device is not known, because the hint names
 * the device and a hint without one is only a worse "didn’t catch that".
 */
export function quietMicSuspect(record: DictationRecord): InputDeviceInfo | null {
  if (record.outcome !== 'heardNothing') return null;
  if (record.audioSeconds < QUIET_MIC_MIN_SECONDS) return null;
  if (record.peakAmplitude >= QUIET_MIC_PEAK_BELOW) return null;
  return record.inputDevice ?? null;
}

const GENERIC_NAME_WORDS = new Set(['microphone', 'mic', 'input', 'микрофон']);

/**
 * How the device is named in the pill: short enough for a 160 px capsule. Drops the generic
 * tail ("Microphone", "Mic", "Input"), keeps at most two words, cuts at 14 characters.
 */
export function quietMicPillName(name: string): string {
  const words = name.split(/\s+/u).filter((word) => word !== '');
  while (words.length > 1 && GENERIC_NAME_WORDS.has((words[words.length - 1] ?? '').toLowerCase())) words.pop();
  const short = words.slice(0, 2).join(' ');
  const chars = [...short];
  return chars.length <= 14 ? short : `${chars.slice(0, 13).join('')}…`;
}

/** Which sentence explains the device. */
export type QuietMicKind = 'continuity' | 'external' | 'builtIn';

export function quietMicKind(device: InputDeviceInfo): QuietMicKind {
  switch (refineTransport(device.transport, device.name)) {
    case 'continuity':
      return 'continuity';
    case 'builtIn':
      return 'builtIn';
    default:
      return 'external';
  }
}

/**
 * Remembers when each device was last complained about. A closure over a map, so the
 * controller owns one and a test drives it with a clock of its own.
 */
export interface QuietMicLimiter {
  /** True — and the device is marked — when it has not been reported within the cooldown. */
  admit(device: InputDeviceInfo, nowMs: number): boolean;
}

export function createQuietMicLimiter(): QuietMicLimiter {
  const lastShown = new Map<string, number>();
  return {
    admit(device, nowMs) {
      const last = lastShown.get(device.name);
      if (last !== undefined && nowMs - last < QUIET_MIC_COOLDOWN_MS) return false;
      lastShown.set(device.name, nowMs);
      return true;
    },
  };
}

/** Where "Open Sound settings" goes on Windows. */
export const SOUND_SETTINGS_URI = 'ms-settings:sound';
