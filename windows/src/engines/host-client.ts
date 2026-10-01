// The client half of the kotiba-stt protocol: spawn it, frame requests, time them out,
// and bring it back when it dies.
//
// The wire format is documented in windows/native/kotiba-stt/src/main.cpp. In short:
//
//     "KSTT" <8 hex headerBytes> <8 hex payloadBytes> "\n"     — 21 bytes, fixed
//     <headerBytes of UTF-8 JSON>
//     <payloadBytes of float32, little-endian>
//
// and one line of JSON comes back per request.
//
// TWO THINGS THIS FILE IS RESPONSIBLE FOR AND NOTHING ELSE IS:
//
//   * SERIALISATION. `whisper_full` mutates the KV cache, `state->result_all` and the
//     logits of the context it was given, and whisper.h says so in as many words: "Not
//     thread safe for same context". The host is a single loop so it cannot overlap two
//     decodes itself — but a client that writes a second frame while the first is still
//     running interleaves nothing and simply queues, which is fine, EXCEPT that the
//     responses then have to be matched up and a timeout on the first would cancel the
//     wrong one. So every request goes through one promise chain per host. `await` is a
//     suspension point exactly as Swift's is, and "JavaScript is single-threaded" does
//     not serialise anything across one.
//
//   * RESTART. The host is a child process and it can die — OOM, a corrupt model that
//     takes ggml down with it, a user killing it. A death is reported, never silent, and
//     the next request spawns a fresh one and reloads the model. What must NOT happen is
//     a restart loop: a host that dies on load will die on every load, so consecutive
//     failures are counted and the client refuses rather than fork-bombing a laptop.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EngineFailure, engineError } from '../contracts/index.js';

/** `KSTT` + 8 hex + 8 hex + `\n`. */
const PREFIX_BYTES = 21;
const MAGIC = 'KSTT';

/**
 * How long one decode may take before the host is presumed hung.
 *
 * Generous on purpose. `large-v3-turbo` on a cold CPU-only laptop is seconds, and the
 * cold-start load in front of it is more; a timeout that fires on a slow machine turns
 * "your first dictation is slow" into "your app is broken", which is the failure mode
 * the readiness rules exist to prevent.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Loading 539 MB from a spinning disk on first launch is not fast. */
export const DEFAULT_LOAD_TIMEOUT_MS = 180_000;

/**
 * Consecutive spawn-or-die failures before the client stops trying.
 *
 * A host that dies on load dies on every load. Three attempts distinguishes "the machine
 * hiccupped" from "this model kills ggml", and the second must become a sentence the
 * user reads rather than a process the OS keeps reaping.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface HostResponse {
  readonly ok: boolean;
  readonly id?: string;
  readonly code?: string;
  readonly error?: string;
  readonly text?: string;
  readonly segments?: number;
  readonly ms?: number;
  readonly posterior?: Readonly<Record<string, number>>;
  /** Host 1.1: the encoder window a transcribe ran with. */
  readonly audioCtx?: number;
  /** Host 1.1: `vad_open`'s handle and frame size, `vad`'s per-frame probabilities. */
  readonly handle?: number;
  readonly frameSamples?: number;
  readonly probs?: readonly number[];
  /** Host 1.1: whether an `abort` found its target running. */
  readonly running?: boolean;
  readonly host?: string;
  readonly whisper?: string;
  readonly logicalCores?: number;
  readonly physicalCores?: number;
  readonly performanceCores?: number;
}

/** What the host said about itself and the machine, from `hello`. */
export interface HostGreeting {
  readonly host: string;
  readonly whisper: string;
  readonly logicalCores: number;
  /** 0 when the platform would not say. Never divide by it. */
  readonly physicalCores: number;
  readonly performanceCores: number;
}

export interface SttHostOptions {
  /** Path to `kotiba-stt.exe`. */
  readonly hostPath: string;
  readonly requestTimeoutMs?: number;
  readonly loadTimeoutMs?: number;
  /** Injected in tests. Defaults to `node:child_process.spawn`. */
  readonly spawnProcess?: (path: string) => ChildProcessWithoutNullStreams;
  /** Every spawn, death and refusal, for the diagnostics pane. */
  readonly onNote?: (note: string) => void;
  /**
   * The host process went away and whatever it had loaded went with it.
   *
   * Distinct from `onNote`, which is prose for a human. This is a FACT the owning engine
   * has to act on: `SttEngine.isReady()` answers "is the model resident", and a resident
   * flag that survives the process holding the weights is a lie that costs the user a
   * second failed dictation. Fires for a crash, for a spawn failure, and for the kill
   * this client performs on a hung host — NOT for `dispose()`, where the engine is going
   * away too.
   */
  readonly onExit?: (reason: string) => void;
}

