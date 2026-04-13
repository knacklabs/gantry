import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/core/src/**/*.test.ts', 'apps/core/setup/**/*.test.ts'],
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
