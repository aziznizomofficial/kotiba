// One file from the network to disk — the ONE downloader both stores use (`bundle-store.ts` for
// Parakeet, Qwen, Cohere, Gemma; `model-store.ts` for whisper turbo and a repair of the Uzbek
// model). Owner, 2026-11-17: "downloading the language models kept failing".
//
// What a 650 MB encoder plus a 1.28 GB GGUF meets on Uzbek mobile and home networks, and what
// each now does:
//
//   * THE CONNECTION DROPS mid-body ("other side closed", ECONNRESET, a Wi-Fi hand-over, sleep).
//     It used to be one attempt: the row went `failed` and the user had to click Try again.
//     Now: retried with capped exponential backoff, each retry resumed from the partial with
//     `Range`, and an attempt that MOVED (wrote at least `progressBytes`) resets the count — a
//     line that drops every 100 MB still finishes, only a line that is down gives up.
//   * THE CONNECTION STALLS — a TCP connection that dies without a RST never errors. undici's
//     own body timeout is 300 s, so the bar froze for five minutes per stall. Now: no byte for
//     `stallMs` (headers or body) and the attempt is abandoned and retried, resumed.
//   * HUGGING FACE ANSWERS 429 or 5xx (its Xet/CDN bridge does, under load). Retried, honouring
//     `Retry-After`. Any other 4xx is final: retrying a 404 helps nobody.
//   * A RANGE ANSWERED WITH 200, or a 206 starting at the wrong byte (`Content-Range`): the
//     partial is not a prefix of that body, so the file restarts rather than being spliced.
//     416 means the server's file is shorter than our partial: restart clean.
//   * THE DISK IS FULL. Checked before every request (`statfs`), and ENOSPC from a write is
//     caught: "needs 1.28 GB, 0.4 GB free", never a raw errno. The partial is kept.
//   * ANTIVIRUS holds the finished file. Defender (and Kaspersky, common here) scans a large
//     file that was just closed, and a rename during the scan fails EPERM/EBUSY. Retried with
//     a growing delay before it is called a failure; the verified partial survives either way.
//   * A QUIT mid-way. The caller's `signal` aborts the transfer; the handle is closed, and the
//     partial is what the next launch resumes.
//
// Verification is unchanged and is the guarantee: the WHOLE file is hashed (the bytes already on
// disk first, then the rest as it arrives) and renamed into place only when size and sha256 both
// match the pin. A resumed file that fails it — an upstream that changed under an unpinned URL,
// a partial from different bytes — is discarded and fetched once more from byte 0 in the same
// call; a clean download that fails it is a real corruption and is final.
//
// Memory: one chunk at a time. The model store used to `Buffer.concat` the whole body — 574 MB
// of turbo in the Electron main process of an 8 GB laptop — before hashing it.

import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, stat, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { formatDecimal, t } from '../core/i18n/index.js';

/** What an unfinished download is called while it waits to be resumed. */
export const PARTIAL_SUFFIX = '.partial';

/**
 * Why a download stopped, as a value — set here, where it is known, never recovered from the
 * sentence (D-W10's rule). `retryLater` is what the app's queue asks: whether trying again in a
 * few minutes can help (a dead line, a busy server, a full disk the user may clear) or not (a
 * 404, a corrupt body, a quit).
 */
export type DownloadFailureKind = 'network' | 'server' | 'refused' | 'corrupt' | 'diskFull' | 'locked' | 'aborted';

export class DownloadError extends Error {
  readonly kind: DownloadFailureKind;
  readonly retryLater: boolean;
  /** English, for the diagnostics log — the message is the user's, in their language. */
  readonly detail: string;

  constructor(kind: DownloadFailureKind, message: string, detail: string) {
    super(message);
    this.name = 'DownloadError';
    this.kind = kind;
    this.detail = detail;
    this.retryLater = kind === 'network' || kind === 'server' || kind === 'diskFull' || kind === 'locked';
  }
}

/** Whether a failure is worth trying again later. Duck-typed: the error may have crossed a module. */
export function retryLater(error: unknown): boolean {
  return (error as { retryLater?: unknown } | null)?.retryLater === true;
}

export interface DownloadPolicy {
  /** Failed attempts IN A ROW before the call gives up. An attempt that moved resets the count. */
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** No byte for this long — waiting for headers or between chunks — and the attempt is dead. */
  readonly stallMs: number;
  /** What an attempt must write to count as progress (and so reset the failure count). */
  readonly progressBytes: number;
  /** Renames tried while antivirus holds the finished file, `renameDelayMs × n` apart. */
  readonly renameAttempts: number;
  readonly renameDelayMs: number;
}

