// The main-process end of the microphone (D-W6).
//
// `src/audio` is written against `AudioHost` — `send(command) => Promise<reply>` plus an
// event stream — and drives the whole capture state machine through it. `src/main` owns
// the hidden `BrowserWindow` that the commands actually run in. THIS FILE IS THE ADAPTER
// BETWEEN THEM, and it is the piece that was missing:
//
//   * `main/index.ts` called `createAudioCapture({ bufferSeconds: 120 })` with no `host`,
//     which `capture.ts` throws on by design ("src/main owns the hidden renderer and must
//     pass it as `host`"). So `audio` was `null` on every launch and every launch recorded
//     'The microphone is not ready'.
//   * Nothing ever sent a command to the capture window, and nothing listened for a reply.
//
// `test/audio/capture.test.ts` drives `MicrophoneCapture` against a fake `AudioHost`, so
// the whole capture module was green with no adapter in existence. `test/main/audio-host.test.ts`
// is the other half: it drives THIS against a fake `WebContents` and the real renderer
// contract.
//
// ---------------------------------------------------------------------------------
// WHY THE PAGE IS INJECTED RATHER THAN IMPORTED
// ---------------------------------------------------------------------------------
//
// The page body is `CAPTURE_RENDERER_SOURCE` and `CAPTURE_WORKLET_SOURCE` from
// `src/audio/renderer-source.ts` — t08's, and the only implementation that speaks the
// five commands and four replies `MicrophoneCapture` sends. It is a source STRING because
// `src/audio` may not import Electron, and it arrives here through `executeJavaScript`.
//
// The window it runs in cannot be `src/renderer/audio.html`: that page carries
// `script-src 'self'`, and the worklet is loaded from a `blob:` URL, which that directive
// blocks. It also cannot be a `data:` URL — an opaque origin is not a secure context and
// `getUserMedia` refuses outright. So the page is written to a real file and loaded over
// `file://`, which Chromium does treat as trustworthy. `tsc` copies no assets and
// `package.json` is frozen, so writing it is also the only way to have it at all.
//
// ---------------------------------------------------------------------------------
// WHY REPLIES COME BACK OVER IPC AND NOT AS THE `executeJavaScript` RESULT
// ---------------------------------------------------------------------------------
//
// `stop` answers with a `Float32Array` of up to 524 seconds of audio. `ipcRenderer.send`
// carries it under the structured clone algorithm, which has TypedArrays; the value
// `executeJavaScript` resolves with does not reliably survive as one. Audio silently
// arriving as `{}` is precisely the class of failure — a capture that looks healthy and
// delivers nothing — that D-W6 exists to make impossible.

import type { AudioHost, AudioHostCommand, AudioHostEvent, AudioHostReply } from '../audio/index.js';

import { IPC_AUDIO, IPC_SEND } from './ipc.js';

/**
 * How long a command may take before it is answered with an error.
 *
 * Generous, because `warmUp` on a cold machine enumerates devices and builds an
 * `AudioContext`, and a first `start` opens the device. It exists so a renderer that has
 * died mid-command cannot hang a dictation forever — a press that never returns is worse
 * than one that reports a broken microphone, because there is nothing to report.
 */
export const AUDIO_COMMAND_TIMEOUT_MS = 15_000;

/**
 * How long the bootstrap waits for the preload bridge before giving up.
 *
 * Electron's own documentation warns that an unsandboxed ESM preload can finish
 * evaluating AFTER a thin page has loaded, and the capture page is the thinnest document
 * in the app — one line of HTML from `src/audio`. Reading `window.kotiba.on` a moment too
 * early throws, `executeJavaScript` rejects, and `ready` rejects PERMANENTLY: every
 * command for the life of the process is then answered 'the capture window did not load'.
 * So the bootstrap waits for the bridge rather than assuming it.
 */
export const BRIDGE_WAIT_MS = 5_000;

