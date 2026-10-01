// Where model weights live, how the app knows they arrived intact, and the one question
// that must never be answered by reading prose.
//
// Ported from `ModelFile` / `ModelStore` (Sources/KotibaModels/ModelStore.swift).
//
// `notInstalled` and `corrupt` are DIFFERENT MACHINE STATES, set by the component that
// looked at the file, and `--check` branches on the enum and on nothing else (D-W10).
// The precedent is `ai-balance/windows`: state was recovered with the regex
// `no [A-Z_]+ stored`, the real message read `no GONKA_API_KEY / GONKA_BASE_URL stored`,
// the regex missed, and a healthy app exited non-zero.
//
// Not ported, because the wiring audit found them dead in the macOS app:
// `ModelStore.isInstalled`, `.remove` and `.installedBytes`.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GGML_MAGIC,
  MODEL_CATALOGUE,
  MODEL_MINIMUM_BYTES,
  MODEL_PROBLEM_REASONS,
  KNOWN_MODEL_FILES,
  PUBLIC_MODELS_BASE,
  PUBLIC_MODELS_LIVE,
  type CreateModelStore,
  type ModelDownloadProgress,
  type ModelId,
  type ModelInspection,
  type ModelRole,
  type ModelStatus,
  type ModelStore,
  type Settings,
} from '../contracts/index.js';

/**
 * Four magic bytes and a stat, deliberately — this sits in front of every readiness
 * question in the app, so it must never read the whole file.
 *
 * It is a PLAUSIBILITY check, not a verification. sha256 is the verification, and it
 * only applies to models the app fetched itself. The app's only check used to be
 * "does the path exist": a half-finished 200 MB download of a 539 MB model passed it,
 * Uzbek went ready, the blocker disappeared, the settings row showed a tick, and the
 * only feedback was whisper's own guess arriving 7.8 s into a load, once per launch,
 * forever.
 */
export async function inspectModelFile(path: string): Promise<ModelInspection> {
  if (path.length === 0) {
    return { status: 'notInstalled', path, bytes: 0, reason: MODEL_PROBLEM_REASONS.missing };
  }

  let bytes = 0;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return { status: 'notInstalled', path, bytes: 0, reason: MODEL_PROBLEM_REASONS.missing };
    }
    bytes = info.size;
  } catch {
    // Absent, or unreadable. Either way there is nothing here to be corrupt — the file
    // is not installed, and that is the state the caller needs, not an errno.
    return { status: 'notInstalled', path, bytes: 0, reason: MODEL_PROBLEM_REASONS.missing };
  }

  if (bytes < MODEL_MINIMUM_BYTES) {
    // A file that IS there and is too small is CORRUPT, not missing. This is the
    // half-finished-download case and it is exactly the distinction D-W10 is about.
    return {
      status: 'corrupt',
      path,
      bytes,
      reason:
        MODEL_PROBLEM_REASONS.tooSmallPrefix +
        String(Math.floor(bytes / 1_048_576)) +
        MODEL_PROBLEM_REASONS.tooSmallSuffix,
    };
  }

  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { status: 'notInstalled', path, bytes, reason: MODEL_PROBLEM_REASONS.missing };
  }
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    if (bytesRead < 4) {
      return { status: 'corrupt', path, bytes, reason: MODEL_PROBLEM_REASONS.notGgml };
    }
    // Little-endian: on disk the four bytes are literally `6c 6d 67 67`.
    if (head.readUInt32LE(0) !== GGML_MAGIC) {
      return { status: 'corrupt', path, bytes, reason: MODEL_PROBLEM_REASONS.notGgml };
    }
  } finally {
    await handle.close();
  }

  return { status: 'ready', path, bytes, reason: null };
}

/** Streams the file, so a 1.1 GB model is not read into memory to be hashed. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The filenames auto-discovery will accept for a role, best first. */
function candidatesFor(role: ModelRole): readonly string[] {
  return KNOWN_MODEL_FILES[role];
}

/**
 * The explicit setting for a role, or `''` when the role has none.
 *
 * Exported because the engine manager's readiness needs the same answer, and a second
 * copy of this switch is exactly how `ClusterMass.defaultThreshold` came to say 0.5
 * while the app said 0.05.
 */
export function settingPathFor(role: ModelRole, settings: Settings): string {
  switch (role) {
    case 'uzbek':
      return settings.uzbekModelPath;
    case 'russian':
      return settings.russianModelPath;
    case 'detector':
      return settings.detectorModelPath;
    case 'fastEnglish':
      // D-W2's Fast English model has no path setting: it is fetched on demand into the
      // models directory, so discovery is the only way it is ever found.
      return '';
  }
}

