// First-use downloads for the on-device model bundles (Parakeet Ultra, Qwen3-1.7B), with
// the model store's discipline: idempotent BY CHECKSUM, a download that does not verify
// never lands, a half-written file can never pass an existence check.
//
// Ported from `ModelStore.ensure(bundle)` (Sources/KotibaModels/ModelStore.swift) — the
// Mac's first-use fetch for Parakeet — and written beside `model-store.ts` rather than
// inside it because that store's `ensure` is built for one ggml file and buffers the whole
// download in memory before hashing it. That is survivable at 574 MB once; for a 650 MB
// encoder plus a 1.28 GB GGUF on an 8 GB laptop it is not, so this one STREAMS: bytes go
// to a uniquely named temporary file and through the hash in the same pass, and the file is
// fsynced and renamed only after its size and sha256 both match the pin.
//
// A verification STAMP (`.kotiba-verified.json`) records what was checked, so a launch does
// not re-hash 1.9 GB to answer "is it installed". The stamp is written last, after every
// file is in place; a file whose size no longer matches the stamp is treated as absent.
//
// RESUMABLE. A download that stops — the network drops, the laptop sleeps, Kotiba is quit
// half-way through 1.28 GB on Uzbek mobile data — leaves `<file>.partial` behind ON PURPOSE,
// and the next attempt hashes what is there and asks the server only for the rest (`Range`).
// Safe because every URL is pinned to one upstream commit and the WHOLE file is hashed before
// it is renamed into place: a partial that belonged to different bytes fails that check, is
// deleted, and the attempt after starts clean. Only a verified file ever loses `.partial`.
//
// SHIPPED BUNDLES (Silero, `ModelBundleSpec.shipped`) sit in the installer's read-only
// `resources/models/<directory>/` with no stamp; a small one is hashed once per launch instead.

import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  BUNDLE_CATALOGUE,
  SHIPPED_HASH_LIMIT_BYTES,
  bundleBytes,
  type BundleFile,
  type BundleId,
  type ModelBundleSpec,
} from '../contracts/index.js';

const STAMP = '.kotiba-verified.json';
/** What an unfinished download is called while it waits to be resumed. */
export const PARTIAL_SUFFIX = '.partial';

export interface BundleProgress {
  readonly id: BundleId;
  readonly receivedBytes: number;
  readonly totalBytes: number;
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
  /** Injected by the tests. */
  readonly fetch?: typeof fetch;
  readonly catalogue?: Readonly<Record<BundleId, ModelBundleSpec>>;
}

async function sha256OfFile(path: string): Promise<string> {
  return (await hashInto(createHash('sha256'), path)).digest('hex');
}

