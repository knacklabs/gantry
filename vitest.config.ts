import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/core/src/**/*.test.ts',
      'packages/agent-runner/src/**/*.test.ts',
    ],
    // Some tests share process-global mocks and host-runtime paths; running
    // files in parallel makes the suite flaky even when each file passes in
    // isolation. Keep deterministic verify stable by running test files
    // serially.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      reportOnFailure: true,
      include: ['apps/core/src/**/*.ts'],
      exclude: [
        'apps/core/src/**/*.test.ts',
        'apps/core/src/**/index.ts',
        'apps/core/src/**/*-types.ts',
        'apps/core/src/**/types.ts',
      ],
    },
  },
});
