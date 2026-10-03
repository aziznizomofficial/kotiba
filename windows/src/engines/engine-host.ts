// The engine process: `engine-host.js parakeet`, `engine-host.js llama`, `engine-host.js arabic`
// (D-W22; Arabic is C4's Cohere / FastConformer — `arabic-runtime.ts`) or `engine-host.js lid` (the
// language-ID model, P4 — `language-id-runtime.ts`).
//
// Started by main through an `EngineLauncher` — an Electron utility process in the app,
// `child_process.fork` under plain Node — and nothing else. It says hello first, before any
// model is touched, so main can tell "this process cannot start" (a packaging fault: fall back
// to running in the app) from "this model crashed it" (restart it on the next use). Then it
// serves exactly one engine until told to dispose, and exits.
//
// Each role imports only its own module graph, lazily: the Parakeet host never loads
// node-llama-cpp and the llama host never loads ONNX Runtime; only the Arabic host loads
// transcribe.cpp (and then only when Cohere is the engine it is asked for).

import { hostPort, type EngineRole } from './engine-process.js';

const role = process.argv[2] as EngineRole | undefined;
const port = hostPort();

// Main posts its first request the moment the process exists, and the engine module is
// imported below AFTER that — a Node 'message' with no listener yet is simply dropped. So
// every message is taken from the first instant and held until the engine is listening.
const early: unknown[] = [];
let deliver: ((message: unknown) => void) | null = null;
port.onMessage((message) => {
  if (deliver === null) early.push(message);
  else deliver(message);
});
const listen = (listener: (message: unknown) => void): void => {
  deliver = listener;
  for (const message of early.splice(0)) listener(message);
};

port.postMessage({ kind: 'hello', pid: process.pid });

// Main going away (a quit, a crash of the app itself) must not leave a 1.3 GB model resident
// in an orphan: the IPC channel closing is the signal, on both carriers.
const orphaned = (): void => process.exit(0);
process.on('disconnect', orphaned);

async function serve(): Promise<void> {
  const close = (): void => {
    // Let the last reply flush, then go.
    setTimeout(() => process.exit(0), 10);
  };
  switch (role) {
    case 'parakeet': {
      const { serveParakeet } = await import('./parakeet-runtime.js');
      serveParakeet({
        onMessage: (listener) => listen((message) => listener(message as never)),
        postMessage: (reply) => port.postMessage(reply),
        close,
      });
      return;
    }
    case 'llama': {
      const { serveLlama } = await import('../polish/llama-host.js');
      serveLlama({
        onMessage: (listener) => listen((message) => listener(message as never)),
        postMessage: (reply) => port.postMessage(reply),
        close,
      });
      return;
    }
    case 'arabic': {
      const { serveArabic } = await import('./arabic-runtime.js');
      serveArabic({
        onMessage: (listener) => listen((message) => listener(message as never)),
        postMessage: (reply) => port.postMessage(reply),
        close,
      });
      return;
    }
    case 'lid': {
      // The language-ID model (P4): ONNX Runtime and nothing else.
      const { serveLanguageID } = await import('./language-id-runtime.js');
      serveLanguageID({
        onMessage: (listener) => listen((message) => listener(message as never)),
        postMessage: (reply) => port.postMessage(reply),
        close,
      });
      return;
    }
    default:
      process.stderr.write(`engine-host: unknown role ${String(role)}\n`);
      process.exit(2);
  }
}

void serve();
