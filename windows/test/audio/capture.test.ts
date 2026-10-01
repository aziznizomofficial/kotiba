// The capture state machine, driven against a fake hidden renderer.
//
// No browser, no microphone, no Electron — which is the point of `AudioHost` being a
// message interface. Every defect this file asserts against is one that shipped: the
// graph that went stale and reported healthy, the latched admission gate, the typed
// permission failure that reached users as `engineFailedToStart("permissionDenied")`.

import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_CEILING_SECONDS,
  DEVICE_CHANGED_MESSAGE,
  createAudioCapture,
  createMicrophoneCapture,
} from '../../src/audio/index.js';
import type { AudioHost, AudioHostCommand, AudioHostEvent, AudioHostReply } from '../../src/audio/index.js';
import { asMicrophoneError, microphoneError, MicrophoneFailure } from '../../src/contracts/index.js';

/** A hidden renderer that behaves, and remembers everything it was asked. */
class FakeHost implements AudioHost {
  readonly commands: AudioHostCommand['kind'][] = [];
  #listeners: ((event: AudioHostEvent) => void)[] = [];

  /** Set to fail the next reply of a given kind. */
  failures: Partial<Record<AudioHostCommand['kind'], AudioHostReply>> = {};
  /** What `stop` hands back. */
  captured = new Float32Array([0.5, -0.5, 0.25]);
  droppedSamples = 0;
  /** The segment being streamed, as the real page tracks it. */
  segment = 0;
  capturing = false;
  sampleRate = 16_000;
  deviceCount = 1;
  /** What the page says the stream opened on, in the answer to `start`. */
  device: { label: string; sampleRate: number | null } | undefined = undefined;

  async send(command: AudioHostCommand): Promise<AudioHostReply> {
    this.commands.push(command.kind);
    const forced = this.failures[command.kind];
    if (forced) return forced;
    switch (command.kind) {
      case 'warmUp':
        return this.deviceCount === 0
          ? { kind: 'error', error: microphoneError.noInputAvailable() }
          : { kind: 'warmedUp', sampleRate: this.sampleRate, deviceLabel: 'Fake microphone' };
      case 'start':
        this.segment = command.segment;
        this.capturing = true;
        return this.device === undefined ? { kind: 'ok' } : { kind: 'ok', device: this.device };
      case 'stop': {
        // The real page streams while capturing; this one streams everything at the end,
        // as one chunk, strictly before the reply — the ordering the pipe guarantees.
        if (this.capturing && this.segment === command.segment) {
          this.capturing = false;
          this.emit({ kind: 'chunk', segment: command.segment, samples: this.captured });
        }
        return {
          kind: 'stopped',
          segment: command.segment,
          totalSamples: this.captured.length,
          droppedSamples: this.droppedSamples,
        };
      }
      default:
        return { kind: 'ok' };
    }
  }

  onEvent(listener: (event: AudioHostEvent) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((each) => each !== listener);
    };
  }

  emit(event: AudioHostEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  /** Every command of one kind, for counting. */
  count(kind: AudioHostCommand['kind']): number {
    return this.commands.filter((each) => each === kind).length;
  }
}

function capture(host: FakeHost, warmHoldMs = 1_000): ReturnType<typeof createMicrophoneCapture> {
  return createMicrophoneCapture({ host, warmHoldMs });
}

describe('warm-up', () => {
  it('never throws — a failure is reported through state', async () => {
    const host = new FakeHost();
    host.deviceCount = 0;
    const microphone = capture(host);
    await expect(microphone.warmUp()).resolves.toBeUndefined();
    expect(microphone.isWarm).toBe(false);
    expect(microphone.lastWarmUpError).toBe('there is no usable input device');
    // No device at all is something only the user can fix.
    expect(microphone.warmUpNeedsTheUser).toBe(true);
  });

  it('runs again on every foreground, and again after a success', async () => {
    // Doing warm-up ONCE is the defect. The macOS sink was attached once forever, and
    // after a device change `prepare()` kept succeeding while nothing was connected.
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.warmUp();
    await microphone.warmUp();
    await microphone.warmUp();
    expect(microphone.warmUpCount).toBe(3);
    expect(host.count('warmUp')).toBe(3);
  });

  it('retries after a failure and recovers', async () => {
    const host = new FakeHost();
    host.deviceCount = 0;
    const microphone = capture(host);
    await microphone.warmUp();
    expect(microphone.isWarm).toBe(false);
    host.deviceCount = 1;
    await microphone.warmUp();
    expect(microphone.isWarm).toBe(true);
    expect(microphone.lastWarmUpError).toBeNull();
  });

  it('refuses a context that is not running at 16 kHz', async () => {
    // D-W6 is not advisory. Anything else means something downstream would resample,
    // which is the whole defect this decision exists to prevent.
    const host = new FakeHost();
    host.sampleRate = 48_000;
    const microphone = capture(host);
    await microphone.warmUp();
    expect(microphone.isWarm).toBe(false);
    expect(microphone.lastWarmUpError).toContain('48000 Hz');
  });

  it('does NOT open the stream — no microphone indicator while merely warm', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.warmUp();
    expect(microphone.isStreamOpen).toBe(false);
    expect(host.commands).not.toContain('start');
  });
});

