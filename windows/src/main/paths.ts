// Where things are on disk, from the main process's point of view.
//
// Uses Node, deliberately not Electron: `--check` runs headless and must resolve the
// same paths without `app` existing. Where an Electron answer is better — the packaged
// resources directory — `process.resourcesPath` is read off `process` rather than
// imported, so this file stays runnable outside Electron.
//
// ---------------------------------------------------------------------------------
// A RESOLVER THAT FINDS NOTHING MUST SAY WHERE IT LOOKED
// ---------------------------------------------------------------------------------
//
// The macOS app shipped "no engine is configured" with no list of paths behind it, and
// that one missing sentence is what made the bug expensive: the message named a
// conclusion and never named the evidence, so every investigation started over.
//
// So every lookup here is a SEARCH over an ordered candidate list, it returns the list
// it tried alongside the answer, and a caller handed `null` can print exactly which
// paths were probed. `describeResourceSearch` exists for that and for nothing else.
//
// The candidate lists are not guesses. They are the two layouts this code actually runs
// under, and they disagree:
//
//   packed  `process.resourcesPath` = <install dir>\resources
//             models  → resources\models      (electron-builder.yml `to: models`)
//             helpers → resources\native\     (electron-builder.yml `to: native`)
//   dev     `dist/src/main/*.js`, three levels under `windows/`
//             models  → windows\fixtures\models    (fetch-models.mjs `--dest`)
//             helpers → windows\resources\native\  (cmake `--install --prefix`)
//
// `__dirname`, `cwd` and `app.getAppPath()` are each right for exactly one of those and
// wrong for the other, which is why none of them is used alone. In particular the old
// `resourcesDirectory()` joined the helper names straight onto the resources root, so
// the packed app looked for `resources\kotiba-stt.exe` while the installer had put it at
// `resources\native\kotiba-stt.exe`.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIAGNOSTICS_FILE_NAME,
  HISTORY_FILE_NAME,
  MODELS_DIRECTORY_NAME,
  SETTINGS_FILE_NAME,
  SETTINGS_UNREADABLE_FILE_NAME,
  SUPPORT_DIRECTORY_NAME,
} from '../contracts/index.js';
import type { KotibaPaths } from '../core/settings/index.js';
import { kotibaPaths } from '../core/settings/index.js';

// ---------------------------------------------------------------------------------
// DELIBERATE AND LOAD-BEARING. Nothing imports a preload at RUNTIME — Electron loads it
// by path into a renderer — so without this line `preload.mts` is in no `tsc` program,
// `dist/src/main/preload.mjs` is never emitted, and every window comes up with no bridge
// at all. The import is type-only and erased; it exists to put the file in the build.
//
// `test/main/preload.test.ts` builds the tree and asserts the emit, so deleting this
// fails the gate rather than shipping four dead windows.
// ---------------------------------------------------------------------------------
import type { PreloadedBridge } from './preload.mjs';

/** What `preload.mjs` puts on `window.kotiba`. Re-exported so the import above is a use. */
export type { PreloadedBridge };

/** The three helper processes the installer ships beside the executable (D-W7, D-W4). */
export const HELPER_EXECUTABLES = {
  stt: 'kotiba-stt.exe',
  hook: 'kotiba-hook.exe',
  input: 'kotiba-input.exe',
} as const;

/**
 * THE LAYOUT, from `src/core/settings/paths.ts` — the tested one.
 *
 * This file used to build its own, and it put ALL FOUR files under `%APPDATA%\Kotiba`.
 * `kotibaPaths` deliberately splits them: the settings blob and the models directory
 * roam (`%APPDATA%`, so a domain user's configuration follows them to another machine),
 * while history and diagnostics do not (`%LOCALAPPDATA%`). That is not a preference —
 * a domain profile syncs `%APPDATA%` at every logoff, and a history file that grows with
 * use plus a 2 MB diagnostics log is exactly what turns a sign-out into a five-minute
 * wait. Two modules answering the same question differently is how the app writes
 * history to one path and the pane reads it from another.
 *
 * `kotibaPaths` also builds BACKSLASH strings by hand rather than with `node:path`,
 * because every developer here is on a Mac and a `path.join` result would be asserted
 * with forward slashes and shipped with backslashes (D-W10).
 *
 * The POSIX fallback is for this machine and the Linux gate runner, and for nothing
 * else: `kotibaPaths` throws only when neither `%APPDATA%`/`%LOCALAPPDATA%` nor
 * `%USERPROFILE%` nor `%HOMEDRIVE%`+`%HOMEPATH%` is set, which on a real Windows session
 * cannot happen. A Mac has none of them, and the app still has to be runnable here.
 */
