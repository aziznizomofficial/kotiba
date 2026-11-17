// First-use downloads for the on-device model bundles (Parakeet Ultra, Qwen3-1.7B), with
// the model store's discipline: idempotent BY CHECKSUM, a download that does not verify
// never lands, a half-written file can never pass an existence check.
//
// Ported from `ModelStore.ensure(bundle)` (Sources/KotibaModels/ModelStore.swift) — the
// Mac's first-use fetch for Parakeet — and written beside `model-store.ts` rather than
// inside it because that store's `ensure` is built for one ggml file with its own three-step
// resolution. Both stream through the same downloader: bytes go to `<file>.partial` and through
// the hash in the same pass, and the file is fsynced and renamed only after its size and sha256
// both match the pin.
//
// A verification STAMP (`.kotiba-verified.json`) records what was checked, so a launch does
// not re-hash 1.9 GB to answer "is it installed". The stamp is written last, after every
// file is in place; a file whose size no longer matches the stamp is treated as absent.
//
// RESUMABLE AND RETRIED (`./download-file.ts`, shared with the model store). A download that
// stops — the network drops or stalls, the laptop sleeps, Kotiba is quit half-way through
// 1.28 GB on Uzbek mobile data — leaves `<file>.partial` behind ON PURPOSE; the downloader
// retries with backoff, each time asking the server only for the rest (`Range`), and a later
// `ensure` (the next launch, the app's own retry) continues from it too. Safe because every URL
// is pinned to one upstream commit and the WHOLE file is hashed before it is renamed into place:
// a partial that belonged to different bytes fails that check and is fetched again from byte 0.
// Only a verified file ever loses `.partial`.
//
// SHIPPED BUNDLES (Silero, `ModelBundleSpec.shipped`) sit in the installer's read-only
// `resources/models/<directory>/` with no stamp; a small one is hashed once per launch instead.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  BUNDLE_CATALOGUE,
  SHIPPED_HASH_LIMIT_BYTES,
  bundleBytes,
  type BundleFile,
  type BundleId,
  type ModelBundleSpec,
} from '../contracts/index.js';

import { DownloadError, downloadFile, type DownloadIo, type DownloadPolicy } from './download-file.js';

const STAMP = '.kotiba-verified.json';

export interface BundleProgress {
  readonly id: BundleId;
  /** Never goes backwards and never exceeds `totalBytes`. */
  readonly receivedBytes: number;
  readonly totalBytes: number;
  /** The connection was lost; the download waits to try again and continues where it stopped. */
  readonly retrying?: boolean;
}

export interface BundleStore {
  /** Where the bundle's files are, whether or not they are there yet. */
  directoryFor(id: BundleId): string;
  /** The path of one of its files. */
  pathOf(id: BundleId, localName: string): string;
  /** Stamp present and every file the pinned size. Cheap: a read and five stats. */
  isInstalled(id: BundleId): Promise<boolean>;
  /** The directory holding a verified copy, or `null`. Never downloads. */
  locate(id: BundleId): Promise<string | null>;
  /** Fetch whatever is missing, verify everything, stamp. Resolves to the directory. */
  ensure(id: BundleId, onProgress?: (progress: BundleProgress) => void): Promise<string>;
  /** Why the last fetch of `id` failed (a `DownloadError` when it was the network or the disk), or `null`. */
  lastFailure?(id: BundleId): unknown;
  /** Stop every download now and refuse new ones (quit). Each partial stays and is resumed next launch. */
  cancelAll?(): void;
  /** Every decision and refusal, in order, for the diagnostics pane. */
  readonly notes: readonly string[];
}

