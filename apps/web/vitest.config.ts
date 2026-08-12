import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  resolve: {
    alias: {
      '@gantry/sdk': fileURLToPath(
        new URL('../../packages/sdk/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['apps/web/src/**/*.test.ts', 'apps/web/server/**/*.test.ts'],
  },
});
