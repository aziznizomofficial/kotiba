// The Parakeet worker thread: loads the three ONNX sessions and answers transcriptions, one
// at a time, in order. See `parakeet-runtime.ts` for why it is a thread, and `engine-host.ts`
// for the separate process the app runs it in instead (D-W22) — this thread is the fallback
// for a machine where that process cannot start, and what `--check` and the headless
// measurements use.
//
// It imports nothing but `parakeet-runtime.ts` (and through it `src/core/stt/tdt.ts` and
// onnxruntime-node): that module graph is what electron-builder unpacks out of app.asar.

import { parentPort } from 'node:worker_threads';

import { serveParakeet, type WorkerReply, type WorkerRequest } from './parakeet-runtime.js';

const port = parentPort;
if (port === null) throw new Error('parakeet-worker.js runs only as a worker thread');

serveParakeet({
  onMessage: (listener) => port.on('message', (request: WorkerRequest) => listener(request)),
  postMessage: (reply: WorkerReply) => port.postMessage(reply),
  close: () => port.close(),
});
