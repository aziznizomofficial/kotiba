// src/platform — hotkey client, insertion, focus, history, diagnostics, stores.  OWNER: t07
//
// THE BARREL, and nothing more. Every factory named by `src/contracts` is bound here to
// the implementation beside it. The bodies live in the sibling files; this file exists so
// the composition root can wire the whole platform without importing seven modules and
// without learning which concrete option bag each one takes.
//
// May use Node. May NOT import `electron`.
//
// ---------------------------------------------------------------------------------
// WHY THIS FILE IS A HAZARD, AND WHAT KEEPS IT HONEST
// ---------------------------------------------------------------------------------
//
// It shipped once as seven `() => notImplemented('platform')` stubs while every sibling
// beside it was written and tested. Nothing caught it: the platform tests import
// `./hotkey.js`, `./insert.js`, `./focus.js` and so on DIRECTLY, and `--check` never
// touches this module at all. The only caller is `src/main/index.ts`, which builds each
// seam inside `attempt()` — so seven `NotImplementedError`s became seven tidy blockers,
// `ready` was false, no controller was built, and the packaged app could never dictate
// while the gate stayed green.
//
// `test/main/compose.test.ts` is the answer to that: it builds the real composition root
// against THIS module, with fakes only for the three native helpers, and asserts zero
// blockers. A stub here fails it.
//
// This module owns every file and every child process except the STT host. Two helpers
// live behind it:
//
//   kotiba-hook.exe    stdout: "DOWN 163" / "UP 163"
//   kotiba-input.exe   stdin:  JSON insert commands
//
// Each is replaceable and independently testable from a shell. A crashed helper is
// restarted by the main process and reported in the tray, never silently.
//
// WHERE THE SETTINGS SPLIT FALLS. This module READS AND WRITES the settings file; the
// schema, the defaults and the per-key salvage are pure and live in `src/core/settings`
// (t05). `createSettingsStore` here calls `parseSettings`/`serialiseSettings` there. Do
// not reimplement the salvage against a filesystem — the interesting bugs are all in
// the salvage, and they are only cheap to test without one.

import { execFile } from 'node:child_process';

import type { CreateSecretStore, SecretStore } from '../contracts/index.js';
import { kotibaPaths } from '../core/settings/index.js';

// ---------------------------------------------------------------------------------
// The contract factories
// ---------------------------------------------------------------------------------
//
// Each `…Factory` is the sibling's `CreateX`-shaped binding: the concrete options carry
// extra seams for tests and diagnostics, and the contract promises only a subset. A
// composition root that wants the extras — sharing one `kotiba-input.exe` between the
// inserter and the focus source, say — imports the concrete factory further down.

/**
 * The push-to-talk hook, D-W4.
 *
 * TWO HARD REQUIREMENTS, both of which are how this goes wrong:
 *   * OBSERVE, NEVER SWALLOW. The low-level hook passes the key through. Eating Right
 *     Ctrl breaks every Ctrl chord in every other app.
 *   * ANY OTHER KEY DURING THE HOLD CANCELS the dictation and lets the chord be.
 *
 * And a lost key-up must not latch: `isHeld` is inferred from edges, so after any gap —
 * a hook restart, a suspended process — the held state must be RE-SAMPLED from the
 * hardware, or it sticks true forever with the microphone open.
 */
export { createHotkeySourceFactory as createHotkeySource } from './hotkey.js';

/**
 * Text insertion via `kotiba-input.exe`.
 *
 * Paste is the PRIMARY path, not a fallback: keystroke synthesis cannot type Uzbek where
 * the machine has no Uzbek Latin layout, because no keycode produces the okina U+02BB.
 */
export { createInserterFactory as createInserter } from './insert.js';

/**
 * Who is in front. The credential gate reads this, so it must never guess.
 *
 * The contract factory cannot be told where the helper is and resolves it beside the
 * running executable. A composition root that has already SEARCHED for the helper —
 * `src/main/paths.ts` does, and says where it looked — calls `createWindowsFocusSource`
 * with that path and with the inserter's own helper, so the two share one child process.
 */
export { createFocusSourceFactory as createFocusSource } from './focus.js';

/**
 * The settings file. Reads bytes, hands them to `core/settings`, writes bytes back.
 *
 * A FAILED READ MUST NOT WRITE. Copy the raw bytes aside, leave the original alone, and
 * report. Writing defaults back destroys the only copy of the user's configuration.
 */
