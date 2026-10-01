// The bridge. The only thing that crosses between main and any renderer.
//
// `contextIsolation` is on and `nodeIntegration` is off in every window, so a page has
// no `require`, no `fs` and no way to reach the STT host. What it gets is this: a typed
// invoke, and a typed subscribe. Both are allow-listed against the channel tables, so a
// compromised page cannot call an IPC handler that was never meant to be public.
//
// ---------------------------------------------------------------------------------
// WHY THIS FILE IS `.mts` AND NOT `.ts`
// ---------------------------------------------------------------------------------
//
// `package.json` is `"type": "module"` and `tsc` runs with `module: NodeNext`, so a
// `.ts` file here emitted `dist/src/main/preload.js` containing `import { contextBridge }
// from 'electron'`. **ELECTRON IGNORES `package.json`'s `type` FOR PRELOAD SCRIPTS.** A
// preload is loaded as CommonJS unless its file name ends in `.mjs`, so that emit threw
// `SyntaxError: Cannot use import statement outside a module` in every renderer before a
// line of page code ran. `window.kotiba` was never defined, `renderer/bridge.ts` threw
// 'kotiba: the preload bridge is missing' on the first `invoke`, and Settings, the HUD,
// onboarding and the audio page were all dead in the packaged app.
//
// `.mts` is how `tsc` is told to emit `.mjs`, and it needs no change to `package.json`
// (frozen, t01 only) and no bundler. The other half of the requirement is
// `sandbox: false`, which `windows.ts` already sets on every window: an ESM preload
// cannot run in a sandboxed renderer.
//
// The file has to be REACHED by the compiler to be emitted, and nothing imports a
// preload at runtime. `src/main/paths.ts` carries a type-only import of this module for
// exactly that reason — see the note there before deleting it.

import { contextBridge, ipcRenderer } from 'electron';

import { IPC_AUDIO, IPC_INVOKE, IPC_SEND } from './ipc.js';
import type { KotibaBridge } from './ipc.js';

const INVOKABLE = new Set<string>(Object.values(IPC_INVOKE));
const LISTENABLE = new Set<string>(Object.values(IPC_SEND));
/** The hidden capture window's own channels, and the only ones it may post on. */
const AUDIO_SENDABLE = new Set<string>(Object.values(IPC_AUDIO));

/**
 * What lands on `window.kotiba`. Declared in `./ipc.ts` so `src/renderer` can type
 * against it without importing anything from main.
 *
 * Re-exported as a type so `paths.ts` has something real to import — see the header.
 */
export type PreloadedBridge = KotibaBridge;

contextBridge.exposeInMainWorld('kotiba', {
  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!INVOKABLE.has(channel)) throw new Error(`kotiba: ${channel} is not an invokable channel`);
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!LISTENABLE.has(channel)) throw new Error(`kotiba: ${channel} is not a listenable channel`);
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    // Returned rather than left to the page: a settings window that is hidden and shown
    // repeatedly would otherwise stack a listener per show.
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});

/**
 * The hidden audio window's half, on `window.kotibaAudio` (D-W6).
 *
 * SEPARATE FROM `window.kotiba` ON PURPOSE. This is the only fire-and-forget, high-rate
 * channel in the app — PCM frames and a 20 Hz peak — and `invoke` is request/response.
 * Putting it on `kotiba` would also hand the Settings and HUD pages the ability to post
 * audio frames at main, which is a surface no visible page has any business having.
 *
 * `send` is one-way and allow-listed against `IPC_AUDIO`, so the capture page can post a
 * frame and a level and nothing else.
 */
contextBridge.exposeInMainWorld('kotibaAudio', {
  send(channel: string, payload: unknown): void {
    if (!AUDIO_SENDABLE.has(channel)) {
      throw new Error(`kotiba: ${channel} is not an audio channel`);
    }
    ipcRenderer.send(channel, payload);
  },
});
