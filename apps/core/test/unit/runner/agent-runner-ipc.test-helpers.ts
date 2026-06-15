/**
 * Shared real-runner test harness for the Anthropic Claude Agent runner.
 *
 * Extracted verbatim from `agent-runner-ipc.test.ts` (no behavior change) so the
 * warm-pool spike (`warm-pool-spike.test.ts`) can reuse the exact same fixture:
 * a temp root with the real runner source copied in and a filesystem-injected
 * fake SDK. The fake SDK additionally exposes a single-use `startup()`/
 * `WarmQuery` primitive (F10) for the warm-pool path; the cold `query()` path is
 * unchanged.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createHash, generateKeyPairSync } from 'crypto';

const tempRoots: string[] = [];

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Register the temp-root cleanup with a vitest `afterEach`. Each importing test
 * file calls this once at module scope so fixtures are torn down between tests.
 */
export function registerRunnerFixtureCleanup(
  afterEach: (fn: () => void) => void,
): void {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

export interface RunnerRecord {
  calls: Array<{
    promptKind: 'stream' | 'string';
    streamMessages?: unknown[];
    stringPrompt?: string;
    systemPromptAppend?: string;
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
  }>;
  /** Count of fake-SDK `startup()` calls (warm-pool boot). */
  startupCalls?: number;
  /** True if a 2nd `WarmQuery.query()` threw (single-use enforced, F10). */
  warmQueryDoubleCallThrew?: boolean;
}

export function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-runner-test-'));
  tempRoots.push(root);
  return root;
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function createRunnerFixture(): {
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
    path.resolve('apps/core/src/runner/memory-boundary.ts'),
    path.join(runnerDir, 'memory-boundary.ts'),
  );
  // Warm-pool (F4): the runner imports the bound-identity accessor to publish
  // the bound chatJid at bind. Copy it into the fixture's runner/mcp dir.
  const runnerMcpDir = path.join(runnerDir, 'mcp');
  fs.mkdirSync(runnerMcpDir, { recursive: true });
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/mcp/bound-identity.ts'),
    path.join(runnerMcpDir, 'bound-identity.ts'),
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
    path.resolve('apps/core/src/shared/no-proxy.ts'),
    path.join(sharedDir, 'no-proxy.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/neutral-ca-trust-env.ts'),
    path.join(sharedDir, 'neutral-ca-trust-env.ts'),
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
    path.resolve('apps/core/src/shared/model-provider-registry.ts'),
    path.join(sharedDir, 'model-provider-registry.ts'),
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
    path.resolve('apps/core/src/shared/admin-mcp-tools.ts'),
    path.join(sharedDir, 'admin-mcp-tools.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/gantry-mcp-tool-catalog.ts'),
    path.join(sharedDir, 'gantry-mcp-tool-catalog.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/native-sdk-tool-names.ts'),
    path.join(sharedDir, 'native-sdk-tool-names.ts'),
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
    path.resolve('apps/core/src/shared/persistent-permission-rules.ts'),
    path.join(sharedDir, 'persistent-permission-rules.ts'),
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appendRecord(call) {
  const recordPath = process.env.TEST_SDK_RECORD_PATH;
  const current = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, 'utf-8'))
    : { calls: [] };
  current.calls.push(call);
  fs.writeFileSync(recordPath, JSON.stringify(current, null, 2));
}

// Warm-pool (F10): record the single-use startup()/WarmQuery lifecycle on the
// SAME record file, under dedicated top-level keys so the cold calls array is
// untouched.
function appendStartupRecord() {
  const recordPath = process.env.TEST_SDK_RECORD_PATH;
  const current = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, 'utf-8'))
    : { calls: [] };
  current.startupCalls = (current.startupCalls || 0) + 1;
  fs.writeFileSync(recordPath, JSON.stringify(current, null, 2));
}