export { createFileSettingsStore as createSettingsStore } from './settings.js';

/**
 * D-W5: history as append-only JSONL with an in-memory index.
 *
 * Storage diverges from macOS; BEHAVIOUR MUST NOT. See `./contracts/history.ts` for the
 * two properties of the FTS5 index the in-memory one has to reproduce — no stemming,
 * and no diacritic folding, because the okina is a letter.
 */
export { createFileHistoryStore as createHistoryStore } from './history.js';

/**
 * `diagnostics.jsonl`, append-only, one `{environment, record}` object per line,
 * newline-terminated. Keys sorted at every level. One corrupt line costs that line.
 *
 * Trimming keeps the NEWEST half and discards the oldest — never the other way round,
 * and never by deleting the file.
 */
export { createFileDiagnosticsSink as createDiagnosticsSink } from './diagnostics.js';

// ---------------------------------------------------------------------------------
// The concrete factories, for a root that needs the extra seams
// ---------------------------------------------------------------------------------

export {
  createHotkeySource as createWindowsHotkeySource,
  HOTKEY_HEALTHY_AFTER_MS,
  HOTKEY_RAPID_RESTARTS,
  HOTKEY_RESTART_DELAY_MS,
  HOTKEY_SLOW_RESTART_DELAY_MS,
  type HotkeySourceOptions,
} from './hotkey.js';

export {
  createInputHelper,
  createInserter as createWindowsInserter,
  INPUT_MAX_CONSECUTIVE_FAILURES,
  INPUT_REQUEST_TIMEOUT_MS,
  InputHelperUnavailable,
  refusalReason,
  type InputHelper,
  type InputHelperOptions,
  type InserterOptions,
  type InsertionPath,
} from './insert.js';

export {
  DUCKING_MARKER_NAME,
  DUCKING_TIMING,
  INERT_DUCKER,
  USER_CHANGE_TOLERANCE,
  createDucker,
  fileMarkerStore,
  helperDuckingBackend,
  type AudioSessionInfo,
  type Ducker,
  type DuckingBackend,
  type MarkerStore,
} from './ducking.js';

export {
  createFocusSource as createWindowsFocusSource,
  defaultInputHelperPath,
  type FocusSourceOptions,
  type WindowsFocusSource,
} from './focus.js';

export {
  createFileSettingsStore,
  writeFileAtomic,
  type FileSettingsStoreOptions,
} from './settings.js';

export {
  createFileHistoryStore,
  type FileHistoryStore,
  type FileHistoryStoreOptions,
} from './history.js';

export {
  createFileDiagnosticsSink,
  encodeDiagnosticsLine,
  isoSeconds,
  type FileDiagnosticsSinkOptions,
} from './diagnostics.js';

// ---------------------------------------------------------------------------------
// The credential store
// ---------------------------------------------------------------------------------
//
// It lives in this file rather than in a sibling because it is the one seam with no
// child process and no file of its own: the whole implementation is three PowerShell
// scripts against `advapi32`, and a module holding only that reads as one that does
// more than it does.
//
// WINDOWS CREDENTIAL MANAGER, NOT A FILE. The macOS twin is the Keychain and the rule is
// the same on both: anything in the settings blob can end up in a support bundle, and an
// API key in a support bundle is an API key on someone else's machine. DPAPI over a file
// would keep the bytes secret but would still put the secret's LOCATION inside the
// directory `diagnostics:reveal` opens — which is exactly where a user is told to look
// when something is wrong.
//
// `Add-Type` with a P/Invoke signature is the only route to `CredReadW`/`CredWriteW`
// that needs nothing installed: Windows PowerShell 5.1 ships in every Windows 10 and 11
// image, and the `CredentialManager` gallery module does not.
//
// LIKE `electron-builder.yml`, THIS CANNOT BE EXERCISED HERE. Nobody on this project owns
// a Windows machine, so what is tested is what can be tested from a Mac: the target name,
// the base64 round trip, the empty-value-means-delete rule, that "no such credential" is
// an answer rather than a failure, and that every other non-zero exit becomes a thrown
// sentence rather than a silent success. The P/Invoke itself is proven by CI on
// `windows-latest`, and by nothing here.

/** How the store reaches PowerShell. Injected in tests; never replaced in production. */
export type PowerShellRunner = (args: readonly string[]) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

