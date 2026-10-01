// Where the packaged app looks for the things the installer put beside it.
//
// This is the file that would have caught the defect in run 32240326275's neighbourhood:
// `electron-builder.yml` lands the three helper executables at `resources\native\`, and
// the old `hostExecutablePath()` joined the bare filename onto the resources root — so a
// packed app looked for `resources\kotiba-stt.exe`, found nothing, and said so with no
// mention of any path at all.
//
// The searches are driven through a real temporary directory rather than a mock, because
// the thing under test IS the filesystem layout: a mocked `existsSync` would agree with
// whatever this file asserted and prove nothing about where electron-builder puts files.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HELPER_EXECUTABLES,
  describeResourceSearch,
  findResource,
  helperSearch,
  resourceRoots,
} from '../../src/main/paths.js';

/** The packed layout, as `extraResources` produces it. */
function packedResources(): string {
  const root = mkdtempSync(join(tmpdir(), 'kotiba-resources-'));
  mkdirSync(join(root, 'models'), { recursive: true });
  mkdirSync(join(root, 'native'), { recursive: true });
  writeFileSync(join(root, 'native', HELPER_EXECUTABLES.stt), 'not really an exe');
  writeFileSync(join(root, 'models', 'ggml-base.bin'), 'not really a model');
  return root;
}

// `@types/node` (with Electron's augmentation) declares `resourcesPath` as a required
// string, so it cannot be `delete`d through that type. The test needs BOTH states — set
// and absent — because "absent" is what a dev run and the vitest process itself have.
const mutableProcess = process as unknown as Record<string, unknown>;

let created: string[] = [];
let hadResourcesPath = false;
let previous: unknown;

beforeEach(() => {
  created = [];
  hadResourcesPath = 'resourcesPath' in process;
  previous = mutableProcess['resourcesPath'];
});

afterEach(() => {
  if (hadResourcesPath) {
    mutableProcess['resourcesPath'] = previous;
  } else {
    delete mutableProcess['resourcesPath'];
  }
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

function packed(): string {
  const root = packedResources();
  created.push(root);
  mutableProcess['resourcesPath'] = root;
  return root;
}

describe('the packed layout', () => {
  it('THE REGRESSION: finds a helper under resources/native, not resources/', () => {
    const root = packed();
    const search = helperSearch(HELPER_EXECUTABLES.stt);
    expect(search.path).toBe(join(root, 'native', HELPER_EXECUTABLES.stt));
  });

  it('puts process.resourcesPath first, ahead of every dev-tree guess', () => {
    const root = packed();
    expect(resourceRoots()[0]).toBe(root);
  });

  it('falls back to the source tree when Electron set no resourcesPath', () => {
    delete mutableProcess['resourcesPath'];
    // Not `cwd`: the anchor has to be the code's own location, because a shortcut, an
    // installer and a CI step each leave `cwd` somewhere different.
    expect(resourceRoots()).not.toHaveLength(0);
    expect(resourceRoots()[0]).not.toBe(process.cwd());
  });
});

describe('a search that finds nothing says where it looked', () => {
  it('records every candidate, in probe order', () => {
    packed();
    const search = findResource('a thing that is not there', ['definitely-absent']);
    expect(search.path).toBeNull();
    expect(search.tried.length).toBe(resourceRoots().length);
    for (const [index, root] of resourceRoots().entries()) {
      expect(search.tried[index]).toBe(join(root, 'definitely-absent'));
    }
  });

  it('THE MESSAGE: the description names the thing and every path tried', () => {
    packed();
    const search = findResource('bundled models directory', ['definitely-absent']);
    const text = describeResourceSearch(search);

    // "no engine is configured" with no list of paths behind it is the message that made
    // this class of bug expensive on macOS. Every probed path must be in the prose.
    expect(text).toContain('bundled models directory');
    expect(text).toContain('NOT FOUND');
    for (const path of search.tried) expect(text).toContain(path);
  });

  it('a search that HIT still lists its probes, so a normal run is legible', () => {
    const root = packed();
    const text = describeResourceSearch(helperSearch(HELPER_EXECUTABLES.stt));
    expect(text).toContain(join(root, 'native', HELPER_EXECUTABLES.stt));
    expect(text).not.toContain('NOT FOUND');
  });
});
