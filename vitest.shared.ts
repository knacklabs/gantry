import path from 'path';
import { defineConfig } from 'vitest/config';

interface VitestConfigOptions {
  include: string[];
  exclude?: string[];
  withCoverage?: boolean;
}

export function makeVitestConfig(options: VitestConfigOptions) {
  const { exclude, include, withCoverage = false } = options;
  const testConfig: {
    exclude?: string[];
    include: string[];
    setupFiles?: string[];
    testTimeout?: number;
    coverage?: {
      provider: 'v8';
      reporter: string[];
      reportOnFailure: boolean;
      include: string[];
      exclude: string[];
    };
  } = {
    exclude,
    include,
    setupFiles: ['apps/core/test/setup/runtime-env.ts'],
    testTimeout: 30_000,
  };

  if (withCoverage) {
    testConfig.coverage = {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      reportOnFailure: true,
      include: ['apps/core/src/**/*.ts', 'packages/contracts/src/**/*.ts'],
      exclude: [
        'apps/core/src/**/index.ts',
        'apps/core/src/**/*-types.ts',
        'apps/core/src/**/types.ts',
        'apps/core/test/**',
        'packages/contracts/test/**',
      ],
    };
  }

  return defineConfig({
    resolve: {
      alias: {
        '@gantry/contracts': path.resolve(
          __dirname,
          'packages/contracts/src/index.ts',
        ),
        '@core': path.resolve(__dirname, 'apps/core/src'),
        '@contracts-src': path.resolve(__dirname, 'packages/contracts/src'),
        '@agent-runner-src': path.resolve(
          __dirname,
          'apps/core/src/runner',
        ),
      },
    },
    test: testConfig,
  });
}
