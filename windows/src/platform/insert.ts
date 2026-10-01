// Text insertion, and the client for `kotiba-input.exe`.  OWNER: t07
//
// May use Node. May NOT import `electron`.
//
// The helper's protocol is in windows/native/kotiba-input/PROTOCOL.md. This file owns
// the process — spawning it, framing requests, timing them out, bringing it back when
// it dies — and turns its `code` into the sentence the user reads.
//
// ---------------------------------------------------------------------------------
// WHY A CODE AND NOT A MESSAGE
// ---------------------------------------------------------------------------------
//
// The helper answers `{"ok":false,"code":"clipboardStolen"}` and this file looks the
// sentence up in `INSERTION_REFUSALS`. It never matches on the helper's prose. D-W10
// says why in as many words, and the bug it is quoting shipped: in `ai-balance/windows`
// the string `no GONKA_API_KEY / GONKA_BASE_URL stored` failed the regex
// `no [A-Z_]+ stored`, and a healthy app exited non-zero.
//
// ---------------------------------------------------------------------------------
// AN INSERTION IS NEVER A THROW
// ---------------------------------------------------------------------------------
//
// `InsertionOutcome` is `inserted` or `refused(reason)`, and every path here produces
// one — including "the helper is missing", "the helper died" and "the helper did not
// answer". The caller always has to record the reason and carry on, and a sink that
// reported success while delivering nothing is the exact defect this project exists to
// fix. So: no rethrows, no `undefined`, and no silent success.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  INSERTION_REFUSALS,
  type CreateInserter,
  type InsertionOutcome,
  type Inserter,
} from '../contracts/index.js';

/**
 * How long one command may take before the helper is presumed hung.
 *
 * Deliberately short. Insertion is the last step of a dictation the user is watching,
 * every path in the helper is a handful of Win32 calls, and the slowest of them —
 * opening a clipboard another application is holding — retries for under 200 ms before
 * giving up. Five seconds is far past any honest answer, and a hang beyond it is a
 * hang, not a slow machine.
 */
export const INPUT_REQUEST_TIMEOUT_MS = 5_000;

/** A helper that dies on every request is not going to start working. */
export const INPUT_MAX_CONSECUTIVE_FAILURES = 3;

/** Which way the text actually went in. Recorded, because a diagnostic that cannot tell
 * "we pasted" from "we typed" cannot explain an empty text field. */
export const INSERTION_PATHS = ['unicode', 'clipboard', 'automation'] as const;
export type InsertionPath = (typeof INSERTION_PATHS)[number];

/** One line back from the helper. Fields beyond `ok` are per-op; see its PROTOCOL.md. */
export interface InputResponse {
  readonly id?: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly detail?: string;
  readonly path?: InsertionPath;
  readonly units?: number;
  readonly clipboardSaved?: boolean;
  readonly restoreDelayMs?: number;
  readonly droppedFormats?: string;
  readonly heldModifiers?: string;
  readonly appId?: string;
  readonly displayName?: string;
  readonly pid?: number;
  readonly helper?: string;
  readonly version?: string;
  /** `audioSessions`: the playing sessions. */
  readonly sessions?: readonly {
    readonly id: string;
    readonly pid: number;
    readonly volume: number;
    readonly muted: boolean;
  }[];
  /** `setSessionVolume`: the level read back after the write (or found, on `userChanged`). */
  readonly volume?: number;
}

/**
 * Thrown by `InputHelper.request` when the helper itself is the problem — missing,
 * dead, or silent. A REFUSAL IS NOT THIS: a refusal is a response line with
 * `ok: false` from a process that is still running, and it comes back as a value.
 * Callers have to be able to tell "this app would not take the text" from "our helper
 * is gone", because only the second is a blocker in the tray.
 */
export class InputHelperUnavailable extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'InputHelperUnavailable';
  }
}

export interface InputHelper {
  request(command: Record<string, unknown>): Promise<InputResponse>;
  readonly isRunning: boolean;
  readonly restarts: number;
  dispose(): Promise<void>;
}

