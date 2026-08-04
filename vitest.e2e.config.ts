import { makeVitestConfig } from './vitest.shared.js';

export default makeVitestConfig({
  include: ['apps/core/test/e2e/**/*.test.ts'],
  // Postgres-backed e2e tests run via test:e2e:postgres (vitest.e2e.postgres.config.ts).
  exclude: ['**/*.postgres.e2e.test.ts'],
});
