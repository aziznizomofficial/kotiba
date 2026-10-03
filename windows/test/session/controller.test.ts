// The controller: the admission gate, the readiness/dictation split, mode resolution,
// the credential gate (both of them) and what gets persisted.

import { describe as suite, expect, test } from 'vitest';
import {
  DEFAULT_POLISH_GUARD,
  DEFAULT_SESSION_CONFIG,
  RESTRUCTURING_POLISH_GUARD,
} from '../../src/contracts/index.js';
import type {
  DictationStatus,
  EngineFamily,
  Language,
  Mode,
  ModeKey,
  Settings,
} from '../../src/contracts/index.js';
import {
  CAPTURE_LIMIT_STAGE,
  createDictationController,
  pinFor,
  polishPolicyFor,
} from '../../src/session/index.js';
import type { ControllerDeps, PlaybackDucking, PolishChain } from '../../src/session/index.js';
import {
  FakeAudio,
  FakeDiagnostics,
  FakeEngine,
  FakeEngineManager,
  FakeFocus,
  FakeHistory,
  FakeHotkey,
  FakeInserter,
  FakeModels,
  FakePolisher,
  FakeSecrets,
  FakeSettings,
  ManualClock,
  NO_AUDIO,
  SILENCE_7_4,
  fakeModes,
  fakePorts,
  flush,
  tone,
} from './fakes.js';
import type { PortOverrides } from './fakes.js';

interface Rig {
  readonly controller: ReturnType<typeof createDictationController>;
  readonly audio: FakeAudio;
  readonly inserter: FakeInserter;
  readonly engines: FakeEngineManager;
  readonly unified: FakeEngine;
  readonly uzbek: FakeEngine;
  readonly focus: FakeFocus;
  readonly settings: FakeSettings;
  readonly secrets: FakeSecrets;
  readonly history: FakeHistory;
  readonly diagnostics: FakeDiagnostics;
  readonly hotkey: FakeHotkey;
  readonly clock: ManualClock;
  readonly statuses: DictationStatus[];
  /**
   * The last status the DICTATION half published.
   *
   * The outcome of a run now stays visible until the next press, so for a healthy app
   * this is usually the final value too — but readiness still outranks it when the app
   * has something of its own to say, and then only the stream carries the outcome.
   */
  lastRun(): DictationStatus | undefined;
  /** One whole dictation: press, let arming settle, release, let the run finish. */
  dictate(): Promise<void>;
}

function rig(
  options: {
    readonly settings?: Partial<Settings>;
    readonly ports?: PortOverrides;
    readonly polishChain?: (mode: Mode) => PolishChain;
    readonly apiKey?: string;
    readonly ducking?: PlaybackDucking;
  } = {},
): Rig {
  const clock = new ManualClock();
  const audio = new FakeAudio(clock);
  const inserter = new FakeInserter();
  const focus = new FakeFocus();
  const settings = new FakeSettings(options.settings);
  const secrets = new FakeSecrets();
  if (options.apiKey !== undefined) {
    secrets.values.set(settings.current().polishKeyAccount, options.apiKey);
  }
  const history = new FakeHistory();
  const diagnostics = new FakeDiagnostics();
  const hotkey = new FakeHotkey();
  const engines = new FakeEngineManager();
  const unified = new FakeEngine('unified-v3-turbo', new Set<Language>(['en', 'ru']), clock);
  const uzbek = new FakeEngine('whisper-ggml-uzbek-stt-v1-q5_0', new Set<Language>(['uz']), clock);
  engines.engines.set('unified' as EngineFamily, unified);
  engines.engines.set('uzbek' as EngineFamily, uzbek);

  const ports = fakePorts({
    ...options.ports,
    clock,
    // Only set when given: an explicit `undefined` after the spread would clobber a
    // chain supplied through `options.ports`.
    ...(options.polishChain === undefined
      ? {}
      : { polishChain: ({ mode }: { mode: Mode }) => options.polishChain!(mode) }),
  });

  const statuses: DictationStatus[] = [];
  const deps: ControllerDeps = {
    settings,
    secrets,
    engines,
    audio,
    inserter,
    hotkey,
    focus,
    history,
    diagnostics,
    models: new FakeModels(),
    modes: fakeModes(),
    config: DEFAULT_SESSION_CONFIG,
    ports,
    ...(options.ducking === undefined ? {} : { ducking: options.ducking }),
    newId: (() => {
      let n = 0;
      return () => `id-${(n += 1)}`;
    })(),
  };
  const controller = createDictationController(deps);
  controller.onStatusChange((status) => statuses.push(status));

  return {
    controller,
    audio,
    inserter,
    engines,
    unified,
    uzbek,
    focus,
    settings,
    secrets,
    history,
    diagnostics,
    hotkey,
    clock,
    statuses,
    lastRun: () => statuses.filter((s) => s.kind !== 'idle').at(-1),
    async dictate() {
      controller.press();
      await flush();
      controller.release();
      await flush();
    },
  };
}

// ---------------------------------------------------------------------------------
// The quiet-microphone hint
// ---------------------------------------------------------------------------------

