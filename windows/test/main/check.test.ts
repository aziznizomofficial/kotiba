// `--check`, and specifically the bug it exists to not repeat.
//
// D-W10: it must distinguish "models not installed" from "model file corrupt" using the
// `ModelStatus` value, never a message match. The `ai-balance/windows` precedent failed a
// HEALTHY build because a regex over an error sentence missed. So the load-bearing test
// here is the pair: two runs whose prose OVERLAPS and whose exit codes DIFFER.

import { describe, expect, it } from 'vitest';

import type {
  AudioBuffer,
  EngineManager,
  Language,
  LanguageRouter,
  ModelId,
  ModelStatus,
  ModelStore,
  RouteDecision,
  SttEngine,
  TranscriptResult,
} from '../../src/contracts/index.js';
import { EngineFailure, engineError } from '../../src/contracts/index.js';
import { createCapitaliser, deliver } from '../../src/core/text/index.js';
import type { CheckEnvironment } from '../../src/main/check.js';
import {
  checkExitCode,
  formatCheckHuman,
  formatCheckJson,
  listWavFiles,
  notDownloaded,
  runCheck,
} from '../../src/main/check.js';

// ---------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------

function fakeStore(statuses: Partial<Record<ModelId, ModelStatus>>): ModelStore {
  return {
    async inspect(path) {
      return { status: 'ready', path, bytes: 1, reason: null };
    },
    async resolve() {
      return null;
    },
    async ensure(id) {
      return String(id);
    },
    async status(id) {
      return statuses[id] ?? 'notInstalled';
    },
    notes: [],
  };
}

function buffer(seconds: number): AudioBuffer {
  return { samples: new Float32Array(16_000 * seconds), droppedSamples: 0 };
}

function fakeEngine(options: {
  readonly text?: string;
  readonly throws?: EngineFailure;
  readonly readyFirstAsk?: boolean;
}): SttEngine {
  let ready = options.readyFirstAsk ?? false;
  return {
    engineId: 'fake-engine',
    supportedLanguages: new Set<Language>(['en', 'ru', 'uz']),
    async isReady() {
      return ready;
    },
    async prepare() {
      ready = true;
    },
    async transcribe(): Promise<TranscriptResult> {
      if (options.throws !== undefined) throw options.throws;
      return { raw: options.text ?? 'hello', language: 'en', engineId: 'fake-engine' };
    },
    async dispose() {
      /* nothing to stop */
    },
  };
}

function fakeManager(engine: SttEngine | null): EngineManager & { disposed: boolean } {
  const manager = {
    disposed: false,
    engineFor: () => engine,
    detector: () => null,
    async prepare() {
      /* nothing */
    },
    async reconfigure() {
      /* nothing */
    },
    async readiness() {
      return {
        uzbek: 'ready' as ModelStatus,
        unified: 'ready' as ModelStatus,
        detector: 'ready' as ModelStatus,
        turkish: 'ready' as ModelStatus,
        arabic: 'ready' as ModelStatus,
        availableLanguages: new Set<Language>(['en']),
      };
    },
    async dispose() {
      manager.disposed = true;
    },
  };
  return manager;
}

const ROUTE: RouteDecision = {
  language: 'en',
  source: 'fallback',
  turkicMass: null,
} as RouteDecision;

