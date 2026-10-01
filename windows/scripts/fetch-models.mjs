#!/usr/bin/env node
//
// windows/scripts/fetch-models.mjs — stage the models the installer carries into the packaged
// resources (D-W3, narrowed by D-W25: Uzbek, the detector and Silero — what Uzbek needs offline
// from the first launch; Parakeet, Qwen and whisper turbo are downloads the app makes itself).
//
// Source of truth for filenames / sizes / sha256 is `MODEL_CATALOGUE` in
// `src/contracts/models.ts` — the comment on that constant explains why: a hash that
// exists in two files can disagree, and that is exactly how `ClusterMass.defaultThreshold`
// once said 0.5 in one file and 0.05 in the app. This script reads the COMPILED version
// of that catalogue (`dist/src/contracts/models.js`) rather than re-declaring the three
// entries here, so `npm run build` must run before this script does. It stages exactly the
// `bundled: true` entries, so whisper turbo (`bundled: false` since D-W25) is not fetched.
//
//   ggml-uzbek-stt-v1-q5_0.bin    — PUBLIC_MODELS_BASE (placeholder until the repo is public),
//                                   falling back to private release `models-v2` via `gh`
//   ggml-base-q5_1.bin            — public Hugging Face URL (also in Scripts/Manifest.json)
//   silero-vad-v6.2.0/ggml-silero-v6.2.0.bin
//                                 — every `SHIPPED_BUNDLE_IDS` bundle from BUNDLE_CATALOGUE
//                                   (src/contracts/bundles.ts), pinned Hugging Face commit;
//                                   staged in its bundle directory, which is where the app's
//                                   bundle store looks under resources/models
//
// Every sha256 is verified before the file is trusted, and a mismatch is a hard failure
// (D-W10's whole point: a 0-byte or truncated model must never quietly ship). Downloads
// are resumable — a partial file left by a killed run or a flaky connection is continued
// with an HTTP Range request rather than restarted — and re-running this script against
// an already-correct file costs one hash pass, not 0.6 GB of network, which is what
// makes it cheap to cache between CI runs (t12's workflow caches this script's `--dest`
// directory keyed on a manifest hash).
//
// Usage:
//   node scripts/fetch-models.mjs [--dest <dir>] [--manifest <path/to/Manifest.json>]
//   node scripts/fetch-models.mjs <dir>                     (positional dest, same thing)
//
// `--dest` defaults to `fixtures/models` — matching how t12's CI workflow invokes this
// script (`--dest fixtures/models`, cached on `hashFiles('Scripts/Manifest.json')`).
// `electron-builder.yml`'s `extraResources` reads from that same directory; whatever you
// pass here, pass the same thing there.
//
// `--manifest` is accepted for CLI compatibility with that workflow and is used ONLY to
// cross-check the two public models' URLs and print a warning on drift — never to
// override MODEL_CATALOGUE. See "THE MODEL CONFLICT, resolved" in src/contracts/models.ts:
// `Scripts/Manifest.json` still names the Uzbek model's SUPERSEDED build
// (`ggml-navoi-medium-q5_0.bin`, release tag `models-v1`), while this task's brief and
// MODEL_CATALOGUE both specify the current one (`ggml-uzbek-stt-v1-q5_0.bin`, `models-v2`).
// A manifest is not a second source of truth here on purpose.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS_ROOT = path.resolve(HERE, '..');
const DIST_CATALOGUE = path.join(WINDOWS_ROOT, 'dist', 'src', 'contracts', 'models.js');

// Set from the compiled catalogue in main(); see PUBLIC_MODELS_BASE in src/contracts/models.ts.
let PUBLIC_MODELS_BASE = '';
let PRIVATE_MODELS_RELEASE = { repo: '', tag: '' };

/** The shipped first-use bundles (Silero), read with the catalogue. */
let SHIPPED_BUNDLES = [];

