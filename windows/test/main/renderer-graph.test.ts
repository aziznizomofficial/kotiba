// The pages run in a browser, over `file://`, with no bundler. Every module they reach —
// directly or through `src/main/*-model.ts`, `src/core` and `src/contracts` — must be
// loadable there: relative imports only, no `electron`, no `node:*`, no bare package
// name (`zod` resolves in Node and 404s in a page). A violation does not fail a build; it
// opens a blank window with the reason in a console nobody sees. So the graph is walked
// here, from the two entry points, and every edge is checked.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/gu;

function walk(entry: string): { files: Set<string>; violations: string[] } {
  const files = new Set<string>();
  const violations: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? '';
      // Type-only imports are erased and cannot fail at runtime.
      const line = match[0];
      if (/\bimport\s+type\b|\bexport\s+type\b/u.test(line)) continue;
      if (!specifier.startsWith('.')) {
        violations.push(`${file.slice(root.length + 1)} imports '${specifier}'`);
        continue;
      }
      const target = resolve(dirname(file), specifier.replace(/\.js$/u, '.ts'));
      if (!existsSync(target)) {
        violations.push(`${file.slice(root.length + 1)} imports missing '${specifier}'`);
        continue;
      }
      queue.push(target);
    }
  }
  return { files, violations };
}

describe('what the pages can load', () => {
  for (const entry of ['main', 'hud']) {
    it(`${entry}.ts reaches only relative, browser-loadable modules`, () => {
      const { files, violations } = walk(join(root, 'src', 'renderer', `${entry}.ts`));
      expect(violations).toEqual([]);
      // And it really walked something — a regex that matched nothing would pass above.
      expect(files.size).toBeGreaterThan(entry === 'main' ? 15 : 5);
    });
  }
});