suite('the quiet-microphone hint', () => {
  const phone = { name: 'Test iPhone Microphone', transport: 'continuity', sampleRate: 48_000, overrodeDefault: false } as const;
  const desk = { name: 'Test Desk Mic', transport: 'usb', sampleRate: 44_100, overrodeDefault: false } as const;
  const quiet = (device: typeof phone | typeof desk | undefined, seconds = 8) => ({
    ...tone(seconds, 0.008),
    ...(device === undefined ? {} : { device }),
  });

  test('a long, near-silent take names the microphone on the pill status and on Home', async () => {
    const r = rig();
    r.audio.buffer = quiet(phone);
    await r.dictate();
    expect(r.lastRun()).toEqual({ kind: 'heardNothing', quietMic: phone });
    expect(r.controller.quietMic).toEqual(phone);
  });

  test('a tap, or a take with no known device, keeps the ordinary message', async () => {
    const r = rig();
    r.audio.buffer = quiet(phone, 1);
    await r.dictate();
    expect(r.lastRun()).toEqual({ kind: 'heardNothing' });
    r.audio.buffer = quiet(undefined);
    await r.dictate();
    expect(r.lastRun()).toEqual({ kind: 'heardNothing' });
    expect(r.controller.quietMic).toBeNull();
  });

  test('once per device per hour: the rest of the burst gets the plain message', async () => {
    const r = rig();
    r.audio.buffer = quiet(phone);
    await r.dictate();
    expect(r.controller.quietMic).toEqual(phone);
    r.controller.dismissQuietMic();
    await r.dictate();
    expect(r.lastRun()).toEqual({ kind: 'heardNothing' });
    expect(r.controller.quietMic).toBeNull();
    // Another device is its own count.
    r.audio.buffer = quiet(desk);
    await r.dictate();
    expect(r.lastRun()).toEqual({ kind: 'heardNothing', quietMic: desk });
    // An hour later the first may speak again.
    await r.clock.advance(3_600_000);
    r.audio.buffer = quiet(phone);
    await r.dictate();
    expect(r.lastRun()).toEqual({ kind: 'heardNothing', quietMic: phone });
  });

  test('a dictation that comes out as text clears the notice', async () => {
    const r = rig();
    r.audio.buffer = quiet(phone);
    await r.dictate();
    expect(r.controller.quietMic).not.toBeNull();
    r.audio.buffer = { samples: new Float32Array(16000).fill(0.4), droppedSamples: 0 };
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('succeeded');
    expect(r.controller.quietMic).toBeNull();
  });

  test('the record that is persisted carries the device', async () => {
    const r = rig();
    r.audio.buffer = quiet(phone);
    await r.dictate();
    expect(r.diagnostics.appended[0]?.inputDevice).toEqual(phone);
  });
});

// ---------------------------------------------------------------------------------
// FAILURE 3 — the latched admission gate
// ---------------------------------------------------------------------------------