/**
 * Six dead attempts in a row ≈ 2 + 4 + 8 + 16 + 32 s of waiting ≈ one minute of a line that
 * does not answer at all. Past that the row says why and the APP's queue tries again later
 * (`index.ts`, `scheduleDownloadRetry`) — the call does not hold the queue for hours. 30 s of
 * silence is a dead connection: URLSession, the Mac's transport, gives up after 60 s.
 */
export const DEFAULT_DOWNLOAD_POLICY: DownloadPolicy = {
  attempts: 6,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  stallMs: 30_000,
  progressBytes: 256 * 1024,
  renameAttempts: 10,
  renameDelayMs: 250,
};

/** The seams, all injectable — a unit test never reaches the network, the clock or a real disk-full. */
export interface DownloadIo {
  readonly fetch: typeof fetch;
  /** Waits `ms`, rejecting at once when `signal` aborts. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Free bytes on the volume holding `directory`, or `null` when it cannot be told. */
  readonly freeBytes?: (directory: string) => Promise<number | null>;
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** 0…1, for the backoff's jitter. */
  readonly random?: () => number;
}

export interface FileProgress {
  /** Bytes of this file on disk, never less than reported before, never more than `totalBytes`. */
  readonly bytes: number;
  readonly totalBytes: number | null;
  /** The connection was lost and the next attempt is being waited for. */
  readonly retrying: boolean;
}

export interface DownloadRequest {
  readonly url: string;
  readonly destination: string;
  /** For the notes: "Parakeet Ultra: int8/encoder-model.int8.onnx". */
  readonly label: string;
  /** Exact size, or `null` when unknown. */
  readonly bytes: number | null;
  /** Lowercase hex, or `''` when unknown — then nothing is resumed, since nothing could verify it. */
  readonly sha256: string;
  readonly onProgress?: (progress: FileProgress) => void;
  readonly signal?: AbortSignal;
  readonly note?: (text: string) => void;
  readonly policy?: Partial<DownloadPolicy>;
}

export interface DownloadedFile {
  readonly bytes: number;
  readonly sha256: string;
}

/** A fault the next attempt may not have. Internal: what leaves `downloadFile` is a `DownloadError`. */
class Retryable extends Error {
  constructor(
    readonly kind: 'network' | 'server' | 'locked',
    readonly detail: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(detail);
  }
}

/** The partial changed shape under us (wrong resume point, 416): discard it, try again at once. */
class Restart extends Error {}

/** Megabytes, or gigabytes past one — the same units the Languages page prints. */
export function sizeText(bytes: number): string {
  return bytes >= 1_000_000_000
    ? t('unit.gb', { value: formatDecimal(bytes / 1_000_000_000, 2) })
    : t('unit.mb', { value: String(Math.max(0, Math.round(bytes / 1_000_000))) });
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** undici says "fetch failed" and hides the reason in `cause`; the cause is what the log needs. */
function networkCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const inner = cause instanceof Error ? (errorCode(cause) ?? cause.message) : cause === undefined ? null : String(cause);
  const own = errorCode(error) ?? error.message;
  return inner === null || inner === own ? own : `${own}: ${inner}`;
}

function abortedError(label: string): DownloadError {
  return new DownloadError('aborted', t('dl.why.stopped'), `${label}: stopped`);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `statfs` is on every platform Node runs on, Windows included (libuv's GetDiskFreeSpaceExW). */
async function statfsFree(directory: string): Promise<number | null> {
  try {
    const info = await statfs(directory);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function remove(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/** `Content-Range: bytes 100-999/1000` → its first byte and the whole length (`null` for `*`). */
export function parseContentRange(header: string | null): { readonly start: number; readonly total: number | null } | null {
  const match = /^\s*bytes\s+(\d+)-\d+\/(\d+|\*)\s*$/iu.exec(header ?? '');
  if (match === null) return null;
  return { start: Number(match[1]), total: match[2] === '*' ? null : Number(match[2]) };
}

/** `Retry-After` in seconds or as an HTTP date; `null` when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * The race every await on the network runs: the work, a stall deadline, and the caller's abort.
 * Raced here rather than trusted to `fetch`'s own signal handling, so a transport that ignores
 * the signal (or a test double) cannot freeze the bar either.
 */
function guarded<T>(work: Promise<T>, stallMs: number, signal: AbortSignal | undefined, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError(label));
    const timer = setTimeout(
      () => reject(new Retryable('network', `no data for ${Math.round(stallMs / 1000)} s — the connection stalled`)),
      stallMs,
    );
    if (signal?.aborted === true) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  });
}

/** Every byte of `chunk`, even if the OS takes it in pieces. */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error('the disk accepted no bytes');
    offset += bytesWritten;
  }
}

