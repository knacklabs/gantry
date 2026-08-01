import path from 'path';
import { defineConfig } from 'vitest/config';

interface VitestConfigOptions {
  include: string[];
  exclude?: string[];
  fileParallelism?: boolean;
  withCoverage?: boolean;
}

export function makeVitestConfig(options: VitestConfigOptions) {
  const { exclude, fileParallelism, include, withCoverage = false } = options;
  const testConfig: {
    exclude?: string[];
    fileParallelism?: boolean;
    include: string[];
    setupFiles?: string[];
    testTimeout?: number;
    reporters?: [string, Record<string, unknown>][];
    coverage?: {
      provider: 'v8';
      reporter: string[];
      reportOnFailure: boolean;
      include: string[];
      exclude: string[];
    };
  } = {
    exclude,
    fileParallelism,
    include,
    setupFiles: ['apps/core/test/setup/runtime-env.ts'],
    testTimeout: 30_000,
    // The junit `file` attribute is a reporter option with no CLI flag; the
    // harness stage gate attributes required tests by it.
    ...(process.env.VITEST_JUNIT
      ? { reporters: [['junit', { addFileAttribute: true }] as [string, Record<string, unknown>]] }
      : {}),
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
