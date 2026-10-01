// The renderer's half of the wire.
//
// A page has no `require`, no `fs` and no `ipcRenderer` — `contextIsolation` is on and
// `nodeIntegration` is off in every window. All it has is `window.kotiba`, put there by
// `src/main/preload.ts` and allow-listed against the channel tables.
//
// Note what this file imports: `../main/ipc.js` and, in the panes, `../main/*-model.js`.
// Those modules import neither `electron` nor `node:*` — that is exactly why they are
// separate files. The DECISIONS are shared between the process that makes them and the
// page that draws them, so the two cannot disagree about what a control writes or what
// the HUD says.

import type { InvokeChannel, KotibaBridge, SendChannel } from '../main/ipc.js';

declare global {
  interface Window {
    readonly kotiba?: KotibaBridge;
  }
}

function bridge(): KotibaBridge {
  const found = window.kotiba;
  if (found === undefined) throw new Error('kotiba: the preload bridge is missing');
  return found;
}

export async function invoke<T>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  return (await bridge().invoke(channel, payload)) as T;
}

export function on<T>(channel: SendChannel, listener: (payload: T) => void): () => void {
  return bridge().on(channel, (payload) => listener(payload as T));
}

// ---------------------------------------------------------------------------------
// Tiny DOM helpers. Deliberately not a framework: no dependency may be added
// (`package.json` is frozen, t01 only), and seven forms do not need one.
// ---------------------------------------------------------------------------------

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) node.append(child);
  return node;
}

/** Replace a container's contents. Used everywhere rather than innerHTML. */
export function replace(target: HTMLElement, children: readonly (Node | string)[]): void {
  target.replaceChildren(...children);
}

/**
 * Text goes in as TEXT, never as markup.
 *
 * Transcripts, model paths and error sentences all reach these pages, and every one of
 * them is content this app did not write — a transcript is literally whatever the user
 * said, and a model path is whatever they typed into a file picker.
 */
export function text(value: string): Text {
  return document.createTextNode(value);
}
