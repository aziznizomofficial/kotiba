// A fake kotiba-stt that speaks the REAL wire protocol over REAL pipes.
//
// The client is tested against a child process rather than a stubbed object on purpose:
// the framing, the little-endian float payload, the line splitting across chunk
// boundaries and the process-death path are the parts that can only be wrong at runtime,
// and a hand-written double for the child would test none of them.
//
// Behaviour is driven by argv[2], a JSON blob:
//   { "dieOnStart": true }        exit 9 immediately, having answered nothing
//   { "dieOnRequest": 2 }         exit 9 after N requests have been read
//   { "hangOnRequest": 1 }        read the Nth request and never answer
//   { "hangOnOp": "transcribe" }  never answer that op, but answer everything else —
//                                 the replacement process then proves recovery, which
//                                 a per-request counter cannot, because the blob is
//                                 per PROCESS and a fresh one starts counting again
//   { "refuse": "no_model" }      answer every transcribe with that error code
//   { "delayMs": 50 }             wait before answering, to expose overlapping calls
//   { "loadFails": true }         refuse `load` with model_corrupt
//   { "lateAnswerOnKill": 150 }   swallow SIGTERM, then N ms later write the answer to
//                                 the request it was still holding — a buffered line
//                                 from a process the client has already replaced. This
//                                 is not a contrivance: a host killed for hanging can
//                                 have a full stdout pipe the OS flushes to the parent
//                                 after the kill, and the parent's `data` handler is
//                                 shared closure state.

import process from 'node:process';

const behaviour = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const PREFIX_BYTES = 21;

if (behaviour.dieOnStart) process.exit(9);

// { "exitAfterMs": 120 } — die on a timer with nothing in flight. A host can be OOM-
// killed or crash between dictations, and the engine that owns it has to notice without
// a request being the thing that discovers it.
if (behaviour.exitAfterMs) setTimeout(() => process.exit(9), behaviour.exitAfterMs);

//   { "noVad": true }             a 1.0 host: refuses abort and every vad_* op as unknown
//   { "transcribeDelayMs": 300 }  a slow decode that polls for an abort every 10 ms

let buffer = Buffer.alloc(0);
/** Ids an `abort` named. A running slow decode sees its id land here and stops. */
const abortedIds = new Set();
let requests = 0;
/** The request being held by a `hang*` rule, for `lateAnswerOnKill` to answer. */
let held = null;
/** Concurrency witness: >1 at any moment means the client let two calls overlap. */
let inFlight = 0;
let maxInFlight = 0;

function reply(object) {
  process.stdout.write(JSON.stringify(object) + '\n');
}

if (behaviour.lateAnswerOnKill) {
  // Swallow it. The client has already dropped this process and spawned a replacement;
  // the point of the fixture is what the parent does with the line that arrives anyway.
  process.on('SIGTERM', () => {
    setTimeout(() => {
      reply({ id: held?.id ?? 'late', ok: true, text: ' LATE FROM THE DEAD HOST ' });
    }, behaviour.lateAnswerOnKill);
  });
}

