#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const [databaseUrl, ...args] = process.argv.slice(2);

if (!databaseUrl) {
  console.error(
    'Usage: node .codex/scripts/run_postgres_integration_with_url.mjs <postgres-url> [vitest args...]',
  );
  process.exit(2);
}

const commandArgs =
  args.length > 0
    ? args
    : [
        'run',
        '-c',
        'vitest.integration.config.ts',
        '--no-file-parallelism',
      ];

const result = spawnSync('npx', ['vitest', ...commandArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    GANTRY_TEST_DATABASE_URL: databaseUrl,
  },
});

process.exit(result.status ?? 1);
