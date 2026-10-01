// Drives a built `kotiba-stt-stub` over the real wire protocol and asserts what came back.
//
// Run it with:  node windows/native/kotiba-stt/test/protocol-test.mjs <path-to-binary>
// `run-protocol-test.sh` beside this file builds the binary first.
//
// It is deliberately NOT part of `windows/scripts/gate.sh`: the gate must pass on a
// clean checkout with no compiler, and it does. This is the test that runs when someone
// is about to touch the host.

import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import process from 'node:process';

const binary = process.argv[2];
if (!binary) {
  console.error('usage: node protocol-test.mjs <path-to-kotiba-stt-stub>');
  process.exit(2);
}

const PREFIX_BYTES = 21;

function frame(header, samples) {
  const body = Buffer.from(JSON.stringify(header), 'utf8');
  const payload = samples ? Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength) : Buffer.alloc(0);
  const prefix = Buffer.from(
    `KSTT${body.length.toString(16).padStart(8, '0')}${payload.length.toString(16).padStart(8, '0')}\n`,
    'ascii',
  );
  assert.equal(prefix.length, PREFIX_BYTES);
  return Buffer.concat([prefix, body, payload]);
}

/** Sends every frame, collects every response line, and reports how the host exited. */
function drive(frames) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = out.split('\n').filter((line) => line.trim().length > 0);
      resolve({ code, lines: lines.map((line) => JSON.parse(line)), stderr: err });
    });
    for (const buffer of frames) child.stdin.write(buffer);
    child.stdin.end();
  });
}

function pcm(seconds, value = 0.25) {
  const samples = new Float32Array(Math.round(16000 * seconds));
  samples.fill(value);
  return samples;
}

/** `key=value` out of the stub's echoed transcript. */
function field(text, name) {
  const match = new RegExp(`(?:^| )${name}=([^ ]*)`).exec(text);
  assert.ok(match, `expected ${name} in "${text}"`);
  return match[1];
}

