import { defineConfig } from 'vitest/config';

// Self-contained test config so the package runs independently of the root
// Gantry vitest setup. Without a local config, vitest walks up to the repo
// root vitest.config.ts (whose include globs target apps/core) and finds no
// tests here. Keeps @gantry/credential-crypto a clean, separately-testable
// leaf; tests import ../src/index.js directly so no aliases are needed.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
