#!/usr/bin/env node
//
// windows/scripts/verify-installer.mjs — D-W10 / D-W3: assert the built installer is
// PLAUSIBLE, and that it actually CONTAINS the models, before anyone downloads it,
// releases it, or trusts it.
//
// The expensive failure this exists to catch is not a corrupt build. It is a build that
// packaged WITHOUT its resources: still a valid .exe, still installs cleanly, and then
// dies on the user's machine with "no model" — after a 0.67 GB download over Uzbek mobile
// data. There is no cheaper place to catch that than here. And, since D-W25, the opposite: an
// installer that carries what it must not — whisper turbo (574 MB) is a Turkish/Arabic download
// now, and a stale staging directory putting it back would make every installer 1.25 GB again.
//
// Checks, in order:
//
//   1. the NSIS installer .exe exists, and its size is in (0.55 GB, 0.95 GB) — decimal GB,
//      the unit D-W25 sums the shipped models in (539.2 + 59.7 + 0.9 MB ≈ 0.60 GB; 1.0.0's
//      installer with turbo inside was 1.245 GB, so the ceiling catches turbo coming back);
//   2. the portable .zip exists and is in the same plausible range;
//   3. size accounting, needing no tools at all: both artifacts must be at least the SUM
//      of the shipped model sizes minus a stated allowance. q5_0/q5_1 weights are already
//      entropy-coded — LZMA wins almost nothing on them — so an installer that dropped
//      one falls hundreds of megabytes short and this catches it on arithmetic alone;
//   4. the two models — and the shipped Silero VAD, sized AND hashed — are in
//      `release/win-unpacked/`, the staging tree electron-builder
//      hands to NSIS — ground truth for "what was packed", not a guess from
//      `resources/models/` which only proves they were STAGED; and no model that is a
//      download (whisper turbo, D-W25) is there;
//   5. the shipped models are inside the COMPILED ARTIFACTS themselves, by name and by
//      exact byte size:
//        - the .zip is a flat archive: `7z l` lists `resources/models/*.bin` directly;
//        - the .exe is NOT. An electron-builder NSIS installer embeds the entire app as
//          ONE nested archive entry (`app-64.7z`); a flat `7z l` of the .exe lists that
//          entry, plus a couple of plugin DLLs, and NOTHING ELSE. Asking it for a model
//          filename is asking a question the format cannot answer — it will always say
//          no, on a good build and a bad one alike, which is exactly the false failure
//          this file was rewritten to remove. So: list the .exe with the NSIS handler
//          forced (`-tnsis`; left to sniff, 7-Zip may pick the PE handler and list
//          SECTIONS), find the nested archive entry, extract it to a temp dir, and list
//          THAT. The model names and sizes are one layer down and that is where we look.
//      Step 5's archive work is skipped with a warning, not a failure, when `7z` is not
//      on the machine — windows-latest ships it, a developer's Mac might not. Steps 1–4
//      still run, and step 3 in particular is a real backstop that needs no 7z.
//
// Every check prints WHAT IT FOUND, not just its verdict — the nested archive's name and
// size, the matched entry paths, and on failure a sample of the entries that were there
// instead. A verifier that cannot explain itself is worse than no verifier: it is the
// reason a real build does not ship.
//
// Exits non-zero having printed every finding first — same "fail loud, name what and
// why" shape as gate.sh.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS_ROOT = path.resolve(HERE, '..');
const DIST_CATALOGUE = path.join(WINDOWS_ROOT, 'dist', 'src', 'contracts', 'models.js');

// Decimal GB (1e9 bytes) — the unit D-W25 sums the shipped models in.
const GB = 1_000_000_000;
const MIN_INSTALLER_BYTES = 0.55 * GB;
const MAX_INSTALLER_BYTES = 0.95 * GB;
// The portable zip is built with `compression: store` (electron-builder.yml): the same payload as
// the installer, uncompressed — 1.234 GB on 2026-10-02 against the installer's 0.73 GB, so the
// installer's ceiling wrongly failed a correct zip. Turbo staged back in would add ~0.57 GB and
// still trip this.
const MAX_ZIP_BYTES = 1.4 * GB;