function environment(overrides: Partial<CheckEnvironment>): CheckEnvironment {
  let clock = 0;
  const router: LanguageRouter = { async route() { return ROUTE; } };
  return {
    models: fakeStore({}),
    // THE REAL DELIVERY PIPELINE, not a stand-in. `deliver` and `createCapitaliser` are
    // the same two functions `src/main/index.ts` binds into `SessionPorts.text`, so a
    // test that passes here is a statement about the code the app runs. A fake that
    // returned its input would make every delivered-text assertion below vacuous.
    capitalisesOnDelivery: true,
    deliver: (text, language) =>
      deliver({ text, language, replacements: [], capitaliser: createCapitaliser([]) }),
    async listFixtures() {
      return [];
    },
    async readWav() {
      return buffer(2);
    },
    async makeEngines() {
      return fakeManager(fakeEngine({}));
    },
    makeRouter: () => router,
    now: () => (clock += 5),
    timestamp: () => '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

const OPTIONS = { fixturePath: '/fixtures/audio', modelsDirectory: '/models' };

// ---------------------------------------------------------------------------------

describe('--check tells "not installed" apart from "corrupt"', () => {
  it('exits 0 on a runner where nothing is installed', async () => {
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({ models: fakeStore({}) }),
    });

    expect(report.ok).toBe(true);
    expect(checkExitCode(report)).toBe(0);
    expect(report.skipped).toBe('modelsNotInstalled');
    expect(report.modelsInstalled).toBe(false);
    expect(report.failures).toEqual([]);
    expect(report.models.uzbek_stt_v1).toBe('notInstalled');
  });

  it('exits 1 when a bundled model is present and unusable', async () => {
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore({
          uzbek_stt_v1: 'corrupt',
          large_v3_turbo: 'notInstalled',
          base_detector: 'notInstalled',
        }),
      }),
    });

    expect(report.ok).toBe(false);
    expect(checkExitCode(report)).toBe(1);
    expect(report.models.uzbek_stt_v1).toBe('corrupt');
  });

  it('THE REGRESSION: the two verdicts differ even though the prose overlaps', async () => {
    // Both reports say "uzbek_stt_v1" and both mention models. A regex over the text
    // cannot separate them, which is precisely how `ai-balance/windows` failed a healthy
    // build. The ENUM separates them, and nothing else is consulted.
    const healthy = await runCheck({
      ...OPTIONS,
      environment: environment({ models: fakeStore({}) }),
    });
    const broken = await runCheck({
      ...OPTIONS,
      environment: environment({ models: fakeStore({ uzbek_stt_v1: 'corrupt' }) }),
    });

    const healthyText = formatCheckHuman(healthy);
    const brokenText = formatCheckHuman(broken);
    expect(healthyText).toContain('uzbek_stt_v1');
    expect(brokenText).toContain('uzbek_stt_v1');

    expect(checkExitCode(healthy)).toBe(0);
    expect(checkExitCode(broken)).toBe(1);
    // And the ONLY thing that moved is the enum.
    expect(healthy.models.uzbek_stt_v1).toBe('notInstalled');
    expect(broken.models.uzbek_stt_v1).toBe('corrupt');
  });

  it('says in full that a skipped run is not a failure', async () => {
    const report = await runCheck({ ...OPTIONS, environment: environment({}) });
    const text = formatCheckHuman(report);
    expect(text).toContain('is not a failure');
    expect(text.startsWith('kotiba --check: ok')).toBe(true);
  });
});

