// The engines in their own process (D-W22): a real child per test, and real deaths — a
// SIGKILL is what a native crash in ONNX Runtime or llama.cpp looks like from outside.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CrashLimiter, EngineProcessExit, forkLauncher, type EngineRole } from '../../src/engines/engine-process.js';
import { ParakeetEngine } from '../../src/engines/parakeet.js';
import { startParakeetProcess } from '../../src/engines/parakeet-process.js';
import { startArabicProcess } from '../../src/engines/arabic-runtime.js';
import type { BundleStore } from '../../src/engines/bundle-store.js';
import { RemoteLlamaPolisher, type ModesModel } from '../../src/polish/remote-llama.js';

const FAKE = fileURLToPath(new URL('./fake-engine-host.mjs', import.meta.url));
const HOST = fileURLToPath(new URL('../../src/engines/engine-host.ts', import.meta.url));
const TS = ['--import', fileURLToPath(new URL('../support/ts-resolve.mjs', import.meta.url)), '--no-warnings'];

/** A launcher over the fake host; each start takes the next behaviour from the list. */
function fake(...behaviours: string[]) {
  let started = 0;
  return forkLauncher(FAKE, {
    extraArgs: (_role: EngineRole) => [behaviours[Math.min(started++, behaviours.length - 1)] ?? 'ok'],
  });
}

const PROMPT = { system: 'x', examples: [] };
const never = new AbortController().signal;
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function remote(options: Partial<ConstructorParameters<typeof RemoteLlamaPolisher>[0]> & { launcher: ReturnType<typeof fake> }) {
  const polisher = new RemoteLlamaPolisher({ modelPath: async () => '/model.gguf', ...options });
  disposers.push(() => polisher.dispose());
  return polisher;
}

describe('the crash limiter', () => {
  it('allows three crashes in five minutes, then refuses until they age out', () => {
    let now = 0;
    const limiter = new CrashLimiter({ now: () => now });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.mayStart()).toBe(true);
      limiter.crashed();
    }
    expect(limiter.mayStart()).toBe(false);
    now = 5 * 60_000 + 1;
    expect(limiter.mayStart()).toBe(true);
  });
});

describe('the modes model in its own process', () => {
  it('answers from another process', async () => {
    const polisher = remote({ launcher: fake('ok') });
    const text = await polisher.generate('hello', 'en', PROMPT, 8, never);
    const [word, pid] = text.split('@');
    expect(word).toBe('HELLO');
    expect(Number(pid)).not.toBe(process.pid);
    expect(polisher.isLoaded).toBe(true);
  });

  it('a crash fails only the sentence in flight, and the next one starts a new process', async () => {
    const notes: string[] = [];
    const polisher = remote({ launcher: fake('crash-on-work', 'ok'), onNote: (note) => notes.push(note) });
    await expect(polisher.generate('first', 'en', PROMPT, 8, never)).rejects.toBeInstanceOf(EngineProcessExit);
    expect(polisher.isLoaded).toBe(false);
    expect(notes.join('\n')).toMatch(/stopped \(crashed\).*starts it again/u);
    expect(await polisher.generate('second', 'en', PROMPT, 8, never)).toMatch(/^SECOND@/u);
  });

  it('stays down after three crashes in the window, and says so', async () => {
    const polisher = remote({ launcher: fake('crash-on-work') });
    for (let i = 0; i < 3; i += 1) await expect(polisher.generate('x', 'en', PROMPT, 8, never)).rejects.toThrow();
    await expect(polisher.generate('x', 'en', PROMPT, 8, never)).rejects.toThrow(/crashed 3 times/u);
  });

  it('a host that cannot start at all hands the model to the in-process fallback', async () => {
    const calls: string[] = [];
    const inProcess: ModesModel = {
      id: 'local',
      supportedLanguages: new Set(['en']),
      isLoaded: false,
      generate: async (text) => {
        calls.push(text);
        return `local:${text}`;
      },
      unload: async () => undefined,
      dispose: async () => undefined,
    };
    const polisher = remote({ launcher: fake('never-hello'), fallback: () => inProcess });
    await expect(polisher.generate('a', 'en', PROMPT, 8, never)).rejects.toBeInstanceOf(EngineProcessExit);
    expect(await polisher.generate('b', 'en', PROMPT, 8, never)).toBe('local:b');
    expect(calls).toEqual(['b']);
  });

  it('no installed model is refused in main, without starting a process', async () => {
    let launched = 0;
    const polisher = new RemoteLlamaPolisher({
      launcher: (role) => {
        launched += 1;
        return fake('ok')(role);
      },
      modelPath: async () => null,
    });
    await expect(polisher.generate('x', 'en', PROMPT, 8, never)).rejects.toThrow(/no polish model/u);
    await polisher.prepare([PROMPT]);
    expect(launched).toBe(0);
  });

  it('an abort that lands while the model path is located never reaches the host as a generate', async () => {
    let launched = 0;
    const controller = new AbortController();
    const polisher = remote({
      launcher: (role) => {
        launched += 1;
        return fake('ok')(role);
      },
      modelPath: async () => {
        // The polish deadline passes while the bundle store is still answering.
        controller.abort();
        return '/model.gguf';
      },
    });
    await expect(polisher.generate('x', 'en', PROMPT, 8, controller.signal)).rejects.toThrow(/cancelled/u);
    expect(launched).toBe(0);
  });

  it('the real engine-host.js serves llama: hello, then the model’s own error for a missing file', async () => {
    const polisher = remote({ launcher: forkLauncher(HOST, { execArgv: TS }), modelPath: async () => '/nonexistent/Qwen3.gguf' });
    await expect(polisher.generate('x', 'en', PROMPT, 8, never)).rejects.toThrow(/nonexistent|ENOENT|no such file/iu);
    // The model failed, not the process: nothing was counted as a crash.
    await expect(polisher.generate('y', 'en', PROMPT, 8, never)).rejects.toThrow(/nonexistent|ENOENT|no such file/iu);
  }, 30_000);
});

