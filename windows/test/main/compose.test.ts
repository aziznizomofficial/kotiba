// THE TEST THAT WOULD HAVE FAILED ON THE SHIPPED BUILD.
//
// `src/platform/index.ts` went out as seven `() => notImplemented('platform')` stubs while
// `hotkey.ts`, `insert.ts`, `focus.ts`, `settings.ts`, `history.ts` and `diagnostics.ts`
// sat beside it, written and covered. Nothing caught it, because of exactly where the
// existing tests point:
//
//   * `test/platform/*.test.ts` imports `../../src/platform/hotkey.js` and its siblings
//     DIRECTLY. The barrel has no test of its own.
//   * `--check` never touches `src/platform` at all.
//   * The one caller was `src/main/index.ts`, which built each seam inside `attempt()` —
//     so seven `NotImplementedError`s became seven tidy blocker rows, `ready` came out
//     false, no `DictationController` was ever constructed, and the packaged app showed
//     the user seven problems and could not dictate. Green gate throughout.
//
// So this goes through the barrel, with the REAL `src/platform`, the REAL `src/engines`
// and the REAL `src/audio`, on a temp directory holding real model files. What is faked
// is what a Mac cannot have: the three helper `.exe`s (which nothing spawns during
// composition — the contract's rule that a constructor does no I/O is what makes that
// true, and the second test below is what holds it to it) and the hidden capture window,
// which is a `BrowserWindow` and therefore Electron's.
//
// The assertion is one line: `ready === true`, with an empty blocker list.

import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Blocker } from '../../src/contracts/index.js';
import { KNOWN_MODEL_FILES, MODEL_MINIMUM_BYTES } from '../../src/contracts/index.js';
import type { AudioHost, AudioHostReply } from '../../src/audio/index.js';
import * as audioModule from '../../src/audio/index.js';
import * as engineModule from '../../src/engines/index.js';
import * as polishModule from '../../src/polish/index.js';
import * as platform from '../../src/platform/index.js';
import { composePipeline, type CompositionPaths } from '../../src/main/compose.js';

/**
 * A model file the store will call ready: the four ggml magic bytes and a size over the
 * 8 MiB floor.
 *
 * `ftruncate` rather than a real 9 MB write — the store stats the size and reads four
 * bytes, and three genuine 500 MB models is not something a unit test gets to want.
 */
function writeModel(path: string): void {
  const fd = openSync(path, 'w');
  try {
    // GGML_MAGIC, little-endian: on disk literally 6c 6d 67 67.
    writeSync(fd, Buffer.from([0x6c, 0x6d, 0x67, 0x67]));
    ftruncateSync(fd, MODEL_MINIMUM_BYTES + 1024);
  } finally {
    closeSync(fd);
  }
}

let hostDisposed = 0;

/**
 * The hidden capture window, which on a Mac cannot exist. Answers every command.
 *
 * `dispose` is beyond `AudioHost` on purpose: `createWindowAudioHost` returns it too,
 * because the host owns two `ipcMain` listeners and the capture module — which was handed
 * the host and did not make it — has no business tearing them down.
 */
function fakeAudioHost(): AudioHost & { dispose(): void } {
  return {
    dispose(): void {
      hostDisposed += 1;
    },
    async send(command): Promise<AudioHostReply> {
      if (command.kind === 'warmUp') {
        return { kind: 'warmedUp', sampleRate: 16_000, deviceLabel: 'a fake microphone' };
      }
      if (command.kind === 'stop') {
        return { kind: 'stopped', segment: command.segment, totalSamples: 0, droppedSamples: 0 };
      }
      return { kind: 'ok' };
    },
    onEvent() {
      return () => {
        /* nothing subscribes in this test */
      };
    },
  };
}