describe('--check runs the pipeline when the models are there', () => {
  const READY = {
    uzbek_stt_v1: 'ready',
    large_v3_turbo: 'ready',
    base_detector: 'ready',
  } as const;

  it('transcribes every fixture and reports each one', async () => {
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        listFixtures: async () => ['a.wav', 'b.wav'],
        makeEngines: async () => fakeManager(fakeEngine({ text: 'salom dunyo' })),
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.skipped).toBeNull();
    expect(report.fixtures.map((f) => f.fixture)).toEqual(['a.wav', 'b.wav']);
    expect(report.fixtures.every((f) => f.transcript === 'salom dunyo')).toBe(true);
    // The contract's single-valued fields report the first fixture.
    expect(report.transcript).toBe('salom dunyo');
    expect(report.route).toEqual(ROUTE);
  });

  it('prepares a cold engine and re-asks rather than refusing on isReady() === false', async () => {
    // The shipped macOS bug: `isReady()` used as a GATE. A lazily-loaded engine is
    // legitimately not ready before first use.
    const engine = fakeEngine({ text: 'ok', readyFirstAsk: false });
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        listFixtures: async () => ['a.wav'],
        makeEngines: async () => fakeManager(engine),
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.fixtures[0]?.transcript).toBe('ok');
  });

  it('carries the typed error kind, not just the sentence', async () => {
    const failure = new EngineFailure(engineError.modelCorrupt('C:\\models\\uz.bin', 'truncated'));
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        listFixtures: async () => ['a.wav'],
        makeEngines: async () => fakeManager(fakeEngine({ throws: failure })),
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.fixtures[0]?.errorKind).toBe('modelCorrupt');
    expect(checkExitCode(report)).toBe(1);
  });

  it('fails when every fixture transcribes to nothing', async () => {
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        listFixtures: async () => ['a.wav', 'b.wav'],
        makeEngines: async () => fakeManager(fakeEngine({ text: '   ' })),
      }),
    });

    // Reported PER FIXTURE now, rather than only as one corpus-wide sentence at the end:
    // audio loud enough to clear the silence gate that comes back empty is that clip's
    // own failure, and naming the clip is what makes it actionable. The corpus-wide
    // message still exists for the case no per-fixture error can catch — every clip
    // legitimately below the silence threshold — and is asserted separately.
    expect(report.ok).toBe(false);
    expect(report.fixtures.every((f) => f.errorKind === 'emptyTranscript')).toBe(true);
    expect(report.failures).toHaveLength(2);
    expect(checkExitCode(report)).toBe(1);
  });

  it('fails when the models are installed but the corpus is missing', async () => {
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({ models: fakeStore(READY), listFixtures: async () => [] }),
    });

    expect(report.ok).toBe(false);
    expect(report.skipped).toBe('noFixtures');
  });

  it('stops the STT host even when a fixture throws', async () => {
    const manager = fakeManager(
      fakeEngine({ throws: new EngineFailure(engineError.hostUnavailable('it died')) }),
    );
    await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        listFixtures: async () => ['a.wav'],
        makeEngines: async () => manager,
      }),
    });

    // A `--check` that leaves a child process behind is a CI job that never ends.
    expect(manager.disposed).toBe(true);
  });
});

describe('the report itself', () => {
  it('is one JSON object with a stable key order', async () => {
    const report = await runCheck({ ...OPTIONS, environment: environment({}) });
    const json = formatCheckJson(report);
    const parsed: unknown = JSON.parse(json);
    expect(Object.keys(parsed as object)).toEqual([
      'ok',
      'startedAt',
      'durationMillis',
      'modelsInstalled',
      'skipped',
      'models',
      'bundledModelIds',
      'fixtures',
      'failures',
      'notes',
    ]);
  });

  it('carries the paths the resolvers probed, even on a run that worked', async () => {
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore({ uzbek_stt_v1: 'ready', large_v3_turbo: 'ready', base_detector: 'ready' }),
        async listFixtures() {
          return ['english-pangram.wav'];
        },
        notes: () => ['bundled models directory: found at C:/app/resources/models'],
      }),
    });
    // Reported on SUCCESS. A path table nobody has seen working is a table nobody can
    // read when it stops working.
    expect(report.ok).toBe(true);
    expect(report.notes).toContain('bundled models directory: found at C:/app/resources/models');
    expect(formatCheckHuman(report)).toContain('C:/app/resources/models');
  });

  it('covers every catalogue model, not only the bundled three', async () => {
    const report = await runCheck({ ...OPTIONS, environment: environment({}) });
    expect(Object.keys(report.models).sort()).toEqual([
      'base_detector',
      'large_v3_turbo',
      'small_en',
      'uzbek_stt_v1',
    ]);
    expect(report.bundledModelIds).not.toContain('small_en');
  });
});

