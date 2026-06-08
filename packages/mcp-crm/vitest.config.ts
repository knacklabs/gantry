import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Self-contained test config so the package runs independently of the root
// Gantry vitest setup. Keeps boondi-crm a clean, separately-testable unit.
export default defineConfig({
  resolve: {
    alias: {
      '@gantry/credential-crypto': path.resolve(
        __dirname,
        '../credential-crypto/src/index.ts',
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
