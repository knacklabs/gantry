import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { buildSync } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { BaseMessage } from '@langchain/core/messages';

import '@core/channels/register-builtins.js';
import { compileSpawnSystemPrompt } from '@core/runtime/agent-spawn-prompt.js';
import { prepareWorkerAuthorityProjection } from '@core/runtime/agent-spawn-preparation.js';
import { composeAgentCapabilities } from '@core/adapters/llm/anthropic-claude-agent/agent-capabilities.js';
import { connectGantryAndThirdPartyMcpTools } from '@core/adapters/llm/deepagents-langchain/runner/mcp-tools.js';
import {
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
} from '@core/shared/agent-engine.js';
import { DEFAULT_GANTRY_HARNESS_TOOL_PROJECTION } from '@core/shared/gantry-tool-facades.js';

const sdkCalls = vi.hoisted(() => [] as Options[]);
const deepProbe = vi.hoisted(() => ({
  prompt: '',
  tools: [] as string[],
  model: undefined as unknown,
}));
vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/model-factory.js',
  () => ({
    buildRunnerModel: async () => ({
      model: deepProbe.model,
      endpointFamily: 'openai',
      modelId: 'test-model',
    }),
  }),
);
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ options }: { options: Options }) => {
    sdkCalls.push(options);
    return (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'tool-inventory-proof',
        mcp_servers: [{ name: 'gantry', status: 'connected' }],
      };
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

class CapturingModel extends FakeListChatModel {
  bindTools(...args: Parameters<FakeListChatModel['bindTools']>) {
    deepProbe.tools = args[0].map(({ name }) => name);
    return super.bindTools(...args);
  }
}

function captureMessages(messages: BaseMessage[]) {
  deepProbe.prompt = messages
    .filter((message) => message.getType() === 'system')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block) => block.type === 'text')
            .map((block) => ('text' in block ? block.text : ''))
            .join('\n'),
    )
    .join('\n');
}

function publicNativeTools(tools: readonly string[]): Set<string> {
  const projection = DEFAULT_GANTRY_HARNESS_TOOL_PROJECTION;
  const names = new Set<string>();
  for (const nativeName of tools) {
    const facade = Object.entries(projection.exactTools).find(
      ([, nativeNames]) => nativeNames.includes(nativeName),
    );
    names.add(
      facade?.[0] ??
        (nativeName === projection.runCommandToolName
          ? 'RunCommand'
          : nativeName),
    );
  }
  return names;
}

