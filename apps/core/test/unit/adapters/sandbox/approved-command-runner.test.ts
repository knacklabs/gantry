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
    ).resolves.toMatchObject({ stdout: '', stderr: '' });
  });

  it('surfaces and redacts stderr when the approved command fails', async () => {
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
    ).rejects.toThrow(/REDACTED/);
  });

  it('preserves a caller-redacted stdout tail when failure stderr is empty', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('discard-me safe-prefix\\nuse-this-tail'); process.exit(4)",
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
        stdoutMaxBytes: 25,
        redactOutput: (value) => value.replace('use-this-tail', '<redacted>'),
      }),
    ).rejects.toThrow(
      'Command failed with exit code 4: [REDACTED_TRUNCATED_OUTPUT]\n<redacted>',
    );
  });

  it('surfaces stderr instead of stdout when both are present', async () => {
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        "console.log('stdout-output'); console.error('stderr-output'); process.exit(5)",
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('stderr-output');
    expect((error as Error).message).not.toContain('stdout-output');
  });

  it('reports only the exit code when failure output is empty', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [process.execPath, '-e', 'process.exit(6)'],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('Command failed with exit code 6');
  });

  it.each([
    `ghp_${'a'.repeat(24)}`,
    'password hunter2',
    '-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----',
  ])('redacts sensitive stdout failure diagnostics', async (diagnostic) => {
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify(diagnostic)}); process.exit(7)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(diagnostic);
    expect((error as Error).message).toContain('REDACTED');
  });

  it('sanitizes stdout before a caller redacts only the credential label', async () => {
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        "process.stdout.write('password hunter2'); process.exit(8)",
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      redactOutput: (value) => value.replace('password', '<redacted>'),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('redacts indentationless YAML sequence values under a credential label', async () => {
    const diagnostic =
      'passwords:\n- hunter2\n- swordfish\ninstaller exited with config error';
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(8)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('hunter2');
    expect((error as Error).message).not.toContain('swordfish');
    expect((error as Error).message).toContain('installer exited');
  });

  it('redacts a labelled PEM block before relaying the failure to the caller', async () => {
    const keyBody = 'private-key-body-that-must-never-reach-the-relay';
    const diagnostic = `private key: -----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----\ninstaller rejected credentials`;
    let callerInput = '';
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify(diagnostic)}); process.exit(8)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      redactOutput: (value) => {
        callerInput = value;
        return value;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(callerInput).toContain('REDACTED');
    expect(callerInput).not.toContain(keyBody);
    expect((error as Error).message).toContain('REDACTED');
    expect((error as Error).message).not.toContain(keyBody);
  });

  it('redacts an orphaned PEM fragment when truncation slices off the BEGIN line', async () => {
    // A truncated tail can retain only the key body + END marker; the
    // fragment (and marker-less base64 runs) must still redact.
    const bodyLine = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w';
    const fragment = `${bodyLine}\n${bodyLine}\n${bodyLine}\n-----END PRIVATE KEY-----\ninstaller rejected credentials`;
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify(fragment)}); process.exit(8)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('REDACTED');
    expect((error as Error).message).not.toContain(bodyLine);
    expect((error as Error).message).toContain(
      'installer rejected credentials',
    );
  });

  it('redacts URL userinfo from stderr failure diagnostics', async () => {
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        "console.error('request failed: https://alice:hunter2@example.com/path'); process.exit(9)",
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('https://***@example.com/path');
    expect((error as Error).message).not.toContain('alice');
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('redacts URL userinfo split across stderr writes', async () => {
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        "process.stderr.write('request failed: https://alice:'); setTimeout(() => { process.stderr.write('hunter2@example.com/path'); process.exit(9); }, 10)",
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('https://***@example.com/path');
    expect((error as Error).message).not.toContain('alice');
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('reassembles a UTF-8 codepoint split across stdout writes', async () => {
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        'process.stdout.write(Buffer.from([0xe2])); setTimeout(() => { process.stdout.write(Buffer.from([0x82, 0xac])); process.exit(9); }, 10)',
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      stdoutMaxBytes: 3,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('€');
    expect((error as Error).message).not.toContain('REDACTED_TRUNCATED_OUTPUT');
  });

  it('redacts userinfo from non-HTTP hierarchical URIs', async () => {
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        "console.error('database failed: postgres://alice:hunter2@localhost:5432/app'); process.exit(9)",
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'postgres://***@localhost:5432/app',
    );
    expect((error as Error).message).not.toContain('alice');
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('masks credential query parameters in stdout failure diagnostics', async () => {
    const diagnostic =
      'https://example.com/install?mode=debug&key=one-secret&ToKeN=two-secret&secret=three-secret&password=four-secret&api_key=five-secret&access_key=six-secret&sig=seven-secret';
    let callerInput = '';
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify(diagnostic)}); process.exit(9)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      redactOutput: (value) => {
        callerInput = value;
        return value;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('mode=debug');
    for (const name of [
      'key',
      'ToKeN',
      'secret',
      'password',
      'api_key',
      'access_key',
      'sig',
    ]) {
      expect(callerInput).toContain(`${name}=***`);
    }
    for (const secret of [
      'one-secret',
      'two-secret',
      'three-secret',
      'four-secret',
      'five-secret',
      'six-secret',
      'seven-secret',
    ]) {
      expect(callerInput).not.toContain(secret);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each([
    ['token: hunter2x', 'hunter2x'],
    ['API key = hunter2x', 'hunter2x'],
    ['credentials: hunter2x', 'hunter2x'],
    ['cookies: hunter2x', 'hunter2x'],
    ['{"password":"correct-horse"}', 'correct-horse'],
    ['{"authToken":"correct-horse"}', 'correct-horse'],
    ['accessToken: correct-horse', 'correct-horse'],
  ])(
    'fails closed for credential-labelled stdout diagnostics',
    async (diagnostic, secret) => {
      const error = await runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          `process.stdout.write(${JSON.stringify(diagnostic)}); process.exit(9)`,
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
        redactOutput: (value) => value.replace(/token|API key/i, '<redacted>'),
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
    },
  );

  it('suppresses complete quoted multi-word credential values', async () => {
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify('{"password":"correct horse battery staple"}')}); process.exit(9)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    for (const word of ['correct', 'horse', 'battery', 'staple']) {
      expect((error as Error).message).not.toContain(word);
    }
  });

  it('suppresses payload appended to a credential status word', async () => {
    let callerInput = '';
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        "process.stdout.write('token failed: hunter2'); process.exit(9)",
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      redactOutput: (value) => {
        callerInput = value;
        return value.replace(/token/gi, '<redacted>');
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(callerInput).not.toContain('hunter2');
    expect((error as Error).message).not.toContain('hunter2');
  });

  it.each(['MY_CREDENTIAL hunter2x', 'NPM_AUTH=short.secret'])(
    'fails closed for credential labels embedded in identifiers',
    async (diagnostic) => {
      const error = await runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          `process.stdout.write(${JSON.stringify(diagnostic)}); process.exit(10)`,
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('hunter2x');
      expect((error as Error).message).not.toContain('short.secret');
    },
  );

  it.each([
    'authentication failed',
    'no credentials configured',
    'credentials could not be found',
    'token has expired',
    'session closed unexpectedly',
  ])('preserves non-secret authentication diagnostics', async (diagnostic) => {
    await expect(
      runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          `process.stdout.write(${JSON.stringify(diagnostic)}); process.exit(11)`,
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(diagnostic);
  });

  it('drops a truncated credential-bearing line and preserves the next line', async () => {
    const diagnostic = `password: ${'x'.repeat(100)} correct horse battery staple\nactual-tail`;
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify(diagnostic)}); process.exit(12)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      stdoutMaxBytes: 40,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('REDACTED_TRUNCATED_OUTPUT');
    expect((error as Error).message).toContain('actual-tail');
    for (const word of ['correct', 'horse', 'battery', 'staple']) {
      expect((error as Error).message).not.toContain(word);
    }
  });

  it('preserves a sanitized tail for verbose stderr failures', async () => {
    const diagnostic = `${'x'.repeat(5_000)}\ninstall failed: https://alice:hunter2@example.com?token=correct-horse\nactual failure reason`;
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(13)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('REDACTED_TRUNCATED_OUTPUT');
    expect((error as Error).message).toContain('actual failure reason');
    expect((error as Error).message).toContain('token=***');
    expect((error as Error).message).not.toContain('alice');
    expect((error as Error).message).not.toContain('hunter2');
    expect((error as Error).message).not.toContain('correct-horse');
  });

  it('drops label-less credential continuations when truncation slices off the label', async () => {
    // The retained tail starts inside a `passwords:` sequence block, so the
    // label that would trigger redaction is gone; the leading continuation
    // lines must be dropped rather than relayed.
    const sequence = Array.from(
      { length: 450 },
      (unused, index) => `- hunter2-${index}`,
    ).join('\n');
    const diagnostic = `${'x'.repeat(5_000)}\npasswords:\n${sequence}\ninstaller exited with config error`;
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(15)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('REDACTED_TRUNCATED_OUTPUT');
    expect((error as Error).message).toContain(
      'installer exited with config error',
    );
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('redacts a spaced compound credential label block', async () => {
    const diagnostic =
      'database password: |\n  hunter2\ninstall failed with config error';
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(16)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('hunter2');
    expect((error as Error).message).toContain('install failed');
  });

  it('keeps a complete first tail line when truncation lands on a newline boundary', async () => {
    // 5 x 1000-byte junk lines followed by exactly 4000 bytes of complete
    // 100-byte lines: the retained window (4001 bytes) starts one byte after
    // a newline, so the first tail line is already complete and must not be
    // discarded.
    const junk = `${'j'.repeat(999)}\n`.repeat(5);
    const firstLine = `${'first retained line '.padEnd(99, '#')}\n`;
    const fillerLine = `${'log entry '.repeat(9)}123456789\n`;
    const finalLine = `${'final failure reason '.padEnd(99, '#')}\n`;
    const diagnostic = `${junk}${firstLine}${fillerLine.repeat(38)}${finalLine}`;
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(17)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('REDACTED_TRUNCATED_OUTPUT');
    expect((error as Error).message).toContain('first retained line');
    expect((error as Error).message).toContain('final failure reason');
  });

  it('fails closed for a verbose single-line failure', async () => {
    const diagnostic = `${'x'.repeat(5_000)} actual single-line failure reason`;
    const error = await runApprovedSandboxCommand({
      argv: [
        process.execPath,
        '-e',
        `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(14)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('REDACTED_TRUNCATED_OUTPUT');
    expect((error as Error).message).not.toContain(
      'actual single-line failure reason',
    );
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
    ).resolves.toMatchObject({ stderr: '' });
  });

  it('returns bounded stdout for successful approved commands', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [process.execPath, '-e', "console.log('done')"],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
        stdoutMaxBytes: 100,
      }),
    ).resolves.toMatchObject({ stdout: 'done' });
  });

  it('aborts a running command through AbortSignal', async () => {
    const controller = new AbortController();
    const run = runApprovedSandboxCommand({
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 30_000)'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    controller.abort();

    await expect(run).rejects.toThrow('Command aborted.');
  });

  it('rejects before spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runApprovedSandboxCommand({
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow('Command aborted.');
  });

  it('rejects timed-out commands even when SIGTERM exits cleanly', async () => {
    await expect(
      runApprovedSandboxCommand({
        argv: [
          process.execPath,
          '-e',
          "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 30_000)",
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('Command timed out');
  });
});