export interface SttHost {
  /**
   * Sends one request and resolves with the host's line. Queued behind every earlier
   * request on this host.
   *
   * Throws `EngineFailure` with `hostUnavailable` when the process died or would not
   * start, and with `transcriptionFailed` when the host refused the request — a refusal
   * and a death are different states and the caller has to be able to tell them apart.
   */
  request(header: Record<string, unknown>, samples?: Float32Array): Promise<HostResponse>;
  /**
   * Host 1.1: a request the host answers AT ONCE, from its reader thread, whatever it is
   * decoding — `abort` and the `vad_*` ops. NOT queued behind the serialised requests, and
   * matched by id rather than by order: the id is made to start with `!`, which is how an
   * immediate answer is told from the one the serialised request is waiting for. A host too
   * old to know the op refuses it with `unknown_op`, which the caller treats as "not here".
   */
  immediate(header: Record<string, unknown>, samples?: Float32Array): Promise<HostResponse>;
  /** `hello`, cached for the life of the process. `null` when it could not be asked. */
  greeting(): Promise<HostGreeting | null>;
  readonly isRunning: boolean;
  /** Number of times this host has been respawned. Recorded, never hidden. */
  readonly restarts: number;
  dispose(): Promise<void>;
}

/**
 * Encodes one frame. Exported for the framing test — a round-trip test of the encoder
 * against a hand-built buffer is what catches an endianness or padding mistake, and
 * neither shows up as anything but bad accuracy at runtime.
 */
export function encodeFrame(header: Record<string, unknown>, samples?: Float32Array): Buffer {
  const body = Buffer.from(JSON.stringify(header), 'utf8');
  // Float32Array over its own buffer, honouring byteOffset — a subarray of a larger
  // capture buffer is the normal case and copying the whole ring would be a real cost.
  const payload =
    samples && samples.length > 0
      ? Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
      : Buffer.alloc(0);
  const prefix = Buffer.from(
    `${MAGIC}${hex8(body.length)}${hex8(payload.length)}\n`,
    'ascii',
  );
  return Buffer.concat([prefix, body, payload], PREFIX_BYTES + body.length + payload.length);
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, '0');
}

