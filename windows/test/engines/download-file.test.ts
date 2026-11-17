// The one downloader both model stores use, against the networks it meets: a connection that
// drops mid-body, one that stalls without erroring, Hugging Face's 429 and 5xx, a server that
// ignores `Range` or resumes at the wrong byte, a full disk, antivirus holding the finished file,
// and a quit. Every fault is injected — no network, no real clock, no real disk-full.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DownloadError,
  downloadFile,
  parseContentRange,
  retryAfterMs,
  retryLater,
  type DownloadIo,
  type DownloadRequest,
  type FileProgress,
} from '../../src/engines/download-file.js';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kotiba-download-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const DATA = Buffer.from(Array.from({ length: 10_000 }, (_, i) => (i * 7) % 251));
const SHA = createHash('sha256').update(DATA).digest('hex');
const URL_ = 'https://huggingface.co/x/resolve/abc/model.bin';

/** What the fake server does with the n-th request. */
interface Turn {
  readonly status?: number;
  /** Send this many bytes of the body, then reset the connection. */
  readonly cutAfter?: number;
  /** Send this many bytes, then go silent forever (a dead TCP connection). */
  readonly stallAfter?: number;
  /** Never answer at all — no headers. */
  readonly noAnswer?: boolean;
  /** Answer a ranged request with 200 and the whole body. */
  readonly ignoreRange?: boolean;
  /** Claim this first byte in `Content-Range` (a CDN that resumed elsewhere). */
  readonly claimStart?: number;
  /** Claim this whole length in `Content-Range` / `Content-Length`. */
  readonly claimTotal?: number;
  readonly headers?: Record<string, string>;
  /** Reject before any response, as undici does: `TypeError('fetch failed', { cause })`. */
  readonly refuse?: string;
}

interface Server {
  readonly fetch: typeof fetch;
  readonly ranges: (string | null)[];
}

function server(data: Buffer, turns: readonly Turn[]): Server {
  const ranges: (string | null)[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    const turn = turns[ranges.length] ?? {};
    ranges.push(range);
    if (turn.refuse !== undefined) {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: turn.refuse }) });
    }
    if (turn.noAnswer === true) return new Promise<Response>(() => undefined);
    if (turn.status !== undefined && turn.status !== 200 && turn.status !== 206) {
      return new Response('nope', { status: turn.status, headers: turn.headers ?? {} });
    }
    const asked = range === null ? 0 : Number(/bytes=(\d+)-/u.exec(range)?.[1] ?? 0);
    const from = turn.ignoreRange === true ? 0 : asked;
    const slice = data.subarray(from);
    const limit = turn.cutAfter ?? turn.stallAfter;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(limit === undefined ? slice : slice.subarray(0, limit)));
          return undefined;
        }
        if (turn.stallAfter !== undefined) return new Promise<void>(() => undefined);
        if (turn.cutAfter !== undefined) controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }));
        else controller.close();
        return undefined;
      },
    });
    const total = turn.claimTotal ?? data.length;
    const partial = from > 0;
    const headers: Record<string, string> = partial
      ? { 'content-range': `bytes ${turn.claimStart ?? from}-${total - 1}/${total}`, 'content-length': String(slice.length) }
      : { 'content-length': String(turn.claimTotal ?? data.length) };
    return new Response(body, { status: partial ? 206 : 200, headers: { ...headers, ...turn.headers } });
  }) as typeof fetch;
  return { fetch: fetchImpl, ranges };
}

interface Rig {
  readonly io: DownloadIo;
  readonly sleeps: number[];
  readonly progress: FileProgress[];
  readonly notes: string[];
  readonly request: (patch?: Partial<DownloadRequest>) => DownloadRequest;
  readonly destination: string;
}