export function kotibaDirectories(
  env: NodeJS.ProcessEnv = process.env,
  directoryName: string = SUPPORT_DIRECTORY_NAME,
): KotibaPaths {
  try {
    return kotibaPaths(env, directoryName);
  } catch {
    const home = env['HOME'] ?? env['USERPROFILE'] ?? '.';
    const root = join(home, `.${directoryName.toLowerCase()}`);
    return {
      roamingDirectory: root,
      localDirectory: root,
      settingsFile: join(root, SETTINGS_FILE_NAME),
      settingsUnreadableFile: join(root, SETTINGS_UNREADABLE_FILE_NAME),
      modelsDirectory: join(root, MODELS_DIRECTORY_NAME),
      historyFile: join(root, HISTORY_FILE_NAME),
      diagnosticsFile: join(root, DIAGNOSTICS_FILE_NAME),
    };
  }
}

/**
 * `%APPDATA%\Kotiba` — the settings blob and the models directory.
 *
 * Deliberately roaming and deliberately not a package container: models live under it
 * and a user drops a newer one in by hand.
 */
export function supportDirectory(env?: NodeJS.ProcessEnv): string {
  return kotibaDirectories(env).roamingDirectory;
}

/** `%LOCALAPPDATA%\Kotiba` — history and diagnostics. What `diagnostics:reveal` opens. */
export function localDirectory(env?: NodeJS.ProcessEnv): string {
  return kotibaDirectories(env).localDirectory;
}

export function modelsDirectory(env?: NodeJS.ProcessEnv): string {
  return kotibaDirectories(env).modelsDirectory;
}

export function historyPath(env?: NodeJS.ProcessEnv): string {
  return kotibaDirectories(env).historyFile;
}

export function diagnosticsPath(env?: NodeJS.ProcessEnv): string {
  return kotibaDirectories(env).diagnosticsFile;
}

// ---------------------------------------------------------------------------------
// The resource search
// ---------------------------------------------------------------------------------

/** The answer, and the evidence behind it. `path === null` means every candidate missed. */
export interface ResourceSearch {
  /** The first candidate that exists, or `null`. */
  readonly path: string | null;
  /** Every candidate probed, in order, whether it hit or missed. */
  readonly tried: readonly string[];
  /** What was being looked for, for the log line. */
  readonly what: string;
}

