import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  RunnerSandboxProvider,
  RunnerSandboxResourceLimits,
} from '../shared/runner-sandbox-provider.js';
import { NEUTRAL_CA_TRUST_ENV_KEYS } from '../shared/neutral-ca-trust-env.js';
import { nowIso } from '../shared/time/datetime.js';
import type {
  AsyncCommandLaunchControl,
  AsyncCommandProcessHandle,
} from './async-command-task-service.js';

const ASYNC_COMMAND_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'GRPC_PROXY',
  'grpc_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'GODEBUG',
  'GANTRY_EGRESS_PROXY_URL',
  'NODE_EXTRA_CA_CERTS',
  ...NEUTRAL_CA_TRUST_ENV_KEYS,
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'USER',
  'SHELL',
  'TERM',
] as const;

export const DEFAULT_ASYNC_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_ASYNC_RESOURCE_LIMITS: RunnerSandboxResourceLimits = {
  cpuSeconds: 300,
  memoryMb: 1024,
  maxProcesses: 64,
};

export async function runSandboxedAsyncCommand(
  provider: RunnerSandboxProvider,
  input: {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    outputMaxBytes: number;
    protectedReadPaths: string[];
    protectedWritePaths: string[];
    allowedNetworkHosts: string[];
    egressProxyUrl?: string;
    resourceLimits: RunnerSandboxResourceLimits;
    signal: AbortSignal;
    appId: string;
    agentId: string;
    conversationId: string;
    threadId?: string | null;
    parentRunId?: string | null;
    parentJobId?: string | null;
    onProcessStarted?: (
      handle: AsyncCommandProcessHandle,
    ) => Promise<void> | void;
    launchControl?: AsyncCommandLaunchControl;
  },
): Promise<{ outputSummary?: string; errorSummary?: string }> {
  if (!provider.enforcing) {
    throw new Error(
      'Async command execution requires an enforcing runner sandbox.',
    );
  }
  if (input.signal.aborted) throw new Error('Command aborted.');
  const configFilePath = input.launchControl
    ? path.join(input.launchControl.directory, 'sandbox-runtime.json')
    : path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-async-command-')),
        'sandbox-runtime.json',
      );
  const child = provider.start({
    command: '/bin/sh',
    args: ['-c', asyncCommandLaunchScript()],
    cwd: input.cwd,
    workspaceRoot: input.cwd,
    configFilePath,
    egressProxyUrl: input.egressProxyUrl,
    allowedNetworkHosts: input.allowedNetworkHosts,
    runtimeReadPaths: [
      input.cwd,
      ...(input.launchControl ? [input.launchControl.directory] : []),
    ],
    runtimeWritePaths: [
      input.cwd,
      ...(input.launchControl ? [input.launchControl.directory] : []),
    ],
    protectedReadPaths: input.protectedReadPaths,
    protectedWritePaths: input.protectedWritePaths,
    resourceLimits: input.resourceLimits,
    sandboxProfile: {
      id: 'async-command',
      network: input.egressProxyUrl ? 'required' : 'none',
      filesystem: 'workspace_write',
    },
    principal: {
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId: input.threadId ?? undefined,
      runId: input.parentRunId ?? undefined,
      jobId: input.parentJobId ?? undefined,
    },
    env: {
      ...input.env,
      GANTRY_ASYNC_COMMAND_SCRIPT: input.command,
      ...(input.launchControl
        ? {
            GANTRY_ASYNC_LAUNCH_DIR: input.launchControl.directory,
            GANTRY_ASYNC_PID_FILE: input.launchControl.pidFile,
            GANTRY_ASYNC_PGID_FILE: input.launchControl.pgidFile,
            GANTRY_ASYNC_READY_FILE: input.launchControl.readyFile,
            GANTRY_ASYNC_CONTINUE_FILE: input.launchControl.continueFile,
          }
        : {}),
    },
  });
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    forceKillTimer.unref?.();
  };
  const onAbort = () => terminate();
  if (input.signal.aborted) {
    terminate();
    fs.rmSync(configFilePath, { force: true });
    throw new Error('Command aborted.');
  }
  input.signal.addEventListener('abort', onAbort, { once: true });
  let settled = false;
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<{
    outputSummary?: string;
    errorSummary?: string;
  }>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal.removeEventListener('abort', onAbort);
      fs.rmSync(configFilePath, { force: true });
      fn();
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-input.outputMaxBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-input.outputMaxBytes);
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code, signal) => {
      if (input.signal.aborted) {
        settle(() => reject(new Error('Command aborted.')));
        return;
      }
      if (timedOut) {
        settle(() =>
          reject(
            new Error(
              `Command timed out${signal ? ` with signal ${signal}` : ''}.`,
            ),
          ),
        );
        return;
      }
      if (code === 0) {
        child.kill('SIGTERM');
        const cleanupTimer = setTimeout(() => {
          child.kill('SIGKILL');
          settle(() =>
            resolve({
              outputSummary: stdout.trim() || 'command completed',
              errorSummary: stderr.trim(),
            }),
          );
        }, 1_000);
        cleanupTimer.unref?.();
        return;
      }
      settle(() =>
        reject(
          new Error(
            `Command failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          ),
        ),
      );
    });
  });
  if (child.pid) {
    try {
      const processStartId = readProcessStartId(child.pid);
      await input.onProcessStarted?.({
        pid: child.pid,
        processGroupId: process.platform === 'win32' ? null : child.pid,
        detached: true,
        platform: process.platform,
        ownerPid: process.pid,
        startedAt: nowIso(),
        ...(processStartId ? { processStartId } : {}),
      });
      if (input.signal.aborted) throw new Error('Command aborted.');
      if (input.launchControl) {
        await waitForLaunchReady(input.launchControl.readyFile);
        if (input.signal.aborted) throw new Error('Command aborted.');
        fs.writeFileSync(input.launchControl.continueFile, '', { mode: 0o600 });
      }
    } catch (err) {
      terminate();
      void completion.catch(() => undefined);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal.removeEventListener('abort', onAbort);
      fs.rmSync(configFilePath, { force: true });
      throw err;
    }
  }
  return completion;
}

export function buildAsyncCommandEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ASYNC_COMMAND_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

function asyncCommandLaunchScript(): string {
  return [
    'set -eu',
    'mkdir -p "$GANTRY_ASYNC_LAUNCH_DIR"',
    'echo "$$" > "$GANTRY_ASYNC_PID_FILE"',
    '(ps -o pgid= -p "$$" | tr -d " " > "$GANTRY_ASYNC_PGID_FILE") 2>/dev/null || echo "$$" > "$GANTRY_ASYNC_PGID_FILE"',
    ': > "$GANTRY_ASYNC_READY_FILE"',
    'while [ ! -f "$GANTRY_ASYNC_CONTINUE_FILE" ]; do sleep 0.05; done',
    'exec /bin/sh -c "$GANTRY_ASYNC_COMMAND_SCRIPT"',
  ].join('\n');
}

async function waitForLaunchReady(readyFile: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(readyFile)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Async command did not reach its launch barrier.');
}

function readProcessStartId(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
