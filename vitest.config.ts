import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@myclaw/contracts': path.resolve(
        __dirname,
        'packages/contracts/src/index.ts',
      ),
    },
  },
  test: {
    include: [
      'apps/core/src/**/*.test.ts',
      'packages/contracts/src/**/*.test.ts',
    ],
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
