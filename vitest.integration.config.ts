import { makeVitestConfig } from './vitest.shared.js';

export default makeVitestConfig({
  include: ['apps/core/test/integration/**/*.test.ts'],
});
