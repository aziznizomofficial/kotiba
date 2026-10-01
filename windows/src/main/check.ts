// `kotiba.exe --check` — the only way anyone verifies this app before strangers install it.
//
// D-W10. Nobody on this project owns a Windows machine. The whole build is proved by a
// 1-core `windows-latest` runner and by this one command, so it runs the WHOLE pipeline
// over `windows/fixtures/audio/`, prints a machine-readable summary, and exits non-zero
// on a real failure.
//
// THE ONE RULE, and the reason this file is careful rather than short:
//
//   "models not installed" and "broken" are DIFFERENT ANSWERS, and they are told apart
//   by the `ModelStatus` enum — set by the component that knows — never by matching an
//   error message.
//
// That exact bug shipped in `ai-balance/windows`: the check recovered state with the
// regex `no [A-Z_]+ stored`, the real message read `no GONKA_API_KEY / GONKA_BASE_URL
// stored`, the regex missed, and a healthy build exited non-zero. On a CI runner nothing
// is configured — that is the NORMAL state, and it must be reported as such at exit 0,
// while a 200 MB truncation of a 539 MB model must fail loudly at exit 1.
//
// Nothing in this file reads `.message`, `.reason` or `.why` to make a decision. Those
// strings are carried into the report for a human and are never branched on. A test
// (`test/main/check.test.ts`) asserts a corrupt model and a missing model produce
// different exit codes with overlapping prose, which is the assertion that bug needed.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AudioBuffer,
  CheckResult,
  EngineManager,
  EngineReadiness,
  Language,
  LanguageRouter,
  ModelId,
  ModelStatus,
  ModelStore,
  RouteDecision,
  Settings,
  TranscriptResult,
} from '../contracts/index.js';
import {
  BUNDLED_MODEL_IDS,
  DEFAULT_SETTINGS,
  MODEL_CATALOGUE,
  MODEL_IDS,
  asEngineError,
  audioDuration,
  engineFamilyFor,
} from '../contracts/index.js';

import { createEngines } from './engine-wiring.js';

/** One fixture's trip through the pipeline. */
export interface FixtureCheck {
  /** File name only — the report is compared across machines. */
  readonly fixture: string;
  readonly seconds: number;
  readonly route: RouteDecision | null;
  /**
   * The engine's VERBATIM output — `TranscriptResult.raw`, before any normalisation.
   *
   * Deliberately still named `transcript` and still carrying `raw`: it is the only way to
   * see what the model actually emitted, and a report that shows only the cleaned-up text
   * cannot tell "the model got it right" apart from "the normaliser covered for it".
   */
  readonly transcript: string | null;
  /**
   * What would actually land in the user's document: `raw` run through the SAME delivery
   * pipeline the session runs — `normaliseForDelivery` (Uzbek only) → replacements →
   * capitaliser — supplied by `CheckEnvironment.deliver`, never re-implemented here.
   *
   * `raw` alone proved nothing about the product's single most Uzbek-specific behaviour.
   * The 1320 golden rows prove the normaliser is correct AS A FUNCTION; only this field
   * proves the shipped binary CALLS it.
   */
  readonly delivered: string | null;
  readonly engineId: string | null;
  readonly millis: number;
  /**
   * What happened, as an ENUM — the same three terminal states the session has.
   *
   * `heardNothing` is neither success nor failure: the clip was below the silence
   * threshold and no engine was asked. It exists so a quiet room and a pipeline that
   * returned an empty string are never the same row in this report, which is exactly the
   * conflation that shipped silence as an empty paste on macOS (02-BEHAVIOUR §6.4).
   *
   * `notDownloaded` (D-W25) is not a failure either: the clip routed to a language whose
   * engine is a download this PC has not made yet — English or Russian before Parakeet lands
   * (the installer no longer carries whisper turbo), Turkish or Arabic before theirs. A fresh
   * install is not a broken one. A file that is there and CORRUPT still fails, as before.
   */
  readonly outcome: 'done' | 'heardNothing' | 'failed' | 'notDownloaded';
  /** `null` when it worked. A sentence, never branched on. */
  readonly error: string | null;
  /** The typed kind behind `error`, when there was one. Branch on THIS. */
  readonly errorKind: string | null;
}

/**
 * Why the pipeline did not run. `null` means it did.
 *
 * `modelsNotInstalled` is the CI runner's normal state and is NOT a failure.
 * `modelsCorrupt` is, and the two are distinguished by `ModelStatus` alone.
 */
export const CHECK_SKIP_REASONS = ['modelsNotInstalled', 'noFixtures'] as const;
export type CheckSkipReason = (typeof CHECK_SKIP_REASONS)[number];

