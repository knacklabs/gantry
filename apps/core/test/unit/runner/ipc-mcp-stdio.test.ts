import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { generateKeyPairSync } from 'crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { schedulerJobConfirmationToken } from '@core/jobs/job-plan-formatter.js';
import { ALL_GANTRY_MCP_TOOL_NAMES } from '@agent-runner-src/gantry-mcp-tool-surface.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-mcp-test-'));
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
  const jobsDir = path.join(root, 'jobs');
  const sharedDir = path.join(root, 'shared');
  const sharedTimeDir = path.join(sharedDir, 'time');
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
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(sharedTimeDir, { recursive: true });
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
    path.resolve('apps/core/src/shared/scheduler-job-plan.ts'),
    path.join(sharedDir, 'scheduler-job-plan.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/human-format.ts'),
    path.join(sharedDir, 'human-format.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/admin-mcp-tools.ts'),
    path.join(sharedDir, 'admin-mcp-tools.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/agent-tool-references.ts'),
    path.join(sharedDir, 'agent-tool-references.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/gantry-tool-facades.ts'),
    path.join(sharedDir, 'gantry-tool-facades.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/bash-command-parser.ts'),
    path.join(sharedDir, 'bash-command-parser.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/semantic-capability-ids.ts'),
    path.join(sharedDir, 'semantic-capability-ids.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/neutral-ca-trust-env.ts'),
    path.join(sharedDir, 'neutral-ca-trust-env.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/semantic-capabilities.ts'),
    path.join(sharedDir, 'semantic-capabilities.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/job-setup-labels.ts'),
    path.join(sharedDir, 'job-setup-labels.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/user-visible-messages.ts'),
    path.join(sharedDir, 'user-visible-messages.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/path-validation.ts'),
    path.join(sharedDir, 'path-validation.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/memory-ipc-actions.ts'),
    path.join(sharedDir, 'memory-ipc-actions.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/memory-timeouts.ts'),
    path.join(runnerDir, 'memory-timeouts.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/gantry-mcp-tool-surface.ts'),
    path.join(runnerDir, 'gantry-mcp-tool-surface.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/jobs/job-plan-formatter.ts'),
    path.join(jobsDir, 'job-plan-formatter.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/private-fs.ts'),
    path.join(sharedDir, 'private-fs.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/live-tool-rules.ts'),
    path.join(sharedDir, 'live-tool-rules.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/tool-access-view.ts'),
    path.join(sharedDir, 'tool-access-view.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/tool-rule-matcher.ts'),
    path.join(sharedDir, 'tool-rule-matcher.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/time/datetime.ts'),
    path.join(sharedTimeDir, 'datetime.ts'),
  );
  symlinkPackage(root, 'zod', 'node_modules/zod');
  symlinkPackage(root, 'cron-parser', 'node_modules/cron-parser');
  symlinkPackage(root, '@gantry/contracts', 'packages/contracts');

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
    const ipcDir = process.env.GANTRY_IPC_DIR;

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
        GANTRY_IPC_DIR: fixture.ipcDir,
        GANTRY_IPC_AUTH_TOKEN: 'mcp-test-token',
        GANTRY_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
        GANTRY_IPC_RESPONSE_KEY_ID: 'mcp-test-response-key-id',
        TEST_IPC_RESPONSE_SIGNING_KEY: fixture.responseSigningKey,
        GANTRY_CHAT_JID: 'tg:team',
        GANTRY_GROUP_FOLDER: 'team',
        GANTRY_AGENT_RUN_HANDLE: 'mcp-test-run',
        GANTRY_ADMIN_MCP_TOOLS_JSON: '[]',
        GANTRY_MCP_TOOL_NAMES_JSON: JSON.stringify(ALL_GANTRY_MCP_TOOL_NAMES),
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
    }, 30_000);
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

