// The main-side half of D-W6, against the renderer contract it has to satisfy.
//
// `test/audio/capture.test.ts` drives `MicrophoneCapture` with a hand-written fake
// `AudioHost`, which is right for that module and is also exactly why the missing adapter
// was invisible: the capture state machine was fully covered while nothing on the main
// side had ever sent a command to a window. `main/index.ts` called
// `createAudioCapture({ bufferSeconds: 120 })` with no `host` at all — which `capture.ts`
// throws on, by design — so `audio` was `null` on every launch and every launch recorded
// 'The microphone is not ready' before a device had been looked at.
//
// This drives the adapter from the other end: a fake `WebContents` and a fake `ipcMain`
// standing in for the one thing a Mac cannot have, and the real `MicrophoneCapture` on
// top to prove the two halves actually meet.

import { describe, expect, it } from 'vitest';

import type { AudioHostEvent, AudioHostReply } from '../../src/audio/index.js';
import { createMicrophoneCapture } from '../../src/audio/index.js';
import {
  BRIDGE_WAIT_MS,
  LEVEL_INTERVAL_MS,
  captureBootstrap,
  createWindowAudioHost,
  type CaptureIpc,
  type CaptureWebContents,
} from '../../src/main/audio-host.js';
import { IPC_AUDIO, IPC_SEND } from '../../src/main/ipc.js';

/**
 * Let the adapter's `await options.ready` settle.
 *
 * `send` is async before it touches the window at all — the wait for the page to load is
 * the first thing it does — so nothing has been sent on the tick the caller returns.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** `ipcMain`, as far as this file is concerned. */
function fakeIpc(): CaptureIpc & { emit: (channel: string, payload: unknown) => void } {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  return {
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
    emit(channel, payload) {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
  };
}

/** The capture window's `webContents`, recording what main sent it. */
function fakeWebContents(): CaptureWebContents & {
  readonly sent: { channel: string; payload: unknown }[];
  destroyed: boolean;
} {
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    sent,
    destroyed: false,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    isDestroyed() {
      return this.destroyed;
    },
  };
}

/**
 * A page that answers every command the way t08's renderer does, over IPC.
 *
 * It reads the correlation id off the command and posts the reply back on
 * `IPC_AUDIO.reply` — the same round trip the injected `captureBootstrap` performs.
 */
function attachFakePage(
  webContents: ReturnType<typeof fakeWebContents>,
  ipc: ReturnType<typeof fakeIpc>,
  answer: (kind: string, command: { kind: string; segment?: number }) => AudioHostReply,
): void {
  const original = webContents.send.bind(webContents);
  webContents.send = (channel: string, payload: unknown): void => {
    original(channel, payload);
    if (channel !== IPC_SEND.audioCommand) return;
    const message = payload as { id: number; command: { kind: string; segment?: number } };
    queueMicrotask(() => {
      ipc.emit(IPC_AUDIO.reply, { id: message.id, reply: answer(message.command.kind, message.command) });
    });
  };
}