/** @returns {Promise<Record<string, {id:string,name:string,fileName:string,sha256:string,bytes:number|null,url:string|null,bundled:boolean}>>} */
async function loadCatalogue() {
  try {
    await fs.access(DIST_CATALOGUE);
  } catch {
    console.error(
      `fetch-models: ${path.relative(WINDOWS_ROOT, DIST_CATALOGUE)} does not exist.\n` +
        '  Run `npm run build` in windows/ first — this script reads MODEL_CATALOGUE from the\n' +
        '  compiled contracts on purpose, so a sha256 cannot drift between two files.',
    );
    process.exit(1);
  }
  const mod = await import(pathToFileURL(DIST_CATALOGUE).href);
  PUBLIC_MODELS_BASE = mod.PUBLIC_MODELS_BASE;
  PRIVATE_MODELS_RELEASE = mod.PRIVATE_MODELS_RELEASE;
  // A bundle the installer carries is staged as `<dest>/<directory>/<localName>` — the layout
  // the app's bundle store looks for under `resources/models`. Each file becomes one spec in
  // the same shape as a model, so it goes through the same fetch, resume and hash.
  const bundles = await import(pathToFileURL(path.join(path.dirname(DIST_CATALOGUE), 'bundles.js')).href);
  SHIPPED_BUNDLES = bundles.SHIPPED_BUNDLE_IDS.flatMap((id) => {
    const bundle = bundles.BUNDLE_CATALOGUE[id];
    return bundle.files.map((file) => ({
      id,
      name: bundle.name,
      fileName: path.join(bundle.directory, file.localName),
      sha256: file.sha256,
      bytes: file.bytes,
      url: bundle.baseUrl + file.remotePath,
      bundled: true,
    }));
  });
  return mod.MODEL_CATALOGUE;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fileSize(filePath) {
  try {
    const st = await fs.stat(filePath);
    return st.size;
  } catch {
    return 0;
  }
}

/** Plain HTTP(S) download with Range-based resume. Throws on any non-2xx response. */
async function downloadResumable(url, dest, expectedBytes) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let startByte = await fileSize(dest);

  if (expectedBytes && startByte >= expectedBytes) {
    // Already have >= the expected size — let the caller's hash check decide if it's good.
    return;
  }

  const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : {};
  const res = await fetch(url, { headers });

  if (startByte > 0 && res.status === 200) {
    // Server does not support Range (or the previous partial is stale) — restart clean.
    startByte = 0;
    await fs.rm(dest, { force: true });
  } else if (startByte > 0 && res.status !== 206) {
    throw new Error(`resume request to ${url} failed: HTTP ${res.status}`);
  } else if (startByte === 0 && !res.ok) {
    throw new Error(`download of ${url} failed: HTTP ${res.status}`);
  }

  if (!res.body) {
    throw new Error(`download of ${url} returned no body`);
  }

  const fh = await fs.open(dest, startByte > 0 ? 'r+' : 'w');
  try {
    const writeStream = fh.createWriteStream({ start: startByte });
    await pipeline(Readable.fromWeb(res.body), writeStream);
  } finally {
    await fh.close();
  }
}

/** `gh release download` — the private release. No byte-range resume is available here,
 * so a bad/partial file is deleted and the whole asset is re-fetched once. `gh` itself
 * picks up GH_TOKEN / GITHUB_TOKEN from the environment; nothing here handles auth. */
async function downloadFromPrivateRelease({ tag, repo }, fileName, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  await execFileAsync(
    'gh',
    ['release', 'download', tag, '--repo', repo, '--pattern', fileName, '--dir', destDir, '--clobber'],
    { stdio: 'inherit' },
  );
}

async function verifyOrThrow(spec, dest) {
  const bytes = await fileSize(dest);
  if (spec.bytes !== null && bytes !== spec.bytes) {
    throw new Error(`${spec.fileName}: expected ${spec.bytes} bytes, got ${bytes}`);
  }
  if (spec.sha256) {
    const actual = await sha256File(dest);
    if (actual !== spec.sha256.toLowerCase()) {
      throw new Error(`${spec.fileName}: sha256 mismatch\n  expected ${spec.sha256}\n  actual   ${actual}`);
    }
  }
}

