import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { executeRunnerProcess } from '../../../src/runtime/agent-spawn-process.js';
import { stopActiveGroupRun } from '../../../src/runtime/group-queue-stop.js';
import { DirectRunnerSandboxProvider } from '../../../src/adapters/sandbox/runner-sandbox-provider.js';

const [mode, logsDir] = process.argv.slice(2);
const prompt = 'private-request-sentinel'.repeat(100_000);
const credential = 'private-credential-sentinel';
let runner: ChildProcess | undefined;
let pendingBytes = 0;
const controller = new AbortController();
const cleanup = () => {
  if (runner && runner.exitCode === null && runner.signalCode === null) {
    runner.kill('SIGKILL');
  }
};
process.on('exit', cleanup);
process.on('disconnect', cleanup);
process.on('SIGTERM', () => {
  cleanup();
  process.exit(1);
});

// The child either closes the actual OS descriptor, holds it unread, or reads
// the entire request. Keeping early-close alive proves the host stops it.
const childScript =
  mode === 'early-close'
    ? `require('node:fs').closeSync(0); setInterval(() => {}, 1000);`
    : mode === 'normal'
      ? `let raw = ''; process.stdin.on('data', chunk => raw += chunk);
       process.stdin.on('end', () => {
         const input = JSON.parse(raw);
         process.stdout.write(JSON.stringify({status: 'success', result:
           JSON.stringify({prompt: input.prompt, credential: input.browserTurnToken})}) + '\\n');
       });`
      : `process.stderr.write('ready\\n'); setInterval(() => {}, 1000);`;
const startTime = Date.now();
const resultPromise = executeRunnerProcess({
  group: {
    name: 'Request delivery',
    folder: 'request-delivery',
    trigger: '@test',
    added_at: new Date().toISOString(),
  },
  input: {
    prompt,
    browserTurnToken: credential,
    appId: 'default',
    workspaceFolder: 'request-delivery',
    chatJid: 'request-delivery',
  },
  command: process.execPath,
  args: ['-e', childScript],
  env: process.env,
  onProcess: (child) => {
    runner = child;
    process.send?.({ type: 'runner', pid: child.pid });
    child.stderr?.once('data', () => {
      pendingBytes = child.stdin?.writableLength ?? 0;
      if (mode === 'abort') controller.abort();
      if (mode === 'stop') {
        stopActiveGroupRun({
          groupJid: 'request-delivery',
          targetQueueJid: 'request-delivery',
          proc: child,
          closeStdin: () => child.stdin?.end(),
        });
      }
    });
  },
  options: {
    runnerSandboxProvider: new DirectRunnerSandboxProvider(),
    signal: controller.signal,
    timeoutMs: mode === 'timeout' ? 1500 : 10_000,
  },
  runnerLabel: 'Agent',
  processName: 'request-delivery',
  startTime,
  logsDir,
  runtimeDetails: [],
  sandbox: {
    cwd: logsDir,
    workspaceRoot: logsDir,
    allowedNetworkHosts: [],
    runtimeReadPaths: [],
    runtimeWritePaths: [],
    protectedReadPaths: [],
    protectedWritePaths: [],
    resourceLimits: { cpuSeconds: 0, memoryMb: 0, maxProcesses: 0 },
    sandboxProfile: {
      id: 'request-delivery',
      network: 'none',
      filesystem: 'workspace_write',
    },
    principal: {},
  },
});
const result = await resultPromise;
const logs = fs
  .readdirSync(logsDir)
  .map((name) => fs.readFileSync(path.join(logsDir, name), 'utf8'));
const summary = {
  type: 'result',
  result,
  pendingBytes,
  stdinFailed: runner?.stdin?.errored != null,
  elapsedMs: Date.now() - startTime,
  logs,
  exitCode: runner?.exitCode,
  signalCode: runner?.signalCode,
};
await new Promise<void>((resolve, reject) => {
  process.send?.(summary, (error) => (error ? reject(error) : resolve()));
});
process.disconnect();