suite('the admission gate', () => {
  test('TEN consecutive dictations all complete — two would not have caught it', async () => {
    const r = rig();
    for (let i = 0; i < 10; i += 1) {
      r.unified.text = `utterance ${i}`;
      await r.dictate();
      expect(r.controller.isRunning).toBe(false);
      expect(r.lastRun()).toEqual({ kind: 'succeeded', text: `Utterance ${i}` });
    }
    expect(r.inserter.inserted).toHaveLength(10);
    expect(r.inserter.inserted).toEqual(
      Array.from({ length: 10 }, (_, i) => `Utterance ${i}`),
    );
    // Not one of them was refused.
    expect(r.statuses.filter((s) => s.kind === 'failed')).toEqual([]);
  });

  test('the gate CLEARS after a failed dictation, and after a heardNothing one', async () => {
    const r = rig();

    r.audio.buffer = NO_AUDIO;
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('failed');
    expect(r.controller.isRunning).toBe(false);

    r.audio.buffer = SILENCE_7_4;
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('heardNothing');
    expect(r.controller.isRunning).toBe(false);

    r.audio.buffer = { samples: new Float32Array(16000).fill(0.4), droppedSamples: 0 };
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('succeeded');
    expect(r.controller.isRunning).toBe(false);
  });

  test('the gate clears even when the run THROWS on a path nobody expected', async () => {
    const r = rig();
    // A store that explodes inside settle. The gate must still open.
    r.diagnostics.appendError = new Error('disk full');
    await r.dictate();
    expect(r.controller.isRunning).toBe(false);

    r.diagnostics.appendError = null;
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('succeeded');
  });

  test('a press while one is PROCESSING starts a new take at once (1.0, Mac parity)', async () => {
    const r = rig();
    r.unified.script.push({ text: 'first thought', delayMs: 8_000 });
    r.controller.press();
    await flush();
    r.controller.release();
    await flush();
    expect(r.controller.isRunning).toBe(true);

    // The second press is ADMITTED while the first is still transcribing: its own take,
    // the microphone open again, "Listening" on the HUD.
    r.unified.script.push({ text: 'second thought', delayMs: 0 });
    r.controller.press();
    await flush();
    expect(r.controller.status).toEqual({ kind: 'listening' });
    expect(r.audio.takes).toHaveLength(2);
    expect(r.audio.takes[1]?.capturing).toBe(true);
    r.controller.release();
    await flush();

    // The second finished first — and still waits for the first to paste.
    expect(r.inserter.inserted).toEqual([]);
    await r.clock.advance(9_000);
    await flush();
    expect(r.inserter.inserted).toEqual(['First thought', 'Second thought']);
    expect(r.controller.isRunning).toBe(false);
  });

  test('a second key-down with the key already down is ignored, not an error', async () => {
    const r = rig();
    r.controller.press();
    await flush();
    r.controller.press();
    await flush();
    expect(r.controller.status).toEqual({ kind: 'listening' });
    expect(r.audio.takes).toHaveLength(1);
    r.controller.release();
    await flush();
    expect(r.inserter.inserted).toEqual(['Hello world']);
  });

  test('ADMISSION IS NOT isBusy: preparing a model must not refuse a press', async () => {
    const r = rig();
    // `recheck()` runs on every foreground and sets readiness. That is the state the
    // macOS gate collapsed into the admission check.
    await r.controller.recheck();
    expect(r.controller.isRunning).toBe(false);
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------------
// The readiness / dictation split
// ---------------------------------------------------------------------------------

suite('the readiness and dictation split', () => {
  test('the dictation wins while one is in flight, and readiness answers otherwise', async () => {
    const r = rig();
    r.engines.readinessValue = { ...r.engines.readinessValue, unified: 'corrupt' };
    await r.controller.recheck();
    // Nothing running: the app's own state answers.
    expect(r.controller.status.kind).toBe('failed');

    r.controller.press();
    await flush();
    expect(r.controller.status).toEqual({ kind: 'listening' });

    r.controller.release();
    await flush();
    // The run is over, so readiness answers again — the model is still corrupt.
    expect(r.controller.status.kind).toBe('failed');
    // `lastRun()` cannot help here — readiness publishes a `failed` of its own — so the
    // stream itself is the assertion: the dictation half did reach `succeeded`.
    expect(r.statuses.some((s) => s.kind === 'succeeded')).toBe(true);
  });

  test('a model that will not load is never erased by settling back to idle', async () => {
    const r = rig();
    r.engines.readinessValue = { ...r.engines.readinessValue, uzbek: 'corrupt' };
    await r.controller.recheck();
    expect(r.controller.status.kind).toBe('failed');
    await r.controller.recheck();
    expect(r.controller.status.kind).toBe('failed');
  });

  test('listeners see every distinct status and no duplicates', async () => {
    const r = rig();
    await r.dictate();
    // AND IT STOPS AT THE OUTCOME. This used to pin a trailing `idle`, published from the
    // run's own `finally` in the same turn as `succeeded` — so the transcript was the
    // visible status for exactly one event and the HUD had nothing left to render by the
    // time it looked. The outcome is the last thing said until the next press.
    expect(r.statuses.map((s) => s.kind)).toEqual(['listening', 'working', 'succeeded']);
    expect(r.controller.status).toEqual({ kind: 'succeeded', text: 'Hello world' });
  });

  test('the outcome stays on screen until the next press replaces it', async () => {
    const r = rig();

    await r.dictate();
    expect(r.controller.status).toEqual({ kind: 'succeeded', text: 'Hello world' });
    // Nothing else the app does to itself disturbs it: a recheck that finds everything
    // healthy settles readiness back to idle, which is not something to show over a
    // transcript the user has not looked at yet.
    await r.controller.recheck();
    expect(r.controller.status).toEqual({ kind: 'succeeded', text: 'Hello world' });

    r.controller.press();
    await flush();
    expect(r.controller.status).toEqual({ kind: 'listening' });
    r.controller.release();
    await flush();

    // heardNothing and failed linger for exactly the same reason: they are the only
    // account the user gets of a dictation that produced no text.
    r.audio.buffer = SILENCE_7_4;
    await r.dictate();
    expect(r.controller.status).toEqual({ kind: 'heardNothing' });
  });

  test('a model that will not load still outranks a lingering transcript', async () => {
    // The outcome outlives the run; it does not outrank the app saying something is
    // broken. Burying a load failure under a minute-old transcript is the erasure
    // `settleReadiness` exists to prevent.
    const r = rig();
    await r.dictate();
    expect(r.controller.status.kind).toBe('succeeded');

    r.engines.readinessValue = { ...r.engines.readinessValue, uzbek: 'corrupt' };
    await r.controller.recheck();
    expect(r.controller.status.kind).toBe('failed');
  });
});

// ---------------------------------------------------------------------------------
// THE CREDENTIAL GATE — a security property
// ---------------------------------------------------------------------------------

suite('the credential gate', () => {
  const alwaysPolishes = (): PolishChain => ({
    polisher: new FakePolisher('groq:llama-3.3-70b'),
    notConfigured: false,
    reason: null,
  });

  test('a password manager in front forces the raw, prompt-less mode', async () => {
    const r = rig();
    r.focus.app = { appId: '1password', displayName: '1Password' };
    const decision = await r.controller.resolveMode();
    expect(decision.source).toBe('credentialField');
    expect(decision.mode.key).toBe('transcription');
    expect(decision.mode.prompt).toBeNull();
  });

  test('NOTHING is sent to a polisher when the foreground app is a password manager', async () => {
    let chainRequested = false;
    const r = rig({
      polishChain: () => {
        chainRequested = true;
        return alwaysPolishes();
      },
      apiKey: 'sk-live-key',
    });
    r.focus.app = { appId: 'bitwarden', displayName: 'Bitwarden' };
    r.unified.text = 'correct horse battery staple';

    await r.dictate();

    expect(chainRequested).toBe(false);
    expect(r.inserter.inserted).toEqual(['Correct horse battery staple']);
    expect(r.controller.lastRecord?.polished).toBeUndefined();
    expect(r.controller.lastRecord?.polishID).toBeUndefined();
  });

  test('THE SECOND GATE: a prompted mode reaching the polisher is still refused', async () => {
    // A fix at one layer must not stop at the next. Here mode resolution is subverted —
    // it hands back a mode WITH a prompt for a password manager — and the polish layer
    // has to refuse anyway, because that is the layer that is protecting a secret.
    let chainRequested = false;
    const subverted = fakeModes();
    const r = rig({
      ports: {
        // Resolution that ignores the gate entirely.
        sensitiveApps: ['1password'],
        modes: subverted,
      },
      polishChain: () => {
        chainRequested = true;
        return alwaysPolishes();
      },
      apiKey: 'sk-live-key',
    });
    r.focus.app = { appId: '1password', displayName: '1Password' };
    // Pick a prompted mode by hand, which in a broken resolver would beat the gate.
    await r.controller.setMode('super');
    await r.dictate();

    expect(chainRequested).toBe(false);
    expect(r.controller.lastRecord?.polished).toBeUndefined();
  });

  test('an ordinary app DOES reach the polisher — the gate is not just "never polish"', async () => {
    let chainRequested = false;
    const r = rig({
      polishChain: () => {
        chainRequested = true;
        return alwaysPolishes();
      },
      apiKey: 'sk-live-key',
    });
    r.focus.app = { appId: 'telegram', displayName: 'Telegram' };
    await r.dictate();

    expect(chainRequested).toBe(true);
    expect(r.controller.lastRecord?.polished).toBe('Hello world.');
    expect(r.controller.lastRecord?.polishID).toBe('groq:llama-3.3-70b');
  });

  test('an UNKNOWN foreground app is not treated as safe by accident', async () => {
    const r = rig();
    r.focus.throws = new Error('the foreground window vanished');
    const decision = await r.controller.resolveMode();
    // `null` resolves to the `unknown` format, which is not sensitive — the table is the
    // whole defence, and this asserts we do not GUESS in either direction.
    expect(decision.source).not.toBe('credentialField');
  });
});

// ---------------------------------------------------------------------------------
// Mode resolution — four tiers, in order
// ---------------------------------------------------------------------------------

suite('mode resolution', () => {
  test('the four tiers, in strict precedence order', async () => {
    const modes = fakeModes({ note: { activationApps: ['obsidian'] } });
    const r = rig({
      ports: { modes },
      settings: { defaultModeKey: 'message', modeFollowsApp: true },
    });

    // 4. app-follow
    r.focus.app = { appId: 'obsidian', displayName: 'Obsidian' };
    expect(await r.controller.resolveMode()).toMatchObject({
      source: 'appFollow',
      mode: { key: 'note' },
    });

    // 3. the persisted default beats app-follow when modeFollowsApp is off
    await r.settings.update({ modeFollowsApp: false });
    expect(await r.controller.resolveMode()).toMatchObject({
      source: 'settingsDefault',
      mode: { key: 'message' },
    });

    // 2. a tray pick beats both, in ANY app — including one with an activation rule
    await r.settings.update({ modeFollowsApp: true });
    await r.controller.setMode('super');
    expect(await r.controller.resolveMode()).toMatchObject({
      source: 'userPicked',
      mode: { key: 'super' },
    });

    // 1. and the credential gate beats everything
    r.focus.app = { appId: '1password', displayName: '1Password' };
    expect(await r.controller.resolveMode()).toMatchObject({
      source: 'credentialField',
      mode: { key: 'transcription' },
    });
  });

  test('setDefaultMode must NOT latch a pin', async () => {
    const modes = fakeModes({ note: { activationApps: ['obsidian'] } });
    const r = rig({ ports: { modes }, settings: { modeFollowsApp: true } });
    r.focus.app = { appId: 'obsidian', displayName: 'Obsidian' };

    await r.controller.setDefaultMode('super');

    // The fallback changed, and app-following is STILL on. Calling setMode here turned
    // it off permanently, with its toggle still showing on.
    expect(r.settings.current().defaultModeKey).toBe('super');
    expect(await r.controller.resolveMode()).toMatchObject({ source: 'appFollow' });
  });

  test('setMode pins AND persists; clearPickedMode is the way back to Automatic', async () => {
    const modes = fakeModes({ note: { activationApps: ['obsidian'] } });
    const r = rig({ ports: { modes }, settings: { modeFollowsApp: true } });
    r.focus.app = { appId: 'obsidian', displayName: 'Obsidian' };

    await r.controller.setMode('super');
    expect(r.settings.current().defaultModeKey).toBe('super');
    expect(await r.controller.resolveMode()).toMatchObject({ source: 'userPicked' });

    r.controller.clearPickedMode();
    expect(await r.controller.resolveMode()).toMatchObject({ source: 'appFollow' });
  });

  test('the mode is resolved ONCE per dictation, at key-down', async () => {
    const r = rig({ settings: { defaultModeKey: 'super' } });
    r.controller.press();
    await flush();
    // The user switches app mid-hold. The dictation keeps the mode it started with.
    r.focus.app = { appId: '1password', displayName: '1Password' };
    r.controller.release();
    await flush();
    expect(r.controller.lastRecord?.modeKey).toBe('super');
  });
});

// ---------------------------------------------------------------------------------
// Polish policy and the pin
// ---------------------------------------------------------------------------------

suite('policy', () => {
  test('a restructuring mode gets the wide guard and inserts after the polish', () => {
    const modes = fakeModes();
    expect(polishPolicyFor(modes.note)).toEqual({
      guard: RESTRUCTURING_POLISH_GUARD,
      insertAfterPolish: true,
    });
    // Every BUILT-IN mode inserts once since 1.0, as on the Mac: its polish is on-device
    // and per sentence, and replace-after-paste was the commonest failure on record. The
    // guard still follows `restructures`.
    expect(polishPolicyFor(modes.super)).toEqual({
      guard: DEFAULT_POLISH_GUARD,
      insertAfterPolish: true,
    });
    // A mode that is not one of the four keeps paste-first.
    expect(polishPolicyFor({ ...modes.super, key: 'my-mode' } as unknown as typeof modes.super)).toEqual({
      guard: DEFAULT_POLISH_GUARD,
      insertAfterPolish: false,
    });
  });

  test('every built-in mode but Raw runs the deterministic clean-up, on the final text', async () => {
    const calls: { text: string; language: string; closes: boolean }[] = [];
    const r = rig({
      ports: {
        cleanUp: (text, language, options) => {
          calls.push({ text, language, closes: options?.closesFinalSentence ?? true });
          return `${text} [clean]`;
        },
      },
    });
    await r.dictate();
    expect(calls).toEqual([{ text: 'hello world', language: 'en', closes: true }]);
    expect(r.inserter.inserted[0]).toContain('[clean]');

    // A password field forces Raw: exactly what was said, no clean-up.
    calls.length = 0;
    r.focus.app = { appId: '1password', displayName: '1Password' };
    await r.dictate();
    expect(calls).toEqual([]);
  });

  test('the pin is the pinned language first, and the default only with no detector', () => {
    const withPin = { ...new FakeSettings({ pinnedLanguage: 'uz' }).current() };
    expect(pinFor(withPin, true)).toBe('uz');
    expect(pinFor(withPin, false)).toBe('uz');

    const automatic = new FakeSettings({ pinnedLanguage: null, defaultLanguage: 'ru' }).current();
    // A detector exists, so the router gets to decide — returning the default here would
    // pin every dictation and the classifier would never run.
    expect(pinFor(automatic, true)).toBeNull();
    // No detector: the default language is the only answer the router can give.
    expect(pinFor(automatic, false)).toBe('ru');
  });

  test('setPinnedLanguage(null) is a real choice and is written unconditionally', async () => {
    const r = rig({ settings: { pinnedLanguage: 'uz' } });
    await r.controller.setPinnedLanguage(null);
    expect(r.settings.current().pinnedLanguage).toBeNull();
  });

  test('a restructuring mode really does insert once, through the whole controller', async () => {
    const r = rig({
      settings: { defaultModeKey: 'note' },
      polishChain: () => ({
        polisher: new FakePolisher('cloud'),
        notConfigured: false,
        reason: null,
      }),
      apiKey: 'sk',
    });
    await r.dictate();
    expect(r.inserter.inserted).toEqual(['Hello world.']);
    expect(r.inserter.replaced).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------
// The text pipeline the controller assembles
// ---------------------------------------------------------------------------------

suite('the delivery pipeline', () => {
  test('capitalisation needs BOTH settings.autoCapitalise and mode.autocapitalizeInsert', async () => {
    const both = rig({ settings: { autoCapitalise: true, defaultModeKey: 'super' } });
    await both.dictate();
    expect(both.inserter.inserted).toEqual(['Hello world']);

    const settingOff = rig({ settings: { autoCapitalise: false, defaultModeKey: 'super' } });
    await settingOff.dictate();
    expect(settingOff.inserter.inserted).toEqual(['hello world']);

    const modeOff = rig({
      settings: { autoCapitalise: true, defaultModeKey: 'super' },
      ports: { modes: fakeModes({ super: { autocapitalizeInsert: false } }) },
    });
    await modeOff.dictate();
    expect(modeOff.inserter.inserted).toEqual(['hello world']);
  });

  test('replacements run on the delivered text', async () => {
    const r = rig({
      settings: {
        autoCapitalise: false,
        replacements: [{ find: 'world', replaceWith: 'dunyo', matchCase: false, wholeWord: true }],
      },
    });
    await r.dictate();
    expect(r.inserter.inserted).toEqual(['hello dunyo']);
  });
});

// ---------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------

suite('what is persisted', () => {
  test('the record carries modeKey and polishID, written by the CONTROLLER', async () => {
    const r = rig({
      settings: { defaultModeKey: 'super' },
      polishChain: () => ({
        polisher: new FakePolisher('groq:llama-3.3-70b'),
        notConfigured: false,
        reason: null,
      }),
      apiKey: 'sk',
    });
    await r.dictate();
    expect(r.diagnostics.appended).toHaveLength(1);
    expect(r.diagnostics.appended[0]).toMatchObject({
      modeKey: 'super',
      polishID: 'groq:llama-3.3-70b',
      outcome: 'done',
    });
  });

  test('history gets the entry and the retention is enforced', async () => {
    const r = rig({ settings: { historyLimit: 200 } });
    await r.dictate();
    expect(r.history.entries).toHaveLength(1);
    expect(r.history.entries[0]).toMatchObject({
      engineID: 'unified-v3-turbo',
      raw: 'hello world',
      result: 'Hello world',
      polished: null,
      audioPath: null,
    });
    expect(r.history.prunedTo).toBe(200);
  });

  test('a delivered Turkish dictation is counted for the Turkish check; others are not', async () => {
    const r = rig({ settings: { enabledLanguages: ['en', 'ru', 'uz', 'tr'], pinnedLanguage: 'tr' } });
    r.engines.engines.set('turkish' as EngineFamily, new FakeEngine('turbo-tr', new Set<Language>(['tr']), r.clock));
    await r.dictate();
    expect(r.settings.current().turkishDictations).toBe(1);
    await r.settings.update({ pinnedLanguage: 'en' });
    await r.dictate();
    expect(r.settings.current().turkishDictations).toBe(1);
  });

  test('P4: with the language-ID model loaded it routes, and every delivered language is counted', async () => {
    const r = rig();
    let asked = 0;
    r.engines.identifier = {
      posterior: async () => {
        asked += 1;
        return { en: 0.97, ru: 0.01, _: 0.02 };
      },
    };
    await r.dictate();
    expect(asked).toBe(1);
    const route = r.diagnostics.appended[0]?.route;
    // The language-ID router's decision: the posterior and the acoustic evidence are on it.
    expect(route).toMatchObject({ language: 'en', source: 'acoustic' });
    expect(Object.keys(route?.probabilities ?? {}).sort()).toEqual(['en', 'ru', 'uz']);
    expect(r.diagnostics.appended[0]?.languageAfterTranscript).toBeDefined();
    expect(r.settings.current().englishDictations).toBe(1);
    expect(r.settings.current().uzbekDictations).toBe(0);
  });

  test('P4: without it, whisper base routes as before and no decision is recorded', async () => {
    const r = rig();
    await r.dictate();
    expect(r.diagnostics.appended[0]?.route?.probabilities).toBeUndefined();
    expect(r.diagnostics.appended[0]?.languageAfterTranscript).toBeUndefined();
  });

  test('P4: the counts are seeded once from History, never lowered', async () => {
    const r = rig({ settings: { turkishDictations: 9 } });
    const entry = (id: string, language: Language) =>
      ({ id, startedAt: '2026-10-01T10:00:00Z', language, engineID: 'x', raw: 'r', result: 'r', polished: null, audioSeconds: 1, audioPath: null }) as const;
    r.history.entries.push(entry('a', 'uz'), entry('b', 'uz'), entry('c', 'ru'), entry('d', 'tr'));
    await r.controller.start();
    await flush();
    const seeded = r.settings.current();
    expect([seeded.uzbekDictations, seeded.russianDictations, seeded.englishDictations, seeded.turkishDictations]).toEqual([2, 1, 0, 9]);
    expect(seeded.languageCountsSeeded).toBe(true);
    r.history.entries.push(entry('e', 'uz'));
    await r.controller.start();
    await flush();
    expect(r.settings.current().uzbekDictations).toBe(2);
    await r.controller.dispose();
  });

  test('a heardNothing dictation is recorded in diagnostics but NOT in history', async () => {
    const r = rig();
    r.audio.buffer = SILENCE_7_4;
    await r.dictate();
    expect(r.diagnostics.appended).toHaveLength(1);
    expect(r.diagnostics.appended[0]?.outcome).toBe('heardNothing');
    expect(r.history.entries).toEqual([]);
  });

  test('keepHistory off means nothing is written, and diagnosticsEnabled off likewise', async () => {
    const r = rig({ settings: { keepHistory: false, diagnosticsEnabled: false } });
    await r.dictate();
    expect(r.history.entries).toEqual([]);
    expect(r.diagnostics.appended).toEqual([]);
  });

  test('a history store that stops accepting writes becomes a blocker, not silence', async () => {
    const r = rig();
    r.history.insertError = new Error('ENOSPC: no space left on device');
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('succeeded');
    expect(r.controller.blockers().map((b) => b.id)).toContain('history-store');
    expect(r.controller.blockers().find((b) => b.id === 'history-store')?.detail).toContain(
      'ENOSPC',
    );
  });
});

// ---------------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------------

suite('blockers', () => {
  test('a cold microphone, a dead hotkey and unreadable settings each name themselves', async () => {
    const r = rig();
    r.audio.isWarm = false;
    r.audio.lastWarmUpError = 'Windows has not given Kotiba the microphone';
    r.hotkey.failure = 'kotiba-hook.exe exited with code 1';
    r.settings.loadFailure = 'these settings could not be read and were left at their defaults: vocabulary';

    const ids = r.controller.blockers().map((b) => b.id);
    expect(ids).toContain('microphone');
    expect(ids).toContain('hotkey');
    expect(ids).toContain('settings');
    for (const blocker of r.controller.blockers()) {
      expect(blocker.headline.length).toBeGreaterThan(12);
      expect(blocker.headline).not.toContain('Optional(');
    }
  });

  test('a microphone that heals itself is not a blocker; one only the user can fix is', () => {
    // The owner's review, 2026-09-30: "the input device changed — the audio graph is rebuilt
    // on the next press" sat under a "Needs attention" banner nearly every time the window
    // opened. The next press rebuilds it; nothing for the user to do.
    const healing = rig();
    healing.audio.isWarm = false;
    healing.audio.lastWarmUpError = 'the input device changed — the audio graph is rebuilt on the next press';
    healing.audio.warmUpNeedsTheUser = false;
    expect(healing.controller.blockers().map((b) => b.id)).not.toContain('microphone');

    const denied = rig();
    denied.audio.isWarm = false;
    denied.audio.lastWarmUpError = 'Windows has not given Kotiba the microphone';
    denied.audio.warmUpNeedsTheUser = true;
    expect(denied.controller.blockers().map((b) => b.id)).toContain('microphone');
  });

  test('a model that is NOT CHOSEN and one that is CORRUPT are different blockers', async () => {
    const missing = rig();
    missing.engines.readinessValue = {
      ...missing.engines.readinessValue,
      uzbek: 'notInstalled',
    };
    await missing.controller.recheck();
    expect(missing.controller.blockers().find((b) => b.id === 'uzbek-model')?.headline).toBe(
      'No Uzbek model',
    );

    const corrupt = rig();
    corrupt.engines.readinessValue = { ...corrupt.engines.readinessValue, uzbek: 'corrupt' };
    await corrupt.controller.recheck();
    expect(corrupt.controller.blockers().find((b) => b.id === 'uzbek-model')?.headline).toBe(
      'The Uzbek model didn’t load',
    );
  });

  test('a missing unified model blocks anyone who can reach Russian, not just ru users', async () => {
    // It used to be gated on `defaultLanguage === 'ru'`, so an English-default user who
    // pins Russian, or who lets the acoustic router pick it, was told nothing at all —
    // and the family serves English too, so the model that "is not needed" is the one
    // every English dictation goes through.
    const englishDefault = rig();
    englishDefault.engines.readinessValue = {
      ...englishDefault.engines.readinessValue,
      unified: 'notInstalled',
    };
    await englishDefault.controller.recheck();
    expect(englishDefault.controller.blockers().map((b) => b.id)).toContain('russian-model');

    const pinnedRussian = rig({ settings: { defaultLanguage: 'uz', pinnedLanguage: 'ru' } });
    pinnedRussian.engines.readinessValue = {
      ...pinnedRussian.engines.readinessValue,
      unified: 'notInstalled',
    };
    await pinnedRussian.controller.recheck();
    expect(pinnedRussian.controller.blockers().map((b) => b.id)).toContain('russian-model');

    // And the one user it is genuinely not a blocker for: everything locked to Uzbek.
    // A blocker they cannot act on is noise, not information.
    const uzbekOnly = rig({
      settings: { defaultLanguage: 'uz', pinnedLanguage: 'uz' },
    });
    uzbekOnly.engines.readinessValue = {
      ...uzbekOnly.engines.readinessValue,
      unified: 'notInstalled',
    };
    await uzbekOnly.controller.recheck();
    expect(uzbekOnly.controller.blockers().map((b) => b.id)).not.toContain('russian-model');
  });

  test('a healthy app has no blockers at all', async () => {
    const r = rig();
    await r.controller.start();
    expect(r.controller.blockers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------

suite('lifecycle', () => {
  test('start opens the stores, warms the microphone and starts the hook', async () => {
    const r = rig();
    await r.controller.start();
    expect(r.history.opened).toBe(true);
    expect(r.diagnostics.opened).toBe(true);
    expect(r.audio.warmUps).toBe(1);
    expect(r.hotkey.started).toBe(true);
  });

  test('a diagnostics store that will not open does not stop startup', async () => {
    const r = rig();
    r.diagnostics.openError = new Error('EACCES');
    await r.controller.start();
    expect(r.controller.blockers().map((b) => b.id)).toContain('diagnostics-store');
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('succeeded');
  });

  test('recheck does not trample a dictation that is in flight', async () => {
    const r = rig();
    r.controller.press();
    await flush();
    const warmUpsBefore = r.audio.warmUps;
    await r.controller.recheck();
    expect(r.audio.warmUps).toBe(warmUpsBefore);

    r.controller.release();
    await flush();
    expect(r.lastRun()?.kind).toBe('succeeded');
  });

  test('cancel clears both halves of the gate and inserts nothing', async () => {
    const r = rig();
    r.controller.press();
    await flush();
    r.controller.cancel('a chord during the hold');
    await flush();

    expect(r.controller.isRunning).toBe(false);
    expect(r.controller.status).toEqual({ kind: 'idle' });
    expect(r.inserter.inserted).toEqual([]);

    // And the next press is admitted.
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('succeeded');
  });

  test('dispose waits for a run in flight and then shuts everything down', async () => {
    const r = rig();
    r.controller.press();
    await flush();
    r.controller.release();
    await r.controller.dispose();
    expect(r.hotkey.started).toBe(false);
  });

  test('a release with no press does nothing and does not latch the gate', async () => {
    const r = rig();
    r.controller.release();
    await flush();
    expect(r.controller.isRunning).toBe(false);
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------------
// THE GESTURE IS CONNECTED — the hook drives the controller, not a test method
// ---------------------------------------------------------------------------------

suite('the hook drives the dictation', () => {
  test('start() subscribes, and a whole dictation runs THROUGH the hotkey', async () => {
    // Every other test in this file calls `press()` and `release()` directly, which is
    // exactly why nobody noticed that `start()` called `hotkey.start()` with NOTHING
    // subscribed to `onEvent`: the helper ran, the state machine worked, and every event
    // it produced went into an empty listener set. The app watched the key and did
    // nothing with it. This test presses the KEY.
    const r = rig();
    await r.controller.start();
    expect(r.hotkey.subscribers).toBe(1);

    r.hotkey.down();
    await flush();
    expect(r.controller.status).toEqual({ kind: 'listening' });
    expect(r.audio.capturing).toBe(true);

    r.hotkey.up();
    await flush();
    expect(r.inserter.inserted).toEqual(['Hello world']);
    expect(r.controller.status).toEqual({ kind: 'succeeded', text: 'Hello world' });
  });

  test('ten holds through the hook, all of them admitted', async () => {
    const r = rig();
    await r.controller.start();
    for (let i = 0; i < 10; i += 1) {
      r.unified.text = `utterance ${i}`;
      r.hotkey.down();
      await flush();
      r.hotkey.up();
      await flush();
    }
    expect(r.inserter.inserted).toEqual(
      Array.from({ length: 10 }, (_, i) => `Utterance ${i}`),
    );
  });

  test('a chord during the hold cancels it and inserts nothing', async () => {
    // D-W4: holding the hotkey and pressing V is the user pasting. The cancel path is
    // dead code on macOS and live here, so it has to be reachable FROM THE HOOK.
    const r = rig();
    await r.controller.start();
    r.hotkey.down();
    await flush();
    r.hotkey.chord();
    await flush();

    expect(r.controller.isRunning).toBe(false);
    expect(r.controller.status).toEqual({ kind: 'idle' });
    expect(r.inserter.inserted).toEqual([]);

    // And the key comes up afterwards in the real world even though the hook suppresses
    // the `released` — nothing here may depend on that suppression.
    r.hotkey.up();
    await flush();
    expect(r.inserter.inserted).toEqual([]);

    r.hotkey.down();
    await flush();
    r.hotkey.up();
    await flush();
    expect(r.inserter.inserted).toEqual(['Hello world']);
  });

  test('a hotkey chosen in Settings reaches the RUNNING hook', async () => {
    // D-W4 requires the key to be reconfigurable without restarting the app, and
    // `setBinding` had no caller anywhere in the tree: the picker wrote a new key into
    // the settings file and the hook went on watching the old one until a restart.
    const r = rig();
    await r.controller.start();
    expect(r.hotkey.bindings.at(-1)).toEqual(r.settings.current().hotkey);

    await r.settings.update({ hotkey: { vk: 162, label: 'Left Ctrl' } });
    await flush();
    expect(r.hotkey.bindings.at(-1)).toEqual({ vk: 162, label: 'Left Ctrl' });

    // And through the explicit hook the shell calls after it writes settings, for a
    // store that does not announce its own changes.
    await r.settings.update({ hotkey: { vk: 164, label: 'Right Alt' } });
    await r.controller.settingsChanged();
    expect(r.hotkey.bindings.at(-1)).toEqual({ vk: 164, label: 'Right Alt' });
  });

  test('dispose unsubscribes, so a late event cannot drive a controller that is gone', async () => {
    const r = rig();
    await r.controller.start();
    await r.controller.dispose();
    expect(r.hotkey.subscribers).toBe(0);
    r.hotkey.down();
    await flush();
    expect(r.audio.capturing).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// A REFUSED PRESS IS INERT — its key-up must not touch the run that refused it
// ---------------------------------------------------------------------------------

suite('overlapping dictations paste in press order', () => {
  test('TEN rapid dictations, later ones finishing first, paste all ten in order', async () => {
    // The Mac regression (OverlappingDictationTests): each release overlaps the previous
    // one's processing, and the transcription times are arranged so that the dictations
    // finish in REVERSE — the tenth first. Pasting in finishing order would reverse the
    // user's sentences in their document.
    const r = rig();
    for (let i = 0; i < 10; i += 1) {
      r.unified.script.push({ text: `sentence ${i}`, delayMs: (10 - i) * 1_000 });
      r.controller.press();
      await flush();
      r.controller.release();
      await flush();
    }
    expect(r.audio.takes).toHaveLength(10);
    expect(r.inserter.inserted).toEqual([]);
    await r.clock.advance(11_000);
    await flush();
    expect(r.inserter.inserted).toEqual(Array.from({ length: 10 }, (_, i) => `Sentence ${i}`));
    expect(r.controller.isRunning).toBe(false);
  });

  test('an older dictation finishing never takes the HUD from the one being spoken', async () => {
    const r = rig();
    r.unified.script.push({ text: 'older', delayMs: 5_000 });
    r.controller.press();
    await flush();
    r.controller.release();
    await flush();

    r.unified.script.push({ text: 'newer', delayMs: 0 });
    r.controller.press();
    await flush();
    await r.clock.advance(6_000);
    await flush();
    // The older one has pasted, but the newer key is still down: still Listening.
    expect(r.inserter.inserted).toEqual(['Older']);
    expect(r.controller.status).toEqual({ kind: 'listening' });

    r.controller.release();
    await flush();
    expect(r.controller.status).toEqual({ kind: 'succeeded', text: 'Newer' });
  });

  test('a dictation that inserts nothing still passes the turn', async () => {
    // `finish` on EVERY path, or every later dictation waits out the five-minute patience.
    const r = rig();
    r.audio.takeBuffers.push(SILENCE_7_4);
    r.controller.press();
    await flush();
    r.controller.release();
    await flush();
    await r.dictate();
    expect(r.inserter.inserted).toEqual(['Hello world']);
  });

  test('a chord cancels ONLY the held dictation; the released one still pastes', async () => {
    const r = rig();
    r.unified.script.push({ text: 'keep me', delayMs: 3_000 });
    r.controller.press();
    await flush();
    r.controller.release();
    await flush();

    r.controller.press();
    await flush();
    r.controller.cancel('chord');
    await flush();
    await r.clock.advance(4_000);
    await flush();
    expect(r.inserter.inserted).toEqual(['Keep me']);
    expect(r.controller.isRunning).toBe(false);
  });

  test('a cancelled press hands the HUD back to the dictation still finishing', async () => {
    const r = rig();
    r.unified.script.push({ text: 'still coming', delayMs: 3_000 });
    r.controller.press();
    await flush();
    r.controller.release();
    await flush();
    r.controller.press();
    await flush();
    r.controller.cancel('chord');
    await flush();
    // Not idle: the first dictation is still transcribing, and the HUD says so.
    expect(r.controller.status).toEqual({ kind: 'working', stage: 'transcribing' });
    await r.clock.advance(4_000);
    await flush();
    // And its outcome is shown, not swallowed by the cancelled press.
    expect(r.controller.status).toEqual({ kind: 'succeeded', text: 'Still coming' });
  });

  test('the 30-minute ceiling finishes the held dictation as though the key came up', async () => {
    const r = rig();
    r.controller.press();
    await flush();
    const take = r.audio.takes[0];
    take?.options.onLimit?.();
    await flush();
    expect(r.statuses.some((s) => s.kind === 'working' && s.stage === CAPTURE_LIMIT_STAGE)).toBe(true);
    await flush();
    expect(r.inserter.inserted).toEqual(['Hello world']);
    // The user's own key-up, later, finds nothing to finish.
    r.controller.release();
    await flush();
    expect(r.inserter.inserted).toEqual(['Hello world']);
  });
});

suite('ducking follows the hold', () => {
  test('duck on key-down, restore on key-up and on a cancel; nothing when switched off', async () => {
    const calls: string[] = [];
    const ducking = {
      duck: (level: number) => calls.push(`duck ${String(level)}`),
      restore: () => calls.push('restore'),
    };
    const r = rig({ ducking });
    r.controller.press();
    await flush();
    r.controller.release();
    await flush();
    r.controller.press();
    await flush();
    r.controller.cancel('chord');
    await flush();
    expect(calls).toEqual(['duck 0.25', 'restore', 'duck 0.25', 'restore']);

    await r.settings.update({ duckingEnabled: false });
    calls.length = 0;
    await r.dictate();
    expect(calls).toEqual(['restore']);
  });
});

suite('a key-up finishes only its own press', () => {
  test('a second key-up for one press finishes nothing twice', async () => {
    const r = rig();
    r.unified.delayMs = 8_000;
    r.controller.press();
    await flush();
    r.controller.release();
    await flush();
    r.controller.release();
    await flush();
    await r.clock.advance(9_000);
    await flush();
    // One press, one insertion — not two `finish()` calls on one session.
    expect(r.inserter.inserted).toEqual(['Hello world']);
  });

  test('a cold model load never holds the microphone open past the key-up', async () => {
    // `release()` awaited the arming task, and the arming task awaited the model preload.
    // So a 7.8 s cold Uzbek load kept the microphone OPEN for 7.8 s after the user let
    // go, and everything said in the room in the meantime was captured and transcribed
    // as part of the dictation.
    const r = rig();
    let finishLoading!: () => void;
    r.engines.prepareGate = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });

    r.controller.press();
    await flush();
    expect(r.audio.capturing).toBe(true);

    r.controller.release();
    await flush();
    expect(r.audio.capturing).toBe(false);
    expect(r.audio.stops).toBe(1);

    finishLoading();
    await flush();
    expect(r.inserter.inserted).toEqual(['Hello world']);
  });
});

// ---------------------------------------------------------------------------------
// Polish is off unless configured
// ---------------------------------------------------------------------------------

suite('polish is off unless configured', () => {
  test('with no chain the raw transcript stands and nothing is an error', async () => {
    const r = rig();
    await r.dictate();
    expect(r.lastRun()?.kind).toBe('succeeded');
    expect(r.controller.lastRecord?.errors).toEqual([]);
    expect(r.controller.lastRecord?.polished).toBeUndefined();
  });

  test('polishEnabled: false never even asks for a chain', async () => {
    let asked = false;
    const r = rig({
      settings: { polishEnabled: false },
      polishChain: () => {
        asked = true;
        return { polisher: new FakePolisher('p'), notConfigured: false, reason: null };
      },
    });
    await r.dictate();
    expect(asked).toBe(false);
  });

  test('a prompt-less mode never asks for a chain either', async () => {
    let asked = false;
    const r = rig({
      settings: { defaultModeKey: 'transcription' },
      polishChain: () => {
        asked = true;
        return { polisher: new FakePolisher('p'), notConfigured: false, reason: null };
      },
    });
    await r.dictate();
    expect(asked).toBe(false);
  });

  test('"not configured" is a FLAG, never a regex over a message', async () => {
    const chain: PolishChain = {
      polisher: null,
      notConfigured: true,
      reason: 'no GONKA_API_KEY / GONKA_BASE_URL stored',
    };
    const r = rig({ polishChain: () => chain });
    await r.dictate();
    // The app is healthy: an unconfigured polish is not a failure, and nothing here
    // inspects `reason` to decide that.
    expect(r.lastRun()?.kind).toBe('succeeded');
    expect(chain.notConfigured).toBe(true);
  });

  test('the API key is read per dictation and handed to the chain, never held', async () => {
    const seen: (string | null)[] = [];
    const r = rig({
      apiKey: 'sk-first',
      ports: {
        // A USER mode: a built-in one never reads the key (next test).
        modes: fakeModes({ super: { key: 'custom-mode' as ModeKey } }),
        polishChain: ({ apiKey }) => {
          seen.push(apiKey);
          return { polisher: null, notConfigured: false, reason: null };
        },
      },
    });
    await r.dictate();
    // Rotated in the credential store between dictations. A key held in memory for the
    // process lifetime would still be the first one.
    r.secrets.values.set(r.settings.current().polishKeyAccount, 'sk-second');
    await r.dictate();
    expect(seen).toEqual(['sk-first', 'sk-second']);
  });

  test('a built-in mode never reads the key — on Windows each read is a PowerShell spawn', async () => {
    const seen: (string | null)[] = [];
    const r = rig({
      apiKey: 'sk-unused',
      ports: {
        polishChain: ({ apiKey }) => {
          seen.push(apiKey);
          return { polisher: null, notConfigured: false, reason: null };
        },
      },
    });
    let reads = 0;
    const read = r.secrets.get.bind(r.secrets);
    r.secrets.get = async (account: string) => {
      reads += 1;
      return read(account);
    };
    await r.dictate();
    expect(reads).toBe(0);
    expect(seen).toEqual([null]);
  });
});
