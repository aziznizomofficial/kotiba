// The owner: a fresh session per press, and everything the tray and the HUD read.
// Ported from `DictationController` (Sources/KotibaUI/DictationController.swift, 1225 lines).
//
// FOUR THINGS IN THIS FILE ARE NOT STYLE.
//
// 1. ADMISSION IS "IS THE KEY ALREADY DOWN", NEVER `isBusy(status)` — and since 1.0, never
//    "is a run in flight" either. A press during the previous dictation's processing gets
//    a take of its own at once, a ticket in the paste queue, and the HUD (see "the
//    gesture" below). `isRunning` is still named once — a held key or any run in `runs` —
//    and every run removes exactly its own entry on every exit path, so it cannot latch.
//    The macOS bug it guards against: a gate cleared only in a method with no callers
//    refused every press after the first for the life of the process. The regression
//    tests drive TEN consecutive dictations, and ten OVERLAPPING ones.
//
// 2. THE READINESS/DICTATION SPLIT. Two independent `DictationStatus` values — what the
//    app is doing to itself, and what this run is doing — exposed as one computed
//    `status`. They used to be one variable written from six places, and `isBusy`
//    collapsed both into the admission gate, so re-preparing a model refused dictations
//    while nothing was finishing and the microphone was free.
//
// 3. A KEY-UP FINISHES THE KEY-DOWN IT BELONGS TO, AND NO OTHER. `held` is the one press
//    waiting for its key-up; a second key-up finds nothing, and a run's cleanup touches
//    only its own entry. A run can therefore never null the session of the dictation
//    being spoken — the defect that once put one press's audio into the next one's text.
//
// 4. THE CREDENTIAL GATE, TWICE. `resolveMode()` forces the raw, prompt-less mode when
//    the foreground app is a password manager, and `makePolishChain()` asks the SAME
//    question again before it builds anything. The second ask is not redundancy: the
//    first gate protects a password only for as long as the forced mode happens to have
//    no prompt, and "happens to" is not a security property. The macOS source records
//    that this defect shipped once already.

import {
  DEFAULT_POLISH_GUARD,
  RESTRUCTURING_POLISH_GUARD,
  dictationError,
  dictationErrorHeadline,
  isTerminal,
} from '../contracts/index.js';
import type {
  AppId,
  Blocker,
  BuiltInModeTable,
  CreateDictationController,
  DictationRecord,
  DictationStatus,
  EngineReadiness,
  HistoryEntry,
  InputDeviceInfo,
  Language,
  Mode,
  ModeDecision,
  Polisher,
  PolishGuardConfig,
  Settings,
  Unsubscribe,
} from '../contracts/index.js';
import type { AudioTake, InsertionOutcome } from '../contracts/index.js';
import type { DictationController } from '../contracts/index.js';
import { speechLanguageName, t } from '../core/i18n/index.js';
import { languageSubset, soleRoute, subsetFallback } from '../core/routing/language-subset.js';
import { detectionWanted } from '../core/settings/models.js';

import { createQuietMicLimiter, quietMicSuspect } from '../core/input-device/index.js';
import { modeBehaviour } from '../core/modes/index.js';
import {
  createLanguageIDRouter,
  languagePolicy,
  optionalLanguageRules,
  warmLexicons,
  type LanguageCounts,
  type LanguagePolicy,
} from '../core/routing/index.js';
import type { Clock, PlaybackDucking, PolishChain, SessionPorts } from './ports.js';
import { INERT_DUCKING, NO_POLISH, isIncrementalPolisher, systemClock } from './ports.js';
import { InsertionTurns, type TurnTimer } from './turns.js';
import type { DictationSession, SessionDeps } from './session.js';
import { createDictationSession, describe } from './session.js';

/** The contract's dependency bag, plus the pure seams no contract interface covers. */
export type ContractDeps = Parameters<CreateDictationController>[0];

export type ControllerDeps = ContractDeps & {
  readonly ports: SessionPorts;
  /**
   * Build a session. Present so a test can drive the controller's gate and status split
   * without a microphone, and so the reroute deadline can be a millisecond.
   */
  readonly createSession?: (deps: SessionDeps) => DictationSession;
  /** Where new UUIDs come from. `src/session` stays free of `node:crypto`. */
  readonly newId?: () => string;
  /** The real ducker, installed by the app. Absent means inert — see `INERT_DUCKING`. */
  readonly ducking?: PlaybackDucking;
  /** The paste queue's patience timer. Injected by the tests. */
  readonly turnTimer?: TurnTimer;
  /**
   * D-W25: how far a language's engine download has got (whole percent), or `null` when it is
   * not on its way. A press that finds no engine for a language still downloading says so.
   */
  readonly gettingReady?: (language: Language) => number | null;
};

/** What the status says while the ceiling's key-up transcribes. The Mac's sentence. */
export const CAPTURE_LIMIT_STAGE = 'reached the 30-minute limit — transcribing everything up to it';

/** Which polish guard a mode gets, and whether it inserts before or after the polish. */
export function polishPolicyFor(mode: Mode): {
  readonly guard: PolishGuardConfig;
  readonly insertAfterPolish: boolean;
} {
  // `restructures` drives the guard: a mode whose job is to reshape legitimately grows
  // and legitimately compresses. The 2.0 ceiling is right for a correction pass and would
  // reject every Note and Message, showing the raw transcript instead — the exact "all my
  // modes do the same thing" symptom.
  //
  // Insert-once is wider since 1.0, as on the Mac (`mode.restructures || ModeBehaviour(mode)
  // != nil`): EVERY built-in mode inserts once, after its polish. Their polish is on-device
  // and sentence by sentence — the deterministic half is instant and a model sentence is
  // ~100 ms — while replace-after-paste was the commonest failure on record (`polish
  // replace refused`, 94 times), and it fails in any app that will not expose its field.
  return {
    guard: mode.restructures ? RESTRUCTURING_POLISH_GUARD : DEFAULT_POLISH_GUARD,
    insertAfterPolish: mode.restructures || modeBehaviour(mode) !== null,
  };
}

/** The history the language decision's prior reads (`LanguagePrior`, P4): the five counts. */
export function languageCountsOf(settings: Settings): LanguageCounts {
  return {
    uz: settings.uzbekDictations,
    en: settings.englishDictations,
    ru: settings.russianDictations,
    tr: settings.turkishDictations,
    ar: settings.arabicDictations,
  };
}