describe('start', () => {
  it('warms up on the way if it is not warm', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.start();
    expect(host.commands).toEqual(['warmUp', 'start']);
  });

  it('rethrows a permission denial UNWRAPPED', async () => {
    // A denied microphone once reached users as engineFailedToStart("permissionDenied").
    const host = new FakeHost();
    host.failures.warmUp = { kind: 'error', error: microphoneError.permissionDenied() };
    const microphone = capture(host);
    await expect(microphone.start()).rejects.toBeInstanceOf(MicrophoneFailure);
    await microphone.start().catch((error: unknown) => {
      expect(asMicrophoneError(error)?.kind).toBe('permissionDenied');
    });
  });

  it('returns silently when already capturing', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.start();
    await microphone.start();
    expect(host.count('start')).toBe(1);
  });

  it('throws away anything captured earlier — there is no pre-roll', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.start();
    await microphone.stop();
    // A second dictation must not inherit the first one's audio.
    host.captured = new Float32Array([0.125]);
    await microphone.start();
    const second = await microphone.stop();
    expect(Array.from(second.samples)).toEqual([0.125]);
  });
});

describe('stop', () => {
  it('returns an empty buffer when nothing was capturing, and does not fail', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    const buffer = await microphone.stop();
    expect(buffer.samples.length).toBe(0);
    expect(buffer.droppedSamples).toBe(0);
    expect(host.commands).not.toContain('stop');
  });

  it('hands back what the renderer captured', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.start();
    const buffer = await microphone.stop();
    expect(Array.from(buffer.samples)).toEqual([0.5, -0.5, 0.25]);
  });

  it('carries the renderer’s drop count through without rescaling it', async () => {
    // macOS scales the count from the hardware timebase to 16 kHz because its ring holds
    // hardware-rate samples. Everything here is already 16 kHz, so scaling again would
    // report a third of the loss.
    const host = new FakeHost();
    host.droppedSamples = 32_000;
    const microphone = capture(host);
    await microphone.start();
    expect((await microphone.stop()).droppedSamples).toBe(32_000);
  });

  it('returns an empty buffer rather than throwing when the drain fails', async () => {
    // The session's own rule — an empty capture is a broken microphone, never the user's
    // silence — is what turns this into the right message. A throw here would become
    // "arming failed", which is not what happened.
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.start();
    host.failures.stop = { kind: 'error', error: microphoneError.engineFailedToStart('gone') };
    const buffer = await microphone.stop();
    expect(buffer.samples.length).toBe(0);
    expect(microphone.isWarm).toBe(false);
  });
});

describe('which microphone a take heard', () => {
  it('rides on the buffer the take returns: label, transport by heuristic, the device’s own rate', async () => {
    const host = new FakeHost();
    host.device = { label: 'Test iPhone Microphone', sampleRate: 48_000 };
    const microphone = capture(host);
    await microphone.start();
    const buffer = await microphone.stop();
    // No device id is ever requested, so Kotiba never overrides the system default.
    expect(buffer.device).toEqual({
      name: 'Test iPhone Microphone',
      transport: 'continuity',
      sampleRate: 48_000,
      overrodeDefault: false,
    });
  });

  it('is absent when the page did not say, rather than invented', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.start();
    expect((await microphone.stop()).device).toBeUndefined();
  });

  it('an unlabelled device (no permission yet) is named as such, and the rate is optional', async () => {
    const host = new FakeHost();
    host.device = { label: '', sampleRate: null };
    const microphone = capture(host);
    await microphone.start();
    const { device } = await microphone.stop();
    expect(device).toEqual({ name: 'unnamed input', transport: 'other', overrodeDefault: false });
  });

  it('a device change between two takes does not relabel the first', async () => {
    const host = new FakeHost();
    host.device = { label: 'USB Audio Device', sampleRate: 44_100 };
    const microphone = capture(host);
    const first = microphone.openTake();
    await first.start();
    host.device = { label: 'Headset (AirPods) Hands-Free', sampleRate: 16_000 };
    const second = microphone.openTake();
    await second.start();
    const a = await first.stop();
    const b = await second.stop();
    expect(a.device?.transport).toBe('usb');
    expect(b.device?.transport).toBe('bluetooth');
  });
});

