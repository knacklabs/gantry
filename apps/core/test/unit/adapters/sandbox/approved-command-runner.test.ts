import { describe, expect, it } from 'vitest';

import { runApprovedSandboxCommand } from '@core/adapters/sandbox/approved-command-runner.js';

describe('runApprovedSandboxCommand', () => {
  it('runs an explicit argv with the provided cwd and environment', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          "if (process.env.GANTRY_TEST_VALUE !== 'ok') process.exit(2)",
        ],
        cwd: process.cwd(),
        env: { ...process.env, GANTRY_TEST_VALUE: 'ok' },
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined();
  });

  it('redacts stderr when the approved command fails', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          "console.error('ACCESS_TOKEN=secret-value'); process.exit(3)",
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
        redactOutput: (value) =>
          value.replace(/ACCESS_TOKEN=[^\s]+/g, '<redacted>'),
      }),
    ).rejects.toThrow(/<redacted>/);
  });

  it('drains stdout so verbose approved commands cannot block on a pipe', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('x'.repeat(1024 * 1024 * 2))",
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined();
  });
});