export interface WindowsSecretStoreOptions {
  /** The credential target prefix. `CREDENTIAL_SERVICE` from `src/contracts`. */
  readonly service: string;
  readonly run?: PowerShellRunner;
}

/**
 * `CredReadW`/`CredWriteW`/`CredDeleteW`, declared once and reused by all three verbs.
 *
 * `CharSet.Unicode` is not decoration: the W entry points take UTF-16, and an API key is
 * routinely base64 with characters that survive a codepage round trip only by luck.
 */
const CREDENTIAL_INTEROP = [
  '$src = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class KotibaCred {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
  '  public struct CREDENTIAL {',
  '    public UInt32 Flags; public UInt32 Type; public IntPtr TargetName; public IntPtr Comment;',
  '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;',
  '    public UInt32 AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;',
  '  }',
  '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
  '  public static extern bool CredReadW(string target, UInt32 type, UInt32 flags, out IntPtr cred);',
  '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
  '  public static extern bool CredWriteW(ref CREDENTIAL cred, UInt32 flags);',
  '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
  '  public static extern bool CredDeleteW(string target, UInt32 type, UInt32 flags);',
  '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);',
  '}',
  '"@',
  'if (-not ("KotibaCred" -as [type])) { Add-Type -TypeDefinition $src }',
  // CRED_TYPE_GENERIC. Never CRED_TYPE_DOMAIN_PASSWORD: that one is the user's own
  // Windows sign-in password, and writing to it is a different and much worse mistake.
  '$T = 1',
].join('\n');

/**
 * The target name a secret is filed under.
 *
 * `service:account`, so one install can hold a key per account exactly as the Keychain
 * does, and so a user reading Credential Manager can see which program wrote it.
 */
export function credentialTarget(service: string, account: string): string {
  return `${service}:${account}`;
}

/** A PowerShell single-quoted literal: the only escape inside one is a doubled quote. */
function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Exported for the test: the three scripts are the part that can be checked from a Mac. */
export function credentialReadScript(target: string): string {
  return [
    CREDENTIAL_INTEROP,
    `$ptr = [IntPtr]::Zero`,
    `if (-not [KotibaCred]::CredReadW(${psLiteral(target)}, $T, 0, [ref]$ptr)) { exit 2 }`,
    `$c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][KotibaCred+CREDENTIAL])`,
    // The blob is raw bytes, so it is read as bytes and decoded as UTF-8 rather than
    // handed to PtrToStringUni — a key written by anything else is not UTF-16.
    `$n = [int]$c.CredentialBlobSize`,
    `$b = New-Object byte[] $n`,
    `if ($n -gt 0) { [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $n) }`,
    `[KotibaCred]::CredFree($ptr)`,
    // Base64 on the way out: stdout is a text pipe with a codepage of its own, and a key
    // that survived everything up to here must not be mangled by a console.
    `[Console]::Out.Write([Convert]::ToBase64String($b))`,
  ].join('\n');
}

export function credentialWriteScript(target: string, value: string): string {
  return [
    CREDENTIAL_INTEROP,
    `$b = [Convert]::FromBase64String(${psLiteral(Buffer.from(value, 'utf8').toString('base64'))})`,
    `$h = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length)`,
    `[System.Runtime.InteropServices.Marshal]::Copy($b, 0, $h, $b.Length)`,
    `$c = New-Object KotibaCred+CREDENTIAL`,
    `$c.Type = $T`,
    `$c.TargetName = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni(${psLiteral(target)})`,
    `$c.CredentialBlob = $h`,
    `$c.CredentialBlobSize = $b.Length`,
    // CRED_PERSIST_LOCAL_MACHINE. Not ENTERPRISE: an API key is not something to sync
    // into a roaming profile, which is the same reason it is not in the settings blob.
    `$c.Persist = 2`,
    `$ok = [KotibaCred]::CredWriteW([ref]$c, 0)`,
    `[System.Runtime.InteropServices.Marshal]::FreeHGlobal($h)`,
    `if (-not $ok) { exit 3 }`,
  ].join('\n');
}

export function credentialDeleteScript(target: string): string {
  return [
    CREDENTIAL_INTEROP,
    // ERROR_NOT_FOUND (1168) is a SUCCESSFUL delete: the caller asked for the key to be
    // gone and it is gone. Every other failure exits non-zero and is surfaced.
    `if (-not [KotibaCred]::CredDeleteW(${psLiteral(target)}, $T, 0)) {`,
    `  if ([System.Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { exit 4 }`,
    `}`,
  ].join('\n');
}