/** The full report. Extends the contract's `CheckResult`, so it satisfies the stub. */
export interface CheckReport extends CheckResult {
  readonly ok: boolean;
  readonly models: Readonly<Record<ModelId, ModelStatus>>;
  readonly transcript: string | null;
  readonly route: RouteDecision | null;
  readonly failures: readonly string[];
  /** Every fixture, in name order. */
  readonly fixtures: readonly FixtureCheck[];
  /** Why the pipeline was skipped, or `null`. */
  readonly skipped: CheckSkipReason | null;
  /** True iff every bundled model reports `ready`. */
  readonly modelsInstalled: boolean;
  /** The three models the installer carries, so a reader knows what `models` covers. */
  readonly bundledModelIds: readonly ModelId[];
  readonly startedAt: string;
  readonly durationMillis: number;
  /**
   * Where the app looked, and what the resolvers said while looking.
   *
   * Never branched on — it is prose for a human, exactly like `error`. It is in the
   * report because "no engine is configured for en" without a list of probed paths is
   * the message that made this bug expensive on macOS.
   */
  readonly notes: readonly string[];
}

/**
 * Everything `--check` needs from the outside world.
 *
 * It is an interface and not a set of imports because the modules behind it land at
 * different times — `src/audio` and `src/session` are other workers' — and because a
 * check whose own tests need a 539 MB model is a check nobody runs.
 */
export interface CheckEnvironment {
  readonly models: ModelStore;
  /** WAV files in the fixtures directory, sorted. Empty when the directory is absent. */
  listFixtures(directory: string): Promise<readonly string[]>;
  readWav(path: string): Promise<AudioBuffer>;
  /** Built only once the models report ready — constructing it spawns the STT host. */
  makeEngines(settings: Settings): Promise<EngineManager>;
  makeRouter(engines: EngineManager, settings: Settings): LanguageRouter;
  /**
   * The delivery pipeline, INJECTED — `src/core/text`'s `deliver`, bound to the same
   * settings-and-mode gate `SessionController.normaliserFor` binds it to.
   *
   * Required, with no default. An optional `deliver` that fell back to the identity
   * function would make every assertion below pass on a build where the normaliser is
   * never reached — which is the exact defect this field exists to catch, so the check
   * would then certify it as fixed.
   */
  deliver(text: string, language: Language): string;
  /**
   * Whether `deliver` was handed a capitaliser, i.e. `settings.autoCapitalise &&
   * mode.autocapitalizeInsert`. Reported by the side that BUILT the pipeline rather than
   * re-derived here, because that gate was once read by nothing at all.
   */
  readonly capitalisesOnDelivery: boolean;
  now(): number;
  /** Injected so the report is reproducible in a test. */
  timestamp(): string;
  /**
   * Everything the model store and the engine manager muttered while resolving, plus the
   * table of resource paths the app searched.
   *
   * Optional so a test's fake environment need not supply one, and reported even on a
   * SUCCESSFUL run: a path table that appears only once something is broken is a table
   * nobody has seen working, so nobody can tell an unusual path from a normal one at the
   * moment it matters.
   */
  readonly notes?: () => readonly string[];
  /**
   * The near-silence rule, injected from `src/audio` rather than re-implemented here.
   *
   * Optional so a fake environment need not supply one; when absent, no clip is treated
   * as silent, which is the conservative default — it can only ever make the check run
   * MORE of the pipeline, never less.
   */
  readonly isNearSilence?: (audio: AudioBuffer, threshold: number) => boolean;
}

export interface CheckOptions {
  /** The fixtures DIRECTORY. Named `fixturePath` because the contract stub named it so. */
  readonly fixturePath: string;
  readonly modelsDirectory: string;
  /** Where the installer put the models. Defaults to the models directory. */
  readonly bundledDirectory?: string;
  readonly settings?: Settings;
  /** Tests pass a fake; production passes nothing. */
  readonly environment?: CheckEnvironment;
}

const WAV_PATTERN = /\.wav$/iu;

// ---------------------------------------------------------------------------------
// The delivered-text assertions
//
// These are CORRECTNESS assertions, not style. Every one of them names a way the shipped
// binary can deliver text that the golden fixtures cannot see, because the golden fixtures
// test the normaliser as a pure function and say nothing about whether it is called.
// ---------------------------------------------------------------------------------

const OKINA = 'ʻ'; // ʻ  MODIFIER LETTER TURNED COMMA — the Uzbek okina
const TUTUQ = 'ʼ'; // ʼ  MODIFIER LETTER APOSTROPHE — the tutuq belgisi

