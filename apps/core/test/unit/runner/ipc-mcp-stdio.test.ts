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

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-mcp-test-'));
  tempRoots.push(root);
  return root;
}

function symlinkPackage(
  root: string,
  packageName: string,
  target: string,
): void {
  const packagePath = path.join(
    root,
    'node_modules',
    ...packageName.split('/'),
  );
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  fs.symlinkSync(path.resolve(target), packagePath, 'dir');
}

function createMcpFixture(): {
  root: string;
  serverPath: string;
  ipcDir: string;
  resultPath: string;
} {
  const root = makeTempRoot();
  const runnerDir = path.join(root, 'runner');
  const coreDir = path.join(root, 'core');
  const serverPath = path.join(runnerDir, 'ipc-mcp-stdio.ts');
  const ipcDir = path.join(root, 'ipc', 'team');
  const resultPath = path.join(root, 'mcp-result.json');
  const sdkRoot = path.join(
    root,
    'node_modules',
    '@modelcontextprotocol',
    'sdk',
  );
  const sdkServerDir = path.join(sdkRoot, 'server');

  fs.mkdirSync(runnerDir, { recursive: true });
  fs.mkdirSync(coreDir, { recursive: true });
  fs.mkdirSync(sdkServerDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ type: 'module' }),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/ipc-mcp-stdio.ts'),
    serverPath,
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/memory-timeouts.ts'),
    path.join(runnerDir, 'memory-timeouts.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/core/datetime.ts'),
    path.join(coreDir, 'datetime.ts'),
  );
  symlinkPackage(root, 'dayjs', 'node_modules/dayjs');
  symlinkPackage(root, 'zod', 'node_modules/zod');
  symlinkPackage(root, 'cron-parser', 'node_modules/cron-parser');
  symlinkPackage(root, '@myclaw/contracts', 'packages/contracts');

  fs.writeFileSync(
    path.join(sdkRoot, 'package.json'),
    JSON.stringify({ type: 'module' }),
  );
  fs.writeFileSync(
    path.join(sdkServerDir, 'stdio.js'),
    'export class StdioServerTransport {}',
  );
  fs.writeFileSync(
    path.join(sdkServerDir, 'mcp.js'),
    `
import fs from 'fs';
import path from 'path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tools = new Map();

async function waitForQuestionRequest(ipcDir) {
  const requestDir = path.join(ipcDir, 'user-questions');
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(requestDir)) {
      const files = fs.readdirSync(requestDir).filter((file) => file.endsWith('.json'));
      if (files.length > 0) {
        const filePath = path.join(requestDir, files[0]);
        return {
          filePath,
          body: JSON.parse(fs.readFileSync(filePath, 'utf-8')),
        };
      }
    }
    await delay(25);
  }
  throw new Error('timed out waiting for user question request');
}

export class McpServer {
  tool(name, _description, _schema, handler) {
    tools.set(name, handler);
  }

  async connect() {
    const toolName = process.env.TEST_MCP_TOOL_NAME;
    const handler = tools.get(toolName);
    if (!handler) throw new Error('tool not registered: ' + toolName);
    const args = JSON.parse(process.env.TEST_MCP_TOOL_ARGS || '{}');
    const ipcDir = process.env.MYCLAW_IPC_DIR;

    let observedRequest;
    if (process.env.TEST_MCP_ANSWER_QUESTION === '1') {
      void (async () => {
        observedRequest = await waitForQuestionRequest(ipcDir);
        const responseDir = path.join(ipcDir, 'user-answers');
        fs.mkdirSync(responseDir, { recursive: true });
        fs.writeFileSync(
          path.join(responseDir, observedRequest.body.requestId + '.json'),
          JSON.stringify({
            requestId: observedRequest.body.requestId,
            answers: {
              'Choose deployment?': ['Staging', 'Canary'],
              'Ship now?': 'Yes',
            },
            answeredBy: 'runner-mcp-test-admin',
          }),
        );
      })();
    }

    const result = await handler(args, {});
    fs.writeFileSync(
      process.env.TEST_MCP_RESULT_PATH,
      JSON.stringify(
        {
          result,
          observedRequest: observedRequest?.body,
          responseFiles: fs.existsSync(path.join(ipcDir, 'user-answers'))
            ? fs.readdirSync(path.join(ipcDir, 'user-answers'))
            : [],
        },
        null,
        2,
      ),
    );
  }
}
`,
  );

  return { root, serverPath, ipcDir, resultPath };
}

