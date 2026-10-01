// The capture PAGE itself — `CAPTURE_RENDERER_SOURCE`, the code that runs inside the
// hidden window — executed in a Node `vm` against stand-ins for the five browser APIs it
// touches. `capture.test.ts` drives the main-process half against a fake page; this drives
// the real page against a fake browser, so the chunking, the seams between takes and the
// drain at key-up are measured on the code that ships rather than on a model of it.
//
// What this cannot cover: Chromium's own resampler and a real microphone. The resampler
// is measured separately (`resample-probe.ts`); the microphone is the Windows checklist.

import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { CAPTURE_RENDERER_SOURCE } from '../../src/audio/index.js';

interface PageEvent {
  readonly kind: string;
  readonly segment?: number;
  readonly samples?: Float32Array;
}

/** The worklet as the page sees it: a port, and blocks the test pushes through it. */
class FakeWorkletNode {
  static last: FakeWorkletNode | null = null;
  capturing = false;
  /** Blocks "in flight" — posted by the audio thread but not yet received by the page. */
  readonly inFlight: Float32Array[] = [];
  readonly port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: unknown): void => {
      if (message === 'start') this.capturing = true;
      const stop = (message as { stop?: unknown } | null)?.stop;
      if (typeof stop === 'number') {
        this.capturing = false;
        // The real processor posts `{stopped: n}` AFTER every block it sent while
        // capturing; blocks still in flight therefore arrive first.
        setTimeout(() => {
          for (const block of this.inFlight.splice(0)) this.#deliver(block);
          this.port.onmessage?.({ data: { stopped: stop } });
        }, 1);
      }
    },
  };
  constructor() {
    FakeWorkletNode.last = this;
  }
  connect(): void {}
  disconnect(): void {}
  /** One 128-frame render quantum from the microphone. */
  render(block: Float32Array, holdInFlight = false): void {
    if (!this.capturing) {
      this.port.onmessage?.({ data: { peak: 0 } });
      return;
    }
    if (holdInFlight) this.inFlight.push(block);
    else this.#deliver(block);
  }
  #deliver(block: Float32Array): void {
    this.port.onmessage?.({ data: { block, peak: 0.1 } });
  }
}

function page(): {
  readonly events: PageEvent[];
  command(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  node(): FakeWorkletNode;
} {
  const events: PageEvent[] = [];
  const track = { readyState: 'live', addEventListener: () => undefined, stop: () => undefined };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  class FakeAudioContext {
    readonly sampleRate: number;
    state = 'running';
    readonly audioWorklet = { addModule: async () => undefined };
    constructor(options: { sampleRate: number }) {
      this.sampleRate = options.sampleRate;
    }
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    async resume() {}
    async close() {}
  }
  const sandbox: Record<string, unknown> = {
    navigator: {
      mediaDevices: {
        getUserMedia: async () => stream,
        enumerateDevices: async () => [{ kind: 'audioinput', label: 'Fake microphone' }],
        addEventListener: () => undefined,
      },
      permissions: { query: async () => ({ state: 'granted' }) },
    },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => undefined },
    Blob: class {},
    Float32Array,
    Map,
    Promise,
    setTimeout,
    Math,
    String,
  };
  sandbox['window'] = sandbox;
  sandbox['__kotibaWorkletSource'] = '';
  sandbox['__kotibaSend'] = (event: PageEvent) => events.push(event);
  runInNewContext(CAPTURE_RENDERER_SOURCE, sandbox);
  const run = sandbox['__kotibaAudio'] as (command: unknown) => Promise<Record<string, unknown>>;
  return {
    events,
    command: (command) => run(command),
    node: () => {
      if (FakeWorkletNode.last === null) throw new Error('no worklet');
      return FakeWorkletNode.last;
    },
  };
}

/** Sample i of the synthetic microphone. Exact in float32, so equality is sample-exact. */
const sampleAt = (i: number): number => Math.fround(((i % 2003) - 1001) / 2048);

function block(start: number, length = 128): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = sampleAt(start + i);
  return out;
}

