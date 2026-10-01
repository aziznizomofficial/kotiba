// The host client, driven against a REAL child process speaking the real protocol.
//
// A hand-written double for the child would test none of the parts that can only be
// wrong at runtime: the little-endian float payload, lines split across chunk
// boundaries, and what happens when the process dies mid-request.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSttHost, encodeFrame, MAX_CONSECUTIVE_FAILURES } from '../../src/engines/index.js';
import { asEngineError } from '../../src/contracts/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_HOST = join(here, 'fake-host.mjs');

const spawned: { dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  while (spawned.length > 0) await spawned.pop()?.dispose();
});

function host(behaviour: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const created = createSttHost({
    hostPath: 'node',
    spawnProcess: (): ChildProcessWithoutNullStreams =>
      spawn(process.execPath, [FAKE_HOST, JSON.stringify(behaviour)], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ...options,
  });
  spawned.push(created);
  return created;
}

function pcm(seconds: number, value = 0.25): Float32Array {
  return new Float32Array(Math.round(16000 * seconds)).fill(value);
}

/**
 * The client's timeout has to be real — it races a real hung child process, and there
 * is no fake-timer that speeds up a `spawn()` the client makes to replace it. 120 ms was
 * timed on an idle Mac and measured 3/3 there; on the 1-core / 2-thread Windows CI VM
 * this project targets (measured 2026-08-11, four other sessions running) that budget is
 * blown by the OS process-creation overhead alone, before the replacement host has even
 * had a chance to answer `hello`. A CI runner never has fewer than two cores committed
 * to it here, so this budget only has to survive one of them being saturated by
 * something else — not the whole machine being idle.
 */
const REQUEST_TIMEOUT_MS = 2_000;

describe('encodeFrame', () => {
  it('writes the fixed 21-byte prefix outside the JSON', () => {
    const frame = encodeFrame({ id: 'a', op: 'hello' });
    expect(frame.subarray(0, 4).toString('ascii')).toBe('KSTT');
    expect(frame[20]).toBe(0x0a);
    const headerBytes = parseInt(frame.subarray(4, 12).toString('ascii'), 16);
    const payloadBytes = parseInt(frame.subarray(12, 20).toString('ascii'), 16);
    expect(payloadBytes).toBe(0);
    expect(JSON.parse(frame.subarray(21, 21 + headerBytes).toString('utf8'))).toEqual({
      id: 'a',
      op: 'hello',
    });
  });

  it('carries float32 little-endian, four bytes per sample', () => {
    const samples = new Float32Array([1, -0.5, 0.25]);
    const frame = encodeFrame({ op: 'transcribe' }, samples);
    const payloadBytes = parseInt(frame.subarray(12, 20).toString('ascii'), 16);
    expect(payloadBytes).toBe(12);
    const payload = frame.subarray(frame.length - 12);
    expect(payload.readFloatLE(0)).toBe(1);
    expect(payload.readFloatLE(4)).toBe(-0.5);
    expect(payload.readFloatLE(8)).toBe(0.25);
  });

  it('honours byteOffset, so a subarray of a capture ring is not re-copied wrongly', () => {
    const backing = new Float32Array([9, 9, 1, 2, 3]);
    const window = backing.subarray(2);
    const frame = encodeFrame({ op: 'transcribe' }, window);
    const payload = frame.subarray(frame.length - 12);
    expect(payload.readFloatLE(0)).toBe(1);
    expect(payload.readFloatLE(8)).toBe(3);
  });
});

describe('the round trip', () => {
  it('answers hello with the machine it is running on', async () => {
    const greeting = await host().greeting();
    expect(greeting?.whisper).toBe('v1.9.2');
    expect(greeting?.logicalCores).toBe(8);
    expect(greeting?.physicalCores).toBe(4);
  });

  it('caches the greeting rather than asking twice', async () => {
    const client = host();
    const first = await client.greeting();
    expect(await client.greeting()).toBe(first);
  });

  it('delivers the samples intact', async () => {
    const client = host();
    const response = await client.request(
      { id: '1', op: 'transcribe', language: 'uz' },
      pcm(0.5, 0.125),
    );
    expect(response.ok).toBe(true);
    expect(response.text).toContain('n=8000');
    expect(response.text).toContain('first=0.125');
    expect(response.text).toContain('lang=uz');
  });
});

describe('serialisation — whisper_full is not thread-safe on one context', () => {
  it('never lets two requests overlap, however many are fired at once', async () => {
    const client = host({ delayMs: 15 });
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        client.request({ id: String(index), op: 'transcribe', language: 'uz' }, pcm(0.1)),
      ),
    );
    for (const response of responses) {
      expect(response.ok).toBe(true);
      // The fake host counts how many handlers were live at once. Anything above 1 means
      // the client let two decodes share a context, which is heap corruption rather than
      // a garbled transcript.
      expect(response.text).toContain('maxInFlight=1');
    }
  });

  it('answers each request with its own id, in order', async () => {
    const client = host({ delayMs: 5 });
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        client.request({ id: `r${String(index)}`, op: 'transcribe', language: 'ru' }, pcm(0.1)),
      ),
    );
    expect(responses.map((response) => response.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it(
    'does not let one failure poison the requests queued behind it',
    async () => {
      const client = host({ hangOnOp: 'transcribe' }, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
      await expect(
        client.request({ id: '1', op: 'transcribe', language: 'uz' }, pcm(0.1)),
      ).rejects.toThrow();
      // The hung host was killed and a replacement spawned. The next request must be
      // answered by the new process, not rejected by the death of the old one.
      const second = await client.request({ id: '2', op: 'hello' });
      expect(second.ok).toBe(true);
      expect(second.id).toBe('2');
    },
    // The first request deliberately burns the whole REQUEST_TIMEOUT_MS budget waiting
    // on the hang, then the second gets its own fresh budget for the replacement spawn —
    // give the test itself enough room for both without tripping vitest's own default.
    REQUEST_TIMEOUT_MS * 3,
  );
});

describe('death and restart', () => {
  it('reports a refusal as a refusal, not as a death', async () => {
    const client = host({ refuse: 'no_model' });
    const response = await client.request({ id: '1', op: 'transcribe', language: 'uz' }, pcm(0.1));
    expect(response.ok).toBe(false);
    expect(response.code).toBe('no_model');
    expect(client.isRunning).toBe(true);
  });

  it('surfaces a death as hostUnavailable, with how it died', async () => {
    const client = host({ dieOnRequest: 1 });
    const error = await client
      .request({ id: '1', op: 'transcribe', language: 'uz' }, pcm(0.1))
      .catch((caught: unknown) => caught);
    const failure = asEngineError(error);
    expect(failure?.kind).toBe('hostUnavailable');
    expect(failure?.reason).toContain('code 9');
  });

  it('spawns a fresh host for the next request after one dies', async () => {
    const client = host({ dieOnRequest: 1 });
    await client.request({ id: '1', op: 'hello' }).catch(() => undefined);
    // The behaviour blob is per-process, so the replacement dies on ITS first request
    // too — what matters is that a replacement was made at all.
    await client.request({ id: '2', op: 'hello' }).catch(() => undefined);
    expect(client.restarts).toBeGreaterThan(1);
  });

  it('stops restarting after three consecutive failures rather than fork-bombing', async () => {
    const client = host({ dieOnStart: true });
    const reasons: string[] = [];
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILURES + 2; attempt += 1) {
      const error = await client.request({ id: String(attempt), op: 'hello' }).catch((e: unknown) => e);
      reasons.push(asEngineError(error)?.reason ?? '');
    }
    expect(client.restarts).toBeLessThanOrEqual(MAX_CONSECUTIVE_FAILURES);
    expect(reasons[reasons.length - 1]).toContain('will not be restarted again');
  });

  it('clears the failure count on a successful response, so a blip is not fatal', async () => {
    const client = host();
    for (let index = 0; index < 5; index += 1) {
      expect((await client.request({ id: String(index), op: 'hello' })).ok).toBe(true);
    }
    expect(client.restarts).toBe(1);
  });

  it('times out a host that never answers, and says how long it waited', async () => {
    // Unlike the queued-request test above, nothing here races a second spawn — the
    // host is already up and simply never answers, so the timeout is the only thing
    // this test waits on. REQUEST_TIMEOUT_MS is still used (rather than an even smaller
    // number) so the reported figure and the budget stay the same one number everywhere
    // in this file.
    const client = host({ hangOnRequest: 1 }, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const error = await client.request({ id: '1', op: 'hello' }).catch((caught: unknown) => caught);
    const failure = asEngineError(error);
    expect(failure?.kind).toBe('hostUnavailable');
    expect(failure?.reason).toContain(`${String(REQUEST_TIMEOUT_MS)} ms`);
  });

  it(
    'never hands a dead host\'s line to the request that replaced it',
    async () => {
      // FINDING 10. `stdout`, `pending` and the line splitter are shared closure state,
      // but the `data` handler had no `child !== process_` guard — the `error` and
      // `close` handlers both do. So: dictation A hangs, the timeout drops the child and
      // ends it, dictation B spawns a fresh host — and a line the OLD process still had
      // in its pipe lands in the SAME handler and resolves B's pending request.
      //
      // The user sees the previous utterance inserted for the current one. Nothing
      // anywhere reports an error, because from the client's point of view B succeeded.
      const client = host(
        { hangOnOp: 'transcribe', lateAnswerOnKill: 120, delayMs: 700 },
        { requestTimeoutMs: REQUEST_TIMEOUT_MS },
      );

      await expect(
        client.request({ id: 'A', op: 'transcribe', language: 'uz' }, pcm(0.1)),
      ).rejects.toThrow();

      // B is in flight from here. The old process writes A's answer ~120 ms from now,
      // while B's replacement is still sitting on its 700 ms delay.
      const second = await client.request({ id: 'B', op: 'hello' });
      expect(second.id).toBe('B');
      expect(second.text ?? '').not.toContain('LATE FROM THE DEAD HOST');
    },
    REQUEST_TIMEOUT_MS * 4,
  );

  it('refuses everything after dispose', async () => {
    const client = host();
    await client.request({ id: '1', op: 'hello' });
    await client.dispose();
    const error = await client.request({ id: '2', op: 'hello' }).catch((caught: unknown) => caught);
    expect(asEngineError(error)?.reason).toContain('shut down');
  });
});