/**
 * The two glyphs a raw Uzbek transcript uses for those marks and that MUST NOT survive
 * delivery: U+0027 APOSTROPHE and U+2019 RIGHT SINGLE QUOTATION MARK.
 *
 * The macOS acceptance criterion for this exact path was that the Uzbek "came back with a
 * real U+02BB okina and no ASCII apostrophes". One of them in delivered Uzbek means the
 * normaliser did not run — that is `o'zbek` in the user's document, which is misspelt.
 *
 * `normaliseForDelivery` does deliberately keep U+0027 in two cases: an English genitive
 * (`Chicago's`) and an apostrophe that is punctuation rather than intra-word (a quote).
 * Neither occurs anywhere in the committed corpus, so a fixture tripping this rule means
 * the corpus changed — revisit the fixture, not the rule.
 */
const FORBIDDEN_IN_DELIVERED_UZBEK = /['’]/u;

/** Either Uzbek modifier letter — proof that the normaliser did something. */
const UZBEK_MARKS = new RegExp(`[${OKINA}${TUTUQ}]`, 'u');

/**
 * Fixtures whose delivered text MUST contain an okina or a tutuq belgisi.
 *
 * Named individually and on purpose: `uzbek-0001.wav` is a committed clip that is KNOWN to
 * contain them ("bu minusi o'zgacha bo'ladi." raw). Without this, a normaliser that
 * silently returned its input unchanged would satisfy the rule above — it forbids the wrong
 * glyph, and a normaliser that does nothing at all to a clip with no apostrophes emits no
 * wrong glyph either. This is the assertion that says the transformation HAPPENED.
 */
const MUST_DELIVER_UZBEK_MARKS: readonly string[] = ['uzbek-0001.wav'];

/** The default file lister. A missing directory is EMPTY, not an exception. */
export async function listWavFiles(directory: string): Promise<readonly string[]> {
  try {
    const names = await readdir(directory);
    return names.filter((name) => WAV_PATTERN.test(name)).sort();
  } catch {
    return [];
  }
}

/**
 * The check.
 *
 * Order matters and it is the order of what can be known cheaply: models first, because
 * their status decides whether anything else is even meaningful; then the fixtures;
 * then one full pipeline run per fixture.
 */
export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const environment = options.environment ?? (await defaultEnvironment(options));
  const settings = options.settings ?? DEFAULT_SETTINGS;
  const startedAt = environment.timestamp();
  const began = environment.now();

  const failures: string[] = [];

  // ---- 1. The models, as an ENUM -------------------------------------------------
  const models = await modelStatuses(environment.models);

  for (const id of BUNDLED_MODEL_IDS) {
    // The ONLY branch, and it is on the enum. `corrupt` is a broken install: the file is
    // there and cannot be used, which no amount of waiting fixes.
    if (models[id] === 'corrupt') {
      failures.push(
        `${MODEL_CATALOGUE[id].name} (${MODEL_CATALOGUE[id].fileName}) is installed but unusable`,
      );
    }
  }

  const modelsInstalled = BUNDLED_MODEL_IDS.every((id) => models[id] === 'ready');

  // A machine with no models cannot transcribe, and on CI that is the expected state,
  // not a fault. Report it, run nothing, exit 0 — unless something was CORRUPT, which
  // was already recorded above and is a different answer entirely.
  if (!modelsInstalled) {
    return finish({
      environment,
      startedAt,
      began,
      models,
      modelsInstalled,
      fixtures: [],
      failures,
      skipped: 'modelsNotInstalled',
    });
  }

  // ---- 2. The fixtures -----------------------------------------------------------
  const names = await environment.listFixtures(options.fixturePath);
  if (names.length === 0) {
    // Reached only when the models ARE installed, so there is no excuse: the corpus is
    // committed to the repository and its absence means the build is not what it says.
    failures.push(`no .wav fixtures in ${options.fixturePath}`);
    return finish({
      environment,
      startedAt,
      began,
      models,
      modelsInstalled,
      fixtures: [],
      failures,
      skipped: 'noFixtures',
    });
  }

  // ---- 3. The pipeline, once per fixture -----------------------------------------
  const engines = await environment.makeEngines(settings);

  // BUILD BEFORE ASKING. `engineFor()` and `detector()` are synchronous getters over a
  // map that only `prepare()`/`reconfigure()` ever fills, so constructing the manager and
  // asking it a question on the next line returns `null` from an EMPTY manager — which is
  // indistinguishable, at the call site, from "you own no model for this language".
  //
  // That is precisely what shipped: run 32240326275 reported all three models `ready` and
  // then failed every fixture with `noEngineInstalled` in 2 ms, and reported `source:
  // "fallback"` with `turkicMass: null` because the detector was equally unbuilt. Both
  // read as pipeline RESULTS rather than as a step that never ran.
  //
  // `eagerly: true` because `--check` exercises every language, not the default one, and
  // a preload failure is deliberately not fatal here — it must surface as the fixture's
  // own typed error, with the engine's reason preserved, rather than as an exception that
  // replaces the whole report with one sentence.
  await engines.prepare({ eagerly: true }).catch(() => undefined);
  // Which families have their models at all — a fixture for one that has not been downloaded
  // yet is reported as such, not as a failure (D-W25). `null` when the question itself failed:
  // then every fixture runs and reports what it gets, as before.
  const readiness = await engines.readiness().catch(() => null);

  const router = environment.makeRouter(engines, settings);
  const fixtures: FixtureCheck[] = [];

  try {
    for (const name of names) {
      fixtures.push(
        await checkOneFixture({
          environment,
          engines,
          router,
          directory: options.fixturePath,
          name,
          pin: settings.pinnedLanguage,
          readiness,
          silenceThreshold: settings.silenceThreshold,
          isNearSilence: environment.isNearSilence ?? (() => false),
        }),
      );
    }
  } finally {
    // The STT host is a child process. Leaving it running turns a `--check` on CI into
    // a job that never ends.
    await engines.dispose().catch(() => undefined);
  }

  for (const fixture of fixtures) {
    if (fixture.error !== null) {
      failures.push(`${fixture.fixture}: ${fixture.error}`);
    }
  }

  // Every fixture transcribing to nothing means the pipeline is dead in a way no single
  // fixture proves — a silence clip is a legitimate fixture, a corpus of them is not.
  const anyText = fixtures.some((f) => f.transcript !== null && f.transcript.trim().length > 0);
  // A corpus whose every clip is for a model not downloaded yet ran nothing, and says so per clip.
  const ran = fixtures.some((f) => f.outcome !== 'notDownloaded');
  if (ran && !anyText && failures.length === 0) {
    failures.push(`every fixture transcribed to nothing — ${fixtures.length} clips, no words`);
  }

  return finish({
    environment,
    startedAt,
    began,
    models,
    modelsInstalled,
    fixtures,
    failures,
    skipped: null,
  });
}

