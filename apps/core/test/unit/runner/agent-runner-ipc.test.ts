import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createHash, generateKeyPairSync } from 'crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GANTRY_CLAUDE_SDK_SKILLS_ENV,
  SDK_NATIVE_SKILL_OVERRIDES,
} from '@core/adapters/llm/anthropic-claude-agent/native-sdk-skills.js';

const RUNNER_IPC_CHILD_TIMEOUT_MS = 50_000;
const RUNNER_IPC_TEST_TIMEOUT_MS = 60_000;
const SLOW_RUNNER_IPC_TEST_TIMEOUT_MS = 120_000;
// The heartbeat test observes a real 15s heartbeat interval after a cold tsx
// runner boot, so it needs a wider per-spawn budget than the default child
// runner timeout and a matching vitest timeout above it.
const HEARTBEAT_RUNNER_TIMEOUT_MS = 60_000;
const HEARTBEAT_TEST_TIMEOUT_MS = 70_000;

const tempRoots: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface RunnerRecord {
  calls: Array<{
    promptKind: 'stream' | 'string';
    streamMessages?: unknown[];
    stringPrompt?: string;
    closeExistsAtQueryStart?: boolean;
    streamEnded?: boolean;
    permissionRequest?: Record<string, unknown>;
    permissionDecision?: Record<string, unknown>;
    permissionDecisions?: Record<string, Record<string, unknown>>;
    primeToolDecisions?: Record<string, Record<string, unknown>>;
    tools?: string[];
    allowedTools?: string[];
    sdkEnv?: Record<string, string>;
    mcpServers?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    skills?: string[];
    sandbox?: Record<string, unknown>;
    additionalDirectories?: string[];
    persistSession?: boolean;
    resume?: unknown;
    resumeSessionAt?: unknown;
    systemPrompt?: unknown;
    settingSources?: string[];
    strictMcpConfig?: boolean;
  }>;
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-runner-test-'));
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
  const sourceRoot = path.join(root, 'apps', 'core', 'src');
  const adapterDir = path.join(
    sourceRoot,
    'adapters',
    'llm',
    'anthropic-claude-agent',
  );
  const runnerDir = path.join(sourceRoot, 'runner');
  const runnerClaudeDir = path.join(adapterDir, 'runner');
  const infrastructureLoggingDir = path.join(
    sourceRoot,
    'infrastructure',
    'logging',
  );
  const domainEventsDir = path.join(sourceRoot, 'domain', 'events');
  const sharedDir = path.join(sourceRoot, 'shared');
  const sharedTimeDir = path.join(sharedDir, 'time');
  const runnerPath = path.join(runnerClaudeDir, 'index.ts');
  const sdkDir = path.join(
    root,
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
  );
  const ipcDir = path.join(root, 'ipc', 'team');
  const inputDir = path.join(ipcDir, 'input');
  const recordPath = path.join(root, 'sdk-record.json');

  fs.mkdirSync(sdkDir, { recursive: true });
  fs.mkdirSync(adapterDir, { recursive: true });
  fs.mkdirSync(runnerDir, { recursive: true });
  fs.mkdirSync(runnerClaudeDir, { recursive: true });
  fs.mkdirSync(infrastructureLoggingDir, { recursive: true });
  fs.mkdirSync(domainEventsDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(sharedTimeDir, { recursive: true });
  for (const file of fs.readdirSync(
    path.resolve('apps/core/src/adapters/llm/anthropic-claude-agent/runner'),
  )) {
    if (file.endsWith('.ts')) {
      fs.copyFileSync(
        path.resolve(
          'apps/core/src/adapters/llm/anthropic-claude-agent/runner',
          file,
        ),
        path.join(runnerClaudeDir, file),
      );
    }
  }
  fs.copyFileSync(
    path.resolve(
      'apps/core/src/adapters/llm/anthropic-claude-agent/agent-capabilities.ts',
    ),
    path.join(adapterDir, 'agent-capabilities.ts'),
  );
  fs.copyFileSync(
    path.resolve(
      'apps/core/src/adapters/llm/anthropic-claude-agent/native-sdk-tools.ts',
    ),
    path.join(adapterDir, 'native-sdk-tools.ts'),
  );
  fs.copyFileSync(
    path.resolve(
      'apps/core/src/adapters/llm/anthropic-claude-agent/native-sdk-skills.ts',
    ),
    path.join(adapterDir, 'native-sdk-skills.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/gantry-mcp-tool-surface.ts'),
    path.join(runnerDir, 'gantry-mcp-tool-surface.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/gantry-agent-system-prompt.ts'),
    path.join(runnerDir, 'gantry-agent-system-prompt.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/memory-boundary.ts'),
    path.join(sharedDir, 'memory-boundary.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/runtime-signal-pump.ts'),
    path.join(runnerDir, 'runtime-signal-pump.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/task-lifecycle-events.ts'),
    path.join(runnerDir, 'task-lifecycle-events.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/tool-gate-core.ts'),
    path.join(runnerDir, 'tool-gate-core.ts'),
  );
  fs.copyFileSync(
    path.resolve(
      'apps/core/src/adapters/llm/anthropic-claude-agent/runner/message-stream.ts',
    ),
    path.join(runnerClaudeDir, 'message-stream.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/infrastructure/logging/logger.ts'),
    path.join(infrastructureLoggingDir, 'logger.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/domain/events/runtime-event-types.ts'),
    path.join(domainEventsDir, 'runtime-event-types.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/time/datetime.ts'),
    path.join(sharedTimeDir, 'datetime.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/canonical-json.ts'),
    path.join(sharedDir, 'canonical-json.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/no-proxy.ts'),
    path.join(sharedDir, 'no-proxy.ts'),
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
    path.resolve('apps/core/src/shared/object.ts'),
    path.join(sharedDir, 'object.ts'),
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
    path.resolve('apps/core/src/shared/model-families.ts'),
    path.join(sharedDir, 'model-families.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-usage.ts'),
    path.join(sharedDir, 'model-usage.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/agent-persona.ts'),
    path.join(sharedDir, 'agent-persona.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/sdk-native-skill-names.ts'),
    path.join(sharedDir, 'sdk-native-skill-names.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/operator-error.ts'),
    path.join(sharedDir, 'operator-error.ts'),
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
    path.resolve('apps/core/src/shared/generated-runtime-paths.ts'),
    path.join(sharedDir, 'generated-runtime-paths.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/semantic-capability-ids.ts'),
    path.join(sharedDir, 'semantic-capability-ids.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/semantic-capabilities.ts'),
    path.join(sharedDir, 'semantic-capabilities.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/capability-runtime-access.ts'),
    path.join(sharedDir, 'capability-runtime-access.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/memory-ipc-actions.ts'),
    path.join(sharedDir, 'memory-ipc-actions.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/tool-rule-matcher.ts'),
    path.join(sharedDir, 'tool-rule-matcher.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/tool-execution-policy-service.ts'),
    path.join(sharedDir, 'tool-execution-policy-service.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/tool-execution-bash-policy.ts'),
    path.join(sharedDir, 'tool-execution-bash-policy.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/tool-execution-protected-paths.ts'),
    path.join(sharedDir, 'tool-execution-protected-paths.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/private-fs.ts'),
    path.join(sharedDir, 'private-fs.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/tool-access-view.ts'),
    path.join(sharedDir, 'tool-access-view.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/live-tool-rules.ts'),
    path.join(sharedDir, 'live-tool-rules.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/permission-tool-rules.ts'),
    path.join(sharedDir, 'permission-tool-rules.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/durable-access-policy.ts'),
    path.join(sharedDir, 'durable-access-policy.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/yolo-mode-policy.ts'),
    path.join(sharedDir, 'yolo-mode-policy.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/sensitive-material.ts'),
    path.join(sharedDir, 'sensitive-material.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/permission-timeout.ts'),
    path.join(sharedDir, 'permission-timeout.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/stable-hash.ts'),
    path.join(sharedDir, 'stable-hash.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/human-format.ts'),
    path.join(sharedDir, 'human-format.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/gantry-home.ts'),
    path.join(sharedDir, 'gantry-home.ts'),
  );
  fs.writeFileSync(
    path.join(sdkDir, 'package.json'),
    JSON.stringify({ type: 'module', main: 'index.js' }),
  );
  fs.writeFileSync(
    path.join(sdkDir, 'index.js'),
    `
import fs from 'fs';
import path from 'path';
import { sign as cryptoSign } from 'crypto';

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appendRecord(call) {
  const recordPath = process.env.TEST_SDK_RECORD_PATH;
  const current = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, 'utf-8'))
    : { calls: [] };
  current.calls.push(call);
  fs.writeFileSync(recordPath, JSON.stringify(current, null, 2));
}

function signPayload(payload) {
  const signingKey = process.env.TEST_IPC_RESPONSE_SIGNING_KEY || '';
  if (!signingKey) return undefined;
  return cryptoSign(null, Buffer.from(JSON.stringify(payload)), signingKey).toString('base64');
}

function writeInput(name, text) {
  const inputDir = process.env.GANTRY_IPC_INPUT_DIR;
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
    sdkEnv: options?.env,
    mcpServers: options?.mcpServers,
    settings: options?.settings,
    skills: options?.skills,
    sandbox: options?.sandbox,
    additionalDirectories: options?.additionalDirectories,
    tools: options?.tools,
    allowedTools: options?.allowedTools,
    persistSession: options?.persistSession,
    resume: options?.resume,
    resumeSessionAt: options?.resumeSessionAt,
    systemPrompt: options?.systemPrompt,
    settingSources: options?.settingSources,
    strictMcpConfig: options?.strictMcpConfig,
    closeExistsAtQueryStart: fs.existsSync(
      path.join(process.env.GANTRY_IPC_INPUT_DIR, '_close'),
    ),
  };

  if (
    process.env.TEST_EMPTY_QUERY === '1' ||
    process.env.TEST_EMPTY_RESUMED_QUERY === '1'
  ) {
    appendRecord(call);
    if (process.env.TEST_EXIT_AFTER_QUERY === '1') {
      fs.mkdirSync(process.env.GANTRY_IPC_INPUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.GANTRY_IPC_INPUT_DIR, '_close'), '');
    }
    return;
  }

  yield {
    type: 'system',
    subtype: 'init',
    session_id: 'runner-session-1',
    mcp_servers: [{ name: 'gantry', status: 'connected' }],
  };

  if (process.env.TEST_MEMORY_GUARD_DENIAL) {
    call.permissionDecision = await options.canUseTool(
      'Bash',
      { cmd: 'rm -rf /tmp/gantry-poisoned-memory' },
      {
        signal: new AbortController().signal,
        title: 'Run command',
        displayName: 'Bash',
        description: 'Needs shell access',
        decisionReason: 'Agent wants to run command from memory context',
        blockedPath: process.env.GANTRY_WORKSPACE_GROUP_DIR,
      },
    );
  }

  if (process.env.TEST_AGENT_BACKGROUND_INPUT === '1') {
    call.permissionDecision = await options.canUseTool(
      'Agent',
      { prompt: 'delegate', run_in_background: false },
      {
        signal: new AbortController().signal,
        title: 'Run subagent',
        displayName: 'Agent',
        description: 'Needs subagent access',
        decisionReason: 'Agent wants a subagent',
      },
    );
  }

  if (process.env.TEST_AUTONOMOUS_PERMISSION_REQUEST) {
    call.permissionDecision = await options.canUseTool(
      process.env.TEST_PERMISSION_TOOL_NAME || 'Bash',
      { cmd: 'npm test', apiToken: 'secret-token' },
      {
        signal: new AbortController().signal,
        title: 'Run command',
        displayName: process.env.TEST_PERMISSION_TOOL_NAME || 'Bash',
        description: 'Needs shell access',
        decisionReason: 'Agent wants to verify tests',
        blockedPath: process.env.GANTRY_WORKSPACE_GROUP_DIR,
      },
    );
  }

  if (process.env.TEST_PERMISSION_DECISION) {
    const permissionToolName = process.env.TEST_PERMISSION_TOOL_NAME || 'Bash';
    const permissionInput = process.env.TEST_PERMISSION_SCOPE
      ? { scope: process.env.TEST_PERMISSION_SCOPE }
      : { cmd: 'npm test', apiToken: 'secret-token' };
    const decisionPromise = options.canUseTool(
      permissionToolName,
      permissionInput,
      {
        signal: new AbortController().signal,
        title: 'Run command',
        displayName: permissionToolName,
        description: 'Needs shell access',
        decisionReason: 'Agent wants to verify tests',
        blockedPath: process.env.GANTRY_WORKSPACE_GROUP_DIR,
        ...(process.env.TEST_PERMISSION_SDK_SUGGESTION_TOOL_NAME
          ? {
              suggestions: [
                {
                  type: 'addRules',
                  behavior: 'allow',
                  destination: 'session',
                  rules: [
                    {
                      toolName:
                        process.env.TEST_PERMISSION_SDK_SUGGESTION_TOOL_NAME,
                    },
                  ],
                },
              ],
            }
          : {}),
      },
    );
    const requestDir = path.join(process.env.GANTRY_IPC_DIR, 'permission-requests');
    const responseDir = path.join(process.env.GANTRY_IPC_DIR, 'permission-responses');
    const requestPath = await waitForFile(requestDir, 1000);
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    fs.mkdirSync(responseDir, { recursive: true });
    const responsePayload = {
      requestId: request.requestId,
      responseNonce: request.responseNonce,
      approved: process.env.TEST_PERMISSION_DECISION === 'approve',
      ...(process.env.TEST_PERMISSION_MODE
        ? { mode: process.env.TEST_PERMISSION_MODE }
        : {}),
      decidedBy: 'runner-test-admin',
      reason: process.env.TEST_PERMISSION_DECISION,
      ...(process.env.TEST_PERMISSION_RETURN_SUGGESTIONS === '1' &&
      Array.isArray(request.suggestions)
        ? { updatedPermissions: request.suggestions }
        : {}),
      ...(process.env.TEST_PERMISSION_CLASSIFICATION
        ? {
            decisionClassification:
              process.env.TEST_PERMISSION_CLASSIFICATION,
          }
        : {}),
    };
    const signature = signPayload(responsePayload);
    fs.writeFileSync(
      path.join(responseDir, request.requestId + '.json'),
      JSON.stringify({
        ...responsePayload,
        ...(signature ? { signature } : {}),
      }),
    );
    call.permissionRequest = request;
    call.permissionDecision = await decisionPromise;
  }

  if (process.env.TEST_SDK_NETWORK_AFTER_TOOL === '1') {
    const useParentlessNetworkPrompt =
      process.env.TEST_PARENTLESS_SDK_NETWORK_AFTER_TOOL === '1';
    const networkHost =
      process.env.TEST_SDK_NETWORK_HOST || 'registry.npmjs.org';
    const toolDecision = await options.canUseTool(
      'Bash',
      { cmd: process.env.TEST_TOOL_USE_CMD || 'npm test --runInBand' },
      {
        signal: new AbortController().signal,
        title: 'Run command',
        displayName: 'Bash',
        description: 'Needs shell access',
        decisionReason: 'Agent wants to run a command',
        blockedPath: process.env.GANTRY_WORKSPACE_GROUP_DIR,
        toolUseID: 'toolu_bash_1',
      },
    );
    const networkDecision = await options.canUseTool(
      'SandboxNetworkAccess',
      { host: networkHost },
      {
        signal: new AbortController().signal,
        title: 'Network request outside of sandbox',
        displayName: 'SandboxNetworkAccess',
        description: 'Allow network connection to ' + networkHost + '?',
        decisionReason: 'Sandboxed tool attempted outbound network access',
        toolUseID: 'toolu_network_1',
        ...(useParentlessNetworkPrompt
          ? {}
          : { parentToolUseID: 'toolu_bash_1' }),
      },
    );
    const secondNetworkDecision =
      process.env.TEST_SECOND_SDK_NETWORK_AFTER_TOOL === '1'
        ? await options.canUseTool(
            'SandboxNetworkAccess',
            { host: 'example.com' },
            {
              signal: new AbortController().signal,
              title: 'Network request outside of sandbox',
              displayName: 'SandboxNetworkAccess',
              description: 'Allow network connection to example.com?',
              decisionReason:
                'Sandboxed tool attempted outbound network access',
              toolUseID: 'toolu_network_2',
              parentToolUseID: 'toolu_bash_1',
            },
          )
        : undefined;
    call.permissionDecisions = {
      tool: toolDecision,
      network: networkDecision,
      ...(secondNetworkDecision ? { network2: secondNetworkDecision } : {}),
    };
  }

  if (process.env.TEST_PRIME_TWO_TOOL_ATTEMPTS === '1') {
    const bashDecision = await options.canUseTool(
      'Bash',
      { cmd: 'npm test --runInBand' },
      {
        signal: new AbortController().signal,
        title: 'Run command',
        displayName: 'Bash',
        description: 'Needs shell access',
        decisionReason: 'Agent wants to verify tests',
        blockedPath: process.env.GANTRY_WORKSPACE_GROUP_DIR,
        toolUseID: 'toolu_prime_bash',
      },
    );
    const browserDecision = await options.canUseTool(
      'mcp__gantry__browser_act',
      { url: 'https://example.com' },
      {
        signal: new AbortController().signal,
        title: 'Navigate browser',
        displayName: 'browser_act',
        description: 'Needs browser access',
        decisionReason: 'Agent wants to inspect a page',
        toolUseID: 'toolu_prime_browser',
      },
    );
    call.primeToolDecisions = {
      bash: bashDecision,
      browser: browserDecision,
    };
  }

	  if (process.env.TEST_TOOL_USE_ONLY) {
	    if (process.env.TEST_LIVE_TOOL_RULE) {
	      const runHandle = process.env.GANTRY_AGENT_RUN_HANDLE;
	      const liveDir = path.join(process.env.GANTRY_IPC_DIR, 'live-tool-rules');
	      fs.mkdirSync(liveDir, { recursive: true });
	      fs.writeFileSync(
	        path.join(liveDir, runHandle + '.json'),
	        JSON.stringify([process.env.TEST_LIVE_TOOL_RULE]),
	      );
	    }
	    call.permissionDecision = await options.canUseTool(
      process.env.TEST_TOOL_USE_ONLY,
      { cmd: process.env.TEST_TOOL_USE_CMD || 'npm test' },
      {
        signal: new AbortController().signal,
        title: 'Run command',
        displayName: process.env.TEST_TOOL_USE_ONLY,
        description: 'Needs tool access',
        decisionReason: 'Agent wants to use a tool',
        blockedPath: process.env.GANTRY_WORKSPACE_GROUP_DIR,
      },
    );
  }

  if (process.env.TEST_WAIT_FOR_HEARTBEAT === '1') {
    await delay(16000);
  }

  if (typeof prompt === 'string') {
    call.stringPrompt = prompt;
  } else {
    call.streamMessages = [];
    const iterator = prompt[Symbol.asyncIterator]();
    const first = await nextWithTimeout(iterator, 1000);
    if (first && !first.done) {
      call.streamMessages.push(first.value.message.content);
      if (Array.isArray(first.value.message.content)) {
        const userPrompt = await nextWithTimeout(iterator, 1000);
        if (userPrompt && !userPrompt.done) {
          call.streamMessages.push(userPrompt.value.message.content);
        }
      }
    }

    if (process.env.TEST_CHECK_STREAM_ENDED === '1') {
      const closed = await nextWithTimeout(iterator, 1000);
      call.streamEnded = Boolean(closed?.done);
    }

    if (process.env.TEST_ACTIVE_INPUT_ORDER === '1') {
      writeInput('001-active-first.json', 'active follow-up first');
      writeInput('002-active-second.json', 'active follow-up second');
      await delay(700);
      yield { type: 'result', subtype: 'success', result: 'runner-ok' };
      for (let i = 0; i < 2; i += 1) {
        const next = await nextWithTimeout(iterator, 1500);
        if (next && !next.done) {
          call.streamMessages.push(next.value.message.content);
        }
      }
      appendRecord(call);
      if (process.env.TEST_EXIT_AFTER_QUERY === '1') {
        setTimeout(() => {
          fs.mkdirSync(process.env.GANTRY_IPC_INPUT_DIR, { recursive: true });
          fs.writeFileSync(path.join(process.env.GANTRY_IPC_INPUT_DIR, '_close'), '');
        }, 20);
      }
      return;
    }

    if (process.env.TEST_INTERACTION_BOUNDARY_FILE === '1') {
      const boundaryDir = path.join(process.env.GANTRY_IPC_DIR, 'interaction-boundaries');
      fs.mkdirSync(boundaryDir, { recursive: true });
      fs.writeFileSync(
        path.join(boundaryDir, 'boundary-1.json'),
        JSON.stringify({ type: 'user_interaction', tool: 'ask_user_question' }),
      );
      await delay(700);
    }

    if (process.env.TEST_CREATE_CLOSE_DURING_QUERY === '1') {
      fs.writeFileSync(path.join(process.env.GANTRY_IPC_INPUT_DIR, '_close'), '');
      const closed = await nextWithTimeout(iterator, 1500);
      call.streamEnded = Boolean(closed?.done);
    }
  }

  appendRecord(call);
  if (process.env.TEST_STRUCTURED_THEN_STREAM_SUCCESS_RESULT === '1') {
    const finalAnswer =
      '**Claude Tag** is Anthropic product detail text that was already streamed to the user before the SDK result arrived. ' +
      'It is long enough to avoid being confused with a short operational error.';
    yield {
      type: 'assistant',
      message: { content: [{ type: 'text', text: "I'll search for that." }] },
    };
    yield {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: finalAnswer },
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      result: finalAnswer,
    };
    if (process.env.TEST_EXIT_AFTER_QUERY === '1') {
      setTimeout(() => {
        fs.mkdirSync(process.env.GANTRY_IPC_INPUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.GANTRY_IPC_INPUT_DIR, '_close'), '');
      }, 20);
    }
    return;
  }
  if (process.env.TEST_STRUCTURED_THEN_STREAM_CREDENTIAL_RESULT === '1') {
    const finalAnswer =
      'The provider returned invalid api key text after visible output was already streamed. ' +
      'This must still be treated as a runtime failure.';
    yield {
      type: 'assistant',
      message: { content: [{ type: 'text', text: "I'll check that." }] },
    };
    yield {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: finalAnswer },
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      result: finalAnswer,
    };
    if (process.env.TEST_EXIT_AFTER_QUERY === '1') {
      setTimeout(() => {
        fs.mkdirSync(process.env.GANTRY_IPC_INPUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.GANTRY_IPC_INPUT_DIR, '_close'), '');
      }, 20);
    }
    return;
  }
  if (process.env.TEST_COMPACT_BOUNDARY === '1') {
    yield { type: 'system', subtype: 'compact_boundary', uuid: 'compact-1' };
  }
  if (process.env.TEST_TASK_LIFECYCLE === '1') {
    yield {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'toolu_agent_1',
      description: 'Research pricing',
      subagent_type: 'general-purpose',
      task_type: 'local_agent',
      workflow_name: 'ignored-for-local-agent',
      prompt: 'raw delegated prompt must not leak',
    };
    yield {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task-1',
      tool_use_id: 'toolu_agent_1',
      description: 'Research pricing',
      subagent_type: 'general-purpose',
      usage: { total_tokens: 123, tool_uses: 2, duration_ms: 456 },
      last_tool_name: 'WebSearch',
      summary: 'two sources checked',
    };
    yield {
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-1',
      patch: {
        status: 'running',
        description: 'Research pricing',
        total_paused_ms: 0,
        is_backgrounded: true,
        error: 'raw task error must not leak',
      },
    };
    yield {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'toolu_agent_1',
      status: 'completed',
      output_file: '/tmp/raw-task-output.json',
      summary: 'subagent done',
      usage: { total_tokens: 200, tool_uses: 3, duration_ms: 789 },
    };
  }
  yield { type: 'result', subtype: 'success', result: 'runner-ok' };

  if (process.env.TEST_EXIT_AFTER_QUERY === '1') {
    setTimeout(() => {
      fs.mkdirSync(process.env.GANTRY_IPC_INPUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.GANTRY_IPC_INPUT_DIR, '_close'), '');
    }, 20);
  }
}
`,
  );

  return {
    root,
    runnerPath,
    ipcDir,
    inputDir,
    recordPath,
    responseVerifyKey,
    responseSigningKey,
  };
}

function baseInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    prompt: 'initial prompt',
    workspaceFolder: 'team',
    chatJid: 'tg:team',
    compiledSystemPrompt: 'compiled system profile',
    ...overrides,
  };
}