export interface BundleStoreOptions {
  readonly modelsDirectory: string;
  /**
   * An extra directory searched first for an already-verified copy — `bundledDirectory`,
   * so a build that ships a bundle beside the executable (or a developer's symlink) is
   * used as-is. Never written to.
   */
  readonly readOnlyDirectory?: string;
  /**
   * The transport. The app passes Electron's `net.fetch` (Chromium's stack: the system proxy and
   * the Windows certificate store, which antivirus HTTPS scanning installs its root into); tests
   * pass a double. Absent: Node's own `fetch`, looked up at call time.
   */
  readonly fetch?: typeof fetch;
  /** Injected by the tests: the clock, the free-space probe, the rename. */
  readonly io?: Partial<Omit<DownloadIo, 'fetch'>>;
  readonly policy?: Partial<DownloadPolicy>;
  readonly catalogue?: Readonly<Record<BundleId, ModelBundleSpec>>;
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

interface StampFile {
  readonly localName: string;
  readonly bytes: number;
  readonly sha256: string;
}

export function createBundleStore(options: BundleStoreOptions): BundleStore {
  const catalogue = options.catalogue ?? BUNDLE_CATALOGUE;
  const notes: string[] = [];
  const record = (note: string): void => {
    notes.push(note);
    if (notes.length > 500) notes.splice(0, notes.length - 500);
  };
  /** One download per bundle at a time: a second caller joins the first. */
  const inFlight = new Map<BundleId, Promise<string>>();
  /** Why the last `ensure` of each bundle failed — the app's queue asks whether to try again later. */
  const failures = new Map<BundleId, unknown>();
  /** Aborted by `cancelAll` (quit). Never replaced: after a quit nothing new may start. */
  const stopping = new AbortController();
  const io: DownloadIo = { ...options.io, fetch: options.fetch ?? ((input, init) => fetch(input, init)) };

  const writableDirectory = (id: BundleId): string => join(options.modelsDirectory, catalogue[id].directory);

  async function verifiedIn(directory: string, spec: ModelBundleSpec): Promise<boolean> {
    let stamp: { files?: StampFile[] };
    try {
      stamp = JSON.parse(await readFile(join(directory, STAMP), 'utf8')) as { files?: StampFile[] };
    } catch {
      return false;
    }
    for (const file of spec.files) {
      const stamped = stamp.files?.find((entry) => entry.localName === file.localName);
      if (stamped === undefined || stamped.sha256 !== file.sha256 || stamped.bytes !== file.bytes) return false;
      if ((await sizeOf(join(directory, file.localName))) !== file.bytes) return false;
    }
    return true;
  }

  /** Shipped directories already hashed this launch, and the verdict. Files there never change. */
  const shippedVerdicts = new Map<string, Promise<boolean>>();

  /**
   * A shipped copy with no stamp: every file the pinned size AND the pinned sha256. Only for
   * a bundle small enough to hash at launch (`SHIPPED_HASH_LIMIT_BYTES`); remembered, so the
   * streaming session asking at every Uzbek press costs one hash per launch, not per press.
   */
  function hashedInPlace(directory: string, spec: ModelBundleSpec): Promise<boolean> {
    if (bundleBytes(spec) > SHIPPED_HASH_LIMIT_BYTES) return Promise.resolve(false);
    const known = shippedVerdicts.get(directory);
    if (known !== undefined) return known;
    const verdict = (async () => {
      for (const file of spec.files) {
        const path = join(directory, file.localName);
        if ((await sizeOf(path)) !== file.bytes) return false;
        if ((await sha256OfFile(path)) !== file.sha256) {
          record(`${spec.name}: the copy in ${directory} does not match its pinned sha256 — ignored`);
          return false;
        }
      }
      return true;
    })();
    shippedVerdicts.set(directory, verdict);
    return verdict;
  }

  /** The directory holding a verified copy: the read-only one first, then ours. */
  async function installedDirectory(id: BundleId): Promise<string | null> {
    const spec = catalogue[id];
    if (options.readOnlyDirectory !== undefined && options.readOnlyDirectory !== '') {
      const shipped = join(options.readOnlyDirectory, spec.directory);
      if ((await verifiedIn(shipped, spec)) || (await hashedInPlace(shipped, spec))) return shipped;
    }
    const ours = writableDirectory(id);
    return (await verifiedIn(ours, spec)) ? ours : null;
  }

  /**
   * Files this process already hashed and found pinned, by path → modification time. A bundle
   * whose LAST file keeps failing on a bad line is retried by the app every few minutes; without
   * this, every retry re-read Parakeet's 650 MB encoder to re-prove what it proved last time.
   */
  const verifiedFiles = new Map<string, number>();

  /** Hash a file that is already the right size. `true` iff it is the pinned file. */
  async function alreadyGood(path: string, file: BundleFile): Promise<boolean> {
    let info;
    try {
      info = await stat(path);
    } catch {
      return false;
    }
    if (!info.isFile() || info.size !== file.bytes) return false;
    if (verifiedFiles.get(path) === info.mtimeMs) return true;
    const good = (await sha256OfFile(path)) === file.sha256;
    if (good) verifiedFiles.set(path, info.mtimeMs);
    return good;
  }

  async function fetchBundle(
    id: BundleId,
    onProgress: ((progress: BundleProgress) => void) | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const spec = catalogue[id];
    const existing = await installedDirectory(id);
    if (existing !== null) return existing;

    const directory = writableDirectory(id);
    await mkdir(directory, { recursive: true });
    const totalBytes = bundleBytes(spec);
    /** Bytes of the files already in place; the current file's own count is added to it. */
    let doneBytes = 0;
    let reported = 0;
    const tell = (fileBytes: number, retrying: boolean): void => {
      // Never backwards: a file that restarts from byte 0 holds the bar, it does not empty it.
      reported = Math.min(totalBytes, Math.max(reported, doneBytes + fileBytes));
      onProgress?.({ id, receivedBytes: reported, totalBytes, retrying });
    };

    for (const file of spec.files) {
      const destination = join(directory, file.localName);
      await mkdir(dirname(destination), { recursive: true });
      if (await alreadyGood(destination, file)) {
        record(`${spec.name}: ${file.localName} present and verified`);
      } else {
        await unlink(destination).catch(() => undefined);
        record(`${spec.name}: downloading ${file.remotePath}`);
        await downloadFile(
          {
            url: spec.baseUrl + file.remotePath,
            destination,
            label: `${spec.name}: ${file.remotePath}`,
            bytes: file.bytes,
            sha256: file.sha256,
            signal,
            note: record,
            onProgress: (progress) => tell(progress.bytes, progress.retrying),
            ...(options.policy === undefined ? {} : { policy: options.policy }),
          },
          io,
        );
        // Verified on the way in: the next `ensure` need not read it again.
        const landed = await stat(destination).catch(() => null);
        if (landed !== null) verifiedFiles.set(destination, landed.mtimeMs);
      }
      doneBytes += file.bytes;
      tell(0, false);
    }

    const stamp = { verified: new Date().toISOString(), files: spec.files.map(({ localName, bytes, sha256 }) => ({ localName, bytes, sha256 })) };
    await writeFile(join(directory, STAMP), JSON.stringify(stamp, null, 2));
    record(`${spec.name}: installed and verified (${totalBytes} bytes)`);
    return directory;
  }

  return {
    directoryFor(id) {
      return writableDirectory(id);
    },
    pathOf(id, localName) {
      return join(writableDirectory(id), localName);
    },
    async isInstalled(id) {
      return (await installedDirectory(id)) !== null;
    },
    locate(id) {
      return installedDirectory(id);
    },
    ensure(id, onProgress) {
      const running = inFlight.get(id);
      if (running !== undefined) return running;
      failures.delete(id);
      const task = fetchBundle(id, onProgress, stopping.signal)
        .catch((error: unknown) => {
          failures.set(id, error);
          if (error instanceof DownloadError) record(error.detail);
          throw error;
        })
        .finally(() => inFlight.delete(id));
      inFlight.set(id, task);
      return task;
    },
    lastFailure(id) {
      return failures.get(id) ?? null;
    },
    cancelAll() {
      // Every transfer stops where it is; its partial stays, and the next launch resumes it.
      // For good: the app's queue may start its next link while the quit is still running.
      stopping.abort();
    },
    get notes() {
      return notes;
    },
  };
}
