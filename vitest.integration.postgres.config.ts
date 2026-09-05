import { makeVitestConfig } from './vitest.shared.js';

// Postgres-backed integration suite. Selection is by naming convention:
// <name>.postgres.integration.test.ts. Runs serially (shared database).
//
// One config, three lanes, selected by GANTRY_POSTGRES_LANE (set by the npm
// scripts): default sweep, "chaos" (long-running destructive combo suite),
// "hot-path" (explain suites, paired with GANTRY_POSTGRES_HOT_PATH=1).
const lane = process.env.GANTRY_POSTGRES_LANE ?? 'default';

export default makeVitestConfig({
  include:
    lane === 'chaos'
      ? [
          'apps/core/test/integration/fleet-capability-chaos-combo.postgres.integration.test.ts',
        ]
      : lane === 'hot-path'
        ? ['apps/core/test/integration/**/*-explain.postgres.integration.test.ts']
        : ['apps/core/test/integration/**/*.postgres.integration.test.ts'],
  exclude:
    lane === 'default'
      ? [
          '**/fleet-capability-chaos-combo.postgres.integration.test.ts', // chaos lane
          '**/*-explain.postgres.integration.test.ts', // hot-path lane
          // ponytail: these match the convention but were never in the old
          // hard-coded script list and have never run in CI with a live
          // database. Excluded to keep behavior; delete a line to adopt one.
          // (live-waiting-admission adopted by Q-0154 once its query was fixed.)
          '**/pattern-candidate-atomic-claim.postgres.integration.test.ts',
          '**/toolchain-bake-reconciler.postgres.integration.test.ts',
          '**/worker-coordination.postgres.integration.test.ts',
        ]
      : [],
  fileParallelism: false,
});
