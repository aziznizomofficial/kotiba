// Ducking, against a fake mixer — never this machine's. The port of
// Tests/KotibaAudioTests/OutputDuckerTests.swift onto per-session volumes: only what is
// playing is lowered, 200 ms after key-down, ramped both ways, restored exactly, the
// user's own change wins, and a crash mid-hold is repaired from the marker.

import { describe, expect, it } from 'vitest';

import {
  DUCKING_TIMING,
  createDucker,
  helperDuckingBackend,
  smoothstep,
  type AudioSessionInfo,
  type DuckingBackend,
  type MarkerStore,
  type VolumeWrite,
} from '../../src/platform/ducking.js';

const KOTIBA_PID = 4242;

class FakeMixer implements DuckingBackend {
  readonly sessions_ = new Map<string, AudioSessionInfo>();
  /** Every write, in order: `id=value`. */
  readonly writes: string[] = [];
  /** A driver that quantises: the value read back is rounded to this step. */
  quantum = 0;

  add(id: string, pid: number, volume: number, muted = false): void {
    this.sessions_.set(id, { id, pid, volume, muted });
  }

  volume(id: string): number {
    return this.sessions_.get(id)?.volume ?? Number.NaN;
  }

  /** The user drags the app's slider in the Volume Mixer. */
  userSets(id: string, volume: number): void {
    const session = this.sessions_.get(id);
    if (session !== undefined) this.sessions_.set(id, { ...session, volume });
  }

  async sessions(): Promise<readonly AudioSessionInfo[]> {
    return [...this.sessions_.values()];
  }

  async setVolume(id: string, volume: number, ifNear: number | null): Promise<VolumeWrite> {
    const session = this.sessions_.get(id);
    if (session === undefined) return { kind: 'gone' };
    if (ifNear !== null && Math.abs(session.volume - ifNear) > 0.02) {
      return { kind: 'userChanged', volume: session.volume };
    }
    const stored = this.quantum > 0 ? Math.round(volume / this.quantum) * this.quantum : volume;
    this.sessions_.set(id, { ...session, volume: stored });
    this.writes.push(`${id}=${stored.toFixed(3)}`);
    return { kind: 'set', volume: stored };
  }
}

class MemoryMarker implements MarkerStore {
  contents: string | null = null;
  async read(): Promise<string | null> {
    return this.contents;
  }
  async write(contents: string): Promise<void> {
    this.contents = contents;
  }
  async remove(): Promise<void> {
    this.contents = null;
  }
}

/** Sleeps that resolve when the test says so, recording how long each asked for. */
class Clock {
  readonly asked: number[] = [];
  #waiting: (() => void)[] = [];
  sleep = (ms: number): Promise<void> => {
    this.asked.push(ms);
    return new Promise((resolve) => this.#waiting.push(resolve));
  };
  /** Release every pending sleep, repeatedly, until nothing is waiting. */
  async run(): Promise<void> {
    for (let round = 0; round < 200; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const waiting = this.#waiting.splice(0);
      if (waiting.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.#waiting.length === 0) return;
        continue;
      }
      for (const wake of waiting) wake();
    }
  }
}

function rig() {
  const mixer = new FakeMixer();
  const marker = new MemoryMarker();
  const clock = new Clock();
  const ducker = createDucker({
    backend: mixer,
    marker,
    ownPids: () => new Set([KOTIBA_PID]),
    sleep: clock.sleep,
  });
  return { mixer, marker, clock, ducker };
}

describe('lowering what is playing', () => {
  it('waits 200 ms, then ramps every other playing app to 25% of its own level', async () => {
    const r = rig();
    r.mixer.add('spotify', 100, 0.8);
    r.mixer.add('browser', 200, 0.5);
    r.ducker.duck(0.25);
    await r.clock.run();
    expect(r.clock.asked[0]).toBe(DUCKING_TIMING.startDelayMs);
    expect(r.mixer.volume('spotify')).toBeCloseTo(0.2, 5);
    expect(r.mixer.volume('browser')).toBeCloseTo(0.125, 5);
    // Twelve steps each, on the ~13 ms cadence of a 160 ms ramp.
    expect(r.mixer.writes.filter((w) => w.startsWith('spotify'))).toHaveLength(DUCKING_TIMING.steps);
    expect(r.clock.asked.slice(1).every((ms) => Math.abs(ms - DUCKING_TIMING.rampMs / DUCKING_TIMING.steps) < 1e-9)).toBe(true);
    expect(r.ducker.decision).toBe('ducked');
  });

  it('never touches Kotiba itself, a muted app, or one already silent', async () => {
    const r = rig();
    r.mixer.add('kotiba-chime', KOTIBA_PID, 1);
    r.mixer.add('muted', 300, 0.9, true);
    r.mixer.add('silent', 301, 0);
    r.ducker.duck(0.25);
    await r.clock.run();
    expect(r.mixer.writes).toEqual([]);
    expect(r.ducker.decision).toBe('nothing playing');
    expect(r.marker.contents).toBeNull();
  });

  it('a Ctrl+C inside the 200 ms never dips the music', async () => {
    const r = rig();
    r.mixer.add('spotify', 100, 0.8);
    r.ducker.duck(0.25);
    r.ducker.restore(); // the chord cancelled the hold before the delay was up
    await r.clock.run();
    expect(r.mixer.writes).toEqual([]);
    expect(r.mixer.volume('spotify')).toBe(0.8);
  });
});

describe('putting it back', () => {
  it('restores exactly, ramped, and forgets the marker', async () => {
    const r = rig();
    r.mixer.add('spotify', 100, 0.8);
    r.ducker.duck(0.25);
    await r.clock.run();
    expect(r.marker.contents).not.toBeNull();
    r.ducker.restore();
    await r.clock.run();
    expect(r.mixer.volume('spotify')).toBe(0.8);
    expect(r.ducker.decision).toBe('restored');
    expect(r.marker.contents).toBeNull();
  });

  it('the ramp is smoothstep: no audible corner at either end', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(0.1)).toBeLessThan(0.1);
    expect(smoothstep(0.9)).toBeGreaterThan(0.9);
  });

