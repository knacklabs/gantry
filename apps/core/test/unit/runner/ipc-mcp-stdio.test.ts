import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { fileURLToPath } from 'url';

import { afterEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';

import { schedulerJobConfirmationToken } from '@core/shared/scheduler-job-plan.js';
import { ALL_GANTRY_MCP_TOOL_NAMES } from '@agent-runner-src/gantry-mcp-tool-surface.js';
import { ITOPS_NATIVE_TOOL_NAMES } from '@agent-runner-src/itops-native-tool-surface.js';

const MCP_FIXTURE_TIMEOUT_MS = 60_000;
const ITOPS_NATIVE_TOOL_NAME_SET = new Set<string>(ITOPS_NATIVE_TOOL_NAMES);
const tempRoots: string[] = [];
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

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
  fs.symlinkSync(
    path.isAbsolute(target) ? target : path.join(repoRoot, target),
    packagePath,
    'dir',
  );
}

function copyBuiltContractsPackage(root: string): void {
  const packagePath = path.join(root, 'node_modules', '@gantry', 'contracts');
  fs.mkdirSync(packagePath, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'packages/contracts/package.json'),
    path.join(packagePath, 'package.json'),
  );
  copyDirectory(
    path.join(repoRoot, 'packages/contracts/dist'),
    path.join(packagePath, 'dist'),
  );
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
  const integrationsDir = path.join(root, 'integrations');
  const channelsDir = path.join(root, 'channels');
  const applicationMcpDir = path.join(root, 'application', 'mcp');
  const sharedDir = path.join(root, 'shared');
  const sharedTimeDir = path.join(sharedDir, 'time');
  const guidedActionsDir = path.join(root, 'application', 'guided-actions');
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
  fs.mkdirSync(integrationsDir, { recursive: true });
  fs.mkdirSync(channelsDir, { recursive: true });
  fs.mkdirSync(applicationMcpDir, { recursive: true });
  fs.mkdirSync(guidedActionsDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(sharedTimeDir, { recursive: true });
  fs.mkdirSync(sdkServerDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ type: 'module' }),
  );
  copyDirectory(path.resolve('apps/core/src/runner/mcp'), runnerMcpDir);
  copyDirectory(
    path.resolve('apps/core/src/integrations/itops'),
    path.join(integrationsDir, 'itops'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/callable-agent-manifest.ts'),
    path.join(sharedDir, 'callable-agent-manifest.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/canonical-json.ts'),
    path.join(sharedDir, 'canonical-json.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/ipc-signing.ts'),
    path.join(sharedDir, 'ipc-signing.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-catalog.ts'),
    path.join(sharedDir, 'model-catalog.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-catalog-provider-metadata.ts'),
    path.join(sharedDir, 'model-catalog-provider-metadata.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-catalog-lookup.ts'),
    path.join(sharedDir, 'model-catalog-lookup.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-provider-registry.ts'),
    path.join(sharedDir, 'model-provider-registry.ts'),
  );
  fs.copyFileSync(
    path.resolve(
      'apps/core/src/shared/model-provider-registry-openai-compatible.ts',
    ),
    path.join(sharedDir, 'model-provider-registry-openai-compatible.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-catalog-openai-compatible.ts'),
    path.join(sharedDir, 'model-catalog-openai-compatible.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-catalog-bedrock.ts'),
    path.join(sharedDir, 'model-catalog-bedrock.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/agent-engine.ts'),
    path.join(sharedDir, 'agent-engine.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-cache-support.ts'),
    path.join(sharedDir, 'model-cache-support.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-catalog-format.ts'),
    path.join(sharedDir, 'model-catalog-format.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-recommendation.ts'),
    path.join(sharedDir, 'model-recommendation.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-execution-route.ts'),
    path.join(sharedDir, 'model-execution-route.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-catalog-availability.ts'),
    path.join(sharedDir, 'model-catalog-availability.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-families.ts'),
    path.join(sharedDir, 'model-families.ts'),
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
    path.resolve('apps/core/src/shared/operator-error.ts'),
    path.join(sharedDir, 'operator-error.ts'),
  );
  fs.copyFileSync(
    path.resolve(
      'apps/core/src/application/guided-actions/guided-action-model.ts',
    ),
    path.join(guidedActionsDir, 'guided-action-model.ts'),
  );
  fs.copyFileSync(
    path.resolve(
      'apps/core/src/application/guided-actions/guided-action-service.ts',
    ),
    path.join(guidedActionsDir, 'guided-action-service.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/application/mcp/mcp-tool-output-bounds.ts'),
    path.join(applicationMcpDir, 'mcp-tool-output-bounds.ts'),
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
    path.resolve('apps/core/src/shared/durable-access-policy.ts'),
    path.join(sharedDir, 'durable-access-policy.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/sensitive-material.ts'),
    path.join(sharedDir, 'sensitive-material.ts'),
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
    path.resolve('apps/core/src/shared/network-host-declaration.ts'),
    path.join(sharedDir, 'network-host-declaration.ts'),
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
    path.resolve('apps/core/src/channels/provider-delivery-labels.ts'),
    path.join(channelsDir, 'provider-delivery-labels.ts'),
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
    path.resolve('apps/core/src/runner/ipc-response-wait.ts'),
    path.join(runnerDir, 'ipc-response-wait.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/gantry-mcp-tool-surface.ts'),
    path.join(runnerDir, 'gantry-mcp-tool-surface.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/itops-native-tool-surface.ts'),
    path.join(runnerDir, 'itops-native-tool-surface.ts'),
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
    path.resolve('apps/core/src/shared/capability-guidance.ts'),
    path.join(sharedDir, 'capability-guidance.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/generated-runtime-paths.ts'),
    path.join(sharedDir, 'generated-runtime-paths.ts'),
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
  copyBuiltContractsPackage(root);

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

const delay = (ms) =>
  new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
const tools = new Map();
const interactionBoundaryWaitMs = 5000;
const taskRequestWaitMs = 30000;

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
  const deadline = Date.now() + interactionBoundaryWaitMs;
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
  const deadline = Date.now() + taskRequestWaitMs;
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
  tool(name, ...args) {
    const handler = args.findLast((arg) => typeof arg === 'function');
    tools.set(name, handler);
  }

  async connect() {
    const toolName = process.env.TEST_MCP_TOOL_NAME;
    const handler = tools.get(toolName);
    if (!handler) {
      throw new Error(
        'tool not registered: ' +
          toolName +
          '; registered=' +
          JSON.stringify([...tools.keys()].sort()) +
          '; noPermission=' +
          String(process.env.GANTRY_NO_PERMISSION_TOOLS),
      );
    }
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
          ok: process.env.TEST_MCP_TASK_RESPONSE_OK !== '0',
          ...(process.env.TEST_MCP_TASK_RESPONSE_OK === '0'
            ? {
                code: process.env.TEST_MCP_TASK_RESPONSE_CODE || 'unavailable',
                error:
                  process.env.TEST_MCP_TASK_RESPONSE_ERROR ||
                  'Task is unavailable.',
              }
            : { message: 'Scheduler task confirmed.' }),
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

function fixtureProcessEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GANTRY_') && !key.startsWith('TEST_MCP_'),
    ),
  );
}