describe('the admission gate does not latch', () => {
  it('drives ten consecutive dictations', async () => {
    // TEN, not two. The macOS gate moved onto a variable cleared only in a method with no
    // callers, so every press after the first was refused for the life of the process —
    // and two dictations would not have caught it.
    const host = new FakeHost();
    const microphone = capture(host);
    for (let dictation = 1; dictation <= 10; dictation += 1) {
      host.captured = new Float32Array([dictation / 32]);
      await microphone.start();
      const buffer = await microphone.stop();
      expect(Array.from(buffer.samples)).toEqual([dictation / 32]);
      expect(buffer.droppedSamples).toBe(0);
    }
    expect(host.count('start')).toBe(10);
    expect(host.count('stop')).toBe(10);
  });
});

describe('the warm hold', () => {
  it('keeps the stream open briefly after release so the next press is cheap', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      const microphone = capture(host, 2_000);
      await microphone.start();
      await microphone.stop();
      expect(microphone.isStreamOpen).toBe(true);

      // A second press inside the window reuses the open stream.
      await vi.advanceTimersByTimeAsync(500);
      await microphone.start();
      expect(host.commands).not.toContain('release');
      await microphone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('DOES let the microphone go — the indicator must not stay lit', async () => {
    // An indicator lit while the user is not dictating reads as spyware, correctly: it
    // means the app can hear them. This is the assertion that keeps the hold a hold.
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      const microphone = capture(host, 2_000);
      await microphone.start();
      await microphone.stop();
      await vi.advanceTimersByTimeAsync(2_001);
      expect(microphone.isStreamOpen).toBe(false);
      expect(host.commands).toContain('release');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never holds the stream open on the strength of a warm-up alone', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      const microphone = capture(host, 2_000);
      for (let foreground = 0; foreground < 5; foreground += 1) {
        await microphone.warmUp();
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(microphone.isStreamOpen).toBe(false);
      expect(host.commands).not.toContain('start');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('device change and graph staleness', () => {
  it('marks the graph stale and rebuilds on the next press', async () => {
    // The macOS fix was an explicit configuration-change observer, NOT comparing formats
    // — comparing formats had been tried and it kept reporting a healthy graph while 12
    // of 159 activations captured nothing.
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.warmUp();
    expect(microphone.isWarm).toBe(true);

    host.emit({ kind: 'deviceChanged', why: 'the list of audio devices changed' });
    expect(microphone.isWarm).toBe(false);
    expect(microphone.configurationChangeCount).toBe(1);
    expect(microphone.lastWarmUpError).toBe(DEVICE_CHANGED_MESSAGE);
    // …and heals itself, so it is not put in front of the user as a problem.
    expect(microphone.warmUpNeedsTheUser).toBe(false);

    await microphone.start();
    expect(host.count('warmUp')).toBe(2);
    expect(microphone.isWarm).toBe(true);
  });

  it('treats a stream that ended the same way', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.start();
    host.emit({ kind: 'streamEnded', why: 'the input device went away mid-stream' });
    expect(microphone.isWarm).toBe(false);
    // The page may still hold a live track (a `mute` also reports here): the release after
    // the last take must still go out, or the microphone light stays on.
    await microphone.stop();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(host.count('release')).toBe(1);
    expect(microphone.isStreamOpen).toBe(false);
  });

  it('still returns the truncated audio when the device changes mid-dictation', async () => {
    // A truncated transcript beats an empty one. The change does NOT clear the capturing
    // flag, exactly as `noteConfigurationChange()` does not on macOS.
    const host = new FakeHost();
    host.captured = new Float32Array([0.25, 0.25]);
    const microphone = capture(host);
    await microphone.start();
    host.emit({ kind: 'deviceChanged', why: 'AirPods connected' });
    const buffer = await microphone.stop();
    expect(Array.from(buffer.samples)).toEqual([0.25, 0.25]);
  });

  it('recovers across a device change and ten more dictations', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    for (let dictation = 0; dictation < 10; dictation += 1) {
      host.emit({ kind: 'deviceChanged', why: 'a flaky USB dock' });
      await microphone.start();
      expect((await microphone.stop()).samples.length).toBe(3);
    }
    expect(microphone.configurationChangeCount).toBe(10);
    expect(host.count('warmUp')).toBe(10);
  });
});

describe('the live meter', () => {
  it('follows the level events and never reads the capture buffer', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.start();
    host.emit({ kind: 'level', peak: 0.6 });
    expect(microphone.currentPeak()).toBeCloseTo(0.6, 6);
    // Reading it repeatedly must not change what `stop()` returns.
    microphone.currentPeak();
    microphone.currentPeak();
    expect((await microphone.stop()).samples.length).toBe(3);
  });

  it('is back to zero when a dictation ends', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.start();
    host.emit({ kind: 'level', peak: 0.9 });
    await microphone.stop();
    expect(microphone.currentPeak()).toBe(0);
  });
});

describe('dispose', () => {
  it('closes the stream and stops listening', async () => {
    const host = new FakeHost();
    const microphone = capture(host);
    await microphone.start();
    await microphone.dispose();
    expect(microphone.isStreamOpen).toBe(false);
    expect(host.commands).toContain('dispose');
    host.emit({ kind: 'deviceChanged', why: 'after disposal' });
    expect(microphone.configurationChangeCount).toBe(0);
  });
});

describe('createAudioCapture', () => {
  it('says so rather than failing on the first press when nobody passed a window', () => {
    expect(() => createAudioCapture({})).toThrow(/hidden renderer/);
  });

  it('builds a working capture when it is given one', async () => {
    const host = new FakeHost();
    const microphone = createAudioCapture({ host } as never);
    await microphone.start();
    expect((await microphone.stop()).samples.length).toBe(3);
    await microphone.dispose();
  });
});

// ---------------------------------------------------------------------------------
// 1.0: takes, the live stream, and no length limit
// ---------------------------------------------------------------------------------

/** A host that streams chunks the way the real page does, driven by the test. */
class StreamingHost implements AudioHost {
  readonly commands: AudioHostCommand[] = [];
  #listeners: ((event: AudioHostEvent) => void)[] = [];
  segment = 0;
  capturing = false;
  /** Samples streamed per segment, counted at the "source". */
  readonly totals = new Map<number, number>();
  /** Chunks the source counted but the pipe never delivered. */
  loseNext = 0;

  async send(command: AudioHostCommand): Promise<AudioHostReply> {
    this.commands.push(command);
    switch (command.kind) {
      case 'warmUp':
        return { kind: 'warmedUp', sampleRate: 16_000, deviceLabel: 'Fake' };
      case 'start':
        this.segment = command.segment;
        this.totals.set(command.segment, 0);
        this.capturing = true;
        return { kind: 'ok' };
      case 'stop':
        if (this.capturing && this.segment === command.segment) this.capturing = false;
        return {
          kind: 'stopped',
          segment: command.segment,
          totalSamples: this.totals.get(command.segment) ?? -1,
          droppedSamples: 0,
        };
      default:
        return { kind: 'ok' };
    }
  }

  onEvent(listener: (event: AudioHostEvent) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((each) => each !== listener);
    };
  }

  /** A chunk for an explicit segment — one flushed at a seam and still in flight. */
  deliver(segment: number, samples: Float32Array): void {
    this.totals.set(segment, (this.totals.get(segment) ?? 0) + samples.length);
    for (const listener of [...this.#listeners]) listener({ kind: 'chunk', segment, samples });
  }

  /** The microphone produced `samples` for whichever segment is being captured. */
  speak(samples: Float32Array): void {
    if (!this.capturing) return;
    this.totals.set(this.segment, (this.totals.get(this.segment) ?? 0) + samples.length);
    if (this.loseNext > 0) {
      this.loseNext -= 1;
      return;
    }
    for (const listener of [...this.#listeners]) {
      listener({ kind: 'chunk', segment: this.segment, samples });
    }
  }
}

/** A deterministic, sample-exact signal: sample i is a function of i alone. */
function signal(start: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.sin((start + i) * 0.001) * 0.5;
  return out;
}

describe('takes', () => {
  it('TEN MINUTES of synthetic audio in 100 ms chunks: every sample kept, in order, stream identical', async () => {
    // The acceptance test for "unbounded capture": 10 min = 9 600 000 samples, which the
    // old page's 2^23 array (524 s) would have truncated at 8 388 608.
    const host = new StreamingHost();
    const microphone = createMicrophoneCapture({ host, warmHoldMs: 10 });
    const take = microphone.openTake();
    let streamed = 0;
    let streamCheck = 0;
    take.onChunk((chunk) => {
      for (let i = 0; i < chunk.length; i += 1) streamCheck += chunk[i] ?? 0;
      streamed += chunk.length;
    });
    await take.start();

    const total = 10 * 60 * 16_000;
    for (let at = 0; at < total; at += 1_600) host.speak(signal(at, 1_600));
    const buffer = await take.stop();

    expect(buffer.samples.length).toBe(total);
    expect(buffer.droppedSamples).toBe(0);
    expect(streamed).toBe(total);
    let takeCheck = 0;
    for (let i = 0; i < buffer.samples.length; i += 1) takeCheck += buffer.samples[i] ?? 0;
    expect(takeCheck).toBe(streamCheck);
    // Spot-check exactness, sample for sample, across the whole ten minutes.
    const expected = signal(0, total);
    for (const i of [0, 1, 1_599, 1_600, 4_000_000, 8_388_607, 8_388_608, total - 1]) {
      expect(buffer.samples[i]).toBe(expected[i]);
    }
  });

  it('a second take SEALS the first at the seam: nothing lost, nothing shared', async () => {
    const host = new StreamingHost();
    const microphone = createMicrophoneCapture({ host, warmHoldMs: 10 });
    const first = microphone.openTake();
    await first.start();
    host.speak(signal(0, 1_600));
    host.speak(signal(1_600, 1_600));

    // The next press lands before the first take's stop has been sent.
    const second = microphone.openTake();
    await second.start();
    host.speak(signal(3_200, 1_600));

    const a = await first.stop();
    host.speak(signal(4_800, 800));
    const b = await second.stop();

    expect(Array.from(a.samples)).toEqual(Array.from(signal(0, 3_200)));
    expect(Array.from(b.samples)).toEqual(Array.from(signal(3_200, 2_400)));
    // One capture, never restarted: exactly two starts, one per take, and the first
    // take's stop did not stop the capture the second take was using.
    expect(host.commands.filter((c) => c.kind === 'start')).toHaveLength(2);
    expect(host.capturing).toBe(false);
  });

  it('a chunk still in flight for the sealed take goes to THAT take, not the new one', async () => {
    const host = new StreamingHost();
    const microphone = createMicrophoneCapture({ host, warmHoldMs: 10 });
    const first = microphone.openTake();
    await first.start();
    const firstSegment = host.segment;
    host.speak(signal(0, 1_600));
    const second = microphone.openTake();
    await second.start();
    // A chunk the page flushed for the first segment at the seam, arriving after the
    // second take has started.
    host.deliver(firstSegment, signal(1_600, 400));
    host.speak(signal(2_000, 1_600));

    const a = await first.stop();
    const b = await second.stop();
    expect(Array.from(a.samples)).toEqual(Array.from(signal(0, 2_000)));
    expect(Array.from(b.samples)).toEqual(Array.from(signal(2_000, 1_600)));
    expect(microphone.openTakes).toBe(0);
  });

  it('audio the source counted but the pipe never delivered is COUNTED as dropped', async () => {
    const host = new StreamingHost();
    const microphone = createMicrophoneCapture({ host, warmHoldMs: 10 });
    const take = microphone.openTake();
    await take.start();
    host.speak(signal(0, 1_600));
    host.loseNext = 1;
    host.speak(signal(1_600, 1_600));
    host.speak(signal(3_200, 1_600));
    const buffer = await take.stop();
    expect(buffer.samples.length).toBe(3_200);
    expect(buffer.droppedSamples).toBe(1_600);
  });

  it('reaching the ceiling is REPORTED once, and audio past it is NOT counted as lost (Mac parity)', async () => {
    const host = new StreamingHost();
    // A one-second ceiling stands in for thirty minutes.
    const microphone = createMicrophoneCapture({ host, warmHoldMs: 10, ceilingSeconds: 1 });
    let limits = 0;
    const take = microphone.openTake({ onLimit: () => (limits += 1) });
    await take.start();
    for (let at = 0; at < 24_000; at += 1_600) host.speak(signal(at, 1_600));
    const buffer = await take.stop();
    expect(limits).toBe(1);
    expect(buffer.samples.length).toBe(16_000);
    // The take ended at the ceiling; the rest was never part of it. Counted as dropped it
    // made both live streams abandon their text and re-decode thirty minutes in batch.
    expect(buffer.droppedSamples).toBe(0);
  });

  it('the shipped ceiling is thirty minutes', () => {
    expect(CAPTURE_CEILING_SECONDS).toBe(1_800);
  });
});
