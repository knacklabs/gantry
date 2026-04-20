import { makeVitestConfig } from './vitest.shared.js';

export default makeVitestConfig({
  include: ['apps/core/test/e2e/**/*.test.ts'],
});