function chunksOf(events: readonly PageEvent[], segment: number): Float32Array[] {
  return events
    .filter((event) => event.kind === 'chunk' && event.segment === segment)
    .map((event) => event.samples as Float32Array);
}

function joined(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

describe('the capture page, run for real', () => {
  it('streams TEN MINUTES as 100 ms chunks with nothing lost and nothing reordered', async () => {
    const p = page();
    expect((await p.command({ kind: 'warmUp' }))['kind']).toBe('warmedUp');
    expect((await p.command({ kind: 'start', segment: 1 }))['kind']).toBe('ok');

    const total = 10 * 60 * 16_000; // 9 600 000 — past the old page's 8 388 608 cap
    for (let at = 0; at < total; at += 128) p.node().render(block(at));
    const reply = await p.command({ kind: 'stop', segment: 1 });

    const chunks = chunksOf(p.events, 1);
    const audio = joined(chunks);
    expect(reply).toMatchObject({ kind: 'stopped', segment: 1, totalSamples: total, droppedSamples: 0 });
    expect(audio.length).toBe(total);
    // Every full chunk is exactly 1 600 samples; 9 600 000 divides evenly, so there is no tail.
    expect(chunks.every((chunk) => chunk.length === 1_600)).toBe(true);
    expect(chunks).toHaveLength(6_000);
    // Sample-exact, across the whole ten minutes.
    let mismatches = 0;
    for (let i = 0; i < total; i += 1) if (audio[i] !== sampleAt(i)) mismatches += 1;
    expect(mismatches).toBe(0);
  });

  it('keeps the blocks still in flight at key-up — the drain', async () => {
    const p = page();
    await p.command({ kind: 'warmUp' });
    await p.command({ kind: 'start', segment: 7 });
    p.node().render(block(0));
    // Two quanta posted by the audio thread but not yet received when 'stop' is sent.
    p.node().render(block(128), true);
    p.node().render(block(256), true);
    const reply = await p.command({ kind: 'stop', segment: 7 });
    const audio = joined(chunksOf(p.events, 7));
    expect(audio.length).toBe(384);
    expect(reply['totalSamples']).toBe(384);
    expect(Array.from(audio)).toEqual(Array.from(block(0, 384)));
  });

  it('a start while capturing SEALS the segment at a block boundary, and a stop of the old one does not stop the new', async () => {
    const p = page();
    await p.command({ kind: 'warmUp' });
    await p.command({ kind: 'start', segment: 1 });
    for (let at = 0; at < 2_000; at += 100) p.node().render(block(at, 100));
    await p.command({ kind: 'start', segment: 2 });
    for (let at = 2_000; at < 5_000; at += 100) p.node().render(block(at, 100));

    const first = await p.command({ kind: 'stop', segment: 1 });
    // Still capturing for segment 2.
    for (let at = 5_000; at < 6_000; at += 100) p.node().render(block(at, 100));
    const second = await p.command({ kind: 'stop', segment: 2 });

    const a = joined(chunksOf(p.events, 1));
    const b = joined(chunksOf(p.events, 2));
    expect(first['totalSamples']).toBe(2_000);
    expect(second['totalSamples']).toBe(4_000);
    expect(Array.from(a)).toEqual(Array.from(block(0, 2_000)));
    expect(Array.from(b)).toEqual(Array.from(block(2_000, 4_000)));
  });

  it('answers commands one at a time, so a start inside a stop cannot seal the wrong segment', async () => {
    const p = page();
    await p.command({ kind: 'warmUp' });
    await p.command({ kind: 'start', segment: 1 });
    p.node().render(block(0));
    p.node().render(block(128), true);
    // Both sent back to back, as a release and an immediate re-press are.
    const stopping = p.command({ kind: 'stop', segment: 1 });
    const starting = p.command({ kind: 'start', segment: 2 });
    await stopping;
    await starting;
    p.node().render(block(256));
    await p.command({ kind: 'stop', segment: 2 });
    expect(Array.from(joined(chunksOf(p.events, 1)))).toEqual(Array.from(block(0, 256)));
    expect(Array.from(joined(chunksOf(p.events, 2)))).toEqual(Array.from(block(256, 128)));
  });
});
