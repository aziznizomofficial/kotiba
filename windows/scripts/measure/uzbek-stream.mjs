#!/usr/bin/env node
// The Windows streaming Uzbek path (C2), end to end on real weights: the app's own
// `createSttEngineWithHost` + `createStreamingWhisperEngine` from `dist/`, talking to a REAL
// `kotiba-stt` 1.1 (linked against whisper.cpp v1.9.2), with the real Silero VAD. Each clip
// is fed in 100 ms chunks at `--pace` × real time, followed by `--trail` seconds of room tone
// (how long after the last word the user lets go); release → text is timed, and the streamed
// transcript is compared with a whole-utterance decode on the same engine.
//
//   node scripts/measure/uzbek-stream.mjs --host <kotiba-stt> --model <ggml-uzbek-stt-v1-q5_0.bin> \
//        --vad <ggml-silero-v6.2.0.bin> [--gpu] [--pace 1] [--trail 0.3] clip.wav ...
//
// `--gpu` off (the default) is the CPU, which is what Windows' host runs. `--language tr` with
// the turbo model is the Turkish family (C4, D-W24): the same session, greedy, its own member.
// `--threads N` pins the decode threads (default: what the app derives for 8 logical cores).

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../dist/src');
const engines = await import(join(dist, 'engines/index.js'));
const { DEFAULT_SETTINGS } = await import(join(dist, 'contracts/index.js'));
const { readWavFile } = await import(join(dist, 'audio/wav.js'));
const { vocabularyHint } = await import(join(dist, 'core/text/index.js'));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}
const clips = process.argv.slice(2).filter((value) => value.endsWith('.wav'));
const pace = Number(arg('pace', '1'));
const trail = Number(arg('trail', '0.3'));
const gpu = process.argv.includes('--gpu');
const language = arg('language', 'uz');
const family = language === 'tr' ? 'turkish' : 'uzbek';

const hint = vocabularyHint([], language);
const params = engines.whisperParamsFor({ language, family, settings: DEFAULT_SETTINGS, initialPrompt: hint, cpuCount: 8 });
const engine = engines.createSttEngineWithHost({
  engineId: `whisper-${arg('model').replace(/^.*\//u, '').replace(/\.bin$/u, '')}`,
  modelPath: arg('model'),
  params: arg('threads') === null ? params : { ...params, nThreads: Number(arg('threads')) },
  hostPath: arg('host'),
  supportedLanguages: [language],
  useGpu: gpu,
  flashAttention: false,
  initialPromptFor: () => hint,
});
const streaming = engines.createStreamingWhisperEngine({ engine, language, speechDetectorPath: async () => arg('vad'), hint: () => hint });
let t = performance.now();
await engine.prepare();
console.error(`load ${Math.round(performance.now() - t)} ms on ${gpu ? 'Metal' : 'the CPU'}, load1 ${loadavg()[0].toFixed(2)}`);

function room(seconds) {
  const out = new Float32Array(Math.round(seconds * 16000));
  for (let i = 0; i < out.length; i += 1) out[i] = (Math.random() - 0.5) * 0.002;
  return out;
}

for (const clip of clips) {
  const audio = await readWavFile(clip);
  const recording = new Float32Array(audio.samples.length + Math.round(trail * 16000));
  recording.set(audio.samples);
  recording.set(room(trail), audio.samples.length);

  t = performance.now();
  const whole = await engine.transcribe({ samples: recording, droppedSamples: 0 }, language);
  const wholeMs = performance.now() - t;

  const stream = streaming.openStream();
  for (let at = 0; at < recording.length; at += 1600) {
    stream.append(recording.slice(at, at + 1600));
    await new Promise((resolve) => setTimeout(resolve, 100 / pace));
  }
  t = performance.now();
  const streamed = await stream.finish({ samples: recording, droppedSamples: 0 }, language);
  const releaseMs = performance.now() - t;
  const a = new Set(whole.raw.toLowerCase().split(/\s+/u));
  const b = new Set(streamed.raw.toLowerCase().split(/\s+/u));
  const overlap = [...a].filter((word) => b.has(word)).length / Math.max(1, a.size);
  console.log(
    JSON.stringify({
      clip: clip.replace(/^.*\//u, ''),
      seconds: +(audio.samples.length / 16000).toFixed(2),
      trail,
      wholeMs: Math.round(wholeMs),
      releaseMs: Math.round(releaseMs),
      tail: stream.report.tail,
      speculations: stream.report.speculations,
      aborted: stream.report.aborted,
      identical: whole.raw === streamed.raw,
      overlap: +overlap.toFixed(2),
      ...(process.argv.includes('--text') ? { whole: whole.raw, streamed: streamed.raw } : {}),
      load1: +loadavg()[0].toFixed(2),
    }),
  );
}
await engine.dispose();
