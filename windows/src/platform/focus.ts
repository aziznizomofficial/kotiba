// Who is in front.  OWNER: t07
//
// May use Node. May NOT import `electron`.
//
// Two consumers, and the second is why this file must never guess:
//
//   1. MODE SELECTION. `resolveMode()` asks which application the text is going into and
//      picks the mode whose activation list claims it.
//   2. THE CREDENTIAL GATE. When the front application is a password manager,
//      `resolveMode()` forces the raw, prompt-less mode and suppresses polish entirely.
//      Without it, a password dictated into 1Password is sent to whatever polish
//      endpoint the user configured. The macOS comment says this defect shipped once
//      already. It is a security property, not a nicety.
//
// macOS reads it twice per dictation on purpose — at hotkey-down for the mode decision
// and again after transcription for the prompt, because the app the text lands in is
// the app that matters for the prompt. Both reads go through here.
//
// ---------------------------------------------------------------------------------
// WHERE THE ANSWER COMES FROM
// ---------------------------------------------------------------------------------
//
// `GetForegroundWindow` + `GetWindowThreadProcessId` + `QueryFullProcessImageNameW`, in
// `kotiba-input.exe` — the same helper that does the insertion, over the same warm pipe.
// The architecture allows two native helpers and this is not a third: spawning a
// process to answer a question asked twice per dictation would put tens of milliseconds
// on the front of every press.
//
// `AppId` is the executable basename, lowercased, `.exe` stripped, matched by EXACT
// EQUALITY (windows/src/contracts/modes.ts). Not the window title, which holds document
// content and changes with locale; not the localised display name, which is what
// a commercial dictation app matches and what breaks when an app is renamed.
//
// ---------------------------------------------------------------------------------
// "I DO NOT KNOW" IS NOT "NOTHING SENSITIVE"
// ---------------------------------------------------------------------------------
//
// A locked session, a UAC prompt on the secure desktop, or an elevated password manager
// seen from a non-elevated Kotiba all produce a refusal from the helper rather than an
// answer. That arrives here as `appId: null` AND a non-null `lastFailure`, so a caller
// that cares about the difference can ask. `formatForApp(null)` is `unknown`, which is
// not sensitive — the same fail-open macOS has when `bundleIdentifier` is nil — and the
// residual risk is recorded rather than papered over.