/** Feed a file through `hash`; the caller decides whether to finish it or keep going. */
async function hashInto(hash: Hash, path: string): Promise<Hash> {
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
  return hash;
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
  const fetcher = options.fetch ?? fetch;
  const notes: string[] = [];
  const record = (note: string): void => {
    notes.push(note);
    if (notes.length > 500) notes.splice(0, notes.length - 500);
  };
  /** One download per bundle at a time: a second caller joins the first. */
  const inFlight = new Map<BundleId, Promise<string>>();

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

  /** Hash a file that is already the right size. `true` iff it is the pinned file. */
  async function alreadyGood(path: string, file: BundleFile): Promise<boolean> {
    if ((await sizeOf(path)) !== file.bytes) return false;
    return (await sha256OfFile(path)) === file.sha256;
  }

  /**
   * One file, resumed from `<destination>.partial` when a previous attempt left one. The hash
   * runs over the bytes already on disk first and then over the rest as it arrives, so the
   * whole file is verified exactly once whichever way it was assembled.
   */
  async function download(
    spec: ModelBundleSpec,
    file: BundleFile,
    destination: string,
    progress: (bytes: number) => void,
  ): Promise<void> {
    const url = spec.baseUrl + file.remotePath;
    const partial = `${destination}${PARTIAL_SUFFIX}`;
    let have = (await sizeOf(partial)) ?? 0;
    if (have > file.bytes) {
      await unlink(partial).catch(() => undefined);
      have = 0;
    }
    const hash = createHash('sha256');
    let received = 0;
    if (have > 0) {
      await hashInto(hash, partial);
      received = have;
    }

    if (received < file.bytes) {
      record(`${spec.name}: downloading ${file.remotePath}${have > 0 ? ` from byte ${have}` : ''}`);
      const response = await fetcher(url, have > 0 ? { headers: { Range: `bytes=${have}-` } } : undefined);
      // 206 continues the partial. 200 to a ranged request is a server that ignored the
      // range (or a stale partial): start over rather than append a second copy.
      const resumed = have > 0 && response.status === 206;
      if (!response.ok || response.body === null) {
        throw new Error(`${spec.name}: ${file.remotePath} failed to download: HTTP ${response.status}`);
      }
      let restart = false;
      if (have > 0 && !resumed) {
        record(`${spec.name}: ${file.remotePath}: the server did not resume (HTTP ${response.status}); starting over`);
        restart = true;
      }
      const handle = await open(partial, restart || have === 0 ? 'w' : 'a');
      const fresh = restart ? createHash('sha256') : hash;
      if (restart) received = 0;
      else if (have > 0) progress(have);
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          fresh.update(chunk);
          await handle.write(chunk);
          received += chunk.byteLength;
          progress(chunk.byteLength);
        }
        await handle.sync();
      } finally {
        // The partial STAYS on any failure here: it is what the next attempt resumes from.
        await handle.close();
      }
      await finishFile(spec, file, destination, partial, fresh, received);
      return;
    }
    progress(have);
    await finishFile(spec, file, destination, partial, hash, received);
  }

  /** Size and sha256 against the pin; rename into place, or delete the partial and say why. */
  async function finishFile(
    spec: ModelBundleSpec,
    file: BundleFile,
    destination: string,
    partial: string,
    hash: Hash,
    received: number,
  ): Promise<void> {
    const actual = hash.digest('hex');
    if (received !== file.bytes || actual !== file.sha256) {
      // Corrupt is not resumable: these bytes can never become the pinned file.
      await unlink(partial).catch(() => undefined);
      record(`${spec.name}: ${file.remotePath} arrived corrupt (${received} bytes, sha256 ${actual.slice(0, 12)}…), discarded`);
      throw new Error(
        `${spec.name}: ${file.remotePath} arrived corrupt — expected ${file.bytes} bytes with sha256 ` +
          `${file.sha256.slice(0, 12)}…, got ${received} bytes with ${actual.slice(0, 12)}…`,
      );
    }
    await rename(partial, destination);
  }

  async function fetchBundle(id: BundleId, onProgress?: (progress: BundleProgress) => void): Promise<string> {
    const spec = catalogue[id];
    const existing = await installedDirectory(id);
    if (existing !== null) return existing;

    const directory = writableDirectory(id);
    await mkdir(directory, { recursive: true });
    const totalBytes = bundleBytes(spec);
    let receivedBytes = 0;
    const tick = (bytes: number): void => {
      receivedBytes += bytes;
      onProgress?.({ id, receivedBytes, totalBytes });
    };

    for (const file of spec.files) {
      const destination = join(directory, file.localName);
      await mkdir(dirname(destination), { recursive: true });
      if (await alreadyGood(destination, file)) {
        record(`${spec.name}: ${file.localName} present and verified`);
        tick(file.bytes);
        continue;
      }
      await unlink(destination).catch(() => undefined);
      await download(spec, file, destination, tick);
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
      const task = fetchBundle(id, onProgress).finally(() => inFlight.delete(id));
      inFlight.set(id, task);
      return task;
    },
    get notes() {
      return notes;
    },
  };
}