  it('the user moved the slider during the hold: their level stands', async () => {
    const r = rig();
    r.mixer.add('spotify', 100, 0.8);
    r.ducker.duck(0.25);
    await r.clock.run();
    r.mixer.userSets('spotify', 0.6);
    r.ducker.restore();
    await r.clock.run();
    expect(r.mixer.volume('spotify')).toBe(0.6);
    expect(r.ducker.decision).toBe("left the user's volume alone");
    expect(r.marker.contents).toBeNull();
  });

  it('a quantising driver does not look like the user', async () => {
    const r = rig();
    r.mixer.quantum = 0.01;
    r.mixer.add('spotify', 100, 0.8);
    r.ducker.duck(0.25);
    await r.clock.run();
    r.ducker.restore();
    await r.clock.run();
    expect(r.mixer.volume('spotify')).toBeCloseTo(0.8, 5);
    expect(r.ducker.decision).toBe('restored');
  });

  it('pressed again while the restore is ramping: back down from where it got to', async () => {
    const r = rig();
    r.mixer.add('spotify', 100, 0.8);
    r.ducker.duck(0.25);
    await r.clock.run();
    r.ducker.restore();
    r.ducker.duck(0.25);
    await r.clock.run();
    expect(r.mixer.volume('spotify')).toBeCloseTo(0.2, 5);
    r.ducker.restore();
    await r.clock.run();
    expect(r.mixer.volume('spotify')).toBe(0.8);
  });

  it('restoreImmediately (the quit path) puts it back with no ramp', async () => {
    const r = rig();
    r.mixer.add('spotify', 100, 0.8);
    r.ducker.duck(0.25);
    await r.clock.run();
    const writesBefore = r.mixer.writes.length;
    await r.ducker.restoreImmediately();
    expect(r.mixer.writes.length - writesBefore).toBe(1);
    expect(r.mixer.volume('spotify')).toBe(0.8);
  });
});

describe('after a crash', () => {
  it('restores a session still sitting at the ducked level, and forgets the marker', async () => {
    const r = rig();
    r.mixer.add('spotify', 100, 0.2);
    r.marker.contents = JSON.stringify({ sessions: [{ id: 'spotify', prior: 0.8, target: 0.2 }] });
    await r.ducker.recoverFromCrash();
    expect(r.mixer.volume('spotify')).toBe(0.8);
    expect(r.ducker.decision).toBe('restored after a crash');
    expect(r.marker.contents).toBeNull();
  });

  it('leaves one the user has changed since, and one that has gone', async () => {
    const r = rig();
    r.mixer.add('spotify', 100, 0.55);
    r.marker.contents = JSON.stringify({
      sessions: [
        { id: 'spotify', prior: 0.8, target: 0.2 },
        { id: 'closed-app', prior: 1, target: 0.25 },
      ],
    });
    await r.ducker.recoverFromCrash();
    expect(r.mixer.volume('spotify')).toBe(0.55);
    expect(r.ducker.decision).toBe('user had changed it since');
  });

  it('a torn marker is discarded, not trusted', async () => {
    const r = rig();
    r.marker.contents = '{"sessions": [';
    await r.ducker.recoverFromCrash();
    expect(r.ducker.decision).toBe('stale marker discarded');
    expect(r.marker.contents).toBeNull();
  });
});

describe('the kotiba-input backend', () => {
  it('speaks the helper protocol: guarded writes, refusals by code, never a throw for a gone session', async () => {
    const sent: Record<string, unknown>[] = [];
    const backend = helperDuckingBackend({
      async request(command) {
        sent.push(command);
        if (command['op'] === 'audioSessions') {
          return { ok: true, sessions: [{ id: 'a', pid: 1, volume: 0.5, muted: false }] };
        }
        if (command['session'] === 'moved') return { ok: false, code: 'userChanged', volume: 0.7 };
        if (command['session'] === 'gone') return { ok: false, code: 'sessionGone' };
        return { ok: true, volume: Number(command['volume']) };
      },
    });
    expect(await backend.sessions()).toEqual([{ id: 'a', pid: 1, volume: 0.5, muted: false }]);
    expect(await backend.setVolume('a', 0.25, 0.5)).toEqual({ kind: 'set', volume: 0.25 });
    expect(sent.at(-1)).toMatchObject({ op: 'setSessionVolume', session: 'a', volume: 0.25, ifNear: 0.5, tolerance: 0.02 });
    expect(await backend.setVolume('moved', 0.25, 0.5)).toEqual({ kind: 'userChanged', volume: 0.7 });
    expect(await backend.setVolume('gone', 0.25, null)).toEqual({ kind: 'gone' });
    expect(sent.at(-1)).not.toHaveProperty('ifNear');
    // Clamped: a duck to 300% is a louder machine, never a quieter one.
    await backend.setVolume('a', 3, null);
    expect(sent.at(-1)).toMatchObject({ volume: 1 });
  });
});
