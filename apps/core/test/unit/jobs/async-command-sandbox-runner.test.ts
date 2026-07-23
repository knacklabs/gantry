import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ASYNC_RESOURCE_LIMITS,
  buildAsyncCommandEnv,
  runSandboxedAsyncCommand,
} from '@core/jobs/async-command-sandbox-runner.js';
import { DirectRunnerSandboxProvider } from '@core/adapters/sandbox/runner-sandbox-provider.js';
import type {
  RunnerSandboxProvider,
  RunnerSandboxSpawnInput,
} from '@core/shared/runner-sandbox-provider.js';

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

const tempDirs: string[] = [];

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 999_999;
  child.kill = vi.fn(() => true);
  return child;
}

function makeProvider(input?: {
  enforcing?: boolean;
  child?: FakeChild;
  onStart?: (options: RunnerSandboxSpawnInput) => void;
}): { provider: RunnerSandboxProvider; child: FakeChild } {
  const child = input?.child ?? makeChild();
  return {
    child,
    provider: {
      id: input?.enforcing === false ? 'direct' : 'sandbox_runtime',
      enforcing: input?.enforcing ?? true,
      start: vi.fn((options) => {
        input?.onStart?.(options);
        return child as never;
      }),
    },
  };
}

function baseInput(signal = new AbortController().signal) {
  return {
    command: 'echo ok',
    cwd: process.cwd(),
    env: { PATH: '/usr/bin' },
    timeoutMs: 5_000,
    outputMaxBytes: 200,
    protectedReadPaths: ['/secret/read'],
    protectedWritePaths: ['/secret/write'],
    allowedNetworkHosts: ['api.example.com:443'],
    egressProxyUrl: 'http://127.0.0.1:18080',
    resourceLimits: DEFAULT_ASYNC_RESOURCE_LIMITS,
    signal,
    appId: 'app:test',
    agentId: 'agent:test',
    conversationId: 'sl:C123',
    threadId: 'thread-1',
    parentRunId: 'run-1',
    parentJobId: 'job-1',
  };
}

function makeLaunchControl() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-async-runner-'),
  );
  tempDirs.push(directory);
  return {
    directory,
    pidFile: path.join(directory, 'pid'),
    pgidFile: path.join(directory, 'pgid'),
    readyFile: path.join(directory, 'ready'),
    continueFile: path.join(directory, 'continue'),
  };
}