// How far BELOW the sum of the model bytes an artifact is still allowed to be (check 3).
// The models are q5-quantised weights: near-incompressible, so in practice the installer
// comes out LARGER than their sum, not smaller. 150 MB is ~25% of the 0.60 GB total —
// wide enough that a compression-setting change can never make this fire spuriously,
// narrow enough that dropping the Uzbek model (539 MB) still trips it by a wide margin (the
// 60 MB detector is caught by name in steps 4 and 5).
const MODEL_SUM_ALLOWANCE_BYTES = 150_000_000;

// 7z has to physically write out the nested archive before it can be listed, and that
// archive is essentially the whole 0.67 GB payload. Generous, because a slow runner disk
// is not a build defect.
const SEVENZIP_TIMEOUT_MS = 15 * 60 * 1000;
const SEVENZIP_MAX_BUFFER = 64 * 1024 * 1024;

let failures = 0;
function ok(msg) {
  console.log(`ok    ${msg}`);
}
function fail(msg) {
  console.error(`FAIL  ${msg}`);
  failures += 1;
}
function warn(msg) {
  console.warn(`warn  ${msg}`);
}
function info(msg) {
  console.log(`      ${msg}`);
}

async function loadBundledModelSpecs() {
  try {
    await fs.access(DIST_CATALOGUE);
  } catch {
    console.error(
      `verify-installer: ${path.relative(WINDOWS_ROOT, DIST_CATALOGUE)} does not exist.\n` +
        '  Run `npm run build` first — this reads the bundled model list from the compiled\n' +
        '  contracts so it can never disagree with what fetch-models.mjs staged.',
    );
    process.exit(1);
  }
  const mod = await import(pathToFileURL(DIST_CATALOGUE).href);
  // The shipped bundles (Silero) as file specs, `fileName` relative to resources/models —
  // the same shape fetch-models.mjs stages them in.
  const bundles = await import(pathToFileURL(path.join(path.dirname(DIST_CATALOGUE), 'bundles.js')).href);
  const shippedBundleFiles = bundles.SHIPPED_BUNDLE_IDS.flatMap((id) => {
    const bundle = bundles.BUNDLE_CATALOGUE[id];
    return bundle.files.map((file) => ({
      fileName: `${bundle.directory}/${file.localName}`,
      bytes: file.bytes,
      sha256: file.sha256,
    }));
  });
  return [...Object.values(mod.MODEL_CATALOGUE).filter((spec) => spec.bundled), ...shippedBundleFiles];
}

async function findOne(dir, suffix) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { matches: [], dirExists: false };
  }
  const matches = entries.filter((name) => name.toLowerCase().endsWith(suffix)).map((name) => path.join(dir, name));
  return { matches, dirExists: true };
}

function humanBytes(bytes) {
  return `${(bytes / GB).toFixed(3)} GB (${bytes} bytes)`;
}

async function checkArtifact(dir, suffix, label) {
  const { matches, dirExists } = await findOne(dir, suffix);
  if (!dirExists) {
    fail(`${label}: output directory ${path.relative(WINDOWS_ROOT, dir)}/ does not exist — nothing was built`);
    return null;
  }
  if (matches.length === 0) {
    fail(`${label}: no *${suffix} found in ${path.relative(WINDOWS_ROOT, dir)}/`);
    return null;
  }
  if (matches.length > 1) {
    fail(`${label}: ${matches.length} candidates found, expected exactly one: ${matches.map((m) => path.basename(m)).join(', ')}`);
    return null;
  }
  const artifactPath = matches[0];
  const { size } = await fs.stat(artifactPath);
  const name = path.basename(artifactPath);
  if (size < MIN_INSTALLER_BYTES) {
    fail(`${label}: ${name} is only ${humanBytes(size)} — smaller than the 0.55 GB floor. A 0-byte or truncated build would pass every other check silently; this is the one that catches it.`);
    return null;
  }
  const ceiling = name.endsWith('.zip') ? MAX_ZIP_BYTES : MAX_INSTALLER_BYTES;
  if (size > ceiling) {
    fail(`${label}: ${name} is ${humanBytes(size)} — larger than the ${ceiling / GB} GB ceiling. D-W25 keeps the installer light (Parakeet, Qwen and turbo are downloads); did a downloaded model get staged into it?`);
    return null;
  }
  ok(`${label}: ${name} — ${humanBytes(size)}`);
  return artifactPath;
}

