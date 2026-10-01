// REGRESSION (final win review 2026-09-30, fixed): every dictation waits for a PowerShell credential read that
// nothing uses, and the microphone stays open until it returns.
//
// press() starts `makePolishChain()` at key-down, which calls `deps.secrets.get(...)` for
// every mode with a prompt (Super, Message, Note — Super is the default) while polish is on
// (the default). On Windows that is `createWindowsSecretStore().get` → a fresh
// `powershell.exe` running `Add-Type` (a C# compile) → CredReadW, with NO timeout
// (src/platform/index.ts defaultRunner). The app's chain (src/polish/chain.ts) never reads
// `apiKey`. release() then does
//     const chain = await (releasing.chain ?? makePolishChain(mode, appId));
// BEFORE `running.finish()` — and `finish()` is what calls `take.stop()`. So:
//   * a hold shorter than the PowerShell round trip (~0.5–3 s cold) keeps recording past the
//     key-up and adds the remainder to key-up → text (the ≤ 200 ms target);
//   * a PowerShell that never exits (AMSI, a policy prompt, a wedged console host) leaves the
//     microphone open for good, `isRunning` latched, and every later paste waiting out the
//     5-minute patience.

import { describe, expect, it } from 'vitest';

import { DEFAULT_SESSION_CONFIG } from '../../src/contracts/index.js';
import type { EngineFamily, Language } from '../../src/contracts/index.js';
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

/** A credential read that has not come back — PowerShell still compiling its Add-Type. */
class SlowSecrets extends FakeSecrets {
  reads = 0;
  override async get(): Promise<string | null> {
    this.reads += 1;
    return new Promise<string | null>(() => undefined);
  }
}

describe('REVIEW: key-up does not wait for the credential store', () => {
  it('a Super dictation stops the microphone and pastes while the key read is still running', async () => {
    const clock = new ManualClock();
    const audio = new FakeAudio(clock);
    const engines = new FakeEngineManager();
    const unified = new FakeEngine('unified', new Set<Language>(['en', 'ru']), clock);
    engines.engines.set('unified' as EngineFamily, unified);
    engines.engines.set('uzbek' as EngineFamily, new FakeEngine('uzbek', new Set<Language>(['uz']), clock));
    const inserter = new FakeInserter();
    const secrets = new SlowSecrets();
    const controller = createDictationController({
      settings: new FakeSettings({ defaultModeKey: 'super', modeFollowsApp: false }),
      secrets,
      engines,
      audio,
      inserter,
      hotkey: new FakeHotkey(),
      focus: new FakeFocus(),
      history: new FakeHistory(),
      diagnostics: new FakeDiagnostics(),
      models: new FakeModels(),
      modes: fakeModes(),
      config: DEFAULT_SESSION_CONFIG,
      // The app's chain: a built-in mode never uses the key.
      ports: fakePorts({ clock, polishChain: () => ({ polisher: null, notConfigured: false, reason: null }) }),
    });

    controller.press();
    await flush();
    controller.release();
    await flush();

    expect(audio.stops).toBe(1);
    expect(inserter.inserted).toHaveLength(1);
    expect(controller.isRunning).toBe(false);
  });
});
