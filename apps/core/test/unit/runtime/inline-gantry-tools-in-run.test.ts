import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { type BaseMessage } from '@langchain/core/messages';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { prepareInlineAgentHostContext } from '@core/runtime/agent-spawn-host.js';
import { createCoreToolRegistry } from '@core/runtime/core-tools/registry.js';
import { createCoreToolSchemas } from '@core/runtime/core-tools/schemas.js';
import type { CoreTaskLifecycleBackend } from '@core/application/core-tools/task-lifecycle.js';
import {
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
  type AgentEngine,
} from '@core/shared/agent-engine.js';
import { createDefaultInlineAgentLoopLane } from '@core/adapters/llm/default-runtime-adapters.js';
import {
  evaluateNeutralToolPolicy,
  evaluateNeutralToolPreChecks,
} from '@core/runner/tool-gate-core.js';
import {
  formatMemoryToolResponse,
  formatMemoryWriteResponse,
} from '@core/runner/mcp/formatting.js';

const probe = vi.hoisted(() => ({
  engine: undefined as AgentEngine | undefined,
  prompt: '',
  tools: [] as string[],
  model: undefined as unknown,
  accessPreset: 'full' as 'full' | 'locked',
}));

vi.mock('@core/config/index.js', async () => ({
  AGENT_TIMEOUT: 30_000,
  DATA_DIR: (await import('node:path')).join(
    (await import('node:os')).tmpdir(),
    'gantry-inline-tool-test',
  ),
  IDLE_TIMEOUT: 30_000,
  getCredentialBrokerRuntimeConfig: () => ({
    mode: 'gantry',
    gatewayBindHost: '127.0.0.1',
  }),
  getEffectiveModelConfig: () => ({}),
  getRuntimeSettingsForConfig: () => ({
    agents: { team: { accessPreset: probe.accessPreset } },
    modelFamilies: [],
    runtime: { sandbox: { provider: 'direct' } },
  }),
  getSelectedAgentHarness: () => 'auto',
}));
vi.mock('@core/runtime/agent-spawn-model-resolution.js', () => ({
  resolveSpawnModel: async () => ({
    resolvedModel: {
      ok: true,
      value: {
        agentEngine: probe.engine,
        runnerModel: 'test-model',
        modelEntry: {
          displayName: 'Test model',
          modelRoute: { id: 'anthropic', label: 'Test provider' },
        },
      },
    },
  }),
}));
vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getConfiguredModelProvidersForApp: async () => [],
  getRuntimeFileArtifactStore: () => undefined,
  getRuntimeEventExchange: () => ({ publish: async () => undefined }),
  getRuntimeStorage: () => ({
    repositories: {
      agents: { getAgent: async () => undefined },
      agentConfigs: { getConfigVersion: async () => undefined },
    },
  }),
}));
vi.mock(
  '@core/adapters/llm/deepagents-langchain/runner/model-factory.js',
  () => ({
    buildRunnerModel: async () => ({
      model: probe.model,
      endpointFamily: 'openai',
      modelId: 'test-model',
    }),
  }),
);
// The SDK server and its registrations are real; only the external model query is replaced.
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => {
  const sdk = await original<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...sdk,
    query: ({
      options,
    }: {
      options: {
        systemPrompt: string[];
        mcpServers: Record<
          string,
          { instance: { connect(transport: InMemoryTransport): Promise<void> } }
        >;
      };
    }) => ({
      async *[Symbol.asyncIterator]() {
        probe.prompt = options.systemPrompt.join('\n');
        const client = new Client({
          name: 'inline-inventory-proof',
          version: '1',
        });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        try {
          await Promise.all([
            client.connect(clientTransport),
            options.mcpServers.gantry.instance.connect(serverTransport),
          ]);
          probe.tools = (await client.listTools()).tools.map(
            ({ name }) => name,
          );
        } finally {
          await client.close();
        }
        yield {
          type: 'result',
          subtype: 'success',
          uuid: 'inline-proof',
          result: 'done',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    }),
  };
});

class CapturingModel extends FakeListChatModel {
  bindTools(...args: Parameters<FakeListChatModel['bindTools']>) {
    probe.tools = args[0].map(({ name }) => name);
    return super.bindTools(...args);
  }
}

