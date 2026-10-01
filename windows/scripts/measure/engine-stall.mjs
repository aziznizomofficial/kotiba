#!/usr/bin/env node
// How long the MAIN event loop is blocked while the modes' model loads and answers — in this
// process (the old arrangement) against in its own process (D-W22) — and what the process
// boundary costs a Parakeet window in IPC.
//
//   npm run build
//   node scripts/measure/engine-stall.mjs --model /path/Qwen3-1.7B-Q4_K_M.gguf --where inproc
//   node scripts/measure/engine-stall.mjs --model /path/Qwen3-1.7B-Q4_K_M.gguf --where process
//   node scripts/measure/engine-stall.mjs --ipc
//
// Stall = the longest gap between ticks of a 1 ms interval while the work runs, minus the
// 1 ms period — what the hotkey's key-up, the pill and a paste would have waited behind.
// Run each `--where` in a FRESH process: the first load pays the addon's dlopen, and that is
// the key-down cost being measured.

import { fork } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../dist/src');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

function stallMeter() {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 1);
    last = now;
  }, 1);
  return {
    reset() {
      worst = 0;
      last = performance.now();
    },
    read() {
      return worst;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

async function modes() {
  const model = arg('model');
  const where = arg('where', 'inproc');
  const { messagePrompt, superPrompt, noteClassifierPrompt, headingPrompt } = await import(join(dist, 'core/modes/index.js'));
  const prompts = [messagePrompt('en'), superPrompt('uz'), noteClassifierPrompt('en'), headingPrompt('en')];
  let polisher;
  if (where === 'process') {
    const { RemoteLlamaPolisher } = await import(join(dist, 'polish/remote-llama.js'));
    const { forkLauncher, engineHostPath } = await import(join(dist, 'engines/engine-process.js'));
    polisher = new RemoteLlamaPolisher({ launcher: forkLauncher(engineHostPath()), modelPath: async () => model, config: { threads: 4 } });
  } else {
    const { LlamaPolisher } = await import(join(dist, 'polish/llama.js'));
    polisher = new LlamaPolisher({ modelPath: async () => model, threads: 4 });
  }
  const meter = stallMeter();
  const rows = {};
  const step = async (name, work) => {
    meter.reset();
    const t0 = performance.now();
    await work();
    rows[name] = { wallMs: Math.round(performance.now() - t0), mainStallMs: Math.round(meter.read() * 10) / 10 };
  };
  const signal = new AbortController().signal;
  await step('keyDownPrepareCold', () => polisher.prepare(prompts));
  await step('firstSentence', () => polisher.generate('okay so basically the plumber is coming on friday', 'en', prompts[0], 32, signal));
  await step('warmSentence', () => polisher.generate('and also the garden gate is still broken', 'en', prompts[0], 32, signal));
  meter.stop();
  await polisher.dispose();
  console.log(JSON.stringify({ where, model: model.split('/').pop(), ...rows }));
}

async function ipc() {
  // Round trip of a Float32Array through a forked child with structured-clone serialisation,
  // the carrier `forkLauncher` uses; Electron's utilityProcess clones the same way.
  const directory = await mkdtemp(join(tmpdir(), 'kotiba-ipc-'));
  const echo = join(directory, 'echo.mjs');
  await writeFile(echo, "process.on('message', (m) => process.send({ n: m.samples.length }));\n");
  const child = fork(echo, [], { serialization: 'advanced' });
  const once = () => new Promise((resolve) => child.once('message', resolve));
  const out = {};
  for (const seconds of [0.1, 1, 14, 30]) {
    const samples = new Float32Array(Math.round(16_000 * seconds));
    const times = [];
    for (let i = 0; i < 40; i += 1) {
      const t0 = performance.now();
      const reply = once();
      child.send({ samples });
      await reply;
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    out[`${seconds}s`] = { medianMs: +times[20].toFixed(3), p90Ms: +times[36].toFixed(3) };
  }
  child.kill();
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ ipcRoundTrip16kHzFloat32: out }));
}

if (process.argv.includes('--ipc')) await ipc();
else await modes();