async function stageOne(spec, destDir) {
  const dest = path.join(destDir, spec.fileName);

  // Cache hit: already present and correct, skip the network entirely.
  const existingBytes = await fileSize(dest);
  if (existingBytes > 0 && (spec.bytes === null || existingBytes === spec.bytes)) {
    try {
      await verifyOrThrow(spec, dest);
      console.log(`ok    ${spec.fileName} — already staged, hash verified (${existingBytes} bytes)`);
      return;
    } catch {
      console.log(`stale ${spec.fileName} — cached file failed verification, re-fetching`);
      await fs.rm(dest, { force: true });
    }
  }

  console.log(`fetch ${spec.fileName} (${spec.bytes ?? 'unknown'} bytes expected)`);

  await fetchOne(spec, dest, destDir);

  try {
    await verifyOrThrow(spec, dest);
  } catch (firstError) {
    console.warn(`retry ${spec.fileName} — verification failed once, retrying from scratch:\n  ${firstError.message}`);
    await fs.rm(dest, { force: true });
    await fetchOne(spec, dest, destDir);
    await verifyOrThrow(spec, dest); // second failure is fatal — let it throw.
  }

  console.log(`ok    ${spec.fileName} — verified`);
}

/** The public URL first — what a stranger's build uses. This project's own builds (those under
 * PUBLIC_MODELS_BASE) fall back to the private release through `gh` while that host is still a
 * placeholder, so CI keeps working until the repository is public. */
async function fetchOne(spec, dest, destDir) {
  const own = spec.url !== null && spec.url.startsWith(PUBLIC_MODELS_BASE);
  if (spec.url !== null) {
    try {
      await downloadResumable(spec.url, dest, spec.bytes);
      return;
    } catch (error) {
      if (!own) throw error;
      console.warn(`public ${spec.fileName} — ${error.message}; trying the private release via gh`);
      await fs.rm(dest, { force: true });
    }
  }
  await downloadFromPrivateRelease(PRIVATE_MODELS_RELEASE, spec.fileName, destDir);
}

function parseArgs(argv) {
  let dest = null;
  let manifest = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dest') {
      dest = argv[++i];
    } else if (arg === '--manifest') {
      manifest = argv[++i];
    } else if (!arg.startsWith('--') && dest === null) {
      dest = arg; // positional fallback: `fetch-models.mjs <dir>`
    }
  }
  return { dest, manifest };
}

/** Warn (never fail, never override) on drift between Manifest.json and MODEL_CATALOGUE
 * for every bundled model with a URL (both since C2: the Uzbek build is now under
 * PUBLIC_MODELS_BASE, and Manifest.json names the same file). */
async function crossCheckManifest(manifestPath, catalogue) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (err) {
    console.warn(`fetch-models: could not read --manifest ${manifestPath} (${err.message}) — skipping the cross-check`);
    return;
  }
  const byDest = new Map((raw.models ?? []).map((m) => [m.dest, m]));
  for (const spec of Object.values(catalogue).filter((s) => s.bundled && s.url !== null)) {
    const entry = byDest.get(spec.fileName);
    if (!entry) continue;
    if (entry.sha256 && entry.sha256.toLowerCase() !== spec.sha256.toLowerCase()) {
      console.warn(
        `fetch-models: ${spec.fileName} — Manifest.json's sha256 disagrees with MODEL_CATALOGUE. ` +
          'MODEL_CATALOGUE wins; this is worth reconciling in Manifest.json.',
      );
    }
  }
}

async function main() {
  const { dest, manifest } = parseArgs(process.argv.slice(2));
  const destDir = dest ? path.resolve(dest) : path.join(WINDOWS_ROOT, 'fixtures', 'models');

  const catalogue = await loadCatalogue();

  if (manifest) {
    await crossCheckManifest(path.resolve(manifest), catalogue);
  }

  const bundled = [...Object.values(catalogue).filter((spec) => spec.bundled), ...SHIPPED_BUNDLES];

  if (bundled.length === 0) {
    console.error('fetch-models: MODEL_CATALOGUE has no bundled=true entries — nothing to stage.');
    process.exit(1);
  }

  console.log(`fetch-models: staging ${bundled.length} model(s) into ${path.relative(WINDOWS_ROOT, destDir)}/`);

  let failures = 0;
  for (const spec of bundled) {
    try {
      await stageOne(spec, destDir);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${spec.fileName}: ${err.message}`);
    }
  }

  if (failures > 0) {
    console.error(`fetch-models: ${failures} of ${bundled.length} model(s) failed verification. Not packaging.`);
    process.exit(1);
  }

  console.log(`fetch-models: all ${bundled.length} bundled model files staged and verified.`);
}

main().catch((err) => {
  console.error('fetch-models: unexpected failure:', err);
  process.exit(1);
});
