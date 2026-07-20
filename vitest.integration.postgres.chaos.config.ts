import { makeVitestConfig } from './vitest.shared.js';

// Chaos combo suite: long-running, destructive; kept out of the main
// postgres integration run.
export default makeVitestConfig({
  include: [
    'apps/core/test/integration/fleet-capability-chaos-combo.postgres.integration.test.ts',
  ],
  fileParallelism: false,
});
