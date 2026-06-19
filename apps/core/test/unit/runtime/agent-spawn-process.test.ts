import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match runtime agent output framing.
const OUTPUT_START_MARKER = '---GANTRY_OUTPUT_START---';
const OUTPUT_END_MARKER = '---GANTRY_OUTPUT_END---';

/* ------------------------------------------------------------------ */
/*  Hoisted mock references (accessible inside vi.mock factories)      */
/* ------------------------------------------------------------------ */

const { mockLogger, mockWriteFileSync } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockWriteFileSync: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

vi.mock('@core/config/index.js', () => ({
  AGENT_MAX_OUTPUT_SIZE: 512, // small limit so truncation tests are manageable
  AGENT_TIMEOUT: 5000, // 5 s
  IDLE_TIMEOUT: 5000, // 5 s
  get LOG_LEVEL() {
    return process.env.LOG_LEVEL || 'info';
  },
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: mockLogger,
  redactString: (value: string) =>
    value
      .replace(
        /(["'](?:sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id)["']\s*:\s*")([^"\r\n]*)(")/gi,
        '$1[REDACTED]$3',
      )
      .replace(
        /(["'](?:sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id)["']\s*:\s*')([^'\r\n]*)(')/gi,
        '$1[REDACTED]$3',
      )
      .replace(
        /\b((?:sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id)\s*[:=]\s*)([^\s"',}\]]+)/gi,
        '$1[REDACTED]',
      )
      .replace(
        /\b((?:sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id)\s+)([^\s"',}\]]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/\bclaude-session-[A-Za-z0-9._:-]+\b/g, '[REDACTED]')
      .replace(/\bprovider-session:[A-Za-z0-9._:-]+\b/g, '[REDACTED]')
      .replace(/\bxox[baprs]-[A-Za-z0-9-]+\b/g, '[REDACTED]')
      .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]'),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
    },
  };
});

/* ------------------------------------------------------------------ */
/*  Fake child process helper                                          */
/* ------------------------------------------------------------------ */

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 99999;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
  };
});

/* ------------------------------------------------------------------ */
/*  Import under test (after all mocks are registered)                 */
/* ------------------------------------------------------------------ */

import { executeRunnerProcess } from '@core/runtime/agent-spawn-process.js';
import { ACTIVE_RUN_STOP_REQUESTED } from '@core/runtime/group-queue-stop.js';
import type { RunnerProcessSpec } from '@core/runtime/agent-spawn-types.js';
import type { ConversationRoute } from '@core/domain/types.js';
import type { RunnerSandboxProvider } from '@core/shared/runner-sandbox-provider.js';

/* ------------------------------------------------------------------ */
/*  Shared fixtures                                                    */
/* ------------------------------------------------------------------ */

const testGroup: ConversationRoute = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@bot',
  added_at: new Date().toISOString(),
};

function makeSpec(
  overrides: Partial<RunnerProcessSpec> = {},
): RunnerProcessSpec {
  const runnerSandboxProvider: RunnerSandboxProvider = {
    id: 'direct',
    enforcing: false,
    start: vi.fn(() => fakeProc),
  };
  const base: RunnerProcessSpec = {
    group: testGroup,
    input: {
      prompt: 'Hello there',
      workspaceFolder: 'test-group',
      chatJid: 'test@g.us',
    },
    command: '/usr/bin/node',
    args: ['runner.js'],
    env: { PATH: '/usr/bin' },
    onProcess: vi.fn(),
    onOutput: undefined,
    options: { runnerSandboxProvider },
    runnerLabel: 'test-runner',
    processName: 'test-proc',
    startTime: Date.now(),
    logsDir: '/tmp/test-logs',
    runtimeDetails: ['detail-1', 'detail-2'],
    sandbox: {
      cwd: '/tmp/test-workspace',
      workspaceRoot: '/tmp/test-workspace',
      configFilePath: '/tmp/test-workspace/.gantry/sandbox.json',
      egressProxyUrl: 'http://127.0.0.1:12345',
      allowedNetworkHosts: [],
      runtimeReadPaths: ['/tmp/test-workspace/runtime'],
      runtimeWritePaths: ['/tmp/test-workspace/ipc'],
      protectedReadPaths: [],
      protectedWritePaths: [],
      resourceLimits: {
        cpuSeconds: 0,
        memoryMb: 0,
        maxProcesses: 0,
      },
      sandboxProfile: {
        id: 'runner-default',
        network: 'required',
        filesystem: 'workspace_write',
      },
      principal: {},
    },
  };
  return {
    ...base,
    ...overrides,
    options: {
      ...base.options,
      ...(overrides.options ?? {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('executeRunnerProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockWriteFileSync.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /* ============================================================== */
  /*  Sandbox provider seam                                          */
  /* ============================================================== */

  describe('sandbox provider seam', () => {
    it('uses the configured runner sandbox provider to start the process', async () => {
      const sandboxProvider = {
        id: 'direct' as const,
        enforcing: false,
        start: vi.fn(() => fakeProc),
      };
      const onProcess = vi.fn();
      const spec = makeSpec({
        onProcess,
        options: { runnerSandboxProvider: sandboxProvider },
      });
      const resultP = executeRunnerProcess(spec);

      const output = JSON.stringify({
        status: 'success',
        result: 'sandboxed result',
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${output}\n${OUTPUT_END_MARKER}\n`,
      );
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(sandboxProvider.start).toHaveBeenCalledWith({
        command: '/usr/bin/node',
        args: ['runner.js'],
        env: { PATH: '/usr/bin' },
        ...spec.sandbox,
      });
      expect(onProcess).toHaveBeenCalledWith(fakeProc, 'test-proc');
      expect(result.status).toBe('success');
      expect(result.result).toBe('sandboxed result');
    });

    it('fails closed when the configured runner sandbox provider cannot spawn', async () => {
      const sandboxProvider = {
        id: 'direct' as const,
        enforcing: false,
        start: vi.fn(() => {
          throw new Error('sandbox unavailable');
        }),
      };
      const onProcess = vi.fn();
      const spec = makeSpec({
        onProcess,
        options: { runnerSandboxProvider: sandboxProvider },
      });

      const result = await executeRunnerProcess(spec);

      expect(onProcess).not.toHaveBeenCalled();
      expect(result.status).toBe('error');
      expect(result.result).toBeNull();
      expect(result.error).toBe(
        'Sandbox startup failed: sandbox unavailable. The run did not start.',
      );
      expect(result.runtimeEvents).toContainEqual(
        expect.objectContaining({
          eventType: 'sandbox.blocked',
          payload: expect.objectContaining({
            provider: 'direct',
            enforcing: false,
            networkMode: 'required',
            filesystemMode: 'workspace_write',
            protectedWritePathCount: expect.any(Number),
          }),
        }),
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'Test Group',
          processName: 'test-proc',
          sandboxProvider: 'direct',
          error: 'sandbox unavailable',
        }),
        'test-runner sandbox provider failed',
      );
    });

    it('does not spawn when the run is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const sandboxProvider = {
        id: 'direct' as const,
        enforcing: false,
        start: vi.fn(() => fakeProc),
      };
      const onProcess = vi.fn();
      const spec = makeSpec({
        onProcess,
        options: {
          runnerSandboxProvider: sandboxProvider,
          signal: controller.signal,
        },
      });

      const result = await executeRunnerProcess(spec);

      expect(sandboxProvider.start).not.toHaveBeenCalled();
      expect(onProcess).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: 'error',
        result: null,
        error: 'test-runner stopped because the run was aborted',
      });
    });

    it('binds abort before writing runner input', async () => {
      const controller = new AbortController();
      const stdinWrite = vi.spyOn(fakeProc.stdin, 'write');
      const sandboxProvider = {
        id: 'direct' as const,
        enforcing: false,
        start: vi.fn(() => {
          controller.abort();
          return fakeProc;
        }),
      };
      const spec = makeSpec({
        options: {
          runnerSandboxProvider: sandboxProvider,
          signal: controller.signal,
        },
      });
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('close', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(10);

      await expect(resultP).resolves.toMatchObject({
        status: 'error',
        error: 'test-runner stopped because the run was aborted',
      });
      expect(stdinWrite).not.toHaveBeenCalled();
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  /* ============================================================== */
  /*  Non-zero exit code (lines 268-286)                             */
  /* ============================================================== */

  describe('non-zero exit code error path', () => {
    it('resolves with error when process exits with non-zero code', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      // Emit some stderr before exit
      fakeProc.stderr.push('something went wrong\n');
      fakeProc.emit('close', 1);

      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.result).toBeNull();
      expect(result.error).toContain('exited with code 1');
      expect(result.error).toContain('something went wrong');
    });

    it('surfaces generated .llm-runtime permission failures with actionable copy', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.stderr.push(
        "Error: EACCES: permission denied, open '/tmp/gantry/agents/main/.llm-runtime/claude/settings.json'\n",
      );
      fakeProc.emit('close', 1);

      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.error).toContain('Gantry-generated .llm-runtime files');
      expect(result.error).toContain('readable/executable');
      expect(result.error).toContain('.llm-runtime');
      expect(result.error).not.toContain('exited with code 1');
    });

    it('truncates stderr in error message to last 200 chars', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      const longStderr = 'x'.repeat(500);
      fakeProc.stderr.push(longStderr);
      fakeProc.emit('close', 2);

      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      // The error field should contain at most 200 chars of stderr
      expect(result.error).toContain('x'.repeat(200));
    });

    it('writes a log file on non-zero exit code', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.stderr.push('fail\n');
      fakeProc.emit('close', 1);

      await vi.advanceTimersByTimeAsync(10);
      await resultP;

      expect(mockWriteFileSync).toHaveBeenCalled();
      const [logPath, logContent] = mockWriteFileSync.mock.calls[0];
      expect(logPath).toMatch(/\/tmp\/test-logs\/agent-.*\.log/);
      expect(logContent).toContain('=== Agent Run Log ===');
      expect(logContent).toContain('Exit Code: 1');
      // Non-zero exit triggers verbose-like output with stderr/stdout sections
      expect(logContent).toContain('=== Stderr ===');
      expect(logContent).toContain('=== Stdout ===');
    });

    it('logs error with group details on non-zero exit', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('close', 127);

      await vi.advanceTimersByTimeAsync(10);
      await resultP;

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'Test Group',
          code: 127,
        }),
        expect.stringContaining('exited with error'),
      );
    });

    it('redacts channel and runtime secrets from durable runner logs', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.stdout.push('SLACK_BOT_TOKEN=xoxb-secret-token\n');
      fakeProc.stderr.push(
        'TELEGRAM_BOT_TOKEN=123456789:telegramSecretTokenValue\n',
      );
      fakeProc.stderr.push('WEBHOOK_SECRET=super-secret-value\n');
      fakeProc.emit('close', 1);

      await vi.advanceTimersByTimeAsync(10);
      const result = await resultP;

      expect(result.status).toBe('error');
      const logContent = String(mockWriteFileSync.mock.calls[0]?.[1] ?? '');
      expect(logContent).toContain('[REDACTED]');
      expect(logContent).not.toContain('xoxb-secret-token');
      expect(logContent).not.toContain('telegramSecretTokenValue');
      expect(logContent).not.toContain('super-secret-value');
      const errorPayload = JSON.stringify(mockLogger.error.mock.calls);
      expect(errorPayload).not.toContain('xoxb-secret-token');
      expect(errorPayload).not.toContain('telegramSecretTokenValue');
      expect(errorPayload).not.toContain('super-secret-value');
    });

    it('does not write provider resume handles to durable runner logs', async () => {
      const uuidHandle = '9f1d4b44-8347-4f6a-90b1-7262bc4f0db4';
      const framedHandle = '31f0f0b0-aad5-4ffc-a9b3-c449d25bb425';
      const shortHandle = 'sess-abc';
      const spec = makeSpec({
        input: {
          prompt: 'test prompt',
          workspaceFolder: 'test-group',
          chatJid: 'test@g.us',
          sessionId: uuidHandle,
        },
      });
      const resultP = executeRunnerProcess(spec);

      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${JSON.stringify({
          status: 'success',
          result: 'ok',
          newSessionId: framedHandle,
          providerSessionId: shortHandle,
          externalSessionId: 'external-short',
        })}\n${OUTPUT_END_MARKER}\n`,
      );
      fakeProc.stderr.push(
        'resume failed latestProviderSessionId: latest-short session_id=snake-short sessionId short-field-handle claude-session-shape-secret\n',
      );
      fakeProc.emit('close', 1);

      await vi.advanceTimersByTimeAsync(10);
      await resultP;

      const logContent = String(mockWriteFileSync.mock.calls[0]?.[1] ?? '');
      expect(logContent).toContain('Resume session: present');
      expect(logContent).not.toContain(uuidHandle);
      expect(logContent).not.toContain(framedHandle);
      expect(logContent).not.toContain(shortHandle);
      expect(logContent).not.toContain('external-short');
      expect(logContent).not.toContain('latest-short');
      expect(logContent).not.toContain('snake-short');
      expect(logContent).not.toContain('short-field-handle');
      expect(logContent).not.toContain('claude-session-shape-secret');

      const errorPayload = JSON.stringify(mockLogger.error.mock.calls);
      expect(errorPayload).not.toContain(framedHandle);
      expect(errorPayload).not.toContain(shortHandle);
      expect(errorPayload).not.toContain('external-short');
      expect(errorPayload).not.toContain('latest-short');
      expect(errorPayload).not.toContain('snake-short');
      expect(errorPayload).not.toContain('short-field-handle');
      expect(errorPayload).not.toContain('claude-session-shape-secret');
    });
  });

  /* ============================================================== */
  /*  Spawn error (lines 337-348)                                    */
  /* ============================================================== */

  describe('spawn error handler', () => {
    it('resolves with error when spawn emits error event', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('error', new Error('ENOENT: command not found'));

      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.result).toBeNull();
      expect(result.error).toContain('spawn error');
      expect(result.error).toContain('ENOENT: command not found');
    });

    it('clears timeout on spawn error', async () => {
      const spec = makeSpec({ options: { timeoutMs: 100 } });
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('error', new Error('EACCES'));

      await vi.advanceTimersByTimeAsync(10);
      const result = await resultP;
      expect(result.status).toBe('error');

      // Advance past what would have been the timeout — should not
      // trigger a second resolve or kill.
      await vi.advanceTimersByTimeAsync(200);
      expect(fakeProc.kill).not.toHaveBeenCalled();
    });

    it('logs spawn error with group and process details', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      const err = new Error('permission denied');
      fakeProc.emit('error', err);

      await vi.advanceTimersByTimeAsync(10);
      await resultP;

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'Test Group',
          processName: 'test-proc',
          error: err.message,
        }),
        expect.stringContaining('spawn error'),
      );
    });
  });

  /* ============================================================== */
  /*  Timeout paths                                                  */
  /* ============================================================== */

  describe('timeout handling', () => {
    it('kills process after configured timeoutMs', async () => {
      const spec = makeSpec({ options: { timeoutMs: 200 } });
      const resultP = executeRunnerProcess(spec);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(250);

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

      // Simulate OS reporting the killed process
      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out after 200ms');
    });

    it('writes timeout log on timeout with no output', async () => {
      const spec = makeSpec({ options: { timeoutMs: 100 } });
      const resultP = executeRunnerProcess(spec);

      await vi.advanceTimersByTimeAsync(150);
      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      expect(mockWriteFileSync).toHaveBeenCalled();
      const [, logContent] = mockWriteFileSync.mock.calls[0];
      expect(logContent).toContain('TIMEOUT');
      expect(logContent).toContain('Had Streaming Output: false');
    });

    it('does not treat runtime-event-only output as idle-cleanup success after timeout', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      const json = JSON.stringify({
        status: 'success',
        result: null,
        newSessionId: 'sess-event-only',
        runtimeEventOnly: true,
        runtimeEvents: [
          {
            eventType: 'task.progress',
            actor: 'runner',
            payload: { taskId: 'task-1' },
          },
        ],
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      await vi.advanceTimersByTimeAsync(35_050);

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');
      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.newSessionId).toBe('sess-event-only');
      expect(onOutput).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeEventOnly: true }),
      );
      const [, logContent] = mockWriteFileSync.mock.calls[0];
      expect(logContent).toContain('Had Streaming Output: false');
    });

    it('timeout after streaming output resolves as error', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput, options: { timeoutMs: 200 } });
      const resultP = executeRunnerProcess(spec);

      // Emit streaming output
      const json = JSON.stringify({
        status: 'success',
        result: 'streamed result',
        newSessionId: 'sess-1',
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
      );

      await vi.advanceTimersByTimeAsync(10);

      // Now advance past timeout
      await vi.advanceTimersByTimeAsync(250);

      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out after 200ms');
      expect(result.newSessionId).toBe('sess-1');
      expect(onOutput).toHaveBeenCalled();
    });

    it('does not reset explicit timeout on streaming output chunks', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput, options: { timeoutMs: 300 } });
      const resultP = executeRunnerProcess(spec);

      // Emit first chunk at t=0
      const json1 = JSON.stringify({ status: 'success', result: 'chunk1' });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json1}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      // Advance 250ms (< 300ms timeout), then emit second chunk
      await vi.advanceTimersByTimeAsync(250);
      const json2 = JSON.stringify({
        status: 'success',
        result: 'chunk2',
        newSessionId: 'sess-2',
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json2}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      // Advance another 250ms. The explicit timeout is wall-clock, not idle.
      await vi.advanceTimersByTimeAsync(250);

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.newSessionId).toBe('sess-2');
      expect(onOutput).toHaveBeenCalledTimes(2);
    });

    it('resets explicit timeout on scheduled job progress chunks', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({
        input: {
          prompt: 'Run lead maintenance',
          workspaceFolder: 'test-group',
          chatJid: 'test@g.us',
          isScheduledJob: true,
          jobId: 'job-1',
          runId: 'run-1',
        },
        onOutput,
        options: { timeoutMs: 300 },
      });
      const resultP = executeRunnerProcess(spec);

      const json1 = JSON.stringify({ status: 'success', result: 'chunk1' });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json1}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      await vi.advanceTimersByTimeAsync(250);
      const json2 = JSON.stringify({
        status: 'success',
        result: 'chunk2',
        newSessionId: 'sess-2',
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json2}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      await vi.advanceTimersByTimeAsync(250);
      expect(fakeProc.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60);
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.newSessionId).toBe('sess-2');
      expect(onOutput).toHaveBeenCalledTimes(2);
    });

    it('uses group agentConfig.timeout when options.timeoutMs not set', async () => {
      const groupWithTimeout: ConversationRoute = {
        ...testGroup,
        agentConfig: { timeout: 150 },
      };
      const spec = makeSpec({
        group: groupWithTimeout,
        options: undefined,
      });
      const resultP = executeRunnerProcess(spec);

      // The timeout should be max(150, IDLE_TIMEOUT + 30000) = max(150, 35000) = 35000
      // because options.timeoutMs is not set, Math.max applies
      // IDLE_TIMEOUT is 5000, so 5000 + 30000 = 35000
      await vi.advanceTimersByTimeAsync(35100);

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out');
    });
  });

  /* ============================================================== */
  /*  Stdout / stderr truncation                                     */
  /* ============================================================== */

  describe('output truncation', () => {
    it('truncates stdout when exceeding AGENT_MAX_OUTPUT_SIZE', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      // AGENT_MAX_OUTPUT_SIZE is mocked to 512
      const bigChunk = 'A'.repeat(600);
      fakeProc.stdout.push(bigChunk);

      await vi.advanceTimersByTimeAsync(10);

      // Emit valid output so it can parse
      const output = JSON.stringify({ status: 'success', result: 'ok' });
      // stdout is already truncated at 512, so buffered parse will fail
      // — we still expect a resolution
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      // Stdout was truncated so JSON parse fails — expect error
      expect(result.status).toBe('error');
      expect(result.error).toContain('Failed to parse runner output');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ group: 'Test Group' }),
        expect.stringContaining('stdout truncated'),
      );
    });

    it('truncates stderr when exceeding AGENT_MAX_OUTPUT_SIZE', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      const bigStderr = 'E'.repeat(600);
      fakeProc.stderr.push(bigStderr);

      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 1);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ group: 'Test Group' }),
        expect.stringContaining('stderr truncated'),
      );
    });
  });

  /* ============================================================== */
  /*  Buffered output parsing (no onOutput)                          */
  /* ============================================================== */

  describe('buffered output parsing (no onOutput)', () => {
    it('parses JSON from the last line of stdout', async () => {
      const spec = makeSpec({ onOutput: undefined });
      const resultP = executeRunnerProcess(spec);

      const output = JSON.stringify({
        status: 'success',
        result: 'buffered result',
      });
      fakeProc.stdout.push(`some debug line\nanother line\n${output}\n`);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
      expect(result.result).toBe('buffered result');
    });

    it('parses JSON from marker-delimited output', async () => {
      const spec = makeSpec({ onOutput: undefined });
      const resultP = executeRunnerProcess(spec);

      const output = JSON.stringify({
        status: 'success',
        result: 'marked result',
        newSessionId: 'sess-xyz',
      });
      fakeProc.stdout.push(
        `debug line\n${OUTPUT_START_MARKER}\n${output}\n${OUTPUT_END_MARKER}\ntrailing\n`,
      );

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
      expect(result.result).toBe('marked result');
      expect(result.newSessionId).toBe('sess-xyz');
    });

    it('resolves with error when stdout is not valid JSON', async () => {
      const spec = makeSpec({ onOutput: undefined });
      const resultP = executeRunnerProcess(spec);

      fakeProc.stdout.push('this is not json\n');
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.result).toBeNull();
      expect(result.error).toContain('Failed to parse runner output');
    });

    it('logs parse error with stdout and stderr context', async () => {
      const spec = makeSpec({ onOutput: undefined });
      const resultP = executeRunnerProcess(spec);

      fakeProc.stdout.push('garbage\n');
      fakeProc.stderr.push('some stderr\n');
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'Test Group',
          stdout: expect.stringContaining('garbage'),
          stderr: expect.stringContaining('some stderr'),
        }),
        'Failed to parse runner output',
      );
    });
  });

  /* ============================================================== */
  /*  Streaming output with onOutput                                 */
  /* ============================================================== */

  describe('streaming output mode (with onOutput)', () => {
    it('resolves with success and null result on normal exit', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      const json = JSON.stringify({
        status: 'success',
        result: 'streamed',
        newSessionId: 'sess-abc',
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
      expect(result.result).toBeNull();
      expect(result.newSessionId).toBe('sess-abc');
    });

    it('does not log structured provider resume handles on completion', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);
      const shortStreamingHandle = 'sess-stream-short';

      const json = JSON.stringify({
        status: 'success',
        result: 'streamed',
        newSessionId: shortStreamingHandle,
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.newSessionId).toBe(shortStreamingHandle);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'Test Group',
          providerSessionCreated: true,
          startupTiming: expect.objectContaining({
            providerSessionMs: expect.any(Number),
          }),
        }),
        'test-runner completed (streaming mode)',
      );
      expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain(
        shortStreamingHandle,
      );
    });

    it('distinguishes session init from first visible output in startup timing', async () => {
      const onOutput = vi.fn(async () => {});
      const publishRuntimeEvent = vi.fn(async () => undefined);
      const spec = makeSpec({
        input: {
          prompt: 'Hello there',
          workspaceFolder: 'test-group',
          chatJid: 'test@g.us',
          appId: 'default',
          agentId: 'agent:test',
          runId: 'agent-run:test-visible',
        },
        onOutput,
        options: { publishRuntimeEvent },
        startupHostPhases: {
          adapterPrepareMs: 7,
          mcpProjectionMs: 11,
        },
      });
      const resultP = executeRunnerProcess(spec);

      await vi.advanceTimersByTimeAsync(25);
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${JSON.stringify({
          status: 'success',
          result: null,
          newSessionId: 'sess-visible',
          sessionInit: true,
        })}\n${OUTPUT_END_MARKER}\n`,
      );

      await vi.advanceTimersByTimeAsync(55);
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${JSON.stringify({
          status: 'success',
          result: 'first text',
          newSessionId: 'sess-visible',
        })}\n${OUTPUT_END_MARKER}\n`,
      );

      await vi.advanceTimersByTimeAsync(10);
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result).toMatchObject({
        status: 'success',
        result: null,
        providerSession: { externalSessionId: 'sess-visible' },
        newSessionId: 'sess-visible',
      });
      expect(onOutput).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          result: null,
          sessionInit: true,
          newSessionId: 'sess-visible',
        }),
      );
      expect(onOutput).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          result: 'first text',
          newSessionId: 'sess-visible',
        }),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          startupTiming: expect.objectContaining({
            firstStructuredOutputMs: 25,
            providerSessionMs: 25,
            firstVisibleOutputMs: 80,
            hostPhases: expect.objectContaining({
              adapterPrepareMs: 7,
              mcpProjectionMs: 11,
            }),
          }),
        }),
        'test-runner completed (streaming mode)',
      );
      const [, logContent] = mockWriteFileSync.mock.calls[0];
      expect(logContent).toContain('First Structured Output: 25ms');
      expect(logContent).toContain('Provider Session Init: 25ms');
      expect(logContent).toContain('First Visible Output: 80ms');
      expect(logContent).toContain('Host Phase - Adapter Prepare: 7ms');
      expect(logContent).toContain('Host Phase - MCP Projection: 11ms');
      expect(publishRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'default',
          agentId: 'agent:test',
          runId: 'agent-run:test-visible',
          conversationId: 'test@g.us',
          eventType: 'run.startup_diagnostic',
          actor: 'runtime',
          responseMode: 'none',
          payload: expect.objectContaining({
            provider: 'host',
            diagnostic: 'runner_process_timing',
            sandbox: {
              provider: 'direct',
              enforcing: false,
            },
            exit: {
              code: 0,
              signal: null,
              timedOut: false,
              hadStreamingOutput: true,
            },
            startupTiming: expect.objectContaining({
              firstStructuredOutputMs: 25,
              providerSessionMs: 25,
              firstVisibleOutputMs: 80,
              hostPhases: expect.objectContaining({
                adapterPrepareMs: 7,
                mcpProjectionMs: 11,
              }),
            }),
          }),
        }),
      );
      expect(JSON.stringify(publishRuntimeEvent.mock.calls)).not.toContain(
        '/tmp/test-workspace',
      );
    });

    it('treats SIGTERM after streamed output as closed, not failed', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      const json = JSON.stringify({
        status: 'success',
        result: 'already visible',
        newSessionId: 'sess-closed',
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result).toEqual({
        status: 'success',
        result: null,
        providerSession: { externalSessionId: 'sess-closed' },
        newSessionId: 'sess-closed',
      });
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        expect.anything(),
        'test-runner exited with error',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'Test Group',
          signal: 'SIGTERM',
        }),
        'test-runner closed after streamed output',
      );
    });

    it('treats SIGTERM after runtime-event-only output as failed', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      const json = JSON.stringify({
        status: 'success',
        result: null,
        newSessionId: 'sess-event-only',
        runtimeEventOnly: true,
        runtimeEvents: [
          {
            eventType: 'task.progress',
            actor: 'runner',
            payload: { taskId: 'task-1' },
          },
        ],
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.anything(),
        'test-runner closed after streamed output',
      );
      expect(onOutput).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeEventOnly: true }),
      );
    });

    it('preserves explicit stop as an error after streamed output', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      const json = JSON.stringify({
        status: 'success',
        result: 'already visible',
        newSessionId: 'sess-stopped',
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      (fakeProc as { [ACTIVE_RUN_STOP_REQUESTED]?: boolean })[
        ACTIVE_RUN_STOP_REQUESTED
      ] = true;
      fakeProc.emit('close', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result).toEqual({
        status: 'error',
        result: null,
        providerSession: { externalSessionId: 'sess-stopped' },
        newSessionId: 'sess-stopped',
        error: 'test-runner stopped by request',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'Test Group',
          signal: 'SIGTERM',
          hadStreamingOutput: true,
        }),
        'test-runner stopped by request',
      );
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.anything(),
        'test-runner closed after streamed output',
      );
    });

    it('warns but continues on malformed streaming JSON', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      // Push a malformed chunk
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n{not json}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ group: 'Test Group' }),
        'Failed to parse streamed output chunk',
      );
      expect(onOutput).not.toHaveBeenCalled();

      // Process can still exit normally
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      // No streaming output was successfully parsed, and onOutput is set,
      // so it goes through the streaming path
      expect(result.status).toBe('success');
      expect(result.result).toBeNull();
    });

    it('handles multiple streaming output chunks', async () => {
      const outputs: Array<{ status: string; result: string | null }> = [];
      const onOutput = vi.fn(async (parsed) => {
        outputs.push(parsed);
      });
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      for (let i = 0; i < 3; i++) {
        const json = JSON.stringify({
          status: 'success',
          result: `chunk-${i}`,
        });
        fakeProc.stdout.push(
          `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
        );
      }
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      expect(onOutput).toHaveBeenCalledTimes(3);
      expect(outputs.map((o) => o.result)).toEqual([
        'chunk-0',
        'chunk-1',
        'chunk-2',
      ]);
    });

    it('keeps running when onOutput callback rejects', async () => {
      const onOutput = vi
        .fn()
        .mockRejectedValueOnce(new Error('callback boom'))
        .mockResolvedValueOnce(undefined);
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      const first = JSON.stringify({ status: 'success', result: 'first' });
      const second = JSON.stringify({ status: 'success', result: 'second' });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${first}\n${OUTPUT_END_MARKER}\n`,
      );
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${second}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
      expect(onOutput).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ group: 'Test Group' }),
        'onOutput callback failed',
      );
    });

    it('trims oversized streaming parse buffers', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      fakeProc.stdout.push('x'.repeat(140_000));
      await vi.advanceTimersByTimeAsync(10);
      const json = JSON.stringify({ status: 'success', result: 'ok' });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);
      const result = await resultP;

      expect(result.status).toBe('success');
      expect(onOutput).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'ok' }),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ group: 'Test Group' }),
        'Streaming parse buffer exceeded limit and was trimmed',
      );
    });
  });

  /* ============================================================== */
  /*  Log file content checks                                        */
  /* ============================================================== */

  describe('log file writing', () => {
    it('writes verbose log when LOG_LEVEL=debug', async () => {
      const origLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'debug';

      try {
        const spec = makeSpec({
          input: {
            prompt: 'test prompt',
            workspaceFolder: 'test-group',
            chatJid: 'test@g.us',
            sessionId: 'sess-existing',
          },
        });
        const resultP = executeRunnerProcess(spec);

        const output = JSON.stringify({ status: 'success', result: 'ok' });
        fakeProc.stdout.push(output + '\n');
        fakeProc.emit('close', 0);
        await vi.advanceTimersByTimeAsync(10);

        await resultP;

        expect(mockWriteFileSync).toHaveBeenCalled();
        const [, logContent] = mockWriteFileSync.mock.calls[0];
        expect(logContent).toContain('=== Input Summary ===');
        expect(logContent).toContain('Chat JID: test@g.us');
        expect(logContent).toContain('=== Spawn Command ===');
        expect(logContent).toContain('/usr/bin/node runner.js');
        expect(logContent).toContain('=== Runtime Details ===');
        expect(logContent).toContain('detail-1');
      } finally {
        if (origLogLevel === undefined) {
          delete process.env.LOG_LEVEL;
        } else {
          process.env.LOG_LEVEL = origLogLevel;
        }
      }
    });

    it('writes summary log (not verbose) on normal success', async () => {
      const origLogLevel = process.env.LOG_LEVEL;
      delete process.env.LOG_LEVEL;

      try {
        const spec = makeSpec();
        const resultP = executeRunnerProcess(spec);

        const output = JSON.stringify({ status: 'success', result: 'done' });
        await vi.advanceTimersByTimeAsync(25);
        fakeProc.stdout.push(output + '\n');
        fakeProc.emit('close', 0);
        await vi.advanceTimersByTimeAsync(10);

        await resultP;

        expect(mockWriteFileSync).toHaveBeenCalled();
        const [, logContent] = mockWriteFileSync.mock.calls[0];
        expect(logContent).toContain('=== Input Summary ===');
        expect(logContent).toContain('Prompt length:');
        expect(logContent).toContain('=== Startup Timing ===');
        expect(logContent).toContain('Host Pre-Spawn:');
        expect(logContent).toContain('First Stdout: 25ms');
        // Should NOT contain full input dump
        expect(logContent).not.toContain('=== Input ===');
        // Should NOT contain stdout/stderr sections on successful non-verbose
        expect(logContent).not.toContain('=== Stdout ===');
      } finally {
        if (origLogLevel === undefined) {
          delete process.env.LOG_LEVEL;
        } else {
          process.env.LOG_LEVEL = origLogLevel;
        }
      }
    });

    it('writes truncation markers in log when output was truncated', async () => {
      const origLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'debug';

      try {
        const spec = makeSpec();
        const resultP = executeRunnerProcess(spec);

        // Exceed AGENT_MAX_OUTPUT_SIZE (512)
        fakeProc.stdout.push('X'.repeat(600));
        fakeProc.stderr.push('Y'.repeat(600));
        await vi.advanceTimersByTimeAsync(10);

        fakeProc.emit('close', 1); // non-zero to trigger verbose logging
        await vi.advanceTimersByTimeAsync(10);

        await resultP;

        const [, logContent] = mockWriteFileSync.mock.calls[0];
        expect(logContent).toContain('Stdout Truncated: true');
        expect(logContent).toContain('Stderr Truncated: true');
        expect(logContent).toContain('(TRUNCATED)');
      } finally {
        if (origLogLevel === undefined) {
          delete process.env.LOG_LEVEL;
        } else {
          process.env.LOG_LEVEL = origLogLevel;
        }
      }
    });
  });

  /* ============================================================== */
  /*  Edge cases                                                     */
  /* ============================================================== */

  describe('edge cases', () => {
    it('calls onProcess with the spawned child process', async () => {
      const onProcess = vi.fn();
      const spec = makeSpec({ onProcess });
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      expect(onProcess).toHaveBeenCalledWith(fakeProc, 'test-proc');
    });

    it('writes input to stdin as JSON', async () => {
      const chunks: string[] = [];
      fakeProc.stdin.on('data', (d: Buffer) => chunks.push(d.toString()));

      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      const written = chunks.join('');
      const parsed = JSON.parse(written);
      expect(parsed.prompt).toBe('Hello there');
      expect(parsed.workspaceFolder).toBe('test-group');
    });

    it('handles empty stdout on exit code 0', async () => {
      const spec = makeSpec({ onOutput: undefined });
      const resultP = executeRunnerProcess(spec);

      // No stdout at all
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.error).toContain('Failed to parse runner output');
    });

    it('handles stderr lines being logged at debug level', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.stderr.push('line one\nline two\n');
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { agent: 'test-group' },
        'line one',
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { agent: 'test-group' },
        'line two',
      );
    });

    it('uses AGENT_TIMEOUT when no options and no agentConfig timeout', async () => {
      // AGENT_TIMEOUT = 5000, IDLE_TIMEOUT = 5000
      // When options.timeoutMs is not set: Math.max(configuredTimeout, IDLE_TIMEOUT + 30000)
      // = Math.max(5000, 35000) = 35000
      const spec = makeSpec({ options: undefined });
      const resultP = executeRunnerProcess(spec);

      // Should NOT have timed out at 5 seconds
      await vi.advanceTimersByTimeAsync(5100);
      expect(fakeProc.kill).not.toHaveBeenCalled();

      // Should time out at 35 seconds
      await vi.advanceTimersByTimeAsync(30000);
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
    });

    it('uses exact timeoutMs when options.timeoutMs is provided (no Math.max)', async () => {
      // When options.timeoutMs IS set, it should use that value directly
      // without the Math.max(configuredTimeout, IDLE_TIMEOUT + 30_000) logic
      const spec = makeSpec({ options: { timeoutMs: 100 } });
      const resultP = executeRunnerProcess(spec);

      await vi.advanceTimersByTimeAsync(150);
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out after 100ms');
    });

    it('buffers partial streaming markers until end marker arrives', async () => {
      // Covers line 118: endIdx === -1 break (start marker present but no end marker yet)
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput, options: { timeoutMs: 5000 } });
      const resultP = executeRunnerProcess(spec);

      // Send start marker and JSON but NOT the end marker yet
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n{"status":"success","result":"partial"}`,
      );
      await vi.advanceTimersByTimeAsync(10);

      // onOutput should NOT have been called — still buffering
      expect(onOutput).not.toHaveBeenCalled();

      // Now send the end marker
      fakeProc.stdout.push(`\n${OUTPUT_END_MARKER}\n`);
      await vi.advanceTimersByTimeAsync(10);

      // Now it should have been called
      expect(onOutput).toHaveBeenCalledTimes(1);
      expect(onOutput).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'partial' }),
      );

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
    });

    it('skips empty stderr lines in debug logging', async () => {
      // Covers lines 147: if (line) — false branch for empty lines
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      // Send stderr with empty lines interspersed
      fakeProc.stderr.push('real line\n\n\nanother line\n');
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      // Only non-empty lines should be logged
      const debugCalls = mockLogger.debug.mock.calls.filter(
        (call) => call[0]?.agent === 'test-group',
      );
      const loggedLines = debugCalls.map((call) => call[1]);
      expect(loggedLines).toContain('real line');
      expect(loggedLines).toContain('another line');
      // Empty strings should NOT appear
      expect(loggedLines.every((l: string) => l.length > 0)).toBe(true);
    });

    it('stops accumulating stderr after truncation but still logs lines', async () => {
      // Covers line 149: if (stderrTruncated) return;
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      // First chunk fills up stderr (AGENT_MAX_OUTPUT_SIZE = 512)
      fakeProc.stderr.push('Z'.repeat(600));
      await vi.advanceTimersByTimeAsync(10);

      // Clear the warn mock so we can check if a second truncation warn fires
      mockLogger.warn.mockClear();

      // Second chunk after truncation — should be ignored for accumulation
      fakeProc.stderr.push('AFTER_TRUNCATION\n');
      await vi.advanceTimersByTimeAsync(10);

      // No second truncation warning should fire
      const truncWarnCalls = mockLogger.warn.mock.calls.filter((call) =>
        String(call[1]).includes('stderr truncated'),
      );
      expect(truncWarnCalls).toHaveLength(0);

      // The "AFTER_TRUNCATION" line should still be debug-logged though
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { agent: 'test-group' },
        'AFTER_TRUNCATION',
      );

      fakeProc.emit('close', 1);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;
    });
  });
});