/** Check 3 — the cheap backstop. Needs no 7z, no extraction, no packaging knowledge:
 * just arithmetic against the model sizes the contracts declare. */
async function checkSizeAccounting(artifactPath, label, specs) {
  const sized = specs.filter((spec) => typeof spec.bytes === 'number');
  if (sized.length === 0) {
    warn(`size-accounting: ${label}: the model catalogue declares no byte sizes — nothing to account against`);
    return;
  }
  const sum = sized.reduce((total, spec) => total + spec.bytes, 0);
  const floor = sum - MODEL_SUM_ALLOWANCE_BYTES;
  const { size } = await fs.stat(artifactPath);
  const breakdown = sized.map((spec) => `${spec.fileName}=${spec.bytes}`).join(' + ');
  if (size < floor) {
    fail(
      `size-accounting: ${label}: ${path.basename(artifactPath)} is ${humanBytes(size)}, below the ${humanBytes(floor)} floor ` +
        `(${sized.length} bundled models sum to ${sum} bytes, minus a ${MODEL_SUM_ALLOWANCE_BYTES}-byte allowance). ` +
        'q5-quantised weights do not compress, so a build that dropped one lands hundreds of MB short — which is what this looks like.',
    );
    info(`models: ${breakdown} = ${sum} bytes`);
    return;
  }
  ok(
    `size-accounting: ${label}: ${path.basename(artifactPath)} is ${size} bytes vs a ${floor}-byte floor ` +
      `(model sum ${sum} − ${MODEL_SUM_ALLOWANCE_BYTES} allowance) — ${size - floor} bytes of headroom`,
  );
}

async function checkUnpackedModels(releaseDir, specs) {
  const unpackedModelsDir = path.join(releaseDir, 'win-unpacked', 'resources', 'models');
  let entries;
  try {
    entries = await fs.readdir(unpackedModelsDir);
  } catch {
    fail(
      `models: ${path.relative(WINDOWS_ROOT, unpackedModelsDir)}/ does not exist — electron-builder never staged ` +
        'a models directory into the unpacked app. Check extraResources in electron-builder.yml and that ' +
        'resources/models/*.bin existed before the build ran (scripts/fetch-models.mjs).',
    );
    return;
  }
  // D-W25: a model that is a download must not ride along (electron-builder.yml names the
  // shipped files, so this is a stale-staging backstop).
  for (const name of NOT_SHIPPED) {
    if (entries.includes(name)) fail(`models: ${name} is in the packaged app, but it is a Turkish/Arabic download since D-W25`);
    else ok(`models: ${name} is not in the packaged app (downloaded with Turkish or Arabic)`);
  }
  for (const spec of specs) {
    // A shipped bundle file sits one directory down (`silero-vad-v6.2.0/…`).
    const top = spec.fileName.split('/')[0];
    if (!entries.includes(top)) {
      fail(`models: ${spec.fileName} is missing from the packaged app (win-unpacked/resources/models/)`);
      continue;
    }
    const file = path.join(unpackedModelsDir, ...spec.fileName.split('/'));
    let size;
    try {
      ({ size } = await fs.stat(file));
    } catch {
      fail(`models: ${spec.fileName} is missing from the packaged app (win-unpacked/resources/models/)`);
      continue;
    }
    if (spec.bytes !== null && size !== spec.bytes) {
      fail(`models: ${spec.fileName} is ${size} bytes inside the package, expected ${spec.bytes} — packaging altered it`);
      continue;
    }
    // A small file is hashed too: the app hashes the shipped Silero at launch and ignores a
    // copy that does not match, so a packaging step that altered it must fail HERE instead.
    if (spec.sha256 && size <= SMALL_FILE_HASH_BYTES) {
      const actual = await sha256OfFile(file);
      if (actual !== spec.sha256) {
        fail(`models: ${spec.fileName} has sha256 ${actual.slice(0, 12)}… inside the package, expected ${spec.sha256.slice(0, 12)}…`);
        continue;
      }
      ok(`models: ${spec.fileName} present in the packaged app (${size} bytes, sha256 verified)`);
      continue;
    }
    ok(`models: ${spec.fileName} present in the packaged app (${size} bytes)`);
  }
}