export interface InputHelperOptions {
  /** Path to `kotiba-input.exe`. */
  readonly helperPath: string;
  readonly requestTimeoutMs?: number;
  /** Injected in tests. Defaults to `node:child_process.spawn`. */
  readonly spawnProcess?: (path: string) => ChildProcessWithoutNullStreams;
  /** Every spawn, death and refusal, for the diagnostics pane. Never the inserted text. */
  readonly onNote?: (note: string) => void;
}

interface Pending {
  resolve: (response: InputResponse) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The process, shared.
 *
 * `createInserter` and `createFocusSource` both talk to `kotiba-input.exe`, and they
 * share ONE of these. Two would mean two processes, two COM apartments and two
 * clipboards' worth of state for a helper whose whole job is to be warm when a
 * dictation ends.
 *
 * Commands are serialised: one in flight, the rest queued behind it. There is no
 * request id matching here beyond the echo, because the helper answers strictly in
 * order and a queue is simpler to reason about than a correlation table — and the one
 * thing that must never happen is a timeout cancelling the wrong request.
 */
export function createInputHelper(options: InputHelperOptions): InputHelper {
  const spawnProcess =
    options.spawnProcess ??
    ((path: string) => spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  const note = options.onNote ?? (() => {});
  const requestTimeoutMs = options.requestTimeoutMs ?? INPUT_REQUEST_TIMEOUT_MS;

  let child: ChildProcessWithoutNullStreams | null = null;
  let pending: Pending | null = null;
  let stdout = '';
  let stderrTail = '';
  let consecutiveFailures = 0;
  let restarts = 0;
  let disposed = false;
  let nextId = 1;

  /** The serialisation chain. Every request awaits its predecessor before it is written. */
  let chain: Promise<unknown> = Promise.resolve();

  function settleWithFailure(reason: string): void {
    const waiting = pending;
    pending = null;
    if (waiting === null) return;
    clearTimeout(waiting.timer);
    waiting.reject(new InputHelperUnavailable(reason));
  }

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const waiting = pending;
    if (waiting === null) {
      note(`kotiba-input: unmatched response ${trimmed.slice(0, 120)}`);
      return;
    }
    pending = null;
    clearTimeout(waiting.timer);
    try {
      const response = JSON.parse(trimmed) as InputResponse;
      // An answer — of either kind — is proof the helper works, so the restart budget
      // starts over. It is reset HERE and not on a successful write: a helper that dies
      // while handling every request accepts every write, and resetting there would
      // make the budget unreachable and the restart loop unbounded.
      consecutiveFailures = 0;
      waiting.resolve(response);
    } catch {
      waiting.reject(
        new InputHelperUnavailable(`the helper wrote a line that is not JSON: ${trimmed.slice(0, 120)}`),
      );
    }
  }

  function start(): ChildProcessWithoutNullStreams {
    const process_ = spawnProcess(options.helperPath);
    child = process_;
    stdout = '';
    stderrTail = '';

    process_.stdout.setEncoding('utf8');
    process_.stdout.on('data', (chunk: string) => {
      if (child !== process_) return;
      stdout += chunk;
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        handleLine(line);
        newline = stdout.indexOf('\n');
      }
    });

    process_.stderr.setEncoding('utf8');
    process_.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2048);
    });

    process_.on('error', (error: Error) => {
      if (child !== process_) return;
      child = null;
      consecutiveFailures += 1;
      note(`kotiba-input would not start: ${error.message}`);
      settleWithFailure(error.message);
    });

    process_.on('close', (code: number | null, signal: string | null) => {
      if (child !== process_) return;
      child = null;
      const how = signal !== null ? `killed by ${signal}` : `exited with code ${code ?? 'unknown'}`;
      if (!disposed) {
        consecutiveFailures += 1;
        note(`kotiba-input ${how}${stderrTail.trim().length > 0 ? ` — ${stderrTail.trim().slice(-300)}` : ''}`);
      }
      settleWithFailure(how);
    });

    return process_;
  }

  function ensureRunning(): ChildProcessWithoutNullStreams {
    if (child !== null) return child;
    if (disposed) throw new InputHelperUnavailable('the insertion helper has been shut down');
    if (consecutiveFailures >= INPUT_MAX_CONSECUTIVE_FAILURES) {
      throw new InputHelperUnavailable(
        `kotiba-input died ${consecutiveFailures} times in a row and will not be restarted again` +
          (stderrTail.trim().length > 0 ? ` — ${stderrTail.trim().slice(-300)}` : ''),
      );
    }
    if (restarts > 0) note(`kotiba-input restarting (attempt ${consecutiveFailures + 1})`);
    const started = start();
    restarts += 1;
    return started;
  }

  function send(command: Record<string, unknown>): Promise<InputResponse> {
    return new Promise<InputResponse>((resolve, reject) => {
      let process_: ChildProcessWithoutNullStreams;
      try {
        process_ = ensureRunning();
      } catch (error) {
        reject(error);
        return;
      }

      const timer = setTimeout(() => {
        pending = null;
        note(`kotiba-input did not answer '${String(command['op'])}' within ${requestTimeoutMs} ms`);
        // Drop the reference BEFORE the kill lands. `close` is asynchronous, so without
        // this the next request finds a child that is still non-null, writes into a
        // dying pipe, and is rejected by the death of a process it never used.
        if (child === process_) child = null;
        consecutiveFailures += 1;
        try {
          process_.kill();
        } catch {
          /* already gone */
        }
        reject(new InputHelperUnavailable(`the helper did not answer within ${requestTimeoutMs} ms`));
      }, requestTimeoutMs);

      pending = { resolve, reject, timer };

      try {
        process_.stdin.write(`${JSON.stringify({ id: String(nextId++), ...command })}\n`);
      } catch (error) {
        pending = null;
        clearTimeout(timer);
        reject(
          new InputHelperUnavailable(
            `could not write to the helper: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  return {
    request(command: Record<string, unknown>): Promise<InputResponse> {
      const result = chain.then(
        () => send(command),
        () => send(command),
      );
      // The chain must not reject, or every later request inherits the rejection.
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    get isRunning(): boolean {
      return child !== null;
    },
    get restarts(): number {
      return restarts;
    },
    async dispose(): Promise<void> {
      disposed = true;
      const process_ = child;
      child = null;
      settleWithFailure('the insertion helper has been shut down');
      if (process_ === null) return;
      try {
        process_.stdin.end();
      } catch {
        /* already gone */
      }
      try {
        process_.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Turn the helper's `code` into the sentence the user reads.
 *
 * An unknown code is not a crash and not a lie: it becomes its own sentence, so a
 * helper newer than this file still produces something honest in the HUD.
 */
export function refusalReason(code: string | undefined, detail: string | undefined): string {
  switch (code) {
    case 'empty':
      return INSERTION_REFUSALS.empty;
    case 'nothingToReplace':
      return INSERTION_REFUSALS.nothingToReplace;
    case 'clipboardRefused':
      return INSERTION_REFUSALS.clipboardRefused;
    case 'clipboardStolen':
      return INSERTION_REFUSALS.clipboardStolen;
    case 'couldNotSendKeys':
      return INSERTION_REFUSALS.couldNotSendKeys;
    case 'moved':
      return INSERTION_REFUSALS.moved;
    case 'notEditable':
      return INSERTION_REFUSALS.notEditable;
    default:
      return detail !== undefined && detail.length > 0
        ? `the insertion helper refused: ${detail}`
        : `the insertion helper refused (${code ?? 'no reason given'})`;
  }
}

export interface InserterOptions {
  /** Path to `kotiba-input.exe`. Ignored when `helper` is supplied. */
  readonly helperPath: string;
  /** Share one helper process with the focus source. */
  readonly helper?: InputHelper;
  /**
   * Which path the helper should use. `auto` types the text as unicode and falls back
   * to the clipboard only when Windows refuses the injection outright.
   */
  readonly path?: 'auto' | 'unicode' | 'clipboard';
  /** Parity with `PasteboardSink.restoreDelay`. Clipboard path only. */
  readonly restoreDelayMs?: number;
  readonly onNote?: (note: string) => void;
  readonly spawnProcess?: (path: string) => ChildProcessWithoutNullStreams;
  readonly requestTimeoutMs?: number;
}

export function createInserter(options: InserterOptions): Inserter {
  const owned = options.helper === undefined;
  const helper =
    options.helper ??
    createInputHelper({
      helperPath: options.helperPath,
      ...(options.onNote !== undefined ? { onNote: options.onNote } : {}),
      ...(options.spawnProcess !== undefined ? { spawnProcess: options.spawnProcess } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
  const note = options.onNote ?? (() => {});

  async function run(command: Record<string, unknown>): Promise<InsertionOutcome> {
    let response: InputResponse;
    try {
      response = await helper.request(command);
    } catch (error) {
      // The helper is gone. Still an outcome, never a throw — a dictation that reached
      // this point has already been recorded and the user is owed a sentence.
      return {
        kind: 'refused',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.ok) {
      // The path taken is worth a note and the text never is. Diagnostics carries no
      // transcript by design (see `DiagnosticsSink.summary`), and the inserted text is
      // the transcript.
      note(`kotiba-input inserted via ${response.path ?? 'unknown path'}`);
      if (response.droppedFormats !== undefined && response.droppedFormats.length > 0) {
        note(`kotiba-input could not preserve clipboard formats: ${response.droppedFormats}`);
      }
      if (response.heldModifiers !== undefined && response.heldModifiers.length > 0) {
        note(`kotiba-input pasted while ${response.heldModifiers} was held`);
      }
      return { kind: 'inserted' };
    }
    return { kind: 'refused', reason: refusalReason(response.code, response.detail) };
  }

  return {
    async insert(text: string): Promise<InsertionOutcome> {
      // Checked here as well as in the helper: a round trip to say "nothing to insert"
      // is a round trip on the critical path of every silent dictation, and silence is
      // common enough that macOS has a rule for it (peak below 0.012 delivers an empty
      // paste).
      if (text.length === 0) return { kind: 'refused', reason: INSERTION_REFUSALS.empty };
      return run({
        op: 'insert',
        text,
        path: options.path ?? pathFor(text),
        ...(options.restoreDelayMs !== undefined ? { restoreDelayMs: options.restoreDelayMs } : {}),
      });
    },

    async replace(previous: string, text: string): Promise<InsertionOutcome> {
      if (previous.length === 0) {
        return { kind: 'refused', reason: INSERTION_REFUSALS.nothingToReplace };
      }
      // This used to refuse unconditionally on macOS, which meant every polish ever
      // computed was discarded after being paid for — the whole mode system did nothing
      // while appearing to work. It must reach the helper.
      return run({ op: 'replace', previous, text });
    },

    async dispose(): Promise<void> {
      // Only tear down a helper this inserter created. A shared one belongs to whoever
      // made it, and disposing it here would take the focus source down with it.
      if (owned) await helper.dispose();
    },
  };
}

/**
 * `auto` (typed as unicode, the clipboard only if Windows refuses) for one line of text; the
 * CLIPBOARD for anything with a line break or a tab.
 *
 * Typed, a line break is a `KEYEVENTF_UNICODE` U+000A, and what an app does with that is
 * its own business: an edit control may drop it, a chat box (Telegram, Slack, a browser's
 * message field) reads it as Enter and SENDS the message half-way through a Note checklist
 * or a multi-paragraph Message, and a tab moves the focus to the next field. Pasted, the
 * text lands whole — which is what the Mac, which always pastes, does.
 */
export function pathFor(text: string): 'auto' | 'clipboard' {
  return /[\n\r\t]/u.test(text) ? 'clipboard' : 'auto';
}

/** The `CreateInserter` factory the composition root wires. */
export const createInserterFactory: CreateInserter = (options) =>
  createInserter({ helperPath: options.helperPath });
