import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { AgentOutput } from '../../src/runtime/agent-spawn-types.js';

// STORY: runner-input-pipe-crash. The host is isolated so an unhandled pipe
// error is an assertion failure instead of taking down Vitest itself.
interface HostResult {
  type: 'result';
  result: AgentOutput;
  pendingBytes: number;
  stdinFailed: boolean;
  elapsedMs: number;
  logs: string[];
  exitCode: number | null;
  signalCode: string | null;
}

async function runHost(mode: string): Promise<HostResult> {
  const logsDir = await mkdtemp(
    path.join(os.tmpdir(), 'gantry-request-delivery-'),
  );
  const fixture = fileURLToPath(
    new URL('./fixtures/runner-request-delivery-host.ts', import.meta.url),
  );
  const host = spawn(
    process.execPath,
    ['--import', 'tsx', fixture, mode, logsDir],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, LOG_LEVEL: 'info' },
    },
  );
  let output = '';
  let runnerPid: number | undefined;
  let result: HostResult | undefined;
  host.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-32_768);
  });
  host.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-32_768);
  });
  host.on('message', (message: unknown) => {
    const frame = message as { type?: string; pid?: number };
    if (frame.type === 'runner') runnerPid = frame.pid;
    if (frame.type === 'result') result = message as HostResult;
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      host.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () =>
            reject(
              new Error(`Request delivery host exceeded 20 seconds: ${output}`),
            ),
          20_000,
        );
      }),
      new Promise<never>((_, reject) => host.once('error', reject)),
    ]);
    expect(exit, output).toEqual({ code: 0, signal: null });
    expect(result, output).toBeDefined();
    return result!;
  } finally {
    clearTimeout(watchdog);
    // Also clean up detached runners after a host crash or watchdog expiry.
    if (runnerPid) {
      try {
        process.kill(-runnerPid, 'SIGKILL');
      } catch (error) {
        expect(error).toMatchObject({ code: 'ESRCH' });
      }
    }
    if (host.exitCode === null && host.signalCode === null)
      host.kill('SIGTERM');
    await closed;
    await rm(logsDir, { recursive: true, force: true });
  }
}

it('returns a bounded request-delivery error and stops a runner that closes input early', async () => {
  const reply = await runHost('early-close');
  expect(reply.result).toEqual({
    status: 'error',
    result: null,
    error: 'The agent could not receive the request. Please try again.',
  });
  expect(reply.elapsedMs).toBeLessThan(10_000);
  expect(reply.stdinFailed).toBe(true);
  expect(reply.signalCode).toBe('SIGKILL');
  const diagnostics = JSON.stringify(reply);
  expect(diagnostics).not.toContain('private-request-sentinel');
  expect(diagnostics).not.toContain('private-credential-sentinel');
});

it('records a timeout without crashing when killing a runner with pending input', async () => {
  const reply = await runHost('timeout');
  expect(reply.pendingBytes).toBeGreaterThan(1024 * 1024);
  expect(reply.stdinFailed).toBe(true);
  expect(reply.result.status).toBe('error');
  expect(reply.result.error).toContain('timed out');
  expect(reply.signalCode).toBe('SIGKILL');
  expect(reply.logs.join('\n')).toContain('TIMEOUT');
});

it.each(['abort', 'stop'])(
  'preserves %s classification when shutdown breaks pending input',
  async (mode) => {
    const reply = await runHost(mode);
    expect(reply.pendingBytes).toBeGreaterThan(1024 * 1024);
    expect(reply.stdinFailed).toBe(true);
    expect(reply.result.status).toBe('error');
    expect(reply.result.error).toContain(
      mode === 'abort' ? 'run was aborted' : 'stopped by request',
    );
    expect(reply.signalCode).toBe('SIGTERM');
  },
);

it('delivers the complete request to a normally reading runner', async () => {
  const reply = await runHost('normal');
  expect(reply.result.status).toBe('success');
  expect(JSON.parse(reply.result.result!)).toEqual({
    prompt: 'private-request-sentinel'.repeat(100_000),
    credential: 'private-credential-sentinel',
  });
  expect(reply.stdinFailed).toBe(false);
  expect(reply.exitCode).toBe(0);
});