/** Model files that are downloads, never installer contents (D-W25). */
const NOT_SHIPPED = ['ggml-large-v3-turbo-q5_0.bin'];

/** Files at or under this size are hashed as well as sized (the shipped Silero). */
const SMALL_FILE_HASH_BYTES = 16 * 1024 * 1024;

async function sha256OfFile(file) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

/**
 * The on-device engines' native binaries, where Windows' loader can reach them: OUTSIDE
 * app.asar. onnxruntime-node (Parakeet) and node-llama-cpp (Qwen3-1.7B) are N-API addons
 * that load DLLs from beside themselves, and a DLL inside an archive cannot be mapped — the
 * failure would be "English and Russian fall back to whisper, the modes run on rules",
 * silently, on the user's machine. Also asserts the trimming held: no other platform's
 * ONNX Runtime and no CUDA build of llama.cpp (~545 MB nobody here can use).
 */
async function checkNativeEngines(releaseDir) {
  const unpacked = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules');
  const required = [
    ['onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime.dll'],
    ['onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_binding.node'],
    ['onnxruntime-node', 'package.json'],
    ['onnxruntime-common', 'package.json'],
    // The Parakeet worker thread's script and what it imports, outside the archive.
    ['..', 'dist', 'src', 'engines', 'parakeet-worker.js'],
    ['..', 'dist', 'src', 'engines', 'parakeet-runtime.js'],
    ['..', 'dist', 'src', 'core', 'stt', 'tdt.js'],
  ];
  for (const parts of required) {
    const file = path.join(unpacked, ...parts);
    try {
      const { size } = await fs.stat(file);
      ok(`native: ${parts.join('/')} unpacked (${size} bytes)`);
    } catch {
      fail(`native: ${parts.join('/')} is not in app.asar.unpacked — Parakeet cannot load (check asarUnpack)`);
    }
  }
  const llamaAddons = [];
  async function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name === 'llama-addon.node') llamaAddons.push(path.relative(unpacked, full));
    }
  }
  await walk(path.join(unpacked, '@node-llama-cpp'), 0);
  if (llamaAddons.length === 0) {
    fail('native: no @node-llama-cpp/*/llama-addon.node in app.asar.unpacked — the modes model cannot load');
  } else {
    ok(`native: node-llama-cpp prebuilts unpacked: ${llamaAddons.join(', ')}`);
  }
  if (llamaAddons.some((entry) => /cuda/u.test(entry))) fail('native: a CUDA llama.cpp build was packaged; it is excluded on purpose');
  await checkArabicEngine(releaseDir, unpacked);
  for (const platform of ['darwin', 'linux']) {
    try {
      await fs.stat(path.join(unpacked, 'onnxruntime-node', 'bin', 'napi-v6', platform));
      fail(`native: onnxruntime-node's ${platform} binaries were packaged; only win32/x64 belongs here`);
    } catch {
      // Absent, as it should be.
    }
  }
}

/**
 * C4: Arabic's Cohere engine — transcribe.cpp's win-x64 build and koffi's binding, OUTSIDE
 * app.asar (LoadLibrary cannot read an archive; `arabic-runtime.ts` points TRANSCRIBE_LIBRARY at
 * the unpacked transcribe.dll, whose directory is also where ggml's backends are loaded from),
 * the build's contract matching the binding, no other platform's copy — and the speed check's
 * standard clip. Without these, Arabic silently runs on whisper for every user.
 */