describe('Parakeet in its own process', () => {
  it('carries 16 kHz samples across as a Float32Array', async () => {
    const runtime = await startParakeetProcess('/dir', { threads: 1 }, fake('ok'));
    disposers.push(() => runtime.dispose());
    const [kind, length, pid] = (await runtime.transcribeSamples(new Float32Array(16_000))).split(':');
    expect(kind).toBe('f32');
    expect(Number(length)).toBe(16_000);
    expect(Number(pid)).not.toBe(process.pid);
  });

  it('a host that never says hello is a start failure, not a crash', async () => {
    const error = await startParakeetProcess('/dir', { threads: 1 }, fake('never-hello')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineProcessExit);
    expect((error as EngineProcessExit).beforeReady).toBe(true);
  });

  it('the engine restarts a crashed process on the next dictation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kotiba-parakeet-proc-'));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const store = { locate: async () => root, isInstalled: async () => true } as unknown as BundleStore;
    // First process: warm-up transcription crashes it after load. Second: fine.
    const engine = new ParakeetEngine({
      store,
      threads: 1,
      autoDownload: false,
      idleUnloadMs: null,
      launcher: fake('crash-on-work', 'ok'),
    });
    disposers.push(() => engine.dispose());
    await engine.prepare();
    await expect(engine.decode(new Float32Array(16_000))).rejects.toThrow();
    await engine.prepare();
    expect(await engine.decode(new Float32Array(16_000))).toMatch(/^f32:16000:/u);
  });

  it('the real engine-host.js serves parakeet: a missing bundle is a load error, not a crash', async () => {
    const error = await startParakeetProcess('/nonexistent-bundle', { threads: 1 }, forkLauncher(HOST, { execArgv: TS })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EngineProcessExit);
  }, 30_000);

  // C4: the Arabic host, both decoders. A missing model is the model's own error, answered by a
  // process that is still up — not an exit, which the engine would count as a crash.
  for (const kind of ['cohere', 'fastConformer'] as const) {
    it(`the real engine-host.js serves arabic (${kind}): a missing model is a load error, not a crash`, async () => {
      const error = await startArabicProcess(
        { kind, directory: '/nonexistent-arabic-bundle', threads: 1, backend: 'cpu' },
        forkLauncher(HOST, { execArgv: TS }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EngineProcessExit);
    }, 30_000);
  }
});