async function checkOneFixture(args: {
  readonly environment: CheckEnvironment;
  readonly engines: EngineManager;
  readonly router: LanguageRouter;
  readonly directory: string;
  readonly name: string;
  readonly pin: Language | null;
  readonly readiness?: EngineReadiness | null;
  readonly silenceThreshold: number;
  readonly isNearSilence: (audio: AudioBuffer, threshold: number) => boolean;
}): Promise<FixtureCheck> {
  const { environment, engines, router, directory, name, pin } = args;
  const began = environment.now();
  let route: RouteDecision | null = null;

  try {
    const audio = await environment.readWav(join(directory, name));
    const seconds = audioDuration(audio);

    // SILENCE IS NOT AN EMPTY TRANSCRIPT. 02-BEHAVIOUR §6.4: a whole-buffer peak below
    // `settings.silenceThreshold` is `heardNothing`, and the macOS app delivered it as an
    // empty paste instead — a clip that transcribed to "" and a room-tone clip that was
    // never spoken into are different facts, and reporting both as `transcript: ""` hides
    // the one that is a bug behind the one that is not.
    //
    // The rule is `isNearSilence` from `src/audio`, injected rather than re-implemented:
    // a second copy of the 0.012 constant is how `ClusterMass.defaultThreshold` came to
    // say 0.5 while the app said 0.05.
    if (args.isNearSilence(audio, args.silenceThreshold)) {
      return {
        fixture: name,
        seconds,
        route: null,
        transcript: null,
        delivered: null,
        engineId: null,
        millis: environment.now() - began,
        outcome: 'heardNothing',
        // NOT an error. The microphone was open and nothing was said, which is a normal
        // outcome and must not fail the check.
        error: null,
        errorKind: null,
      };
    }

    route = await router.route(audio, pin);

    if (notDownloaded(route.language, args.readiness ?? null)) {
      return {
        fixture: name,
        seconds,
        route,
        transcript: null,
        delivered: null,
        engineId: null,
        millis: environment.now() - began,
        outcome: 'notDownloaded',
        error: null,
        errorKind: null,
      };
    }

    const engine = engines.engineFor(engineFamilyFor(route.language));
    if (engine === null) {
      return {
        fixture: name,
        seconds,
        route,
        transcript: null,
        delivered: null,
        engineId: null,
        millis: environment.now() - began,
        outcome: 'failed',
        error: `no engine is configured for ${route.language}`,
        errorKind: 'noEngineInstalled',
      };
    }

    // PREPARE-THEN-RE-ASK, never check-alone. A lazily-loaded engine is legitimately not
    // ready before first use; refusing on `isReady() === false` made Uzbek fail on every
    // default install while pointing the user at a model file that was present and valid.
    if (!(await engine.isReady())) await engine.prepare();

    const result: TranscriptResult = await engine.transcribe(audio, route.language);

    // THE DELIVERY PATH, run here and not merely described. `environment.deliver` is
    // `src/core/text`'s `deliver` bound exactly as `SessionController.normaliserFor` binds
    // it, so what this line produces is what the user's document would receive. Anything
    // less — a copy of the pipeline living in this file — would prove only that the copy
    // works, which is the one thing nobody needs to know.
    const delivered = environment.deliver(result.raw, route.language);

    // A transcript that came back EMPTY from audio loud enough to clear the silence
    // gate is a real failure of the pipeline, not a quiet room, and it is the second
    // gate 02-BEHAVIOUR §6.4 asks for. Checked FIRST: an empty raw makes every delivered
    // assertion below vacuously true, so reporting them instead would hide it.
    const problem =
      result.raw.trim().length === 0
        ? {
            error: 'the clip was loud enough to transcribe and came back empty',
            kind: 'emptyTranscript',
          }
        : deliveryProblem({
            name,
            language: route.language,
            delivered,
            capitalises: environment.capitalisesOnDelivery,
          });

    return {
      fixture: name,
      seconds,
      route,
      transcript: result.raw,
      delivered,
      engineId: result.engineId,
      millis: environment.now() - began,
      outcome: problem === null ? 'done' : 'failed',
      error: problem?.error ?? null,
      errorKind: problem?.kind ?? null,
    };
  } catch (error: unknown) {
    // The TYPED kind is what a reader branches on. The sentence is for the human.
    const engineError = asEngineError(error);
    return {
      fixture: name,
      seconds: 0,
      route,
      transcript: null,
      delivered: null,
      engineId: null,
      millis: environment.now() - began,
      outcome: 'failed',
      error: engineError?.reason ?? messageOf(error),
      errorKind: engineError?.kind ?? 'unknown',
    };
  }
}