export const createModelStore: CreateModelStore = (options): ModelStore => {
  const notes: string[] = [];
  const record = (note: string): void => {
    notes.push(note);
    // Bounded. This process runs for days and the diagnostics pane shows the tail.
    if (notes.length > 500) notes.splice(0, notes.length - 500);
  };

  async function ensureModelsDirectory(): Promise<void> {
    // `recursive: true` is load-bearing for the same reason it is on iOS: creating a
    // child of a directory that does not exist fails with a permission error, which
    // reads like a permissions problem and is not one.
    await mkdir(options.modelsDirectory, { recursive: true });
  }

  /**
   * THREE STEPS, IN ORDER, and the order is load-bearing:
   *
   *   1. the explicit setting, if usable;
   *   2. a known filename in the models directory;
   *   3. the same filename beside the executable (what the installer shipped).
   *
   * Step 2 beats step 3 so a newer model dropped in by hand wins over the bundled one.
   * And discovery NEVER writes the setting back: readiness and the raw setting are
   * different questions, and conflating them is what makes a cleared path resurrect.
   */
  async function resolve(role: ModelRole, settings: Settings): Promise<string | null> {
    // EVERY path probed, in order, kept whether it hits or misses. A resolver that
    // reports "nothing usable found" without naming where it looked is the message that
    // made the macOS "no engine is configured" bug expensive: it stated a conclusion and
    // withheld the only evidence anyone could act on.
    const tried: string[] = [];

    const configured = settingPathFor(role, settings);
    if (configured.length > 0) {
      tried.push(`${configured} (configured)`);
      const inspection = await inspectModelFile(configured);
      if (inspection.status === 'ready') return configured;
      record(`${role}: the configured path is unusable (${inspection.reason ?? 'unknown'})`);
      // Deliberately falls through rather than refusing. A user whose external drive is
      // unplugged still has the bundled model, and refusing here would report a broken
      // install for a path they can no longer even see to clear.
    }

    for (const directory of [options.modelsDirectory, options.bundledDirectory]) {
      if (directory.length === 0) continue;
      for (const fileName of candidatesFor(role)) {
        const path = join(directory, fileName);
        const inspection = await inspectModelFile(path);
        if (inspection.status === 'ready') {
          record(`${role}: found ${fileName} in ${directory}`);
          return path;
        }
        tried.push(`${path} (${inspection.status})`);
        if (inspection.status === 'corrupt') {
          record(`${role}: ${path} is unusable — ${inspection.reason ?? 'unknown'}`);
        }
      }
    }

    record(
      `${role}: nothing usable found — probed ${String(tried.length)}: ${tried.join(' | ')}`,
    );
    return null;
  }

  async function inspect(path: string): Promise<ModelInspection> {
    return inspectModelFile(path);
  }

  /** Where a catalogue model lives once installed. */
  function destinationFor(id: ModelId): string {
    return join(options.modelsDirectory, MODEL_CATALOGUE[id].fileName);
  }

  async function status(id: ModelId): Promise<ModelStatus> {
    const inModels = await inspectModelFile(destinationFor(id));
    if (inModels.status === 'ready') return 'ready';
    // A bundled model also lives beside the executable, and that copy is what makes
    // D-W3's "no first-run download" true. Not finding it in the models directory is not
    // the same as not having it.
    if (options.bundledDirectory.length > 0) {
      const beside = await inspectModelFile(
        join(options.bundledDirectory, MODEL_CATALOGUE[id].fileName),
      );
      if (beside.status === 'ready') return 'ready';
      // A present-but-broken file anywhere is the more actionable answer: `notInstalled`
      // tells the user to obtain a model they already have.
      if (beside.status === 'corrupt' || inModels.status === 'corrupt') return 'corrupt';
      return 'notInstalled';
    }
    return inModels.status;
  }

  /**
   * IDEMPOTENT BY CHECKSUM, not by existence.
   *
   * An already-correct file is not refetched — weights survive re-signs and a 1.1 GB
   * re-download on a hunch is not free — but a file whose hash disagrees is replaced,
   * and a download whose hash disagrees never lands: it is written to a temporary name
   * and renamed only after it verifies, so a half-written file can never pass the
   * existence check that other code does.
   */
  async function ensure(
    id: ModelId,
    onProgress?: (progress: ModelDownloadProgress) => void,
  ): Promise<string> {
    const spec = MODEL_CATALOGUE[id];
    const destination = destinationFor(id);

    const existing = await inspectModelFile(destination);
    if (existing.status === 'ready') {
      if (spec.sha256.length === 0) {
        record(`${spec.name} present, no checksum to verify against`);
        return destination;
      }
      const actual = await sha256OfFile(destination);
      if (actual === spec.sha256.toLowerCase()) {
        record(`${spec.name} present and verified`);
        return destination;
      }
      record(
        `${spec.name} present but sha256 ${actual.slice(0, 12)}… != ${spec.sha256.slice(0, 12)}…, refetching`,
      );
      await unlink(destination).catch(() => undefined);
    }

    // D-W3: the bundled models are in the installer, so a missing one is a broken
    // install rather than something to fetch. Only the Fast English model has a public
    // URL it is expected to arrive by.
    // This project's own builds sit under PUBLIC_MODELS_BASE, which is a placeholder until
    // the repository is public: offering that download before then would be a 404 button.
    const placeholder = spec.url !== null && spec.url.startsWith(PUBLIC_MODELS_BASE)
      && !PUBLIC_MODELS_LIVE;
    if (spec.url === null || placeholder) {
      record(`${spec.name} cannot be downloaded — there is no public copy`);
      throw new Error(
        `${spec.name} is not installed and cannot be downloaded — it ships inside the installer`,
      );
    }

    await ensureModelsDirectory();
    await mkdir(dirname(destination), { recursive: true });

    record(`${spec.name} downloading from ${spec.url}`);
    const response = await fetch(spec.url);
    if (!response.ok) {
      record(`${spec.name} failed to download: HTTP ${response.status}`);
      throw new Error(`${spec.name} failed to download: HTTP ${response.status}`);
    }
    const lengthHeader = response.headers.get('content-length');
    const totalBytes = lengthHeader === null ? null : Number(lengthHeader);

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    if (response.body !== null) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        chunks.push(buffer);
        receivedBytes += buffer.length;
        onProgress?.({ modelId: id, receivedBytes, totalBytes });
      }
    }
    const data = Buffer.concat(chunks, receivedBytes);

    const actual = createHash('sha256').update(data).digest('hex');
    if (spec.sha256.length > 0 && actual !== spec.sha256.toLowerCase()) {
      record(`${spec.name} arrived corrupt, discarded`);
      throw new Error(
        `${spec.name} arrived corrupt — expected sha256 ${spec.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
      );
    }
    if (spec.sha256.length === 0) {
      record(`${spec.name} has no expected sha256; it is ${actual}`);
    }

    // Atomic: a half-written file that passes an existence check is worse than no file.
    //
    // Two things `writeFile(temp)` + `rename()` did not give, and both end with a file
    // that is present, plausible, and wrong — which is the one outcome D-W10 exists to
    // make impossible.
    //
    //   * ONE SHARED TEMPORARY NAME. `${destination}.partial` is the same path for every
    //     writer of this model, so two `ensure()` calls in flight at once — two windows,
    //     a retry racing the attempt it replaced, a second instance — interleave their
    //     writes into it, and the rename publishes a file whose bytes came from both.
    //     The sha256 above was computed on the in-memory buffer and never on what
    //     landed, so nothing downstream ever notices.
    //   * NO FSYNC. The rename is atomic with respect to READERS — they see the old file
    //     or the new one, never a mixture — but not with respect to a crash. The
    //     directory entry and the file's SIZE are metadata and can reach the disk while
    //     the data behind them has not, leaving a full-length file at the final name
    //     whose tail is whatever was in those blocks. `inspectModelFile` reads four
    //     bytes and a stat, so it calls that `ready`.
    const temporary = `${destination}.${randomBytes(8).toString('hex')}.partial`;
    try {
      const handle = await open(temporary, 'w');
      try {
        await handle.write(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      // And the directory entry the rename created, so the rename itself survives a
      // crash. POSIX requires this; Windows has no equivalent and will not open a
      // directory for reading, so failing here is the EXPECTED case on the platform this
      // port targets and is not worth a note.
      const directory = await open(dirname(destination), 'r').catch(() => null);
      if (directory !== null) {
        await directory.sync().catch(() => undefined);
        await directory.close();
      }
    } catch (error) {
      // Never leave the partial behind. It is invisible to `resolve` — the name does not
      // end in `.bin` — but it is 539 MB on a laptop that may have been short of space
      // when the write failed in the first place.
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    record(`${spec.name} installed (${data.length} bytes)`);
    return destination;
  }

  return {
    inspect,
    resolve,
    ensure,
    status,
    get notes() {
      return notes;
    },
  };
};