async function handle(header, samples) {
  requests += 1;
  if (behaviour.dieOnRequest === requests) process.exit(9);
  if (behaviour.hangOnRequest === requests) {
    held = header;
    return;
  }
  if (behaviour.hangOnOp === header.op) {
    held = header;
    return;
  }

  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));

  const id = header.id ?? '';
  switch (header.op) {
    case 'hello':
      reply({
        id,
        ok: true,
        host: '1.0.0',
        whisper: 'v1.9.2',
        logicalCores: 8,
        physicalCores: 4,
        performanceCores: 4,
      });
      break;
    case 'load':
      if (behaviour.loadFails) {
        reply({ id, ok: false, code: 'model_corrupt', error: 'whisper.cpp could not load it' });
      } else {
        reply({ id, ok: true, model: header.model });
      }
      break;
    case 'unload':
      reply({ id, ok: true });
      break;
    case 'transcribe':
      if (behaviour.transcribeDelayMs) {
        for (let waited = 0; waited < behaviour.transcribeDelayMs; waited += 10) {
          if (abortedIds.has(id)) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (abortedIds.has(id)) {
          reply({ id, ok: false, code: 'aborted', error: 'aborted' });
          break;
        }
      }
      if (behaviour.refuse) {
        reply({ id, ok: false, code: behaviour.refuse, error: `refused: ${behaviour.refuse}` });
      } else {
        // Echo enough to assert on: how many samples arrived, what the first one was,
        // the language, and the concurrency witness.
        reply({
          id,
          ok: true,
          // `prompt=[...]` is delimited rather than space-separated because the hint
          // contains spaces, commas and full stops — that shape is the whole point of it.
          text: ` n=${samples.length} first=${samples.length > 0 ? samples[0].toFixed(3) : 'none'} lang=${header.language} maxInFlight=${maxInFlight} prompt=[${header.initialPrompt === null || header.initialPrompt === undefined ? 'NONE' : header.initialPrompt}] `,
          segments: 1,
          ms: 1,
          audioCtx: header.audioCtx ?? 0,
        });
      }
      break;
    case 'detect':
      // A fitted head window is echoed as `window` (per ten thousand), so a test can see it.
      reply({
        id,
        ok: true,
        audioCtx: header.audioCtx ?? 0,
        posterior: {
          tr: 0.63,
          az: 0.17,
          en: 0.1,
          ...(header.audioCtx > 0 ? { window: header.audioCtx / 10000 } : {}),
        },
      });
      break;
    case 'shutdown':
      reply({ id, ok: true });
      inFlight -= 1;
      process.exit(0);
      return;
    default:
      reply({ id, ok: false, code: 'unknown_op', error: `no operation named '${header.op}'` });
  }
  inFlight -= 1;
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (buffer.length < PREFIX_BYTES) return;
    if (buffer.subarray(0, 4).toString('ascii') !== 'KSTT') {
      process.stderr.write('fake-host: bad frame prefix\n');
      process.exit(3);
    }
    const headerBytes = parseInt(buffer.subarray(4, 12).toString('ascii'), 16);
    const payloadBytes = parseInt(buffer.subarray(12, 20).toString('ascii'), 16);
    const total = PREFIX_BYTES + headerBytes + payloadBytes;
    if (buffer.length < total) return;

    const headerText = buffer.subarray(PREFIX_BYTES, PREFIX_BYTES + headerBytes).toString('utf8');
    const payload = buffer.subarray(PREFIX_BYTES + headerBytes, total);
    buffer = buffer.subarray(total);

    const samples = new Float32Array(payloadBytes / 4);
    for (let i = 0; i < samples.length; i += 1) samples[i] = payload.readFloatLE(i * 4);

    const header = JSON.parse(headerText);
    // Host 1.1: these are answered by the reader thread, at once, whatever is decoding.
    if (['abort', 'vad_open', 'vad', 'vad_reset', 'vad_close'].includes(header.op)) {
      immediate(header, samples);
      continue;
    }
    void handle(header, samples);
  }
});

function immediate(header, samples) {
  const id = header.id ?? '';
  if (behaviour.noVad) {
    reply({ id, ok: false, code: 'unknown_op', error: `no operation named '${header.op}'` });
    return;
  }
  switch (header.op) {
    case 'abort':
      abortedIds.add(header.target);
      reply({ id, ok: true, running: true });
      return;
    case 'vad_open':
      reply({ id, ok: true, handle: 1, frameSamples: 512 });
      return;
    case 'vad': {
      const probs = [];
      for (let start = 0; start + 512 <= samples.length; start += 512) {
        let sum = 0;
        for (let i = start; i < start + 512; i += 1) sum += Math.abs(samples[i]);
        probs.push(sum / 512 > 0.1 ? 0.9 : 0.05);
      }
      reply({ id, ok: true, probs });
      return;
    }
    default:
      reply({ id, ok: true });
  }
}

process.stdin.on('end', () => process.exit(0));
