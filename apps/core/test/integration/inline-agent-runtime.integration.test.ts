import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/index.js';
import {
  ensureConfiguredAgent,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { makeAppGroup } from '@core/application/sessions/session-interaction-module.js';

const INLINE_DATA_DIR = vi.hoisted(
  () => `/tmp/gantry-inline-runtime-integration-${process.pid}`,
);
const credentials = vi.hoisted(() => ({
  revoke: vi.fn(async () => undefined),
  gatewayUrl: '',
}));
const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  createServer: vi.fn((options) => ({ type: 'sdk', instance: options })),
  createTool: vi.fn((name, description, inputSchema, handler) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
}));
const deep = vi.hoisted(() => ({
  createAgent: vi.fn(),
  createAgentMemoryMiddleware: vi.fn(),
  createSkillsMiddleware: vi.fn(),
}));
const model = vi.hoisted(() => ({ build: vi.fn() }));
const delegatedSpawn = vi.hoisted(() => ({ run: vi.fn() }));
const structuredAttemptPrompts = {
  claude: [] as string[],
  deepAgents: [] as string[],
};

vi.mock('@core/runtime/agent-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/runtime/agent-spawn.js')>()),
  spawnAgent: delegatedSpawn.run,
}));

vi.mock('@core/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/config/index.js')>()),
  DATA_DIR: INLINE_DATA_DIR,
}));

vi.mock(`@anthropic-ai/${'claude-agent-sdk'}`, () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: 'dynamic-boundary',
  query: sdk.query,
  createSdkMcpServer: sdk.createServer,
  tool: sdk.createTool,
}));

vi.mock('deepagents', () => ({
  createDeepAgent: deep.createAgent,
  createAgentMemoryMiddleware: deep.createAgentMemoryMiddleware,
  createSkillsMiddleware: deep.createSkillsMiddleware,
  StateBackend: class StateBackend {},
}));

vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/model-factory.js',
  () => ({ buildRunnerModel: model.build }),
);

vi.mock(
  '@core/application/mcp/mcp-tool-proxy-network.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@core/application/mcp/mcp-tool-proxy-network.js')
    >()),
    createGuardedMcpFetch: () => fetch,
  }),
);

vi.mock('@core/runtime/agent-spawn-host.js', () => ({
  prepareInlineAgentHostContext: vi.fn(async (_group, input) => {
    const openai =
      input.model === 'openai-fallback' || input.prompt.includes('OPENAI_TURN');
    return {
      dataDir: INLINE_DATA_DIR,
      defaultTimeoutMs: 30_000,
      idleTimeoutMs: 30_000,
      sandboxProvider: 'direct',
      permissionMode: 'ask',
      compiledSystemPrompt: 'integration system prompt',
      modelWorkload: 'chat',
      resolvedModel: {
        ok: true,
        value: {
          agentEngine: openai ? 'deepagents' : ['anthropic', 'sdk'].join('_'),
          executionProviderId: 'integration:inline',
          runnerModel: openai
            ? 'openai-inline'
            : (input.model ?? 'claude-primary'),
          modelEntry: {
            displayName: openai ? 'OpenAI inline' : 'Claude inline',
            modelRoute: { id: openai ? 'openai' : 'anthropic' },
          },
        },
      },
    };
  }),
  getHostRuntimeCredentialEnv: vi.fn(async () => ({
    env: {
      [['ANTHROPIC', 'BASE_URL'].join('_')]:
        `${credentials.gatewayUrl}/anthropic`,
      [['ANTHROPIC', 'API_KEY'].join('_')]: 'gtw_integration',
      OPENAI_BASE_URL: `${credentials.gatewayUrl}/openai`,
      OPENAI_API_KEY: 'gtw_integration',
    },
    credentialProviders: {},
    brokerApplied: true,
    brokerProfile: 'gantry',
    revoke: credentials.revoke,
  })),
  withControls: (input: unknown) => input,
  createConfiguredRunTokenBudget: () => ({
    exceeded: false,
    enforce: (output: unknown) => output,
  }),
}));

vi.mock('@core/runtime/agent-spawn-admission.js', () => ({
  validateAgentPreSpawnAdmission: vi.fn(() => null),
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  redactString: (value: string) => value,
}));

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { createCoreTaskLifecycleBackend } from '@core/application/core-tools/task-lifecycle.js';
import { createCoreToolRegistry } from '@core/runtime/core-tools/registry.js';
import { createCoreToolSchemas } from '@core/runtime/core-tools/schemas.js';
import {
  evaluateNeutralToolPolicy,
  evaluateNeutralToolPreChecks,
} from '@core/runner/tool-gate-core.js';
import {
  formatMemoryToolResponse,
  formatMemoryWriteResponse,
} from '@core/runner/mcp/formatting.js';
import {
  runInlineAgent,
  type InlineAgentLoopLane,
} from '@core/runtime/agent-inline.js';
import type {
  AgentInput,
  AgentOutput,
} from '@core/runtime/agent-spawn-types.js';
import { readScheduledJobHeartbeat } from '@core/runtime/agent-spawn-scheduled-idle.js';
import { GroupQueue } from '@core/runtime/group-queue.js';
import { runJobAgentWithFailover } from '@core/jobs/execution-failover.js';
import { createInlineAgentTaskLifecycle } from '@core/app/bootstrap/inline-agent-task-lifecycle.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import { createPostgresIntegrationRuntime } from '../harness/postgres-integration-runtime.js';
import { hasPostgresIntegrationDatabase } from '../harness/postgres-integration-runtime.js';
import { startTestControlServer } from '../harness/control-http-server.js';
import { createFakeChannelRuntime } from '../harness/fake-channel.js';