const FS_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const FS_FULL = new Set(['ENOSPC', 'EDQUOT']);

/**
 * Download `request.url` to `request.destination`, resumably, verified, retried. Resolves once
 * the verified file is at `destination`; rejects with a `DownloadError` whose message is the
 * user's sentence. Leaves `<destination>.partial` behind on every failure but a corrupt one.
 */
export async function downloadFile(request: DownloadRequest, io: DownloadIo): Promise<DownloadedFile> {
  const policy: DownloadPolicy = { ...DEFAULT_DOWNLOAD_POLICY, ...request.policy };
  const sleepWith = io.sleep ?? abortableSleep;
  /** The wait between attempts, ended by a quit even if the injected clock ignores the signal. */
  const sleep = (ms: number, until?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('aborted'));
      if (until?.aborted === true) onAbort();
      until?.addEventListener('abort', onAbort, { once: true });
      sleepWith(ms, until)
        .then(resolve, reject)
        .finally(() => until?.removeEventListener('abort', onAbort));
    });
  const freeBytes = io.freeBytes ?? statfsFree;
  const random = io.random ?? Math.random;
  const note = request.note ?? ((): void => undefined);
  const { label, signal } = request;
  const partial = `${request.destination}${PARTIAL_SUFFIX}`;
  const resumable = request.sha256 !== '';
  const pinned = request.bytes;

  // THE HASH COVERS partial[0, hashed). Whenever the file on disk is not exactly that long — a
  // previous run's partial, a write that failed half-way — it is re-read from disk, so the
  // whole file is hashed exactly once however many attempts assembled it.
  let hash: Hash = createHash('sha256');
  let hashed = 0;
  const resetHash = (): void => {
    hash = createHash('sha256');
    hashed = 0;
  };
  /** Bytes appended to bytes an earlier response (or run) wrote: a resume, which can splice. */
  let spliced = false;
  let cleanRetryUsed = false;
  /** The length the server announced, when the pin has none (Fast English). */
  let announced: number | null = null;
  /** Bytes the current attempt wrote — what decides whether it "moved". */
  let attemptBytes = 0;

  let reported = 0;
  const report = (onDisk: number, retrying: boolean): void => {
    const total = pinned ?? announced;
    reported = Math.max(reported, onDisk);
    if (total !== null) reported = Math.min(reported, total);
    request.onProgress?.({ bytes: reported, totalBytes: total, retrying });
  };

  /** One request: what is missing, appended (206) or from byte 0 (200). */
  async function transfer(have: number): Promise<void> {
    const need = (pinned ?? 0) - have;
    if (need > 0) {
      const free = await freeBytes(dirname(partial));
      if (free !== null && free < need) {
        throw new DownloadError(
          'diskFull',
          t('dl.why.disk', { need: sizeText(need), free: sizeText(free) }),
          `${label}: needs ${need} bytes, ${free} free`,
        );
      }
    }

    const controller = new AbortController();
    const forward = (): void => controller.abort();
    signal?.addEventListener('abort', forward, { once: true });
    let iterator: AsyncIterator<Uint8Array> | null = null;
    let finished = false;
    try {
      const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {};
      const response = await guarded(
        // Through a `then`, so a transport that throws synchronously is a failed attempt too.
        Promise.resolve().then(() =>
          io.fetch(request.url, { headers, signal: controller.signal, cache: 'no-store', redirect: 'follow' }),
        ),
        policy.stallMs,
        signal,
        label,
      );
      const status = response.status;
      if (status === 416) {
        // The server's file ends before our partial does: it is not the file the partial began.
        throw new Restart(`the server cannot continue from byte ${have} (HTTP 416)`);
      }
      if (status === 429 || status === 408 || status >= 500) {
        throw new Retryable('server', `HTTP ${status}`, status, retryAfterMs(response.headers.get('retry-after')));
      }
      if (!response.ok) {
        throw new DownloadError('refused', t('dl.why.refused', { status: String(status) }), `${label}: HTTP ${status}`);
      }
      if (response.body === null) throw new Retryable('network', `HTTP ${status} with no body`);

      // Where this body starts. 206 continues the partial only if `Content-Range` says it starts
      // exactly where the partial ends — a CDN that resumed elsewhere would splice a wrong file.
      // 200 to a ranged request is a server that ignored the range: start over, never append.
      let append = false;
      let total: number | null = null;
      const encoded = (response.headers.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity';
      if (status === 206) {
        const range = parseContentRange(response.headers.get('content-range'));
        const start = range?.start ?? have;
        if (start !== have) throw new Restart(`the server resumed at byte ${start}, not ${have}`);
        append = have > 0;
        total = range?.total ?? null;
      } else {
        if (have > 0) note(`${label}: the server did not resume (HTTP ${status}); starting over`);
        const length = Number(response.headers.get('content-length') ?? Number.NaN);
        total = Number.isFinite(length) && !encoded ? length : null;
      }
      if (total !== null && pinned !== null && total !== pinned) {
        // The server's file is not the pinned file at all — no attempt can make it verify.
        await remove(partial);
        throw new DownloadError(
          'corrupt',
          t('dl.why.corrupt'),
          `${label}: the server's copy is ${total} bytes, the pin says ${pinned}`,
        );
      }
      if (pinned === null && total !== null) announced = total;
      if (!append) resetHash();
      else spliced = true;

      let handle: FileHandle;
      try {
        handle = await open(partial, append ? 'a' : 'w');
      } catch (error: unknown) {
        throw localFault(error, need);
      }
      try {
        iterator = (response.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
        for (;;) {
          const next = await guarded(iterator.next(), policy.stallMs, signal, label);
          if (next.done === true) break;
          const chunk = next.value;
          try {
            await writeAll(handle, chunk);
          } catch (error: unknown) {
            throw localFault(error, (pinned ?? announced ?? 0) - hashed);
          }
          hash.update(chunk);
          hashed += chunk.byteLength;
          attemptBytes += chunk.byteLength;
          const limit = pinned ?? announced;
          if (limit !== null && hashed > limit) {
            await handle.close().catch(() => undefined);
            await remove(partial);
            throw new DownloadError('corrupt', t('dl.why.corrupt'), `${label}: the body ran past ${limit} bytes`);
          }
          report(hashed, false);
        }
        finished = true;
        // Durable before it can be renamed: the rename can reach the disk before the data
        // behind it, leaving a full-length file whose tail is whatever was in those blocks.
        await handle.sync().catch(() => undefined);
      } finally {
        // The partial STAYS on any failure here: it is what the next attempt resumes from.
        await handle.close().catch(() => undefined);
      }
      const expected = pinned ?? announced;
      if (expected !== null && hashed < expected) {
        throw new Retryable('network', `the connection closed at byte ${hashed} of ${expected}`);
      }
    } finally {
      signal?.removeEventListener('abort', forward);
      if (!finished) {
        // A stall or an abort: let the socket go, or it holds the line until the OS notices.
        controller.abort();
        void iterator?.return?.()?.catch(() => undefined);
      }
    }
  }

  /** A disk-side failure, as a value: a full disk is final for now; a busy file is worth a retry. */
  function localFault(error: unknown, need: number): Error {
    const code = errorCode(error);
    if (code !== null && FS_FULL.has(code)) {
      return new DownloadError(
        'diskFull',
        t('dl.why.disk', { need: sizeText(Math.max(0, need)), free: sizeText(0) }),
        `${label}: ${code} while writing`,
      );
    }
    if (code !== null && FS_BUSY.has(code)) return new Retryable('locked', `${code} on ${partial}`);
    return error instanceof Error ? error : new Error(String(error));
  }

  /** A function, not `signal.aborted` inline: it changes across the awaits between checks. */
  const aborted = (): boolean => signal?.aborted === true;

  let failures = 0;
  for (;;) {
    if (aborted()) throw abortedError(label);
    attemptBytes = 0;
    try {
      if (!resumable) {
        // Nothing could verify a resumed body, so an unpinned file always starts at byte 0.
        await remove(partial);
      }
      let have = (await sizeOf(partial)) ?? 0;
      if (pinned !== null && have > pinned) {
        await remove(partial);
        have = 0;
      }
      if (have !== hashed) {
        // Inside the try: a partial antivirus will not let us read yet is a failed attempt.
        resetHash();
        if (have > 0) {
          for await (const chunk of createReadStream(partial, { highWaterMark: 1 << 20, end: have - 1 })) {
            hash.update(chunk as Buffer);
          }
          hashed = have;
          spliced = true;
          note(`${label}: resuming at byte ${have}`);
        }
      }
      if (!(pinned !== null && have === pinned)) {
        report(have, failures > 0);
        await transfer(have);
      }
    } catch (error: unknown) {
      if (error instanceof DownloadError) throw error;
      if (aborted()) throw abortedError(label);
      if (error instanceof Restart) {
        note(`${label}: ${error.message}; starting over`);
        await remove(partial);
        resetHash();
      }
      const fault =
        error instanceof Retryable
          ? error
          : error instanceof Restart
            ? new Retryable('network', error.message)
            : new Retryable('network', networkCause(error));
      const moved = attemptBytes >= policy.progressBytes;
      failures = moved ? 1 : failures + 1;
      if (failures >= policy.attempts) throw giveUp(fault);
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failures - 1)) * (0.75 + 0.5 * random());
      const wait = Math.round(
        fault.retryAfterMs === null ? backoff : Math.min(fault.retryAfterMs, policy.maxDelayMs * 5),
      );
      note(`${label}: ${fault.detail}; trying again in ${Math.round(wait / 1000)} s (${failures} of ${policy.attempts})`);
      report(hashed, true);
      try {
        await sleep(wait, signal);
      } catch {
        throw abortedError(label);
      }
      continue;
    }

    // Every byte is on disk. The pin decides.
    const actual = hash.digest('hex');
    const size = hashed;
    if ((pinned !== null && size !== pinned) || (resumable && actual !== request.sha256)) {
      await remove(partial);
      resetHash();
      if (spliced && !cleanRetryUsed) {
        // Assembled from more than one response: one of them may have been other bytes. Once more,
        // from byte 0, before calling it corrupt.
        cleanRetryUsed = true;
        spliced = false;
        note(`${label}: the resumed file did not verify (sha256 ${actual.slice(0, 12)}…); downloading it again from the start`);
        continue;
      }
      throw new DownloadError(
        'corrupt',
        t('dl.why.corrupt'),
        `${label}: arrived corrupt — expected ${pinned ?? '?'} bytes with sha256 ${request.sha256.slice(0, 12) || '?'}…, ` +
          `got ${size} bytes with ${actual.slice(0, 12)}…`,
      );
    }
    await renameIntoPlace(partial, request.destination);
    report(size, false);
    return { bytes: size, sha256: actual };
  }

  function giveUp(fault: Retryable): DownloadError {
    switch (fault.kind) {
      case 'server':
        return new DownloadError('server', t('dl.why.server', { status: String(fault.status ?? '?') }), `${label}: ${fault.detail}`);
      case 'locked':
        return new DownloadError('locked', t('dl.why.locked'), `${label}: ${fault.detail}`);
      case 'network':
        return new DownloadError('network', t('dl.why.network', { cause: fault.detail }), `${label}: ${fault.detail}`);
    }
  }

  /**
   * Antivirus scans a large file the moment it is closed, and a rename during the scan fails
   * EPERM / EBUSY / EACCES on Windows. A few tries with a growing delay; the partial is verified,
   * so even a final failure costs a rename at the next attempt, not a download.
   */
  async function renameIntoPlace(from: string, to: string): Promise<void> {
    const move = io.rename ?? rename;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await move(from, to);
        break;
      } catch (error: unknown) {
        const code = errorCode(error);
        if (code === null || !FS_BUSY.has(code) || attempt >= policy.renameAttempts) {
          throw new DownloadError('locked', t('dl.why.locked'), `${label}: could not rename into place (${code ?? String(error)})`);
        }
        note(`${label}: ${code} renaming into place (antivirus scanning it?); trying again`);
        try {
          await sleep(policy.renameDelayMs * attempt, signal);
        } catch {
          throw abortedError(label);
        }
      }
    }
    // And the directory entry the rename created, so the rename itself survives a crash. POSIX
    // needs it; Windows will not open a directory for reading, which is the expected failure.
    const directory = await open(dirname(to), 'r').catch(() => null);
    if (directory !== null) {
      await directory.sync().catch(() => undefined);
      await directory.close().catch(() => undefined);
    }
  }
}
