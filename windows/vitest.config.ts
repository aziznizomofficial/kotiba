import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Nine modules land here one at a time. A worktree in which only some of them
    // are implemented must still produce a green gate, so an empty run is not a
    // failure — the golden-parity suite is what asserts coverage, not the file count.
    passWithNoTests: true,
    reporters: ['default'],
  },
});