// ---------------------------------------------------------------------------------
// The bug this file exists to not repeat a second time
// ---------------------------------------------------------------------------------
//
// Run 32240326275 packaged a 1.186 GB installer, verified all three models were inside
// it by name and exact byte size, reported them `ready` — and then failed every fixture
// with `noEngineInstalled` in 2 ms, routing `source: "fallback"`, `turkicMass: null`.
//
// The cause was not a path. `engineFor()` and `detector()` read a map that only
// `prepare()`/`reconfigure()` ever fills, and `--check` asked before either had run. The
// manager was EMPTY, and an empty manager answers exactly like a machine that owns no
// models — which is why the report looked like a routing result rather than a step that
// never happened.

describe('--check builds the engines before it asks for one', () => {
  const READY = {
    uzbek_stt_v1: 'ready' as ModelStatus,
    large_v3_turbo: 'ready' as ModelStatus,
    base_detector: 'ready' as ModelStatus,
  };

  it('THE REGRESSION: calls prepare({eagerly}) before the first engineFor', async () => {
    const order: string[] = [];
    const engine = fakeEngine({ text: 'the quick brown fox' });
    const manager: EngineManager = {
      engineFor() {
        order.push('engineFor');
        // An unprepared manager has nothing to hand back. This is the shipped bug,
        // reproduced exactly: the map is empty until `prepare` fills it.
        return order.includes('prepare') ? engine : null;
      },
      detector: () => null,
      async prepare(options) {
        order.push('prepare');
        expect(options.eagerly).toBe(true);
      },
      async reconfigure() {
        /* nothing */
      },
      async readiness() {
        return {
          uzbek: 'ready' as ModelStatus,
          unified: 'ready' as ModelStatus,
          detector: 'ready' as ModelStatus,
          turkish: 'ready' as ModelStatus,
          arabic: 'ready' as ModelStatus,
          availableLanguages: new Set<Language>(['en']),
        };
      },
      async dispose() {
        /* nothing */
      },
    };

    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        async listFixtures() {
          return ['english-pangram.wav'];
        },
        async makeEngines() {
          return manager;
        },
      }),
    });

    expect(order[0]).toBe('prepare');
    expect(report.fixtures[0]?.transcript).toBe('the quick brown fox');
    expect(report.fixtures[0]?.errorKind).toBeNull();
    expect(checkExitCode(report)).toBe(0);
  });

  it('still reports a fixture-level failure when prepare itself throws', async () => {
    // A throwing preload must not replace the whole report with one sentence: every
    // fixture still runs and each carries its own typed error.
    const manager = fakeManager(null);
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        async listFixtures() {
          return ['english-pangram.wav'];
        },
        async makeEngines() {
          return {
            ...manager,
            async prepare() {
              throw new EngineFailure(engineError.notReady('the host would not start'));
            },
          };
        },
      }),
    });

    expect(report.fixtures).toHaveLength(1);
    expect(report.fixtures[0]?.errorKind).toBe('noEngineInstalled');
    expect(checkExitCode(report)).toBe(1);
  });
});

describe('a fresh install is not a broken one (D-W25: turbo left the installer)', () => {
  it('needs only Uzbek and the detector to count as installed', async () => {
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore({ uzbek_stt_v1: 'ready', large_v3_turbo: 'notInstalled', base_detector: 'ready' }),
        async listFixtures() {
          return ['english-pangram.wav'];
        },
        async makeEngines() {
          const manager = fakeManager(fakeEngine({ text: 'never asked', readyFirstAsk: true }));
          return {
            ...manager,
            async readiness() {
              return { ...(await manager.readiness()), unified: 'notInstalled' as ModelStatus };
            },
          };
        },
      }),
    });
    expect(report.modelsInstalled).toBe(true);
    // English before Parakeet lands: reported, not run, and not a failure.
    expect(report.fixtures[0]?.outcome).toBe('notDownloaded');
    expect(report.fixtures[0]?.error).toBeNull();
    expect(report.failures).toEqual([]);
    expect(checkExitCode(report)).toBe(0);
    expect(formatCheckHuman(report)).toContain('not run: the en model is a download this PC has not made yet');
  });

  it('only notInstalled is "not downloaded" — a corrupt model still fails', () => {
    const base = {
      uzbek: 'ready',
      unified: 'notInstalled',
      detector: 'ready',
      turkish: 'notInstalled',
      arabic: 'corrupt',
      availableLanguages: new Set<Language>(['uz']),
    } as const;
    expect(notDownloaded('en', base)).toBe(true);
    expect(notDownloaded('ru', base)).toBe(true);
    expect(notDownloaded('tr', base)).toBe(true);
    expect(notDownloaded('ar', base)).toBe(false);
    expect(notDownloaded('uz', base)).toBe(false);
    expect(notDownloaded('en', null)).toBe(false);
  });
});