/** `powershell.exe -NoProfile …`, so a user's profile script cannot break us. */
const defaultRunner: PowerShellRunner = async (args) =>
  new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** One sentence, naming the verb — the Settings pane renders it in red beside the field. */
function secretFailure(verb: string, stderr: string, code: number): string {
  const detail = stderr.trim();
  return detail.length > 0
    ? `Windows Credential Manager could not ${verb} the key: ${detail}`
    : `Windows Credential Manager could not ${verb} the key (exit ${String(code)})`;
}

/**
 * Windows Credential Manager, one generic credential per account.
 *
 * CONSTRUCTION DOES NO I/O AND CANNOT FAIL — the contract's rule, and the reason a
 * machine with no PowerShell still starts the app and reports the problem on the first
 * read, rather than as a start-up blocker that hides every other one.
 */
export function createWindowsSecretStore(options: WindowsSecretStoreOptions): SecretStore {
  const run = options.run ?? defaultRunner;
  const target = (account: string): string => credentialTarget(options.service, account);

  const remove = async (account: string): Promise<void> => {
    const result = await run(['-Command', credentialDeleteScript(target(account))]);
    // NEVER SWALLOWED. A key that looks deleted and is not keeps sending text to the
    // endpoint, and the user has no way at all to find that out.
    if (result.code !== 0) throw new Error(secretFailure('delete', result.stderr, result.code));
  };

  return {
    async get(account: string): Promise<string | null> {
      const result = await run(['-Command', credentialReadScript(target(account))]);
      // 2 is "no such credential", which is an answer and not a failure.
      if (result.code === 2) return null;
      if (result.code !== 0) throw new Error(secretFailure('read', result.stderr, result.code));
      const decoded = Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
      return decoded.length === 0 ? null : decoded;
    },

    async set(account: string, value: string): Promise<void> {
      // AN EMPTY VALUE DELETES. The Settings pane clears the field to remove the key, and
      // a stored empty string would still read as "a key is present" to `secretPresent()`.
      if (value.length === 0) {
        await remove(account);
        return;
      }
      const result = await run(['-Command', credentialWriteScript(target(account), value)]);
      if (result.code !== 0) throw new Error(secretFailure('save', result.stderr, result.code));
    },

    remove,
  };
}

/**
 * The polish API key, in Windows Credential Manager — never in the settings file,
 * because anything in that file could end up in a support bundle.
 */
export const createSecretStore: CreateSecretStore = (options) =>
  createWindowsSecretStore({ service: options.service });

// ---------------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------------

/**
 * `%APPDATA%\Kotiba`, the roaming half of the layout.
 *
 * Built by `core/settings/paths.ts` — the TESTED one, which assembles backslash paths
 * from the environment by hand rather than with `node:path`, because every developer
 * here is on a Mac and `path.join` on a Mac produces forward slashes that no test run
 * from this machine would ever catch. D-W10 names path building as one of exactly two
 * places Windows differs silently.
 *
 * macOS uses `~/Library/Application Support/Kotiba` and stays deliberately OUT of a
 * sandbox container. Windows has no sandbox to escape, but the directory must still be
 * created rather than assumed: on iOS the same assumption surfaced as
 * `NSFileWriteNoPermissionError`, which reads like a permissions problem and is not one.
 */
export function supportDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return kotibaPaths(env).roamingDirectory;
}

/**
 * The directory shipped alongside the executable, holding the three bundled models and
 * the three helper binaries.
 *
 * This is the Windows stand-in for the macOS app bundle's `Resources/models`, and it is
 * LAST in the three-step model resolution — a newer model dropped into
 * `%APPDATA%\Kotiba\models` by hand must beat the one inside the install.
 *
 * `process.resourcesPath` is READ off `process`, never imported from `electron`: this
 * module may not import Electron, and `--check` resolves the same directory with no
 * Electron around it at all.
 */
export function bundledResourcesDirectory(): string {
  const packed = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof packed === 'string' && packed.length > 0) return packed;
  const executable = process.execPath;
  const cut = Math.max(executable.lastIndexOf('\\'), executable.lastIndexOf('/'));
  return cut > 0 ? executable.slice(0, cut) : '.';
}