describe('async command sandbox runner', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a narrow child environment without provider credentials', () => {
    vi.stubEnv('PATH', '/safe/bin');
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:18080');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/certs/ca.pem');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-secret');
    vi.stubEnv('OPENAI_API_KEY', 'openai-secret');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-secret');

    expect(buildAsyncCommandEnv()).toMatchObject({
      PATH: '/safe/bin',
      HTTP_PROXY: 'http://127.0.0.1:18080',
      NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
    });
    expect(buildAsyncCommandEnv()).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(buildAsyncCommandEnv()).not.toHaveProperty('OPENAI_API_KEY');
    expect(buildAsyncCommandEnv()).not.toHaveProperty(
      'CLAUDE_CODE_OAUTH_TOKEN',
    );
  });

  it('projects sandbox policy and launch barrier files to the enforcing provider', async () => {
    vi.useFakeTimers();
    const launchControl = makeLaunchControl();
    const { provider, child } = makeProvider({
      onStart: (options) => {
        fs.writeFileSync(launchControl.readyFile, '');
        expect(options).toMatchObject({
          command: '/bin/sh',
          args: ['-c', expect.stringContaining('GANTRY_ASYNC_COMMAND_SCRIPT')],
          cwd: process.cwd(),
          workspaceRoot: process.cwd(),
          configFilePath: path.join(
            launchControl.directory,
            'sandbox-runtime.json',
          ),
          egressProxyUrl: 'http://127.0.0.1:18080',
          allowedNetworkHosts: ['api.example.com:443'],
          runtimeReadPaths: [process.cwd(), launchControl.directory],
          runtimeWritePaths: [process.cwd(), launchControl.directory],
          protectedReadPaths: ['/secret/read'],
          protectedWritePaths: ['/secret/write'],
          sandboxProfile: {
            id: 'async-command',
            network: 'required',
            filesystem: 'workspace_write',
          },
          principal: {
            appId: 'app:test',
            agentId: 'agent:test',
            conversationId: 'sl:C123',
            threadId: 'thread-1',
            runId: 'run-1',
            jobId: 'job-1',
          },
        });
        expect(options.env).toMatchObject({
          PATH: '/usr/bin',
          GANTRY_ASYNC_COMMAND_SCRIPT: 'echo ok',
          GANTRY_ASYNC_LAUNCH_DIR: launchControl.directory,
          GANTRY_ASYNC_PID_FILE: launchControl.pidFile,
          GANTRY_ASYNC_PGID_FILE: launchControl.pgidFile,
          GANTRY_ASYNC_READY_FILE: launchControl.readyFile,
          GANTRY_ASYNC_CONTINUE_FILE: launchControl.continueFile,
        });
      },
    });

    const resultPromise = runSandboxedAsyncCommand(provider, {
      ...baseInput(),
      launchControl,
    });
    await Promise.resolve();
    child.stdout.write('done\n');
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toEqual({
      outputSummary: 'done',
      errorSummary: '',
    });
    expect(fs.existsSync(launchControl.continueFile)).toBe(true);
    expect(provider.start).toHaveBeenCalledOnce();
  });

  it('emits bounded throttled output snapshots while the child is running', async () => {
    vi.useFakeTimers();
    const { provider, child } = makeProvider();
    const snapshots: Array<{ stdoutTail?: string; stderrTail?: string }> = [];

    const resultPromise = runSandboxedAsyncCommand(provider, {
      ...baseInput(),
      outputMaxBytes: 8,
      onOutputSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    await Promise.resolve();
    child.stdout.write('123456789');
    child.stderr.write('abcdefghi');
    expect(snapshots).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshots).toEqual([
      {
        stdoutTail: '23456789',
        stderrTail: 'bcdefghi',
      },
    ]);
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toEqual({
      outputSummary: '23456789',
      errorSummary: 'bcdefghi',
    });
  });

  it('executes a direct command with the egress gateway environment', async () => {
    // A pure-shell command reads the injected egress env directly. Deliberately
    // not a `node -e` child: node fails to load libc (SIGTRAP) under the
    // sandbox's minimal env in containerized CI, which this test is not about.
    const result = await runSandboxedAsyncCommand(
      new DirectRunnerSandboxProvider(),
      {
        ...baseInput(),
        command: 'printf %s "${GANTRY_EGRESS_PROXY_URL}|${HTTP_PROXY}"',
        env: { PATH: process.env.PATH },
        launchControl: makeLaunchControl(),
      },
    );

    expect(result).toEqual({
      outputSummary: 'http://127.0.0.1:18080|http://127.0.0.1:18080',
      errorSummary: '',
    });
  });

  it('kills a direct command process group on timeout', async () => {
    let pid: number | undefined;
    const resultPromise = runSandboxedAsyncCommand(
      new DirectRunnerSandboxProvider(),
      {
        ...baseInput(),
        // A pure-shell loop that ignores SIGTERM: the runner must escalate to
        // SIGKILL. Deliberately not a `node -e` child — spawning node under the
        // sandbox's process constraints aborts early (SIGABRT/SIGTRAP) in
        // containerized CI before the timeout, which this test is not about.
        command: "trap '' TERM; while :; do sleep 1; done",
        env: { PATH: process.env.PATH },
        timeoutMs: 500,
        launchControl: makeLaunchControl(),
        onProcessStarted: (handle) => {
          pid = handle.pid;
        },
      },
    );

    await expect(resultPromise).rejects.toThrow(
      /Command timed out with signal SIG(?:TERM|KILL)\./,
    );
    expect(pid).toEqual(expect.any(Number));
    expect(() => process.kill(pid as number, 0)).toThrow();
  });

  it('times out active children under an enforcing sandbox', async () => {
    vi.useFakeTimers();
    const { provider, child } = makeProvider();
    child.kill.mockImplementation(() => {
      child.emit('close', null, 'SIGTERM');
      return true;
    });
    const resultPromise = runSandboxedAsyncCommand(provider, {
      ...baseInput(),
      timeoutMs: 10,
    });
    const assertion = expect(resultPromise).rejects.toThrow(
      'Command timed out with signal SIGTERM',
    );

    await vi.advanceTimersByTimeAsync(10);

    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
