import { makeVitestConfig } from './vitest.shared.js';

// Protected real-tenant lane. Never included in the hermetic PR suite.
export default makeVitestConfig({
  include: ['apps/core/test/agent-e2e/scenarios/**/*.agent-e2e.live.test.ts'],
  fileParallelism: false,
});
