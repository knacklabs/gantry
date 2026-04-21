import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface RunnerRecord {
  calls: Array<{
    promptKind: 'stream' | 'string';
    streamMessages?: string[];
    stringPrompt?: string;
    systemPromptAppend?: string;
    memoryContextFile?: string;
    closeExistsAtQueryStart?: boolean;
    streamEnded?: boolean;
    permissionRequest?: Record<string, unknown>;
    permissionDecision?: Record<string, unknown>;
  }>;
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-runner-test-'));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createRunnerFixture(): {
  root: string;
  runnerPath: string;
  ipcDir: string;
  inputDir: string;
  recordPath: string;
  memoryContextFile: string;
} {
  const root = makeTempRoot();
  const runnerPath = path.join(root, 'runner.ts');
  const sdkDir = path.join(
    root,
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
  );
  const ipcDir = path.join(root, 'ipc', 'team');
  const inputDir = path.join(ipcDir, 'input');
  const recordPath = path.join(root, 'sdk-record.json');
  const memoryContextFile = path.join(ipcDir, 'memory_context.json');

  fs.mkdirSync(sdkDir, { recursive: true });
  fs.copyFileSync(path.resolve('apps/core/src/runner/index.ts'), runnerPath);
  fs.writeFileSync(
    path.join(sdkDir, 'package.json'),
    JSON.stringify({ type: 'module', main: 'index.js' }),
  );
  fs.writeFileSync(
    path.join(sdkDir, 'index.js'),
    `
import fs from 'fs';
import path from 'path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appendRecord(call) {
  const recordPath = process.env.TEST_SDK_RECORD_PATH;
  const current = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, 'utf-8'))
    : { calls: [] };
  current.calls.push(call);
  fs.writeFileSync(recordPath, JSON.stringify(current, null, 2));
}

function writeInput(name, text) {
  const inputDir = process.env.MYCLAW_IPC_INPUT_DIR;
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, name),
    JSON.stringify({ type: 'message', text }),
  );
}

async function nextWithTimeout(iterator, timeoutMs) {
  const timeout = Symbol('timeout');
  const result = await Promise.race([
    iterator.next(),
    delay(timeoutMs).then(() => timeout),
  ]);
  return result === timeout ? null : result;
}

async function waitForFile(dir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json'));
      if (files.length > 0) return path.join(dir, files[0]);
    }
    await delay(25);
  }
  throw new Error('timed out waiting for IPC file in ' + dir);
}

export async function* query({ prompt, options }) {
  const call = {
    promptKind: typeof prompt === 'string' ? 'string' : 'stream',
    systemPromptAppend: options?.systemPrompt?.append,
    memoryContextFile: process.env.MYCLAW_IPC_MEMORY_CONTEXT_FILE,
    closeExistsAtQueryStart: fs.existsSync(
      path.join(process.env.MYCLAW_IPC_INPUT_DIR, '_close'),
    ),
  };

  yield { type: 'system', subtype: 'init', session_id: 'runner-session-1' };

  if (process.env.TEST_PERMISSION_DECISION) {
    const decisionPromise = options.canUseTool(
      'Bash',
      { cmd: 'npm test', apiToken: 'secret-token' },
      {
        signal: new AbortController().signal,
        title: 'Run command',
        displayName: 'Bash',
        description: 'Needs shell access',
        decisionReason: 'Agent wants to verify tests',
        blockedPath: process.env.MYCLAW_WORKSPACE_GROUP_DIR,
      },
    );
    const requestDir = path.join(process.env.MYCLAW_IPC_DIR, 'permission-requests');
    const responseDir = path.join(process.env.MYCLAW_IPC_DIR, 'permission-responses');
    const requestPath = await waitForFile(requestDir, 1000);
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    fs.mkdirSync(responseDir, { recursive: true });
    fs.writeFileSync(
      path.join(responseDir, request.requestId + '.json'),
      JSON.stringify({
        requestId: request.requestId,
        approved: process.env.TEST_PERMISSION_DECISION === 'approve',
        decidedBy: 'runner-test-admin',
        reason: process.env.TEST_PERMISSION_DECISION,
      }),
    );
    call.permissionRequest = request;
    call.permissionDecision = await decisionPromise;
  }

  if (typeof prompt === 'string') {
    call.stringPrompt = prompt;
  } else {
    call.streamMessages = [];
    const iterator = prompt[Symbol.asyncIterator]();
    const first = await nextWithTimeout(iterator, 1000);
    if (first && !first.done) {
      call.streamMessages.push(first.value.message.content);
    }

    if (process.env.TEST_ACTIVE_INPUT_ORDER === '1') {
      writeInput('001-active-first.json', 'active follow-up first');
      writeInput('002-active-second.json', 'active follow-up second');
      for (let i = 0; i < 2; i += 1) {
        const next = await nextWithTimeout(iterator, 1500);
        if (next && !next.done) {
          call.streamMessages.push(next.value.message.content);
        }
      }
    }

    if (process.env.TEST_CREATE_CLOSE_DURING_QUERY === '1') {
      fs.writeFileSync(path.join(process.env.MYCLAW_IPC_INPUT_DIR, '_close'), '');
      const closed = await nextWithTimeout(iterator, 1500);
      call.streamEnded = Boolean(closed?.done);
    }
  }

  appendRecord(call);
  yield { type: 'result', subtype: 'success', result: 'runner-ok' };

  if (process.env.TEST_EXIT_AFTER_QUERY === '1') {
    setTimeout(() => {
      fs.writeFileSync(path.join(process.env.MYCLAW_IPC_INPUT_DIR, '_close'), '');
    }, 20);
  }
}
`,
  );

  return { root, runnerPath, ipcDir, inputDir, recordPath, memoryContextFile };
}

function baseInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    prompt: 'initial prompt',
    groupFolder: 'team',
    chatJid: 'tg:team',
    isMain: false,
    compiledSystemPrompt: 'compiled system profile',
    ...overrides,
  };
}

async function runRunner(
  fixture: ReturnType<typeof createRunnerFixture>,
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const child = spawn(
    process.execPath,
    [path.resolve('node_modules/tsx/dist/cli.mjs'), fixture.runnerPath],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        MYCLAW_IPC_DIR: fixture.ipcDir,
        MYCLAW_IPC_INPUT_DIR: fixture.inputDir,
        MYCLAW_IPC_AUTH_TOKEN: 'runner-test-token',
        MYCLAW_IPC_MEMORY_CONTEXT_FILE: fixture.memoryContextFile,
        MYCLAW_WORKSPACE_GROUP_DIR: path.join(fixture.root, 'group'),
        MYCLAW_WORKSPACE_EXTRA_DIR: path.join(fixture.root, 'extra'),
        TEST_SDK_RECORD_PATH: fixture.recordPath,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdin.end(JSON.stringify(input));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`runner timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }, 12_000);
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  return { stdout, stderr, exitCode };
}

function readRecord(recordPath: string): RunnerRecord {
  return JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as RunnerRecord;
}

describe('agent-runner IPC lifecycle', () => {
  it('removes stale _close at startup before starting the SDK query', async () => {
    const fixture = createRunnerFixture();
    fs.mkdirSync(fixture.inputDir, { recursive: true });
    fs.writeFileSync(path.join(fixture.inputDir, '_close'), '');

    const result = await runRunner(fixture, baseInput(), {
      TEST_EXIT_AFTER_QUERY: '1',
    });

    expect(result.exitCode).toBe(0);
    const record = readRecord(fixture.recordPath);
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]?.closeExistsAtQueryStart).toBe(false);
  });

  it('removes stale _close at startup without discarding pending startup input', async () => {
    const fixture = createRunnerFixture();
    fs.mkdirSync(fixture.inputDir, { recursive: true });
    fs.writeFileSync(path.join(fixture.inputDir, '_close'), '');
    writeJson(path.join(fixture.inputDir, '001-pending.json'), {
      type: 'message',
      text: 'pending startup context after stale close',
    });

    const result = await runRunner(fixture, baseInput(), {
      TEST_EXIT_AFTER_QUERY: '1',
    });

    expect(result.exitCode).toBe(0);
    const call = readRecord(fixture.recordPath).calls[0];
    expect(call?.closeExistsAtQueryStart).toBe(false);
    expect(call?.streamMessages?.[0]).toContain(
      'pending startup context after stale close',
    );
    expect(fs.readdirSync(fixture.inputDir)).not.toContain('_close');
    expect(fs.readdirSync(fixture.inputDir)).not.toContain('001-pending.json');
  });

  it('drains pending startup IPC input into the initial prompt in filename order', async () => {
    const fixture = createRunnerFixture();
    writeJson(path.join(fixture.inputDir, '001-first.json'), {
      type: 'message',
      text: 'startup first',
    });
    writeJson(path.join(fixture.inputDir, '002-second.json'), {
      type: 'message',
      text: 'startup second',
    });

    const result = await runRunner(fixture, baseInput(), {
      TEST_EXIT_AFTER_QUERY: '1',
    });

    expect(result.exitCode).toBe(0);
    const firstMessage = readRecord(fixture.recordPath).calls[0]
      ?.streamMessages?.[0];
    expect(firstMessage).toContain('initial prompt');
    expect(firstMessage?.indexOf('startup first')).toBeLessThan(
      firstMessage?.indexOf('startup second') ?? -1,
    );
    expect(fs.readdirSync(fixture.inputDir)).not.toContain('001-first.json');
  }, 15000);

  it('skips malformed startup IPC input while draining adjacent valid input', async () => {
    const fixture = createRunnerFixture();
    fs.mkdirSync(fixture.inputDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixture.inputDir, '000-malformed.json'),
      '{"type":',
    );
    writeJson(path.join(fixture.inputDir, '001-valid.json'), {
      type: 'message',
      text: 'valid startup context after malformed neighbor',
    });

    const result = await runRunner(fixture, baseInput(), {
      TEST_EXIT_AFTER_QUERY: '1',
    });

    expect(result.exitCode).toBe(0);
    const firstMessage = readRecord(fixture.recordPath).calls[0]
      ?.streamMessages?.[0];
    expect(firstMessage).toContain('initial prompt');
    expect(firstMessage).toContain(
      'valid startup context after malformed neighbor',
    );
    expect(fs.readdirSync(fixture.inputDir)).not.toContain(
      '000-malformed.json',
    );
    expect(fs.readdirSync(fixture.inputDir)).not.toContain('001-valid.json');
  });

  it('drains active-query IPC input into the stream in filename order', async () => {
    const fixture = createRunnerFixture();

    const result = await runRunner(fixture, baseInput(), {
      TEST_ACTIVE_INPUT_ORDER: '1',
      TEST_EXIT_AFTER_QUERY: '1',
    });

    expect(result.exitCode).toBe(0);
    const messages = readRecord(fixture.recordPath).calls[0]?.streamMessages;
    expect(messages).toEqual([
      'initial prompt',
      'active follow-up first',
      'active follow-up second',
    ]);
  });

  it('ends the active query stream when _close arrives during the query', async () => {
    const fixture = createRunnerFixture();

    const result = await runRunner(fixture, baseInput(), {
      TEST_CREATE_CLOSE_DURING_QUERY: '1',
    });

    expect(result.exitCode).toBe(0);
    const call = readRecord(fixture.recordPath).calls[0];
    expect(call?.streamEnded).toBe(true);
    expect(result.stdout.match(/---MYCLAW_OUTPUT_START---/g)).toHaveLength(1);
  });

  it('appends memory context blocks to the first streamed user prompt only', async () => {
    const fixture = createRunnerFixture();
    writeJson(fixture.memoryContextFile, {
      block: 'Memory brief: user prefers concise updates.',
    });

    const result = await runRunner(fixture, baseInput(), {
      TEST_EXIT_AFTER_QUERY: '1',
    });

    expect(result.exitCode).toBe(0);
    const call = readRecord(fixture.recordPath).calls[0];
    expect(call?.systemPromptAppend).toBe('compiled system profile');
    expect(call?.systemPromptAppend).not.toContain('user prefers');
    expect(call?.streamMessages?.[0]).toContain(
      'Memory brief: user prefers concise updates.',
    );
    expect(call?.memoryContextFile).toBe(fixture.memoryContextFile);
  });

  it('routes SDK canUseTool approval through permission request and response IPC', async () => {
    const fixture = createRunnerFixture();

    const result = await runRunner(fixture, baseInput(), {
      TEST_PERMISSION_DECISION: 'approve',
      TEST_EXIT_AFTER_QUERY: '1',
    });

    expect(result.exitCode).toBe(0);
    const call = readRecord(fixture.recordPath).calls[0];
    expect(call?.permissionRequest).toEqual(
      expect.objectContaining({
        sourceGroup: 'team',
        toolName: 'Bash',
        authToken: 'runner-test-token',
      }),
    );
    expect(call?.permissionRequest?.toolInput).toEqual(
      expect.objectContaining({ cmd: 'npm test', apiToken: 'secret-token' }),
    );
    expect(call?.permissionDecision).toEqual({
      behavior: 'allow',
      updatedInput: { cmd: 'npm test', apiToken: 'secret-token' },
    });
    expect(
      fs.readdirSync(path.join(fixture.ipcDir, 'permission-responses')),
    ).toHaveLength(0);
  });

  it('fails SDK canUseTool closed when permission response denies the request', async () => {
    const fixture = createRunnerFixture();

    const result = await runRunner(fixture, baseInput(), {
      TEST_PERMISSION_DECISION: 'deny',
      TEST_EXIT_AFTER_QUERY: '1',
    });

    expect(result.exitCode).toBe(0);
    const call = readRecord(fixture.recordPath).calls[0];
    expect(call?.permissionDecision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: 'Permission denied: deny',
        interrupt: false,
      }),
    );
  });
});
