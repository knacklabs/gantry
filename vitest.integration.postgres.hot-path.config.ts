import { makeVitestConfig } from './vitest.shared.js';

// Postgres hot-path EXPLAIN suite. Naming convention:
// <name>-explain.postgres.integration.test.ts. Tests additionally gate on
// GANTRY_POSTGRES_HOT_PATH=1 (set by the npm script).
export default makeVitestConfig({
  include: [
    'apps/core/test/integration/**/*-explain.postgres.integration.test.ts',
  ],
  fileParallelism: false,
});