/**
 * Whether `language`'s engine is simply not on this PC yet — its family `notInstalled`, never
 * `corrupt` (that is a broken install, and fails). English and Russian are the unified family:
 * Parakeet, or turbo when Turkish or Arabic brought it.
 */
export function notDownloaded(language: Language, readiness: EngineReadiness | null): boolean {
  if (readiness === null) return false;
  switch (language) {
    case 'uz':
      return readiness.uzbek === 'notInstalled';
    case 'en':
    case 'ru':
      return readiness.unified === 'notInstalled';
    case 'tr':
      return readiness.turkish === 'notInstalled';
    case 'ar':
      return readiness.arabic === 'notInstalled';
  }
}

/**
 * The three assertions on DELIVERED text, in the order a reader should meet them.
 *
 * Returns `null` when the delivered text is what the product promises. Each rule carries
 * its own `errorKind`, because "the normaliser did not run" and "the normaliser ran and
 * changed nothing" are different faults with different fixes, and telling them apart by
 * matching an error sentence is the D-W10 mistake this whole file is written against.
 */
function deliveryProblem(args: {
  readonly name: string;
  readonly language: Language;
  readonly delivered: string;
  readonly capitalises: boolean;
}): { readonly error: string; readonly kind: string } | null {
  // 1. WRONG GLYPH. An ASCII apostrophe or a right single quote in delivered Uzbek is a
  //    misspelling in the user's document — `o'zbek` where `oʻzbek` was meant. It is the
  //    literal macOS acceptance criterion for this path and nothing in CI checked it.
  if (args.language === 'uz' && FORBIDDEN_IN_DELIVERED_UZBEK.test(args.delivered)) {
    return {
      error:
        `delivered Uzbek still contains an ASCII apostrophe (U+0027) or a right single ` +
        `quote (U+2019); the delivery normaliser did not run: ${JSON.stringify(args.delivered)}`,
      kind: 'uzbekApostropheDelivered',
    };
  }

  // 2. NO-OP NORMALISER. Rule 1 alone is satisfied by a normaliser that returns its input
  //    untouched whenever the input happens to carry no apostrophe. This fixture is known
  //    to carry them, so its delivered text must carry the marks they became. A failure
  //    here also catches misrouting: an Uzbek clip sent to the unified engine is delivered
  //    as `en`, and `normaliseForDelivery` is Uzbek-only, so no marks appear.
  if (MUST_DELIVER_UZBEK_MARKS.includes(args.name) && !UZBEK_MARKS.test(args.delivered)) {
    return {
      error:
        `delivered text for a fixture known to contain the okina/tutuq belgisi has ` +
        `neither U+02BB nor U+02BC (routed ${args.language}): ${JSON.stringify(args.delivered)}`,
      kind: 'uzbekMarksMissing',
    };
  }

  // 3. CAPITALISER. Load-bearing specifically for Uzbek: the Uzbek model emits zero
  //    capitals — not one in 24 measured dictations — so the whole of a user's Uzbek
  //    sentence arrives lower case if this stage is skipped. The gate is `capitalises`,
  //    reported by whoever built the pipeline; when it is off, a lower-case start is
  //    correct and this rule does not apply.
  if (args.capitalises) {
    const first = firstCasedLetter(args.delivered);
    if (first !== null && first !== first.toUpperCase()) {
      return {
        error:
          `delivered text begins lower case with the capitaliser enabled; the capitalise ` +
          `stage did not run: ${JSON.stringify(args.delivered)}`,
        kind: 'notCapitalised',
      };
    }
  }

  return null;
}