describe('agent-runner MCP stdio tools', { timeout: 35_000 }, () => {
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
        sourceAgentFolder: 'team',
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

  it('shows unavailable admin tools without exposing raw grant internals', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'capability_status', {});

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain(
      'available: mcp__gantry__scheduler_list_jobs',
    );
    expect(record.result.content[0].text).toContain(
      'requestable: mcp__gantry__service_restart',
    );
    expect(record.result.content[0].text).not.toContain(
      'tool_id: tool:mcp__gantry__service_restart',
    );
    expect(record.result.content[0].text).not.toContain(
      'request_permission: permissionKind=tool toolName=mcp__gantry__service_restart temporaryOnly=false',
    );
    expect(record.result.content[0].text).toContain('requestable: Browser');
    expect(record.result.content[0].text).not.toContain(
      'tool_id: tool:Browser',
    );
    expect(record.result.content[0].text).not.toContain(
      'request_permission: permissionKind=tool toolName=Browser toolCategory=browser temporaryOnly=false',
    );
    expect(record.result.content[0].text).toContain(
      'Browser approval exposes Gantry-owned browser_* tools',
    );
  });

  it('shows configured tools, selected skills, and selected MCP servers', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'capability_status',
      {},
      {
        GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: '["RunCommand(npm test *)"]',
        GANTRY_SELECTED_SKILLS_JSON: '["skill:release"]',
        GANTRY_SELECTED_MCP_SERVERS_JSON: '["mcp:github"]',
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain(
      'Configured tools: RunCommand(npm test *)',
    );
    expect(record.result.content[0].text).toContain('ready: skill:release');
    expect(record.result.content[0].text).toContain('ready: mcp:github');
  });

  it('registers selected admin tools and reports remaining requestable tools', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'service_restart',
      {},
      { GANTRY_ADMIN_MCP_TOOLS_JSON: '["service_restart"]' },
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
    expect(task.chatJid).toBe('tg:team');
    expect(task.targetJid).toBe('tg:team');

    const statusFixture = createMcpFixture();
    const statusResult = await runMcpFixture(
      statusFixture,
      'capability_status',
      {},
      { GANTRY_ADMIN_MCP_TOOLS_JSON: '["service_restart"]' },
    );
    expect(statusResult.exitCode, statusResult.stderr).toBe(0);
    const statusRecord = JSON.parse(
      fs.readFileSync(statusFixture.resultPath, 'utf-8'),
    );
    expect(statusRecord.result.content[0].text).toContain(
      'available: mcp__gantry__service_restart',
    );
    expect(statusRecord.result.content[0].text).toContain(
      'requestable: mcp__gantry__register_agent',
    );
  }, 40_000);

  it('keeps unselected admin tools gated at call time', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'service_restart', {});

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'Gantry Service Restart is not approved for this agent yet.',
    );
    expect(record.result.content[0].text).toContain(
      'Ask a configured conversation approver to approve it, then choose Always allow.',
    );
    expect(fs.existsSync(path.join(fixture.ipcDir, 'tasks'))).toBe(false);
  });

  it('lists admin permissions from the runner read-only view when selected', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'admin_permission_list',
      {},
      {
        GANTRY_ADMIN_MCP_TOOLS_JSON: '["admin_permission_list"]',
        GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: '["RunCommand(npm test *)"]',
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain(
      'Admin permission inventory (read-only runner view):',
    );
    expect(record.result.content[0].text).toContain(
      'mcp__gantry__admin_permission_list: approved',
    );
    expect(record.result.content[0].text).toContain('RunCommand(npm test *)');
    expect(fs.existsSync(path.join(fixture.ipcDir, 'tasks'))).toBe(false);
  });

  it('submits admin permission revoke as a host-owned task', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'admin_permission_revoke',
      {
        tool_name: 'mcp__gantry__service_restart',
        reason: 'Reduce admin surface',
      },
      { GANTRY_ADMIN_MCP_TOOLS_JSON: '["admin_permission_revoke"]' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain(
      'Scheduler task confirmed.',
    );
    const taskFiles = fs.readdirSync(path.join(fixture.ipcDir, 'tasks'));
    expect(taskFiles).toHaveLength(1);
    const task = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'tasks', taskFiles[0]),
        'utf-8',
      ),
    );
    expect(task).toMatchObject({
      type: 'admin_permission_revoke',
      runHandle: 'mcp-test-run',
      payload: {
        toolName: 'mcp__gantry__service_restart',
        reason: 'Reduce admin surface',
      },
      chatJid: 'tg:team',
      targetJid: 'tg:team',
    });
  });

  it('activates admin MCP tools from live persistent approval rules', async () => {
    const fixture = createMcpFixture();
    const liveRuleDir = path.join(fixture.ipcDir, 'live-tool-rules');
    fs.mkdirSync(liveRuleDir, { recursive: true });
    fs.writeFileSync(
      path.join(liveRuleDir, 'mcp-test-run.json'),
      JSON.stringify(['mcp__gantry__service_restart']),
    );

    const statusResult = await runMcpFixture(fixture, 'capability_status', {});
    expect(statusResult.exitCode, statusResult.stderr).toBe(0);
    const statusRecord = JSON.parse(
      fs.readFileSync(fixture.resultPath, 'utf-8'),
    );
    expect(statusRecord.result.content[0].text).toContain(
      'available: mcp__gantry__service_restart',
    );

    const result = await runMcpFixture(fixture, 'service_restart', {});
    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain(
      'Scheduler task confirmed.',
    );
  });

  it('keeps default first-party MCP tools registered despite stale runner projection', async () => {
    const fixture = createMcpFixture();
    const staleSurface = JSON.stringify([
      'send_message',
      'ask_user_question',
      'memory_search',
      'memory_save',
      'procedure_save',
      'browser',
      'request_skill_install',
      'request_skill_proposal',
      'request_skill_dependency_install',
      'request_mcp_server',
      'request_permission',
      'capability_status',
      'mcp_list_tools',
      'mcp_call_tool',
    ]);

    const scheduler = await runMcpFixture(
      fixture,
      'scheduler_list_models',
      {},
      { GANTRY_MCP_TOOL_NAMES_JSON: staleSurface },
    );

    expect(scheduler.exitCode, scheduler.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain('Supported model aliases');

    const hiddenAdmin = await runMcpFixture(
      fixture,
      'service_restart',
      {},
      { GANTRY_MCP_TOOL_NAMES_JSON: staleSurface },
    );
    expect(hiddenAdmin.exitCode, hiddenAdmin.stderr).toBe(0);
    const adminRecord = JSON.parse(
      fs.readFileSync(fixture.resultPath, 'utf-8'),
    );
    expect(adminRecord.result.isError).toBe(true);
    expect(adminRecord.result.content[0].text).toContain(
      'Gantry Service Restart is not approved for this agent yet.',
    );
  });

  it('suppresses direct send_message output for scheduled jobs', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'send_message',
      { text: 'Mode B: 0 leads.' },
      { GANTRY_JOB_ID: 'job-1' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain(
      'Scheduled job message suppressed.',
    );
    expect(fs.existsSync(path.join(fixture.ipcDir, 'messages'))).toBe(false);
  });

  it('defaults to first-party MCP tools when runner projection is missing', async () => {
    const fixture = createMcpFixture();

    const scheduler = await runMcpFixture(
      fixture,
      'scheduler_list_models',
      {},
      { GANTRY_MCP_TOOL_NAMES_JSON: undefined },
    );

    expect(scheduler.exitCode, scheduler.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain('Supported model aliases');
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
        confirm: true,
        confirmation_token: schedulerJobConfirmationToken({
          name: 'Daily review',
          prompt: 'Review memory',
          modelAlias: 'kimi 2.6',
          scheduleType: 'interval',
          scheduleValue: '60000',
          executionContext: {
            conversationJid: 'tg:team',
            threadId: 'trusted-thread',
            groupScope: 'team',
          },
          notificationRoutes: [
            {
              conversationJid: 'tg:team',
              threadId: 'trusted-thread',
              label: 'primary',
            },
          ],
          createdBy: 'agent',
        }),
      },
      { GANTRY_THREAD_ID: 'trusted-thread' },
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
    expect(task.executionContext).toEqual(
      expect.objectContaining({
        conversationJid: 'tg:team',
        threadId: 'trusted-thread',
        groupScope: 'team',
      }),
    );
    expect(task.notificationRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationJid: 'tg:team',
          threadId: 'trusted-thread',
        }),
      ]),
    );
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
        files: [
          {
            path: 'SKILL.md',
            content: [
              '---',
              'name: Release Notes',
              'description: Drafts release notes',
              '---',
              '# Release Notes',
            ].join('\n'),
          },
        ],
        reason: 'Reuse a reviewed release workflow.',
      },
      {
        files: [
          expect.objectContaining({
            path: 'SKILL.md',
            content: expect.stringContaining('Release Notes'),
          }),
        ],
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
        permissionPolicy: 'persistent',
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
        permissionPolicy: 'persistent',
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

  it('submits local CLI propose_capability as a reviewed capability proposal even for a built-in capability id', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'propose_capability', {
      capabilityId: 'google.sheets.write',
      displayName: 'Google Sheets write using gog',
      category: 'Local CLI',
      risk: 'write',
      source: 'local_cli',
      credentialSource: 'local_cli',
      accountLabel: 'gog',
      can: 'Append reviewed rows to Google Sheets through gog.',
      cannot: 'Run commands outside the reviewed templates.',
      executablePath: '/usr/local/bin/gog',
      executableVersion: 'v0.9.0',
      executableHash: 'sha256:abc123',
      commandTemplates: ['/usr/local/bin/gog sheets append *'],
      authPreflightCommand: '/usr/local/bin/gog auth status',
      protectedPaths: ['~/.config/gog/*'],
      reason: 'This job writes lead rows after each run.',
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
      type: 'request_permission',
      targetJid: 'tg:team',
      chatJid: 'tg:team',
      payload: {
        capabilityRequestSource: 'propose_capability',
        capabilityId: 'google.sheets.write',
        source: 'local_cli',
        credentialSource: 'local_cli',
        executablePath: '/usr/local/bin/gog',
        executableVersion: 'v0.9.0',
        executableHash: 'sha256:abc123',
        commandTemplates: ['/usr/local/bin/gog sheets append *'],
      },
    });
  });

  it('rejects browser-control skill install requests with request_permission guidance', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'request_skill_install', {
      expectedFiles: ['browser'],
      reason: 'Install browser automation as a skill.',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    const taskFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
    expect(taskFiles).toHaveLength(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'Browser control is a built-in Gantry tool capability',
    );
    expect(record.result.content[0].text).toContain(
      'Ask a configured conversation approver to approve Browser access',
    );
    expect(record.result.content[0].text).not.toContain('temporaryOnly=false');
    expect(record.result.content[0].text).not.toContain('temporaryOnly=true');
    expect(record.result.content[0].text).toContain(
      'No install request was recorded.',
    );
  });

  it('rejects browser-control third-party MCP requests with request_permission guidance', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'request_mcp_server', {
      name: `${'browser'}_${'backend'}`,
      transport: 'http',
      origin: 'https://example.test/browser/control',
      requestedToolPatterns: ['browser_*', 'page_*'],
      reason: 'Use a browser-control server.',
      docsUrl: 'https://example.test/browser-control',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    const taskFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
    expect(taskFiles).toHaveLength(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'Browser control is a built-in Gantry tool capability',
    );
    expect(record.result.content[0].text).toContain(
      'Ask a configured conversation approver to approve Browser access',
    );
    expect(record.result.content[0].text).toContain('the browser tools');
    expect(record.result.content[0].text).not.toContain('temporaryOnly=true');
    expect(record.result.content[0].text).toContain(
      'No install request was recorded.',
    );
  });

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
        confirm: true,
        confirmation_token: schedulerJobConfirmationToken({
          name: 'Daily review',
          prompt: 'Review memory',
          scheduleType: 'interval',
          scheduleValue: '60000',
          executionContext: {
            conversationJid: 'tg:team',
            threadId: null,
            groupScope: 'team',
          },
          notificationRoutes: [
            {
              conversationJid: 'tg:team',
              threadId: null,
              label: 'primary',
            },
          ],
          createdBy: 'agent',
        }),
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

  it('rejects non-canonical scheduler thread_id field on upsert', async () => {
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
      { GANTRY_THREAD_ID: 'trusted-thread' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    const taskFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
    expect(taskFiles).toHaveLength(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'Unsupported scheduler fields: thread_id. Use execution_context and notification_routes for routing.',
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
      { GANTRY_THREAD_ID: 'trusted-thread' },
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
        target: 'this_thread',
      },
      { GANTRY_THREAD_ID: 'trusted-thread' },
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
    expect(task.executionContext).toEqual(
      expect.objectContaining({
        conversationJid: 'tg:team',
        threadId: 'trusted-thread',
        groupScope: 'team',
      }),
    );
    expect(task.notificationRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationJid: 'tg:team',
          threadId: 'trusted-thread',
          label: 'this_thread',
        }),
      ]),
    );
  });

  it('forwards explicit null thread updates for host authorization', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_update_job',
      {
        job_id: 'job-1',
        prompt: 'Updated prompt',
        execution_context: {
          conversation_jid: 'tg:team',
          thread_id: null,
          group_scope: 'team',
        },
        notification_routes: [
          {
            conversation_jid: 'tg:team',
            thread_id: null,
            label: 'primary',
          },
        ],
      },
      { GANTRY_THREAD_ID: 'trusted-thread' },
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
    expect(task.executionContext).toEqual(
      expect.objectContaining({
        conversationJid: 'tg:team',
        threadId: null,
        groupScope: 'team',
      }),
    );
    expect(task.notificationRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationJid: 'tg:team',
          threadId: null,
          label: 'primary',
        }),
      ]),
    );
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
      { GANTRY_THREAD_ID: 'trusted-thread' },
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

  it('rejects non-canonical scheduler thread_id field on update', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'scheduler_update_job',
      {
        job_id: 'job-1',
        prompt: 'Updated prompt',
        thread_id: 'attacker-thread',
      },
      { GANTRY_THREAD_ID: '' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    const taskFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
    expect(taskFiles).toHaveLength(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'Unsupported scheduler fields: thread_id. Use execution_context and notification_routes for routing.',
    );
  });
});