const group: ConversationRoute = {
  name: 'Inline integration agent',
  folder: 'inline_integration_agent',
  trigger: '',
  added_at: new Date(0).toISOString(),
};

const baseInput: AgentInput = {
  prompt: 'integration prompt',
  workspaceFolder: group.folder,
  chatJid: 'app:integration:inline',
  appId: 'default',
  agentId: 'agent:inline-integration',
  runtime: 'inline',
};

function inlineOptions(lane: InlineAgentLoopLane) {
  return {
    inlineAgentLoopLane: lane,
    runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
  };
}

function waitUntilAborted(signal: AbortSignal): Promise<AgentOutput> {
  return new Promise((resolve) => {
    const finish = () => resolve({ status: 'success', result: null });
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
}

function registerInlineSessionAgent(conversationId: string): void {
  const appId = 'app-inline-itest';
  const runtimeHome = process.env.GANTRY_HOME;
  if (!runtimeHome) throw new Error('GANTRY_HOME is required for this test');
  const folder = makeAppGroup({
    appId,
    conversationId,
    conversationJid: `app:${appId}:${conversationId}`,
    identityHash: createHash('sha256')
      .update(`${appId}\0${conversationId}`)
      .digest('hex')
      .slice(0, 12),
    addedAt: new Date(0).toISOString(),
  }).folder;
  const settings = loadRuntimeSettings(runtimeHome);
  ensureConfiguredAgent(settings, {
    agentId: folder,
    agentName: conversationId,
    agentFolder: folder,
  });
  settings.agents[folder].runtime = 'inline';
  saveRuntimeSettings(runtimeHome, settings);
}

function scriptedCoreTools(events: string[]) {
  const taskBackend = createCoreTaskLifecycleBackend({
    service: {
      startDelegatedAgent: vi.fn(async () => ({
        ok: true,
        message: 'delegated',
        task: { id: 'task-parity', summary: 'delegated' },
      })),
    } as never,
    owner: {
      appId: 'default',
      agentId: 'agent:inline-integration',
      conversationId: baseInput.chatJid,
    },
    workspaceFolder: group.folder,
  });
  return createCoreToolRegistry({
    context: {
      sourceAgentFolder: group.folder,
      conversationId: baseInput.chatJid,
      appId: 'default',
      agentId: 'agent:inline-integration',
      runId: 'run:event-parity',
      accessPreset: 'full',
    },
    sendMessage: vi.fn(async () => undefined),
    requestUserAnswer: vi.fn(async (request) => ({
      requestId: request.requestId,
      answers: {},
    })),
    requestPermissionApproval: vi.fn(async () => ({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'integration-approver',
    })),
    publishRuntimeEvent: vi.fn(async (event) => {
      events.push(event.eventType);
    }),
    taskLifecycleBackend: taskBackend,
    durability: {
      record: vi.fn(async () => true),
      resolve: vi.fn(async () => true),
    },
    requestId: (prefix) => `${prefix}-event-parity`,
    evaluateToolPreChecks: evaluateNeutralToolPreChecks,
    evaluateToolPolicy: evaluateNeutralToolPolicy,
    formatMemorySearchResponse: formatMemoryToolResponse,
    formatMemoryWriteResponse,
    schemas: createCoreToolSchemas(z),
  });
}

async function listen(server: http.Server): Promise<string> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Test server did not bind a TCP port.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function close(server: http.Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
    : undefined;
}

async function startMcpStub(calls: Array<Record<string, unknown>>) {
  const server = http.createServer((request, response) => {
    void (async () => {
      const mcp = new McpServer({ name: 'inline-itest', version: '1.0.0' });
      mcp.registerTool(
        'echo',
        {
          description: 'Echo an integration payload.',
          inputSchema: { value: z.string() },
        },
        async ({ value }) => {
          calls.push({ value });
          return { content: [{ type: 'text', text: `remote:${value}` }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, await readBody(request));
      response.once('close', () => {
        void transport.close();
        void mcp.close();
      });
    })().catch((error) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  return { server, url: `${await listen(server)}/mcp` };
}

async function startGatewayStub(calls: string[]) {
  const server = http.createServer((request, response) => {
    calls.push(request.url ?? '/');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  return { server, url: await listen(server) };
}

async function callRemoteTool(
  config: { url: string; headers?: Record<string, string> },
  value: string,
): Promise<void> {
  const client = new McpClient({
    name: 'inline-itest-client',
    version: '1.0.0',
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    );
    await client.callTool({ name: 'echo', arguments: { value } });
  } finally {
    await client.close();
  }
}

function configureProviderMocks(): void {
  structuredAttemptPrompts.claude.length = 0;
  structuredAttemptPrompts.deepAgents.length = 0;
  deep.createAgent.mockReset();
  deep.createAgentMemoryMiddleware.mockReset();
  deep.createAgentMemoryMiddleware.mockReturnValue({
    name: 'AgentMemoryMiddleware',
    stateSchema: {},
  });
  deep.createSkillsMiddleware.mockReset();
  sdk.query.mockImplementation(({ options, prompt }) => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'claude-inline-session',
      };
      if (options.outputFormat) {
        const initialPrompt = await (prompt as AsyncIterable<unknown>)
          [Symbol.asyncIterator]()
          .next();
        const structuredAttempt = structuredAttemptPrompts.claude.push(
          JSON.stringify(initialPrompt.value),
        );
        yield {
          type: 'result',
          subtype: 'success',
          uuid: 'claude-structured-usage',
          result: '',
          structured_output:
            structuredAttempt === 1 ? { wrong: 'first' } : { lane: 'first' },
          usage: { input_tokens: 4, output_tokens: 2 },
        };
        return;
      }
      const tools = options.mcpServers.gantry.instance.tools;
      await tools
        .find((tool) => tool.name === 'send_message')
        .handler({
          text: 'Claude core message',
        });
      await tools
        .find((tool) => tool.name === 'ask_user_question')
        .handler({
          questions: [
            {
              question: 'Continue?',
              header: 'Continue',
              options: [
                { label: 'Yes', description: 'Continue the turn.' },
                { label: 'No', description: 'Stop the turn.' },
              ],
            },
          ],
        });
      const remote = options.mcpServers.crm;
      await options.canUseTool(
        'mcp__crm__echo',
        { value: 'claude' },
        { signal: new AbortController().signal, toolUseID: 'claude-mcp' },
      );
      await callRemoteTool(remote, 'claude');
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Claude inline complete' },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        uuid: 'claude-usage',
        result: 'Claude inline complete',
        usage: { input_tokens: 4, output_tokens: 2 },
      };
    },
  }));

  deep.createAgent.mockImplementation(({ tools, responseFormat }) => ({
    async *streamEvents(input) {
      if (responseFormat) {
        const structuredAttempt = structuredAttemptPrompts.deepAgents.push(
          JSON.stringify(input),
        );
        yield {
          event: 'on_chain_end',
          data: {
            output: {
              structuredResponse:
                structuredAttempt === 1
                  ? { wrong: 'second' }
                  : { lane: 'second' },
            },
          },
        };
        return;
      }
      await tools
        .find((tool) => tool.name === 'send_message')
        .invoke({ text: 'OpenAI core message' });
      await tools
        .find((tool) => tool.name === 'ask_user_question')
        .invoke({
          questions: [
            {
              question: 'Continue?',
              header: 'Continue',
              options: [
                { label: 'Yes', description: 'Continue the turn.' },
                { label: 'No', description: 'Stop the turn.' },
              ],
            },
          ],
        });
      await tools
        .find((tool) => tool.name === 'mcp__crm__echo')
        .invoke({ value: 'openai' });
      yield {
        event: 'on_chat_model_stream',
        data: {
          chunk: {
            content: 'OpenAI inline complete',
            usage_metadata: { input_tokens: 3, output_tokens: 1 },
          },
        },
      };
    },
  }));

  model.build.mockImplementation(async (input) => {
    await fetch(`${input.gatewayBaseUrl}/mock`, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.gatewayToken}` },
    });
    return {
      model: { profile: { maxInputTokens: 100 } },
      endpointFamily: 'openai',
      modelId: input.modelId,
    };
  });
}

beforeEach(() => {
  configureProviderMocks();
  credentials.revoke.mockClear();
  delegatedSpawn.run.mockReset();
  delegatedSpawn.run.mockImplementation(
    async (runGroup, input, onProcess, onOutput, options) => {
      if (runGroup.agentConfig?.runtime === 'inline') {
        return runInlineAgent(
          runGroup,
          { ...input, runtime: 'inline' },
          onProcess,
          onOutput,
          options,
        );
      }
      const handle = {
        pid: 42_424,
        killed: false,
        kill() {
          this.killed = true;
          return true;
        },
      };
      onProcess(handle, 'stub-worker-run');
      const output = {
        status: 'success',
        result: 'stub worker completed',
      } as const;
      await onOutput?.(output);
      return output;
    },
  );
  fs.rmSync(INLINE_DATA_DIR, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(INLINE_DATA_DIR, { recursive: true, force: true });
});

describe('inline runtime integration seams', () => {
  it('snapshots the same session-init, permission, delta, and terminal order for worker and inline turns', async () => {
    const workerRunner = vi.fn(
      async (
        script: (emit: (output: AgentOutput) => Promise<void>) => Promise<void>,
        emit: (output: AgentOutput) => Promise<void>,
      ) => script(emit),
    );
    const runScript = async (runtime: 'inline' | 'worker') => {
      const events: string[] = [];
      const tools = scriptedCoreTools(events);
      const script = async (emit: (output: AgentOutput) => Promise<void>) => {
        await emit({
          status: 'success',
          result: null,
          newSessionId: `session-${runtime}`,
          sessionInit: true,
        });
        await tools.execute('delegate_task', { objective: 'Parity probe' });
        await emit({ status: 'success', result: 'delta' });
        await emit({
          status: 'success',
          result: null,
          usageEventId: `usage-${runtime}`,
        });
      };
      const capture = async (output: AgentOutput) => {
        events.push(
          output.sessionInit
            ? 'frame.session_init'
            : output.result
              ? 'frame.delta'
              : 'frame.terminal',
        );
      };

      if (runtime === 'inline') {
        await runInlineAgent(
          group,
          baseInput,
          vi.fn(),
          capture,
          inlineOptions(async ({ emitOutput }) => {
            await script(emitOutput);
            return { status: 'success', result: null };
          }),
        );
      } else {
        await workerRunner(script, capture);
      }
      return events;
    };

    const worker = await runScript('worker');
    const inline = await runScript('inline');
    expect(workerRunner).toHaveBeenCalledOnce();
    expect(inline).toEqual(worker);
    expect(inline).toEqual([
      'frame.session_init',
      RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
      RUNTIME_EVENT_TYPES.PERMISSION_ALLOWED,
      RUNTIME_EVENT_TYPES.PERMISSION_RESUMED,
      RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
      'frame.delta',
      'frame.terminal',
    ]);
  });

  it('keeps scheduled inline execution live with a synthetic heartbeat', async () => {
    const frames: AgentOutput[] = [];
    const output = await runInlineAgent(
      group,
      {
        ...baseInput,
        isScheduledJob: true,
        jobId: 'job:inline-heartbeat',
        runId: 'run:inline-heartbeat',
      },
      vi.fn(),
      async (frame) => {
        frames.push(frame);
      },
      inlineOptions(async () => ({
        status: 'success',
        result: 'scheduled inline result',
      })),
    );

    expect(output).toMatchObject({
      status: 'success',
      result: 'scheduled inline result',
    });
    expect(output.error).toBeUndefined();
    expect(
      frames.flatMap((frame) =>
        (frame.runtimeEvents ?? []).map((event) => event.eventType),
      ),
    ).toContain(RUNTIME_EVENT_TYPES.JOB_HEARTBEAT);
    expect(frames.some((frame) => readScheduledJobHeartbeat(frame))).toBe(true);
    expect(credentials.revoke).toHaveBeenCalledOnce();
  });

  it('loads an attached skill into the DeepAgents inline middleware from in-memory storage', async () => {
    const skillContent = `---
name: inline-response
description: Supplies the integration response marker.
---
Response marker: stage-c-skill-loaded`;
    const skillRepository = {
      listEnabledSkillsForAgent: vi.fn(async () => [
        {
          id: 'skill:inline-response',
          name: 'inline-response',
          status: 'installed',
          storage: {
            storageType: 'object-store',
            storageRef: 'memory:inline-response',
            contentHash: 'sha256-inline-response',
            sizeBytes: Buffer.byteLength(skillContent),
          },
        },
      ]),
    };
    const skillArtifactStore = {
      putSkillArtifact: vi.fn(),
      getSkillArtifact: vi.fn(async () => ({
        assets: [
          {
            path: 'SKILL.md',
            contentType: 'text/markdown',
            content: Buffer.from(skillContent),
          },
        ],
      })),
    };
    deep.createSkillsMiddleware.mockImplementationOnce((options) => ({
      stageCSkillMiddleware: options,
    }));
    deep.createAgent.mockImplementationOnce(({ middleware }) => ({
      async *streamEvents({ files }) {
        const loaded = middleware.find(
          (item) => item.stageCSkillMiddleware,
        ).stageCSkillMiddleware;
        const content = files[`${loaded.sources[0]}inline-response/SKILL.md`]
          .content as string;
        yield {
          event: 'on_chat_model_stream',
          data: {
            chunk: {
              content: content.match(/Response marker: (\S+)/)?.[1] ?? '',
              usage_metadata: { input_tokens: 1, output_tokens: 1 },
            },
          },
        };
      },
    }));
    model.build.mockResolvedValueOnce({
      model: { profile: { maxInputTokens: 100 } },
      endpointFamily: 'openai',
      modelId: 'openai-inline',
    });
    const { createDeepAgentsInlineAgentLoopLane } =
      await import('@core/adapters/llm/deepagents-langchain/inline-lane/index.js');
    const deepAgentsLane = createDeepAgentsInlineAgentLoopLane({
      databaseUrl: null,
      schema: 'integration',
    });
    const frames: AgentOutput[] = [];

    const output = await runInlineAgent(
      group,
      {
        ...baseInput,
        prompt: 'OPENAI_TURN use the attached skill',
        model: 'openai-fallback',
        attachedSkillSourceIds: ['skill:inline-response'],
        isScheduledJob: true,
        jobId: 'job:inline-skill',
      },
      vi.fn(),
      async (frame) => {
        frames.push(frame);
      },
      {
        ...inlineOptions((laneInput) =>
          deepAgentsLane({
            ...laneInput,
            coreTools: {
              tools: [],
              execute: vi.fn(),
              authorizeThirdPartyMcpTool: vi.fn(),
              recordThirdPartyMcpToolActivity: vi.fn(),
            },
            egressDenylist: [],
          }),
        ),
        skillRepository: skillRepository as never,
        skillArtifactStore: skillArtifactStore as never,
        skillContext: {
          appId: 'default',
          agentId: 'agent:inline-integration',
        },
      },
    );

    expect(output.error).toBeUndefined();
    expect(output).toMatchObject({
      status: 'success',
      result: null,
    });
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: 'stage-c-skill-loaded' }),
      ]),
    );
    expect(deep.createSkillsMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ['/skills/'] }),
    );
    expect(skillRepository.listEnabledSkillsForAgent).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent:inline-integration',
    });
    expect(skillArtifactStore.getSkillArtifact).toHaveBeenCalledWith(
      'memory:inline-response',
    );
    expect(skillArtifactStore.putSkillArtifact).not.toHaveBeenCalled();
  });

  it('uses the existing scheduled-run failover chain after an inline model error', async () => {
    const attemptedModels: Array<string | undefined> = [];
    const onFailover = vi.fn(async (providerId) => providerId);
    const spawn = async (
      runGroup: ConversationRoute,
      input: AgentInput,
      onProcess: Parameters<typeof runInlineAgent>[2],
      onOutput: Parameters<typeof runInlineAgent>[3],
      options: Parameters<typeof runInlineAgent>[4],
    ) => {
      attemptedModels.push(input.model);
      return runInlineAgent(
        runGroup,
        { ...input, runtime: 'inline' },
        onProcess,
        onOutput,
        {
          ...options,
          inlineAgentLoopLane: async () =>
            input.model === 'claude-primary'
              ? {
                  status: 'error',
                  result: null,
                  error: 'API Error: 503 primary unavailable',
                }
              : { status: 'success', result: 'fallback completed' },
        },
      );
    };

    const output = await runJobAgentWithFailover({
      group,
      candidates: ['claude-primary', 'openai-fallback'],
      firstModel: 'claude-primary',
      baseInput: {
        ...baseInput,
        isScheduledJob: true,
        jobId: 'job:inline-failover',
        runId: 'run:inline-failover',
      },
      spawn: spawn as never,
      onProcess: vi.fn(),
      streamHandler: vi.fn(async () => undefined),
      runOptions: inlineOptions(async () => ({
        status: 'success',
        result: null,
      })),
      fallbackProviderId: 'anthropic:claude-agent-sdk' as never,
      hasStreamedOutput: () => false,
      onFailover,
      log: vi.fn(),
    });

    expect(attemptedModels).toEqual(['claude-primary', 'openai-fallback']);
    expect(onFailover).toHaveBeenCalledOnce();
    expect(output).toMatchObject({
      status: 'success',
      result: 'fallback completed',
    });
    expect(credentials.revoke).toHaveBeenCalledTimes(2);
  });

  it('stops inline and worker handles through GroupQueue with matching terminal semantics', async () => {
    const runWithQueue = async (runtime: 'inline' | 'worker') => {
      const queue = new GroupQueue();
      let terminal: AgentOutput | undefined;
      const registered = vi.fn();
      queue.setProcessMessagesFn(async (queueJid) => {
        if (runtime === 'inline') {
          terminal = await runInlineAgent(
            group,
            baseInput,
            (handle, runHandle) => {
              queue.registerProcess(queueJid, handle, runHandle, group.folder);
              registered();
            },
            undefined,
            inlineOptions(({ signal }) => waitUntilAborted(signal)),
          );
        } else {
          let stopped = false;
          const handle = {
            pid: undefined,
            killed: false,
            kill() {
              stopped = true;
              this.killed = true;
              return true;
            },
          };
          queue.registerProcess(
            queueJid,
            handle as never,
            'worker-run',
            group.folder,
          );
          registered();
          await vi.waitFor(() => expect(stopped).toBe(true));
          terminal = {
            status: 'error',
            result: null,
            error: 'Worker agent stopped by request',
          };
        }
        return true;
      });

      queue.enqueueMessageCheck(baseInput.chatJid);
      await vi.waitFor(() => expect(registered).toHaveBeenCalledOnce());
      expect(queue.stopGroup(baseInput.chatJid)).toBe(true);
      await vi.waitFor(() => expect(terminal).toBeDefined());
      return terminal!;
    };

    const [inline, worker] = await Promise.all([
      runWithQueue('inline'),
      runWithQueue('worker'),
    ]);
    for (const terminal of [inline, worker]) {
      expect(terminal).toMatchObject({ status: 'error', result: null });
      expect(terminal.error).toMatch(/stopped by request/i);
    }
  });

  it('continues a compacted inline session with retained task continuity', async () => {
    const queue = new GroupQueue();
    const frames: AgentOutput[] = [];
    const taskId = 'task-continuity';
    const sessionId = 'session:mock-compact';
    let terminal: AgentOutput | undefined;

    queue.setProcessMessagesFn(async (queueJid) => {
      terminal = await runInlineAgent(
        group,
        {
          ...baseInput,
          prompt: 'MOCK_COMPACTION_THRESHOLD crossed',
        },
        (handle, runHandle) =>
          queue.registerProcess(queueJid, handle, runHandle, group.folder),
        async (frame) => {
          frames.push(frame);
        },
        inlineOptions(async ({ controlPort, emitOutput, signal }) => {
          const continuations: string[] = [];
          const unsubscribe = controlPort.subscribe({
            onContinuation: ({ text }) => continuations.push(text),
            onClose: () => undefined,
          });
          try {
            await emitOutput({
              status: 'success',
              result: null,
              newSessionId: sessionId,
              sessionInit: true,
            });
            await emitOutput({
              status: 'success',
              result: `compacted ${taskId}`,
              newSessionId: sessionId,
              compactBoundary: true,
            });
            await vi.waitFor(() =>
              expect(continuations).toEqual(['continue after compaction']),
            );
            signal.throwIfAborted();
            return {
              status: 'success',
              result: `continued ${taskId} after compaction`,
              newSessionId: sessionId,
            };
          } finally {
            unsubscribe();
          }
        }),
      );
      return terminal.status === 'success';
    });

    queue.enqueueMessageCheck(baseInput.chatJid);
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.compactBoundary)).toBe(true),
    );
    expect(
      queue.sendMessage(baseInput.chatJid, 'continue after compaction'),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(terminal).toMatchObject({
        status: 'success',
        result: `continued ${taskId} after compaction`,
        newSessionId: sessionId,
      }),
    );
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionInit: true, newSessionId: sessionId }),
        expect.objectContaining({
          compactBoundary: true,
          result: `compacted ${taskId}`,
          newSessionId: sessionId,
        }),
      ]),
    );
  });
});

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('inline session turns through the control API', () => {
  let runtime: Awaited<ReturnType<typeof createPostgresIntegrationRuntime>>;
  let mcpServer: http.Server | undefined;
  let gatewayServer: http.Server | undefined;
  let controlServer:
    | Awaited<ReturnType<typeof startTestControlServer>>
    | undefined;
  const mcpCalls: Array<Record<string, unknown>> = [];
  const gatewayCalls: string[] = [];
  const liveTurnIds: string[] = [];
  const runIds: string[] = [];
  const workerId = 'worker:inline-stage-2d-itest';
  let channelEffects: ReturnType<typeof createFakeChannelRuntime>;

  beforeAll(async () => {
    vi.stubEnv('SECRET_ENCRYPTION_KEYRING_JSON', '');
    vi.stubEnv(
      'SECRET_ENCRYPTION_KEY',
      Buffer.alloc(32, 13).toString('base64'),
    );
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'inline_stage_2d',
    });
    const mcp = await startMcpStub(mcpCalls);
    mcpServer = mcp.server;
    const gateway = await startGatewayStub(gatewayCalls);
    gatewayServer = gateway.server;
    credentials.gatewayUrl = gateway.url;
    configureProviderMocks();

    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
    await runtime.repositories.workerCoordination.registerWorker({
      id: workerId,
      bootNonce: 'inline-stage-2d-itest',
    });

    const { createRuntimeApp } =
      await import('@core/app/bootstrap/runtime-app.js');
    const { wireInlineAgentLoopTools, createInlineCoreTools } =
      await import('@core/app/bootstrap/inline-agent-loop-tools.js');
    const { createInlineAgentLoopLaneDispatcher } =
      await import('@core/adapters/llm/inline-lane-dispatcher.js');
    const { runClaudeInlineAgentLoopLane } =
      await import('@core/adapters/llm/anthropic-claude-agent/inline-lane/index.js');
    const { createDeepAgentsInlineAgentLoopLane } =
      await import('@core/adapters/llm/deepagents-langchain/inline-lane/index.js');
    const { createAgentExecutionAdapterRegistry } =
      await import('@core/application/agent-execution/agent-execution-adapter-registry.js');
    const { DirectRunnerSandboxProvider } =
      await import('@core/adapters/sandbox/runner-sandbox-provider.js');
    const { createSessionInteractionModule } =
      await import('@core/control/server/session-interaction-adapter.js');
    const { GroupQueue } = await import('@core/runtime/group-queue.js');

    const remoteCapability = {
      serverId: 'mcp:inline-itest',
      bindingId: 'mcp-binding:inline-itest',
      name: 'crm',
      config: { type: 'http', url: mcp.url },
      allowedToolNames: ['mcp__crm__echo'],
      allowedToolPatterns: ['echo'],
      autoApproveToolNames: [],
      autoApproveToolPatterns: [],
    } as never;
    const support = {
      schemaFactory: z,
      evaluateToolPreChecks: evaluateNeutralToolPreChecks,
      evaluateToolPolicy: evaluateNeutralToolPolicy,
      formatMemorySearchResponse: formatMemoryToolResponse,
      formatMemoryWriteResponse,
    };
    const dispatcher = createInlineAgentLoopLaneDispatcher({
      claudeLane: runClaudeInlineAgentLoopLane,
      deepAgentsLane: createDeepAgentsInlineAgentLoopLane({
        databaseUrl: process.env.GANTRY_TEST_DATABASE_URL ?? null,
        schema: runtime.schemaName,
      }),
      createCoreTools: (laneInput) =>
        createInlineCoreTools(laneInput as never, support),
      getEgressDenylist: () => [],
    });
    const queue = new GroupQueue({
      maxMessageRuns: 1,
      maxJobRuns: 1,
      maxRetries: 0,
      baseRetryMs: 1,
    });
    const executionAdapter = {
      id: 'anthropic:claude-agent-sdk',
      prepare: vi.fn(),
    } as never;
    const app = createRuntimeApp({
      queue,
      opsRepository: runtime.ops,
      ensureCredentialBinding: async () => ({ created: false }),
      executionAdapter,
      executionAdapters: createAgentExecutionAdapterRegistry([
        executionAdapter,
      ]),
      runnerSandboxProvider: new DirectRunnerSandboxProvider(),
      publishRuntimeEvent: (event) =>
        runtime.runtimeEvents.publish(event as never),
      runAgent: ((runGroup, input, onProcess, onOutput, options) =>
        runInlineAgent(
          runGroup,
          { ...input, runtime: 'inline' },
          onProcess,
          onOutput,
          {
            ...options,
            inlineAgentLoopLane: (laneInput) =>
              dispatcher({
                ...laneInput,
                mcpServers: [remoteCapability],
              } as never),
          },
        )) as never,
    });
    channelEffects = createFakeChannelRuntime(() => true, {
      permissionDecision: {
        approved: true,
        mode: 'allow_once',
        decidedBy: 'stage-2d-approver',
      },
      userAnswer: (request) => ({
        requestId: request.requestId,
        answers: { 'Continue?': 'Yes' },
        answeredBy: 'stage-2d-user',
      }),
      sendMessage: async (conversationJid, text) => {
        await createSessionInteractionModule().publishOutboundEvent({
          conversationJid,
          eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
          payload: { text },
        });
      },
      sendStreamingChunk: async (conversationJid, text) => {
        await createSessionInteractionModule().publishOutboundEvent({
          conversationJid,
          eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING,
          payload: { text },
        });
      },
    });
    app.setChannelRuntime(channelEffects.runtime as never);
    wireInlineAgentLoopTools({
      app,
      channelWiring: {
        sendMessage: channelEffects.runtime.sendMessage,
        requestPermissionApproval: (request) =>
          channelEffects.runtime.requestPermissionApproval(
            request.targetJid ?? baseInput.chatJid,
            request,
          ),
        requestUserAnswer: (request) =>
          channelEffects.runtime.requestUserAnswer(
            request.targetJid ?? baseInput.chatJid,
            request,
          ),
      } as never,
      interactionsEnabled: true,
      getAgentAccessPreset: () => 'full',
      getPermissionRuntimeSettings: () => ({
        permissions: {
          autoMode: {},
          yoloMode: { enabled: false },
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
      getAsyncTaskRepository: () => runtime.repositories.asyncTasks,
      opsRepository: runtime.ops,
      getMcpServerRepository: () =>
        ({ appendAuditEvent: vi.fn(async () => undefined) }) as never,
      publishRuntimeEvent: (event) =>
        runtime.runtimeEvents.publish(event as never),
      warn: vi.fn(),
    });

    queue.setProcessMessagesFn(async (queueJid, processOptions) => {
      const route = app.getConversationRoutes()[queueJid];
      if (!route) return true;
      const turnContext = await runtime.ops.getAgentTurnContext({
        appId: 'app-inline-itest',
        agentFolder: route.folder,
        executionProviderId: 'anthropic:claude-agent-sdk' as never,
        conversationJid: queueJid,
      });
      const runId = await runtime.ops.createSessionAgentRun({
        agentSessionId: turnContext.agentSessionId,
        executionProviderId: 'anthropic:claude-agent-sdk' as never,
        cause: 'message',
      });
      if (!runId) throw new Error('Failed to create the integration run.');
      runIds.push(runId);
      const liveTurnId = `live-turn:inline-itest:${liveTurnIds.length + 1}`;
      liveTurnIds.push(liveTurnId);
      await runtime.repositories.liveTurns.claimLiveTurn({
        id: liveTurnId,
        scope: {
          appId: 'app-inline-itest',
          agentSessionId: turnContext.agentSessionId,
          conversationId: queueJid,
          threadId: null,
        },
        workerInstanceId: workerId,
        runId,
      });
      const completed = await app.processGroupMessages(queueJid, {
        ...processOptions,
        existingRunId: runId,
      });
      await runtime.repositories.liveTurns.transitionLiveTurnState({
        id: liveTurnId,
        toState: completed ? 'completed' : 'failed',
        fromStates: ['claimed', 'running'],
      });
      return completed;
    });

    controlServer = await startTestControlServer({
      token: 'inline-stage-2d-token',
      appId: 'app-inline-itest',
      scopes: ['sessions:read', 'sessions:write'],
      runtimeApp: app,
      liveExecution: false,
      liveTurnsEnabled: false,
    });
  }, 60_000);

  afterAll(async () => {
    await controlServer?.close();
    await close(mcpServer);
    await close(gatewayServer);
    await runtime?.cleanup();
    credentials.gatewayUrl = '';
    vi.unstubAllEnvs();
  });

  it('runs mocked Claude and OpenAI-compatible inline turns with core tools, remote MCP, and durable records', async () => {
    const ensureSession = async (conversationId: string) => {
      const response = await fetch(
        `${controlServer!.baseUrl}/v1/sessions/ensure`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${controlServer!.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            appId: 'app-inline-itest',
            conversationId,
            responseMode: 'sse',
          }),
        },
      );
      expect(response.status).toBe(200);
      registerInlineSessionAgent(conversationId);
      return (await response.json()) as { sessionId: string };
    };
    const runTurn = async (
      sessionId: string,
      message: string,
      responseSchema?: Record<string, unknown>,
    ) => {
      const runIndex = runIds.length;
      const response = await fetch(
        `${controlServer!.baseUrl}/v1/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${controlServer!.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message,
            responseMode: 'sse',
            ...(responseSchema ? { response_schema: responseSchema } : {}),
          }),
        },
      );
      expect(response.status).toBe(202);
      await vi.waitFor(
        async () => {
          const runId = runIds[runIndex];
          expect(runId).toEqual(expect.any(String));
          await expect(
            runtime.repositories.agentRuns.getAgentRun(runId as never),
          ).resolves.toMatchObject({ status: 'completed' });
        },
        { timeout: 20_000, interval: 50 },
      );
    };

    const claude = await ensureSession('claude-inline');
    await runTurn(claude.sessionId, 'CLAUDE_TURN use every scripted tool');
    const openai = await ensureSession('openai-inline');
    await runTurn(openai.sessionId, 'OPENAI_TURN use every scripted tool');
    const responseSchema = {
      type: 'object',
      properties: { lane: { type: 'string' } },
      required: ['lane'],
      additionalProperties: false,
    };
    await runTurn(
      claude.sessionId,
      'Return the first structured result',
      responseSchema,
    );
    await runTurn(
      openai.sessionId,
      'OPENAI_TURN return the second structured result',
      responseSchema,
    );

    expect(sdk.query).toHaveBeenCalledTimes(3);
    expect(deep.createAgent).toHaveBeenCalledTimes(3);
    expect(sdk.query.mock.calls[1]?.[0].options.outputFormat).toEqual({
      type: 'json_schema',
      schema: responseSchema,
    });
    expect(deep.createAgent.mock.calls[1]?.[0].responseFormat).toMatchObject({
      schema: expect.objectContaining({
        properties: responseSchema.properties,
      }),
      tool: expect.objectContaining({
        function: expect.objectContaining({
          name: 'gantry_structured_output',
          parameters: expect.objectContaining({
            properties: responseSchema.properties,
          }),
        }),
      }),
    });
    for (const prompts of Object.values(structuredAttemptPrompts)) {
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).not.toBe(prompts[0]);
      expect(prompts[1]).toMatch(/validat/i);
      expect(prompts[1]).toMatch(/required/i);
      expect(prompts[1]).toContain('lane');
    }
    expect(mcpCalls).toEqual([{ value: 'claude' }, { value: 'openai' }]);
    expect(gatewayCalls).toContain('/openai/mock');
    expect(channelEffects.outbound.map(({ text }) => text)).toEqual(
      expect.arrayContaining([
        'Claude core message',
        'OpenAI core message',
        '{"lane":"first"}',
        '{"lane":"second"}',
      ]),
    );
    expect(channelEffects.userQuestions).toHaveLength(2);
    expect(channelEffects.permissionRequests).toHaveLength(2);

    const interactionRows = await runtime.service.db
      .select({
        kind: pgSchema.pendingInteractionsPostgres.kind,
        status: pgSchema.pendingInteractionsPostgres.status,
        runId: pgSchema.pendingInteractionsPostgres.runId,
      })
      .from(pgSchema.pendingInteractionsPostgres);
    expect(interactionRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'permission',
          status: 'resolved',
          runId: expect.any(String),
        }),
        expect.objectContaining({
          kind: 'question',
          status: 'resolved',
          runId: expect.any(String),
        }),
      ]),
    );
    expect(
      interactionRows.filter((row) => row.kind === 'permission'),
    ).toHaveLength(2);
    expect(
      interactionRows.filter((row) => row.kind === 'question'),
    ).toHaveLength(2);

    const runRows = await runtime.service.db
      .select({
        id: pgSchema.agentRunsPostgres.id,
        status: pgSchema.agentRunsPostgres.status,
      })
      .from(pgSchema.agentRunsPostgres);
    expect(runRows.filter((row) => row.status === 'completed')).toHaveLength(4);
    await vi.waitFor(
      async () => {
        const liveTurnRows = await runtime.service.db
          .select({
            runId: pgSchema.liveTurnsPostgres.runId,
            state: pgSchema.liveTurnsPostgres.state,
          })
          .from(pgSchema.liveTurnsPostgres);
        expect(liveTurnRows).toHaveLength(4);
        expect(liveTurnRows).toEqual(
          expect.arrayContaining(
            runRows.map((run) =>
              expect.objectContaining({ runId: run.id, state: 'completed' }),
            ),
          ),
        );
      },
      { timeout: 20_000, interval: 50 },
    );
    for (const liveTurnId of liveTurnIds) {
      await expect(
        runtime.repositories.liveTurns.getLiveTurnById(liveTurnId),
      ).resolves.toMatchObject({ state: 'completed' });
    }
  }, 60_000);

  it('persists child runs for inline and worker delegation targets', async () => {
    const { createInlineAgentTaskLifecycle } =
      await import('@core/app/bootstrap/inline-agent-task-lifecycle.js');
    const { makeAgentThreadQueueKey } =
      await import('@core/shared/thread-queue-key.js');
    const conversationJid = 'app:default:delegation';
    const parentGroup = {
      ...group,
      folder: 'parent_inline',
      agentConfig: { runtime: 'inline' },
    } as ConversationRoute;
    const inlineTarget = {
      ...group,
      folder: 'child_inline',
      agentConfig: { runtime: 'inline' },
    } as ConversationRoute;
    const workerTarget = {
      ...group,
      folder: 'child_worker',
      agentConfig: { runtime: 'worker' },
    } as ConversationRoute;
    const routes = {
      [makeAgentThreadQueueKey(conversationJid, 'agent:parent_inline')]:
        parentGroup,
      [makeAgentThreadQueueKey(conversationJid, 'agent:child_inline')]:
        inlineTarget,
      [makeAgentThreadQueueKey(conversationJid, 'agent:child_worker')]:
        workerTarget,
    };
    const parentContext = await runtime.ops.getAgentTurnContext({
      appId: 'default',
      agentFolder: parentGroup.folder,
      executionProviderId: 'integration:inline' as never,
      conversationJid,
      hydrateMemory: false,
    });
    const parentRunId = await runtime.ops.createSessionAgentRun({
      agentSessionId: parentContext.agentSessionId,
      executionProviderId: 'integration:inline' as never,
      cause: 'manual',
    });
    expect(parentRunId).toEqual(expect.any(String));

    const tools = createInlineAgentTaskLifecycle({
      laneInput: {
        group: parentGroup,
        input: {
          ...baseInput,
          appId: 'default',
          agentId: 'agent:parent_inline',
          chatJid: conversationJid,
          runId: parentRunId,
          compiledSystemPrompt: 'delegation integration prompt',
        },
        signal: new AbortController().signal,
      } as never,
      repository: runtime.repositories.asyncTasks,
      runRepository: runtime.ops,
      getConversationRoutes: () => routes,
      resolveExecutionProviderId: async (route) =>
        route.agentConfig?.runtime === 'inline'
          ? ('integration:inline' as never)
          : ('integration:worker' as never),
      resolveRunAccess: async (agentId) => ({
        toolPolicyRules: [`target:${agentId}`],
        attachedMcpSourceIds: [`mcp:${agentId}`],
      }),
      buildRunOptions: async () =>
        inlineOptions(async () => ({
          status: 'success',
          result: 'inline child completed',
        })),
    });
    expect(tools).toBeDefined();

    await expect(
      tools!.delegate_task({
        objective: 'Run inline child',
        targetAgentId: 'agent:child_inline',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      tools!.delegate_task({
        objective: 'Run worker child',
        targetAgentId: 'agent:child_worker',
      }),
    ).resolves.toMatchObject({ ok: true });

    await vi.waitFor(
      async () => {
        const childRuns = await runtime.service.db
          .select({
            agentId: pgSchema.agentRunsPostgres.agentId,
            status: pgSchema.agentRunsPostgres.status,
          })
          .from(pgSchema.agentRunsPostgres);
        expect(childRuns).toEqual(
          expect.arrayContaining([
            { agentId: 'agent:child_inline', status: 'completed' },
            { agentId: 'agent:child_worker', status: 'completed' },
          ]),
        );
      },
      { timeout: 20_000, interval: 50 },
    );
    await vi.waitFor(
      async () => {
        const childTasks = await runtime.service.db
          .select({
            kind: pgSchema.agentAsyncTasksPostgres.kind,
            status: pgSchema.agentAsyncTasksPostgres.status,
          })
          .from(pgSchema.agentAsyncTasksPostgres);
        expect(childTasks).toEqual([
          { kind: 'delegated_agent', status: 'completed' },
          { kind: 'delegated_agent', status: 'completed' },
        ]);
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(delegatedSpawn.run).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'child_inline' }),
      expect.objectContaining({
        runId: expect.any(String),
        toolPolicyRules: ['target:agent:child_inline'],
        attachedMcpSourceIds: ['mcp:agent:child_inline'],
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
    );
    expect(delegatedSpawn.run).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'child_worker' }),
      expect.objectContaining({
        runId: expect.any(String),
        toolPolicyRules: ['target:agent:child_worker'],
        attachedMcpSourceIds: ['mcp:agent:child_worker'],
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
    );
  }, 60_000);
});