let failures = 0;
async function check(name, body) {
  try {
    await body();
    console.log(`ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------

await check('hello reports the host, the whisper tag and the machine', async () => {
  const { lines, code } = await drive([frame({ id: 'a', op: 'hello' })]);
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 'a');
  assert.equal(lines[0].ok, true);
  assert.equal(lines[0].whisper, 'v1.9.2');
  assert.ok(lines[0].logicalCores >= 1);
});

await check('transcribe before load is a refusal, not a crash', async () => {
  const { lines, code } = await drive([
    frame({ id: 'a', op: 'transcribe', language: 'uz' }, pcm(2)),
  ]);
  assert.equal(code, 0, 'the host must survive');
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].code, 'no_model');
});

await check('a model that will not load is model_corrupt, and the host stays alive', async () => {
  const { lines, code } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/REFUSE.bin' }),
    frame({ id: 'b', op: 'hello' }),
  ]);
  assert.equal(code, 0);
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].code, 'model_corrupt');
  assert.equal(lines[1].ok, true, 'the host answered the next request');
});

await check('the BEAM branch sets greedy.best_of to 5 — the bug that shipped on macOS', async () => {
  const { lines } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/turbo.bin' }),
    frame(
      {
        id: 'b',
        op: 'transcribe',
        language: 'ru',
        strategy: 'beam',
        beamSearchBeamSize: 5,
        greedyBestOf: 5,
        nThreads: 4,
      },
      pcm(2),
    ),
  ]);
  const text = lines[1].text;
  assert.equal(field(text, 'strategy'), '1', 'beam strategy');
  assert.equal(field(text, 'best_of'), '5', 'best_of must be 5 in the BEAM branch');
  assert.equal(field(text, 'beam_size'), '5');
});

await check('the GREEDY branch leaves beam_size at whisper\'s own -1', async () => {
  const { lines } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }),
    frame(
      { id: 'b', op: 'transcribe', language: 'uz', strategy: 'greedy', greedyBestOf: 5, nThreads: 3 },
      pcm(2),
    ),
  ]);
  const text = lines[1].text;
  assert.equal(field(text, 'strategy'), '0', 'greedy strategy');
  assert.equal(field(text, 'best_of'), '5');
  assert.equal(field(text, 'beam_size'), '-1', 'do not pass beam_size 1 with a beam strategy');
  assert.equal(field(text, 'n_threads'), '3');
});

await check('the fields Kotiba never sets keep their v1.9.2 defaults', async () => {
  const { lines } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }),
    frame({ id: 'b', op: 'transcribe', language: 'uz' }, pcm(2)),
  ]);
  const text = lines[1].text;
  assert.equal(field(text, 'no_context'), '1');
  assert.equal(field(text, 'audio_ctx'), '0');
  assert.equal(field(text, 'temperature'), '0.00');
  assert.equal(field(text, 'temperature_inc'), '0.20');
  assert.equal(field(text, 'entropy_thold'), '2.40');
  assert.equal(field(text, 'logprob_thold'), '-1.00');
});

await check('the fields Kotiba does set are set', async () => {
  const { lines } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }),
    frame(
      {
        id: 'b',
        op: 'transcribe',
        language: 'uz',
        printRealtime: false,
        printProgress: false,
        printTimestamps: false,
        printSpecial: false,
        noTimestamps: true,
        translate: false,
        singleSegment: false,
        suppressBlank: true,
        noSpeechThold: 0.6,
        detectLanguage: false,
        initialPrompt: 'Kotiba, Toshkent.',
      },
      pcm(2),
    ),
  ]);
  const text = lines[1].text;
  assert.equal(field(text, 'print_progress'), '0', "whisper's default is TRUE — Kotiba turns it off");
  assert.equal(field(text, 'print_timestamps'), '0', "whisper's default is TRUE — Kotiba turns it off");
  assert.equal(field(text, 'no_timestamps'), '1', "whisper's default is false — Kotiba turns it ON");
  assert.equal(field(text, 'translate'), '0');
  assert.equal(field(text, 'single_segment'), '0');
  assert.equal(field(text, 'suppress_blank'), '1');
  assert.equal(field(text, 'no_speech_thold'), '0.60');
  assert.equal(field(text, 'detect_language'), '0');
  assert.equal(field(text, 'language'), 'uz');
  assert.ok(text.includes('prompt=Kotiba,'), 'the initial prompt reached whisper');
});

await check('a null initialPrompt leaves the field at nullptr', async () => {
  const { lines } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }),
    frame({ id: 'b', op: 'transcribe', language: 'uz', initialPrompt: null }, pcm(2)),
  ]);
  assert.equal(field(lines[1].text, 'prompt'), '(null)');
});

await check('short audio is padded to one second before it reaches whisper', async () => {
  const { lines } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }),
    frame({ id: 'b', op: 'transcribe', language: 'uz' }, pcm(0.2)),
  ]);
  assert.equal(field(lines[1].text, 'n_samples'), '16000');
});

await check('a missing language is refused — this host never auto-detects', async () => {
  const { lines, code } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }),
    frame({ id: 'b', op: 'transcribe' }, pcm(2)),
  ]);
  assert.equal(code, 0);
  assert.equal(lines[1].ok, false);
  assert.equal(lines[1].code, 'bad_request');
});

await check('the model is loaded ONCE — a second load of the same path is idempotent', async () => {
  const { lines, code } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }),
    frame({ id: 'b', op: 'load', model: '/models/uzbek.bin' }),
    frame({ id: 'c', op: 'transcribe', language: 'uz' }, pcm(2)),
  ]);
  assert.equal(code, 0);
  assert.equal(lines[0].ok, true);
  assert.equal(lines[1].ok, true);
  assert.equal(lines[2].ok, true);
});

await check('detect returns a posterior and drops everything under the 0.001 floor', async () => {
  const { lines } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/base.bin' }),
    frame({ id: 'b', op: 'detect', nThreads: 2 }, pcm(3)),
  ]);
  const posterior = lines[1].posterior;
  assert.equal(lines[1].ok, true);
  assert.ok(Math.abs(posterior.tr - 0.63) < 1e-4, 'tr wins on clean Uzbek');
  assert.equal(posterior.uz, undefined, 'uz scores 0 and is dropped — this is why cluster mass exists');
  assert.equal(posterior.ru, undefined, 'below the 0.001 noise floor');
});

await check('detect reads the window it is sent, and the full one when it is sent none', async () => {
  const { lines } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/turbo.bin' }),
    frame({ id: 'b', op: 'detect', nThreads: 2, audioCtx: 512 }, pcm(3)),
    frame({ id: 'c', op: 'detect', nThreads: 2 }, pcm(3)),
  ]);
  assert.equal(lines[1].ok, true);
  assert.equal(lines[1].audioCtx, 512);
  assert.ok(Math.abs(lines[1].posterior.az - 0.0512) < 1e-4, 'the head read the fitted window');
  assert.equal(lines[2].audioCtx, 0);
  assert.ok(Math.abs(lines[2].posterior.az - 0.17) < 1e-4, 'and the full one, not the last call’s');
});

await check('MALFORMED JSON is one error line and the host stays alive and in sync', async () => {
  // Hand-built: a valid prefix, a header that is not JSON, and a real payload after it.
  const junk = Buffer.from('{this is not json', 'utf8');
  const payload = Buffer.from(pcm(1).buffer);
  const bad = Buffer.concat([
    Buffer.from(
      `KSTT${junk.length.toString(16).padStart(8, '0')}${payload.length.toString(16).padStart(8, '0')}\n`,
      'ascii',
    ),
    junk,
    payload,
  ]);
  const { lines, code } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }),
    bad,
    frame({ id: 'c', op: 'transcribe', language: 'uz' }, pcm(2)),
  ]);
  assert.equal(code, 0, 'a malformed request is a refusal, not a crash');
  assert.equal(lines.length, 3);
  assert.equal(lines[1].ok, false);
  assert.equal(lines[1].code, 'bad_json');
  assert.equal(lines[2].ok, true, 'the NEXT frame was still read correctly — the stream stayed in sync');
});

await check('an unknown op is refused by name and the host stays alive', async () => {
  const { lines, code } = await drive([
    frame({ id: 'a', op: 'sing' }),
    frame({ id: 'b', op: 'hello' }),
  ]);
  assert.equal(code, 0);
  assert.equal(lines[0].code, 'unknown_op');
  assert.equal(lines[1].ok, true);
});

await check('a payload that is not whole float32 samples is refused, in sync', async () => {
  const bodyText = Buffer.from(JSON.stringify({ id: 'a', op: 'transcribe', language: 'uz' }), 'utf8');
  const odd = Buffer.alloc(7);
  const bad = Buffer.concat([
    Buffer.from(
      `KSTT${bodyText.length.toString(16).padStart(8, '0')}${odd.length.toString(16).padStart(8, '0')}\n`,
      'ascii',
    ),
    bodyText,
    odd,
  ]);
  const { lines, code } = await drive([bad, frame({ id: 'b', op: 'hello' })]);
  assert.equal(code, 0);
  assert.equal(lines[0].code, 'bad_frame');
  assert.equal(lines[1].ok, true);
});

await check('a stream that is not this protocol exits 3, distinguishably', async () => {
  // At least a full prefix worth of bytes, or the host simply sees the stream end.
  const { lines, code } = await drive([
    Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n', 'ascii'),
  ]);
  assert.equal(code, 3, 'desynchronised, and it says so rather than guessing');
  assert.equal(lines[0].code, 'bad_frame');
});

await check('stdin closing mid-frame is exit 0, not a crash', async () => {
  // The parent going away is the normal end of this process's life.
  const { code } = await drive([Buffer.from('KSTT0000', 'ascii')]);
  assert.equal(code, 0);
});

await check('shutdown answers and exits 0', async () => {
  const { lines, code } = await drive([frame({ id: 'a', op: 'shutdown' })]);
  assert.equal(code, 0);
  assert.equal(lines[0].ok, true);
});

await check('a unicode initial prompt survives the round trip', async () => {
  const prompt = 'sanʼat, oʻzbek, Toshkent';
  const { lines } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }),
    frame({ id: 'b', op: 'transcribe', language: 'uz', initialPrompt: prompt }, pcm(2)),
  ]);
  assert.ok(lines[1].text.includes('sanʼat'), 'U+02BC survived');
  assert.ok(lines[1].text.includes('oʻzbek'), 'U+02BB survived');
});

// ---------------------------------------------------------------------------------
// 1.1 — streaming Uzbek (C2): the encoder window, abort, Silero VAD
// ---------------------------------------------------------------------------------

/** Like `drive`, but each step may wait before it is written — to land an abort mid-decode. */
function driveTimed(steps) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const seen = [];
    const started = Date.now();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      let newline = out.indexOf('\n');
      while (newline >= 0) {
        const line = out.slice(0, newline);
        out = out.slice(newline + 1);
        if (line.trim().length > 0) seen.push({ at: Date.now() - started, line: JSON.parse(line) });
        newline = out.indexOf('\n');
      }
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, seen }));
    (async () => {
      for (const step of steps) {
        if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
        child.stdin.write(step.frame);
      }
      child.stdin.end();
    })();
  });
}

await check('audioCtx reaches whisper as audio_ctx, and absent stays the model window', async () => {
  const { lines } = await drive([
    frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }),
    frame({ id: 'b', op: 'transcribe', language: 'uz', audioCtx: 512 }, pcm(2)),
    frame({ id: 'c', op: 'transcribe', language: 'uz' }, pcm(2)),
    frame({ id: 'd', op: 'transcribe', language: 'uz', audioCtx: -3 }, pcm(2)),
  ]);
  assert.equal(field(lines[1].text, 'audio_ctx'), '512');
  assert.equal(lines[1].audioCtx, 512);
  assert.equal(field(lines[2].text, 'audio_ctx'), '0');
  assert.equal(field(lines[3].text, 'audio_ctx'), '0', 'a negative window is the model window');
});

await check('abort ends a RUNNING decode early, as code "aborted", and the host carries on', async () => {
  const { seen, code } = await driveTimed([
    { frame: frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }) },
    { frame: frame({ id: 'slow', op: 'transcribe', language: 'uz', initialPrompt: 'SLOW' }, pcm(2)) },
    { waitMs: 150, frame: frame({ id: '!x', op: 'abort', target: 'slow' }) },
    { frame: frame({ id: 'next', op: 'transcribe', language: 'uz' }, pcm(1)) },
  ]);
  assert.equal(code, 0);
  const byId = Object.fromEntries(seen.map((entry) => [entry.line.id, entry]));
  assert.equal(byId['!x'].line.ok, true);
  assert.equal(byId['!x'].line.running, true, 'the abort found the decode running');
  assert.equal(byId.slow.line.code, 'aborted');
  assert.ok(byId.slow.at < 1500, `aborted at ${byId.slow.at} ms, not after the full 2 s`);
  assert.equal(byId.next.line.ok, true, 'the next request decodes normally');
});

await check('abort of a QUEUED decode drops it before it starts', async () => {
  const { seen } = await driveTimed([
    { frame: frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }) },
    { frame: frame({ id: 'slow', op: 'transcribe', language: 'uz', initialPrompt: 'SLOW' }, pcm(2)) },
    { frame: frame({ id: 'queued', op: 'transcribe', language: 'uz' }, pcm(2)) },
    { waitMs: 100, frame: frame({ id: '!q', op: 'abort', target: 'queued' }) },
    { frame: frame({ id: '!s', op: 'abort', target: 'slow' }) },
  ]);
  const byId = Object.fromEntries(seen.map((entry) => [entry.line.id, entry.line]));
  assert.equal(byId['!q'].running, false);
  assert.equal(byId.queued.code, 'aborted');
  assert.match(byId.queued.error, /before it started/);
});

await check('VAD is answered at once, even while a decode runs', async () => {
  const loud = pcm(512 * 4 / 16000, 0.5);
  const { seen } = await driveTimed([
    { frame: frame({ id: 'a', op: 'load', model: '/models/uzbek.bin' }) },
    { frame: frame({ id: 'slow', op: 'transcribe', language: 'uz', initialPrompt: 'SLOW' }, pcm(2)) },
    { waitMs: 50, frame: frame({ id: '!v1', op: 'vad_open', model: '/models/ggml-silero-v6.2.0.bin' }) },
    { frame: frame({ id: '!v2', op: 'vad', handle: 1 }, loud) },
    { frame: frame({ id: '!v3', op: 'vad', handle: 1 }, pcm(700 / 16000, 0.01)) },
    { frame: frame({ id: '!v4', op: 'vad_reset', handle: 1 }) },
    { frame: frame({ id: '!v5', op: 'vad_close', handle: 1 }) },
    { frame: frame({ id: '!v6', op: 'vad', handle: 1 }, loud) },
    { frame: frame({ id: '!v7', op: 'vad_open', model: '/models/REFUSE.bin' }) },
    { frame: frame({ id: '!stop', op: 'abort', target: 'slow' }) },
  ]);
  const order = seen.map((entry) => entry.line.id);
  assert.ok(order.indexOf('!v2') < order.indexOf('slow'), `VAD answered before the decode: ${order.join(' ')}`);
  const byId = Object.fromEntries(seen.map((entry) => [entry.line.id, entry.line]));
  assert.equal(byId['!v1'].handle, 1);
  assert.equal(byId['!v1'].frameSamples, 512);
  assert.deepEqual(byId['!v2'].probs, [0.9, 0.9, 0.9, 0.9]);
  assert.deepEqual(byId['!v3'].probs, [0.05], 'whole frames only; the rest is the caller\'s');
  assert.equal(byId['!v4'].ok, true);
  assert.equal(byId['!v5'].ok, true);
  assert.equal(byId['!v6'].code, 'no_vad', 'a closed handle is refused, not a crash');
  assert.equal(byId['!v7'].code, 'vad_failed');
});

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('protocol test passed');
