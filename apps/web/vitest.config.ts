import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['apps/web/src/**/*.test.ts'] },
});