/** The settings key that counts `language`'s delivered dictations (`AppSettings.countDictation`). */
const DICTATION_COUNT_KEY = {
  uz: 'uzbekDictations',
  en: 'englishDictations',
  ru: 'russianDictations',
  tr: 'turkishDictations',
  ar: 'arabicDictations',
} as const satisfies Readonly<Record<Language, keyof Settings>>;

/** The optional languages that are on (Turkish, Arabic). */
function enabledOptional(settings: Settings): Language[] {
  return settings.enabledLanguages.filter((language) => language === 'tr' || language === 'ar');
}

/**
 * A pin only when the user asked for one.
 *
 * `null` is what lets the router actually decide. Returning `defaultLanguage`
 * unconditionally pins every dictation at tier 1 and the classifier below it never runs.
 *
 * `pinnedLanguage` comes FIRST, and it is the whole point: measured on 745 clips of real
 * Uzbek at the live 0.05 threshold, the acoustic router's recall is 83.1%, and 58.4% on
 * clips under two seconds. A pin costs 0 ms and is always right. With no detector loaded
 * the default language is the only answer the router can give, so it becomes the pin.
 */
export function pinFor(settings: Settings, hasDetector: boolean): Language | null {
  const on = languageSubset(settings.enabledLanguages);
  if (settings.pinnedLanguage !== null && on.languages.has(settings.pinnedLanguage)) return settings.pinnedLanguage;
  // One language on (or English and Russian alone): nothing to detect, and the router routes
  // there for free (`soleRoute`, source `only`) — not as a pin, so the unified engine's own
  // English/Russian label still stands.
  if (soleRoute(on) !== null) return null;
  return hasDetector ? null : subsetFallback(on, settings.defaultLanguage);
}

/**
 * The pin for a dictation in `mode`: the mode's own language when it is on — a mode pinned to a
 * language the user turned off does not route there — else `pinFor` (the Mac's `effectivePin`).
 */
export function effectivePin(mode: Mode, settings: Settings, hasDetector: boolean): Language | null {
  if (mode.language !== null && mode.language !== undefined && settings.enabledLanguages.includes(mode.language)) {
    return mode.language;
  }
  return pinFor(settings, hasDetector);
}

/** The pin known at key-down: the mode's (when on), else the user's (when on). */
function pinAtPressFor(mode: Mode, settings: Settings): Language | null {
  if (mode.language !== null && mode.language !== undefined && settings.enabledLanguages.includes(mode.language)) {
    return mode.language;
  }
  const pinned = settings.pinnedLanguage;
  return pinned !== null && settings.enabledLanguages.includes(pinned) ? pinned : null;
}