describe('the bootstrap injected into the capture window', () => {
  const script = captureBootstrap('WORKLET_SOURCE_HERE', 'RENDERER_SOURCE_HERE');

  it('hands the renderer both globals it declares it needs', () => {
    // `renderer-source.ts` documents its contract in as many words: it expects
    // `window.__kotibaSend` and `window.__kotibaWorkletSource` from the injector, and
    // installs `window.__kotibaAudio`.
    expect(script).toContain('window.__kotibaWorkletSource');
    expect(script).toContain('window.__kotibaSend');
    expect(script).toContain('WORKLET_SOURCE_HERE');
    expect(script).toContain('RENDERER_SOURCE_HERE');
  });

  it('pumps commands in and replies out on the allow-listed channels', () => {
    // The preload allow-lists `on` against IPC_SEND and `send` against IPC_AUDIO. A page
    // that reached for any other channel would throw inside the bridge.
    expect(script).toContain(JSON.stringify(IPC_SEND.audioCommand));
    expect(script).toContain(JSON.stringify(IPC_AUDIO.reply));
    expect(script).toContain(JSON.stringify(IPC_AUDIO.event));
  });

  it('ends on a value that survives the executeJavaScript round trip', () => {
    // `kotiba.on` answers with an unsubscribe FUNCTION, and a script whose last expression
    // is one makes `executeJavaScript` reject — which would reject `ready`, which would
    // make every command afterwards answer 'the capture window did not load'.
    // The last expression is now the arming promise, and what it settles with is what
    // crosses: `resolve(true)`, never the unsubscribe function `kotiba.on` answers with.
    // That function is parked on `window` instead, since it is the only handle on the
    // listener.
    expect(script).toContain('resolve(true)');
    expect(script).toContain('window.__kotibaUnsubscribe = window.kotiba.on(');
    expect(script.trimEnd().endsWith('});')).toBe(true);
  });

  it('waits for the preload bridge before arming, instead of assuming it', () => {
    // Electron's own docs warn that an unsandboxed ESM preload can finish evaluating
    // AFTER a thin page has loaded, and the capture page is one line of HTML. Reading
    // `window.kotiba.on` a moment early throws, `executeJavaScript` rejects, and `ready`
    // rejects PERMANENTLY — every command for the life of the process is then answered
    // 'the capture window did not load'.
    expect(script).toContain('!window.kotiba || !window.kotibaAudio');
    expect(script).toContain('setTimeout(arm, 10)');
    // And it gives up rather than spinning for ever.
    expect(script).toContain(String(BRIDGE_WAIT_MS));
    expect(script).toContain('the preload bridge never appeared');
  });

  it('throttles levels on the page, so the message is never sent rather than dropped', () => {
    // `process()` runs once per 128-frame quantum: 125/s at 16 kHz. Unthrottled that is
    // ~250 IPC messages a second on the thread also pumping the STT host's pipe, to move
    // a number the HUD redraws 20 times a second.
    expect(script).toContain(String(LEVEL_INTERVAL_MS));
    expect(script).toContain("event.kind === 'level'");
    // Everything that is NOT a level goes straight through — a device change delayed is
    // a graph that stays stale for another press.
    expect(script).toMatch(/__kotibaLevelSentAt[\s\S]*kotibaAudio\.send/);
  });

  it('embeds the worklet source as a literal, not as a fetch', () => {
    // The page has no network and must not have one — it is a hidden window with a
    // microphone open. A worklet fetched over http is the one way that changes.
    expect(script).not.toContain('fetch(');
    expect(script).toContain(JSON.stringify('WORKLET_SOURCE_HERE'));
  });
});