describe('silence is heard-nothing, not an empty transcript (02-BEHAVIOUR §6.4)', () => {
  const READY = {
    uzbek_stt_v1: 'ready' as ModelStatus,
    large_v3_turbo: 'ready' as ModelStatus,
    base_detector: 'ready' as ModelStatus,
  };

  it('reports the quiet clip as heardNothing with no error and no engine run', async () => {
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        async listFixtures() {
          return ['english-pangram.wav', 'silence-room-tone.wav'];
        },
        async makeEngines() {
          return fakeManager(fakeEngine({ text: 'the quick brown fox', readyFirstAsk: true }));
        },
        isNearSilence: () => true,
      }),
    });

    const quiet = report.fixtures.find((f) => f.fixture === 'silence-room-tone.wav');
    expect(quiet?.outcome).toBe('heardNothing');
    // NOT an empty string, and NOT an error — the distinction is the whole point.
    expect(quiet?.transcript).toBeNull();
    expect(quiet?.error).toBeNull();
    expect(quiet?.engineId).toBeNull();
    expect(formatCheckHuman(report)).toContain('heard nothing');
  });

  it('a LOUD clip that transcribes to nothing is a failure, not heard-nothing', async () => {
    // The second gate. Silence excuses an empty transcript; loud audio does not, and
    // conflating the two is what let an empty paste ship as a successful dictation.
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        async listFixtures() {
          return ['english-pangram.wav'];
        },
        async makeEngines() {
          return fakeManager(fakeEngine({ text: '   ', readyFirstAsk: true }));
        },
        isNearSilence: () => false,
      }),
    });

    expect(report.fixtures[0]?.outcome).toBe('failed');
    expect(report.fixtures[0]?.errorKind).toBe('emptyTranscript');
    expect(checkExitCode(report)).toBe(1);
  });

  it('a corpus of nothing but silence still fails — one quiet clip is not a pipeline', async () => {
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        async listFixtures() {
          return ['silence-room-tone.wav'];
        },
        isNearSilence: () => true,
      }),
    });
    expect(report.failures.join(' ')).toContain('no words');
    expect(checkExitCode(report)).toBe(1);
  });
});

describe('--check exits non-zero whenever it reports a failure', () => {
  it('THE RULE: a non-empty failures array is never exit 0', async () => {
    // Asserted over the exact states that produce failures, because "--check failed
    // (exit 0)" is the one outcome that makes the whole command worthless: it is not a
    // check that missed something, it is a check that reported success.
    const corrupt = await runCheck({
      ...OPTIONS,
      environment: environment({ models: fakeStore({ uzbek_stt_v1: 'corrupt' }) }),
    });
    const noCorpus = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore({
          uzbek_stt_v1: 'ready',
          large_v3_turbo: 'ready',
          base_detector: 'ready',
        }),
      }),
    });

    for (const report of [corrupt, noCorpus]) {
      expect(report.failures.length).toBeGreaterThan(0);
      expect(checkExitCode(report)).not.toBe(0);
    }
  });

  it('exits 0 for the CI runner state, which reports no failures at all', async () => {
    const report = await runCheck({ ...OPTIONS, environment: environment({}) });
    expect(report.skipped).toBe('modelsNotInstalled');
    expect(report.failures).toEqual([]);
    expect(checkExitCode(report)).toBe(0);
  });
});

