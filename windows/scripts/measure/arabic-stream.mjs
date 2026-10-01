#!/usr/bin/env node
// Arabic on the Windows code path, on real weights (C4): the app's own `ArabicEngine` from
// `dist/`, its decoders in a separate engine process exactly as the app runs them (`fork` here,
// Electron's utility process there), fed each clip in 100 ms chunks at `--pace` × real time,
// followed by `--trail` s of room tone (how long after the last word the user lets go). Times
// the first-run speed check (the app's own), then release → text per clip — C4's "streamed tail".
//
//   npm run build
//   node scripts/measure/arabic-stream.mjs --kind cohere --dir <dir with the .gguf> \
//        [--backend cpu|auto] [--threads 4] [--pace 1] [--trail 0.3] [--text] clip.wav ...
//   node scripts/measure/arabic-stream.mjs --kind fastConformer --dir <fc bundle dir> ... clip.wav ...
//
// `--backend cpu --threads 4` is C4's Windows floor (this Mac's CPU, no GPU). Pauses come from
// the energy gate: Silero runs in kotiba-stt.exe, which is not built for macOS here.

import { loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../dist/src');
const engines = await import(join(dist, 'engines/index.js'));
const { readWavFile } = await import(join(dist, 'audio/wav.js'));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}
const kind = arg('kind', 'cohere');
const directory = resolve(arg('dir'));
const backend = arg('backend', 'cpu');
const threads = Number(arg('threads', '4'));
const pace = Number(arg('pace', '1'));
const trail = Number(arg('trail', '0.3'));
const clips = process.argv.slice(2).filter((value) => value.endsWith('.wav'));
// `--segment S`: the stream's commit length (min S, relax S + 2, max S + 4), as the Mac's
// `--arabic-segment` (C4 §14.4). Absent: the engine's own `ARABIC_SPEECH_SEGMENTER`.
const segment = arg('segment');
// `--coalesce on|off`: force `coalesceSpeculations` (absent: the engine's own choice).
const coalesce = arg('coalesce');
const bundle = kind === 'cohere' ? 'cohere_arabic' : 'fastconformer_ar';

// The weights as a verified store would hand them over: this directory, for this engine only.
const store = {
  directoryFor: () => directory,
  pathOf: (_id, name) => join(directory, name),
  isInstalled: async (id) => id === bundle,
  locate: async (id) => (id === bundle ? directory : null),
  ensure: async () => {
    throw new Error('the measurement never downloads');
  },
  notes: [],
};

let verdict = null;
const notes = [];
const engine = new engines.ArabicEngine({
  store,
  threads,
  autoDownload: false,
  idleUnloadMs: null,
  loadBudgetMs: null,
  choice: () => kind,
  backend: () => backend,
  launcher: engines.forkLauncher(join(dist, 'engines/engine-host.js')),
  onNote: (note) => notes.push(note),
  ...(coalesce === null ? {} : { coalesceSpeculations: coalesce === 'on' }),
  ...(segment === null
    ? {}
    : {
        segmenter: {
          ...engines.ARABIC_SPEECH_SEGMENTER,
          minimumSegment: Number(segment),
          relaxAfter: Number(segment) + 2,
          maximumSegment: Number(segment) + 4,
        },
      }),
});

let t = performance.now();
await engine.prepare();
const loadMs = performance.now() - t;

// The speed check as the app runs it (only for Cohere; the app's own clip).
if (kind === 'cohere') {
  const clip = (await readWavFile(resolve(here, '../../fixtures/speed-check/arabic-speed-check.wav'))).samples;
  const runtimeTimes = [];
  for (let run = 0; run < 3; run += 1) {
    t = performance.now();
    await engine.transcribe({ samples: clip, droppedSamples: 0 }, 'ar');
    runtimeTimes.push(Math.round(performance.now() - t));
  }
  verdict = { runs: runtimeTimes, fasterOfTwo: Math.min(runtimeTimes[1], runtimeTimes[2]), slowAt: engines.DEFAULT_SPEED_THRESHOLD_MS };
}
console.error(
  `${kind} on ${engine.status().device} (${backend}, ${threads} threads): load ${Math.round(loadMs)} ms, load1 ${loadavg()[0].toFixed(2)}` +
    (verdict === null ? '' : `; speed check ${JSON.stringify(verdict)} → ${verdict.fasterOfTwo > verdict.slowAt ? 'SLOW: FastConformer' : 'Cohere stays'}`),
);

function room(seconds) {
  const out = new Float32Array(Math.round(seconds * 16000));
  for (let i = 0; i < out.length; i += 1) out[i] = (Math.random() - 0.5) * 0.002;
  return out;
}

/** Trailing silence down to 0.2 s after the last speech, as Silero leaves it in the app (C4 §1). */
function trimTail(samples) {
  const frame = 320;
  let end = samples.length;
  while (end > frame) {
    let energy = 0;
    for (let i = end - frame; i < end; i += 1) energy += samples[i] * samples[i];
    if (Math.sqrt(energy / frame) > 0.01) break;
    end -= frame;
  }
  return samples.subarray(0, Math.min(samples.length, end + 3200));
}

for (const clip of clips) {
  const audio = await readWavFile(clip);
  const speech = trimTail(audio.samples);
  const recording = new Float32Array(speech.length + Math.round(trail * 16000));
  recording.set(speech);
  recording.set(room(trail), speech.length);

  const stream = engine.openStream();
  for (let at = 0; at < recording.length; at += 1600) {
    stream.append(recording.slice(at, at + 1600));
    await new Promise((done) => setTimeout(done, 100 / pace));
  }
  t = performance.now();
  const streamed = await stream.finish({ samples: recording, droppedSamples: 0 }, 'ar');
  const releaseMs = performance.now() - t;
  console.log(
    JSON.stringify({
      clip: clip.replace(/^.*\//u, ''),
      seconds: +(recording.length / 16000).toFixed(2),
      releaseMs: Math.round(releaseMs),
      tail: stream.report?.tail,
      tailSeconds: +(stream.report?.tailSeconds ?? 0).toFixed(2),
      commits: stream.report?.commits,
      speculations: stream.report?.speculations,
      load1: +loadavg()[0].toFixed(2),
      ...(process.argv.includes('--text') ? { text: streamed.raw } : {}),
    }),
  );
}
await engine.dispose();
for (const note of notes) console.error(`note: ${note}`);
