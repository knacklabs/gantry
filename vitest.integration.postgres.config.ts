import { makeVitestConfig } from './vitest.shared.js';

// Postgres-backed integration suite. Selection is by naming convention:
// <name>.postgres.integration.test.ts. Runs serially (shared database).
export default makeVitestConfig({
  include: ['apps/core/test/integration/**/*.postgres.integration.test.ts'],
  exclude: [
    // Runs under test:integration:postgres:chaos (own config).
    '**/fleet-capability-chaos-combo.postgres.integration.test.ts',
    // Hot-path explain suite: test:integration:postgres:hot-path (own config).
    '**/*-explain.postgres.integration.test.ts',
    // ponytail: these match the convention but were never in the old
    // hard-coded script list and have never run in CI with a live database.
    // Excluded to keep this refactor behavior-preserving; delete a line here
    // to deliberately adopt that suite into CI.
    '**/live-waiting-admission.postgres.integration.test.ts',
    '**/pattern-candidate-atomic-claim.postgres.integration.test.ts',
    '**/proactive-surfacing-opt-in.postgres.integration.test.ts',
    '**/toolchain-bake-reconciler.postgres.integration.test.ts',
    '**/worker-coordination.postgres.integration.test.ts',
  ],
  fileParallelism: false,
});