async function checkArabicEngine(releaseDir, unpacked) {
  const tcpp = path.join(unpacked, '@transcribe-cpp', 'win32-x64-cpu-vulkan');
  const required = [
    'transcribe.dll',
    'ggml.dll',
    'ggml-base.dll',
    'ggml-vulkan.dll',
    // The CPU backends ggml picks from at start-up, one per x86 level; the floor must be there.
    'ggml-cpu-x64.dll',
    'ggml-cpu-haswell.dll',
    'contract.json',
  ];
  for (const name of required) {
    try {
      const { size } = await fs.stat(path.join(tcpp, name));
      ok(`arabic: @transcribe-cpp/win32-x64-cpu-vulkan/${name} unpacked (${size} bytes)`);
    } catch {
      fail(`arabic: @transcribe-cpp/win32-x64-cpu-vulkan/${name} is not in app.asar.unpacked — Cohere cannot load (check asarUnpack, and step 3 of build-installer-mac.sh)`);
    }
  }
  try {
    const contract = JSON.parse(await fs.readFile(path.join(tcpp, 'contract.json'), 'utf8'));
    const binding = JSON.parse(await fs.readFile(path.join(WINDOWS_ROOT, 'node_modules', 'transcribe-cpp', 'package.json'), 'utf8'));
    if (contract.version === binding.version) ok(`arabic: transcribe.dll is ${contract.version}, the binding's version`);
    else fail(`arabic: transcribe.dll is ${contract.version} but the binding is ${binding.version} — the loader refuses a mismatch`);
  } catch (error) {
    fail(`arabic: could not compare transcribe.cpp's contract with its binding: ${error.message}`);
  }
  for (const parts of [['@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'], ['koffi', 'package.json']]) {
    try {
      const { size } = await fs.stat(path.join(unpacked, ...parts));
      ok(`arabic: ${parts.join('/')} unpacked (${size} bytes)`);
    } catch {
      fail(`arabic: ${parts.join('/')} is not in app.asar.unpacked — transcribe.cpp's FFI cannot load`);
    }
  }
  for (const other of ['darwin-arm64-metal', 'darwin-x64-cpu', 'linux-x64-cpu-vulkan', 'linux-arm64-cpu-vulkan']) {
    try {
      await fs.stat(path.join(unpacked, '@transcribe-cpp', other));
      fail(`arabic: @transcribe-cpp/${other} was packaged; only win32-x64 belongs here`);
    } catch {
      // Absent, as it should be.
    }
  }
  const clip = path.join(releaseDir, 'win-unpacked', 'resources', 'audio', 'arabic-speed-check.wav');
  try {
    const { size } = await fs.stat(clip);
    ok(`arabic: resources/audio/arabic-speed-check.wav present (${size} bytes)`);
  } catch {
    fail('arabic: resources/audio/arabic-speed-check.wav is missing — the speed check cannot run, so Cohere is never demoted on a slow PC');
  }
}

// ---------------------------------------------------------------------------
// 7-Zip: the two-layer read of the compiled artifacts
// ---------------------------------------------------------------------------

async function find7z() {
  const candidates = ['7z', '7z.exe', 'C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'];
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['i']);
      return candidate;
    } catch {
      // not this one
    }
  }
  return null;
}

async function run7z(sevenZip, args) {
  try {
    const { stdout } = await execFileAsync(sevenZip, args, {
      timeout: SEVENZIP_TIMEOUT_MS,
      maxBuffer: SEVENZIP_MAX_BUFFER,
    });
    return { stdout, error: null };
  } catch (err) {
    // 7z exits non-zero on "warnings" — an NSIS script section it cannot decompile, say —
    // while still having produced correct output. Hand the caller both and let it judge
    // by what it actually got rather than by the exit code.
    return { stdout: err.stdout ?? '', error: err };
  }
}

/** Parse `7z l -slt` output. The technical listing emits one `Key = Value` record per
 * entry after a `----------` line, which is parseable exactly — unlike the default
 * fixed-width table, whose columns shift with the archive type.
 *
 * The `----------` split is load-bearing, not cosmetic: BEFORE it, `-slt` prints the
 * ARCHIVE's own properties, including a `Path =` and a `Size =` of its own. Parsed as an
 * entry, the archive would outrank every real entry in the largest-first ranking that
 * picks the nested payload — and we would extract the installer from itself. No
 * separator, no entries; say so rather than guess. */
