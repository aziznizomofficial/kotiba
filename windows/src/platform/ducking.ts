// Lower what other apps are playing while the key is held; put it back on release.
//
// The port of `OutputDucker` (Sources/KotibaAudio/OutputDucker.swift) — its timing, its
// "only what is actually playing" rule, its exact restore, its deference to the user and
// its crash marker — onto the mechanism Windows offers: PER-SESSION volume.
//
// WHY SESSIONS AND NOT THE MASTER VOLUME. On the Mac the device volume is the only knob
// that ramps smoothly, and every shipping analog moves it. On Windows the master volume is
// shared by every app, and a session's `ISimpleAudioVolume` is exactly the per-app slider
// in the Volume Mixer: lowering Spotify's slider leaves everything that is not playing
// alone, and never touches the level the user set for their speakers. The native half is
// two commands in `kotiba-input.exe` (`audioSessions`, `setSessionVolume`); ALL of the
// policy is here, where it is tested against a fake backend and can never move this
// machine's volume from a test.
//
// The rules, each the Mac's:
//
//   * NOTHING PLAYING, NOTHING TOUCHED. Only sessions in `AudioSessionStateActive` are
//     listed, Kotiba's own processes are excluded, and a session already silent or muted is
//     left alone.
//   * 200 ms START DELAY. A Right Ctrl that turns into Ctrl+C is cancelled inside it, so a
//     keyboard shortcut never dips the music.
//   * ~160 ms SMOOTHSTEP RAMPS, both ways, twelve steps. No audible corner at either end.
//   * EXACT RESTORE, AND THE USER WINS. Each session's level before the duck is kept, and
//     so is the level Kotiba last wrote. A session that has moved away from what Kotiba wrote
//     was moved by the user during the hold; their choice stands and that session is not
//     touched again. The check and the write are ONE helper call (`ifNear`), so there is no
//     gap between looking and writing.
//   * A CRASH MARKER. "Ducked from X" is on disk for the length of the duck, so a crash or
//     an End Task mid-hold is repaired at the next launch instead of leaving someone's
//     music at a quarter volume for good. Session instance identifiers outlive a Kotiba
//     process, which is what makes the marker usable by the next one.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One playing session, as the helper lists it. */
export interface AudioSessionInfo {
  /** `IAudioSessionControl2::GetSessionInstanceIdentifier`. Stable for the session's life. */
  readonly id: string;
  readonly pid: number;
  /** `ISimpleAudioVolume::GetMasterVolume`, 0…1. */
  readonly volume: number;
  readonly muted: boolean;
}

/** What a guarded write came back with. */
export type VolumeWrite =
  | { readonly kind: 'set'; readonly volume: number }
  | { readonly kind: 'userChanged'; readonly volume: number | null }
  | { readonly kind: 'gone' };

/** The helper, reduced to what ducking needs. Real in the app, a fake in the tests. */
export interface DuckingBackend {
  /** Sessions that are playing right now, on every active output. Throws when unavailable. */
  sessions(): Promise<readonly AudioSessionInfo[]>;
  /**
   * Set one session's volume — only if it is still within the tolerance of `ifNear` when
   * given. Never throws for a session that has gone; says so.
   */
  setVolume(id: string, volume: number, ifNear: number | null): Promise<VolumeWrite>;
}

/** Where the "ducked from X" marker lives, and how it is read and written. */
export interface MarkerStore {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
  remove(): Promise<void>;
}

export interface DuckingTiming {
  readonly startDelayMs: number;
  readonly rampMs: number;
  readonly steps: number;
}

/** The Mac's `OutputDucker.Timing` defaults, to the millisecond. */
export const DUCKING_TIMING: DuckingTiming = { startDelayMs: 200, rampMs: 160, steps: 12 };

/** Tolerance for "the user moved it". A mixer slider moves in 1/100 steps; drivers quantise. */
export const USER_CHANGE_TOLERANCE = 0.02;

/** A session below this is already silent; lowering silence is not ducking. */
const AUDIBLE_FLOOR = 0.001;

export interface Ducker {
  /** Lower every other playing session to `level` × its own volume, after the start delay. */
  duck(level: number): void;
  /** Put back what `duck` took, ramped — unless the user has moved it meanwhile. */
  restore(): void;
  /** The quit path: no ramp, done when this resolves. */
  restoreImmediately(): Promise<void>;
  /** A marker left by a process that died while ducked: restore, then forget it. */
  recoverFromCrash(): Promise<void>;
  /** Waits for queued work. For tests and for the quit path. */
  settle(): Promise<void>;
  /** What the last duck or restore decided, in words. For tests and diagnostics. */
  readonly decision: string;
}

/** Does nothing, ever. What every controller holds unless the app installs the real one. */
export const INERT_DUCKER: Ducker = {
  duck: () => undefined,
  restore: () => undefined,
  restoreImmediately: async () => undefined,
  recoverFromCrash: async () => undefined,
  settle: async () => undefined,
  decision: 'inert',
};