interface Pending {
  resolve: (response: HostResponse) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createSttHost(options: SttHostOptions): SttHost {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const spawnProcess =
    options.spawnProcess ??
    // `windowsHide` is not cosmetic here. `kotiba-stt.exe` is a CONSOLE-subsystem
    // executable, so a GUI Electron process spawning it gets a real conhost window per
    // host — and there are three of them, one per model. `hotkey.ts` and `insert.ts`
    // both set it for the same reason; this was the one spawn that did not.
    ((path: string) => spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  const note = options.onNote ?? (() => {});
  const onExit = options.onExit ?? (() => {});

  let child: ChildProcessWithoutNullStreams | null = null;
  let pending: Pending | null = null;
  let stdout = '';
  let stderrTail = '';
  let consecutiveFailures = 0;
  let restarts = 0;
  let disposed = false;
  let greetingCache: HostGreeting | null = null;

  /** The serialisation chain. Every request awaits its predecessor before it is written. */
  let chain: Promise<unknown> = Promise.resolve();
  /** Immediate requests in flight, by id (always `!`-prefixed). */
  const immediates = new Map<string, Pending>();
  let immediateCounter = 0;

  function settleWithFailure(reason: string): void {
    for (const [, waiting] of immediates) {
      clearTimeout(waiting.timer);
      waiting.reject(new EngineFailure(engineError.hostUnavailable(reason)));
    }
    immediates.clear();
    const waiting = pending;
    pending = null;
    if (waiting === null) return;
    clearTimeout(waiting.timer);
    waiting.reject(new EngineFailure(engineError.hostUnavailable(reason)));
  }

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    // An immediate answer, matched by id. Anything that does not parse, or whose id is not
    // an immediate one, belongs to the serialised request, exactly as before.
    if (trimmed.includes('"id":"!')) {
      try {
        const parsed = JSON.parse(trimmed) as HostResponse;
        const waiting = parsed.id === undefined ? undefined : immediates.get(parsed.id);
        if (waiting !== undefined && parsed.id !== undefined) {
          immediates.delete(parsed.id);
          clearTimeout(waiting.timer);
          waiting.resolve(parsed);
          return;
        }
        // An immediate's id with nobody waiting: its request TIMED OUT and the host was only
        // slow. It must never fall through — the serialised request in flight would take
        // this `{ok:true}` with no text as its transcript, and the dictation would come out
        // silently empty.
        if (typeof parsed.id === 'string' && parsed.id.startsWith('!')) {
          note(`kotiba-stt: late answer to ${parsed.id}, dropped`);
          return;
        }
      } catch {
        /* falls through to the serialised request */
      }
    }
    const waiting = pending;
    if (waiting === null) {
      // The host answered something nobody is waiting for. Recorded rather than ignored:
      // it means the request/response pairing has slipped, which is worth knowing about.
      note(`kotiba-stt: unmatched response ${trimmed.slice(0, 120)}`);
      return;
    }
    pending = null;
    clearTimeout(waiting.timer);
    try {
      waiting.resolve(JSON.parse(trimmed) as HostResponse);
    } catch {
      waiting.reject(
        new EngineFailure(
          engineError.hostUnavailable(`the host wrote a line that is not JSON: ${trimmed.slice(0, 120)}`),
        ),
      );
    }
  }

  function start(): ChildProcessWithoutNullStreams {
    const process_ = spawnProcess(options.hostPath);
    child = process_;
    stdout = '';
    stderrTail = '';

    process_.stdout.setEncoding('utf8');
    process_.stdout.on('data', (chunk: string) => {
      // THE SAME GUARD THE `error` AND `close` HANDLERS ALREADY HAD, and its absence
      // here was worse than either of theirs.
      //
      // `stdout`, `pending` and the splitter below are shared closure state, not
      // per-process. A host killed for hanging (see the timeout in `send`) can still
      // have a complete line sitting in its pipe, and the OS delivers it to the parent
      // after the kill. Without this line that late chunk is appended to the NEW
      // process's buffer and `handleLine` resolves the NEW pending request with it: the
      // previous utterance is inserted for the current one, and nothing reports an
      // error, because from the client's point of view the request succeeded.
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
      // Only the tail: the host's stderr is diagnostics, and an unbounded string here is
      // a leak in a process that runs for days.
      stderrTail = (stderrTail + chunk).slice(-4096);
    });

    process_.on('error', (error: Error) => {
      // Only the process this client is currently using may settle its request. A
      // straggler event from one we already replaced must not reject a live call.
      if (child !== process_) return;
      child = null;
      consecutiveFailures += 1;
      note(`kotiba-stt would not start: ${error.message}`);
      settleWithFailure(error.message);
      onExit(error.message);
    });

    process_.on('close', (code: number | null, signal: string | null) => {
      if (child !== process_) return;
      child = null;
      const how =
        signal !== null ? `killed by ${signal}` : `exited with code ${code ?? 'unknown'}`;
      // A clean exit after a dispose is not a failure and must not count toward the
      // restart budget.
      if (!disposed) {
        consecutiveFailures += 1;
        note(`kotiba-stt ${how}${stderrTail.length > 0 ? ` — ${stderrTail.trim().slice(-300)}` : ''}`);
      }
      settleWithFailure(how);
      // Not on a dispose: the engine that owns this host is going away too, and telling
      // it its model is gone is noise at best.
      if (!disposed) onExit(how);
    });

    return process_;
  }

  function ensureRunning(): ChildProcessWithoutNullStreams {
    if (child !== null) return child;
    if (disposed) {
      throw new EngineFailure(engineError.hostUnavailable('the engine has been shut down'));
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new EngineFailure(
        engineError.hostUnavailable(
          `kotiba-stt died ${consecutiveFailures} times in a row and will not be restarted again` +
            (stderrTail.trim().length > 0 ? ` — ${stderrTail.trim().slice(-300)}` : ''),
        ),
      );
    }
    if (restarts > 0 || consecutiveFailures > 0) {
      note(`kotiba-stt restarting (attempt ${consecutiveFailures + 1})`);
    }
    const started = start();
    restarts += 1;
    return started;
  }

  function send(header: Record<string, unknown>, samples?: Float32Array): Promise<HostResponse> {
    return new Promise<HostResponse>((resolve, reject) => {
      let process_: ChildProcessWithoutNullStreams;
      try {
        process_ = ensureRunning();
      } catch (error) {
        reject(error);
        return;
      }

      const isLoad = header['op'] === 'load';
      // THE BUDGET GROWS WITH THE AUDIO. A fixed 120 s killed every whisper batch decode
      // longer than that — English and Russian before Parakeet lands, and an Uzbek stream
      // that falls back to one whole-recording decode — and a 10–30 minute hold on a laptop
      // CPU takes longer than 120 s to decode. The host was then killed and the text lost.
      // Two seconds per second of audio on top of the fixed floor: a hung host is still
      // found, only later for a long recording, and a slow one is never mistaken for it.
      const audioMs = samples === undefined ? 0 : (samples.length / 16_000) * 1000;
      const timeoutMs = isLoad ? loadTimeoutMs : requestTimeoutMs + Math.ceil(2 * audioMs);
      const timer = setTimeout(() => {
        pending = null;
        note(`kotiba-stt did not answer '${String(header['op'])}' within ${timeoutMs} ms — killing it`);
        // A hung host is not recoverable by waiting. Kill it so the NEXT request gets a
        // fresh process rather than queueing behind a decode that will never finish.
        //
        // Dropping the reference here, BEFORE the kill lands, is load-bearing: `close`
        // is asynchronous, so without it the next request finds a child that is still
        // non-null, writes into a dying pipe, and is rejected by the death of a process
        // it never used. Clearing it makes `ensureRunning` spawn a fresh one instead,
        // and makes the `close` handler's `child !== process_` guard skip the
        // already-settled request.
        if (child === process_) child = null;
        consecutiveFailures += 1;
        try {
          process_.kill();
        } catch {
          /* already gone */
        }
        // The `close` handler will skip this process (`child !== process_`), so the
        // death has to be reported from here or the owning engine never hears about the
        // one kind of death this client causes itself.
        onExit(`the engine did not answer within ${timeoutMs} ms`);
        reject(
          new EngineFailure(
            engineError.hostUnavailable(`the engine did not answer within ${timeoutMs} ms`),
          ),
        );
      }, timeoutMs);

      pending = { resolve, reject, timer };

      try {
        process_.stdin.write(encodeFrame(header, samples));
      } catch (error) {
        pending = null;
        clearTimeout(timer);
        reject(
          new EngineFailure(
            engineError.hostUnavailable(
              `could not write to the engine: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
      }
    });
  }

  async function request(
    header: Record<string, unknown>,
    samples?: Float32Array,
  ): Promise<HostResponse> {
    // Chained, not merely awaited. Assignment happens before the first suspension point,
    // so two callers cannot read the same predecessor — the same reason the Swift engine
    // keeps `inFlight` rather than relying on actor isolation.
    const previous = chain;
    const mine = previous.then(
      () => send(header, samples),
      () => send(header, samples),
    );
    chain = mine.then(
      () => undefined,
      () => undefined,
    );

    const response = await mine;
    // A response is proof the host is alive and speaking the protocol, whatever it said
    // about the request itself. A REFUSAL IS NOT A DEATH, and only a death may count
    // toward the restart budget.
    consecutiveFailures = 0;
    return response;
  }

  function immediate(header: Record<string, unknown>, samples?: Float32Array): Promise<HostResponse> {
    return new Promise<HostResponse>((resolve, reject) => {
      let process_: ChildProcessWithoutNullStreams;
      try {
        process_ = ensureRunning();
      } catch (error) {
        reject(error);
        return;
      }
      immediateCounter += 1;
      const id = `!${String(header['op'] ?? 'op')}-${String(immediateCounter)}`;
      // Short: the host answers these from its reader thread in microseconds to
      // milliseconds. A late answer is not worth killing a host over — it may be mid-decode
      // on a slow machine — so a timeout here only rejects the one call.
      const timer = setTimeout(() => {
        immediates.delete(id);
        reject(new EngineFailure(engineError.hostUnavailable(`'${String(header['op'])}' was not answered within 10 s`)));
      }, 10_000);
      immediates.set(id, { resolve, reject, timer });
      try {
        process_.stdin.write(encodeFrame({ ...header, id }, samples));
      } catch (error) {
        immediates.delete(id);
        clearTimeout(timer);
        reject(
          new EngineFailure(
            engineError.hostUnavailable(
              `could not write to the engine: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
      }
    });
  }

  async function greeting(): Promise<HostGreeting | null> {
    if (greetingCache !== null) return greetingCache;
    try {
      const response = await request({ id: 'hello', op: 'hello' });
      if (!response.ok) return null;
      greetingCache = {
        host: response.host ?? 'unknown',
        whisper: response.whisper ?? 'unknown',
        logicalCores: response.logicalCores ?? 0,
        physicalCores: response.physicalCores ?? 0,
        performanceCores: response.performanceCores ?? 0,
      };
      return greetingCache;
    } catch {
      // Non-throwing by design: the greeting is diagnostics, and failing to get it must
      // never stop a dictation.
      return null;
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const process_ = child;
    if (process_ === null) return;
    try {
      // Ask first. A host that exits cleanly frees the model without the OS having to
      // reclaim 539 MB of dirty pages.
      await Promise.race([
        request({ id: 'bye', op: 'shutdown' }),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      /* it is going away either way */
    }
    if (child !== null) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      child = null;
    }
  }

  return {
    request,
    immediate,
    greeting,
    get isRunning() {
      return child !== null;
    },
    get restarts() {
      return restarts;
    },
    dispose,
  };
}