function rig(net: Server, io: Partial<DownloadIo> = {}): Rig {
  const sleeps: number[] = [];
  const progress: FileProgress[] = [];
  const notes: string[] = [];
  const destination = join(root, 'model.bin');
  return {
    io: {
      fetch: net.fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      freeBytes: async () => 10 * 1024 * 1024 * 1024,
      ...io,
    },
    sleeps,
    progress,
    notes,
    destination,
    request: (patch = {}) => ({
      url: URL_,
      destination,
      label: 'Test model',
      bytes: DATA.length,
      sha256: SHA,
      onProgress: (p) => progress.push(p),
      note: (text) => notes.push(text),
      policy: { stallMs: 40, progressBytes: 1 },
      ...patch,
    }),
  };
}

/** Progress never went backwards, never past the total, and ended at the total. */
function expectHonestProgress(progress: readonly FileProgress[], total: number): void {
  for (let i = 1; i < progress.length; i += 1) expect(progress[i]!.bytes).toBeGreaterThanOrEqual(progress[i - 1]!.bytes);
  for (const each of progress) expect(each.bytes).toBeLessThanOrEqual(total);
  expect(progress.at(-1)?.bytes).toBe(total);
}

describe('a connection that drops mid-body', () => {
  it('is retried after a backoff, resumed with Range, and lands verified in the same call', async () => {
    const net = server(DATA, [{ cutAfter: 3000 }, {}]);
    const r = rig(net);
    const landed = await downloadFile(r.request(), r.io);
    expect(landed).toEqual({ bytes: DATA.length, sha256: SHA });
    expect(net.ranges).toEqual([null, 'bytes=3000-']);
    expect(r.sleeps).toEqual([2000]);
    expect((await readFile(r.destination)).equals(DATA)).toBe(true);
    expect(await readdir(root)).toEqual(['model.bin']);
    expectHonestProgress(r.progress, DATA.length);
    // While it waited to reconnect, the bar said so.
    expect(r.progress.some((each) => each.retrying && each.bytes === 3000)).toBe(true);
  });

  it('keeps going for as long as each attempt MOVES — a line that drops every 1 000 bytes still finishes', async () => {
    const net = server(DATA, Array.from({ length: 9 }, () => ({ cutAfter: 1000 })));
    const r = rig(net);
    await downloadFile(r.request({ policy: { stallMs: 40, progressBytes: 1, attempts: 2 } }), r.io);
    expect(net.ranges).toHaveLength(10);
    expect((await readFile(r.destination)).equals(DATA)).toBe(true);
  });

  it('gives up after `attempts` dead attempts in a row, keeps the partial, and names the cause', async () => {
    const net = server(DATA, [{ cutAfter: 2000 }, { refuse: 'ECONNRESET' }, { refuse: 'ECONNRESET' }, { refuse: 'ECONNRESET' }]);
    const r = rig(net);
    const failure = await downloadFile(r.request({ policy: { stallMs: 40, progressBytes: 1, attempts: 3 } }), r.io).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DownloadError);
    expect((failure as DownloadError).kind).toBe('network');
    expect(retryLater(failure)).toBe(true);
    expect((failure as DownloadError).message).toMatch(/ECONNRESET/u);
    expect((failure as DownloadError).message).toMatch(/tries again by itself/u);
    expect((await readFile(`${r.destination}.partial`)).length).toBe(2000);
    // Capped exponential backoff, with the jitter at its midpoint.
    expect(r.sleeps).toEqual([2000, 4000]);
  });
});

describe('a connection that stalls without erroring', () => {
  it('is abandoned after `stallMs` of silence mid-body and resumed', async () => {
    const net = server(DATA, [{ stallAfter: 4000 }, {}]);
    const r = rig(net);
    await downloadFile(r.request(), r.io);
    expect(net.ranges).toEqual([null, 'bytes=4000-']);
    expect(r.notes.join('\n')).toMatch(/stalled/u);
    expect((await readFile(r.destination)).equals(DATA)).toBe(true);
  });

  it('is abandoned when the headers never come', async () => {
    const net = server(DATA, [{ noAnswer: true }, {}]);
    const r = rig(net);
    await downloadFile(r.request(), r.io);
    expect(net.ranges).toEqual([null, null]);
  });
});