async function runRunner(
  fixture: ReturnType<typeof createRunnerFixture>,
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
  timeoutMs = RUNNER_IPC_CHILD_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const child = spawn(
    process.execPath,
    [path.resolve('node_modules/tsx/dist/cli.mjs'), fixture.runnerPath],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        GANTRY_IPC_DIR: fixture.ipcDir,
        GANTRY_IPC_INPUT_DIR: fixture.inputDir,
        GANTRY_IPC_AUTH_TOKEN: 'runner-test-token',
        GANTRY_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
        GANTRY_AGENT_RUN_HANDLE: 'runner-test-run',
        TEST_IPC_RESPONSE_SIGNING_KEY: fixture.responseSigningKey,
        GANTRY_WORKSPACE_GROUP_DIR: path.join(fixture.root, 'group'),
        GANTRY_WORKSPACE_EXTRA_DIR: path.join(fixture.root, 'extra'),
        TEST_SDK_RECORD_PATH: fixture.recordPath,
        ...(typeof input.jobId === 'string'
          ? { GANTRY_JOB_ID: input.jobId }
          : {}),
        ...(typeof input.runId === 'string'
          ? { GANTRY_JOB_RUN_ID: input.runId }
          : {}),
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
    }, timeoutMs);
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

function systemPromptText(
  call: RunnerRecord['calls'][number] | undefined,
): string {
  return JSON.stringify(call?.systemPrompt ?? '');
}

