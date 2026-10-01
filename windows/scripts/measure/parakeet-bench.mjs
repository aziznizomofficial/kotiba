#!/usr/bin/env node
// The Windows Parakeet engine, run headless over a manifest — the TypeScript twin of
// `Scripts/measure/en-ru/sherpa_bench.py --model onnx-asr-parakeet`, writing the same JSONL
// rows so `Scripts/measure/en-ru/score.py` scores both the same way.
//
// It runs THE APP'S OWN CLASSES from `dist/` (`npm run build` first) — `ParakeetEngine`,
// its runtime, its stream — not a copy. onnxruntime-node ships darwin-arm64 as well as
// win32-x64, so the numbers this prints on a Mac are the CPU provider's, on this CPU: they
// verify ACCURACY against C1 §8 and give a latency floor; they are not Windows latencies.
//
//   npm run build
//   node scripts/measure/parakeet-bench.mjs --models <dir holding parakeet-tdt-0.6b-v3-ultra-int8/> \
//        --manifest ~/code/kotib-lab/stt/sets/short/en.jsonl --out results/ts-short-en.jsonl
//   # Streamed, as a microphone feeds it: 100 ms pieces at 2× real time, tail = key-up → text.
//   node scripts/measure/parakeet-bench.mjs ... --stream --pace 2
//
// The bundle directory must be verified (a `.kotiba-verified.json` stamp beside the files);
// `--stamp` writes one after hashing, for a directory assembled by hand or by symlinks.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadavg, availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../dist/src');
const { ParakeetEngine, resolveOrtThreads } = await import(join(dist, 'engines/parakeet.js'));
const { createBundleStore } = await import(join(dist, 'engines/bundle-store.js'));
const { PARAKEET_ULTRA } = await import(join(dist, 'contracts/index.js'));
const { readWavFile } = await import(join(dist, 'audio/wav.js'));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const models = arg('models');
const manifest = arg('manifest');
const out = arg('out');
const stream = flag('stream');
const pace = Number(arg('pace', '2'));
const threads = Number(arg('threads', String(resolveOrtThreads(availableParallelism()))));
const limit = Number(arg('limit', '100000'));
if (models === null || manifest === null || out === null) {
  console.error('usage: parakeet-bench.mjs --models DIR --manifest M.jsonl --out R.jsonl [--stream --pace 2] [--threads N] [--stamp]');
  process.exit(2);
}

if (flag('stamp')) {
  const directory = join(models, PARAKEET_ULTRA.directory);
  const files = [];
  for (const file of PARAKEET_ULTRA.files) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(directory, file.localName))) hash.update(chunk);
    const sha256 = hash.digest('hex');
    if (sha256 !== file.sha256) throw new Error(`${file.localName}: sha256 ${sha256} is not the pinned ${file.sha256}`);
    files.push({ localName: file.localName, bytes: file.bytes, sha256 });
  }
  await writeFile(join(directory, '.kotiba-verified.json'), JSON.stringify({ verified: new Date().toISOString(), files }, null, 2));
  console.error(`stamped ${directory}`);
}

const store = createBundleStore({ modelsDirectory: models });
const engine = new ParakeetEngine({ store, threads, autoDownload: false, idleUnloadMs: null, loadBudgetMs: null });
const label = `ts-ort-parakeet-ultra-int8-t${threads}`;

let t = performance.now();
await engine.prepare();
console.error(`${label}: prepare ${Math.round(performance.now() - t)} ms (load + warm-up decode), load1 ${loadavg()[0].toFixed(2)}`);

const items = (await readFile(manifest, 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .slice(0, limit);

// Warm-up, discarded — the same two passes the Python bench makes.
const warm = await readWavFile(items[0].wav);
for (let i = 0; i < 2; i += 1) await engine.transcribe(warm, items[0].lang);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(dirname(out), { recursive: true });
const rows = [];
for (const [i, item] of items.entries()) {
  const audio = await readWavFile(item.wav);
  const row = {
    id: item.id,
    engine: label + (stream ? '-stream' : ''),
    lang: item.lang,
    set: item.set ?? null,
    dur: audio.samples.length / 16000,
    load1: Number(loadavg()[0].toFixed(2)),
    rss_mb: Math.round(process.memoryUsage().rss / 1048576),
  };
  let text;
  t = performance.now();
  if (stream) {
    // A microphone: 100 ms pieces, `pace` times faster than real time.
    const live = engine.openStream();
    const piece = 1600;
    for (let at = 0; at < audio.samples.length; at += piece) {
      live.append(audio.samples.slice(at, at + piece));
      await sleep(100 / pace);
    }
    const tail = performance.now();
    const result = await live.finish(audio, item.lang);
    row.tail_ms = performance.now() - tail;
    text = result.raw;
  } else {
    text = (await engine.transcribe(audio, item.lang)).raw;
  }
  row.ms = performance.now() - t;
  row.hyp = text;
  rows.push(JSON.stringify(row));
  if (i % 25 === 0 || stream) {
    console.error(
      `${row.engine} [${i + 1}/${items.length}] ${row.dur.toFixed(1)}s → ${row.ms.toFixed(0)} ms` +
        (row.tail_ms === undefined ? '' : ` tail ${row.tail_ms.toFixed(0)} ms`) +
        ` load1 ${row.load1}  ${text.slice(0, 60)}`,
    );
  }
}
await writeFile(out, rows.join('\n') + '\n');
await engine.dispose();
console.error(`${label}: done, ${rows.length} rows → ${out}`);
