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

interface RunnerRecord {
  calls: Array<{
    promptKind: 'stream' | 'string';
    streamMessages?: unknown[];
    stringPrompt?: string;
    systemPromptAppend?: string;
    closeExistsAtQueryStart?: boolean;
    streamEnded?: boolean;
    permissionRequest?: Record<string, unknown>;
    permissionDecision?: Record<string, unknown>;
    tools?: string[];
    allowedTools?: string[];
    sdkEnv?: Record<string, string>;
    mcpServers?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    sandbox?: Record<string, unknown>;
    persistSession?: boolean;
    resume?: unknown;
    resumeSessionAt?: unknown;
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
  const runnerClaudeDir = path.join(runnerDir, 'claude');
  const infrastructureLoggingDir = path.join(root, 'infrastructure', 'logging');
  const sharedDir = path.join(root, 'shared');
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
  fs.mkdirSync(runnerDir, { recursive: true });
  fs.mkdirSync(runnerClaudeDir, { recursive: true });
  fs.mkdirSync(infrastructureLoggingDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(sharedTimeDir, { recursive: true });
  for (const file of fs.readdirSync(
    path.resolve('apps/core/src/runner/claude'),
  )) {
    if (file.endsWith('.ts')) {
      fs.copyFileSync(
        path.resolve('apps/core/src/runner/claude', file),
        path.join(runnerClaudeDir, file),
      );
    }
  }
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/agent-capabilities.ts'),
    path.join(runnerDir, 'agent-capabilities.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/myclaw-mcp-tool-surface.ts'),
    path.join(runnerDir, 'myclaw-mcp-tool-surface.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/memory-boundary.ts'),
    path.join(runnerDir, 'memory-boundary.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/runner/claude/message-stream.ts'),
    path.join(runnerClaudeDir, 'message-stream.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/infrastructure/logging/logger.ts'),
    path.join(infrastructureLoggingDir, 'logger.ts'),
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
    path.resolve('apps/core/src/shared/object.ts'),
    path.join(sharedDir, 'object.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/model-catalog.ts'),
    path.join(sharedDir, 'model-catalog.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/agent-persona.ts'),
    path.join(sharedDir, 'agent-persona.ts'),
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
    path.resolve('apps/core/src/shared/permission-timeout.ts'),
    path.join(sharedDir, 'permission-timeout.ts'),
  );
  fs.copyFileSync(
    path.resolve('apps/core/src/shared/myclaw-home.ts'),
    path.join(sharedDir, 'myclaw-home.ts'),
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

function signPayload(payload) {
  const signingKey = process.env.TEST_IPC_RESPONSE_SIGNING_KEY || '';
  if (!signingKey) return undefined;
  return cryptoSign(null, Buffer.from(JSON.stringify(payload)), signingKey).toString('base64');
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
    sdkEnv: options?.env,
    mcpServers: options?.mcpServers,
    settings: options?.settings,
    sandbox: options?.sandbox,
    tools: options?.tools,
    allowedTools: options?.allowedTools,
    persistSession: options?.persistSession,
    resume: options?.resume,
    resumeSessionAt: options?.resumeSessionAt,
    systemPromptAppend: options?.systemPrompt?.append,
    closeExistsAtQueryStart: fs.existsSync(
      path.join(process.env.MYCLAW_IPC_INPUT_DIR, '_close'),
    ),
  };

  yield {
    type: 'system',
    subtype: 'init',
    session_id: 'runner-session-1',
    mcp_servers: [{ name: 'myclaw', status: 'connected' }],
  };

  if (process.env.TEST_MEMORY_GUARD_DENIAL) {
    call.permissionDecision = await options.canUseTool(
      'Bash',
      { cmd: 'rm -rf /tmp/myclaw-poisoned-memory' },
      {
        signal: new AbortController().signal,
        title: 'Run command',
        displayName: 'Bash',
        description: 'Needs shell access',
        decisionReason: 'Agent wants to run command from memory context',
        blockedPath: process.env.MYCLAW_WORKSPACE_GROUP_DIR,
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
        blockedPath: process.env.MYCLAW_WORKSPACE_GROUP_DIR,
      },
    );
    const requestDir = path.join(process.env.MYCLAW_IPC_DIR, 'permission-requests');
    const responseDir = path.join(process.env.MYCLAW_IPC_DIR, 'permission-responses');
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

	  if (process.env.TEST_TOOL_USE_ONLY) {
	    if (process.env.TEST_LIVE_TOOL_RULE) {
	      const runHandle = process.env.MYCLAW_AGENT_RUN_HANDLE;
	      const liveDir = path.join(process.env.MYCLAW_IPC_DIR, 'live-tool-rules');
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
        blockedPath: process.env.MYCLAW_WORKSPACE_GROUP_DIR,
      },
    );
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
          fs.writeFileSync(path.join(process.env.MYCLAW_IPC_INPUT_DIR, '_close'), '');
        }, 20);
      }
      return;
    }

    if (process.env.TEST_INTERACTION_BOUNDARY_FILE === '1') {
      const boundaryDir = path.join(process.env.MYCLAW_IPC_DIR, 'interaction-boundaries');
      fs.mkdirSync(boundaryDir, { recursive: true });
      fs.writeFileSync(
        path.join(boundaryDir, 'boundary-1.json'),
        JSON.stringify({ type: 'user_interaction', tool: 'ask_user_question' }),
      );
      await delay(700);
    }

    if (process.env.TEST_CREATE_CLOSE_DURING_QUERY === '1') {
      fs.writeFileSync(path.join(process.env.MYCLAW_IPC_INPUT_DIR, '_close'), '');
      const closed = await nextWithTimeout(iterator, 1500);
      call.streamEnded = Boolean(closed?.done);
    }
  }

  appendRecord(call);
  if (process.env.TEST_COMPACT_BOUNDARY === '1') {
    yield { type: 'system', subtype: 'compact_boundary', uuid: 'compact-1' };
  }
  yield { type: 'result', subtype: 'success', result: 'runner-ok' };

  if (process.env.TEST_EXIT_AFTER_QUERY === '1') {
    setTimeout(() => {
      fs.writeFileSync(path.join(process.env.MYCLAW_IPC_INPUT_DIR, '_close'), '');
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
    groupFolder: 'team',
    chatJid: 'tg:team',
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
        MYCLAW_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
        MYCLAW_AGENT_RUN_HANDLE: 'runner-test-run',
        TEST_IPC_RESPONSE_SIGNING_KEY: fixture.responseSigningKey,
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

function readRecord(recordPath: string): RunnerRecord {
  return JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as RunnerRecord;
}

const RUNNER_IPC_TEST_TIMEOUT_MS = 35_000;

describe('agent-runner IPC lifecycle', () => {
  it(
    'passes only broker-safe values into the Agent SDK env',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          modelCredentialEnv: {
            ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
            HTTP_PROXY: 'http://127.0.0.1:10255/',
            HTTPS_PROXY: 'http://127.0.0.1:10255/',
            NODE_USE_ENV_PROXY: '1',
            NODE_EXTRA_CA_CERTS: '/tmp/onecli-ca.pem',
          },
        }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
          ANTHROPIC_API_KEY: 'raw-provider-key',
          CLAUDE_CODE_OAUTH_TOKEN: 'raw-oauth-token',
          HTTP_PROXY: 'http://127.0.0.1:10255/',
          HTTPS_PROXY: 'http://127.0.0.1:10255/',
          NODE_USE_ENV_PROXY: '1',
          GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
          NO_PROXY: '',
          no_proxy: '',
          NODE_EXTRA_CA_CERTS: '/tmp/onecli-ca.pem',
          MYCLAW_IPC_AUTH_TOKEN: 'runner-test-token',
          MYCLAW_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
        },
      );

      expect(result.exitCode).toBe(0);
      const sdkEnv = readRecord(fixture.recordPath).calls[0]?.sdkEnv || {};
      expect(sdkEnv.ANTHROPIC_BASE_URL).toBe('https://broker.local/anthropic');
      expect(sdkEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(sdkEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(sdkEnv.HTTP_PROXY).toBe('http://127.0.0.1:10255/');
      expect(sdkEnv.HTTPS_PROXY).toBe('http://127.0.0.1:10255/');
      expect(sdkEnv.NODE_USE_ENV_PROXY).toBe('1');
      expect(sdkEnv.GIT_HTTP_PROXY_AUTHMETHOD).toBeUndefined();
      expect(sdkEnv.NODE_EXTRA_CA_CERTS).toBe('/tmp/onecli-ca.pem');
      expect(sdkEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
      expect(sdkEnv.NO_PROXY?.split(',')).toEqual(
        expect.arrayContaining([
          '127.0.0.1',
          'localhost',
          '::1',
          'github.com',
          '.github.com',
          'api.github.com',
          'raw.githubusercontent.com',
          'objects.githubusercontent.com',
          'codeload.github.com',
        ]),
      );
      expect(sdkEnv.no_proxy).toBe(sdkEnv.NO_PROXY);
      expect(sdkEnv.MYCLAW_IPC_AUTH_TOKEN).toBeUndefined();
      expect(sdkEnv.MYCLAW_IPC_RESPONSE_VERIFY_KEY).toBeUndefined();
      expect(sdkEnv.MYCLAW_MCP_CONFIG_FILE).toBeUndefined();
      expect(sdkEnv.MYCLAW_MCP_SERVERS_JSON).toBeUndefined();
      expect(sdkEnv.MYCLAW_MCP_ALLOWED_TOOLS_JSON).toBeUndefined();
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
        MYCLAW_PROTECTED_FILESYSTEM_PATHS_JSON: JSON.stringify([
          claudeConfigDir,
          handoffPath,
        ]),
      });

      expect(result.exitCode).toBe(0);
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
    'rejects host-private agent_browser MCP config from a private file',
    async () => {
      const fixture = createRunnerFixture();
      const mcpConfigPath = path.join(fixture.root, 'mcp-config.json');
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          agent_browser: {
            type: 'stdio',
            command: '/tmp/raw-browser-backend',
            args: ['--unsafe-shared-context'],
            env: { RAW_BROWSER_BACKEND_ENDPOINT: 'http://127.0.0.1:4567' },
          },
        }),
      );

      const result = await runRunner(fixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
        MYCLAW_MCP_CONFIG_FILE: mcpConfigPath,
        MYCLAW_MCP_ALLOWED_TOOLS_JSON: JSON.stringify([
          'mcp__agent_browser__*',
        ]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('agent_browser is host-private');
      expect(fs.existsSync(fixture.recordPath)).toBe(false);
      expect(fs.existsSync(mcpConfigPath)).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'rejects legacy @playwright/mcp config from a private file',
    async () => {
      const fixture = createRunnerFixture();
      const mcpConfigPath = path.join(fixture.root, 'mcp-config.json');
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          playwright: {
            type: 'stdio',
            command: '/tmp/node_modules/.bin/playwright-mcp',
            args: ['--shared-browser-context'],
            env: {
              PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:4567',
            },
          },
        }),
      );

      const result = await runRunner(fixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
        MYCLAW_MCP_CONFIG_FILE: mcpConfigPath,
        MYCLAW_MCP_ALLOWED_TOOLS_JSON: JSON.stringify([
          'mcp__playwright__browser_click',
        ]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('playwright is host-private');
      expect(fs.existsSync(fixture.recordPath)).toBe(false);
      expect(fs.existsSync(mcpConfigPath)).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'passes broker placeholder auth values into the Agent SDK env',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
        ANTHROPIC_API_KEY: 'placeholder',
        CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
        MYCLAW_IPC_AUTH_TOKEN: 'runner-test-token',
        MYCLAW_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
      });

      expect(result.exitCode).toBe(0);
      const sdkEnv = readRecord(fixture.recordPath).calls[0]?.sdkEnv || {};
      expect(sdkEnv.ANTHROPIC_API_KEY).toBe('placeholder');
      expect(sdkEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('placeholder');
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'keeps Claude Code git instructions only for developer persona',
    async () => {
      const developerFixture = createRunnerFixture();
      const developerResult = await runRunner(developerFixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(developerResult.exitCode).toBe(0);
      expect(
        readRecord(developerFixture.recordPath).calls[0]?.settings
          ?.includeGitInstructions,
      ).toBe(true);

      const assistantFixture = createRunnerFixture();
      const assistantResult = await runRunner(
        assistantFixture,
        baseInput({ persona: 'personal_assistant' }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(assistantResult.exitCode).toBe(0);
      expect(
        readRecord(assistantFixture.recordPath).calls[0]?.settings
          ?.includeGitInstructions,
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'exposes permission-gated native tools without allowing them by default',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({ persona: 'personal_assistant' }),
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
        baseInput({ persona: 'personal_assistant' }),
        {
          TEST_TOOL_USE_ONLY: 'Bash',
          TEST_TOOL_USE_CMD: 'npm test --runInBand',
          TEST_LIVE_TOOL_RULE: 'Bash(npm test *)',
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
    'resumes persisted SDK sessions for live channel turns',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({ sessionId: 'stale-sdk-session' }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.persistSession).toBe(true);
      expect(call?.resume).toBe('stale-sdk-session');
      expect(call?.resumeSessionAt).toBeUndefined();
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'routes /compact through the live streaming SDK session with persistence',
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
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
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
      expect(result.stdout.match(/---MYCLAW_OUTPUT_START---/g)).toHaveLength(1);
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
      expect(call?.systemPromptAppend).toContain('compiled system profile');
      expect(call?.systemPromptAppend).toContain(
        'MyClaw Durable Memory Boundary',
      );
      expect(call?.systemPromptAppend).not.toContain('user prefers');
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
          toolName: 'Bash',
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
              toolName: 'Bash',
              ruleContent: call.permissionRequest.blockedPath,
            },
          ],
        },
      ]);
      expect(call?.permissionDecision).toEqual({
        behavior: 'allow',
        updatedInput: { cmd: 'npm test', apiToken: 'secret-token' },
      });
      expect(
        fs.readdirSync(path.join(fixture.ipcDir, 'permission-responses')),
      ).toHaveLength(0);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'synthesizes persistent permission suggestions from host blockedPath, not agent input',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_PERMISSION_DECISION: 'approve',
        TEST_PERMISSION_TOOL_NAME: 'mcp__internal__deploy_preview',
        TEST_PERMISSION_SCOPE: 'environment:staging',
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionRequest).toEqual(
        expect.objectContaining({
          toolName: 'mcp__internal__deploy_preview',
          suggestions: [
            {
              type: 'addRules',
              behavior: 'allow',
              destination: 'session',
              rules: [
                {
                  toolName: 'mcp__internal__deploy_preview',
                  ruleContent: call.permissionRequest.blockedPath,
                },
              ],
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
        updatedInput: { cmd: 'npm test', apiToken: 'secret-token' },
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
            '<myclaw_memory_context trust="untrusted_data_only">[suppressed: instruction-like memory content]</myclaw_memory_context>',
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
    'scheduled jobs allow scoped Bash rules without writing permission IPC',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['Bash(npm test *)'],
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
    'scheduled jobs deny nonmatching scoped Bash rules without writing permission IPC',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['Bash(dedup-append-lead.py *)'],
        }),
        {
          TEST_TOOL_USE_ONLY: 'Bash',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(1);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'deny',
          interrupt: true,
        }),
      );
      expect(String(call?.permissionDecision?.message)).toContain(
        'Tool not on autonomous job allowlist: Bash',
      );
      expect(String(call?.permissionDecision?.message)).toContain(
        'scheduler_grant_tool { "job_id": "job-1", "rule": "Bash(npm test)" }',
      );
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'scheduled jobs deny missing tools without writing permission IPC',
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
          TEST_TOOL_USE_ONLY: 'Bash',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(1);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'deny',
          interrupt: true,
        }),
      );
      expect(String(call?.permissionDecision?.message)).toContain(
        'Tool not on autonomous job allowlist: Bash',
      );
      expect(String(call?.permissionDecision?.message)).toContain(
        'scheduler_grant_tool { "job_id": "job-1", "rule": "Bash(npm test)" }',
      );
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
      expect(result.stdout).not.toContain(
        '"interactionBoundary":"user_interaction"',
      );
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'scheduled jobs do not inherit default interactive tools',
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
          TEST_TOOL_USE_ONLY: 'WebSearch',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode).toBe(1);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toEqual(
        expect.objectContaining({
          behavior: 'deny',
          interrupt: true,
        }),
      );
      expect(String(call?.permissionDecision?.message)).toContain(
        'Tool not on autonomous job allowlist: WebSearch',
      );
      expect(String(call?.permissionDecision?.message)).toContain(
        'scheduler_grant_tool { "job_id": "job-1", "rule": "WebSearch" }',
      );
      expect(
        fs.existsSync(path.join(fixture.ipcDir, 'permission-requests')),
      ).toBe(false);
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