export function createDictationController(deps: ControllerDeps): DictationController {
  const { ports } = deps;
  const clock: Clock = ports.clock ?? systemClock;
  const makeSession = deps.createSession ?? createDictationSession;
  const newId = deps.newId ?? defaultId;

  // ---- state -------------------------------------------------------------------

  /** What the app is doing to ITSELF. Written by start, prepare, settle and recheck. */
  let readiness: DictationStatus = { kind: 'idle' };
  /** What THIS RUN is doing. Written by press, release and settleRun. */
  let dictation: DictationStatus = { kind: 'idle' };

  /** N pastes before N+1. See `./turns.ts`. */
  const turns = new InsertionTurns(deps.turnTimer === undefined ? {} : { timer: deps.turnTimer });
  /**
   * Lowers what other apps are playing while the key is held. INERT unless the app
   * installs the real one — a controller built by a test must never move this machine's
   * volume, which is exactly what the Mac's first version did from a UI test.
   */
  const ducker: PlaybackDucking = deps.ducking ?? INERT_DUCKING;
  let lastRecord: DictationRecord | null = null;
  /**
   * A microphone that barely registered a real hold, and that has not been complained about
   * within the hour. Home shows it as a notice with the device name; it goes when a later
   * dictation comes out as text, or when the person dismisses it — never by time alone,
   * because the microphone is still quiet. The Mac's `DictationController.quietMic`.
   */
  let quietMic: InputDeviceInfo | null = null;
  const quietMicLimiter = createQuietMicLimiter();
  let userPickedModeKey: string | null = null;
  let disposed = false;

  /** Why a store or a helper would not come up. Each becomes one blocker. */
  let historyOpenError: string | null = null;
  let diagnosticsOpenError: string | null = null;
  let historyWriteError: string | null = null;
  let diagnosticsWriteError: string | null = null;
  /** Why a model would not load. Kept, because throwing it away names the wrong cause. */
  const loadFailures = new Map<Language, string>();
  /**
   * The last answer `engines.readiness()` gave.
   *
   * Cached because `blockers()` is SYNCHRONOUS by contract — the tray renders it — and a
   * blocker list that had to await the engine manager would either block the menu or
   * silently return an empty list, which reads to the user as the app believing
   * everything is fine.
   */
  let lastReadiness: EngineReadiness | null = null;

  const listeners = new Set<(status: DictationStatus) => void>();
  let lastPublished: DictationStatus | null = null;

  /** Dropped by `dispose()`. Both are attached exactly once, by `start()`. */
  let hotkeyOff: Unsubscribe | null = null;
  let settingsOff: Unsubscribe | null = null;

  /**
   * The dictation always wins while one is in flight, because that is the half the user
   * is currently looking at — AND ITS OUTCOME OUTLIVES IT.
   *
   * `isRunning ? dictation : readiness` alone published `idle` in the same turn as
   * `succeeded`, so the transcript, the "heard nothing" and the failure sentence each
   * existed for exactly one status event and the HUD had nothing left to render. The
   * outcome of the last dictation therefore stays the visible status until the next
   * press replaces it — which is what a HUD needs and what the macOS build kept in a
   * stored property beside the status.
   *
   * A readiness that is NOT idle still wins: a model that will not load is the app
   * saying something about itself, and burying that under a transcript from a minute ago
   * is the erasure `settleReadiness()` exists to prevent.
   */
  function currentStatus(): DictationStatus {
    if (isRunning()) return dictation;
    if (readiness.kind === 'idle' && isOutcome(dictation)) return dictation;
    return readiness;
  }

  /**
   * THE ADMISSION CONDITION, named once.
   *
   * Not `isBusy(status)`: `isBusy` is true whenever a model is being prepared, which
   * `recheck()` does on every foreground — so keying the gate off it refused a dictation
   * every time the user clicked the tray icon and immediately spoke.
   */
  function isRunning(): boolean {
    // Declared further down with the gesture; read only after construction.
    return heldPress() !== null || runCount() > 0;
  }

  function publish(): void {
    const status = currentStatus();
    if (lastPublished !== null && sameStatus(lastPublished, status)) return;
    lastPublished = status;
    for (const listener of [...listeners]) listener(status);
  }

  function setReadiness(next: DictationStatus): void {
    readiness = next;
    publish();
  }

  function setDictation(next: DictationStatus): void {
    dictation = next;
    publish();
  }

  /** Back to idle — unless something broke, where "idle" would erase the only diagnosis. */
  function settleReadiness(): void {
    const failure = [...loadFailures.values()][0];
    setReadiness(failure === undefined ? { kind: 'idle' } : { kind: 'failed', message: failure });
  }

  // ---- foreground and modes ------------------------------------------------------

  async function foregroundAppId(): Promise<AppId | null> {
    try {
      return (await deps.focus.foreground()).appId;
    } catch {
      // The credential gate must never GUESS. An unknown foreground app is `null`, which
      // resolves to the `unknown` format — not to "definitely not a password manager".
      return null;
    }
  }

  async function resolveMode(): Promise<ModeDecision> {
    return ports.modes.resolveMode({
      modes: deps.modes as BuiltInModeTable,
      settings: deps.settings.current(),
      userPickedModeKey,
      foregroundApp: await foregroundAppId(),
    });
  }

  /**
   * THE SECOND GATE.
   *
   * `resolveMode()` already returns the prompt-less mode for a credential field, and
   * that alone would be enough IF nothing else could ever reach here with a prompt. This
   * depends on nothing, and the thing being protected is a password: without it, a
   * password dictated into 1Password or Bitwarden is sent to whatever polish endpoint
   * the user configured.
   *
   * Assume every wrapper lies until its own test says otherwise. This one has one.
   */
  async function makePolishChain(mode: Mode, appId: AppId | null): Promise<PolishChain> {
    const settings = deps.settings.current();
    if (!settings.polishEnabled) return NO_POLISH;
    if (mode.prompt === null) return NO_POLISH;
    if (ports.modes.isSensitiveApp(appId)) return NO_POLISH;

    // Read per dictation rather than held: a secret in memory for the whole process
    // lifetime is a larger target than one read when it is needed.
    //
    // NEVER FOR A BUILT-IN MODE. Their polish is on-device (the deterministic half and
    // Qwen, C3) and takes no key — and on Windows `secrets.get` is a fresh `powershell.exe`
    // compiling an `Add-Type` block, with no timeout. `release()` awaits this chain before
    // `finish()` stops the take, so every Super/Message/Note dictation kept the microphone
    // open past key-up for that round trip (≈0.5–3 s cold), and a PowerShell that never
    // returned left it open for good.
    let apiKey: string | null = null;
    if (modeBehaviour(mode) === null) {
      try {
        apiKey = await deps.secrets.get(settings.polishKeyAccount);
      } catch {
        apiKey = null;
      }
    }
    return ports.createPolishChain({ mode, settings, apiKey });
  }

  function instructionsFor(mode: Mode, appId: AppId | null, language: Language): string | null {
    const settings = deps.settings.current();
    const context = ports.modes.promptContext({
      appId: mode.contextFromActiveApplication ? appId : null,
      language,
      datetime: promptDatetime(clock.now()),
      locale: ports.locale ?? 'en-US',
      // The user's own vocabulary first — those are the words they told us they say.
      names: settings.vocabulary[language] ?? [],
    });
    return ports.modes.polishInstructions({ mode, context });
  }

  // ---- the text pipeline for one dictation ---------------------------------------

  /**
   * `closesFinalSentence: false` is the same pipeline for a stretch that is not the end of
   * the dictation — what text committed during the hold is normalised with.
   */
  function normaliserFor(
    mode: Mode,
    options: { readonly closesFinalSentence: boolean } = { closesFinalSentence: true },
  ): (text: string, language: Language) => string {
    const settings = deps.settings.current();
    // The deterministic half of every built-in mode but Raw — fillers, stutters, the
    // transcriber's mid-sentence stops, spoken punctuation, spacing (C3 §3). Raw is
    // exactly what was said. Between the Uzbek delivery normaliser and the replacements,
    // exactly where the Mac's `normalise` closure runs it.
    const cleanUp = ports.text.cleanUp;
    const cleansUp = cleanUp !== undefined && modeBehaviour(mode) !== 'raw';
    // BOTH must be true. All four shipped modes set the mode flag, including `super` —
    // the flag gates this deterministic layer, not the model. Off, every Uzbek dictation
    // arrives entirely lower case, because the Uzbek model emits zero capitals.
    const capitalise = settings.autoCapitalise && mode.autocapitalizeInsert;
    // Seeded with the union of vocabulary terms across ALL THREE languages: the words
    // the user told us about are exactly the ones that should keep their capitals, in
    // English and Russian too.
    const capitaliser = capitalise
      ? ports.text.createCapitaliser(Object.values(settings.vocabulary).flat())
      : null;
    const replacements = settings.replacements;
    return (text, language) =>
      ports.text.deliver({
        text,
        language,
        replacements,
        capitaliser,
        ...(cleansUp ? { cleanUp: (value: string) => cleanUp(value, language, options) } : {}),
      });
  }

  function buildSession(
    mode: Mode,
    take: AudioTake,
    ticket: number,
    live: {
      readonly pinAtPress: Language | null;
      readonly polisher: () => Polisher | null;
      /** The take's start, already under way since key-down. Absent: the session starts it. */
      readonly started?: Promise<void>;
    } = {
      pinAtPress: null,
      polisher: () => null,
    },
  ): DictationSession {
    const started = live.started;
    const settings = deps.settings.current();
    // The language decision (P4, D-14), when the language-ID model is loaded: over the languages
    // that are on AND have an engine here (an optional language whose files are not built is out
    // of reach, the Mac's `routable`), with the user's own history as the prior.
    const identifier = deps.engines.languageIdentifier?.() ?? null;
    const policy: LanguagePolicy | null =
      identifier === null
        ? null
        : languagePolicy({
            counts: languageCountsOf(settings),
            enabled: settings.enabledLanguages.filter(
              (language) => (language !== 'tr' && language !== 'ar') || deps.engines.engineFor(language === 'tr' ? 'turkish' : 'arabic') !== null,
            ),
          });
    return makeSession({
      // Known at key-down: which family to stream into, and what to polish with while the
      // key is held (C1 §5, C2, C3 §8). Neither decides anything at key-up.
      pinAtPress: live.pinAtPress,
      speculativeLanguage: soleRoute(languageSubset(settings.enabledLanguages), settings.defaultLanguage) ??
        subsetFallback(languageSubset(settings.enabledLanguages), settings.defaultLanguage),
      livePolisher: live.polisher,
      normaliseSegment: normaliserFor(mode, { closesFinalSentence: false }),
      // THIS press's take — never the shared capture. A take opened by the next press
      // seals this one at that sample; the two never see each other's audio.
      audio: {
        start: () => started ?? take.start(),
        stop: () => take.stop(),
        onChunk: (listener) => take.onChunk(listener),
      },
      // Built per dictation, from the CURRENT settings and the CURRENT detector. A
      // router captured once at construction keeps routing on the threshold the app
      // started with, and `turkicThreshold` is the one number a user tunes when Uzbek
      // is being missed.
      //
      // P4: with the language-ID model loaded, the router is its policy's (`policyRoute`), and the
      // session reads the transcripts after it (`languageID`, step 4L); whisper base otherwise.
      router:
        identifier !== null && policy !== null
          ? createLanguageIDRouter({ classifier: identifier, policy, fallback: settings.defaultLanguage })
          : ports.createRouter({
              classifier: deps.engines.detector(),
              threshold: settings.turkicThreshold,
              fallbackLanguage: settings.defaultLanguage,
              // Turkish and Arabic, only when on (C4): off, the router is the three-language one.
              optional: optionalLanguageRules(settings.enabledLanguages),
              // Every language the user turned off is out of the router's reach.
              languages: languageSubset(settings.enabledLanguages),
            }),
      languageID: policy,
      engineFor: (family) => deps.engines.engineFor(family),
      ...(deps.gettingReady === undefined ? {} : { gettingReady: deps.gettingReady }),
      // turbo's head settles a Turkish and an Arabic candidate alike (C4 §13.1, §14.1).
      languageHead: () => (enabledOptional(settings).length > 0 ? (deps.engines.languageHead?.() ?? null) : null),
      optionalLanguages: enabledOptional(settings),
      languages: settings.enabledLanguages,
      // The user's own history (the Mac's D-11): a first Turkish dictation needs more.
      turkishFamiliar: settings.turkishDictations > 0,
      arabicFamiliar: settings.arabicDictations > 0,
      // The FIRST insert waits for this press's turn; `replace` does not move the caret.
      insert: orderedInsert(ticket),
      replace: (previous, text) => deps.inserter.replace(previous, text),
      normalise: normaliserFor(mode),
      routing: ports.routing,
      text: ports.text,
      config: {
        silenceThreshold: settings.silenceThreshold,
        polishDeadlineMs: Math.max(1, settings.polishTimeoutSeconds) * 1000,
        rerouteDeadlineMs: deps.config.rerouteDeadlineMs,
      },
      clock,
    });
  }

  // ---- lifecycle -----------------------------------------------------------------

  async function start(): Promise<void> {
    await deps.settings.load().catch(() => undefined);

    historyOpenError = null;
    if (deps.settings.current().keepHistory) {
      try {
        await deps.history.open();
        void seedLanguageCounts();
      } catch (error: unknown) {
        historyOpenError = describe(error);
      }
    }
    diagnosticsOpenError = null;
    if (deps.settings.current().diagnosticsEnabled) {
      try {
        await deps.diagnostics.open();
      } catch (error: unknown) {
        diagnosticsOpenError = describe(error);
      }
    }

    // The microphone is warmed ALONGSIDE the models, never in front of them. Warm-up can
    // end in a permission prompt, and a prompt waits for a person; awaiting it first left
    // the macOS app with neither model open until someone clicked Allow, and then paying
    // the 7.8 s cold load on the first Uzbek dictation instead.
    const warmUp = deps.audio.warmUp().catch(() => undefined);

    await prepareEngines({ eagerly: deps.settings.current().preloadAllLanguages });
    settleReadiness();
    // The language decision's word lists (~40 ms to split), built now rather than by the first
    // key-up that reads a transcript — the Mac's `Lexicon.warmUp` at launch.
    if ((deps.engines.languageIdentifier?.() ?? null) !== null) warmLexicons();

    // THE GESTURE IS CONNECTED HERE, AND NOWHERE ELSE.
    //
    // `hotkey.start()` used to be called with NOTHING subscribed to `onEvent`, so the
    // helper ran, the state machine in src/platform/hotkey.ts worked perfectly, and every
    // `pressed` it produced was delivered into an empty listener set. The app watched the
    // key and did nothing with it; the only thing that ever drove a dictation was a test
    // calling `press()` directly. This controller owns press/release/cancel, so this is
    // where the three events become the three calls.
    //
    // Subscribed BEFORE the helper starts: a key already going down as the hook installs
    // must not fall into the gap between the two lines.
    if (hotkeyOff === null) {
      hotkeyOff = deps.hotkey.onEvent((event) => {
        if (event.kind === 'pressed') press();
        else if (event.kind === 'released') release();
        else cancel(event.reason);
      });
    }
    // D-W4 requires the key to be reconfigurable without a restart, and `setBinding` had
    // no caller anywhere in the tree — so the picker in Settings wrote a new key into the
    // settings file and the running hook went on watching the old one until the app was
    // restarted.
    if (settingsOff === null) {
      settingsOff = deps.settings.onChange(() => {
        void syncHotkeyBinding();
      });
    }
    try {
      await deps.hotkey.start();
    } catch {
      // `hotkey.failure` is the channel for this; a throw here must not stop startup.
    }
    await syncHotkeyBinding();
    await warmUp;
  }

  async function prepareEngines(options: { readonly eagerly: boolean }): Promise<void> {
    try {
      await deps.engines.prepare(options);
    } catch (error: unknown) {
      loadFailures.set(deps.settings.current().defaultLanguage, describe(error));
      return;
    }
    // ASK WHAT ACTUALLY CAME UP. A `prepare()` that did not throw is not the same claim
    // as "the models are resident", and taking it as one is failure #2 — the macOS
    // composite engine computed readiness as an OR over its members and read ready
    // forever, re-breaking Russian one level below the fix.
    try {
      const now = await deps.engines.readiness();
      lastReadiness = now;
      loadFailures.clear();
      // `notInstalled` is not a load failure — it is a model the user has not chosen,
      // and it gets its own blocker with its own sentence. Only `corrupt` means a file
      // that is there and will not load.
      if (now.uzbek === 'corrupt') {
        loadFailures.set('uz', 'the Uzbek model file cannot be used. Download it again in Settings › Languages.');
      }
      if (now.unified === 'corrupt') {
        loadFailures.set('ru', 'the Russian model file cannot be used. Download it again in Settings › Languages.');
      }
    } catch {
      // A readiness call that itself fails tells us nothing new. The previous snapshot
      // stands rather than being replaced with a guess.
    }
  }

  /**
   * Push the settings' hotkey onto the running hook. Idempotent: `setBinding` returns
   * immediately when the key has not changed, so calling this on every settings change
   * costs nothing and cannot miss one.
   */
  async function syncHotkeyBinding(): Promise<void> {
    try {
      await deps.hotkey.setBinding(deps.settings.current().hotkey);
    } catch {
      // A hook that will not take a new binding keeps the old one and says so through
      // `hotkey.failure`. It must not take the settings write down with it.
    }
  }

  async function recheck(): Promise<void> {
    // Re-tested after EVERY suspension, not once at the top. This used to check once and
    // then perform two awaits, during which a press could land — a check-then-act across
    // a suspension point on the one variable both paths wrote.
    if (isRunning()) return;
    await deps.audio.warmUp().catch(() => undefined);

    if (isRunning()) return;
    await prepareEngines({ eagerly: deps.settings.current().preloadAllLanguages });

    if (isRunning()) return;
    settleReadiness();
  }

  // ---- the gesture ---------------------------------------------------------------
  //
  // OVERLAPPING DICTATIONS, AS ON THE MAC (DictationController.press, 1.0).
  //
  // A press is admitted whenever the key is not already down — INCLUDING while earlier
  // dictations are still transcribing, polishing or pasting. Refusing it with "Still
  // finishing the last one." is the opposite of what someone dictating in bursts wants:
  // they have already moved on to the next sentence. Three things make the overlap safe,
  // and they are the whole of the admission design:
  //
  //   * AUDIO. Each press gets its own take. A take opening while the previous one has not
  //     yet been stopped seals the previous one at that sample, on the same running
  //     capture — nothing restarts, nothing is lost at the seam, nothing is shared.
  //   * PASTE ORDER. Each press takes a ticket in `turns` at key-down, and its first
  //     insert waits for its turn. N pastes before N+1, whichever finishes first.
  //   * THE HUD. `hudOwner` names the dictation the HUD is showing — the newest press, or,
  //     after that press is cancelled, the newest run still in flight — and only it may
  //     write `dictation`.
  //     An older one finishing while the next is being spoken is recorded, persisted and
  //     pasted, but it does not take the HUD back from "Listening".
  //
  // What the old single-run gate protected against is still protected, by identity rather
  // than by refusal: a key-up finishes THE press waiting for it (`held`), a second key-up
  // finds nothing, and every run clears exactly its own entry in `runs` on every exit
  // path — so `isRunning` is self-clearing by construction.

  /** The dictation whose key is down right now. At most one. */
  interface HeldPress {
    readonly press: number;
    readonly take: AudioTake;
    /**
     * `take.start()`, called SYNCHRONOUSLY in `press()` — the Mac's order. The session's
     * `audio.start` hands back this same promise. It used to start only after the mode was
     * resolved, i.e. after a foreground read from `kotiba-input.exe`, which answers one
     * request at a time and is shared with the inserter: a press landing during the
     * previous dictation's paste (the overlap 1.0 exists for) opened the microphone only
     * after the paste, and a busy or respawning helper up to 5 s later — the first words
     * were never recorded.
     */
    readonly started: Promise<void>;
    readonly ticket: number;
    /** Resolves once the mode is resolved and the session is armed (or failed to arm). */
    armed: Promise<void>;
    session: DictationSession | null;
    mode: ModeDecision | null;
    appId: AppId | null;
    /** The take reached its ceiling; this key-up is the controller's, not the user's. */
    limited: boolean;
    /**
     * The polish chain, started at key-down — alongside arming, never in front of it — so
     * the text streamed during the hold can be polished during the hold. The key-up uses the
     * same one: one decision, not two.
     */
    chain: Promise<PolishChain> | null;
  }

  let held: HeldPress | null = null;
  /** Released dictations still transcribing, polishing or pasting, by press. */
  const runs = new Map<number, Promise<void>>();
  /** Counts presses. The newest one owns the HUD. */
  let pressCount = 0;
  /**
   * The press whose progress the HUD shows. The newest press takes it; a cancelled press
   * hands it BACK to the newest run still finishing, whose outcome would otherwise never
   * be shown — the tray reading "idle" mid-transcription and the pill never dismissed.
   */
  let hudOwner = 0;
  /**
   * Paging the model in behind the user's speech. NEVER awaited on the key-up path — a
   * cold 7.8 s Uzbek load awaited there held the microphone open past the key-up and
   * transcribed the room. Kept only so `dispose()` can let it finish.
   */
  let preloadTask: Promise<void> | null = null;

  function heldPress(): HeldPress | null {
    return held;
  }
  function runCount(): number {
    return runs.size;
  }

  /** Write the dictation half, but only for the press that owns the HUD. */
  function setDictationFor(press: number, next: DictationStatus): void {
    if (press === hudOwner) setDictation(next);
  }

  /** An insert that waits for this press's turn, and passes the turn on either way. */
  function orderedInsert(ticket: number): (text: string) => Promise<InsertionOutcome> {
    return async (text: string) => {
      await turns.waitForTurn(ticket);
      try {
        return await deps.inserter.insert(text);
      } finally {
        turns.finish(ticket);
      }
    };
  }

  function press(): void {
    if (disposed) return;
    // A second key-down with the key already down is a stuck modifier or a lost key-up,
    // not a new dictation — and never a reason to show an error over the one being
    // recorded. Earlier dictations still finishing do NOT refuse a press.
    if (held !== null) return;

    pressCount += 1;
    const press = pressCount;
    hudOwner = press;
    const settings = deps.settings.current();
    // Synchronously, before the first await: the order of tickets IS the order of presses.
    const ticket = turns.issue();
    const take = deps.audio.openTake({ onLimit: () => captureLimitReached(press) });
    // The microphone first, before anything that waits on a helper. Its failure is the
    // session's to report (its `arm()` awaits this same promise); never unhandled here.
    const started = take.start();
    started.catch(() => undefined);
    if (settings.duckingEnabled) ducker.duck(settings.duckLevel);

    const current: HeldPress = {
      press,
      take,
      started,
      ticket,
      armed: Promise.resolve(),
      session: null,
      mode: null,
      appId: null,
      limited: false,
      chain: null,
    };
    const armed = (async () => {
      const appId = await foregroundAppId();
      const decision = ports.modes.resolveMode({
        modes: deps.modes as BuiltInModeTable,
        settings,
        userPickedModeKey,
        foregroundApp: appId,
      });
      current.appId = appId;
      current.mode = decision;
      const pinAtPress = pinAtPressFor(decision.mode, settings);
      // The chain asks the credential gate itself, so a password field gets NO_POLISH
      // here exactly as it would at key-up. A chain that will not build is the raw
      // transcript, never a refused press. NOT awaited: a credential read must not sit
      // between the key and the microphone.
      let chainNow: PolishChain | null = null;
      const chain = makePolishChain(decision.mode, appId).catch(() => NO_POLISH);
      current.chain = chain;
      void chain.then((built) => {
        chainNow = built;
        // The modes' model, with this mode's prompts prefilled, behind the user's speech —
        // the Mac's key-down `IncrementalPolish.prepare()`. Loading it cold is seconds;
        // after that a prefill is milliseconds.
        if (isIncrementalPolisher(built.polisher)) {
          void built.polisher
            .begin(pinAtPress ?? settings.defaultLanguage)
            .prepare()
            .catch(() => undefined);
        }
      });
      const built = buildSession(decision.mode, take, ticket, {
        started,
        pinAtPress,
        polisher: () => chainNow?.polisher ?? null,
      });
      current.session = built;

      // Page the model in behind the user's speech. An OPTIMISATION and nothing more —
      // the session loads a cold engine itself rather than refusing it — and NOT part of
      // arming, for the reason `preloadTask` states.
      preloadTask = deps.engines
        .prepare({ eagerly: settings.preloadAllLanguages })
        .catch(() => undefined);

      await built.arm();
      if (built.state.kind === 'failed') {
        setDictationFor(press, {
          kind: 'failed',
          message: built.state.error.message,
          pill: dictationErrorHeadline(built.state.error),
        });
      }
    })();
    // The arming task owns its own failure. Anything it throws would otherwise land as an
    // unhandled rejection and take the main process with it.
    armed.catch(() => undefined);
    // ONE object: the arming body writes the session and the mode into `current`, and the
    // key-up reads them from `held`, so the two must be the same object.
    current.armed = armed;
    held = current;
    // After `held`: the status a listener reads is `isRunning ? dictation : readiness`.
    setDictation({ kind: 'listening' });
  }

  function release(): void {
    if (disposed) return;
    // A key-up with no press waiting for it — a second key-up for one press, a helper
    // restarting mid-chord — opens nothing and clears nothing.
    const releasing = held;
    if (releasing === null) return;
    held = null;
    ducker.restore();

    const { press, ticket } = releasing;
    const task = (async () => {
      try {
        // The session is built inside `press()`'s async body. A key-up that outruns it
        // waits here; the session's own arming waiter list handles the narrower race
        // where `arm()` is already inside `audio.start()`.
        await releasing.armed;
        const running = releasing.session;
        const decision = releasing.mode;
        if (running === null || decision === null) {
          // No session will ever stop this take, and it was started at key-down: stop it
          // here — after its start settles, or the stop finds nothing and the start then
          // opens a microphone nobody closes.
          await releasing.started.catch(() => undefined);
          await releasing.take.stop().catch(() => undefined);
          return;
        }
        const mode = decision.mode;
        // Captured for THIS press: the credential gate asks it again further down.
        const appId = releasing.appId;

        const chain = await (releasing.chain ?? makePolishChain(mode, appId));
        const polisher: Polisher | null = chain.polisher;
        const settings = deps.settings.current();
        const language = mode.language ?? settings.defaultLanguage;
        const instructions = polisher === null ? null : instructionsFor(mode, appId, language);
        const policy = polishPolicyFor(mode);

        const record = await running.finish({
          pin: effectivePin(mode, settings, (deps.engines.languageIdentifier?.() ?? null) !== null || deps.engines.detector() !== null),
          polisher,
          polishInstructions: instructions,
          polishGuard: policy.guard,
          insertAfterPolish: policy.insertAfterPolish,
          drainPolishNotes: chain.drainNotes?.bind(chain),
        });

        // `modeKey` and `polishID` are written by the CONTROLLER after the session
        // returns, not by the session — it does not know which mode ran.
        const stamped: DictationRecord = {
          ...record,
          modeKey: mode.key,
          ...(polisher === null ? {} : { polishID: polisher.id }),
        };
        lastRecord = stamped;
        await settleRun(stamped, running, press);
      } catch (error: unknown) {
        // A throw anywhere above must still say something — the taxonomy's sentence,
        // never a hand-written copy of it.
        const failure = dictationError.captureFailed(describe(error));
        setDictationFor(press, { kind: 'failed', message: failure.message, pill: dictationErrorHeadline(failure) });
      } finally {
        // Its paste has happened, or will not: the next dictation in line may go.
        // Idempotent — the ordered insert already passed the turn if it inserted — and it
        // must run on EVERY path, or every later dictation waits out the patience.
        turns.finish(ticket);
        // The run is over, so stop saying it is not. Each run removes exactly its own
        // entry, as the last thing it does: that is what keeps `isRunning` self-clearing.
        runs.delete(press);
        publish();
      }
    })();
    runs.set(press, task);
    task.catch(() => undefined);
    // After `runs.set`, for the same reason as `listening` above. The released press is
    // always the newest, so it still owns the HUD — unless this key-up is the ceiling's,
    // which says so itself.
    if (!releasing.limited) setDictationFor(press, { kind: 'working', stage: 'transcribing' });
  }

  async function settleRun(record: DictationRecord, ran: DictationSession, press: number): Promise<void> {
    const state = ran.state;
    // THE HUD IS THE NEWEST DICTATION'S. An older one finishing while the next is being
    // spoken is recorded and persisted, but it does not replace "Listening".
    const ownsHud = press === hudOwner && held === null;
    const show = (status: DictationStatus): void => {
      if (ownsHud) setDictation(status);
    };
    // Decided once per finished take, whatever its outcome: a dictation that came out as text
    // clears the notice, a qualifying heard-nothing take raises it (at most once per device
    // per hour), and only a take that owns the HUD may put the device name on the pill.
    if (record.outcome === 'done') quietMic = null;
    const suspect = state.kind === 'heardNothing' ? quietMicSuspect(record) : null;
    const hint = suspect !== null && quietMicLimiter.admit(suspect, clock.now()) ? suspect : null;
    if (hint !== null) quietMic = hint;
    if (state.kind === 'done') {
      show({ kind: 'succeeded', text: record.polished ?? record.result ?? '' });
      // Counted for the Turkish check's threshold — a delivered Turkish dictation, pinned or not —
      // and the Arabic check's (C4 §14.1), and every language's for the language decision's prior
      // (`languageLogPrior`, P4): the Mac's `countDictation(in:)`.
      const language = record.route?.language;
      if (language !== undefined) {
        const key = DICTATION_COUNT_KEY[language];
        await deps.settings.update({ [key]: deps.settings.current()[key] + 1 });
      }
      await persist(record);
    } else if (state.kind === 'heardNothing') {
      show(hint === null || !ownsHud ? { kind: 'heardNothing' } : { kind: 'heardNothing', quietMic: hint });
      await persist(record);
    } else if (state.kind === 'failed') {
      show({ kind: 'failed', message: state.error.message, pill: dictationErrorHeadline(state.error) });
      await persist(record);
    } else {
      show({ kind: 'failed', message: `the dictation ended in ${state.kind}` });
    }
  }

  async function persist(record: DictationRecord): Promise<void> {
    const settings = deps.settings.current();
    if (settings.diagnosticsEnabled) {
      try {
        await deps.diagnostics.append(record);
        diagnosticsWriteError = null;
      } catch (error: unknown) {
        // A store that opened and then stopped taking writes is a DIFFERENT fact from
        // one that never opened, and the two want different answers from the user.
        diagnosticsWriteError = describe(error);
      }
    }
    const result = record.result;
    if (!settings.keepHistory || result === undefined || result === '') return;
    const entry: HistoryEntry = {
      id: newId(),
      startedAt: record.startedAt,
      language: record.route?.language ?? settings.defaultLanguage,
      engineID: record.engineID ?? 'unknown',
      raw: record.raw ?? result,
      result,
      polished: record.polished ?? null,
      audioSeconds: record.audioSeconds,
      audioPath: null,
    };
    try {
      await deps.history.insert(entry);
      // Enforce the retention the user asked for, here rather than never. 0 keeps
      // everything, which is the shipped default and what the setting documents.
      await deps.history.prune(settings.historyLimit);
      historyWriteError = null;
    } catch (error: unknown) {
      historyWriteError = describe(error);
    }
  }

  /**
   * D-W4: a chord during the hold. Discards the dictation whose key is down — and ONLY
   * that one. Dictations already released carry on: the user has finished with those.
   */
  function cancel(reason: string): void {
    const cancelled = held;
    if (cancelled === null) return;
    held = null;
    ducker.restore();
    // Nothing was inserted, so there is no outcome to keep on screen — unless an earlier
    // dictation is still finishing, which then gets the HUD back and says so.
    if (cancelled.press === hudOwner) {
      const newestRun = Math.max(0, ...runs.keys());
      if (newestRun > 0) {
        hudOwner = newestRun;
        setDictation({ kind: 'working', stage: 'transcribing' });
      } else {
        setDictation({ kind: 'idle' });
      }
    }
    void (async () => {
      // After arming, never before: a stop that overtakes the start finds no take to
      // end, and the start then opens one nobody will ever close.
      await cancelled.armed.catch(() => undefined);
      if (cancelled.session !== null) {
        await cancelled.session.cancel(reason).catch(() => undefined);
      } else {
        // The take started at key-down; let that settle first (see `release`).
        await cancelled.started.catch(() => undefined);
        await cancelled.take.stop().catch(() => undefined);
      }
      turns.finish(cancelled.ticket);
      publish();
    })();
  }

  /**
   * The held dictation reached its take's ceiling (30 minutes). Finish it as though the
   * key had come up, and say why — the alternative is audio silently not being kept.
   */
  function captureLimitReached(press: number): void {
    if (held === null || held.press !== press) return;
    held.limited = true;
    release();
    setDictationFor(press, { kind: 'working', stage: CAPTURE_LIMIT_STAGE });
  }

  // ---- settings ------------------------------------------------------------------

  /**
   * Once per install: the per-language counts the language decision's prior reads start from the
   * user's History, where there is one (P4, the Mac's `seedLanguageCounts`). The Turkish and
   * Arabic counts existed already and are kept when larger. Marked seeded even when History
   * cannot count (a fake, an error): seeding is a convenience, never a reason to ask again.
   */
  async function seedLanguageCounts(): Promise<void> {
    const settings = deps.settings.current();
    if (settings.languageCountsSeeded) return;
    const counts = await deps.history.countsByLanguage?.().catch(() => null);
    const patch: Partial<Record<(typeof DICTATION_COUNT_KEY)[Language], number>> = {};
    if (counts !== null && counts !== undefined) {
      for (const language of Object.keys(DICTATION_COUNT_KEY) as Language[]) {
        const key = DICTATION_COUNT_KEY[language];
        patch[key] = Math.max(settings[key], counts[language] ?? 0);
      }
    }
    await deps.settings.update({ ...patch, languageCountsSeeded: true }).catch(() => undefined);
  }

  async function settingsChanged(): Promise<void> {
    const settings = deps.settings.current();
    await syncHotkeyBinding();
    try {
      await deps.engines.reconfigure(settings);
    } catch (error: unknown) {
      loadFailures.set(settings.defaultLanguage, describe(error));
    }
    settleReadiness();
  }

  async function setMode(key: string): Promise<void> {
    // The tray menu's behaviour: pick it for this session AND make it the default.
    userPickedModeKey = key;
    await deps.settings.update({ defaultModeKey: key });
  }

  async function setDefaultMode(key: string): Promise<void> {
    // The Settings picker's behaviour. It must NOT latch a pin: calling `setMode` here
    // set `userPickedModeKey`, and since resolution checks the pick before it checks
    // `modeFollowsApp`, changing the FALLBACK silently turned app-following off — with
    // its toggle still showing on, and permanently, because nothing ever wrote null back.
    await deps.settings.update({ defaultModeKey: key });
  }

  function clearPickedMode(): void {
    userPickedModeKey = null;
  }

  async function setPinnedLanguage(language: Language | null): Promise<void> {
    // `null` means Automatic and is a REAL choice, so it is assigned unconditionally.
    await deps.settings.update({ pinnedLanguage: language });
  }

  // ---- blockers ------------------------------------------------------------------

  function blockers(): readonly Blocker[] {
    const found: Blocker[] = [];
    const settings = deps.settings.current();

    if (deps.hotkey.failure !== null) {
      found.push({
        id: 'hotkey',
        headline: t('blk.the_push_to_talk_key_is'),
        detail: t('blk.hotkeyFailure', { why: deps.hotkey.failure }),
      });
    }
    // Only when the user can do something about it. A changed device or an ended stream is
    // rebuilt by the next press and every foreground's warm-up, and a dictation it still
    // breaks says so in the pill; listing it here put a "not ready" banner up for a state
    // that fixes itself (owner's review, 2026-09-30).
    if (!deps.audio.isWarm && (deps.audio.warmUpNeedsTheUser ?? true)) {
      found.push({
        id: 'microphone',
        headline: t('blk.the_microphone_is_not_ready'),
        detail: deps.audio.lastWarmUpError ?? t('blk.allowMicrophone'),
      });
    }
    for (const [language, why] of [...loadFailures.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : 1,
    )) {
      found.push({
        id: language === 'uz' ? 'uzbek-model' : 'russian-model',
        headline: t('blk.modelWouldNotLoad', { language: speechLanguageName(language) }),
        detail: why,
      });
    }
    if (historyOpenError !== null) {
      found.push({
        id: 'history-store',
        headline: t('blk.history_could_not_be_opened'),
        detail: t('blk.historyOpen', { why: historyOpenError }),
      });
    } else if (historyWriteError !== null) {
      found.push({
        id: 'history-store',
        headline: t('blk.history_has_stopped_saving'),
        detail: t('blk.historyWrite', { why: historyWriteError }),
      });
    }
    if (diagnosticsOpenError !== null) {
      found.push({
        id: 'diagnostics-store',
        headline: t('blk.diagnostics_could_not_be_recorded'),
        detail: t('blk.diagnosticsOpen', { why: diagnosticsOpenError }),
      });
    } else if (diagnosticsWriteError !== null) {
      found.push({
        id: 'diagnostics-store',
        headline: t('blk.diagnostics_have_stopped_recording'),
        detail: t('blk.diagnosticsWrite', { why: diagnosticsWriteError }),
      });
    }
    if (deps.settings.loadFailure !== null) {
      found.push({
        id: 'settings',
        headline: t('blk.some_settings_could_not_be_read'),
        detail: t('blk.settingsKept', { why: deps.settings.loadFailure }),
      });
    }
    // A model that is simply NOT CHOSEN is a different fact from one that will not load,
    // and saying so is the difference between "choose a model" and "this file is broken".
    if (lastReadiness !== null) {
      if (lastReadiness.uzbek === 'notInstalled') {
        found.push({
          id: 'uzbek-model',
          headline: t('blk.no_uzbek_model'),
          detail: t('blk.uzbek_dictation_needs_a_whisper_cpp'),
        });
      }
      // NOT gated on `defaultLanguage === 'ru'`. The `unified` family serves English AND
      // Russian, and a user reaches it through a pin, through the acoustic router, or
      // through a default that is simply not Uzbek — none of which the default language
      // alone answers. Gating on it hid a missing model from everyone who can pick
      // Russian without having made it their default, which is most of this audience.
      //
      // The one user it genuinely does not affect is the one who has locked everything to
      // Uzbek: a pin to `uz`, or an Uzbek default with detection off. For them the model
      // is not missing, it is unwanted, and a blocker they cannot act on is noise.
      const reachesUnified =
        settings.pinnedLanguage !== null
          ? settings.pinnedLanguage !== 'uz'
          : detectionWanted(settings) || settings.defaultLanguage !== 'uz';
      const unifiedOn = settings.enabledLanguages.includes('en') || settings.enabledLanguages.includes('ru');
      if (lastReadiness.unified === 'notInstalled' && reachesUnified && unifiedOn) {
        found.push({
          id: 'russian-model',
          headline: t('blk.no_russian_model'),
          detail: t('blk.english_and_russian_dictation_both_need'),
        });
      }
      if (detectionWanted(settings) && lastReadiness.detector !== 'ready') {
        found.push({
          id: 'detector-model',
          headline: t('blk.language_detection_is_off'),
          detail: t('blk.no_detector_model_is_loaded_so'),
        });
      }
    }
    return found;
  }

  // ---- the public surface --------------------------------------------------------

  const controller: DictationController = {
    get status() {
      return currentStatus();
    },
    get isRunning() {
      return isRunning();
    },
    get lastRecord() {
      return lastRecord;
    },
    get quietMic() {
      return quietMic;
    },
    dismissQuietMic(): void {
      quietMic = null;
    },
    start,
    recheck,
    press,
    release,
    cancel,
    settingsChanged,
    resolveMode,
    setMode,
    setDefaultMode,
    clearPickedMode,
    setPinnedLanguage,
    blockers,
    onStatusChange(listener: (status: DictationStatus) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose(): Promise<void> {
      disposed = true;
      hotkeyOff?.();
      hotkeyOff = null;
      settingsOff?.();
      settingsOff = null;
      await Promise.allSettled([...runs.values()]);
      if (preloadTask !== null) await preloadTask.catch(() => undefined);
      listeners.clear();
      await Promise.allSettled([
        deps.hotkey.stop(),
        deps.audio.dispose(),
        deps.inserter.dispose(),
        deps.engines.dispose(),
        deps.history.close(),
        deps.diagnostics.close(),
      ]);
    },
  };
  return controller;
}

// ---------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------

/** `PROMPT_DATETIME_FORMAT` — `yyyy-MM-dd HH:mm`, in UTC so a golden is stable. */
export function promptDatetime(epochMillis: number): string {
  return new Date(epochMillis).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * The three statuses that are the RESULT of a dictation rather than a step in one.
 *
 * `isBusy` names the other end of the same axis and deliberately does not name these:
 * `idle`, `preparing`, `listening` and `working` all mean "nothing has come out yet".
 */
function isOutcome(status: DictationStatus): boolean {
  return status.kind === 'succeeded' || status.kind === 'heardNothing' || status.kind === 'failed';
}

function sameStatus(a: DictationStatus, b: DictationStatus): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'preparing' && b.kind === 'preparing') return a.what === b.what;
  if (a.kind === 'working' && b.kind === 'working') return a.stage === b.stage;
  if (a.kind === 'succeeded' && b.kind === 'succeeded') return a.text === b.text;
  if (a.kind === 'failed' && b.kind === 'failed') return a.message === b.message;
  if (a.kind === 'heardNothing' && b.kind === 'heardNothing') return a.quietMic?.name === b.quietMic?.name;
  return true;
}

/** Not `node:crypto`: `src/session` must stay runnable in a plain test process. */
let counter = 0;
function defaultId(): string {
  counter += 1;
  return `dictation-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export { isTerminal };