/**
 * The first character that HAS a case distinction, or `null`.
 *
 * Not simply `text[0]`: delivered text may open with a quote or a digit, and the Uzbek
 * modifier letters (U+02BB/U+02BC) are Unicode letters with no uppercase form — taking one
 * of those as "the first letter" is the exact bug the capitaliser itself guards against.
 */
function firstCasedLetter(text: string): string | null {
  for (const ch of text) {
    if (ch.toLowerCase() !== ch.toUpperCase()) return ch;
  }
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Every catalogue model's status, including the ones that are not bundled. */
export async function modelStatuses(
  store: ModelStore,
): Promise<Readonly<Record<ModelId, ModelStatus>>> {
  const entries: [ModelId, ModelStatus][] = [];
  for (const id of MODEL_IDS) {
    try {
      entries.push([id, await store.status(id)]);
    } catch {
      // A store that cannot answer is not the same as a model that is not there, but it
      // is not `ready` either, and `notInstalled` is the honest floor.
      entries.push([id, 'notInstalled']);
    }
  }
  return Object.fromEntries(entries) as Record<ModelId, ModelStatus>;
}

function finish(args: {
  readonly environment: CheckEnvironment;
  readonly startedAt: string;
  readonly began: number;
  readonly models: Readonly<Record<ModelId, ModelStatus>>;
  readonly modelsInstalled: boolean;
  readonly fixtures: readonly FixtureCheck[];
  readonly failures: readonly string[];
  readonly skipped: CheckSkipReason | null;
}): CheckReport {
  const first = args.fixtures[0];
  return {
    ok: args.failures.length === 0,
    models: args.models,
    // The contract's single-valued fields report the FIRST fixture; `fixtures` has them all.
    transcript: first?.transcript ?? null,
    route: first?.route ?? null,
    failures: args.failures,
    fixtures: args.fixtures,
    skipped: args.skipped,
    modelsInstalled: args.modelsInstalled,
    bundledModelIds: BUNDLED_MODEL_IDS,
    startedAt: args.startedAt,
    durationMillis: args.environment.now() - args.began,
    notes: args.environment.notes?.() ?? [],
  };
}

// ---------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------

/**
 * The machine-readable summary: one JSON object, stable key order, on stdout.
 *
 * Stable order so a CI job can diff two runs, and one object rather than a stream so a
 * job can `jq` it without a parser.
 */
export function formatCheckJson(report: CheckReport): string {
  return JSON.stringify(
    {
      ok: report.ok,
      startedAt: report.startedAt,
      durationMillis: report.durationMillis,
      modelsInstalled: report.modelsInstalled,
      skipped: report.skipped,
      models: report.models,
      bundledModelIds: report.bundledModelIds,
      fixtures: report.fixtures,
      failures: report.failures,
      notes: report.notes,
    },
    null,
    2,
  );
}

/** The human summary, on stderr, so a `jq` pipeline on stdout is not disturbed by it. */
export function formatCheckHuman(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(report.ok ? 'kotiba --check: ok' : 'kotiba --check: FAILED');

  for (const id of MODEL_IDS) {
    const status = report.models[id];
    lines.push(`  model ${id.padEnd(16)} ${status}`);
  }

  if (report.skipped === 'modelsNotInstalled') {
    // Said in full, because "skipped" alone reads as a failure to anyone scanning a log.
    lines.push('  the pipeline did not run: no models are installed on this machine.');
    lines.push('  that is the expected state on a build runner and is not a failure.');
  } else if (report.skipped === 'noFixtures') {
    lines.push('  the pipeline did not run: there are no audio fixtures to run it over.');
  }

  for (const fixture of report.fixtures) {
    const route = fixture.route;
    const where = route === null ? '—' : `${route.language} via ${route.source}`;
    // `heard nothing` and `(none)` are deliberately different words for deliberately
    // different facts: a quiet room, and a pipeline that produced no transcript.
    const text =
      fixture.outcome === 'heardNothing'
        ? 'heard nothing (below the silence threshold)'
        : fixture.outcome === 'notDownloaded'
          ? `not run: the ${fixture.route?.language ?? ''} model is a download this PC has not made yet`
          : fixture.transcript === null
          ? '(none)'
          : JSON.stringify(fixture.transcript);
    lines.push(`  ${fixture.fixture}  ${fixture.millis} ms  ${where}  raw ${text}`);
    // BOTH STAGES, always, and on their own line so the two are read against each other.
    // Printing only `raw` is what made this check stop one step short of the product: the
    // Uzbek row showed ASCII apostrophes and was CORRECT to, because that is what the
    // engine emitted — and nobody could see whether the okina ever arrived.
    if (fixture.delivered !== null) {
      lines.push(`      delivered ${JSON.stringify(fixture.delivered)}`);
    }
    if (fixture.error !== null) lines.push(`      ! [${fixture.errorKind}] ${fixture.error}`);
  }

  // Where it looked, ALWAYS — see `CheckReport.notes`. Before the failures, because by
  // the time a reader reaches "no engine is configured" the paths are what they need.
  for (const note of report.notes) {
    for (const line of note.split('\n')) lines.push(`  · ${line}`);
  }

  for (const failure of report.failures) lines.push(`  FAIL ${failure}`);
  return lines.join('\n');
}

/**
 * Non-zero whenever `failures` is non-empty, and zero otherwise. Nothing else.
 *
 * `ok` is defined as `failures.length === 0` in `finish()` and this reads it, so there is
 * exactly one place that decides, and no message is ever matched to get here. The states
 * that are NOT failures are excluded upstream by the `ModelStatus` enum: `notInstalled`
 * on every bundled model is a runner with no models, which returns before anything is
 * pushed; `corrupt` pushes a failure and lands here as 1.
 *
 * `--check` is the only verification anyone has before strangers install this, so a run
 * that prints failures and exits 0 is worse than no check at all — it is a check that
 * reports success.
 */
export function checkExitCode(report: CheckReport): number {
  return report.failures.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------
// The production environment
// ---------------------------------------------------------------------------------

/**
 * Built lazily and by dynamic import, for one reason: `--check` must be able to REPORT
 * that a module it needs is not there yet, rather than failing to load at all. The nine
 * modules land one at a time, and a check that cannot start is a check nobody can use to
 * find out why.
 */
async function defaultEnvironment(options: CheckOptions): Promise<CheckEnvironment> {
  const engines = await import('../engines/index.js');
  const audio = await import('../audio/index.js');
  const textCore = await import('../core/text/index.js');
  const settingsCore = await import('../core/settings/index.js');
  const modesCore = await import('../core/modes/index.js');
  const { describeAllResources, hostExecutablePath } = await import('./paths.js');

  // ---- the delivery pipeline, assembled the way the SESSION assembles it -----------
  //
  // `SessionController.normaliserFor` does exactly this and nothing else: resolve the
  // mode, AND the two capitalise flags, build the capitaliser over the union of the
  // vocabulary across all three languages, and hand the lot to `textCore.deliver`. The
  // stages themselves — `normaliseForDelivery` → replacements → capitaliser — live inside
  // `deliver`, which is imported, not copied, so `--check` cannot pass on a pipeline the
  // app does not have.
  //
  // The mode comes from `resolveMode` with no user pick and no foreground app, which is
  // the default-mode path (`settings.defaultModeKey`, `super` out of the box) — the mode
  // a dictation gets when nobody has chosen otherwise.
  const checkSettings = options.settings ?? DEFAULT_SETTINGS;
  const { mode } = settingsCore.resolveMode({
    modes: settingsCore.builtInModes(),
    settings: checkSettings,
    userPickedModeKey: null,
    foregroundApp: null,
  });
  // BOTH flags, ANDed — the session's rule verbatim. Reading only the mode flag makes
  // every Uzbek dictation arrive lower case, and reading only the setting ignores a mode
  // that asked to be left alone.
  const capitalisesOnDelivery = checkSettings.autoCapitalise && mode.autocapitalizeInsert;
  const capitaliser = capitalisesOnDelivery
    ? textCore.createCapitaliser(Object.values(checkSettings.vocabulary).flat())
    : null;

  const store = engines.createModelStore({
    modelsDirectory: options.modelsDirectory,
    bundledDirectory: options.bundledDirectory ?? options.modelsDirectory,
  });

  // The path table first, then whatever the manager says as it builds. Both are prose
  // and neither is branched on.
  const managerNotes: string[] = [describeAllResources()];

  return {
    models: store,
    listFixtures: listWavFiles,
    readWav: (path) => audio.readWavFile(path),
    isNearSilence: (buffer, threshold) => audio.isNearSilence(buffer, threshold),
    capitalisesOnDelivery,
    deliver: (text, language) =>
      textCore.deliver({
        text,
        language,
        replacements: checkSettings.replacements,
        capitaliser,
        // The mode's deterministic half, as `normaliserFor` runs it for every built-in
        // mode but Raw — `--check` must not pass on a pipeline the app does not have.
        ...(modesCore.modeBehaviour(mode) === 'raw'
          ? {}
          : { cleanUp: (value: string) => modesCore.cleanUp(value, language) }),
      }),
    notes: () => [...managerNotes, ...store.notes],
    async makeEngines(settings) {
      // THE SAME FUNCTION THE APP CALLS. This block used to be a second copy of
      // `src/main/index.ts`'s wiring — including its own `supportedLanguagesFor` reading
      // a model's languages out of its FILE NAME — and the two had already drifted. The
      // whole value of `--check` is that it exercises what the app runs, and it cannot
      // do that from a paragraph maintained in parallel.
      // Parakeet heads the unified family here exactly as in the app, so a machine that
      // has it (downloaded, or shipped beside the executable) runs its English fixture
      // through it. Never downloaded by a smoke test: without it, turbo serves if this PC has
      // it (Turkish/Arabic brought it), and otherwise the fixture reports `notDownloaded`.
      const bundles = engines.createBundleStore({
        modelsDirectory: options.modelsDirectory,
        readOnlyDirectory: options.bundledDirectory ?? options.modelsDirectory,
      });
      const { availableParallelism } = await import('node:os');
      const parakeet = new engines.ParakeetEngine({
        store: bundles,
        threads: engines.resolveOrtThreads(availableParallelism()),
        autoDownload: false,
        idleUnloadMs: null,
        onNote: (note) => managerNotes.push(note),
      });
      // C4: Arabic heads its family here as in the app — never downloaded by a smoke test.
      const arabic = new engines.ArabicEngine({
        store: bundles,
        threads: engines.resolveOrtThreads(availableParallelism()),
        autoDownload: false,
        idleUnloadMs: null,
        backend: () => (settings.whisperUseGPU ? 'auto' : 'cpu'),
        choice: () => settings.arabicEngine,
        onNote: (note) => managerNotes.push(note),
      });
      return createEngines(engines, {
        settings,
        models: store,
        hostPath: hostExecutablePath(),
        onNote: (note) => managerNotes.push(note),
        unifiedLead: {
          engine: parakeet,
          status: async () => ((await bundles.isInstalled('parakeet_ultra')) ? 'ready' : 'notInstalled'),
        },
        arabicLead: {
          engine: arabic,
          status: async () =>
            (await bundles.isInstalled('cohere_arabic')) || (await bundles.isInstalled('fastconformer_ar')) ? 'ready' : 'notInstalled',
        },
        // The Uzbek engine streams in the app, so it is built the same way here: flash
        // attention off, the session wrapper around it (batch `transcribe` passes through).
        speechDetectorPath: async () => {
          const directory = await bundles.locate('silero_vad');
          return directory === null ? null : `${directory}/ggml-silero-v6.2.0.bin`;
        },
      });
    },
    makeRouter(manager, settings) {
      // The router is built from the manager's own detector, so `--check` exercises the
      // same three tiers the app does rather than a simplified stand-in.
      return createRouter(manager, settings);
    },
    now: () => Date.now(),
    timestamp: () => new Date().toISOString(),
  };
}

/** Kept separate so the import graph above stays readable. */
function createRouter(manager: EngineManager, settings: Settings): LanguageRouter {
  return {
    async route(audio, pin) {
      const { createTieredRouter, languageSubset, optionalLanguageRules } = await import('../core/routing/index.js');
      return createTieredRouter({
        classifier: manager.detector(),
        threshold: settings.turkicThreshold,
        fallbackLanguage: settings.defaultLanguage,
        optional: optionalLanguageRules(settings.enabledLanguages),
        languages: languageSubset(settings.enabledLanguages),
      }).route(audio, pin);
    },
  };
}