/** How often peaks may cross to main. `METER_POLL_MS`, the rate the HUD redraws at. */
export const LEVEL_INTERVAL_MS = 50;

/** The `<script>` that glues t08's page source to this process's two preload bridges. */
export function captureBootstrap(workletSource: string, rendererSource: string): string {
  return [
    // The worklet source, which the renderer turns into a blob URL. Injected rather than
    // fetched: the page has no network and must not have one.
    `window.__kotibaWorkletSource = ${JSON.stringify(workletSource)};`,
    // Unprompted events — a level, a device change, a stream that ended — go out on the
    // audio channel, which is one-way and allow-listed in the preload.
    //
    // LEVELS ARE THROTTLED HERE, ON THE PAGE, so the message is never sent rather than
    // sent and dropped. `process()` runs once per 128-frame quantum, which at 16 kHz is
    // 125 times a second, and every one of those would otherwise become a contextBridge
    // call, a renderer→main IPC and a main→HUD IPC — around 250 messages a second on the
    // thread that is also pumping the STT host's pipe, to move a number the HUD redraws
    // 20 times a second. Everything that is not a level goes straight through: a device
    // change delayed is a graph that stays stale for another press.
    `window.__kotibaLevelSentAt = 0;`,
    `window.__kotibaSend = (event) => {`,
    `  if (event && event.kind === 'level') {`,
    `    const now = Date.now();`,
    `    if (now - window.__kotibaLevelSentAt < ${String(LEVEL_INTERVAL_MS)}) return;`,
    `    window.__kotibaLevelSentAt = now;`,
    `  }`,
    `  window.kotibaAudio.send(${JSON.stringify(IPC_AUDIO.event)}, event);`,
    `};`,
    rendererSource,
    // The command pump, armed only once the preload bridge is really there. Every command
    // carries an id and every reply carries it back, so a `stop` cannot be answered by a
    // `warmUp` that happened to finish first.
    //
    // THE SCRIPT'S LAST EXPRESSION IS ITS RETURN VALUE and `executeJavaScript` sends that
    // back across a process boundary, awaiting it when it is a promise. `kotiba.on`
    // answers with an unsubscribe FUNCTION, which does not survive the trip, so the
    // function is parked on `window` and this resolves with something clonable.
    `new Promise((resolve, reject) => {`,
    `  const startedAt = Date.now();`,
    `  (function arm() {`,
    `    if (!window.kotiba || !window.kotibaAudio) {`,
    `      if (Date.now() - startedAt > ${String(BRIDGE_WAIT_MS)}) {`,
    `        reject(new Error('the preload bridge never appeared on the capture page'));`,
    `        return;`,
    `      }`,
    `      setTimeout(arm, 10);`,
    `      return;`,
    `    }`,
    `    window.__kotibaUnsubscribe = window.kotiba.on(${JSON.stringify(IPC_SEND.audioCommand)}, (message) => {`,
    `      Promise.resolve()`,
    `        .then(() => window.__kotibaAudio(message.command))`,
    `        .catch((error) => ({ kind: 'error', error: {`,
    `          kind: 'engineFailedToStart',`,
    `          why: String(error && error.message ? error.message : error),`,
    `          reason: 'the audio page could not run the command: ' + String(error && error.message ? error.message : error),`,
    `        } }))`,
    `        .then((reply) => { window.kotibaAudio.send(${JSON.stringify(IPC_AUDIO.reply)}, { id: message.id, reply }); });`,
    `    });`,
    `    resolve(true);`,
    `  })();`,
    `});`,
  ].join('\n');
}