describe('Hugging Face says 429 or 5xx', () => {
  it('429 waits as long as Retry-After asks, then succeeds', async () => {
    const net = server(DATA, [{ status: 429, headers: { 'retry-after': '7' } }, {}]);
    const r = rig(net);
    await downloadFile(r.request(), r.io);
    expect(r.sleeps).toEqual([7000]);
    expect((await readFile(r.destination)).equals(DATA)).toBe(true);
  });

  it('a server that stays at 503 ends as `server`, worth retrying later', async () => {
    const net = server(DATA, [{ status: 503 }, { status: 503 }]);
    const r = rig(net);
    const failure = await downloadFile(r.request({ policy: { stallMs: 40, attempts: 2 } }), r.io).catch((error: unknown) => error);
    expect((failure as DownloadError).kind).toBe('server');
    expect((failure as DownloadError).message).toMatch(/HTTP 503/u);
    expect(retryLater(failure)).toBe(true);
  });

  it('404 is final at once — no waiting, no retry, and not worth retrying later', async () => {
    const net = server(DATA, [{ status: 404 }]);
    const r = rig(net);
    const failure = await downloadFile(r.request(), r.io).catch((error: unknown) => error);
    expect((failure as DownloadError).kind).toBe('refused');
    expect((failure as DownloadError).message).toMatch(/HTTP 404/u);
    expect(retryLater(failure)).toBe(false);
    expect(r.sleeps).toEqual([]);
    expect(net.ranges).toHaveLength(1);
  });
});

