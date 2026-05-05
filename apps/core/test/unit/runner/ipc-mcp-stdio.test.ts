import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { generateKeyPairSync } from 'crypto';

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

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function createMcpFixture(): {
  root: string;
  serverPath: string;
  ipcDir: string;
  resultPath: string;
  responseVerifyKey: string;
  responseSigningKey: string;
} {
  const root = makeTempRoot();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const responseVerifyKey = publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();
  const responseSigningKey = privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  const runnerDir = path.join(root, 'runner');
  const runnerMcpDir = path.join(runnerDir, 'mcp');
  const infrastructureTimeDir = path.join(root, 'infrastructure', 'time');
  const sharedDir = path.join(root, 'shared');
  const serverPath = path.join(runnerMcpDir, 'stdio.ts');
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
  fs.mkdirSync(runnerMcpDir, { recursive: true });
  fs.mkdirSync(infrastructureTimeDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(sdkServerDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ type: 'module' }),
  );
  copyDirectory(path.resolve('apps/core/src/runner/mcp'), runnerMcpDir);
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-catalog.ts'),
    path.join(sharedDir, 'model-catalog.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/admin-mcp-tools.ts'),
    path.join(sharedDir, 'admin-mcp-tools.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/memory-timeouts.ts'),
    path.join(runnerDir, 'memory-timeouts.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/infrastructure/time/datetime.ts'),
    path.join(infrastructureTimeDir, 'datetime.ts'),
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
import { sign as cryptoSign } from 'crypto';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tools = new Map();

function signPayload(payload) {
  const signingKey = process.env.TEST_IPC_RESPONSE_SIGNING_KEY || '';
  if (!signingKey) return undefined;
  return cryptoSign(null, Buffer.from(JSON.stringify(payload)), signingKey).toString('base64');
}

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

async function waitForInteractionBoundary(ipcDir) {
  const boundaryDir = path.join(ipcDir, 'interaction-boundaries');
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(boundaryDir)) {
      const files = fs.readdirSync(boundaryDir).filter((file) => file.endsWith('.json'));
      if (files.length > 0) {
        const filePath = path.join(boundaryDir, files[0]);
        const body = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        return { filePath, body };
      }
    }
    await delay(25);
  }
  throw new Error('timed out waiting for interaction boundary');
}

