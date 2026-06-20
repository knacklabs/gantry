import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GANTRY_CLAUDE_SDK_SKILLS_ENV,
  SDK_NATIVE_SKILL_OVERRIDES,
} from '@core/adapters/llm/anthropic-claude-agent/native-sdk-skills.js';
import {
  startIpcSocketServer,
  type IpcSocketServerHandle,
} from '@core/runtime/ipc-socket-server.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { makeSocketContinuationDelivery } from '@core/runtime/continuation-delivery.js';
// The fixture + fake-SDK harness is extracted into a shared helper module (no
// behavior change) so the warm-pool spike can reuse the exact same real runner +
// filesystem-injected fake SDK.
import {
  baseInput,
  createRunnerFixture,
  readRecord,
  readRunnerOutputs,
  registerRunnerFixtureCleanup,
  runRunner,
  sha256,
  writeJson,
} from './agent-runner-ipc.test-helpers.js';

registerRunnerFixtureCleanup(afterEach);

const RUNNER_IPC_TEST_TIMEOUT_MS = 35_000;
const SOCKET_RUNNER_IPC_TEST_TIMEOUT_MS = 60_000;
const SOCKET_CONNECTION_TIMEOUT_MS = 30_000;

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
            HTTP_PROXY: 'http://127.0.0.1:18080/',
            HTTPS_PROXY: 'http://127.0.0.1:18080/',
            http_proxy: 'http://127.0.0.1:18080/',
            https_proxy: 'http://127.0.0.1:18080/',
            NODE_USE_ENV_PROXY: '1',
            NODE_EXTRA_CA_CERTS: '/tmp/model_gateway-ca.pem',
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
          NODE_EXTRA_CA_CERTS: '/tmp/model_gateway-ca.pem',
          GANTRY_IPC_AUTH_TOKEN: 'runner-test-token',
          GANTRY_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
          GANTRY_EGRESS_PROXY_URL: 'http://127.0.0.1:18080/',
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      const sdkEnv = call?.sdkEnv || {};
      expect(sdkEnv.ANTHROPIC_BASE_URL).toBe('https://broker.local/anthropic');
      expect(sdkEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(sdkEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(sdkEnv.HTTP_PROXY).toBe('http://127.0.0.1:18080/');
      expect(sdkEnv.HTTPS_PROXY).toBe('http://127.0.0.1:18080/');
      expect(sdkEnv.http_proxy).toBe('http://127.0.0.1:18080/');
      expect(sdkEnv.https_proxy).toBe('http://127.0.0.1:18080/');
      expect(sdkEnv.NODE_USE_ENV_PROXY).toBe('1');
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
      expect(sdkEnv.GANTRY_IPC_AUTH_TOKEN).toBeUndefined();
      expect(sdkEnv.GANTRY_IPC_RESPONSE_VERIFY_KEY).toBeUndefined();
      expect(sdkEnv.GANTRY_MCP_CONFIG_FILE).toBeUndefined();
      expect(sdkEnv.GANTRY_MCP_SERVERS_JSON).toBeUndefined();
      expect(sdkEnv.GANTRY_MCP_ALLOWED_TOOLS_JSON).toBeUndefined();
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
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'rejects model proxy env that bypasses the Gantry egress gateway',
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
        'modelCredentialEnv.HTTP_PROXY must match GANTRY_EGRESS_PROXY_URL.',
      );
      expect(fs.existsSync(fixture.recordPath)).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'forces native Agent tool calls to run in background',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_AGENT_BACKGROUND_INPUT: '1',
        TEST_EXIT_AFTER_QUERY: '1',
      });

      expect(result.exitCode, result.stderr).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.permissionDecision).toMatchObject({
        behavior: 'allow',
        updatedInput: {
          prompt: 'delegate',
          run_in_background: true,
        },
      });
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'records prime-mode native Agent attempts as background work',
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
      expect(attemptEvents).toEqual([
        expect.objectContaining({
          eventType: 'permission.requested',
          payload: expect.objectContaining({
            requestedToolName: 'Agent',
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
    'emits SDK task notifications as structured runtime events',
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
          TEST_TASK_NOTIFICATION: '1',
          TEST_EXIT_AFTER_QUERY: '1',
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const outputs = readRunnerOutputs(result.stdout);
      expect(outputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runtimeEvents: [
              expect.objectContaining({
                eventType: 'task.notification',
                appId: 'app-one',
                agentId: 'agent:team',
                runId: 'run-1',
                jobId: 'job-1',
                conversationId: 'tg:team',
                threadId: 'thread-1',
                payload: {
                  taskId: 'task-1',
                  status: 'completed',
                  summary: 'subagent done',
                },
              }),
            ],
          }),
        ]),
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
    'passes broker placeholder auth values into the Agent SDK env',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_EXIT_AFTER_QUERY: '1',
        ANTHROPIC_API_KEY: 'placeholder',
        CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
        GANTRY_IPC_AUTH_TOKEN: 'runner-test-token',
        GANTRY_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
      });

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
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
      expect(
        readRecord(assistantFixture.recordPath).calls[0]?.settings
          ?.includeGitInstructions,
      ).toBe(false);
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
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

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.tools).toContain('Skill');
      expect(call?.allowedTools).toContain('Skill');
      expect(call?.settings?.skillOverrides).toEqual(
        SDK_NATIVE_SKILL_OVERRIDES,
      );
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
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'keeps the Skill tool available when enabled SDK skills meet a restricted native surface',
    async () => {
      const fixture = createRunnerFixture();
      const domainSkillIds = [
        'boondi-gifting',
        'boondi-product-care',
        'boondi-orders',
        'boondi-store-aggregator',
        'boondi-misc-policy',
      ];

      const result = await runRunner(
        fixture,
        baseInput({
          persona: 'generalist',
          nativeToolSurface: ['ToolSearch'],
        }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
          [GANTRY_CLAUDE_SDK_SKILLS_ENV]: JSON.stringify(domainSkillIds),
        },
      );

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.skills).toEqual([...domainSkillIds].sort());
      expect(call?.skills).not.toContain('boondi-kb');
      expect(call?.tools).toEqual(['ToolSearch', 'Skill']);
      expect(call?.allowedTools).toContain('ToolSearch');
      expect(call?.allowedTools).not.toContain('Skill');
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'passes an explicit Claude SDK debug file only when requested',
    async () => {
      const fixture = createRunnerFixture();
      const debugFile = path.join(fixture.root, 'claude-sdk-debug.log');

      const result = await runRunner(
        fixture,
        baseInput({ persona: 'generalist' }),
        {
          TEST_EXIT_AFTER_QUERY: '1',
          GANTRY_CLAUDE_SDK_DEBUG_FILE: debugFile,
        },
      );

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const call = readRecord(fixture.recordPath).calls[0];
      expect(call?.debugFile).toBe(debugFile);
      expect(call?.debug).toBeUndefined();
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
      expect(call?.allowedTools).toEqual([]);
      expect(call?.skills).toEqual([]);
      expect(call?.settings?.skillOverrides).toEqual(
        SDK_NATIVE_SKILL_OVERRIDES,
      );
      expect(call?.sdkEnv?.CLAUDE_CODE_DISABLE_POLICY_SKILLS).toBe('1');
      expect(call?.sdkEnv?.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL).toBe('1');
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
      expect(attemptEvents).toHaveLength(2);
      expect(attemptEvents.map((event) => event.eventType)).toEqual([
        'permission.requested',
        'permission.requested',
      ]);
      expect(attemptEvents.map((event) => event.payload?.toolName)).toEqual([
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
    'persists SDK sessions for live channel turns without resuming saved handles',
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
      expect(call?.resume).toBeUndefined();
      expect(call?.resumeSessionAt).toBeUndefined();
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
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('"eventType":"job.heartbeat"');
      expect(result.stdout).toContain('"jobId":"job-1"');
      expect(result.stdout).toContain('"runId":"run-1"');
      expect(result.stdout).not.toContain('"pendingPermissionRequests"');
      expect(result.stdout).toContain('"totalToolCalls":0');
    },
    RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'suppresses streamed pre-tool text and emits only the post-tool answer',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(fixture, baseInput(), {
        TEST_STREAM_TEXT_THEN_TOOL_USE: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Let me check that.');
      expect(result.stdout).toContain('Here is the actual answer.');
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
        'Gantry Durable Memory Boundary',
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
    'adds neutral CA trust aliases to allowed Bash tool calls',
    async () => {
      const fixture = createRunnerFixture();

      const result = await runRunner(
        fixture,
        baseInput({
          isScheduledJob: true,
          jobId: 'job-1',
          allowedTools: ['RunCommand(acme records *)'],
          modelCredentialEnv: {
            NODE_EXTRA_CA_CERTS: '/tmp/model_gateway-ca.pem',
          },
        }),
        {
          TEST_TOOL_USE_ONLY: 'Bash',
          TEST_TOOL_USE_CMD: 'acme records get budget',
        },
      );

      const trustPrefix = [
        'GODEBUG=netdns=go',
        "SSL_CERT_FILE='/tmp/model_gateway-ca.pem'",
        "REQUESTS_CA_BUNDLE='/tmp/model_gateway-ca.pem'",
        "CURL_CA_BUNDLE='/tmp/model_gateway-ca.pem'",
        "GIT_SSL_CAINFO='/tmp/model_gateway-ca.pem'",
        "PIP_CERT='/tmp/model_gateway-ca.pem'",
        "AWS_CA_BUNDLE='/tmp/model_gateway-ca.pem'",
        "CARGO_HTTP_CAINFO='/tmp/model_gateway-ca.pem'",
        "DENO_CERT='/tmp/model_gateway-ca.pem'",
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
              auditLabel: 'Gog Sheets get',
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
            '/opt/homebrew/bin/acme records get 12s6uzwLDLV-DVcTH6XBa5vV3FZJUo04fLm0npfgACb4 "Bot Recommendation!A1:Z1" --json --account ravi@knacklabs.ai',
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
            '/opt/homebrew/bin/acme records get 12s6uzwLDLV-DVcTH6XBa5vV3FZJUo04fLm0npfgACb4 "Bot Recommendation!A1:Z1" --json --account ravi@knacklabs.ai',
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
    'scheduled jobs request missing tool approval before denying current run',
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
          interrupt: true,
          decisionClassification: 'user_reject',
        }),
      );
      expect(String(call?.permissionDecision?.message)).toContain(
        'Permission socket approval is disabled because permission waiting is disabled.',
      );
      expect(String(call?.permissionDecision?.message)).toContain(
        'request_permission { "permissionKind": "tool", "toolName": "WebSearch", "temporaryOnly": false, "reason": "This autonomous run needs WebSearch access." }',
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
});

const SOCKET_FOLDER = 'team';
const SOCKET_CHAT_JID = 'tg:team';
const SOCKET_THREAD_ID = 'thread-socket-1';
const SOCKET_RUN_HANDLE = 'runner-socket-run';

function buildSocketDeps(): IpcDeps {
  const routes: Record<string, ConversationRoute> = {
    [SOCKET_CHAT_JID]: {
      name: 'Socket Team',
      folder: SOCKET_FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
    },
  };
  return {
    sendMessage: async () => undefined,
    conversationRoutes: () => routes,
    registerGroup: () => undefined,
    syncGroups: async () => undefined,
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => undefined,
    onSchedulerChanged: () => undefined,
    requestPermissionApproval: async () => ({}) as never,
    requestUserAnswer: async () => ({}) as never,
    opsRepository: {} as never,
  } as unknown as IpcDeps;
}

function spawnRunner(
  fixture: ReturnType<typeof createRunnerFixture>,
  input: Record<string, unknown>,
  extraEnv: Record<string, string>,
): {
  child: ChildProcess;
  stdoutRef: { value: string };
  stderrRef: { value: string };
  exit: Promise<number | null>;
} {
  const child = spawn(
    process.execPath,
    [path.resolve('node_modules/tsx/dist/cli.mjs'), fixture.runnerPath],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        GANTRY_IPC_DIR: fixture.ipcDir,
        GANTRY_IPC_RESPONSE_KEY_ID: 'runner-test-response-key',
        GANTRY_IPC_RESPONSE_VERIFY_KEY: fixture.responseVerifyKey,
        GANTRY_WORKSPACE_GROUP_DIR: path.join(fixture.root, 'group'),
        GANTRY_WORKSPACE_EXTRA_DIR: path.join(fixture.root, 'extra'),
        TEST_SDK_RECORD_PATH: fixture.recordPath,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const stdoutRef = { value: '' };
  const stderrRef = { value: '' };
  child.stdout?.on('data', (chunk) => {
    stdoutRef.value += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderrRef.value += String(chunk);
  });
  child.stdin?.end(JSON.stringify(input));
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
  return { child, stdoutRef, stderrRef, exit };
}

async function waitForMarker(
  markerDir: string,
  name: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  const target = path.join(markerDir, name);
  while (Date.now() < deadline) {
    if (fs.existsSync(target)) {
      try {
        return JSON.parse(fs.readFileSync(target, 'utf-8'));
      } catch {
        // marker mid-write; retry
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for marker ${name} in ${markerDir}`);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
  diagnostics?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const detail = diagnostics?.();
  throw new Error(
    `timed out waiting for ${label}${detail ? `\n${detail}` : ''}`,
  );
}

describe('agent-runner socket transport continuation', () => {
  let socketServer: IpcSocketServerHandle | undefined;

  afterEach(async () => {
    if (socketServer) {
      await socketServer.stop().catch(() => undefined);
      socketServer = undefined;
    }
  });

  it(
    'emits exact SDK startup cache prewarm payload for warm generic boots when tracing is enabled',
    async () => {
      const fixture = createRunnerFixture();
      const socketPath = path.join(fixture.root, 'core.sock');

      const handle = await startIpcSocketServer(buildSocketDeps(), {
        socketPath,
      });
      if (!handle) throw new Error('socket server failed to start');
      socketServer = handle;

      const auth = createIpcAuthEnvelope(SOCKET_FOLDER, SOCKET_THREAD_ID);
      const { child, stdoutRef, stderrRef, exit } = spawnRunner(
        fixture,
        baseInput({
          prompt: '',
          chatJid: '',
          threadId: undefined,
          warmGenericBoot: true,
        }),
        {
          GANTRY_IPC_AUTH_TOKEN: auth.authToken,
          GANTRY_IPC_RESPONSE_KEY_ID: auth.responseKeyId,
          GANTRY_IPC_SOCKET_PATH: socketPath,
          GANTRY_GROUP_FOLDER: SOCKET_FOLDER,
          GANTRY_THREAD_ID: SOCKET_THREAD_ID,
          GANTRY_AGENT_RUN_HANDLE: SOCKET_RUN_HANDLE,
          GANTRY_WARM_POOL_BOOT: 'generic',
          GANTRY_WARM_POOL_CACHE_SHAPE_KEY: 'shape-1',
          GANTRY_TRACE_PAYLOADS: '1',
        },
      );

      const runnerDiagnostics = () =>
        [
          `childExitCode=${child.exitCode ?? 'running'}`,
          `stdout=${stdoutRef.value || '<empty>'}`,
          `stderr=${stderrRef.value || '<empty>'}`,
        ].join('\n');

      try {
        await waitFor(
          () => {
            if (!stderrRef.value.includes('awaiting bind')) {
              return false;
            }
            return Boolean(
              handle
                .connectionsForFolder(SOCKET_FOLDER)
                .find(
                  (c) =>
                    c.scope?.role === 'runner' &&
                    c.scope?.runHandle === SOCKET_RUN_HANDLE,
                ),
            );
          },
          SOCKET_CONNECTION_TIMEOUT_MS,
          'warm runner bind readiness',
          runnerDiagnostics,
        );
        const runnerConnection = handle
          .connectionsForFolder(SOCKET_FOLDER)
          .find(
            (c) =>
              c.scope?.role === 'runner' &&
              c.scope?.runHandle === SOCKET_RUN_HANDLE,
          );
        if (!runnerConnection) throw new Error('runner connection missing');
        runnerConnection.send({
          v: 1,
          type: 'push',
          channel: 'bind',
          id: 'bind-1',
          payload: {
            chatJid: SOCKET_CHAT_JID,
            threadId: SOCKET_THREAD_ID,
            firstMessage: 'bound customer question',
            runHandle: SOCKET_RUN_HANDLE,
          },
        });

        const exitCode = await exit;
        expect(exitCode, `${stderrRef.value}\n${stdoutRef.value}`).toBe(0);
        const outputs = readRunnerOutputs(stdoutRef.value);
        const terminal = outputs.find((output) => output.cachePrewarmTrace);
        expect(terminal).toMatchObject({
          status: 'success',
          warmBound: true,
          cachePrewarmTrace: {
            kind: 'cache_prewarm',
            detail: {
              provider: 'anthropic',
              status: 'succeeded',
              promptShapeKey: 'shape-1',
            },
            payload: {
              cache: {
                provider: 'anthropic',
                promptShapeKey: 'shape-1',
                cacheReadTokens: 0,
                input: {
                  systemPrompt: expect.any(Object),
                  includePartialMessages: true,
                },
                output: {
                  status: 'succeeded',
                  readyMarker: 'awaiting bind',
                },
              },
            },
          },
        });
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
    SOCKET_RUNNER_IPC_TEST_TIMEOUT_MS,
  );

  it(
    'delivers continuation and close over the runner socket',
    async () => {
      const fixture = createRunnerFixture();
      const markerDir = path.join(fixture.ipcDir, 'test-markers');
      const socketPath = path.join(fixture.root, 'core.sock');

      const handle = await startIpcSocketServer(buildSocketDeps(), {
        socketPath,
      });
      if (!handle) throw new Error('socket server failed to start');
      socketServer = handle;

      const auth = createIpcAuthEnvelope(SOCKET_FOLDER, SOCKET_THREAD_ID);

      const { child, stdoutRef, stderrRef, exit } = spawnRunner(
        fixture,
        baseInput({ threadId: SOCKET_THREAD_ID }),
        {
          GANTRY_IPC_AUTH_TOKEN: auth.authToken,
          GANTRY_IPC_RESPONSE_KEY_ID: auth.responseKeyId,
          GANTRY_IPC_SOCKET_PATH: socketPath,
          GANTRY_GROUP_FOLDER: SOCKET_FOLDER,
          GANTRY_THREAD_ID: SOCKET_THREAD_ID,
          GANTRY_AGENT_RUN_HANDLE: SOCKET_RUN_HANDLE,
          TEST_SOCKET_CONTINUATION: '1',
        },
      );

      const runnerDiagnostics = () =>
        [
          `childExitCode=${child.exitCode ?? 'running'}`,
          `childKilled=${child.killed}`,
          `stdout=${stdoutRef.value || '<empty>'}`,
          `stderr=${stderrRef.value || '<empty>'}`,
        ].join('\n');

      try {
        await waitFor(
          () => {
            if (child.exitCode !== null) {
              throw new Error(
                `runner exited before socket connection\n${runnerDiagnostics()}`,
              );
            }
            return handle
              .connectionsForFolder(SOCKET_FOLDER)
              .some(
                (c) =>
                  c.scope?.role === 'runner' &&
                  c.scope?.runHandle === SOCKET_RUN_HANDLE,
              );
          },
          SOCKET_CONNECTION_TIMEOUT_MS,
          'runner socket connection',
          runnerDiagnostics,
        );

        await waitForMarker(markerDir, 'ready.json', 12_000);
        const delivery = makeSocketContinuationDelivery(
          handle.connectionsForFolder.bind(handle),
        );
        const delivered = delivery.deliverContinuation(
          {
            groupFolder: SOCKET_FOLDER,
            chatJid: SOCKET_CHAT_JID,
            threadId: SOCKET_THREAD_ID,
            runHandle: SOCKET_RUN_HANDLE,
          },
          'socket follow-up please',
          1,
        );
        expect(delivered).toBe(true);

        const received = await waitForMarker(
          markerDir,
          'continuation-received.json',
          12_000,
        );
        expect(received.text).toBe('socket follow-up please');

        delivery.deliverClose({
          groupFolder: SOCKET_FOLDER,
          chatJid: SOCKET_CHAT_JID,
          threadId: SOCKET_THREAD_ID,
          runHandle: SOCKET_RUN_HANDLE,
        });

        const closed = await waitForMarker(markerDir, 'closed.json', 12_000);
        expect(closed.streamEnded).toBe(true);

        const exitCode = await exit;
        expect(exitCode, `${stderrRef.value}\n${stdoutRef.value}`).toBe(0);

        // The drained continuation was recorded as a stream (steering) message.
        const call = readRecord(fixture.recordPath).calls[0];
        expect(call?.streamMessages).toContain('socket follow-up please');
        expect(call?.streamEnded).toBe(true);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
    SOCKET_RUNNER_IPC_TEST_TIMEOUT_MS,
  );
});
