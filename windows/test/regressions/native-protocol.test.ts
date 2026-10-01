// REGRESSION (final win review 2026-09-30, fixed): native helpers ↔ their TS clients — three defects, each pinned below.
//
// 1. Kotiba's OWN injected typing cancels the next dictation as a chord.
//    kotiba-input's primary path is SendInput(KEYEVENTF_UNICODE); every unit arrives at the
//    WH_KEYBOARD_LL hook as vkCode VK_PACKET (0xE7 = 231), flagged injected, and kotiba-hook
//    reports injected events like any other (main.cpp:80). With overlapping dictations the
//    previous press's insert runs DURING the next hold (controller.ts orderedInsert), so a
//    `DOWN 231` lands inside the 1.5 s chord window and the new dictation is cancelled.
//
// 2. A late answer to an `immediate` request resolves the SERIALISED request.
//    host-client.ts handleLine: an `!`-id line whose immediate already timed out falls
//    through to `pending`, so an in-flight transcribe resolves with the vad_open answer —
//    `ok: true`, no text — and the dictation silently becomes an empty transcript.
//
// 3. The transcribe timeout does not scale with the audio (fixed 120 s): a long batch
//    decode is killed and its text lost.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HotkeyTracker } from '../../src/core/hotkey/index.js';
import { createSttHost } from '../../src/engines/host-client.js';

const RIGHT_CTRL = 0xa3;
const VK_PACKET = 0xe7;

describe('kotiba-hook reports Kotiba\'s own unicode typing (VK_PACKET)', () => {
  it('an insert from the previous dictation does not cancel the hold in progress', () => {
    const tracker = new HotkeyTracker(RIGHT_CTRL);
    expect(tracker.handle({ kind: 'down', vk: RIGHT_CTRL }, 0)).toBe('pressed');
    // 300 ms later the previous dictation's text is typed by kotiba-input (injected).
    expect(tracker.handle({ kind: 'down', vk: VK_PACKET }, 300)).toBeNull();
    expect(tracker.handle({ kind: 'up', vk: VK_PACKET }, 301)).toBeNull();
    expect(tracker.handle({ kind: 'up', vk: RIGHT_CTRL }, 2_000)).toBe('released');
  });
});

/** An in-process child: the test writes the host's stdout by hand. */
function fakeChild(): { child: ChildProcessWithoutNullStreams; say: (line: string) => void } {
  const emitter = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdin.resume();
  Object.assign(emitter, { stdin, stdout, stderr, kill: () => true, pid: 1 });
  return { child: emitter, say: (line) => stdout.write(`${line}\n`) };
}

describe('host-client: immediate vs serialised matching', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a timed-out immediate\'s late answer never resolves the serialised request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { child, say } = fakeChild();
    const host = createSttHost({ hostPath: 'x', spawnProcess: () => child });

    const transcribe = host.request({ id: 'stt-1', op: 'transcribe', language: 'uz' });
    const opened = host.immediate({ op: 'vad_open', model: 'silero.bin' });
    const openedOutcome = opened.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await openedOutcome).toBe('rejected');

    // The host was only slow: its vad_open answer arrives now, then the transcript.
    say('{"id":"!vad_open-1","ok":true,"handle":1,"frameSamples":512}');
    say('{"id":"stt-1","ok":true,"text":"the real transcript","segments":1,"ms":900}');
    await vi.advanceTimersByTimeAsync(1);

    const response = await transcribe;
    expect(response.id).toBe('stt-1');
    expect(response.text).toBe('the real transcript');
  });
});

describe('host-client: timeout vs audio length', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a 10-minute batch decode is not killed at a fixed 120 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { child, say } = fakeChild();
    const host = createSttHost({ hostPath: 'x', spawnProcess: () => child });
    const tenMinutes = new Float32Array(16_000 * 600);
    const transcribe = host.request({ id: 'stt-1', op: 'transcribe', language: 'en' }, tenMinutes);
    const outcome = transcribe.then(
      () => 'resolved',
      () => 'rejected',
    );
    // large-v3-turbo on a 4-core laptop CPU: ~20 encoder windows + ~1,500 tokens.
    await vi.advanceTimersByTimeAsync(150_000);
    say('{"id":"stt-1","ok":true,"text":"ten minutes of text","segments":40,"ms":150000}');
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('resolved');
  });
});