async function waitForTaskRequest(ipcDir) {
  const requestDir = path.join(ipcDir, 'tasks');
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(requestDir)) {
      const files = fs
        .readdirSync(requestDir)
        .filter((file) => file.endsWith('.json'));
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
  return null;
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
    let observedBoundary;
    if (process.env.TEST_MCP_ANSWER_QUESTION === '1') {
      void (async () => {
        observedBoundary = await waitForInteractionBoundary(ipcDir);
        observedRequest = await waitForQuestionRequest(ipcDir);
        const responseDir = path.join(ipcDir, 'user-answers');
        fs.mkdirSync(responseDir, { recursive: true });
        const responsePayload = {
          requestId: observedRequest.body.requestId,
          answers: {
            'Choose deployment?': ['Staging', 'Canary'],
            'Ship now?': 'Yes',
          },
          answeredBy: 'runner-mcp-test-admin',
        };
        const signature = signPayload(responsePayload);
        fs.writeFileSync(
          path.join(responseDir, observedRequest.body.requestId + '.json'),
          JSON.stringify({
            ...responsePayload,
            ...(signature ? { signature } : {}),
          }),
        );
      })();
    }
    if (process.env.TEST_MCP_AUTO_RESPOND_TASKS === '1') {
      void (async () => {
        const observedTask = await waitForTaskRequest(ipcDir);
        const taskId =
          typeof observedTask?.body?.taskId === 'string'
            ? observedTask.body.taskId
            : '';
        if (!taskId) return;
        const responseDir = path.join(ipcDir, 'task-responses');
        fs.mkdirSync(responseDir, { recursive: true });
        const responsePayload = {
          taskId,
          ok: true,
          message: 'Scheduler task confirmed.',
          ...(process.env.TEST_MCP_TASK_RESPONSE_DATA
            ? { data: JSON.parse(process.env.TEST_MCP_TASK_RESPONSE_DATA) }
            : {}),
        };
    const signature = signPayload(responsePayload);
        fs.writeFileSync(
          path.join(responseDir, 'task-' + taskId + '.json'),
          JSON.stringify({
            ...responsePayload,
            ...(process.env.TEST_MCP_UNSIGNED_TASK_RESPONSE === '1'
              ? {}
              : signature
                ? { signature }
                : {}),
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
          observedBoundary: observedBoundary?.body,
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

  return {
    root,
    serverPath,
    ipcDir,
    resultPath,
    responseVerifyKey,
    responseSigningKey,
  };
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
        MYCLAW_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
        TEST_IPC_RESPONSE_SIGNING_KEY: fixture.responseSigningKey,
        MYCLAW_CHAT_JID: 'tg:team',
        MYCLAW_GROUP_FOLDER: 'team',
        MYCLAW_ADMIN_MCP_TOOLS_JSON: '[]',
        ...envOverrides,
        TEST_MCP_TOOL_NAME: toolName,
        TEST_MCP_TOOL_ARGS: JSON.stringify(args),
        TEST_MCP_RESULT_PATH: fixture.resultPath,
        TEST_MCP_ANSWER_QUESTION: toolName === 'ask_user_question' ? '1' : '0',
        TEST_MCP_AUTO_RESPOND_TASKS: '1',
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
    }, 15_000);
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

describe('agent-runner MCP stdio tools', { timeout: 10_000 }, () => {
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
        signature: expect.any(String),
      }),
    );
    expect(record.observedBoundary).toEqual(
      expect.objectContaining({
        type: 'user_interaction',
        tool: 'ask_user_question',
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

  it('shows unavailable admin tools with exact request_permission guidance', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'capability_status', {});

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain(
      'requestable: mcp__myclaw__service_restart',
    );
    expect(record.result.content[0].text).toContain(
      'tool_id: tool:mcp__myclaw__service_restart',
    );
    expect(record.result.content[0].text).toContain(
      'request_permission: permissionKind=tool toolName=mcp__myclaw__service_restart temporaryOnly=false',
    );
  });

  it('registers selected admin tools and reports remaining requestable tools', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'service_restart',
      {},
      { MYCLAW_ADMIN_MCP_TOOLS_JSON: '["service_restart"]' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain(
      'Scheduler task confirmed.',
    );
    const taskFiles = fs.readdirSync(path.join(fixture.ipcDir, 'tasks'));
    const task = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'tasks', taskFiles[0]),
        'utf-8',
      ),
    );
    expect(task.type).toBe('service_restart');

    const statusFixture = createMcpFixture();
    const statusResult = await runMcpFixture(
      statusFixture,
      'capability_status',
      {},
      { MYCLAW_ADMIN_MCP_TOOLS_JSON: '["service_restart"]' },
    );
    expect(statusResult.exitCode, statusResult.stderr).toBe(0);
    const statusRecord = JSON.parse(
      fs.readFileSync(statusFixture.resultPath, 'utf-8'),
    );
    expect(statusRecord.result.content[0].text).toContain(
      'available: mcp__myclaw__service_restart',
    );
    expect(statusRecord.result.content[0].text).toContain(
      'requestable: mcp__myclaw__register_agent',
    );
  });

  it('keeps unselected admin tools out of the MCP surface', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'service_restart', {});

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('tool not registered: service_restart');
  });

  it('defaults scheduler upsert delivery to the trusted runtime thread', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_upsert_job',
      {
        name: 'Daily review',
        prompt: 'Review memory',
        model_alias: 'kimi 2.6',
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
    expect(task.modelAlias).toBe('kimi 2.6');
    expect(task.chatJid).toBe('tg:team');
    expect(task.targetJid).toBe('tg:team');
    expect(task.authThreadId).toBe('trusted-thread');
    expect(task.threadId).toBe('trusted-thread');
    expect(task.context.threadId).toBe('trusted-thread');
    expect(task.requestId).toEqual(expect.any(String));
    expect(task.nonce).toEqual(expect.any(String));
    expect(Date.parse(task.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('submits agent-created skills as host-reviewed proposal tasks', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'request_skill_proposal', {
      files: [
        {
          path: 'SKILL.md',
          content: [
            '---',
            'name: LinkedIn Posting',
            'description: Draft LinkedIn posts',
            '---',
            '# LinkedIn Posting',
          ].join('\n'),
        },
      ],
      reason: 'Reuse a posting workflow.',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const taskFiles = fs.readdirSync(path.join(fixture.ipcDir, 'tasks'));
    expect(taskFiles).toHaveLength(1);
    const task = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'tasks', taskFiles[0]),
        'utf-8',
      ),
    );
    expect(task).toMatchObject({
      type: 'request_skill_proposal',
      targetJid: 'tg:team',
      chatJid: 'tg:team',
      payload: {
        reason: 'Reuse a posting workflow.',
        files: [
          expect.objectContaining({
            path: 'SKILL.md',
            content: expect.stringContaining('LinkedIn Posting'),
          }),
        ],
      },
    });
  });

  it('submits skill proposals through the documented request tool name', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'request_skill_proposal', {
      files: [
        {
          path: 'SKILL.md',
          content: [
            '---',
            'name: Proposal Skill',
            'description: Proposed skill bundle',
            '---',
            '# Proposal Skill',
          ].join('\n'),
        },
      ],
      reason: 'Review a proposed workflow.',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const taskFiles = fs.readdirSync(path.join(fixture.ipcDir, 'tasks'));
    expect(taskFiles).toHaveLength(1);
    const task = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'tasks', taskFiles[0]),
        'utf-8',
      ),
    );
    expect(task).toMatchObject({
      type: 'request_skill_proposal',
      targetJid: 'tg:team',
      chatJid: 'tg:team',
      payload: {
        reason: 'Review a proposed workflow.',
        files: [
          expect.objectContaining({
            path: 'SKILL.md',
            content: expect.stringContaining('Proposal Skill'),
          }),
        ],
      },
    });
  });

  it.each([
    [
      'request_skill_install',
      {
        spec: 'clawhub:release-notes@1.0.0',
        provider: 'clawhub',
        slug: 'release-notes',
        version: '1.0.0',
        reason: 'Reuse a reviewed release workflow.',
      },
      {
        spec: 'clawhub:release-notes@1.0.0',
        provider: 'clawhub',
        slug: 'release-notes',
        version: '1.0.0',
        reason: 'Reuse a reviewed release workflow.',
      },
    ],
    [
      'request_skill_dependency_install',
      {
        ecosystem: 'npm',
        packages: ['tsx'],
        commandArgv: ['npm', 'install', 'tsx'],
        skillName: 'Release Notes',
        reason: 'The reviewed skill needs tsx.',
      },
      {
        ecosystem: 'npm',
        packages: ['tsx'],
        commandArgv: ['npm', 'install', 'tsx'],
        skillName: 'Release Notes',
        reason: 'The reviewed skill needs tsx.',
      },
    ],
    [
      'request_permission',
      {
        permissionKind: 'tool',
        toolName: 'Bash',
        toolNames: ['Read'],
        rule: 'npm run test *',
        temporaryOnly: false,
        broadAccess: false,
        toolCategory: 'sdk',
        permissionPolicy: 'scoped persistent',
        sandboxProfile: 'workspace-write',
        reason: 'Run project tests and inspect files.',
      },
      {
        permissionKind: 'tool',
        toolName: 'Bash',
        toolNames: ['Read'],
        rule: 'npm run test *',
        temporaryOnly: false,
        broadAccess: false,
        toolCategory: 'sdk',
        permissionPolicy: 'scoped persistent',
        sandboxProfile: 'workspace-write',
        reason: 'Run project tests and inspect files.',
      },
    ],
    [
      'request_permission',
      {
        permissionKind: 'provider_capability',
        channelTool: 'slack_file_access',
        providerId: 'slack',
        requiredScopes: ['files:read'],
        affectedConversations: ['C123'],
        reason: 'Read files shared in the active channel.',
      },
      {
        permissionKind: 'provider_capability',
        channelTool: 'slack_file_access',
        providerId: 'slack',
        requiredScopes: ['files:read'],
        affectedConversations: ['C123'],
        reason: 'Read files shared in the active channel.',
      },
    ],
  ])(
    'submits %s as a host-reviewed capability task',
    async (toolName, args, payload) => {
      const fixture = createMcpFixture();

      const result = await runMcpFixture(fixture, toolName, args);

      expect(result.exitCode, result.stderr).toBe(0);
      const taskFiles = fs.readdirSync(path.join(fixture.ipcDir, 'tasks'));
      expect(taskFiles).toHaveLength(1);
      const task = JSON.parse(
        fs.readFileSync(
          path.join(fixture.ipcDir, 'tasks', taskFiles[0]),
          'utf-8',
        ),
      );
      expect(task).toMatchObject({
        type: toolName,
        targetJid: 'tg:team',
        chatJid: 'tg:team',
        payload,
      });
    },
  );

  it('rejects unsigned task responses from the host boundary', async () => {
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
      { TEST_MCP_UNSIGNED_TASK_RESPONSE: '1' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'Invalid task response signature',
    );
  });

  it('reads scheduler jobs from signed IPC data responses', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_list_jobs',
      {
        statuses: ['active'],
      },
      {
        TEST_MCP_TASK_RESPONSE_DATA: JSON.stringify({
          jobs: [{ id: 'job-1', status: 'active', group_scope: 'team' }],
        }),
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain('"id": "job-1"');

    const taskFiles = fs.readdirSync(path.join(fixture.ipcDir, 'tasks'));
    const task = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'tasks', taskFiles[0]),
        'utf-8',
      ),
    );
    expect(task).toMatchObject({
      type: 'scheduler_list_jobs',
      chatJid: 'tg:team',
      targetJid: 'tg:team',
      statuses: ['active'],
    });
  });

  it('queues scheduler_run_now through signed IPC and returns the run data', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_run_now',
      {
        job_id: 'job-1',
      },
      {
        TEST_MCP_TASK_RESPONSE_DATA: JSON.stringify({
          run_id: 'run-1',
          queued: true,
          trigger_id: 'trigger-1',
        }),
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain('"run_id": "run-1"');

    const taskFiles = fs.readdirSync(path.join(fixture.ipcDir, 'tasks'));
    const task = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'tasks', taskFiles[0]),
        'utf-8',
      ),
    );
    expect(task).toMatchObject({
      type: 'scheduler_run_now',
      jobId: 'job-1',
      chatJid: 'tg:team',
      targetJid: 'tg:team',
    });
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
        model_alias: 'sonnet',
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
    expect(task.modelAlias).toBe('sonnet');
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

  it('forwards explicit null thread updates for host authorization', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_update_job',
      {
        job_id: 'job-1',
        prompt: 'Updated prompt',
        thread_id: null,
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
    expect(task.threadId).toBeNull();
  });

  it('allows scheduler updates to clear explicit model selection', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_update_job',
      {
        job_id: 'job-1',
        model_alias: null,
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
    expect(task.modelAlias).toBeNull();
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