/** Just the slice of `WebContents` this needs, so the test can supply one. */
export interface CaptureWebContents {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

/** Just the slice of `ipcMain` this needs. */
export interface CaptureIpc {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export interface WindowAudioHostOptions {
  readonly webContents: CaptureWebContents;
  readonly ipc: CaptureIpc;
  /**
   * The current arming gate, RE-READ ON EVERY COMMAND rather than captured once.
   *
   * Two reasons, and the second is the one that bites. Commands sent before the first
   * load WAIT rather than being dropped: `controller.start()` warms the microphone within
   * milliseconds of launch, long before a renderer has finished loading, and a warm-up
   * silently swallowed is a microphone that reports itself cold forever.
   *
   * And a capture renderer that CRASHES is replaced by a new one with no `__kotibaAudio`
   * and no listener on it. A gate captured once is already resolved by then, so every
   * command would be posted into a dead page and answered fifteen seconds later with a
   * timeout — for the rest of the session. A function lets `createAudioWindow` swap in a
   * fresh gate while it reloads and re-injects.
   */
  readonly ready: () => Promise<void>;
  readonly timeoutMs?: number;
  /** Injected by the test. */
  readonly setTimer?: (run: () => void, ms: number) => { cancel: () => void };
}

/** An `AudioHostReply` that says the page could not be reached. Never thrown. */
function unreachable(reason: string): AudioHostReply {
  return { kind: 'error', error: { kind: 'engineFailedToStart', why: reason, reason } };
}

/**
 * The hidden capture window, as an `AudioHost`.
 *
 * Every failure is a `{kind: 'error'}` REPLY and never a rejection: `MicrophoneCapture`
 * turns a reply into `lastWarmUpError` and an empty buffer, which the session already
 * knows how to report. A rejection here would surface as an unhandled promise inside a
 * key-up handler instead.
 */
export interface WindowAudioHost extends AudioHost {
  /** Drops both `ipcMain` listeners. The composition owns this, not the capture module. */
  dispose(): void;
}

export function createWindowAudioHost(options: WindowAudioHostOptions): WindowAudioHost {
  const timeoutMs = options.timeoutMs ?? AUDIO_COMMAND_TIMEOUT_MS;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms);
      // Never keep the process alive for a reply nobody is waiting on any more.
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    });

  const pending = new Map<number, (reply: AudioHostReply) => void>();
  const listeners = new Set<(event: AudioHostEvent) => void>();
  let nextId = 1;

  const onReply = (_event: unknown, payload: unknown): void => {
    const message = payload as { id?: unknown; reply?: unknown };
    if (typeof message.id !== 'number') return;
    const resolve = pending.get(message.id);
    if (resolve === undefined) return;
    pending.delete(message.id);
    resolve(message.reply as AudioHostReply);
  };

  const onEvent = (_event: unknown, payload: unknown): void => {
    const message = payload as AudioHostEvent;
    if (typeof message?.kind !== 'string') return;
    for (const listener of listeners) listener(message);
  };

  options.ipc.on(IPC_AUDIO.reply, onReply);
  options.ipc.on(IPC_AUDIO.event, onEvent);

  return {
    async send(command: AudioHostCommand): Promise<AudioHostReply> {
      try {
        await options.ready();
      } catch (error: unknown) {
        return unreachable(
          `the capture window did not load: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (options.webContents.isDestroyed()) {
        // The microphone IS a window here. A destroyed one is a dead device, and saying
        // so is what stops the session reporting a quiet room.
        return unreachable('the capture window has closed');
      }

      const id = nextId;
      nextId += 1;
      return new Promise<AudioHostReply>((resolve) => {
        const timer = setTimer(() => {
          if (!pending.delete(id)) return;
          resolve(unreachable(`the capture window did not answer ${command.kind} in time`));
        }, timeoutMs);
        pending.set(id, (reply) => {
          timer.cancel();
          resolve(reply);
        });
        options.webContents.send(IPC_SEND.audioCommand, { id, command });
      });
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose(): void {
      options.ipc.removeListener(IPC_AUDIO.reply, onReply);
      options.ipc.removeListener(IPC_AUDIO.event, onEvent);
      listeners.clear();
      // Anything still waiting is told, rather than left holding a promise that can no
      // longer be settled by anyone.
      for (const [, resolve] of pending) resolve(unreachable('the capture bridge was torn down'));
      pending.clear();
    },
  };
}