/** `process.resourcesPath` when Electron set it, else `null`. Read, never imported. */
export function electronResourcesPath(): string | null {
  const value = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `dist/src/main/` → `windows/`. The dev-run anchor, and independent of `cwd`. */
function sourceTreeRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * Every directory that could plausibly hold shipped resources, best first.
 *
 * The packed answer is first because it is authoritative when it exists; the dev
 * answers follow so a plain `npm run build` checkout finds the same files. `cwd` is
 * LAST and is here only because running from `windows/` is a real case — it is never
 * trusted ahead of a path anchored to the code itself, since `cwd` is whatever the
 * shortcut, the installer or the CI step happened to leave it as.
 */
export function resourceRoots(): readonly string[] {
  const roots: string[] = [];
  const packed = electronResourcesPath();
  if (packed !== null) roots.push(packed);
  const source = sourceTreeRoot();
  roots.push(source, join(source, 'resources'));
  roots.push(process.cwd(), join(process.cwd(), 'resources'));

  const seen = new Set<string>();
  return roots.filter((root) => {
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
}

/**
 * The first `<root>/<relative>` that exists, plus every path probed on the way.
 *
 * Existence and nothing more: whether a model file is INTACT is `inspectModelFile`'s
 * question, asked by the component that knows, and answering it here too would be a
 * second copy of a judgement that must have exactly one.
 */
export function findResource(what: string, relatives: readonly string[]): ResourceSearch {
  const tried: string[] = [];
  for (const root of resourceRoots()) {
    for (const relative of relatives) {
      const candidate = join(root, relative);
      tried.push(candidate);
      if (existsSync(candidate)) return { path: candidate, tried, what };
    }
  }
  return { path: null, tried, what };
}

/**
 * The sentence a caller prints for a search.
 *
 * Multi-line and exhaustive on purpose. This is the message whose absence on macOS cost
 * days, so it names the thing, the count, and every path in probe order.
 */
export function describeResourceSearch(search: ResourceSearch): string {
  const head =
    search.path === null
      ? `${search.what}: NOT FOUND — looked in ${String(search.tried.length)} place(s):`
      : `${search.what}: found at ${search.path} — probed ${String(search.tried.length)}:`;
  return [head, ...search.tried.map((path) => `    ${path}`)].join('\n');
}

// ---------------------------------------------------------------------------------
// The resources themselves
// ---------------------------------------------------------------------------------

/**
 * Where the installer put the bundled models (D-W3 — all three, ~1.17 GB).
 *
 * `models` is what `extraResources.to` lands as in the packed app. `fixtures/models` is
 * where `scripts/fetch-models.mjs --dest` stages them before packaging, and is the only
 * copy a dev tree has.
 */
export function bundledModelsSearch(): ResourceSearch {
  return findResource('bundled models directory', [
    MODELS_DIRECTORY_NAME,
    join('fixtures', MODELS_DIRECTORY_NAME),
  ]);
}

/**
 * The bundled models directory, or the FIRST candidate when none exists.
 *
 * Never the empty string: `createModelStore` reads an empty `bundledDirectory` as "do
 * not look there at all", which would turn a missing directory into a silently narrower
 * search instead of a search that reports a miss.
 */
export function bundledModelsDirectory(): string {
  const search = bundledModelsSearch();
  return search.path ?? search.tried[0] ?? join(sourceTreeRoot(), MODELS_DIRECTORY_NAME);
}

/** The committed WAV corpus `--check` runs over. */
export function fixturesAudioSearch(): ResourceSearch {
  return findResource('audio fixtures directory', [join('fixtures', 'audio')]);
}

/**
 * C4: the standard 3 s Arabic clip Cohere's first-run speed check decodes (`src/engines/
 * arabic.ts`). `audio/` in the packed app (`extraResources`), `fixtures/audio/` in a dev tree.
 */
export function arabicSpeedClipSearch(): ResourceSearch {
  return findResource('Arabic speed-check clip', [
    join('audio', ARABIC_SPEED_CLIP_NAME),
    join('fixtures', 'speed-check', ARABIC_SPEED_CLIP_NAME),
  ]);
}

export const ARABIC_SPEED_CLIP_NAME = 'arabic-speed-check.wav';

export function fixturesAudioDirectory(): string {
  const search = fixturesAudioSearch();
  return search.path ?? search.tried[0] ?? join(sourceTreeRoot(), 'fixtures', 'audio');
}

/**
 * A native helper.
 *
 * `native/<name>` first, because that is `extraResources.to` in the packed app AND the
 * `cmake --install --prefix resources/native` layout in a dev tree — the same relative
 * shape under two different roots, which is exactly what the root list is for. The bare
 * `<name>` follows only as a courtesy to a hand-assembled directory; nothing in this
 * repository produces that layout.
 */
export function helperSearch(name: string): ResourceSearch {
  return findResource(`helper ${name}`, [join('native', name), name]);
}

function helperPath(name: string): string {
  const search = helperSearch(name);
  return search.path ?? search.tried[0] ?? join(sourceTreeRoot(), 'native', name);
}

export function hostExecutablePath(): string {
  return helperPath(HELPER_EXECUTABLES.stt);
}

export function hookExecutablePath(): string {
  return helperPath(HELPER_EXECUTABLES.hook);
}

export function inputExecutablePath(): string {
  return helperPath(HELPER_EXECUTABLES.input);
}

/**
 * Every resource search, as one block of prose, hit or miss.
 *
 * `--check` prints this on EVERY run and not only on failure. A path table that appears
 * only once something is already broken is a table nobody has ever seen working, so
 * nobody can tell an unusual path from a normal one at the moment it matters.
 */
export function describeAllResources(): string {
  return [
    'resource roots, in probe order:',
    ...resourceRoots().map((root) => `    ${root}`),
    describeResourceSearch(bundledModelsSearch()),
    describeResourceSearch(fixturesAudioSearch()),
    describeResourceSearch(helperSearch(HELPER_EXECUTABLES.stt)),
    describeResourceSearch(helperSearch(HELPER_EXECUTABLES.hook)),
    describeResourceSearch(helperSearch(HELPER_EXECUTABLES.input)),
  ].join('\n');
}

/**
 * The renderer HTML, always in the directory holding its own script.
 *
 * `tsc` emits the `.ts` and ignores the `.html` and `.css` beside it, and `package.json`
 * is frozen (t01 only) so no copy step can be added to `npm run build`. The packager does
 * it — `electron-builder.yml` lands `src/renderer/*.{html,css}` at `dist/src/renderer/` —
 * and a plain `npm run build` in a checkout does not, which is what the copy below is for.
 *
 * THE SUBTLETY THAT MAKES THIS MORE THAN A LOOKUP. Every page loads its script as a
 * SIBLING: `main.html` loads `./main.js` by `src`. Those
 * scripts are `tsc` output in `dist/src/renderer/`. Returning the page from the SOURCE
 * tree — which is what the old fallback did — hands the window a document whose only
 * script resolves against a directory that has never contained it. The window opens, the
 * import 404s, and the page stays blank with the explanation in a console nobody can see.
 *
 * So the source copy is never returned as-is. It is copied next to the scripts first, and
 * the copy is what the window loads. In a packaged app the packager has already put it
 * there and nothing is written — the asar is read-only, and a failed copy falls back to
 * the source page rather than taking the app down over it.
 */
export function rendererFile(name: 'main' | 'hud'): string {
  const emitted = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer', `${name}.html`);
  if (existsSync(emitted)) return emitted;

  // dist/src/main/ → ../../../src/renderer/
  const source = join(sourceTreeRoot(), 'src', 'renderer', `${name}.html`);
  try {
    mkdirSync(dirname(emitted), { recursive: true });
    // The stylesheet travels with the page for the same reason: `<link href="style.css">`
    // is resolved relative to the document.
    const styles = join(sourceTreeRoot(), 'src', 'renderer', 'style.css');
    if (existsSync(styles)) copyFileSync(styles, join(dirname(emitted), 'style.css'));
    copyFileSync(source, emitted);
    return emitted;
  } catch {
    // Read-only tree. The page will be missing its script, which is worse than this
    // function can fix — but a path that exists beats a path that does not.
    return source;
  }
}

/**
 * The preload script, emitted by `tsc` beside this file.
 *
 * `.mjs`, AND THE EXTENSION IS THE WHOLE POINT. Electron ignores `package.json`'s
 * `"type": "module"` when it loads a preload: anything not ending in `.mjs` is run as
 * CommonJS. The `tsc` emit is ESM, so pointing this at `preload.js` — which is what it
 * did — threw `SyntaxError: Cannot use import statement outside a module` inside every
 * renderer, `window.kotiba` was never defined, and `renderer/bridge.ts` threw 'the
 * preload bridge is missing' on the first `invoke` in all four windows.
 *
 * The source is `preload.mts`, which is how `tsc` is told to emit `.mjs` without a
 * bundler and without touching the frozen `package.json`. `test/main/preload.test.ts`
 * builds the tree and asserts this file is really there.
 */
export function preloadScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), PRELOAD_FILE_NAME);
}

/** The one place the preload's file name is written. Read by the packaging test too. */
export const PRELOAD_FILE_NAME = 'preload.mjs';