describe('listWavFiles', () => {
  it('treats a missing directory as empty rather than throwing', async () => {
    expect(await listWavFiles('/definitely/not/here')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------
// The delivered text — the step `--check` used to stop one short of
// ---------------------------------------------------------------------------------
//
// Run 32247823051 was fully green and its smoke test printed, for the Uzbek fixture:
//
//     uzbek-0001.wav  uz via acoustic  "bu minusi o'zgacha bo'ladi."
//
// Those are ASCII apostrophes and the row was CORRECT — the report showed
// `TranscriptResult.raw`, the engine's verbatim output, before the delivery normaliser.
// Nothing in CI then looked at what the user's document would actually receive, so the
// single most Uzbek-specific behaviour in the product was unverified end to end: the
// 1320 golden rows prove `normaliseForDelivery` is right AS A FUNCTION, and cannot prove
// the shipped binary calls it.

describe('--check reports and asserts the DELIVERED text, not only the raw', () => {
  const READY = {
    uzbek_stt_v1: 'ready' as ModelStatus,
    large_v3_turbo: 'ready' as ModelStatus,
    base_detector: 'ready' as ModelStatus,
  };

  const UZ_ROUTE: RouteDecision = {
    language: 'uz',
    source: 'acoustic',
    turkicMass: 0.9,
  } as RouteDecision;

  const uzbekRouter: LanguageRouter = {
    async route() {
      return UZ_ROUTE;
    },
  };

  /** One Uzbek fixture, routed to `uz`, with whatever the engine "emitted" as `raw`. */
  async function uzbekRun(options: {
    readonly raw: string;
    readonly fixture?: string;
    readonly deliver?: (text: string, language: Language) => string;
    readonly capitalisesOnDelivery?: boolean;
  }) {
    const overrides: Partial<CheckEnvironment> = {
      models: fakeStore(READY),
      listFixtures: async () => [options.fixture ?? 'uzbek-0001.wav'],
      makeEngines: async () => fakeManager(fakeEngine({ text: options.raw })),
      makeRouter: () => uzbekRouter,
      ...(options.deliver === undefined ? {} : { deliver: options.deliver }),
      ...(options.capitalisesOnDelivery === undefined
        ? {}
        : { capitalisesOnDelivery: options.capitalisesOnDelivery }),
    };
    return runCheck({ ...OPTIONS, environment: environment(overrides) });
  }

  it('keeps raw verbatim and adds the delivered text beside it', async () => {
    const report = await uzbekRun({ raw: "bu minusi o'zgacha bo'ladi." });
    const fixture = report.fixtures[0];

    // `transcript` is unchanged in name and in meaning: the engine's own output, ASCII
    // apostrophes and all. Losing it would remove the only view of what the model said.
    expect(fixture?.transcript).toBe("bu minusi o'zgacha bo'ladi.");
    // And the new field is what the user's document would receive.
    expect(fixture?.delivered).toBe('Bu minusi oʻzgacha boʻladi.');
    expect(report.ok).toBe(true);
  });

  it('prints both stages in the human table', async () => {
    const report = await uzbekRun({ raw: "bu minusi o'zgacha bo'ladi." });
    const text = formatCheckHuman(report);

    // A person reading CI must be able to SEE the difference — the whole point of the
    // exercise is that the two lines do not match for Uzbek.
    expect(text).toContain('raw "bu minusi o\'zgacha bo\'ladi."');
    expect(text).toContain('delivered "Bu minusi oʻzgacha boʻladi."');
  });

  it('THE REGRESSION: an ASCII apostrophe in delivered Uzbek fails with its own kind', async () => {
    // A binary that never reaches the delivery normaliser — exactly what `--check` could
    // not detect before — is modelled by a `deliver` that hands the text straight back.
    const report = await uzbekRun({
      raw: "bu minusi o'zgacha bo'ladi.",
      deliver: (text) => text,
    });

    expect(report.ok).toBe(false);
    expect(report.fixtures[0]?.errorKind).toBe('uzbekApostropheDelivered');
    expect(checkExitCode(report)).toBe(1);
  });

  it('fails a right single quote too, not only U+0027', async () => {
    const report = await uzbekRun({
      raw: 'bu minusi o’zgacha bo’ladi.',
      deliver: (text) => text,
    });
    expect(report.fixtures[0]?.errorKind).toBe('uzbekApostropheDelivered');
  });

  it('fails when the delivered Uzbek carries neither okina nor tutuq belgisi', async () => {
    // The no-op normaliser. It emits no FORBIDDEN glyph either, so the rule above passes
    // it — and `uzbek-0001.wav` is a committed clip known to contain both marks, which is
    // why the fixture is named. Without this a normaliser that did nothing would be green.
    const report = await uzbekRun({ raw: 'salom dunyo' });

    expect(report.ok).toBe(false);
    expect(report.fixtures[0]?.errorKind).toBe('uzbekMarksMissing');
    expect(checkExitCode(report)).toBe(1);
  });

  it('does not demand the marks from a fixture that is not known to contain them', async () => {
    const report = await uzbekRun({ raw: 'salom dunyo', fixture: 'uzbek-other.wav' });
    expect(report.ok).toBe(true);
    expect(report.fixtures[0]?.delivered).toBe('Salom dunyo');
  });

  it('fails when the capitaliser did not run and the mode says it should have', async () => {
    // Load-bearing for Uzbek specifically: the Uzbek model emits zero capitals, so a
    // skipped capitalise stage delivers a whole sentence in lower case.
    const report = await uzbekRun({
      raw: "bu minusi o'zgacha bo'ladi.",
      deliver: (text, language) => deliver({ text, language, replacements: [], capitaliser: null }),
    });

    expect(report.ok).toBe(false);
    expect(report.fixtures[0]?.errorKind).toBe('notCapitalised');
    // The normaliser DID run — the marks are there — so this is a different fault from
    // the two above and must not be reported as either of them.
    expect(report.fixtures[0]?.delivered).toContain('ʻ');
  });

  it('accepts lower case when the pipeline was built without a capitaliser', async () => {
    const report = await uzbekRun({
      raw: "bu minusi o'zgacha bo'ladi.",
      capitalisesOnDelivery: false,
      deliver: (text, language) => deliver({ text, language, replacements: [], capitaliser: null }),
    });
    expect(report.ok).toBe(true);
    expect(report.fixtures[0]?.delivered).toBe('bu minusi oʻzgacha boʻladi.');
  });

  it('reports nothing delivered for a silent clip', async () => {
    const report = await runCheck({
      ...OPTIONS,
      environment: environment({
        models: fakeStore(READY),
        listFixtures: async () => ['silence-room-tone.wav'],
        isNearSilence: () => true,
      }),
    });

    // `heardNothing` asked no engine, so there is nothing to deliver — and `null` is a
    // different fact from an empty delivered string, exactly as for `transcript`.
    expect(report.fixtures[0]?.outcome).toBe('heardNothing');
    expect(report.fixtures[0]?.delivered).toBeNull();
    // The row itself carries no error — a quiet room is not a fault, and none of the
    // delivered-text rules may invent one for it. (The run as a whole is not ok, because
    // this corpus of exactly one silent clip trips the pre-existing "every fixture
    // transcribed to nothing" rule, which is a statement about the corpus, not the row.)
    expect(report.fixtures[0]?.errorKind).toBeNull();
    expect(report.failures).toHaveLength(1);
  });
});
