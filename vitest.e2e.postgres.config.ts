import { makeVitestConfig } from './vitest.shared.js';

// Postgres-backed e2e suite. Selection is by naming convention:
// <name>.postgres.e2e.test.ts. Runs serially (shared database).
export default makeVitestConfig({
  include: ['apps/core/test/e2e/**/*.postgres.e2e.test.ts'],
  fileParallelism: false,
});