import { type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { CreateFocusSource, ForegroundApp, FocusSource } from '../contracts/index.js';
import { createInputHelper, type InputHelper } from './insert.js';

export interface FocusSourceOptions {
  /** Path to `kotiba-input.exe`. Ignored when `helper` is supplied. */
  readonly helperPath: string;
  /** Share the inserter's helper process. Strongly preferred. */
  readonly helper?: InputHelper;
  readonly onNote?: (note: string) => void;
  readonly spawnProcess?: (path: string) => ChildProcessWithoutNullStreams;
  readonly requestTimeoutMs?: number;
  /**
   * This process's own id, for `isSelfForeground`. Injected in tests; in production it
   * is Electron main's pid, which owns every window Kotiba puts on screen.
   */
  readonly selfPid?: number;
}

/**
 * `FocusSource`, plus the two things the contract does not carry: whether the last read
 * failed, and whether the front window is one of ours.
 */
export interface WindowsFocusSource extends FocusSource {
  /**
   * The sentence from the last unsuccessful read, or `null`. Non-null means the answer
   * to `foreground()` was `{appId: null}` because we could not tell, NOT because
   * nothing was in front.
   */
  readonly lastFailure: string | null;

  /**
   * **A DELIBERATE WINDOWS ADDITION, NOT PARITY.**
   *
   * macOS has `Focus.isSelfFrontmost` — the "do not paste into our own settings window"
   * guard — and it is written, documented, and called from NOWHERE: `grep -rn
   * isSelfFrontmost` over the Swift tree returns the two definitions and nothing else.
   * `PasteboardSink.insert()` checks only that the text is non-empty and that
   * Accessibility is trusted. So there is no self-frontmost check on the macOS
   * insertion path, and porting one as if it were parity would be shipping behaviour
   * the Mac app does not execute — which 02-BEHAVIOUR §3 forbids.
   *
   * It is implemented here anyway, as an addition, because the case it was written for
   * is MORE likely on Windows, not less: the settings window is a real focusable window
   * that a user reaches from the tray, the first-run onboarding window is a Windows-only
   * addition (there is no macOS equivalent), and the HUD sits over everything. A
   * dictation triggered while one of those has focus would type into our own UI.
   *
   * It is deliberately NOT wired into `insert()` by this module. Whether an insertion is
   * refused is the session's decision (t09), and a guard buried in the sink is a guard
   * nobody can see. This exposes the fact; the session decides what it means.
   */
  isSelfForeground(): Promise<boolean>;

  /** Tears down the helper only when this source created it. */
  dispose(): Promise<void>;
}

export function createFocusSource(options: FocusSourceOptions): WindowsFocusSource {
  const owned = options.helper === undefined;
  const helper =
    options.helper ??
    createInputHelper({
      helperPath: options.helperPath,
      ...(options.onNote !== undefined ? { onNote: options.onNote } : {}),
      ...(options.spawnProcess !== undefined ? { spawnProcess: options.spawnProcess } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
  const selfPid = options.selfPid ?? process.pid;

  let lastFailure: string | null = null;
  let lastPid: number | null = null;

  async function read(): Promise<ForegroundApp> {
    try {
      const response = await helper.request({ op: 'foreground' });
      if (!response.ok) {
        lastFailure = response.detail ?? response.code ?? 'the foreground window could not be read';
        lastPid = null;
        return { appId: null, displayName: null };
      }
      lastFailure = null;
      lastPid = typeof response.pid === 'number' ? response.pid : null;
      // Normalised again on this side. The helper already lowercases, and doing it twice
      // costs nothing next to an `AppId` that fails an exact-equality match because one
      // end changed its mind about case.
      const appId =
        typeof response.appId === 'string' && response.appId.length > 0
          ? response.appId.trim().toLowerCase()
          : null;
      return {
        appId,
        displayName:
          typeof response.displayName === 'string' && response.displayName.length > 0
            ? response.displayName
            : null,
      };
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      lastPid = null;
      return { appId: null, displayName: null };
    }
  }

  return {
    async foreground(): Promise<ForegroundApp> {
      return read();
    },

    async isSelfForeground(): Promise<boolean> {
      await read();
      // An unreadable foreground is NOT us. Answering true here would silently suppress
      // insertion into every elevated application on the machine, which is a far worse
      // failure than pasting into our own settings window once.
      return lastPid !== null && lastPid === selfPid;
    },

    get lastFailure(): string | null {
      return lastFailure;
    },

    async dispose(): Promise<void> {
      if (owned) await helper.dispose();
    },
  };
}

/**
 * The `CreateFocusSource` factory the contract declares. It takes no arguments, so it
 * cannot be told where the helper is; the composition root should call
 * `createFocusSource` directly with the shared helper instead. This exists so the
 * contract type is satisfiable, and it resolves the helper next to the running
 * executable — the same place `bundledResourcesDirectory()` will point.
 */
export const createFocusSourceFactory: CreateFocusSource = () =>
  createFocusSource({ helperPath: defaultInputHelperPath() });

/**
 * `kotiba-input.exe` beside the running executable.
 *
 * Built with string joins rather than `node:path` for one reason: on Windows both
 * separators work, and this file is read by people checking a layering rule. Keeping
 * the import list to `node:child_process` makes that check trivial.
 */
export function defaultInputHelperPath(): string {
  const executable = process.execPath;
  const cut = Math.max(executable.lastIndexOf('\\'), executable.lastIndexOf('/'));
  const directory = cut > 0 ? executable.slice(0, cut) : '.';
  return `${directory}\\kotiba-input.exe`;
}
