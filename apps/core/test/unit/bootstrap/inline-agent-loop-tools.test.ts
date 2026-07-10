import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createInlineCoreTools,
  wireInlineAgentLoopTools,
} from '@core/app/bootstrap/inline-agent-loop-tools.js';
import {
  evaluateNeutralToolPolicy,
  evaluateNeutralToolPreChecks,
} from '@core/runner/tool-gate-core.js';
import {
  formatMemoryToolResponse,
  formatMemoryWriteResponse,
} from '@core/runner/mcp/formatting.js';

const publishRuntimeEvent = vi.fn(async () => undefined);
const requestPermissionApproval = vi.fn(async () => ({
  approved: true,
  mode: 'allow_once' as const,
}));

function wire(overrides: Record<string, unknown> = {}) {
  const repository = {
    listTasks: vi.fn(async () => []),
  };
  wireInlineAgentLoopTools({
    app: {
      executionAdapter: undefined,
      executionAdapters: undefined,
      runnerSandboxProvider: { enforcing: true },
      getCredentialBroker: vi.fn(async () => undefined),
      getConversationRoutes: vi.fn(() => ({})),
      resolveExecutionProviderId: vi.fn(async () => 'test:inline'),
    },
    channelWiring: {
      sendMessage: vi.fn(async () => undefined),
      requestPermissionApproval,
      requestUserAnswer: vi.fn(async (request) => ({
        requestId: request.requestId,
        answers: {},
      })),
    },
    interactionsEnabled: true,
    getAgentAccessPreset: () => 'full',
    getYoloMode: () => ({ enabled: false }),
    getAsyncTaskRepository: () => repository,
    publishRuntimeEvent,
    warn: vi.fn(),
    ...overrides,
  } as never);
  return repository;
}

function laneInput() {
  return {
    group: {
      name: 'Test',
      folder: 'main_agent',
      trigger: '@test',
      added_at: new Date(0).toISOString(),
    },
    input: {
      prompt: 'hello',
      workspaceFolder: 'main_agent',
      chatJid: 'conversation:test',
      compiledSystemPrompt: 'system',
      appId: 'default',
      agentId: 'agent-1',
      runId: 'run-1',
    },
    signal: new AbortController().signal,
    controlPort: { subscribe: vi.fn(() => () => undefined) },
    resolvedModel: { ok: true },
    modelCredentialEnv: {},
    mcpServers: [],
    runtimeDataDir: '/tmp/inline-tools-test',
    jobActivity: {
      beginPermissionRequest: vi.fn(),
      finishPermissionRequest: vi.fn(),
    },
    emitOutput: vi.fn(async () => undefined),
  } as never;
}

function support(
  evaluateToolPolicy: typeof evaluateNeutralToolPolicy = evaluateNeutralToolPolicy,
) {
  return {
    schemaFactory: z,
    evaluateToolPreChecks: evaluateNeutralToolPreChecks,
    evaluateToolPolicy,
    formatMemorySearchResponse: formatMemoryToolResponse,
    formatMemoryWriteResponse,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('inline core tool bootstrap', () => {
  it('mounts the shared durable task lifecycle tools', async () => {
    const repository = wire();
    const tools = createInlineCoreTools(laneInput(), support());

    expect(tools.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'delegate_task',
        'task_get',
        'task_list',
        'task_cancel',
        'task_message',
      ]),
    );
    await expect(tools.execute('task_list', {})).resolves.toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({
            text: expect.stringContaining('Listed 0 async task(s).'),
          }),
        ],
      }),
    );
    expect(repository.listTasks).toHaveBeenCalledOnce();
  });

  it('publishes permission lifecycle events for remote MCP prompts', async () => {
    wire();
    const input = laneInput();
    input.mcpServers = [
      {
        name: 'crm',
        allowedToolNames: ['mcp__crm__read'],
      },
    ] as never;
    const tools = createInlineCoreTools(
      input,
      support((() => ({
        status: 'prompt',
        reason: 'Approval required.',
      })) as never),
    );

    await expect(
      tools.authorizeThirdPartyMcpTool('mcp__crm__read', { id: 'crm-1' }),
    ).resolves.toEqual({ allowed: true });
    expect(input.emitOutput).toHaveBeenCalledWith(
      expect.objectContaining({ interactionBoundary: 'user_interaction' }),
    );
    expect(input.jobActivity.beginPermissionRequest).toHaveBeenCalledWith(
      expect.any(String),
      'mcp__crm__read',
    );
    expect(input.jobActivity.finishPermissionRequest).toHaveBeenCalledOnce();
    expect(
      publishRuntimeEvent.mock.calls.map(([event]) => event.eventType),
    ).toEqual([
      'permission.requested',
      'permission.allowed',
      'permission.resumed',
      'permission.final_outcome',
    ]);
  });

  it('prompts for allowed remote MCP tools that are not auto-approved', async () => {
    wire();
    const input = laneInput();
    input.mcpServers = [
      {
        name: 'crm',
        allowedToolNames: ['mcp__crm__read'],
        autoApproveToolNames: [],
      },
    ] as never;
    const tools = createInlineCoreTools(input, support());

    await expect(
      tools.authorizeThirdPartyMcpTool('mcp__crm__read', { id: 'crm-1' }),
    ).resolves.toEqual({ allowed: true });
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
  });

  it('does not prompt for auto-approved remote MCP tools', async () => {
    wire();
    const input = laneInput();
    input.mcpServers = [
      {
        name: 'crm',
        allowedToolNames: ['mcp__crm__read'],
        autoApproveToolNames: ['mcp__crm__read'],
      },
    ] as never;
    const tools = createInlineCoreTools(input, support());

    await expect(
      tools.authorizeThirdPartyMcpTool('mcp__crm__read', { id: 'crm-1' }),
    ).resolves.toEqual({ allowed: true });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });
});