function parseTechnicalListing(stdout) {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '----------');
  if (start === -1) return [];
  const body = lines.slice(start + 1);
  const entries = [];
  let current = null;
  for (const line of body) {
    const match = /^([A-Za-z][A-Za-z0-9 ]*?)\s=\s?(.*)$/.exec(line);
    if (!match) {
      if (line.trim() === '' && current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    const [, key, value] = match;
    if (key === 'Path') {
      if (current) entries.push(current);
      current = { path: value, size: null };
    } else if (key === 'Size' && current) {
      const n = Number.parseInt(value, 10);
      current.size = Number.isFinite(n) ? n : null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function basenameOf(entryPath) {
  return entryPath.split(/[\\/]/).pop() ?? entryPath;
}

/** Assert each bundled model appears in a parsed archive listing, by name AND exact byte
 * size. The `ok` line it prints names the entry it matched — that line is the evidence
 * that the payload is really there. */
function assertModelsInListing(entries, specs, { label, where }) {
  const byName = new Map();
  for (const entry of entries) byName.set(basenameOf(entry.path).toLowerCase(), entry);

  for (const spec of specs) {
    const entry = byName.get(basenameOf(spec.fileName).toLowerCase());
    if (!entry) {
      fail(`${label}: ${spec.fileName} is NOT among the ${entries.length} entries of ${where}`);
      continue;
    }
    if (spec.bytes !== null && entry.size !== null && entry.size !== spec.bytes) {
      fail(
        `${label}: ${spec.fileName} is listed in ${where} at ${entry.size} bytes, expected ${spec.bytes} — ` +
          'the payload carries a different file than the contracts declare',
      );
      continue;
    }
    ok(`${label}: ${entry.path} — ${entry.size} bytes — inside ${where}`);
  }
}

/** Print a survey of what a listing actually held, so a failure above is diagnosable from
 * the log alone rather than needing the artifact in hand. */
function describeListing(entries, where, limit = 12) {
  info(`${where}: ${entries.length} entries; largest ${Math.min(limit, entries.length)}:`);
  const sorted = [...entries].sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, limit);
  for (const entry of sorted) info(`  ${String(entry.size ?? '?').padStart(12)}  ${entry.path}`);
}

/** The portable .zip is a FLAT archive of the unpacked app — one `7z l` answers it. */
async function checkZipContents(sevenZip, zipPath, specs) {
  const name = path.basename(zipPath);
  const { stdout, error } = await run7z(sevenZip, ['l', '-slt', zipPath]);
  const entries = parseTechnicalListing(stdout);
  if (entries.length === 0) {
    fail(`models-in-zip: 7z listed no entries in ${name}${error ? ` (${error.message.split('\n')[0]})` : ''}`);
    return;
  }
  describeListing(entries, name);
  assertModelsInListing(entries, specs, { label: 'models-in-zip', where: name });
}

/** The .exe is NOT flat. Two layers: NSIS wrapper → nested app archive → the app's files.
 * Force the NSIS handler, find the nested archive, extract it, and list THAT. */
async function checkExeContents(sevenZip, exePath, specs) {
  const name = path.basename(exePath);

  const listing = await run7z(sevenZip, ['l', '-slt', '-tnsis', exePath]);
  const outerEntries = parseTechnicalListing(listing.stdout);
  if (outerEntries.length === 0) {
    fail(
      `models-in-exe: 7z could not list ${name} as an NSIS archive` +
        `${listing.error ? ` (${listing.error.message.split('\n')[0]})` : ''} — the installer is not the format this check assumes`,
    );
    return;
  }
  describeListing(outerEntries, `${name} (outer NSIS layer)`);

  // electron-builder embeds the whole app as a single `app-64.7z`. Prefer an entry that
  // looks like an archive; fall back to the largest entry, because a payload rename is a
  // packaging-config change, not a reason to stop being able to verify.
  const ranked = [...outerEntries].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  const nested = ranked.find((entry) => /\.(7z|zip|nsis7z)$/i.test(entry.path)) ?? ranked[0];
  info(
    `nested payload entry: ${nested.path} — ${nested.size ?? 'size not reported'} — this is the archive the app lives in. ` +
      'The models are one layer below it, which is why listing the .exe flat can never find them.',
  );

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kotiba-verify-'));
  try {
    // `x`, not `e`: keep the stored paths so the extracted file is identifiable. 7z can
    // exit non-zero over an NSIS script section it cannot decompile while still having
    // written every file correctly — so judge by what landed on disk, not by exit code.
    const extraction = await run7z(sevenZip, ['x', '-tnsis', '-y', `-o${tempDir}`, exePath]);
    const extracted = await largestFileUnder(tempDir);
    if (!extracted) {
      fail(
        `models-in-exe: extracting ${name} with the NSIS handler produced no files` +
          `${extraction.error ? ` (${extraction.error.message.split('\n')[0]})` : ''}`,
      );
      return;
    }
    info(`extracted payload: ${path.relative(tempDir, extracted.file)} — ${extracted.size} bytes`);

    const inner = await run7z(sevenZip, ['l', '-slt', extracted.file]);
    const innerEntries = parseTechnicalListing(inner.stdout);
    if (innerEntries.length === 0) {
      fail(
        `models-in-exe: the nested payload ${path.basename(extracted.file)} extracted from ${name} lists no entries` +
          `${inner.error ? ` (${inner.error.message.split('\n')[0]})` : ''}`,
      );
      return;
    }
    const where = `${path.basename(extracted.file)}, nested inside ${name}`;
    describeListing(innerEntries, where);
    assertModelsInListing(innerEntries, specs, { label: 'models-in-exe', where });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function largestFileUnder(dir) {
  let best = null;
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const { size } = await fs.stat(full);
        if (!best || size > best.size) best = { file: full, size };
      }
    }
  };
  await walk(dir);
  return best;
}

/** Accepts either a release DIRECTORY (dev/default use) or a path straight to the .exe
 * itself — t12's CI calls `verify-installer.mjs "$(cat installer-path.txt)"`, which is
 * the installer file, not its directory. Either way we end up with the release dir. */
async function resolveReleaseDir(arg) {
  if (!arg) return path.join(WINDOWS_ROOT, 'release');
  const resolved = path.resolve(arg);
  try {
    const st = await fs.stat(resolved);
    if (st.isFile()) return path.dirname(resolved);
    if (st.isDirectory()) return resolved;
  } catch {
    // Doesn't exist yet — treat as a directory path so the missing-artifact checks
    // below produce the right "does not exist" failure instead of a stat crash here.
  }
  return resolved;
}

async function main() {
  const releaseDir = await resolveReleaseDir(process.argv[2]);

  console.log(`verify-installer: checking ${path.relative(WINDOWS_ROOT, releaseDir)}/`);

  const specs = await loadBundledModelSpecs();

  const exePath = await checkArtifact(releaseDir, '.exe', 'installer');
  const zipPath = await checkArtifact(releaseDir, '.zip', 'portable zip');

  if (exePath) await checkSizeAccounting(exePath, 'installer', specs);
  if (zipPath) await checkSizeAccounting(zipPath, 'portable zip', specs);

  await checkUnpackedModels(releaseDir, specs);
  await checkNativeEngines(releaseDir);

  if (exePath || zipPath) {
    const sevenZip = await find7z();
    if (!sevenZip) {
      warn(
        'models-in-exe/zip: no 7z on this machine — skipping the archive listings. The size accounting above ' +
          'still ran, and win-unpacked was checked directly.',
      );
    } else {
      info(`7z: ${sevenZip}`);
      if (exePath) await checkExeContents(sevenZip, exePath, specs);
      if (zipPath) await checkZipContents(sevenZip, zipPath, specs);
    }
  }

  if (failures > 0) {
    console.error(`\nverify-installer: ${failures} check(s) failed. Not releasing this build.`);
    process.exit(1);
  }
  console.log('\nverify-installer: all checks passed.');
}

main().catch((err) => {
  console.error('verify-installer: unexpected failure:', err);
  process.exit(1);
});