async function runMcpFixture(
  fixture: ReturnType<typeof createMcpFixture>,
  toolName: string,
  args: Record<string, unknown>,
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const bundledServerPath = path.join(fixture.root, 'stdio.mjs');
  buildSync({
    entryPoints: [fixture.serverPath],
    outfile: bundledServerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
  });
  const child = spawn(process.execPath, [bundledServerPath], {
    cwd: fixture.root,
    env: {
      ...fixtureProcessEnv(),
      GANTRY_IPC_DIR: fixture.ipcDir,
      GANTRY_IPC_AUTH_TOKEN: 'mcp-test-token',
      GANTRY_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
      GANTRY_IPC_RESPONSE_KEY_ID: 'mcp-test-response-key-id',
      TEST_IPC_RESPONSE_SIGNING_KEY: fixture.responseSigningKey,
      GANTRY_CHAT_JID: 'tg:team',
      GANTRY_WORKSPACE_KEY: 'team',
      GANTRY_AGENT_RUN_HANDLE: 'mcp-test-run',
      GANTRY_NO_PERMISSION_TOOLS: '',
      GANTRY_ADMIN_MCP_TOOLS_JSON: '[]',
      GANTRY_MCP_TOOL_NAMES_JSON: JSON.stringify(
        ALL_GANTRY_MCP_TOOL_NAMES.filter(
          (name) => !ITOPS_NATIVE_TOOL_NAME_SET.has(name),
        ),
      ),
      ...envOverrides,
      TEST_MCP_TOOL_NAME: toolName,
      TEST_MCP_TOOL_ARGS: JSON.stringify(args),
      TEST_MCP_RESULT_PATH: fixture.resultPath,
      TEST_MCP_ANSWER_QUESTION: toolName === 'ask_user_question' ? '1' : '0',
      TEST_MCP_AUTO_RESPOND_TASKS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, MCP_FIXTURE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(
            `MCP fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolve(code);
    });
  });

  return { exitCode, stdout, stderr };
}

function writeLiveToolRules(
  fixture: ReturnType<typeof createMcpFixture>,
  rules: readonly string[],
): void {
  const liveRuleDir = path.join(fixture.ipcDir, 'live-tool-rules');
  fs.mkdirSync(liveRuleDir, { recursive: true });
  fs.writeFileSync(
    path.join(liveRuleDir, 'mcp-test-run.json'),
    JSON.stringify(rules),
  );
}

function cawAtsMcpCapability(mcpTool: string): Record<string, unknown> {
  const allowedToolPattern = mcpTool.split('__').pop() || 'ats_list_positions';
  return {
    capabilityId: 'mcp.caw-ats.access',
    version: '1',
    displayName: 'caw-ats MCP access',
    category: 'MCP',
    risk: 'write',
    can: 'Call approved tools on the caw-ats MCP server.',
    cannot: 'Call unapproved MCP tools or receive raw credentials.',
    credentialSource: 'none',
    implementationBindings: [
      {
        kind: 'mcp_pattern',
        mcpServer: 'caw-ats',
        mcpToolPatterns: [allowedToolPattern],
      },
    ],
    source: {
      source: 'mcp',
      serverName: 'caw-ats',
      allowedToolPatterns: [allowedToolPattern],
    },
  };
}

describe('agent-runner MCP stdio tools', { timeout: 70_000 }, () => {
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

  it(
    'registers selected admin tools and reports remaining requestable tools',
    async () => {
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
    },
    MCP_FIXTURE_TIMEOUT_MS,
  );

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
      'Ask a configured conversation approver to approve service_restart, then choose persistent access.',
    );
    expect(fs.existsSync(path.join(fixture.ipcDir, 'tasks'))).toBe(false);
  });

  it('lists admin permissions from the runner read-only view without a grant', async () => {
    const fixture = createMcpFixture();
    fs.mkdirSync(path.join(fixture.ipcDir, 'live-tool-rules'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(fixture.ipcDir, 'live-tool-rules', 'run-1.json'),
      JSON.stringify(['capability:acme.records.append']),
    );

    const result = await runMcpFixture(
      fixture,
      'admin_permission_list',
      {},
      {
        GANTRY_AGENT_RUN_HANDLE: 'run-1',
        GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: '["RunCommand(npm test *)"]',
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain(
      'Admin permission inventory (read-only runner view):',
    );
    expect(record.result.content[0].text).toContain(
      'mcp__gantry__admin_permission_list: available (read-only)',
    );
    expect(record.result.content[0].text).toContain('RunCommand(npm test *)');
    expect(record.result.content[0].text).toContain(
      'capability:acme.records.append',
    );
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
    writeLiveToolRules(fixture, ['mcp__gantry__service_restart']);

    const result = await runMcpFixture(fixture, 'service_restart', {});
    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain(
      'Scheduler task confirmed.',
    );
  });

  it('includes the current run fence on proxied MCP tool calls', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'mcp_call_tool',
      {
        serverName: 'github',
        toolName: 'create_issue',
        arguments: { title: 'Bug' },
      },
      {
        GANTRY_JOB_RUN_ID: 'job-run-1',
        GANTRY_JOB_RUN_LEASE_TOKEN: 'lease-1',
        GANTRY_JOB_RUN_LEASE_FENCING_VERSION: '7',
      },
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
    expect(task).toMatchObject({
      type: 'mcp_call_tool',
      runHandle: 'mcp-test-run',
      runId: 'job-run-1',
      runLeaseToken: 'lease-1',
      runLeaseFencingVersion: 7,
      payload: {
        serverName: 'github',
        toolName: 'create_issue',
        arguments: { title: 'Bug' },
      },
    });
  });

  it('preserves structured remote MCP failures for the model', async () => {
    const fixture = createMcpFixture();
    const remoteResult = {
      content: [{ type: 'text', text: 'Remote validation failed.' }],
      structuredContent: { field: 'account_id', reason: 'missing' },
      isError: true,
      error: {
        category: 'business',
        isRetryable: false,
        message: 'Remote validation failed.',
      },
    };

    const result = await runMcpFixture(
      fixture,
      'mcp_call_tool',
      { serverName: 'crm', toolName: 'lookup' },
      { TEST_MCP_TASK_RESPONSE_DATA: JSON.stringify(remoteResult) },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result).toMatchObject({
      content: remoteResult.content,
      structuredContent: remoteResult.structuredContent,
      error: remoteResult.error,
    });
    expect(record.result.isError).toBeUndefined();
  });

  it('returns host MCP rejections as recoverable model-visible results', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'mcp_call_tool',
      { serverName: 'ats', toolName: 'ats_list_client_projects' },
      {
        TEST_MCP_TASK_RESPONSE_OK: '0',
        TEST_MCP_TASK_RESPONSE_CODE: 'invalid_request',
        TEST_MCP_TASK_RESPONSE_ERROR: 'The client field is required.',
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBeUndefined();
    expect(record.result.content[0].text).toContain(
      'The client field is required.',
    );
    expect(record.result.content[0].text).toContain(
      'ask the user for missing information',
    );
  });

  it('writes MCP tool detail requests through IPC without execution arguments', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'mcp_describe_tool', {
      serverName: 'github',
      toolName: 'create_issue',
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
      type: 'mcp_describe_tool',
      payload: {
        serverName: 'github',
        toolName: 'create_issue',
      },
    });
    expect(task.runHandle).toBeUndefined();
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
      'request_access',
      'mcp_list_tools',
      'mcp_call_tool',
      'service_restart',
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

  it('includes the trusted provider account in send_message IPC', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'send_message',
      { text: 'Account-scoped update.' },
      { GANTRY_PROVIDER_ACCOUNT_ID: 'provider-account:slack:a' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const messageFiles = fs.readdirSync(path.join(fixture.ipcDir, 'messages'));
    expect(messageFiles).toHaveLength(1);
    const message = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'messages', messageFiles[0]),
        'utf-8',
      ),
    );
    expect(message.providerAccountId).toBe('provider-account:slack:a');
    expect(message.context.providerAccountId).toBe('provider-account:slack:a');
  });

  it('accepts source-less FileArtifact refs in send_message IPC', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'send_message', {
      text: 'Artifact attached.',
      files: [{ path: 'reports/status.txt' }],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const messageFiles = fs.readdirSync(path.join(fixture.ipcDir, 'messages'));
    expect(messageFiles).toHaveLength(1);
    const message = JSON.parse(
      fs.readFileSync(
        path.join(fixture.ipcDir, 'messages', messageFiles[0]),
        'utf-8',
      ),
    );
    expect(message.files).toEqual([{ path: 'reports/status.txt' }]);
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
            workspaceKey: 'team',
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
        workspaceKey: 'team',
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

    const result = await runMcpFixture(
      fixture,
      'request_skill_proposal',
      {
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
      },
      {
        GANTRY_MEMORY_USER_ID: 'tg:user-1',
        GANTRY_PROVIDER_ACCOUNT_ID: 'provider-account:telegram:main',
      },
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
    expect(task).toMatchObject({
      type: 'request_skill_proposal',
      targetJid: 'tg:team',
      chatJid: 'tg:team',
      providerAccountId: 'provider-account:telegram:main',
      memoryUserId: 'tg:user-1',
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

  it.each([
    [
      { kind: 'run_command', argvPattern: 'npm test *' },
      { temporaryOnly: true },
      {
        permissionKind: 'tool',
        toolName: 'RunCommand',
        rule: 'npm test *',
        temporaryOnly: true,
        reason: 'Run the project test suite on schedule.',
      },
    ],
  ])(
    'submits request_access %o as a request_permission review task',
    async (target, extra, payload) => {
      const fixture = createMcpFixture();

      const result = await runMcpFixture(fixture, 'request_access', {
        target,
        reason: payload.reason,
        ...extra,
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
        payload,
      });
    },
  );

  it('submits request_access for AgentDelegation as an exact built-in facade review task', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'request_access', {
      target: { kind: 'capability', id: 'AgentDelegation' },
      reason: 'Delegate async subtasks through Gantry task lifecycle wrappers.',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    const taskFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
    expect(taskFiles).toHaveLength(1);
    const task = JSON.parse(
      fs.readFileSync(path.join(taskDir, taskFiles[0]), 'utf-8'),
    );
    expect(task).toMatchObject({
      type: 'request_permission',
      targetJid: 'tg:team',
      chatJid: 'tg:team',
      payload: {
        permissionKind: 'tool',
        toolName: 'AgentDelegation',
        temporaryOnly: false,
        reason:
          'Delegate async subtasks through Gantry task lifecycle wrappers.',
      },
    });
  });

  it('rejects broad durable request_access run_command fallbacks before queuing review', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'request_access',
      {
        target: { kind: 'run_command', argvPattern: 'gh *' },
        reason: 'Run GitHub commands on schedule.',
      },
      { TEST_MCP_AUTO_RESPOND_TASKS: '0' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'Invalid durable run_command access request',
    );
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    expect(fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : []).toEqual([]);
  });

  it('shows selected MCP capabilities as ready sources', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'mcp_list_tools',
      { serverName: 'caw-ats' },
      {
        TEST_MCP_AUTO_RESPOND_TASKS: '1',
        TEST_MCP_TASK_RESPONSE_DATA: JSON.stringify({
          servers: [
            {
              name: 'caw-ats',
              tools: [{ name: 'ats_list_positions' }],
            },
          ],
        }),
        GANTRY_SELECTED_MCP_SERVERS_JSON: '["mcp:caw-ats"]',
        GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: JSON.stringify([
          'capability:mcp.caw-ats.access',
        ]),
        GANTRY_SEMANTIC_CAPABILITIES_JSON: JSON.stringify([
          cawAtsMcpCapability('mcp__caw-ats__ats_list_positions'),
        ]),
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.content[0].text).toContain('ready source: caw-ats');
    expect(record.result.content[0].text).toContain(
      'selected capabilities: mcp.caw-ats.access',
    );
    expect(record.result.content[0].text).toContain(
      'use: mcp_list_tools with serverName="caw-ats", mcp_describe_tool for one tool schema if needed, then mcp_call_tool with serverName="caw-ats"',
    );
    expect(record.result.content[0].text).toContain(
      'Do not request the same MCP capability again',
    );
  });

  it('allows request_access run_command fallbacks when MCP access is only requestable', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'request_access',
      {
        target: { kind: 'run_command', argvPattern: "jq '.[1].content' -r" },
        reason: 'List Manipal projects from caw-ats.',
        temporaryOnly: true,
      },
      {
        GANTRY_SEMANTIC_CAPABILITIES_JSON: JSON.stringify([
          cawAtsMcpCapability('mcp__caw-ats__ats_list_positions'),
        ]),
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).not.toBe(true);
    expect(record.result.content[0].text).toContain('Scheduler task confirmed');
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    const taskFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
    expect(taskFiles).toHaveLength(1);
    const task = JSON.parse(
      fs.readFileSync(path.join(taskDir, taskFiles[0]), 'utf-8'),
    );
    expect(task).toMatchObject({
      type: 'request_permission',
      targetJid: 'tg:team',
      chatJid: 'tg:team',
      payload: {
        permissionKind: 'tool',
        toolName: 'RunCommand',
        rule: "jq '.[1].content' -r",
        temporaryOnly: true,
        reason: 'List Manipal projects from caw-ats.',
      },
    });
  });

  it('allows unrelated request_access run_command fallbacks when MCP access is selected', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'request_access',
      {
        target: { kind: 'run_command', argvPattern: "jq '.[1].content' -r" },
        reason: 'List Manipal projects from caw-ats.',
        temporaryOnly: true,
      },
      {
        GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: JSON.stringify([
          'capability:mcp.caw-ats.access',
        ]),
        GANTRY_SEMANTIC_CAPABILITIES_JSON: JSON.stringify([
          cawAtsMcpCapability('mcp__caw-ats__ats_list_positions'),
        ]),
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).not.toBe(true);
    expect(record.result.content[0].text).toContain('Scheduler task confirmed');
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    expect(fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : []).toHaveLength(
      1,
    );
  });

  it('rejects request_access run_command fallbacks that target selected MCP access', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'request_access',
      {
        target: { kind: 'run_command', argvPattern: 'caw-ats list positions' },
        reason: 'List Manipal projects from caw-ats.',
        temporaryOnly: true,
      },
      {
        GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: JSON.stringify([
          'capability:mcp.caw-ats.access',
        ]),
        GANTRY_SEMANTIC_CAPABILITIES_JSON: JSON.stringify([
          cawAtsMcpCapability('mcp__caw-ats__ats_list_positions'),
        ]),
        TEST_MCP_AUTO_RESPOND_TASKS: '0',
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'RunCommand/Bash permission is not available as a fallback',
    );
    expect(record.result.content[0].text).toContain(
      'Selected MCP capabilities: mcp.caw-ats.access',
    );
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    expect(fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : []).toEqual([]);
  });

  it('rejects duplicate request_access capability requests when capability is already selected', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'request_access',
      {
        target: { kind: 'capability', id: 'mcp.caw-ats.access' },
        reason: 'List Flipspaces projects from caw-ats.',
      },
      {
        GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: JSON.stringify([
          'capability:mcp.caw-ats.access',
        ]),
        GANTRY_SEMANTIC_CAPABILITIES_JSON: JSON.stringify([
          cawAtsMcpCapability('mcp__caw-ats__ats_list_client_projects'),
        ]),
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'already selected for this run',
    );
    expect(record.result.content[0].text).toContain(
      'use mcp_list_tools to inspect the ready source, mcp_describe_tool for one tool schema if needed, then mcp_call_tool',
    );
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    expect(fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : []).toEqual([]);
  });

  it('rejects duplicate request_access capability requests when capability is live-selected', async () => {
    const fixture = createMcpFixture();
    writeLiveToolRules(fixture, ['capability:mcp.caw-ats.access']);

    const result = await runMcpFixture(
      fixture,
      'request_access',
      {
        target: { kind: 'capability', id: 'mcp.caw-ats.access' },
        reason: 'List Flipspaces projects from caw-ats.',
      },
      {
        GANTRY_SEMANTIC_CAPABILITIES_JSON: JSON.stringify([
          cawAtsMcpCapability('mcp__caw-ats__ats_list_client_projects'),
        ]),
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'already selected for this run',
    );
    expect(record.result.content[0].text).toContain(
      'use mcp_list_tools to inspect the ready source, mcp_describe_tool for one tool schema if needed, then mcp_call_tool',
    );
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    expect(fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : []).toEqual([]);
  });

  it('does not request MCP source setup when a matching capability is already selected', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'request_mcp_server',
      {
        name: 'caw-ats',
        transport: 'stdio_template',
        templateId: 'npx-package',
        args: ['@caw/ats-mcp'],
        sandboxProfileId: 'mcp-stdio',
        requestedToolPatterns: ['ats_list_client_projects'],
        reason: 'List projects from caw-ats.',
      },
      {
        GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: JSON.stringify([
          'capability:mcp.caw-ats.access',
        ]),
        GANTRY_SEMANTIC_CAPABILITIES_JSON: JSON.stringify([
          cawAtsMcpCapability('mcp__caw-ats__ats_list_client_projects'),
        ]),
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).not.toBe(true);
    expect(record.result.content[0].text).toContain(
      'MCP source "caw-ats" is already available for this run',
    );
    expect(record.result.content[0].text).toContain(
      'Selected capabilities: mcp.caw-ats.access',
    );
    expect(record.result.content[0].text).toContain(
      'Use mcp_list_tools with serverName="caw-ats", mcp_describe_tool when schema is needed, then mcp_call_tool',
    );
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    expect(fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : []).toEqual([]);
  });

  it('submits a request_access capability target as a reviewed capability request', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'request_access',
      {
        target: { kind: 'capability', id: 'acme.records.append' },
        reason: 'Append reviewed rows after each run.',
      },
      {
        GANTRY_SEMANTIC_CAPABILITIES_JSON: JSON.stringify([
          {
            capabilityId: 'acme.records.append',
            version: '1',
            displayName: 'Acme records append',
            category: 'Acme',
            risk: 'write',
            can: 'Append reviewed records through an approved source action.',
            cannot: 'Read unrelated records or receive raw credentials.',
            credentialSource: 'configured_access',
            preflight: { kind: 'none' },
            implementationBindings: [
              { kind: 'tool_rule', rule: 'example.records.append' },
            ],
          },
        ]),
      },
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
    expect(task).toMatchObject({
      type: 'request_permission',
      payload: {
        capabilityRequestSource: 'request_access',
        capabilityId: 'acme.records.append',
      },
    });
  });

  it('submits request_access exact Gantry tool targets as reviewed permission requests', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'request_access', {
      target: { kind: 'tool', name: 'AgentDelegation' },
      reason: 'Delegate bounded async work to a child agent.',
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
      payload: {
        capabilityRequestSource: 'request_access',
        permissionKind: 'tool',
        toolName: 'AgentDelegation',
      },
    });
  });

  it('rejects unknown exact Gantry tool requests before queuing review', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'request_access', {
      target: { kind: 'tool', name: 'DefinitelyNotAGantryTool' },
      reason: 'Try to request a made-up tool.',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'No exact requestable Gantry tool matches "DefinitelyNotAGantryTool".',
    );
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    expect(fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : []).toEqual([]);
  });

  it('rejects duplicate exact Gantry tool requests when already selected', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(
      fixture,
      'request_access',
      {
        target: { kind: 'tool', name: 'AgentDelegation' },
        reason: 'Delegate bounded async work to a child agent.',
      },
      { GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: '["AgentDelegation"]' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    expect(record.result.isError).toBe(true);
    expect(record.result.content[0].text).toContain(
      'Tool "AgentDelegation" is already selected for this run.',
    );
    const taskDir = path.join(fixture.ipcDir, 'tasks');
    expect(fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : []).toEqual([]);
  });

  it('normalizes delegate_task access requests to AgentDelegation', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'request_access', {
      target: { kind: 'tool', name: 'delegate_task' },
      reason: 'Use the durable delegated-task executor.',
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
    expect(task.payload.toolName).toBe('AgentDelegation');
  });

  it('normalizes tool-shaped capability requests to exact Gantry tool access', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'request_access', {
      target: { kind: 'capability', id: 'delegate_task' },
      reason: 'Use the durable delegated-task executor.',
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
    expect(task.payload.toolName).toBe('AgentDelegation');
  });

  it('submits request_access Gantry admin tool targets as reviewed permission requests', async () => {
    const fixture = createMcpFixture();

    const result = await runMcpFixture(fixture, 'request_access', {
      target: { kind: 'tool', name: 'request_settings_update' },
      reason: 'Submit reviewed local settings changes.',
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
      payload: {
        capabilityRequestSource: 'request_access',
        permissionKind: 'tool',
        toolName: 'mcp__gantry__request_settings_update',
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
      transport: 'stdio_template',
      templateId: 'npx-package',
      args: ['browser-control-mcp'],
      sandboxProfileId: 'mcp-stdio',
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
            workspaceKey: 'team',
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
          jobs: [{ id: 'job-1', status: 'active', workspace_key: 'team' }],
        }),
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(fixture.resultPath, 'utf-8'));
    // Rendered as a clean job-list row (no raw JSON dump).
    expect(record.result.content[0].text).toContain('Scheduler jobs (1)');
    expect(record.result.content[0].text).toContain('job-1');

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
    expect(record.result.content[0].text).toContain(
      'Queued an immediate run of this job.',
    );
    expect(record.result.content[0].text).not.toContain('run-1');

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
        workspaceKey: 'team',
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
          workspace_key: 'team',
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
        workspaceKey: 'team',
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
