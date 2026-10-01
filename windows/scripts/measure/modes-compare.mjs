#!/usr/bin/env node
// The Windows modes, run headless over a corpus the way `kotiba-probe modes` runs the Mac's —
// the same clean-up, the same incremental session, the same commit-then-tail split — so the
// two outputs can be compared row by row.
//
// It runs THE APP'S OWN CLASSES from `dist/` (`npm run build` first): `cleanUp`, the
// capitaliser, `IncrementalPolish`, and `LlamaPolisher` over node-llama-cpp (Metal on a Mac,
// Vulkan or the CPU on Windows).
//
//   node scripts/measure/modes-compare.mjs --model Qwen3-1.7B-Q4_K_M.gguf --mode message \
//        --language en scripts/measure/modes-sample.json > ts-message-en.jsonl
//   # and, on the Mac, from the repo root:
//   .build/release/kotiba-probe modes --model Qwen3-1.7B-Q4_K_M.gguf --mode message \
//        --language en windows/scripts/measure/modes-sample.json > mac-message-en.jsonl
//   node scripts/measure/modes-compare.mjs --diff ts-message-en.jsonl mac-message-en.jsonl
//
// `modes-sample.json` is invented sentences in the shapes the owner's dictation has; the
// owner's own text never goes in the repository.

import { readFile } from 'node:fs/promises';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../dist/src');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}

if (process.argv.includes('--diff')) {
  const [ours, theirs] = process.argv.slice(process.argv.indexOf('--diff') + 1);
  const read = async (path) => (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const a = await read(ours);
  const b = await read(theirs);
  let same = 0;
  let sameCleaned = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i].cleaned === b[i].cleaned) sameCleaned += 1;
    if (a[i].output === b[i].output) same += 1;
    else if (process.env.SHOW !== undefined) console.log(JSON.stringify({ windows: a[i].output, mac: b[i].output }));
  }
  console.log(JSON.stringify({ rows: Math.min(a.length, b.length), cleanedIdentical: sameCleaned, outputIdentical: same }));
  process.exit(0);
}

const modes = await import(join(dist, 'core/modes/index.js'));
const text = await import(join(dist, 'core/text/index.js'));
const { IncrementalPolish } = await import(join(dist, 'polish/incremental.js'));
const { LlamaPolisher, resolveLlamaThreads } = await import(join(dist, 'polish/llama.js'));

const modelPath = arg('model');
const mode = arg('mode', 'super');
const language = arg('language', 'en');
const corpusPath = process.argv[process.argv.length - 1];
const everywhere = process.argv.includes('--model-everywhere');
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const texts = corpus[language] ?? [];

const engine =
  modelPath === null
    ? null
    : new LlamaPolisher({
        modelPath: async () => modelPath,
        idleUnloadMs: null,
        threads: Number(arg('threads', String(resolveLlamaThreads(availableParallelism())))),
        onNote: (note) => console.error(note),
      });
const capitaliser = text.createCapitaliser([]);
const tails = [];
let first = true;
for (const raw of texts) {
  let cleaned = raw;
  if (language === 'uz') cleaned = text.normaliseForDelivery(cleaned);
  cleaned = modes.cleanUp(cleaned, language);
  cleaned = capitaliser.restore(cleaned);

  const session = new IncrementalPolish({
    behaviour: mode,
    language,
    engine,
    ...(everywhere ? { superModelLanguages: new Set(['en', 'ru', 'uz']) } : {}),
  });
  const t0 = performance.now();
  await session.prepare();
  const prepareMs = performance.now() - t0;
  const split = modes.splitSentences(cleaned, false);
  const head = split.sentences.slice(0, -1).join(' ');
  const tail = (split.sentences.length > 1 ? ' ' : '') + (split.sentences.at(-1) ?? '');
  const b0 = performance.now();
  if (head !== '') session.commit(head + ' ');
  await session.idle();
  const backgroundMs = performance.now() - b0;
  const outcome = await session.finish(tail, 10_000);
  tails.push(outcome.tailMs);
  const run = engine?.last ?? null;
  console.log(
    JSON.stringify({
      raw,
      cleaned,
      output: outcome.text,
      sentences: outcome.sentences,
      modelSentences: outcome.modelSentences,
      tailMs: outcome.tailMs,
      backgroundMs,
      prepareMs: first ? prepareMs : 0,
      notes: outcome.notes,
      lastPrefilled: run?.prefilled ?? 0,
      lastGenerated: run?.generated ?? 0,
      lastPrefillMs: run?.prefillMs ?? 0,
      lastGenerateMs: run?.generateMs ?? 0,
      load1: Number(loadavg()[0].toFixed(2)),
    }),
  );
  first = false;
}
await engine?.dispose();
const sorted = [...tails].sort((x, y) => x - y);
if (sorted.length > 0) {
  console.error(
    `${mode} ${language}: n=${sorted.length} tail p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms ` +
      `p90 ${sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))].toFixed(0)} ms ` +
      `max ${sorted[sorted.length - 1].toFixed(0)} ms, load1 ${loadavg()[0].toFixed(2)}`,
  );
}