describe('the window audio host', () => {
  it('sends a command and resolves with the page’s reply', async () => {
    const webContents = fakeWebContents();
    const ipc = fakeIpc();
    attachFakePage(webContents, ipc, (kind) =>
      kind === 'warmUp'
        ? { kind: 'warmedUp', sampleRate: 16_000, deviceLabel: 'Microphone Array' }
        : { kind: 'ok' },
    );

    const host = createWindowAudioHost({ webContents, ipc, ready: () => Promise.resolve() });
    const reply = await host.send({ kind: 'warmUp' });

    expect(reply).toEqual({ kind: 'warmedUp', sampleRate: 16_000, deviceLabel: 'Microphone Array' });
    expect(webContents.sent[0]?.channel).toBe(IPC_SEND.audioCommand);
  });

  it('matches every reply to its own command', async () => {
    // Without the correlation id a slow `warmUp` and a fast `stop` resolve each other's
    // promises, and a dictation gets handed the wrong buffer — silently, and only under
    // load, which is the worst way to find out.
    const webContents = fakeWebContents();
    const ipc = fakeIpc();
    const host = createWindowAudioHost({ webContents, ipc, ready: () => Promise.resolve() });

    const warmUp = host.send({ kind: 'warmUp' });
    const stop = host.send({ kind: 'stop', segment: 1 });
    await settle();

    const ids = webContents.sent.map((entry) => (entry.payload as { id: number }).id);
    expect(new Set(ids).size).toBe(2);

    // Answered in the opposite order to the one they were asked in.
    ipc.emit(IPC_AUDIO.reply, {
      id: ids[1],
      reply: { kind: 'stopped', segment: 1, totalSamples: 1, droppedSamples: 3 },
    });
    ipc.emit(IPC_AUDIO.reply, {
      id: ids[0],
      reply: { kind: 'warmedUp', sampleRate: 16_000, deviceLabel: null },
    });

    expect(await warmUp).toMatchObject({ kind: 'warmedUp' });
    expect(await stop).toMatchObject({ kind: 'stopped', droppedSamples: 3 });
  });

  it('waits for the page rather than dropping the first command', async () => {
    // `controller.start()` warms the microphone within milliseconds of launch, long
    // before a renderer has finished loading. A warm-up silently swallowed is a
    // microphone that reports itself cold for the life of the process.
    const webContents = fakeWebContents();
    const ipc = fakeIpc();
    let loaded = (): void => {};
    const ready = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    attachFakePage(webContents, ipc, () => ({ kind: 'ok' }));

    const host = createWindowAudioHost({ webContents, ipc, ready: () => ready });
    const pending = host.send({ kind: 'start', segment: 1 });
    await settle();

    expect(webContents.sent).toHaveLength(0);
    loaded();
    expect(await pending).toEqual({ kind: 'ok' });
    expect(webContents.sent).toHaveLength(1);
  });

  it('answers, rather than throws, when the capture window has gone', async () => {
    // The microphone IS a window here. `MicrophoneCapture` turns an error REPLY into
    // `lastWarmUpError` and an empty buffer, which the session already knows how to
    // report; a rejection would surface as an unhandled promise inside a key-up handler.
    const webContents = fakeWebContents();
    webContents.destroyed = true;

    const host = createWindowAudioHost({ webContents, ipc: fakeIpc(), ready: () => Promise.resolve() });
    const reply = await host.send({ kind: 'start', segment: 1 });

    expect(reply.kind).toBe('error');
    expect(JSON.stringify(reply)).toContain('closed');
  });

  it('answers when the page never loaded at all', async () => {
    const host = createWindowAudioHost({
      webContents: fakeWebContents(),
      ipc: fakeIpc(),
      ready: () => Promise.reject(new Error('the capture page did not load (-6): FILE_NOT_FOUND')),
    });

    const reply = await host.send({ kind: 'warmUp' });
    expect(reply.kind).toBe('error');
    expect(JSON.stringify(reply)).toContain('FILE_NOT_FOUND');
  });

  it('gives up on a page that never answers, instead of hanging the dictation', async () => {
    const webContents = fakeWebContents();
    const timers: (() => void)[] = [];
    const host = createWindowAudioHost({
      webContents,
      ipc: fakeIpc(),
      ready: () => Promise.resolve(),
      timeoutMs: 50,
      setTimer: (run) => {
        timers.push(run);
        return { cancel: () => {} };
      },
    });

    const pending = host.send({ kind: 'stop', segment: 1 });
    await settle();
    timers[0]?.();

    const reply = await pending;
    expect(reply.kind).toBe('error');
    expect(JSON.stringify(reply)).toContain('stop');
  });

  it('delivers the page’s unprompted events to every subscriber', async () => {
    const ipc = fakeIpc();
    const host = createWindowAudioHost({
      webContents: fakeWebContents(),
      ipc,
      ready: () => Promise.resolve(),
    });

    const seen: AudioHostEvent[] = [];
    const unsubscribe = host.onEvent((event) => seen.push(event));
    ipc.emit(IPC_AUDIO.event, { kind: 'level', peak: 0.4 });
    // The whole reason the event channel exists: a device change must reach the capture
    // module, or the graph goes stale and warm-up keeps reporting success against a dead
    // device — 12 of 159 activations captured nothing on macOS for exactly that.
    ipc.emit(IPC_AUDIO.event, { kind: 'deviceChanged', why: 'the list of audio devices changed' });

    unsubscribe();
    ipc.emit(IPC_AUDIO.event, { kind: 'level', peak: 0.9 });

    expect(seen).toEqual([
      { kind: 'level', peak: 0.4 },
      { kind: 'deviceChanged', why: 'the list of audio devices changed' },
    ]);
  });
});