let root: string;
let paths: CompositionPaths;
let blockers: Blocker[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kotiba-compose-'));
  const models = join(root, 'models');
  const native = join(root, 'native');
  mkdirSync(models, { recursive: true });
  mkdirSync(native, { recursive: true });

  // A machine with models. The names are `KNOWN_MODEL_FILES`', so the store's
  // auto-discovery finds them with no path in the settings — which is what a fresh
  // install looks like.
  writeModel(join(models, KNOWN_MODEL_FILES.uzbek[0]));
  writeModel(join(models, KNOWN_MODEL_FILES.russian[0]));
  writeModel(join(models, KNOWN_MODEL_FILES.detector[0]));

  blockers = [];
  paths = {
    supportDirectory: root,
    historyPath: join(root, 'history.jsonl'),
    diagnosticsPath: join(root, 'diagnostics.jsonl'),
    modelsDirectory: models,
    bundledDirectory: models,
    // The three helpers. Nothing spawns them here; see the second test.
    sttHelperPath: join(native, 'kotiba-stt.exe'),
    hookHelperPath: join(native, 'kotiba-hook.exe'),
    inputHelperPath: join(native, 'kotiba-input.exe'),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function compose(overrides: Partial<Parameters<typeof composePipeline>[0]> = {}) {
  return composePipeline({
    platform,
    engines: engineModule,
    audio: audioModule,
    paths,
    appVersion: '0.2.0',
    createAudioHost: fakeAudioHost,
    onNote: () => {
      /* prose, not asserted on */
    },
    record: (blocker) => blockers.push(blocker),
    cpuCount: 8,
    ...overrides,
  });
}

describe('the composition root, against the real platform module', () => {
  it('builds every seam and is ready, with nothing blocking', async () => {
    const pipeline = await compose();

    // THE ASSERTION. On the shipped build this was `false`, with seven rows behind it.
    expect(blockers).toEqual([]);
    expect(pipeline.ready).toBe(true);
    expect(pipeline.complete).not.toBeNull();

    await pipeline.dispose();
  });

  it('produces a real object for each of the seven platform factories', async () => {
    const pipeline = await compose();

    // Named individually rather than only through `ready`, so a failure says WHICH seam
    // went missing instead of just that one did.
    expect(pipeline.settingsStore).not.toBeNull();
    expect(pipeline.secrets).not.toBeNull();
    expect(pipeline.history).not.toBeNull();
    expect(pipeline.diagnostics).not.toBeNull();
    expect(pipeline.hotkey).not.toBeNull();
    expect(pipeline.inserter).not.toBeNull();
    expect(pipeline.focus).not.toBeNull();
    // And the two that are not `src/platform`'s but failed for their own reasons: the
    // microphone had no host to talk to, and the engine manager had no cpu count.
    expect(pipeline.audio).not.toBeNull();
    expect(pipeline.engines).not.toBeNull();

    await pipeline.dispose();
  });

  it('reports the languages the models on disk can actually produce', async () => {
    const pipeline = await compose();

    const readiness = await pipeline.engines?.readiness();
    // Uzbek from `uzbek_stt_v1`; English and Russian both from `large-v3-turbo` (D-W2 —
    // English ships on the Russian model because there is no `SpeechTranscriber` here).
    expect([...(readiness?.availableLanguages ?? [])].sort()).toEqual(['en', 'ru', 'uz']);

    await pipeline.dispose();
  });

  it('spawns no helper while composing — a constructor that fails has nowhere to fail to', async () => {
    // The helper paths point at files that do not exist. If any factory spawned in its
    // constructor, composition would record a blocker on this machine.
    const pipeline = await compose();

    expect(blockers).toEqual([]);
    expect(pipeline.ready).toBe(true);

    await pipeline.dispose();
  });

  it('has teeth: a stubbed platform module is not ready and says why', async () => {
    // What `src/platform/index.ts` actually shipped as. If someone puts the stubs back,
    // the first test in this file fails — this one proves that is a real signal and not
    // an assertion that passes on anything.
    const notImplemented = (): never => {
      throw new Error('platform is not implemented');
    };
    const stubbed = {
      createSettingsStore: notImplemented,
      createSecretStore: notImplemented,
      createHistoryStore: notImplemented,
      createDiagnosticsSink: notImplemented,
      createInputHelper: notImplemented,
      createWindowsHotkeySource: notImplemented,
      createWindowsInserter: notImplemented,
      createWindowsFocusSource: notImplemented,
      createDucker: notImplemented,
      helperDuckingBackend: notImplemented,
      fileMarkerStore: notImplemented,
    } as unknown as typeof platform;

    const pipeline = await compose({ platform: stubbed });

    expect(pipeline.ready).toBe(false);
    expect(pipeline.complete).toBeNull();
    // Unique ids: the shell's own `record` keeps the first row per id, and several seams
    // legitimately share one — the inserter, the focus source and the hook are all
    // 'hotkey' because to a user they are one thing, "the keys do not work".
    expect([...new Set(blockers.map((blocker) => blocker.id))].sort()).toEqual([
      'diagnostics-store',
      'history-store',
      'hotkey',
      'settings',
    ]);
    // Every row carries the sentence rather than only a headline: `attempt` appends the
    // thrown message, which is the difference between "Settings could not be opened" and
    // knowing that the whole module is a stub.
    for (const blocker of blockers) expect(blocker.detail).toContain('platform is not implemented');

    await pipeline.dispose();
  });

  it('tears the capture bridge down with the composition, not with the capture module', async () => {
    // The host registers two permanent `ipcMain` listeners and the capture module was
    // HANDED it — it did not make it, so it does not unmake it. Whoever built it does.
    hostDisposed = 0;
    const pipeline = await compose();
    expect(hostDisposed).toBe(0);

    await pipeline.dispose();
    expect(hostDisposed).toBe(1);
    // Idempotent: a second quit path must not double-dispose.
    await pipeline.dispose();
    expect(hostDisposed).toBe(1);
  });

  it('shares one kotiba-input.exe between the inserter and the focus source', async () => {
    // Two helpers means two child processes, two restarts to supervise, and two chances
    // for the foreground read to disagree with the paste about which window is in front.
    const created: string[] = [];
    const counting = {
      ...platform,
      createInputHelper: (options: Parameters<typeof platform.createInputHelper>[0]) => {
        created.push(options.helperPath);
        return platform.createInputHelper(options);
      },
    } as unknown as typeof platform;

    const pipeline = await compose({ platform: counting });

    // Two constructions and no more: the one the inserter and the focus source SHARE,
    // and the ducker's own, which must not queue a volume ramp behind a paste.
    expect(created).toEqual([paths.inputHelperPath, paths.inputHelperPath]);
    expect(pipeline.ready).toBe(true);
    expect(pipeline.ducker.decision).toBe('none');

    await pipeline.dispose();
  });

  it('puts Parakeet at the head of the unified family, and builds the modes model', async () => {
    // "Written, tested, called from nowhere" is this repo's commonest defect. Parakeet and
    // the modes' model are built HERE and nowhere else; this asserts they come out wired.
    const pipeline = await compose({
      onDevice: {
        ParakeetEngine: engineModule.ParakeetEngine,
        createBundleStore: engineModule.createBundleStore,
        resolveOrtThreads: engineModule.resolveOrtThreads,
        LlamaPolisher: polishModule.LlamaPolisher,
        resolveLlamaThreads: polishModule.resolveLlamaThreads,
      },
      // A test must never start a 668 MB download.
      autoDownload: false,
    });
    expect(blockers).toEqual([]);
    expect(pipeline.onDevice?.parakeet).not.toBeNull();
    expect(pipeline.onDevice?.llama.id).toBe('qwen3-1.7b');

    await pipeline.engines?.prepare({ eagerly: false, language: 'en' });
    const unified = pipeline.engines?.engineFor('unified');
    expect(unified?.engineId).toBe('unified(parakeet-ultra, whisper-ggml-large-v3-turbo-q5_0)');
    // C2: the Uzbek family streams — Silero-cut segments decoded while the key is held.
    const { isStreamingEngine } = await import('../../src/contracts/index.js');
    expect(isStreamingEngine(pipeline.engines?.engineFor('uzbek'))).toBe(true);
    // Not downloaded here, so English and Russian still come from the bundled whisper.
    expect([...((await pipeline.engines?.readiness())?.availableLanguages ?? [])].sort()).toEqual(['en', 'ru', 'uz']);

    await pipeline.dispose();
  });

  it('C4: puts the Arabic engine at the head of the Arabic family; Turkish streams on turbo', async () => {
    const pipeline = await compose({
      onDevice: {
        ParakeetEngine: engineModule.ParakeetEngine,
        ArabicEngine: engineModule.ArabicEngine,
        createBundleStore: engineModule.createBundleStore,
        resolveOrtThreads: engineModule.resolveOrtThreads,
        LlamaPolisher: polishModule.LlamaPolisher,
        resolveLlamaThreads: polishModule.resolveLlamaThreads,
      },
      // Never a 1.77 GB download from a test: `arabic` is absent, so its autoDownload is off.
      autoDownload: false,
    });
    expect(blockers).toEqual([]);
    expect(pipeline.onDevice?.arabic).not.toBeNull();
    await pipeline.engines?.prepare({ eagerly: false, language: 'en' });
    expect(pipeline.engines?.engineFor('arabic')?.engineId).toBe(
      'arabic(cohere-transcribe-arabic-07-2026-q5_k_m, whisper-ggml-large-v3-turbo-q5_0-ar)',
    );
    const { isStreamingEngine } = await import('../../src/contracts/index.js');
    expect(isStreamingEngine(pipeline.engines?.engineFor('turkish'))).toBe(true);
    expect(isStreamingEngine(pipeline.engines?.engineFor('arabic'))).toBe(true);
    // Both off by default: not available, so not pinnable and never routed to.
    const readiness = await pipeline.engines?.readiness();
    expect(readiness?.availableLanguages.has('tr')).toBe(false);
    expect(readiness?.availableLanguages.has('ar')).toBe(false);
    await pipeline.dispose();
  });

  it('without the on-device module, Uzbek is batch exactly as before', async () => {
    const pipeline = await compose();
    await pipeline.engines?.prepare({ eagerly: false, language: 'uz' });
    const { isStreamingEngine } = await import('../../src/contracts/index.js');
    expect(isStreamingEngine(pipeline.engines?.engineFor('uzbek'))).toBe(false);
    await pipeline.dispose();
  });

  it('the app root passes the on-device engines and the on-device polish chain', async () => {
    // `src/main/index.ts` needs Electron and cannot be built in a test, so its wiring is
    // held by its text: the two calls that make Parakeet and Qwen reachable at all.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8');
    expect(source).toMatch(/onDevice: \{\s*ParakeetEngine: engineModule\.ParakeetEngine/u);
    // C4: the Arabic engine, and what the app tells it (consent, choice, GPU, verdict, clip).
    expect(source).toContain('ArabicEngine: engineModule.ArabicEngine');
    expect(source).toContain('autoDownload: () => arabicMayDownload(state.settings)');
    expect(source).toContain('speedChecks: speedCheckFileStore(');
    expect(source).toContain('createPolishChain: polishModule.createOnDevicePolishChain(');
    expect(source).toContain('cleanUp: modesCore.cleanUp');
    // D-W22: the engines run in utility processes in the app, not in its main process.
    expect(source).toContain('engineLauncher: utilityLauncher()');
    expect(source).toContain('RemoteLlamaPolisher: polishModule.RemoteLlamaPolisher');
  });

  it('with a launcher, the modes model lives in another process and Parakeet gets the launcher', async () => {
    const launched: string[] = [];
    const { forkLauncher } = await import('../../src/engines/engine-process.js');
    const pipeline = await compose({
      onDevice: {
        ParakeetEngine: engineModule.ParakeetEngine,
        createBundleStore: engineModule.createBundleStore,
        resolveOrtThreads: engineModule.resolveOrtThreads,
        LlamaPolisher: polishModule.LlamaPolisher,
        resolveLlamaThreads: polishModule.resolveLlamaThreads,
        RemoteLlamaPolisher: polishModule.RemoteLlamaPolisher,
      },
      autoDownload: false,
      engineLauncher: (role) => {
        launched.push(role);
        return forkLauncher(join(__dirname, '../engines/fake-engine-host.mjs'))(role);
      },
    });
    expect(pipeline.onDevice?.llama).toBeInstanceOf(polishModule.RemoteLlamaPolisher);
    // Nothing is started until something needs it — and no model is installed here.
    await pipeline.onDevice?.llama.prepare?.([]);
    expect(launched).toEqual([]);
    await pipeline.dispose();
  });
});