function readRunnerOutputs(stdout: string): Array<Record<string, unknown>> {
  const matches = [
    ...stdout.matchAll(
      /---GANTRY_OUTPUT_START---\n([\s\S]*?)\n---GANTRY_OUTPUT_END---/g,
    ),
  ];
  return matches.map((match) => JSON.parse(match[1] ?? '{}'));
}

describe('agent-runner IPC lifecycle', () => {
  it(
    'passes only broker-safe values into the Agent SDK env',
    async () => {
      const fixture = createRunnerFixture();
      const claudeConfigDirEnvKey = ['CLAUDE', 'CONFIG', 'DIR'].join('_');

      const result = await runRunner(
        fixture,
        baseInput({
          modelCredentialEnv: {
            ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
            NODE_EXTRA_CA_CERTS: '/tmp/model_gateway-ca.pem',
          },
          toolNetworkEnv: {
            HTTP_PROXY: 'http://127.0.0.1:18080/',
            HTTPS_PROXY: 'http://127.0.0.1:18080/',
            http_proxy: 'http://127.0.0.1:18080/',
            https_proxy: 'http://127.0.0.1:18080/',
            NODE_USE_ENV_PROXY: '1',
            REQUESTS_CA_BUNDLE: '/tmp/model_gateway-ca.pem',
          },
        }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
          ANTHROPIC_API_KEY: 'raw-provider-key',
          CLAUDE_CODE_OAUTH_TOKEN: 'raw-oauth-token',
          [claudeConfigDirEnvKey]: path.join(
            fixture.root,
            'isolated-claude-config',
          ),
          HOME: path.join(fixture.root, 'host-home'),
          USERPROFILE: path.join(fixture.root, 'host-profile'),
          XDG_CONFIG_HOME: path.join(fixture.root, 'host-xdg-config'),
          APPDATA: path.join(fixture.root, 'host-appdata'),
          LOCALAPPDATA: path.join(fixture.root, 'host-localappdata'),
          USER: 'host-user',
          USERNAME: 'host-username',
          LOGNAME: 'host-logname',
          HTTP_PROXY: 'http://127.0.0.1:10255/',
          HTTPS_PROXY: 'http://127.0.0.1:10255/',
          NODE_USE_ENV_PROXY: '1',
          GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
          NO_PROXY: '',
          no_proxy: '',
          NODE_EXTRA_CA_CERTS: '/tmp/model_gateway-ca.pem',
          GANTRY_IPC_AUTH_TOKEN: 'runner-test-token',
          GANTRY_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
          GANTRY_EGRESS_PROXY_URL: 'http://127.0.0.1:18080/',
        },
        SLOW_RUNNER_IPC_TEST_TIMEOUT_MS,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      const sdkEnv = call?.sdkEnv || {};
      expect(sdkEnv.ANTHROPIC_BASE_URL).toBe('https://broker.local/anthropic');
      expect(sdkEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(sdkEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(sdkEnv[claudeConfigDirEnvKey]).toBe(
        path.join(fixture.root, 'isolated-claude-config'),
      );
      expect(sdkEnv.HOME).toBeUndefined();
      expect(sdkEnv.USERPROFILE).toBeUndefined();
      expect(sdkEnv.XDG_CONFIG_HOME).toBeUndefined();
      expect(sdkEnv.APPDATA).toBeUndefined();
      expect(sdkEnv.LOCALAPPDATA).toBeUndefined();
      expect(sdkEnv.USER).toBeUndefined();
      expect(sdkEnv.USERNAME).toBeUndefined();
      expect(sdkEnv.LOGNAME).toBeUndefined();
      expect(sdkEnv.HTTP_PROXY).toBeUndefined();
      expect(sdkEnv.HTTPS_PROXY).toBeUndefined();
      expect(sdkEnv.http_proxy).toBeUndefined();
      expect(sdkEnv.https_proxy).toBeUndefined();
      expect(sdkEnv.NODE_USE_ENV_PROXY).toBeUndefined();
      expect(sdkEnv.GIT_HTTP_PROXY_AUTHMETHOD).toBeUndefined();
      expect(sdkEnv.NODE_EXTRA_CA_CERTS).toBe('/tmp/model_gateway-ca.pem');
      expect(sdkEnv.SSL_CERT_FILE).toBe('/tmp/model_gateway-ca.pem');
      expect(sdkEnv.REQUESTS_CA_BUNDLE).toBe('/tmp/model_gateway-ca.pem');
      expect(sdkEnv.CURL_CA_BUNDLE).toBe('/tmp/model_gateway-ca.pem');
      expect(sdkEnv.GIT_SSL_CAINFO).toBe('/tmp/model_gateway-ca.pem');
      expect(sdkEnv.PIP_CERT).toBe('/tmp/model_gateway-ca.pem');
      expect(sdkEnv.AWS_CA_BUNDLE).toBe('/tmp/model_gateway-ca.pem');
      expect(sdkEnv.CARGO_HTTP_CAINFO).toBe('/tmp/model_gateway-ca.pem');
      expect(sdkEnv.DENO_CERT).toBe('/tmp/model_gateway-ca.pem');
      expect(sdkEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
      expect(sdkEnv.NO_PROXY?.split(',')).toEqual(
        expect.arrayContaining(['127.0.0.1', 'localhost', '::1']),
      );
      expect(sdkEnv.NO_PROXY).not.toContain('api.github.com');
      expect(sdkEnv.NO_PROXY).not.toContain('.github.com');
      expect(sdkEnv.no_proxy).toBe(sdkEnv.NO_PROXY);
      expect(sdkEnv.GANTRY_IPC_AUTH_TOKEN).toBeUndefined();
      expect(sdkEnv.GANTRY_IPC_RESPONSE_VERIFY_KEY).toBeUndefined();
      expect(sdkEnv.GANTRY_MCP_CONFIG_FILE).toBeUndefined();
      expect(sdkEnv.GANTRY_MCP_SERVERS_JSON).toBeUndefined();
      expect(sdkEnv.GANTRY_MCP_ALLOWED_TOOLS_JSON).toBeUndefined();
      expect(sdkEnv.ENABLE_TOOL_SEARCH).toBe('false');
      const startupDiagnostics = readRunnerOutputs(result.stdout).flatMap(
        (output) =>
          Array.isArray(output.runtimeEvents) ? output.runtimeEvents : [],
      ) as Array<{ eventType?: string; payload?: Record<string, unknown> }>;
      expect(startupDiagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: 'run.startup_diagnostic',
            payload: expect.objectContaining({
              diagnostic: 'tool_search',
              enableToolSearch: 'false',
              reason: 'non_first_party_base_url_tool_reference_unproven',
              anthropicBaseUrlKind: 'non_first_party',
            }),
          }),
          expect.objectContaining({
            eventType: 'run.startup_diagnostic',
            payload: expect.objectContaining({
              provider: ['anthropic', 'sdk'].join('_'),
              diagnostic: 'runner_startup_timing',
              persistSdkSession: true,
              resumedSession: false,
              sdkQueryPreparedMs: expect.any(Number),
              sdkQueryIteratorMs: expect.any(Number),
              firstSdkEventMs: expect.any(Number),
              providerSessionMs: expect.any(Number),
              firstVisibleOutputMs: expect.any(Number),
              firstResultMs: expect.any(Number),
              messageCount: 2,
              resultCount: 1,
              availableToolCount: expect.any(Number),
              allowedToolCount: expect.any(Number),
              disallowedToolCount: expect.any(Number),
              mcpServerCount: expect.any(Number),
            }),
          }),
        ]),
      );
      expect(JSON.stringify(startupDiagnostics)).not.toContain('broker.local');
      expect(JSON.stringify(startupDiagnostics)).not.toContain(
        'runner-session-1',
      );
      const gantryMcpServer = call?.mcpServers?.gantry as
        | { args?: string[] }
        | undefined;
      const gantryMcpServerPath = path.normalize(
        gantryMcpServer?.args?.[0] ?? '',
      );
      expect(gantryMcpServerPath).toContain(
        path.join('apps', 'core', 'src', 'runner', 'mcp', 'stdio.js'),
      );
      expect(gantryMcpServerPath).not.toContain(
        path.join('adapters', 'llm', 'anthropic-claude-agent', 'mcp'),
      );
    },
    SLOW_RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'rejects proxy env in the model credential lane',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          modelCredentialEnv: {
            HTTP_PROXY: 'http://127.0.0.1:10255/',
            HTTPS_PROXY: 'http://127.0.0.1:18080/',
          },
        }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
          GANTRY_EGRESS_PROXY_URL: 'http://127.0.0.1:18080/',
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'modelCredentialEnv.HTTP_PROXY is not supported.',
      );
      expect(fs.existsSync(fixture.recordPath)).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'routes native Agent attempts through AgentDelegation instead of auto-allowing',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput(),
        {
          TEST_PERMISSION_DECISION: 'deny',
          TEST_PERMISSION_TOOL_NAME: 'Agent',
          TEST_EXIT_AFTER_QUERY: '1',
        },
        SLOW_RUNNER_IPC_TEST_TIMEOUT_MS,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionRequest).toMatchObject({
        toolName: 'AgentDelegation',
        toolInput: { cmd: 'npm test', apiToken: 'secret-token' },
      });
      expect(call?.permissionDecision).toEqual({
        behavior: 'deny',
        message: 'Permission denied: deny',
        interrupt: false,
      });
    },
    SLOW_RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'records prime-mode native Agent attempts as AgentDelegation requests',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          runMode: 'prime',
          appId: 'app-1',
          agentId: 'agent-1',
          jobId: 'job-1',
          runId: 'run-1',
        }),
        {
          TEST_AGENT_BACKGROUND_INPUT: '1',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const outputs = readRunnerOutputs(result.stdout);
      const attemptEvents = outputs.flatMap((output) =>
        Array.isArray(output.runtimeEvents) ? output.runtimeEvents : [],
      ) as Array<{ eventType?: string; payload?: Record<string, unknown> }>;
      const permissionEvents = attemptEvents.filter(
        (event) => event.eventType === 'permission.requested',
      );
      expect(permissionEvents).toEqual([
        expect.objectContaining({
          eventType: 'permission.requested',
          payload: expect.objectContaining({
            requestedToolName: 'AgentDelegation',
            toolInput: {
              prompt: 'delegate',
              run_in_background: true,
            },
          }),
        }),
      ]);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'emits SDK task lifecycle messages as structured runtime events',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          appId: 'app-one',
          agentId: 'agent:team',
          runId: 'run-1',
          jobId: 'job-1',
          threadId: 'thread-1',
        }),
        {
          TEST_TASK_LIFECYCLE: '1',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const outputs = readRunnerOutputs(result.stdout);
      const taskOutputs = outputs.filter((output) =>
        (output.runtimeEvents ?? []).some(
          (event: { eventType?: string }) =>
            typeof event.eventType === 'string' &&
            event.eventType.startsWith('task.'),
        ),
      );
      expect(taskOutputs.every((output) => output.runtimeEventOnly)).toBe(true);
      const taskEvents = outputs
        .flatMap((output) =>
          Array.isArray(output.runtimeEvents) ? output.runtimeEvents : [],
        )
        .filter(
          (event): event is Record<string, unknown> =>
            typeof event === 'object' &&
            event !== null &&
            typeof event.eventType === 'string' &&
            event.eventType.startsWith('task.'),
        );
      expect(taskEvents).toEqual([
        expect.objectContaining({
          eventType: 'task.started',
          appId: 'app-one',
          agentId: 'agent:team',
          runId: 'run-1',
          jobId: 'job-1',
          conversationId: 'tg:team',
          threadId: 'thread-1',
          payload: {
            taskId: 'task-1',
            toolUseId: 'toolu_agent_1',
            description: 'Research pricing',
            subagentType: 'general-purpose',
            taskKind: 'delegated_agent',
            workflowName: 'ignored-for-local-agent',
            skipTranscript: false,
          },
        }),
        expect.objectContaining({
          eventType: 'task.progress',
          payload: {
            taskId: 'task-1',
            toolUseId: 'toolu_agent_1',
            description: 'Research pricing',
            subagentType: 'general-purpose',
            lastToolName: 'WebSearch',
            summary: 'two sources checked',
            usage: {
              totalTokens: 123,
              toolUses: 2,
              durationMs: 456,
            },
          },
        }),
        expect.objectContaining({
          eventType: 'task.updated',
          payload: {
            taskId: 'task-1',
            patch: {
              status: 'running',
              description: 'Research pricing',
              totalPausedMs: 0,
              isBackgrounded: true,
              hasError: true,
            },
          },
        }),
        expect.objectContaining({
          eventType: 'task.notification',
          payload: {
            taskId: 'task-1',
            toolUseId: 'toolu_agent_1',
            status: 'completed',
            summary: 'subagent done',
            skipTranscript: false,
            usage: {
              totalTokens: 200,
              toolUses: 3,
              durationMs: 789,
            },
          },
        }),
      ]);
      expect(JSON.stringify(taskEvents)).not.toContain(
        'raw delegated prompt must not leak',
      );
      expect(JSON.stringify(taskEvents)).not.toContain(
        '/tmp/raw-task-output.json',
      );
      expect(JSON.stringify(taskEvents)).not.toContain(
        'raw task error must not leak',
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'enables SDK filesystem sandboxing with protected deny-write paths',
    async () => {
      const fixture = createRunnerFixture();
      const claudeConfigDir = path.join(fixture.root, 'claude-config');
      const handoffPath = path.join(fixture.root, 'ipc', 'mcp-handoff.json');

      const result = await runRunner(fixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
        GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON: JSON.stringify([
          claudeConfigDir,
          handoffPath,
        ]),
      });

      expect(result.exitCode, result.stderr).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        filesystem: {
          denyWrite: expect.arrayContaining([
            path.join(
              fs.realpathSync.native(path.dirname(claudeConfigDir)),
              path.basename(claudeConfigDir),
            ),
            path.join(
              fs.realpathSync.native(path.dirname(handoffPath)),
              path.basename(handoffPath),
            ),
          ]),
        },
      });
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'keeps reviewed local CLI credential paths readable but write-protected in the SDK sandbox',
    async () => {
      const fixture = createRunnerFixture();
      const protectedSettingsPath = path.join(
        fixture.root,
        'runtime',
        'settings.json',
      );
      const runtimeProjectionDir = path.join(fixture.root, 'runtime');
      const localCliCredentialDir = path.join(
        fixture.root,
        'credentials',
        'acme',
      );
      fs.mkdirSync(runtimeProjectionDir, { recursive: true });
      fs.mkdirSync(localCliCredentialDir, { recursive: true });

      const result = await runRunner(fixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
        GANTRY_PROTECTED_FILESYSTEM_DENY_READ_PATHS_JSON: JSON.stringify([
          protectedSettingsPath,
        ]),
        GANTRY_PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_JSON: JSON.stringify([
          runtimeProjectionDir,
        ]),
        GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON: JSON.stringify([
          localCliCredentialDir,
        ]),
      });

      expect(result.exitCode, result.stderr).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      const sandboxFilesystem = call?.sandbox?.filesystem as
        | { denyRead?: string[]; denyWrite?: string[] }
        | undefined;

      expect(sandboxFilesystem?.denyRead).toEqual(
        expect.arrayContaining([
          path.join(
            fs.realpathSync.native(path.dirname(protectedSettingsPath)),
            path.basename(protectedSettingsPath),
          ),
        ]),
      );
      expect(sandboxFilesystem?.denyRead).not.toEqual(
        expect.arrayContaining([
          path.join(
            fs.realpathSync.native(path.dirname(localCliCredentialDir)),
            path.basename(localCliCredentialDir),
          ),
        ]),
      );
      expect(call?.additionalDirectories).toEqual(
        expect.arrayContaining([
          path.join(
            fs.realpathSync.native(path.dirname(localCliCredentialDir)),
            path.basename(localCliCredentialDir),
          ),
        ]),
      );
      expect(sandboxFilesystem?.denyWrite).toEqual(
        expect.arrayContaining([
          path.join(
            fs.realpathSync.native(path.dirname(runtimeProjectionDir)),
            path.basename(runtimeProjectionDir),
          ),
          path.join(
            fs.realpathSync.native(path.dirname(localCliCredentialDir)),
            path.basename(localCliCredentialDir),
          ),
        ]),
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'does not request a nested SDK filesystem sandbox inside the outer runner sandbox',
    async () => {
      const fixture = createRunnerFixture();
      const protectedSettingsPath = path.join(
        fixture.root,
        'runtime',
        'settings.json',
      );
      fs.mkdirSync(path.dirname(protectedSettingsPath), { recursive: true });
      fs.writeFileSync(protectedSettingsPath, '{}');

      const result = await runRunner(fixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
        GANTRY_SANDBOX_RUNTIME_PROXY: '1',
        GANTRY_PROTECTED_FILESYSTEM_DENY_READ_PATHS_JSON: JSON.stringify([
          protectedSettingsPath,
        ]),
        GANTRY_PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_JSON: JSON.stringify([
          protectedSettingsPath,
        ]),
      });

      expect(result.exitCode, result.stderr).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.sandbox).toBeUndefined();
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'rejects unsupported model credential env keys before Agent SDK launch',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          modelCredentialEnv: {
            ANTHROPIC_MODEL: 'evil-provider/model',
            LD_PRELOAD: '/tmp/injected.dylib',
          },
        }),
        { TEST_EXIT_AFTER_QUERY: '1' },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'modelCredentialEnv.ANTHROPIC_MODEL is not supported.',
      );
      expect(fs.existsSync(fixture.recordPath)).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'rejects host-private browser MCP config from a private file',
    async () => {
      const fixture = createRunnerFixture();
      const mcpConfigPath = path.join(fixture.root, 'mcp-config.json');
      const hostPrivateServerName = `${'browser'}_${'backend'}`;
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          [hostPrivateServerName]: {
            type: 'stdio',
            command: '/tmp/private-browser-mcp',
            args: ['--unsafe-shared-context'],
            env: { RAW_BROWSER_BACKEND_ENDPOINT: 'http://127.0.0.1:4567' },
          },
        }),
      );

      const result = await runRunner(fixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
        GANTRY_MCP_CONFIG_FILE: mcpConfigPath,
        GANTRY_MCP_ALLOWED_TOOLS_JSON: JSON.stringify([
          'mcp__browser' + '_' + 'backend' + '__*',
        ]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Host-private browser MCP servers');
      expect(fs.existsSync(fixture.recordPath)).toBe(false);
      expect(fs.existsSync(mcpConfigPath)).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'merges private MCP config proxy env inside sandbox runtime',
    async () => {
      const fixture = createRunnerFixture();
      const mcpConfigPath = path.join(fixture.root, 'mcp-config.json');
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          github: {
            type: 'stdio',
            command: '/tmp/github-mcp',
            env: {
              GITHUB_TOKEN: 'token',
              HTTP_PROXY: 'http://127.0.0.1:18080/',
              HTTPS_PROXY: 'http://127.0.0.1:18080/',
            },
          },
        }),
      );

      const result = await runRunner(
        fixture,
        baseInput({
          toolNetworkEnv: {
            HTTP_PROXY: 'http://127.0.0.1:18080/',
            HTTPS_PROXY: 'http://127.0.0.1:18080/',
          },
        }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
          GANTRY_SANDBOX_RUNTIME_PROXY: '1',
          HTTP_PROXY: 'http://127.0.0.1:28080/',
          HTTPS_PROXY: 'http://127.0.0.1:28080/',
          GANTRY_MCP_CONFIG_FILE: mcpConfigPath,
          GANTRY_MCP_ALLOWED_TOOLS_JSON: JSON.stringify(['mcp__github__*']),
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      const githubMcp = call?.mcpServers?.github as
        | { env?: Record<string, string> }
        | undefined;
      expect(githubMcp?.env).toMatchObject({
        GITHUB_TOKEN: 'token',
        HTTP_PROXY: 'http://127.0.0.1:28080/',
        HTTPS_PROXY: 'http://127.0.0.1:28080/',
        http_proxy: 'http://127.0.0.1:28080/',
        https_proxy: 'http://127.0.0.1:28080/',
        NODE_USE_ENV_PROXY: '1',
      });
      expect(fs.existsSync(mcpConfigPath)).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'rejects host-private browser backend hyphenated config from a private file',
    async () => {
      const fixture = createRunnerFixture();
      const mcpConfigPath = path.join(fixture.root, 'mcp-config.json');
      const hostPrivateServerName = `${'browser'}-${'backend'}`;
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          [hostPrivateServerName]: {
            type: 'stdio',
            command: '/tmp/private-browser-mcp',
            args: ['--shared-browser-context'],
            env: {
              BROWSER_BACKEND_ENDPOINT: 'http://127.0.0.1:4567',
            },
          },
        }),
      );

      const result = await runRunner(fixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
        GANTRY_MCP_CONFIG_FILE: mcpConfigPath,
        GANTRY_MCP_ALLOWED_TOOLS_JSON: JSON.stringify([
          'mcp__browser' + '_' + 'backend' + '__click',
        ]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Host-private browser MCP servers');
      expect(fs.existsSync(fixture.recordPath)).toBe(false);
      expect(fs.existsSync(mcpConfigPath)).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'passes broker placeholder API key values into the Agent SDK env',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
        ANTHROPIC_API_KEY: 'placeholder',
        CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
        GANTRY_IPC_AUTH_TOKEN: 'runner-test-token',
        GANTRY_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
      });

      expect(result.exitCode).toBe(0);
      const sdkEnv = readRecord(fixture.recordPath).calls[0]?.sdkEnv || {};
      expect(sdkEnv.ANTHROPIC_API_KEY).toBe('placeholder');
      expect(sdkEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'disables Claude Code git instructions for all personas',
    async () => {
      const developerFixture = createRunnerFixture();
      const developerResult = await runRunner(developerFixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(developerResult.exitCode).toBe(0);
      const developerCall = readRecord(developerFixture.recordPath).calls[0];
      expect(developerCall?.settings?.includeGitInstructions).toBe(false);
      expect(systemPromptText(developerCall)).toContain(
        'Configured working style: developer.',
      );
      expect(systemPromptText(developerCall)).toContain(
        'compiled system profile',
      );
      expect(systemPromptText(developerCall)).not.toContain('claude_code');

      const assistantFixture = createRunnerFixture();
      const assistantResult = await runRunner(
        assistantFixture,
        baseInput({ persona: 'generalist' }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
          [GANTRY_CLAUDE_SDK_SKILLS_ENV]: JSON.stringify([
            'gantry-admin',
            'gantry-browser',
            'linkedin-posting',
          ]),
        },
      );

      expect(assistantResult.exitCode).toBe(0);
      const assistantCall = readRecord(assistantFixture.recordPath).calls[0];
      expect(assistantCall?.settings?.includeGitInstructions).toBe(false);
      expect(systemPromptText(assistantCall)).toContain(
        'Configured working style: generalist.',
      );
      expect(systemPromptText(assistantCall)).toContain(
        'compiled system profile',
      );
      expect(systemPromptText(assistantCall)).not.toContain('claude_code');
    },
    SLOW_RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'hides Claude SDK-native skills while keeping the Skill tool available',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({ persona: 'generalist' }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
          [GANTRY_CLAUDE_SDK_SKILLS_ENV]: JSON.stringify([
            'gantry-admin',
            'gantry-browser',
            'linkedin-posting',
          ]),
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.tools).toContain('Skill');
      expect(call?.allowedTools).toContain('Skill');
      expect(call?.settings?.skillOverrides).toEqual(
        SDK_NATIVE_SKILL_OVERRIDES,
      );
      expect(call?.settingSources).toEqual([]);
      expect(call?.strictMcpConfig).toBe(true);
      expect(call?.skills).toEqual([
        'gantry-admin',
        'gantry-browser',
        'linkedin-posting',
      ]);
      expect(call?.skills).not.toEqual(
        expect.arrayContaining([
          'commands',
          'init',
          'review',
          'security-review',
          'update-config',
          'loop',
          'schedule',
        ]),
      );
      expect(call?.sdkEnv?.CLAUDE_CODE_DISABLE_POLICY_SKILLS).toBe('1');
      expect(call?.sdkEnv?.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL).toBe('1');
      expect(call?.sdkEnv?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
      expect(call?.sdkEnv?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'hides Claude SDK-native skills for session slash commands',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput({ prompt: '/model' }), {
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.promptKind).toBe('string');
      expect(call?.stringPrompt).toBe('/model');
      expect(systemPromptText(call)).toContain('Gantry-managed assistant');
      expect(systemPromptText(call)).toContain('compiled system profile');
      expect(systemPromptText(call)).not.toContain('claude_code');
      expect(call?.allowedTools).toEqual([]);
      expect(call?.skills).toEqual([]);
      expect(call?.settings?.includeGitInstructions).toBe(false);
      expect(call?.settings?.skillOverrides).toEqual(
        SDK_NATIVE_SKILL_OVERRIDES,
      );
      expect(call?.settingSources).toEqual([]);
      expect(call?.strictMcpConfig).toBe(true);
      expect(call?.sdkEnv?.CLAUDE_CODE_DISABLE_POLICY_SKILLS).toBe('1');
      expect(call?.sdkEnv?.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL).toBe('1');
      expect(call?.sdkEnv?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
      expect(call?.sdkEnv?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'exposes permission-gated native tools without allowing them by default',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({ persona: 'generalist' }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.tools).toEqual(
        expect.arrayContaining(['Bash', 'Write', 'Edit']),
      );
      expect(call?.allowedTools).not.toEqual(
        expect.arrayContaining(['Bash', 'Write', 'Edit']),
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'allows a tool from a live run permission rule without writing permission IPC',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({ persona: 'generalist' }),
        {
          TEST_TOOL_USE_ONLY: 'Bash',
          TEST_TOOL_USE_CMD: 'npm test --runInBand',
          TEST_LIVE_TOOL_RULE: 'RunCommand(npm test *)',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'allow',
        }),
      );
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'denies and surfaces every attempted tool in prime mode',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          runMode: 'prime',
          appId: 'app-1',
          agentId: 'agent-1',
          jobId: 'job-1',
          runId: 'run-1',
        }),
        {
          TEST_PRIME_TWO_TOOL_ATTEMPTS: '1',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.primeToolDecisions).toEqual({
        bash: expect.objectContaining({
          behavior: 'deny',
          interrupt: false,
        }),
        browser: expect.objectContaining({
          behavior: 'deny',
          interrupt: false,
        }),
      });
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);

      const outputs = readRunnerOutputs(result.stdout);
      const attemptEvents = outputs.flatMap((output) =>
        Array.isArray(output.runtimeEvents) ? output.runtimeEvents : [],
      ) as Array<{ eventType?: string; payload?: Record<string, unknown> }>;
      const permissionEvents = attemptEvents.filter(
        (event) => event.eventType === 'permission.requested',
      );
      expect(permissionEvents).toHaveLength(2);
      expect(permissionEvents.map((event) => event.eventType)).toEqual([
        'permission.requested',
        'permission.requested',
      ]);
      expect(permissionEvents.map((event) => event.payload?.toolName)).toEqual([
        'RunCommand',
        'Browser',
      ]);

      const finalOutput = outputs.at(-1);
      expect(finalOutput?.primeToolAttempts).toEqual([
        expect.objectContaining({
          toolName: 'RunCommand',
          suggestions: [
            {
              type: 'addRules',
              behavior: 'allow',
              destination: 'session',
              rules: [
                {
                  toolName: 'RunCommand',
                  ruleContent: 'npm test --runInBand',
                },
              ],
            },
          ],
        }),
        expect.objectContaining({
          requestedToolName: 'mcp__gantry__browser_act',
          toolName: 'Browser',
          suggestions: [
            {
              type: 'addRules',
              behavior: 'allow',
              destination: 'session',
              rules: [{ toolName: 'Browser' }],
            },
          ],
        }),
      ]);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'removes stale _close at startup before starting the SDK query',
    async () => {
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
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'removes stale _close at startup without discarding pending startup input',
    async () => {
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
      expect(fs.readdirSync(fixture.inputDir)).not.toContain(
        '001-pending.json',
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'drains pending startup IPC input into the initial prompt in filename order',
    async () => {
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
        ?.streamMessages?.[0] as string | undefined;
      expect(firstMessage).toContain('initial prompt');
      expect(firstMessage?.indexOf('startup first')).toBeLessThan(
        firstMessage?.indexOf('startup second') ?? -1,
      );
      expect(fs.readdirSync(fixture.inputDir)).not.toContain('001-first.json');
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'resumes and persists SDK sessions for live channel turns',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          appId: 'app-runner-test',
          agentId: 'agent:team',
          sessionId: 'stale-sdk-session',
        }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.persistSession).toBe(true);
      expect(call?.resume).toBe('stale-sdk-session');
      expect(call?.resumeSessionAt).toBeUndefined();
      const startupDiagnostics = readRunnerOutputs(result.stdout).flatMap(
        (output) =>
          Array.isArray(output.runtimeEvents) ? output.runtimeEvents : [],
      ) as Array<{ eventType?: string; payload?: Record<string, unknown> }>;
      expect(startupDiagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: 'run.startup_diagnostic',
            payload: expect.objectContaining({
              provider: ['anthropic', 'sdk'].join('_'),
              diagnostic: 'runner_startup_timing',
              persistSdkSession: true,
              resumedSession: true,
            }),
          }),
        ]),
      );
      expect(JSON.stringify(startupDiagnostics)).not.toContain(
        'stale-sdk-session',
      );
      expect(
        (call?.mcpServers?.gantry as { env?: Record<string, string> })?.env,
      ).toMatchObject({
        GANTRY_APP_ID: 'app-runner-test',
        GANTRY_AGENT_ID: 'agent:team',
      });
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'separates structured acknowledgements from streamed answers',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput(),
        {
          TEST_STRUCTURED_THEN_STREAM_SUCCESS_RESULT: '1',
          TEST_EXIT_AFTER_QUERY: '1',
        },
        RUNNER_IPC_TEST_TIMEOUT_MS,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const outputs = readRunnerOutputs(result.stdout);
      expect(outputs).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ status: 'error' })]),
      );
      const visibleResults = outputs
        .map((output) => output.result)
        .filter((value): value is string => typeof value === 'string');
      expect(visibleResults).toEqual([
        "I'll search for that.",
        expect.stringMatching(/^\n\n\*\*Claude Tag\*\*/),
      ]);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'keeps streamed credential result text as a terminal failure',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput(),
        {
          TEST_STRUCTURED_THEN_STREAM_CREDENTIAL_RESULT: '1',
          TEST_EXIT_AFTER_QUERY: '1',
        },
        RUNNER_IPC_TEST_TIMEOUT_MS,
      );

      expect(result.exitCode).toBe(1);
      expect(readRunnerOutputs(result.stdout)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'error',
            error: expect.stringContaining('invalid api key'),
          }),
        ]),
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'fails empty resumed SDK streams so the runtime can retry without resume',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({ sessionId: 'stale-sdk-session' }),
        {
          TEST_EMPTY_RESUMED_QUERY: '1',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(1);
      expect(readRecord(fixture.recordPath).calls[0]?.resume).toBe(
        'stale-sdk-session',
      );
      expect(readRunnerOutputs(result.stdout)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'error',
            error: expect.stringContaining(
              'No conversation found with session ID',
            ),
          }),
        ]),
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'fails empty new SDK streams instead of completing with no answer',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_EMPTY_QUERY: '1',
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(readRecord(fixture.recordPath).calls[0]?.resume).toBeUndefined();
      expect(readRunnerOutputs(result.stdout)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'error',
            error: expect.stringContaining(
              'Anthropic SDK query completed without messages or results',
            ),
          }),
        ]),
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'routes /compact through a persistent live streaming SDK query',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({ prompt: '/compact' }),
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.promptKind).toBe('stream');
      expect(call?.streamMessages?.[0]).toBe('/compact');
      expect(call?.persistSession).toBe(true);
      expect(call?.resume).toBeUndefined();
      expect(call?.resumeSessionAt).toBeUndefined();
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'does not resume or persist SDK sessions for scheduled job turns',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          sessionId: 'scheduled-sdk-session',
          isScheduledJob: true,
          jobId: 'job-1',
        }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.persistSession).toBe(false);
      expect(call?.resume).toBeUndefined();
      expect(call?.resumeSessionAt).toBeUndefined();
      expect(systemPromptText(call)).toContain('compiled system profile');
      expect(systemPromptText(call)).toContain('Run type: scheduled job.');
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'emits compact boundary markers for host memory extraction',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_COMPACT_BOUNDARY: '1',
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"compactBoundary":true');
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'emits scheduled job heartbeat runtime events during quiet query windows',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          appId: 'app-1',
          agentId: 'agent-1',
          isScheduledJob: true,
          jobId: 'job-1',
          runId: 'run-1',
          threadId: 'thread-1',
        }),
        {
          TEST_WAIT_FOR_HEARTBEAT: '1',
          TEST_EXIT_AFTER_QUERY: '1',
        },
        // This spawn must cover cold tsx runner boot + the full 15s heartbeat
        // interval + query completion. The default 25s spawn budget is too tight
        // serially / under load (the heartbeat fires correctly but the spawn is
        // SIGKILLed first), so give it a wider budget under a matching vitest
        // timeout.
        HEARTBEAT_RUNNER_TIMEOUT_MS,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('"eventType":"job.heartbeat"');
      expect(result.stdout).toContain('"jobId":"job-1"');
      expect(result.stdout).toContain('"runId":"run-1"');
      expect(result.stdout).toContain('"pendingPermissionRequests":0');
      expect(result.stdout).toContain('"totalToolCalls":0');
    },
    HEARTBEAT_TEST_TIMEOUT_MS,
  );

  it(
    'skips malformed startup IPC input while draining adjacent valid input',
    async () => {
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
        ?.streamMessages?.[0] as string | undefined;
      expect(firstMessage).toContain('initial prompt');
      expect(firstMessage).toContain(
        'valid startup context after malformed neighbor',
      );
      expect(fs.readdirSync(fixture.inputDir)).not.toContain(
        '000-malformed.json',
      );
      expect(fs.readdirSync(fixture.inputDir)).not.toContain('001-valid.json');
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'drains active-query IPC input into the stream in filename order',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput(),
        {
          TEST_ACTIVE_INPUT_ORDER: '1',
          TEST_EXIT_AFTER_QUERY: '1',
        },
        SLOW_RUNNER_IPC_TEST_TIMEOUT_MS,
      );

      expect(result.exitCode).toBe(0);
      const messages = readRecord(fixture.recordPath).calls[0]?.streamMessages;
      expect(messages).toEqual([
        'initial prompt',
        'active follow-up first',
        'active follow-up second',
      ]);
    },
    SLOW_RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'ends the active query stream when _close arrives during the query',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_CREATE_CLOSE_DURING_QUERY: '1',
      });

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.streamEnded).toBe(true);
      const outputs = readRunnerOutputs(result.stdout);
      expect(outputs.filter((output) => !output.runtimeEventOnly)).toHaveLength(
        1,
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'emits a user interaction boundary from MCP side-channel files',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_INTERACTION_BOUNDARY_FILE: '1',
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        '"interactionBoundary":"user_interaction"',
      );
      expect(
        fs.readdirSync(path.join(fixture.ipcDir, 'interaction-boundaries')),
      ).toHaveLength(0);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'bundles memory context with the first user prompt so it cannot produce a standalone reply',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          memoryContextBlock: 'Memory brief: user prefers concise updates.',
        }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(systemPromptText(call)).toContain('compiled system profile');
      expect(systemPromptText(call)).toContain(
        'Gantry Durable Memory Boundary',
      );
      expect(systemPromptText(call)).not.toContain('user prefers');
      expect(call?.streamMessages).toHaveLength(1);
      expect(call?.streamMessages?.[0]).toEqual([
        {
          type: 'text',
          text: 'Memory brief: user prefers concise updates.',
        },
        {
          type: 'text',
          text: 'initial prompt',
        },
      ]);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'routes SDK canUseTool approval through permission request and response IPC',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_PERMISSION_DECISION: 'approve',
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        '"interactionBoundary":"user_interaction"',
      );
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionRequest).toEqual(
        expect.objectContaining({
          sourceAgentFolder: 'team',
          runHandle: 'runner-test-run',
          toolName: 'RunCommand',
          signature: expect.any(String),
        }),
      );
      expect(call?.permissionRequest?.toolInput).toEqual(
        expect.objectContaining({ cmd: 'npm test', apiToken: 'secret-token' }),
      );
      expect(call?.permissionRequest?.suggestions).toEqual([
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [
            {
              toolName: 'RunCommand',
              ruleContent: 'npm test',
            },
          ],
        },
      ]);
      expect(call?.permissionDecision).toEqual({
        behavior: 'allow',
        updatedInput: {
          cmd: 'GODEBUG=netdns=go npm test',
          apiToken: 'secret-token',
        },
      });
      expect(
        fs.readdirSync(path.join(fixture.ipcDir, 'permission-responses')),
      ).toHaveLength(0);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'synthesizes exact persistent permission suggestions for Gantry admin tools',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_PERMISSION_DECISION: 'approve',
        TEST_PERMISSION_TOOL_NAME: 'mcp__gantry__service_restart',
        TEST_PERMISSION_SCOPE: 'environment:staging',
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionRequest).toEqual(
        expect.objectContaining({
          toolName: 'mcp__gantry__service_restart',
          suggestions: [
            {
              type: 'addRules',
              behavior: 'allow',
              destination: 'session',
              rules: [{ toolName: 'mcp__gantry__service_restart' }],
            },
          ],
        }),
      );
      expect(call?.permissionDecision).toEqual({
        behavior: 'allow',
        updatedInput: { scope: 'environment:staging' },
      });
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'canonicalizes interactive SDK permission suggestions to exact public tools',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_PERMISSION_DECISION: 'approve',
        TEST_PERMISSION_TOOL_NAME: 'mcp__gantry__browser_act',
        TEST_PERMISSION_SDK_SUGGESTION_TOOL_NAME: 'mcp__gantry__browser_act',
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionRequest).toEqual(
        expect.objectContaining({
          toolName: 'Browser',
          suggestions: [
            {
              type: 'addRules',
              behavior: 'allow',
              destination: 'session',
              rules: [{ toolName: 'Browser' }],
            },
          ],
        }),
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'accepts a signed SDK permission response that includes a decision mode',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_PERMISSION_DECISION: 'approve',
        TEST_PERMISSION_MODE: 'allow_once',
        TEST_PERMISSION_CLASSIFICATION: 'user_temporary',
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual({
        behavior: 'allow',
        updatedInput: {
          cmd: 'GODEBUG=netdns=go npm test',
          apiToken: 'secret-token',
        },
        decisionClassification: 'user_temporary',
      });
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'denies high-risk tool use when durable memory had suppressed instructions',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          memoryContextBlock:
            '<gantry_memory_context trust="untrusted_data_only">[suppressed: instruction-like memory content]</gantry_memory_context>',
        }),
        {
          TEST_MEMORY_GUARD_DENIAL: '1',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'deny',
          interrupt: false,
        }),
      );
      expect(String(call?.permissionDecision?.message)).toContain(
        'memory boundary',
      );
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'scheduled jobs include the autonomous tool contract in the prompt',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: [
            'Browser',
            'RunCommand(/Users/example/runtime/scripts/append-lead.py *)',
          ],
          toolAccessRequirements: ['Browser'],
          prompt: 'Find new leads.',
        }),
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      const prompt =
        (call?.stringPrompt as string | undefined) ??
        JSON.stringify(call?.streamMessages ?? []);
      expect(prompt).toContain('Final Job Report');
      expect(prompt).toContain('found, added, skipped, and errors');
      expect(prompt).toContain('Durable tool rules for this autonomous run:');
      expect(prompt).toContain(
        'RunCommand(/Users/example/runtime/scripts/append-lead.py *)',
      );
      expect(prompt).toContain('Do not wrap it in python -c');
      expect(prompt).toContain('Use browser_open early');
      expect(prompt).toContain(
        'Do not claim Browser was used or opened unless',
      );
      expect(prompt).toContain('Find new leads.');
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'scheduled jobs allow matching scoped RunCommand without writing permission IPC',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['RunCommand(npm test *)'],
        }),
        {
          TEST_TOOL_USE_ONLY: 'Bash',
          TEST_TOOL_USE_CMD: 'npm test --runInBand',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'allow',
        }),
      );
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'closes the SDK prompt stream for one-shot scheduled jobs',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
        }),
        {
          TEST_CHECK_STREAM_ENDED: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.streamMessages).toHaveLength(1);
      expect(call?.streamEnded).toBe(true);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'adds tool network env to allowed Bash tool calls',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['RunCommand(acme records *)'],
          toolNetworkEnv: {
            HTTP_PROXY: 'http://127.0.0.1:18080/',
            HTTPS_PROXY: 'http://127.0.0.1:18080/',
            http_proxy: 'http://127.0.0.1:18080/',
            https_proxy: 'http://127.0.0.1:18080/',
            ALL_PROXY: 'socks5h://127.0.0.1:18081',
            GRPC_PROXY: 'socks5h://127.0.0.1:18081',
            NODE_USE_ENV_PROXY: '1',
            NO_PROXY: '127.0.0.1,localhost,::1',
            no_proxy: '127.0.0.1,localhost,::1',
            REQUESTS_CA_BUNDLE: '/tmp/model_gateway-ca.pem',
          },
        }),
        {
          TEST_TOOL_USE_ONLY: 'Bash',
          TEST_TOOL_USE_CMD: 'acme records get budget',
        },
      );

      const trustPrefix = [
        'GODEBUG=netdns=go',
        "HTTP_PROXY='http://127.0.0.1:18080/'",
        "HTTPS_PROXY='http://127.0.0.1:18080/'",
        "http_proxy='http://127.0.0.1:18080/'",
        "https_proxy='http://127.0.0.1:18080/'",
        "ALL_PROXY='socks5h://127.0.0.1:18081'",
        "GRPC_PROXY='socks5h://127.0.0.1:18081'",
        "NODE_USE_ENV_PROXY='1'",
        "NO_PROXY='127.0.0.1,localhost,::1'",
        "no_proxy='127.0.0.1,localhost,::1'",
        "REQUESTS_CA_BUNDLE='/tmp/model_gateway-ca.pem'",
      ].join(' ');

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual({
        behavior: 'allow',
        updatedInput: {
          cmd: `${trustPrefix} acme records get budget`,
        },
      });
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'suppresses SDK sandbox network prompts after Gantry allowed a scoped tool',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['RunCommand(npm test *)'],
        }),
        {
          TEST_SDK_NETWORK_AFTER_TOOL: '1',
          TEST_TOOL_USE_CMD: 'npm test --runInBand',
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"eventType":"sandbox.blocked"');
      expect(result.stdout).toContain('sdk_network_gate_suppressed');
      expect(result.stdout).toContain(
        `"networkToolUseIDHash":"${sha256('toolu_network_1')}"`,
      );
      expect(result.stdout).toContain(
        `"parentToolUseIDHash":"${sha256('toolu_bash_1')}"`,
      );
      expect(result.stdout).not.toContain(
        '"networkToolUseID":"toolu_network_1"',
      );
      expect(result.stdout).not.toContain('"parentToolUseID":"toolu_bash_1"');
      expect(result.stdout).toContain('"approvedToolName":"Bash"');
      expect(result.stdout).toContain('"inputHash"');
      expect(result.stdout).toContain('"hostHash"');
      expect(result.stdout).not.toContain('registry.npmjs.org');
      expect(result.stdout).not.toContain('npm test --runInBand');
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecisions?.tool).toEqual(
        expect.objectContaining({
          behavior: 'allow',
        }),
      );
      expect(call?.permissionDecisions?.network).toEqual({
        behavior: 'allow',
        updatedInput: { host: 'registry.npmjs.org' },
      });
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'suppresses repeated SDK sandbox network prompts for an allowed tool invocation',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['RunCommand(npm test *)'],
        }),
        {
          TEST_SDK_NETWORK_AFTER_TOOL: '1',
          TEST_SECOND_SDK_NETWORK_AFTER_TOOL: '1',
          TEST_TOOL_USE_CMD: 'npm test --runInBand',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecisions?.network).toEqual({
        behavior: 'allow',
        updatedInput: { host: 'registry.npmjs.org' },
      });
      expect(call?.permissionDecisions?.network2).toEqual({
        behavior: 'allow',
        updatedInput: { host: 'example.com' },
      });
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'scheduled jobs correlate parentless SDK network prompts through typed local CLI runtime access',
    async () => {
      const fixture = createRunnerFixture();
      const credentialDir = path.join(fixture.root, 'credentials', 'acme');
      fs.mkdirSync(credentialDir, { recursive: true });

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['RunCommand(/opt/homebrew/bin/acme records get *)'],
          runtimeAccess: [
            {
              selectedCapabilityId: 'acme.records.get',
              sourceType: 'local_cli',
              auditLabel: 'Fixture Records get',
              commandRules: [
                'RunCommand(/opt/homebrew/bin/acme records get *)',
              ],
              credentialDirs: [credentialDir],
              networkBindings: [
                {
                  commandRules: [
                    'RunCommand(/opt/homebrew/bin/acme records get *)',
                  ],
                  hosts: ['oauth2.googleapis.com', 'records.googleapis.com'],
                },
              ],
            },
          ],
        }),
        {
          TEST_SDK_NETWORK_AFTER_TOOL: '1',
          TEST_PARENTLESS_SDK_NETWORK_AFTER_TOOL: '1',
          TEST_SDK_NETWORK_HOST: 'oauth2.googleapis.com',
          TEST_TOOL_USE_CMD:
            '/opt/homebrew/bin/acme records get fixture_sheet_001 "Fixture Leads!A1:Z1" --json --account operator@example.test',
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        'sdk_network_gate_suppressed_parentless_recent_tool',
      );
      const call = readRecord(fixture.recordPath).calls[0];
      const expectedCredentialDir = path.join(
        fs.realpathSync.native(path.dirname(credentialDir)),
        path.basename(credentialDir),
      );
      expect(call?.additionalDirectories).toEqual(
        expect.arrayContaining([expectedCredentialDir]),
      );
      expect(call?.permissionDecisions?.network).toEqual({
        behavior: 'allow',
        updatedInput: { host: 'oauth2.googleapis.com' },
      });
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'denies parentless SDK sandbox network prompts after a scheduled command without host binding',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['RunCommand(/opt/homebrew/bin/acme records get *)'],
        }),
        {
          TEST_SDK_NETWORK_AFTER_TOOL: '1',
          TEST_PARENTLESS_SDK_NETWORK_AFTER_TOOL: '1',
          TEST_TOOL_USE_CMD:
            '/opt/homebrew/bin/acme records get fixture_sheet_001 "Fixture Leads!A1:Z1" --json --account operator@example.test',
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('sdk_network_gate_denied');
      expect(result.stdout).toContain(
        `"networkToolUseIDHash":"${sha256('toolu_network_1')}"`,
      );
      expect(result.stdout).not.toContain('"parentToolUseID":"toolu_bash_1"');
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecisions?.tool).toEqual(
        expect.objectContaining({
          behavior: 'allow',
        }),
      );
      expect(call?.permissionDecisions?.network).toEqual({
        behavior: 'deny',
        interrupt: false,
        message:
          'SDK requested sandbox network access without a parent tool-use id. Approve the tool call through Gantry first.',
      });
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'scheduled jobs request permission when Bash is missing and resume after approval',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['Read'],
        }),
        {
          GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS: '5000',
          TEST_PERMISSION_DECISION: 'approve',
          TEST_PERMISSION_TOOL_NAME: 'Bash',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        '"interactionBoundary":"user_interaction"',
      );
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'allow',
        }),
      );
      expect(call?.permissionRequest).toEqual(
        expect.objectContaining({
          targetJid: 'tg:team',
          sourceAgentFolder: 'team',
          toolName: 'RunCommand',
        }),
      );
      expect(call?.permissionRequest?.context).toEqual(
        expect.objectContaining({ chatJid: 'tg:team' }),
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'scheduled jobs apply persistent permission approvals to the active run',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['Read'],
        }),
        {
          GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS: '5000',
          TEST_PERMISSION_DECISION: 'approve',
          TEST_PERMISSION_MODE: 'allow_persistent_rule',
          TEST_PERMISSION_CLASSIFICATION: 'user_permanent',
          TEST_PERMISSION_RETURN_SUGGESTIONS: '1',
          TEST_PERMISSION_TOOL_NAME: 'Bash',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'allow',
          decisionClassification: 'user_permanent',
        }),
      );
      expect(call?.permissionRequest?.suggestions).toEqual([
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [
            {
              toolName: 'RunCommand',
              ruleContent: 'npm test',
            },
          ],
        },
      ]);
      expect(call?.permissionDecision?.updatedPermissions).toEqual(
        call?.permissionRequest?.suggestions,
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'scheduled jobs deny unsupported exact tool grants without permission prompts',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: [],
        }),
        {
          TEST_AUTONOMOUS_PERMISSION_REQUEST: '1',
          TEST_PERMISSION_TOOL_NAME: 'WebSearch',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'deny',
          interrupt: false,
        }),
      );
      expect(String(call?.permissionDecision?.message)).toContain(
        'Use a reviewed semantic capability from the Agent Access summary for WebSearch',
      );
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'scheduled jobs allow materialized selected MCP server tools',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: [],
          attachedMcpSourceIds: ['mcp:github'],
        }),
        {
          GANTRY_MCP_ALLOWED_TOOLS_JSON: JSON.stringify([
            'mcp__github__search_repositories',
          ]),
          TEST_TOOL_USE_ONLY: 'mcp__github__search_repositories',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'allow',
        }),
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'fails SDK canUseTool closed when permission response denies the request',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_PERMISSION_DECISION: 'deny',
        TEST_PERMISSION_CLASSIFICATION: 'user_reject',
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'deny',
          message: 'Permission denied: deny',
          interrupt: false,
          decisionClassification: 'user_reject',
        }),
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );
});