describe('a capture window that has been re-armed', () => {
  it('waits for the NEW page rather than answering from the old resolved gate', async () => {
    // The failure this exists to stop: a capture renderer crashes, Electron reloads it,
    // and the fresh page has no `__kotibaAudio` and no listener. A gate captured ONCE is
    // already resolved, so every press is posted into a dead page and answered fifteen
    // seconds later with a timeout — for the rest of the session.
    const webContents = fakeWebContents();
    const ipc = fakeIpc();
    attachFakePage(webContents, ipc, () => ({ kind: 'ok' }));

    let gate = Promise.resolve();
    const host = createWindowAudioHost({ webContents, ipc, ready: () => gate });

    expect(await host.send({ kind: 'warmUp' })).toEqual({ kind: 'ok' });

    // The renderer died; `createAudioWindow` swaps in a fresh pending gate while it
    // reloads, and `send` must read THAT one.
    let reloaded = (): void => {};
    gate = new Promise<void>((resolve) => {
      reloaded = resolve;
    });

    const sentBefore = webContents.sent.length;
    const pending = host.send({ kind: 'start', segment: 1 });
    await settle();
    expect(webContents.sent).toHaveLength(sentBefore);

    reloaded();
    expect(await pending).toEqual({ kind: 'ok' });
    expect(webContents.sent).toHaveLength(sentBefore + 1);
  });

  it('answers everything still in flight when the bridge is torn down', async () => {
    const webContents = fakeWebContents();
    const ipc = fakeIpc();
    const host = createWindowAudioHost({ webContents, ipc, ready: () => Promise.resolve() });

    const pending = host.send({ kind: 'stop', segment: 1 });
    await settle();
    host.dispose();

    // Never left holding a promise nobody can settle any more.
    const reply = await pending;
    expect(reply.kind).toBe('error');

    // And the listeners really are gone, so a rebuilt pipeline does not stack them.
    const seen: AudioHostEvent[] = [];
    host.onEvent((event) => seen.push(event));
    ipc.emit(IPC_AUDIO.event, { kind: 'level', peak: 0.5 });
    expect(seen).toEqual([]);
  });
});

describe('the adapter and the capture module together', () => {
  it('warms up, captures and returns real samples across the whole bridge', async () => {
    // End to end over the seam that did not exist: `MicrophoneCapture` → `AudioHost` →
    // IPC → the page's reply → back. This is the round trip every dictation makes.
    const webContents = fakeWebContents();
    const ipc = fakeIpc();
    const samples = new Float32Array([0.1, -0.2, 0.3]);
    attachFakePage(webContents, ipc, (kind, command) => {
      if (kind === 'warmUp') {
        return { kind: 'warmedUp', sampleRate: 16_000, deviceLabel: 'Microphone Array' };
      }
      if (kind === 'stop') {
        // The page streams the take's chunks on the event channel, strictly BEFORE the
        // reply — the ordering `stop()` relies on to know it has everything.
        ipc.emit(IPC_AUDIO.event, { kind: 'chunk', segment: command.segment, samples });
        return { kind: 'stopped', segment: command.segment ?? 0, totalSamples: samples.length, droppedSamples: 0 };
      }
      return { kind: 'ok' };
    });

    const host = createWindowAudioHost({ webContents, ipc, ready: () => Promise.resolve() });
    const capture = createMicrophoneCapture({ host });

    await capture.warmUp();
    expect(capture.isWarm).toBe(true);
    expect(capture.lastWarmUpError).toBeNull();

    await capture.start();
    const buffer = await capture.stop();
    // float32, so the values that come back are the nearest representable ones.
    expect(Array.from(buffer.samples)).toHaveLength(3);
    for (const [index, expected] of [0.1, -0.2, 0.3].entries()) {
      expect(buffer.samples[index]).toBeCloseTo(expected, 6);
    }
    // `AudioBuffer` carries no rate: 16 kHz is the invariant, enforced by `warmUp`
    // refusing any context that is not running at it.
    expect(buffer.droppedSamples).toBe(0);

    await capture.dispose();
  });

  it('reports a page that cannot open the microphone, rather than a quiet room', async () => {
    const webContents = fakeWebContents();
    const ipc = fakeIpc();
    attachFakePage(webContents, ipc, () => ({
      kind: 'error',
      error: {
        kind: 'permissionDenied',
        reason:
          'Windows has not given Kotiba the microphone — Settings › Privacy & security › Microphone',
      },
    }));

    const host = createWindowAudioHost({ webContents, ipc, ready: () => Promise.resolve() });
    const capture = createMicrophoneCapture({ host });

    await capture.warmUp();
    expect(capture.isWarm).toBe(false);
    expect(capture.lastWarmUpError).toContain('Privacy & security');

    await capture.dispose();
  });
});

/** `AudioHostReply` is referenced by the fakes above; named here so the import is a use. */
export type _Reply = AudioHostReply;
