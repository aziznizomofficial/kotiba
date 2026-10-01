// REGRESSION (final win review 2026-09-30, fixed): the microphone waits for kotiba-input before it opens.
//
// press() (src/session/controller.ts, the `armed` body) does
//     const appId = await foregroundAppId();   // an IPC request to kotiba-input.exe
//     ... buildSession(...) ... await built.arm();   // only now: take.start()
// kotiba-input answers strictly one request at a time (src/platform/insert.ts, the
// serialisation chain), is SHARED with the inserter (src/main/compose.ts), and times out at
// 5 s (INPUT_REQUEST_TIMEOUT_MS). So a press that lands while the previous dictation is
// pasting (the overlap 1.0 exists for), or while the helper is respawning/hung, opens the
// microphone only after the paste — or up to 5 s later — and the first words are never
// recorded. The Mac opens the take synchronously in `press()` and resolves the mode
// synchronously beside it.

import { describe, expect, it } from 'vitest';

import { DEFAULT_SESSION_CONFIG } from '../../src/contracts/index.js';
import type { EngineFamily, ForegroundApp, Language } from '../../src/contracts/index.js';
import { createDictationController } from '../../src/session/index.js';
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
  FakeSecrets,
  FakeSettings,
  ManualClock,
  fakeModes,
  fakePorts,
  flush,
} from '../session/fakes.js';

/** A foreground read that answers only when the test says so — a busy kotiba-input. */
class SlowFocus extends FakeFocus {
  private answer: (() => void) | null = null;
  override async foreground(): Promise<ForegroundApp> {
    await new Promise<void>((resolve) => {
      this.answer = resolve;
    });
    return this.app;
  }
  answerNow(): void {
    this.answer?.();
  }
}

describe('REVIEW: key-down opens the microphone without waiting for the foreground read', () => {
  it('the take has started while kotiba-input is still busy', async () => {
    const clock = new ManualClock();
    const audio = new FakeAudio(clock);
    const engines = new FakeEngineManager();
    engines.engines.set('unified' as EngineFamily, new FakeEngine('unified', new Set<Language>(['en', 'ru']), clock));
    engines.engines.set('uzbek' as EngineFamily, new FakeEngine('uzbek', new Set<Language>(['uz']), clock));
    const focus = new SlowFocus();
    const controller = createDictationController({
      settings: new FakeSettings(),
      secrets: new FakeSecrets(),
      engines,
      audio,
      inserter: new FakeInserter(),
      hotkey: new FakeHotkey(),
      focus,
      history: new FakeHistory(),
      diagnostics: new FakeDiagnostics(),
      models: new FakeModels(),
      modes: fakeModes(),
      config: DEFAULT_SESSION_CONFIG,
      ports: fakePorts({ clock }),
    });

    controller.press();
    await flush();
    // The user is already speaking. On the Mac the take is open by now.
    expect(audio.starts).toBe(1);

    focus.answerNow();
    await flush();
    controller.release();
    await flush();
  });
});
