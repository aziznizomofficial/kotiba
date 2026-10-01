// The preload has to EXIST, in the BUILD OUTPUT, with the extension Electron accepts.
//
// This is the test that would have caught the shipped defect. `src/main/preload.ts` was
// emitted by `tsc` as `dist/src/main/preload.js` holding ESM `import` syntax, and
// `paths.ts` pointed four `BrowserWindow`s at it. **Electron ignores `package.json`'s
// `"type": "module"` for preload scripts**: anything not ending in `.mjs` is loaded as
// CommonJS, so every window threw `SyntaxError: Cannot use import statement outside a
// module` before a line of page code ran, `window.kotiba` was never defined, and
// `renderer/bridge.ts:23` threw 'kotiba: the preload bridge is missing' on the first
// `invoke`. Settings, the HUD, onboarding and the audio page were all dead.
//
// Nothing in the old suite could see it: `--check` never opens a window, the renderer
// tests import `bridge.ts` directly, and a typecheck is perfectly happy with a file that
// Electron will refuse to parse.
//
// So this compiles the real tree with the real `tsconfig.json` and asserts against what
// lands on disk. A mocked filesystem would agree with whatever this file claimed and
// prove nothing about what `tsc` actually emits — and what `tsc` emits is the entire
// question.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PRELOAD_FILE_NAME, preloadScript } from '../../src/main/paths.js';

/** `windows/`, from this file. */
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let out: string;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'kotiba-preload-build-'));
  // The real compiler with the real config, only redirected. `--sourceMap false` keeps
  // the build to what is being asserted about.
  execFileSync(
    process.execPath,
    [
      join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project',
      join(projectRoot, 'tsconfig.json'),
      '--outDir',
      out,
      '--sourceMap',
      'false',
    ],
    { cwd: projectRoot, stdio: 'pipe' },
  );
}, 120_000);

afterAll(() => {
  if (out !== undefined) rmSync(out, { recursive: true, force: true });
});

describe('the preload the windows actually load', () => {
  const emitted = (): string => join(out, 'src', 'main', PRELOAD_FILE_NAME);

  it('is emitted by a plain `npm run build`', () => {
    // NOT `preload.js`. If this ever fails because the file is named `.js`, the app is
    // shipping four windows with no bridge — that is the whole bug, restored.
    expect(existsSync(emitted())).toBe(true);
  });

  it('has the extension Electron will parse as ESM', () => {
    // Electron only treats a preload as ESM when the file name ends in `.mjs`. A `.js`
    // preload is run as CommonJS whatever `package.json` says, and this one is ESM.
    expect(PRELOAD_FILE_NAME.endsWith('.mjs')).toBe(true);
    expect(basename(preloadScript())).toBe(PRELOAD_FILE_NAME);
  });

  it('is what `preloadScript()` points the windows at', () => {
    // `preloadScript()` resolves beside its own module, which in the build output is
    // `<out>/src/main/`. Same directory, same basename — so the path the windows are
    // handed is the file that exists.
    expect(basename(preloadScript())).toBe(basename(emitted()));
    expect(basename(dirname(preloadScript()))).toBe(basename(dirname(emitted())));
  });

  it('really is ESM, so the `.mjs` is not decoration', () => {
    const source = readFileSync(emitted(), 'utf8');
    // A CommonJS emit would have `require(` and `exports.` and no bare `import`.
    expect(source).toMatch(/^import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it('exposes both bridges the renderers read', () => {
    const source = readFileSync(emitted(), 'utf8');
    // `renderer/bridge.ts` reads `window.kotiba`; `renderer/audio-host.ts:33` reads
    // `window.kotibaAudio`. A preload that exposes only the first leaves the hidden
    // capture page unable to post a single frame.
    expect(source).toContain("exposeInMainWorld('kotiba'");
    expect(source).toContain("exposeInMainWorld('kotibaAudio'");
  });
});

describe('the pages the windows load', () => {
  const PAGES = ['main', 'hud'] as const;

  it('each load their script as a SIBLING, which is what fixes their location', () => {
    // The constraint the packaging rests on, asserted from the pages themselves rather
    // than assumed: `main.html` loads `./main.js` by `src` (never inline — `script-src
    // 'self'` refuses an inline script, which is how the 0.2.0 pages would have opened blank).
    // A relative sibling import means the page has to sit in the directory holding the
    // `tsc` output, and nowhere else — a page copied to `<asar>/src/renderer/` resolves
    // `./settings.js` against a directory that has never contained it, so the window
    // opens blank with a 404 in a console nobody can see.
    for (const page of PAGES) {
      const html = readFileSync(join(projectRoot, 'src', 'renderer', `${page}.html`), 'utf8');
      expect(html).toContain(`src="./${page}.js"`);
      // And nothing inline: the page's own policy would refuse it.
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/u);
      expect(html).toContain('href="style.css"');
    }
  });

  it('are compiled to the directory their pages have to sit in', () => {
    // `tsc` puts the SCRIPTS here. Everything else in this describe is about getting the
    // pages to the same place.
    for (const page of PAGES) {
      expect(existsSync(join(out, 'src', 'renderer', `${page}.js`))).toBe(true);
    }
    // And `tsc` does NOT bring the pages: it emits the `.ts` beside a `.html` and ignores
    // the `.html`. That is the gap the packager and `rendererFile()` each close.
    expect(existsSync(join(out, 'src', 'renderer', 'main.html'))).toBe(false);
  });

  it('are landed there by the packager, not merely somewhere in the package', () => {
    // The half-fix that looks right and ships blank windows: putting the pages at
    // `<asar>/src/renderer/`, which is where `rendererFile()`'s FALLBACK looks but is not
    // where the scripts are. `to:` has to name the compiled directory.
    const builder = readFileSync(join(projectRoot, 'electron-builder.yml'), 'utf8');
    expect(builder).toMatch(/from:\s*src\/renderer/);
    expect(builder).toMatch(/to:\s*dist\/src\/renderer/);
  });

  it('are copied beside their scripts when the packager has not been near them', () => {
    // A plain `npm run build` in a checkout. `rendererFile()` copies the page and the
    // stylesheet it links into the compiled directory and returns the copy, so a dev run
    // loads a page whose `./settings.js` resolves.
    const compiled = join(out, 'src', 'renderer');
    for (const page of PAGES) {
      copyFileSync(join(projectRoot, 'src', 'renderer', `${page}.html`), join(compiled, `${page}.html`));
    }
    copyFileSync(join(projectRoot, 'src', 'renderer', 'style.css'), join(compiled, 'style.css'));

    for (const page of PAGES) {
      expect(existsSync(join(compiled, `${page}.html`))).toBe(true);
      expect(existsSync(join(compiled, `${page}.js`))).toBe(true);
      expect(existsSync(join(compiled, 'style.css'))).toBe(true);
    }
  });
});
