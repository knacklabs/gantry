import { defineConfig } from 'vitest/config';

const forgeReporter = process.env.FORGE_JUNIT
  ? { reporters: [['junit', { addFileAttribute: true }]] }
  : {};

export default defineConfig({
  root: '../..',
  test: {
    include: ['apps/web/src/**/*.test.ts'],
    ...forgeReporter,
  },
});