interface DuckedSession {
  readonly id: string;
  readonly prior: number;
  target: number;
  /** The last value Kotiba wrote and read back. Anything else is the user's doing. */
  lastSet: number;
}

interface Marker {
  readonly sessions: readonly { readonly id: string; readonly prior: number; readonly target: number }[];
}

export interface DuckerOptions {
  readonly backend: DuckingBackend;
  readonly marker: MarkerStore;
  /** Kotiba's own processes — main, renderers, the audio service. Never ducked. */
  readonly ownPids: () => ReadonlySet<number>;
  readonly timing?: DuckingTiming;
  /** Injected by the tests, so a ramp is a list of writes rather than a wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onNote?: (note: string) => void;
}

/** Smoothstep. No audible corner at either end of the ramp. */
export function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export function createDucker(options: DuckerOptions): Ducker {
  const timing = options.timing ?? DUCKING_TIMING;
  const steps = Math.max(1, Math.round(timing.steps));
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  const note = options.onNote ?? (() => undefined);

  /** Serialises every operation, as the Mac's private queue does. */
  let queue: Promise<void> = Promise.resolve();
  /** Bumped by every duck and restore; a ramp step from an older one sees it and stops. */
  let generation = 0;
  let ducked: Map<string, DuckedSession> | null = null;
  let decision = 'none';

  function enqueue(work: () => Promise<void>): Promise<void> {
    const next = queue.then(work, work).catch((error: unknown) => {
      decision = `failed: ${error instanceof Error ? error.message : String(error)}`;
      note(`ducking: ${decision}`);
    });
    queue = next;
    return next;
  }

  async function writeMarker(): Promise<void> {
    if (ducked === null) return;
    const marker: Marker = {
      sessions: [...ducked.values()].map(({ id, prior, target }) => ({ id, prior, target })),
    };
    try {
      await options.marker.write(JSON.stringify(marker));
    } catch {
      // A marker that cannot be written costs the crash repair, not the duck.
    }
  }

  async function finish(): Promise<void> {
    ducked = null;
    try {
      await options.marker.remove();
    } catch {
      /* nothing to remove */
    }
  }

  /** Step every ducked session from where it is to its goal. Returns false if superseded. */
  async function ramp(goal: (session: DuckedSession) => number, mine: number): Promise<boolean> {
    const current = ducked;
    if (current === null) return true;
    const from = new Map([...current.values()].map((session) => [session.id, session.lastSet]));
    const interval = timing.rampMs / steps;
    for (let i = 1; i <= steps; i += 1) {
      if (mine !== generation || ducked !== current) return false;
      const eased = smoothstep(i / steps);
      for (const session of [...current.values()]) {
        const origin = from.get(session.id) ?? goal(session);
        const value = origin + (goal(session) - origin) * eased;
        const written = await options.backend.setVolume(session.id, value, session.lastSet);
        if (written.kind === 'set') {
          // Read back, not assumed: a driver that quantises must not look like the user.
          session.lastSet = written.volume;
        } else {
          // The user moved this app's slider during the hold, or the app went away. Either
          // way it is no longer Kotiba's to move — and it is not restored later either.
          current.delete(session.id);
          if (written.kind === 'userChanged') decision = "left the user's volume alone";
        }
      }
      if (current.size === 0) {
        await finish();
        return true;
      }
      if (i < steps) await sleep(interval);
    }
    return true;
  }

  async function beginDuck(level: number, mine: number): Promise<void> {
    if (mine !== generation) return;
    if (ducked !== null) {
      // Pressed again while the last release was still ramping back up: go back down from
      // wherever it got to, towards the same target — the prior level is still the truth.
      for (const session of ducked.values()) session.target = session.prior * level;
      decision = 're-ducked';
      await ramp((session) => session.target, mine);
      return;
    }
    const mineOnly = options.ownPids();
    let sessions: readonly AudioSessionInfo[];
    try {
      sessions = await options.backend.sessions();
    } catch (error: unknown) {
      decision = `no sessions: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    const playing = sessions.filter(
      (session) => !mineOnly.has(session.pid) && !session.muted && session.volume > AUDIBLE_FLOOR,
    );
    if (playing.length === 0) {
      decision = 'nothing playing';
      return;
    }
    if (mine !== generation) return; // released during the enumeration
    ducked = new Map(
      playing.map((session) => [
        session.id,
        { id: session.id, prior: session.volume, target: session.volume * level, lastSet: session.volume },
      ]),
    );
    await writeMarker();
    decision = 'ducked';
    await ramp((session) => session.target, mine);
  }

  async function beginRestore(mine: number): Promise<void> {
    if (ducked === null) return;
    decision = 'restoring';
    const completed = await ramp((session) => session.prior, mine);
    if (completed && mine === generation) {
      if (decision === 'restoring') decision = 'restored';
      await finish();
    }
  }

  return {
    duck(level: number): void {
      const clamped = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 1));
      generation += 1;
      const mine = generation;
      // The delay is outside the queue on purpose: a release inside it bumps the
      // generation, and the duck that wakes up afterwards sees that and does nothing.
      void sleep(timing.startDelayMs).then(() => enqueue(() => beginDuck(clamped, mine)));
    },

    restore(): void {
      generation += 1;
      const mine = generation;
      void enqueue(() => beginRestore(mine));
    },

    async restoreImmediately(): Promise<void> {
      generation += 1;
      await enqueue(async () => {
        const current = ducked;
        if (current === null) return;
        let unreached = 0;
        for (const session of current.values()) {
          const written = await options.backend.setVolume(session.id, session.prior, session.lastSet);
          if (written.kind === 'gone') unreached += 1;
        }
        if (unreached > 0) {
          // A write that did not land — the helper already gone, a device mid-change —
          // KEEPS the marker, so the next launch repairs what this quit could not. A
          // session that really ended is dropped by that recovery, not here.
          ducked = null;
          decision = 'restore incomplete — kept the marker for the next launch';
          return;
        }
        decision = 'restored at once';
        await finish();
      });
    },

    async recoverFromCrash(): Promise<void> {
      await enqueue(async () => {
        let raw: string | null = null;
        try {
          raw = await options.marker.read();
        } catch {
          raw = null;
        }
        if (raw === null) return;
        let marker: Marker | null = null;
        try {
          marker = JSON.parse(raw) as Marker;
        } catch {
          marker = null;
        }
        let restored = 0;
        for (const session of marker?.sessions ?? []) {
          if (typeof session.id !== 'string' || typeof session.prior !== 'number') continue;
          // Put back ONLY a session still sitting at the ducked level. One the user has
          // moved since, or that has gone, is theirs.
          const written = await options.backend.setVolume(session.id, session.prior, session.target);
          if (written.kind === 'set') restored += 1;
        }
        decision =
          marker === null
            ? 'stale marker discarded'
            : restored > 0
              ? 'restored after a crash'
              : 'user had changed it since';
        await finish();
      });
    },

    settle(): Promise<void> {
      return enqueue(async () => undefined);
    },

    get decision(): string {
      return decision;
    },
  };
}

// ---------------------------------------------------------------------------------
// The marker on disk
// ---------------------------------------------------------------------------------

/** "Ducked from X", as a file beside the history. Written at a duck, removed at a restore. */
export function fileMarkerStore(path: string): MarkerStore {
  return {
    async read(): Promise<string | null> {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    async write(contents: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, 'utf8');
    },
    async remove(): Promise<void> {
      await rm(path, { force: true });
    },
  };
}

/** The marker's file name. The Mac's `ducking.json`. */
export const DUCKING_MARKER_NAME = 'ducking.json';

// ---------------------------------------------------------------------------------
// The real backend: `kotiba-input.exe`
// ---------------------------------------------------------------------------------

/** The slice of `InputHelper` this needs. Kept structural so this file does not import it. */
export interface DuckingHelper {
  request(command: Record<string, unknown>): Promise<{
    readonly ok: boolean;
    readonly code?: string;
    readonly detail?: string;
    readonly sessions?: readonly AudioSessionInfo[];
    readonly volume?: number;
  }>;
}

/**
 * The backend over a `kotiba-input.exe` of its own.
 *
 * ITS OWN PROCESS, not the inserter's. The helper answers strictly in order, and a ramp
 * is a dozen writes on a 13 ms cadence that start at the same moment as the paste — on a
 * shared helper the restore ramp would queue behind a long `SendInput`, and the paste
 * behind the ramp. A second copy of a 450 KB helper is the cheaper price.
 */
export function helperDuckingBackend(helper: DuckingHelper): DuckingBackend {
  return {
    async sessions(): Promise<readonly AudioSessionInfo[]> {
      const response = await helper.request({ op: 'audioSessions' });
      if (!response.ok) {
        throw new Error(response.detail ?? response.code ?? 'the helper could not list audio sessions');
      }
      return (response.sessions ?? []).filter(
        (session) =>
          typeof session.id === 'string' &&
          typeof session.pid === 'number' &&
          typeof session.volume === 'number',
      );
    },
    async setVolume(id: string, volume: number, ifNear: number | null): Promise<VolumeWrite> {
      const command: Record<string, unknown> = {
        op: 'setSessionVolume',
        session: id,
        volume: Math.min(1, Math.max(0, volume)),
      };
      if (ifNear !== null) {
        command['ifNear'] = ifNear;
        command['tolerance'] = USER_CHANGE_TOLERANCE;
      }
      let response;
      try {
        response = await helper.request(command);
      } catch {
        // The helper itself is gone. Nothing more can be written; treat the session as
        // gone rather than retrying into a dead pipe on every ramp step.
        return { kind: 'gone' };
      }
      if (response.ok && typeof response.volume === 'number') {
        return { kind: 'set', volume: response.volume };
      }
      if (response.code === 'userChanged') {
        return { kind: 'userChanged', volume: typeof response.volume === 'number' ? response.volume : null };
      }
      return { kind: 'gone' };
    },
  };
}