async function runMcpFixture(
  fixture: ReturnType<typeof createMcpFixture>,
  toolName: string,
  args: Record<string, unknown>,
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ exitCode: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    [path.resolve('node_modules/tsx/dist/cli.mjs'), fixture.serverPath],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        MYCLAW_IPC_DIR: fixture.ipcDir,
        MYCLAW_IPC_AUTH_TOKEN: 'mcp-test-token',
        MYCLAW_CHAT_JID: 'tg:team',
        MYCLAW_GROUP_FOLDER: 'team',
        MYCLAW_IS_MAIN: '0',
        ...envOverrides,
        TEST_MCP_TOOL_NAME: toolName,
        TEST_MCP_TOOL_ARGS: JSON.stringify(args),
        TEST_MCP_RESULT_PATH: fixture.resultPath,
        TEST_MCP_ANSWER_QUESTION: toolName === 'ask_user_question' ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP fixture timed out\nstderr:\n${stderr}`));
    }, 6_000);
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  return { exitCode, stderr };
}

describe('agent-runner MCP stdio tools', () => {
  it('consumes ask_user_question responses, formats answers, and unlinks the response file', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'ask_user_question', {
      questions: [
        {
          question: 'Choose deployment?',
          header: 'Deploy',
          options: [
            { label: 'Staging', description: 'Use test environment' },
            { label: 'Canary', description: 'Limited production rollout' },
          ],
          multiSelect: true,
        },
        {
          question: 'Ship now?',
          header: 'Ship',
          options: [
            { label: 'Yes', description: 'Proceed' },
            { label: 'No', description: 'Wait' },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.observedRequest).toEqual(
      expect.objectContaining({
        sourceGroup: 'team',
        authToken: 'mcp-test-token',
      }),
    );
    expect(record.result.content[0].text).toContain(
      'Choose deployment?: Staging, Canary',
    );
    expect(record.result.content[0].text).toContain('Ship now?: Yes');
    expect(record.result.content[0].text).toContain(
      '(answered by runner-mcp-test-admin)',
    );
    expect(record.responseFiles).toHaveLength(0);
  });

  it('defaults scheduler upsert delivery to the trusted runtime thread', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_upsert_job',
      {
        name: 'Daily review',
        prompt: 'Review memory',
        schedule_type: 'interval',
        schedule_value: '60000',
      },
      { MYCLAW_THREAD_ID: 'trusted-thread' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const taskFiles = fs.readdirSync(path.join(fixture.ipcDir, 'tasks'));
    expect(taskFiles).toHaveLength(1);
    const task = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'tasks', taskFiles[0]),
        'utf-8',
      ),
    );
    expect(task.threadId).toBe('trusted-thread');
    expect(task.context.threadId).toBe('trusted-thread');
  });

  it('rejects scheduler upsert thread targets outside the current runtime thread', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_upsert_job',
      {
        name: 'Daily review',
        prompt: 'Review memory',
        schedule_type: 'interval',
        schedule_value: '60000',
        thread_id: 'attacker-thread',
      },
      { MYCLAW_THREAD_ID: 'trusted-thread' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    const taskFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
    expect(taskFiles).toHaveLength(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'thread_id can only target the current thread/topic',
    );
  });

  it('does not retarget scheduler updates to the ambient runtime thread', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_update_job',
      {
        job_id: 'job-1',
        prompt: 'Updated prompt',
      },
      { MYCLAW_THREAD_ID: 'trusted-thread' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const taskFiles = fs.readdirSync(path.join(fixture.ipcDir, 'tasks'));
    expect(taskFiles).toHaveLength(1);
    const task = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'tasks', taskFiles[0]),
        'utf-8',
      ),
    );
    expect(task.context.threadId).toBe('trusted-thread');
    expect(task.threadId).toBeUndefined();
  });

  it('allows scheduler updates to explicitly target the current runtime thread', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_update_job',
      {
        job_id: 'job-1',
        prompt: 'Updated prompt',
        thread_id: 'trusted-thread',
      },
      { MYCLAW_THREAD_ID: 'trusted-thread' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const taskFiles = fs.readdirSync(path.join(fixture.ipcDir, 'tasks'));
    expect(taskFiles).toHaveLength(1);
    const task = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'tasks', taskFiles[0]),
        'utf-8',
      ),
    );
    expect(task.threadId).toBe('trusted-thread');
  });

  it('rejects scheduler thread targets outside the current runtime thread', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_update_job',
      {
        job_id: 'job-1',
        prompt: 'Updated prompt',
        thread_id: 'attacker-thread',
      },
      { MYCLAW_THREAD_ID: '' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    const taskFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
    expect(taskFiles).toHaveLength(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'thread_id can only target the current thread/topic',
    );
  });
});