function captureMessages(messages: BaseMessage[]) {
  probe.prompt = messages
    .filter((message: BaseMessage) => message.getType() === 'system')
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

describe('the-agent-can-t-tell-which-gantry-tools inline mounting', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // bindTools creates a fresh FakeListChatModel, so capture at its real model transport.
    const stream = FakeListChatModel.prototype._streamResponseChunks;
    vi.spyOn(
      FakeListChatModel.prototype,
      '_streamResponseChunks',
    ).mockImplementation(async function* (this: FakeListChatModel, ...args) {
      captureMessages(args[0]);
      yield* stream.call(this, ...args);
    });
    probe.prompt = '';
    probe.tools = [];
    probe.model = new CapturingModel({ responses: ['done'] });
    probe.accessPreset = 'full';
  });

  it.each([
    [DEFAULT_AGENT_ENGINE, true, 'full', false, true, false, undefined],
    [
      DEFAULT_AGENT_ENGINE,
      false,
      'full',
      false,
      true,
      false,
      'AgentDelegation has not been granted',
    ],
    [DEEPAGENTS_ENGINE, true, 'full', false, true, false, undefined],
    [
      DEEPAGENTS_ENGINE,
      false,
      'full',
      false,
      true,
      false,
      'AgentDelegation has not been granted',
    ],
    [
      DEEPAGENTS_ENGINE,
      true,
      'locked',
      false,
      true,
      false,
      'locked access preset',
    ],
    [DEEPAGENTS_ENGINE, true, 'full', true, true, false, 'tools are hidden'],
    [
      DEEPAGENTS_ENGINE,
      true,
      'full',
      false,
      false,
      false,
      'async task executor is unavailable',
    ],
    [DEEPAGENTS_ENGINE, true, 'full', false, true, true, undefined],
  ] as const)(
    'inline %s exposed tools agree with grant %s, preset %s, hidden %s, executor %s, disabled %s',
    async (engine, granted, preset, hidden, executor, disabled, gateReason) => {
      probe.engine = engine;
      probe.accessPreset = preset;
      const group = {
        name: 'Team',
        folder: 'team',
        trigger: '',
        added_at: '2026-01-01T00:00:00.000Z',
        conversationKind: 'dm' as const,
      };
      const agentInput = {
        prompt: 'hello',
        workspaceFolder: 'team',
        chatJid: 'conversation:inline-proof',
        appId: 'app-one',
        agentId: 'agent-one',
        isScheduledJob: true,
        toolPolicyRules: granted ? ['AgentDelegation'] : [],
        hideAuthorityTools: hidden,
      };
      const host = await prepareInlineAgentHostContext(group, agentInput);
      const lane = createDefaultInlineAgentLoopLane({
        databaseUrl: null,
        databaseSchema: 'inline_proof',
        getEgressDenylist: () => [],
        createCoreTools: () => ({
          ...createCoreToolRegistry({
            context: {
              sourceAgentFolder: group.folder,
              conversationId: agentInput.chatJid,
              appId: agentInput.appId,
              agentId: agentInput.agentId,
              permissionMode: 'auto',
              allowedToolRules: agentInput.toolPolicyRules,
              accessPreset: preset,
              fixedImageRestricted: hidden,
            },
            sendMessage: async () => undefined,
            requestUserAnswer: async (request) => ({
              requestId: request.requestId,
              answers: {},
            }),
            taskLifecycleBackend: executor
              ? ({
                  delegate_task: async () => ({ ok: true, message: 'ready' }),
                  task_get: async () => ({ ok: true, message: 'ready' }),
                  task_list: async () => ({ ok: true, message: 'ready' }),
                  task_cancel: async () => ({ ok: true, message: 'ready' }),
                  task_message: async () => ({ ok: true, message: 'ready' }),
                } satisfies CoreTaskLifecycleBackend)
              : undefined,
            evaluateToolPreChecks: evaluateNeutralToolPreChecks,
            evaluateToolPolicy: evaluateNeutralToolPolicy,
            formatMemorySearchResponse: formatMemoryToolResponse,
            formatMemoryWriteResponse,
            schemas: createCoreToolSchemas(z),
          }),
          authorizeThirdPartyMcpTool: async () => ({ allowed: false }),
          recordThirdPartyMcpToolActivity: async () => undefined,
        }),
      });
      const result = await lane({
        group,
        input: {
          ...agentInput,
          permissionMode: 'auto',
          compiledSystemPrompt: host.compiledSystemPrompt ?? '',
          disableTools: disabled,
        },
        signal: new AbortController().signal,
        controlPort: { subscribe: () => () => undefined },
        resolvedModel: host.resolvedModel,
        modelCredentialEnv: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:10254/anthropic',
          ANTHROPIC_API_KEY: 'gtw_test',
          OPENAI_BASE_URL: 'http://127.0.0.1:10254/openai',
          OPENAI_API_KEY: 'gtw_test',
        },
        mcpServers: [],
        runtimeDataDir: join(tmpdir(), 'gantry-inline-tool-proof'),
        emitOutput: async () => undefined,
      });
      expect(result.status).toBe('success');
      expect(probe.prompt).toContain('Gantry');
      if (!disabled) {
        expect(probe.tools).toContain('delegate_task');
        expect(probe.tools).toContain('task_message');
      }
      const availableText = /^Available: (.*)\.$/m.exec(probe.prompt)?.[1];
      const available =
        availableText === 'none' || availableText === ''
          ? []
          : availableText?.split(', ').sort();
      expect(available).toEqual([...probe.tools].sort());
      if (!gateReason) {
        expect(probe.prompt).not.toMatch(
          /AgentDelegation (?:not granted|has not been granted)/,
        );
      } else {
        const gate = /(?:Gated|Unavailable):[^\n]*delegate_task[^\n]*/.exec(
          probe.prompt,
        )?.[0];
        expect(gate).toContain(gateReason);
      }
    },
  );
});