describe('what a ranged request is answered with', () => {
  it('200 to a Range restarts the file cleanly instead of appending a second copy', async () => {
    await writeFile(join(root, 'model.bin.partial'), DATA.subarray(0, 5000));
    const net = server(DATA, [{ ignoreRange: true }]);
    const r = rig(net);
    await downloadFile(r.request(), r.io);
    expect(net.ranges).toEqual(['bytes=5000-']);
    expect((await readFile(r.destination)).equals(DATA)).toBe(true);
    // The bar held at 5 000 while the restart caught up — it never went back to 0.
    expectHonestProgress(r.progress, DATA.length);
  });

  it('206 starting at the wrong byte is not spliced: the partial is dropped and fetched from 0', async () => {
    await writeFile(join(root, 'model.bin.partial'), DATA.subarray(0, 5000));
    const net = server(DATA, [{ claimStart: 4096 }, {}]);
    const r = rig(net);
    await downloadFile(r.request(), r.io);
    expect(net.ranges).toEqual(['bytes=5000-', null]);
    expect((await readFile(r.destination)).equals(DATA)).toBe(true);
  });

  it('a server whose file is not the pinned size is final: corrupt, partial removed', async () => {
    const net = server(DATA, [{ claimTotal: DATA.length + 1 }]);
    const r = rig(net);
    const failure = await downloadFile(r.request(), r.io).catch((error: unknown) => error);
    expect((failure as DownloadError).kind).toBe('corrupt');
    expect(retryLater(failure)).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it('a partial from other bytes fails the hash and is fetched once more from byte 0, in the same call', async () => {
    await writeFile(join(root, 'model.bin.partial'), Buffer.alloc(5000, 9));
    const net = server(DATA, [{}, {}]);
    const r = rig(net);
    await downloadFile(r.request(), r.io);
    expect(net.ranges).toEqual(['bytes=5000-', null]);
    expect((await readFile(r.destination)).equals(DATA)).toBe(true);
  });

  it('a clean download that fails the hash is final', async () => {
    const net = server(Buffer.alloc(DATA.length, 1), [{}]);
    const r = rig(net);
    const failure = await downloadFile(r.request(), r.io).catch((error: unknown) => error);
    expect((failure as DownloadError).kind).toBe('corrupt');
    expect(net.ranges).toEqual([null]);
    expect(await readdir(root)).toEqual([]);
  });

  it('an unpinned file (no sha256) never resumes: a stale partial is discarded', async () => {
    await writeFile(join(root, 'model.bin.partial'), DATA.subarray(0, 5000));
    const net = server(DATA, [{}]);
    const r = rig(net);
    const landed = await downloadFile(r.request({ sha256: '', bytes: null }), r.io);
    expect(net.ranges).toEqual([null]);
    expect(landed.sha256).toBe(SHA);
  });
});

describe('the disk', () => {
  it('too little free space says how much is needed and how much there is, and fetches nothing', async () => {
    await writeFile(join(root, 'model.bin.partial'), DATA.subarray(0, 4000));
    const net = server(DATA, [{}]);
    const r = rig(net, { freeBytes: async () => 1000 });
    const failure = await downloadFile(r.request({ bytes: DATA.length }), r.io).catch((error: unknown) => error);
    expect((failure as DownloadError).kind).toBe('diskFull');
    expect(retryLater(failure)).toBe(true);
    expect((failure as DownloadError).message).toMatch(/needs 0 MB, and 0 MB is free/u);
    expect(net.ranges).toEqual([]);
    // What arrived stays, for when the space is back.
    expect((await readFile(`${r.destination}.partial`)).length).toBe(4000);
  });

  it('prints real sizes', async () => {
    const big = 1_282_439_264;
    const r = rig(server(DATA, []), { freeBytes: async () => 412_000_000 });
    const failure = await downloadFile(r.request({ bytes: big, sha256: 'ab' }), r.io).catch((error: unknown) => error);
    expect((failure as DownloadError).message).toMatch(/needs 1\.28 GB, and 412 MB is free/u);
  });
});

describe('antivirus holding the finished file', () => {
  it('a rename refused with EPERM is tried again, and the file lands', async () => {
    let tries = 0;
    const r = rig(server(DATA, [{}]), {
      rename: async (from, to) => {
        tries += 1;
        if (tries <= 2) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        const { rename } = await import('node:fs/promises');
        await rename(from, to);
      },
    });
    await downloadFile(r.request(), r.io);
    expect(tries).toBe(3);
    expect(r.sleeps).toEqual([250, 500]);
    expect((await readFile(r.destination)).equals(DATA)).toBe(true);
  });

  it('a rename that never succeeds keeps the verified partial, so the next call only renames', async () => {
    const net = server(DATA, [{}]);
    const blocked = rig(net, { rename: async () => Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) });
    const failure = await downloadFile(blocked.request({ policy: { stallMs: 40, renameAttempts: 3 } }), blocked.io).catch(
      (error: unknown) => error,
    );
    expect((failure as DownloadError).kind).toBe('locked');
    expect(retryLater(failure)).toBe(true);
    expect((await readFile(`${blocked.destination}.partial`)).equals(DATA)).toBe(true);

    const again = rig(net);
    await downloadFile(again.request(), again.io);
    expect(net.ranges).toHaveLength(1);
    expect((await readFile(again.destination)).equals(DATA)).toBe(true);
  });
});

describe('a quit', () => {
  it('aborting mid-body stops at once, as `aborted`, and the partial is what the next launch resumes', async () => {
    const net = server(DATA, [{ stallAfter: 6000 }, {}]);
    const controller = new AbortController();
    const r = rig(net);
    const request = r.request({
      signal: controller.signal,
      policy: { stallMs: 60_000 },
      onProgress: (p) => {
        if (p.bytes === 6000) controller.abort();
      },
    });
    const failure = await downloadFile(request, r.io).catch((error: unknown) => error);
    expect((failure as DownloadError).kind).toBe('aborted');
    expect(retryLater(failure)).toBe(false);
    expect((await readFile(`${r.destination}.partial`)).length).toBe(6000);

    const next = rig(net);
    await downloadFile(next.request(), next.io);
    expect(net.ranges).toEqual([null, 'bytes=6000-']);
    expect((await readFile(next.destination)).equals(DATA)).toBe(true);
  });
});

describe('the header parsers', () => {
  it('Content-Range', () => {
    expect(parseContentRange('bytes 100-999/1000')).toEqual({ start: 100, total: 1000 });
    expect(parseContentRange('bytes 0-9/*')).toEqual({ start: 0, total: null });
    expect(parseContentRange(null)).toBeNull();
    expect(parseContentRange('nonsense')).toBeNull();
  });

  it('Retry-After, in seconds or as a date', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});