function appendWarmQueryDoubleCall() {
  const recordPath = process.env.TEST_SDK_RECORD_PATH;
  const current = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, 'utf-8'))
    : { calls: [] };
  current.warmQueryDoubleCallThrew = true;
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
    systemPromptAppend: options?.systemPrompt?.append,
    closeExistsAtQueryStart: fs.existsSync(
      path.join(process.env.GANTRY_IPC_INPUT_DIR, '_close'),
    ),
  };

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
  if (process.env.TEST_COMPACT_BOUNDARY === '1') {
    yield { type: 'system', subtype: 'compact_boundary', uuid: 'compact-1' };
  }
  if (process.env.TEST_TASK_NOTIFICATION === '1') {
    yield {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      status: 'completed',
      summary: 'subagent done',
    };
  }
  if (process.env.TEST_STREAM_TEXT_THEN_TOOL_USE === '1') {
    yield {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Let me check that.' },
      },
    };
    yield {
      type: 'assistant',
      uuid: 'assistant-tool-1',
      message: {
        content: [
          { type: 'text', text: 'Let me check that.' },
          { type: 'tool_use', id: 'toolu_1', name: 'mcp_call_tool' },
        ],
      },
    };
    yield { type: 'result', subtype: 'success', result: '' };
    yield {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Here is the actual answer.' },
      },
    };
    yield {
      type: 'assistant',
      uuid: 'assistant-final-1',
      message: {
        content: [{ type: 'text', text: 'Here is the actual answer.' }],
      },
    };
    yield { type: 'result', subtype: 'success', result: '' };
    return;
  }
  // Warm-pool: when a bind carries sample token usage, surface it on the result
  // so the envelope cache-plumbing (detail.tokens.cacheRead/cacheWrite) can be
  // asserted (gate criterion 4). Cold path leaves usage undefined as before.
  const warmUsageRaw = process.env.GANTRY_SPIKE_USAGE;
  if (warmUsageRaw) {
    let warmUsage;
    try {
      warmUsage = JSON.parse(warmUsageRaw);
    } catch {
      warmUsage = undefined;
    }
    if (warmUsage) {
      const warmUsageTokens = {
        input_tokens: warmUsage.in ?? 0,
        output_tokens: warmUsage.out ?? 0,
        cache_read_input_tokens: warmUsage.cacheRead ?? 0,
        cache_creation_input_tokens: warmUsage.cacheWrite ?? 0,
      };
      // Mirror the real SDK ordering: message_start (turn start) → assistant
      // (carries message.usage so the turn accumulator records detail.tokens) →
      // message_delta (final usage) → result. This exercises the full cache
      // token plumbing through to turns[].detail.tokens + the result usage.
      yield {
        type: 'stream_event',
        event: { type: 'message_start' },
      };
      yield {
        type: 'assistant',
        uuid: 'assistant-warm-1',
        message: {
          id: 'msg-warm-1',
          content: [{ type: 'text', text: 'warm reply' }],
          usage: warmUsageTokens,
        },
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: warmUsageTokens,
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'runner-ok',
        usage: warmUsageTokens,
      };
      if (process.env.TEST_EXIT_AFTER_QUERY === '1') {
        setTimeout(() => {
          fs.mkdirSync(process.env.GANTRY_IPC_INPUT_DIR, { recursive: true });
          fs.writeFileSync(path.join(process.env.GANTRY_IPC_INPUT_DIR, '_close'), '');
        }, 20);
      }
      return;
    }
  }
  yield { type: 'result', subtype: 'success', result: 'runner-ok' };

  if (process.env.TEST_EXIT_AFTER_QUERY === '1') {
    setTimeout(() => {
      fs.mkdirSync(process.env.GANTRY_IPC_INPUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.GANTRY_IPC_INPUT_DIR, '_close'), '');
    }, 20);
  }
}

// Warm-pool primitive (F10): startup() pre-warms the CLI subprocess and returns
// a single-use WarmQuery. query() delegates to the cold generator above (so the
// recording + behavior are identical); a second query() throws and is recorded.
export async function startup(_params = {}) {
  appendStartupRecord();
  let used = false;
  const warm = {
    query(prompt) {
      if (used) {
        appendWarmQueryDoubleCall();
        throw new Error('Can only be called once per WarmQuery');
      }
      used = true;
      return query({ prompt, options: _params.options });
    },
    close() {},
    async [Symbol.asyncDispose]() {
      this.close();
    },
  };
  return warm;
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

export function baseInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    prompt: 'initial prompt',
    groupFolder: 'team',
    chatJid: 'tg:team',
    compiledSystemPrompt: 'compiled system profile',
    ...overrides,
  };
}

export async function runRunner(
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
    }, 25_000);
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

export function readRecord(recordPath: string): RunnerRecord {
  return JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as RunnerRecord;
}

export function readRunnerOutputs(
  stdout: string,
): Array<Record<string, unknown>> {
  const matches = [
    ...stdout.matchAll(
      /---GANTRY_OUTPUT_START---\n([\s\S]*?)\n---GANTRY_OUTPUT_END---/g,
    ),
  ];
  return matches.map((match) => JSON.parse(match[1] ?? '{}'));
}