async function registeredTools(
  serverPath: string,
  env: Record<string, string>,
): Promise<Set<string>> {
  const client = new Client({ name: 'gantry-tools-proof', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env,
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return new Set(result.tools.map((tool) => tool.name));
  } finally {
    await client.close();
    await transport.close();
  }
}

function advertisedTools(prompt: string): Set<string> {
  const section = prompt.split('## Gantry tools in this run')[1];
  expect(section).toBeDefined();
  const names = section?.match(/^Available: (.+)\.$/m)?.[1];
  expect(names).toBeDefined();
  return new Set(names?.split(', '));
}

describe('the-agent-can-t-tell-which-gantry-tools', () => {
  let root: string;
  let serverPath: string;
  beforeAll(() => {
    root = mkdtempSync(join(process.cwd(), '.gantry-tools-test-'));
    serverPath = join(root, 'stdio.mjs');
    buildSync({
      entryPoints: ['apps/core/src/runner/mcp/stdio.ts'],
      outfile: serverPath,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node24',
    });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => {
    sdkCalls.length = 0;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'delegation is granted',
      tools: ['AgentDelegation', 'RunCommand'],
      accessPreset: 'full' as const,
      hidden: false,
      asyncEnabled: true,
      autonomous: false,
      reason: undefined,
      delegation: true,
    },
    {
      name: 'delegation has no grant',
      tools: [],
      accessPreset: 'full' as const,
      hidden: false,
      asyncEnabled: true,
      autonomous: false,
      reason: 'AgentDelegation has not been granted',
      delegation: false,
    },
    {
      name: 'the access preset is locked',
      tools: ['AgentDelegation', 'mcp__gantry__service_restart'],
      accessPreset: 'locked' as const,
      hidden: false,
      asyncEnabled: true,
      autonomous: false,
      reason: 'locked access preset',
      delegation: false,
    },
    {
      name: 'authority tools are hidden while selected admin tools remain',
      tools: ['AgentDelegation', 'mcp__gantry__service_restart'],
      accessPreset: 'full' as const,
      hidden: true,
      asyncEnabled: true,
      autonomous: false,
      reason: 'tools are hidden for this run',
      delegation: false,
    },
    {
      name: 'the async executor is unavailable',
      tools: ['AgentDelegation'],
      accessPreset: 'full' as const,
      hidden: false,
      asyncEnabled: false,
      autonomous: false,
      reason: 'async task executor is unavailable',
      delegation: false,
    },
    {
      name: 'an autonomous run has no browser IPC credential',
      tools: ['Browser', 'mcp__gantry__scheduler_run_now'],
      accessPreset: 'full' as const,
      hidden: false,
      asyncEnabled: true,
      autonomous: true,
      reason: 'AgentDelegation has not been granted',
      delegation: false,
    },
  ])(
    'advertises the mounted surface when $name',
    async (scenario) => {
      vi.stubEnv('GANTRY_NO_PERMISSION_TOOLS', '0');
      vi.stubEnv('GANTRY_IPC_DIR', root);
      vi.stubEnv('GANTRY_WORKSPACE_GROUP_DIR', root);
      vi.stubEnv('GANTRY_WORKSPACE_EXTRA_DIR', root);
      const inputDir = join(root, 'input');
      mkdirSync(inputDir, { recursive: true });
      vi.stubEnv('GANTRY_IPC_INPUT_DIR', inputDir);
      vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude-config'));
      vi.stubEnv('GANTRY_MCP_SERVERS_JSON', '{}');
      vi.stubEnv('GANTRY_MCP_ALLOWED_TOOLS_JSON', '[]');
      const agentInput = {
        prompt: 'Which Gantry tools can I use in this run?',
        workspaceFolder: 'team',
        chatJid: 'tg:1001',
        toolPolicyRules: scenario.tools,
        hideAuthorityTools: scenario.hidden,
        isScheduledJob: scenario.autonomous,
      };
      const authority = await prepareWorkerAuthorityProjection({
        agentInput,
        accessPreset: scenario.accessPreset,
        delegates: [],
        getConversationBoundAgentIds: () => new Set(),
        personasByAgentId: {},
        workspaceFolder: agentInput.workspaceFolder,
        options: { asyncTaskRepositoryAvailable: scenario.asyncEnabled },
        getAgentRepository: () => {
          throw new Error('No delegate lookup is needed for this run');
        },
        warn: () => {},
      });
      const claude = composeAgentCapabilities({
        mcpServerPath: serverPath,
        ...agentInput,
        configuredAllowedTools: scenario.tools,
        accessPreset: authority.accessPreset,
        hideAuthorityTools: authority.hideAuthorityTools,
        asyncTaskToolsEnabled: scenario.asyncEnabled,
      });
      const claudeEnv = claude.mcpServers.gantry.env ?? {};
      const deepEnv = {
        GANTRY_IPC_DIR: root,
        GANTRY_MCP_SERVER_PATH: serverPath,
        GANTRY_MCP_CONFIG_FILE: '',
        GANTRY_BROWSER_IPC_AUTH_TOKEN: '',
        GANTRY_DEEPAGENTS_FILESYSTEM_ENABLED: '1',
        GANTRY_DEEPAGENTS_SHELL_ENABLED: scenario.tools.includes('RunCommand')
          ? '1'
          : '',
        GANTRY_CHAT_JID: agentInput.chatJid,
        GANTRY_AGENT_ACCESS_PRESET: authority.accessPreset,
        GANTRY_NO_PERMISSION_TOOLS: authority.hideAuthorityTools ? '1' : '',
        GANTRY_ASYNC_TASK_TOOLS_ENABLED: scenario.asyncEnabled ? '1' : '',
        GANTRY_PERMISSION_LANE: scenario.autonomous
          ? 'autonomous'
          : 'interactive',
      };
      for (const [name, value] of Object.entries(deepEnv))
        vi.stubEnv(name, value);
      const mounted = await registeredTools(serverPath, {
        GANTRY_IPC_DIR: root,
        ...claudeEnv,
        GANTRY_AGENT_ACCESS_PRESET: authority.accessPreset,
      });
      expect(claude.mcpServers.gantry.alwaysLoad).toBe(true);
      expect(mounted.has('delegate_task')).toBe(scenario.delegation);
      expect(mounted.has('task_message')).toBe(scenario.delegation);
      if (scenario.delegation) {
        for (const name of ['task_get', 'task_list', 'task_cancel']) {
          expect(mounted.has(name)).toBe(true);
        }
      }
      expect(mounted.has('send_message')).toBe(true);
      if (scenario.accessPreset === 'locked') {
        expect(mounted.has('request_access')).toBe(false);
        expect(mounted.has('service_restart')).toBe(false);
      } else if (scenario.hidden) {
        expect(mounted.has('request_access')).toBe(true);
        expect(mounted.has('service_restart')).toBe(true);
      }
      if (scenario.autonomous) {
        expect(mounted.has('scheduler_run_now')).toBe(false);
        expect(mounted.has('browser_open')).toBe(false);
      }
      const deep = await connectGantryAndThirdPartyMcpTools({
        configuredAllowedTools: scenario.tools,
        hideAuthorityTools: authority.hideAuthorityTools,
        shellCwd: root,
        gate: {
          workspaceFolder: 'team',
          memoryBlock: '',
          gateContext: { conversationId: agentInput.chatJid },
          permissionEnv: {
            appId: 'default',
            agentId: '',
            chatJid: agentInput.chatJid,
            jobId: '',
            jobName: '',
            jobRunId: '',
            jobRunLeaseToken: '',
            jobRunLeaseFencingVersion: '',
            ipcAuthToken: '',
            ipcResponseVerifyKey: '',
            ipcResponseKeyId: '',
            permissionRequestTimeoutMs: 1000,
            resolveWorkspaceIpcDir: () => root,
          },
          capabilityRequestToolsHidden: authority.hideAuthorityTools,
        },
      });
      try {
        const deepMounted = new Set(deep.tools.map((tool) => tool.name));
        expect(deepMounted).toEqual(deep.gantryOwnedToolNames);
        expect(deepMounted.has('WebSearch')).toBe(true);
        expect(deepMounted.has('WebRead')).toBe(true);
        expect(deepMounted.has('FileRead')).toBe(true);
        expect(deepMounted.has('RunCommand')).toBe(
          scenario.tools.includes('RunCommand'),
        );
        expect(deepMounted.has('delegate_task')).toBe(scenario.delegation);
        for (const agentEngine of [DEFAULT_AGENT_ENGINE, DEEPAGENTS_ENGINE]) {
          const compiled = await compileSpawnSystemPrompt({
            group: {
              name: 'Team',
              folder: 'team',
              trigger: '',
              added_at: '2026-01-01T00:00:00.000Z',
              conversationKind: 'dm',
            },
            agentInput,
            appId: 'default',
            accessPreset: authority.accessPreset,
            mcpInventoryToolsMounted: !authority.hideAuthorityTools,
            agentEngine,
            gantryToolSelection: {
              ...authority.gantryToolSelection,
              browserIpcEnabled: false,
            },
            fileArtifactStore: () => undefined,
            measureAsync: (_name, fn) => fn(),
          });
          let prompt: string;
          let completeMounted: Set<string>;
          if (agentEngine === DEEPAGENTS_ENGINE) {
            deepProbe.model = new CapturingModel({ responses: ['done'] });
            const stream = FakeListChatModel.prototype._streamResponseChunks;
            vi.spyOn(
              FakeListChatModel.prototype,
              '_streamResponseChunks',
            ).mockImplementation(async function* (
              this: FakeListChatModel,
              ...args
            ) {
              captureMessages(args[0]);
              yield* stream.call(this, ...args);
            });
            const { runDeepAgentTurn } =
              await import('@core/adapters/llm/deepagents-langchain/runner/deep-agent-runner.js');
            await runDeepAgentTurn({
              agentInput: {
                ...agentInput,
                allowedTools: scenario.tools,
                hideAuthorityTools: authority.hideAuthorityTools,
                permissionMode: 'ask',
                compiledSystemPrompt: compiled,
                modelCredentialEnv: {
                  OPENAI_BASE_URL: 'http://127.0.0.1:10254/openai',
                  OPENAI_API_KEY: 'gtw_worker_tool_proof',
                },
              },
              provider: 'openai',
              modelId: 'test-model',
              newSessionId: 'worker-tool-proof',
              includeMemoryContext: false,
              emit: () => {},
            });
            prompt = deepProbe.prompt;
            completeMounted = new Set(deepProbe.tools);
            expect(completeMounted).toEqual(deepMounted);
          } else {
            const { runQuery } =
              await import('@core/adapters/llm/anthropic-claude-agent/runner/query-loop.js');
            await runQuery(
              agentInput.prompt,
              serverPath,
              {
                ...agentInput,
                hideAuthorityTools: authority.hideAuthorityTools,
                allowedTools: scenario.tools,
                permissionMode: 'ask',
                compiledSystemPrompt: compiled,
              },
              { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
              'sonnet',
              undefined,
              undefined,
              { enableIpcFollowups: false, persistSdkSession: false },
            );
            const options = sdkCalls.at(-1);
            expect(options).toBeDefined();
            expect(Array.isArray(options?.tools)).toBe(true);
            const nativeTools = Array.isArray(options?.tools)
              ? options.tools
              : [];
            const gantryServer = options?.mcpServers?.gantry;
            expect(gantryServer && 'env' in gantryServer).toBeTruthy();
            expect(gantryServer?.alwaysLoad).toBe(true);
            const actualMcpMounted = await registeredTools(
              serverPath,
              gantryServer && 'env' in gantryServer
                ? (gantryServer.env ?? {})
                : {},
            );
            completeMounted = new Set([
              ...actualMcpMounted,
              ...publicNativeTools(nativeTools),
            ]);
            expect(completeMounted.has('WebSearch')).toBe(true);
            expect(completeMounted.has('WebRead')).toBe(true);
            expect(completeMounted.has('FileRead')).toBe(true);
            expect(completeMounted.has('RunCommand')).toBe(
              !scenario.autonomous,
            );
            expect(completeMounted.has('delegate_task')).toBe(
              scenario.delegation,
            );
            prompt = Array.isArray(options?.systemPrompt)
              ? options.systemPrompt.join('\n')
              : typeof options?.systemPrompt === 'string'
                ? options.systemPrompt
                : '';
          }
          expect(advertisedTools(prompt)).toEqual(completeMounted);
          if (scenario.reason) {
            const delegationLine = prompt
              .split('\n')
              .find(
                (line) =>
                  line.startsWith('Unavailable: ') &&
                  line.includes('delegate_task'),
              );
            expect(delegationLine).toContain(scenario.reason);
          }
        }
      } finally {
        await deep.close();
      }
    },
    30_000,
  );
});
