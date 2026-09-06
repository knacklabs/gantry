import { makeVitestConfig } from './vitest.shared.js';

export default makeVitestConfig({
  include: ['apps/core/test/integration/**/*.test.ts'],
  // Concurrent schema migrations against one database time out beforeAll hooks.
  fileParallelism: process.env.GANTRY_TEST_DATABASE_URL ? false : undefined,
});
