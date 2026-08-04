import { makeVitestConfig } from './vitest.shared.js';

// Packaged-runtime agent E2E gate scenarios (hermetic lane). Serial: every
// scenario boots the built runtime against its own disposable database.
// Requires GANTRY_TEST_DATABASE_URL (throwaway admin URL) + a built dist/.
export default makeVitestConfig({
  include: ['apps/core/test/agent-e2e/scenarios/**/*.agent-e2e.test.ts'],
  fileParallelism: false,
});
