import { makeVitestConfig } from './vitest.shared.js';

export default makeVitestConfig({
  include: [
    'apps/core/test/unit/**/*.test.ts',
    'packages/contracts/test/unit/**/*.test.ts',
    'apps/core/test/integration/**/*.test.ts',
  ],
  withCoverage: true,
});
