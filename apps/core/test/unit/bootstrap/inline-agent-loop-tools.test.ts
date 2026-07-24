import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createInlineCoreTools,
  createInlineCoreToolsForRun,
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
import type {
  AsyncTaskCreateInput,
  AsyncTaskRecord,
} from '@core/domain/ports/async-tasks.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

const publishRuntimeEvent = vi.fn(async () => undefined);
const sendMessage = vi.fn(async () => undefined);
const requestPermissionApproval = vi.fn(async () => ({
  approved: true,
  mode: 'allow_once' as const,
}));
const requestUserAnswer = vi.fn(async (request) => ({
  requestId: request.requestId,
  answers: {},
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
      getConversationRoutes: vi.fn(() => ({
        [makeAgentThreadQueueKey(
          'conversation:test',
          'agent-1',
          undefined,
          'slack-main',
        )]: {
          name: 'Main',
          folder: 'main_agent',
          trigger: '',
          added_at: new Date(0).toISOString(),
          agentId: 'agent-1',
          providerAccountId: 'slack-main',
          conversationId: 'conversation:shared',
        },
        [makeAgentThreadQueueKey('conversation:test', 'agent:reviewer')]: {
          name: 'Reviewer',
          folder: 'reviewer',
          trigger: '',
          added_at: new Date(0).toISOString(),
          agentId: 'agent:reviewer',
          providerAccountId: 'slack-reviewer',
          conversationId: 'conversation:shared',
        },
      })),
      resolveExecutionProviderId: vi.fn(async () => 'test:inline'),
    },
    channelWiring: {
      sendMessage,
      requestPermissionApproval,
      requestUserAnswer,
    },
    interactionsEnabled: true,
    getAgentAccessPreset: () => 'full',
    getPermissionRuntimeSettings: () => ({
      permissions: {
        autoMode: {},
        yoloMode: { enabled: false },
      },
      memory: { llm: { models: { extractor: 'sonnet' } } },
    }),
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
      providerAccountId: 'slack-main',
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
      runtimeAccess: [
        {
          selectedCapabilityId: 'mcp.crm.access',
          sourceType: 'mcp_server',
          auditLabel: 'CRM read',
          reviewedServerId: 'crm',
          allowedTools: ['mcp__crm__read'],
          credentialRefs: [],
          networkHosts: [],
        },
      ],
      semanticCapabilities: [
        {
          capabilityId: 'mcp.crm.access',
          displayName: 'CRM read',
          category: 'CRM',
          risk: 'read',
          can: 'Read CRM records.',
          cannot: 'Mutate CRM records.',
          credentialSource: 'none',
          implementationBindings: [
            {
              kind: 'mcp_pattern',
              mcpServer: 'crm',
              mcpToolPatterns: ['read'],
            },
          ],
        },
      ],
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
  it('uses the active correlation run for permission and question requests', async () => {
    wire();
    const input = laneInput();
    input.correlationRunId = 'run-active';
    input.input.runId = undefined;
    const tools = createInlineCoreTools(input, support());

    await tools.execute('delegate_task', { objective: 'Investigate' });
    await tools.execute('ask_user_question', {
      questions: [
        {
          question: 'Continue?',
          header: 'Continue',
          options: [
            { label: 'Yes', description: 'Continue.' },
            { label: 'No', description: 'Stop.' },
          ],
        },
      ],
    });

    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-active' }),
    );
    expect(requestUserAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-active' }),
    );
  });

  it('returns the structured rule denial envelope on the inline lane', async () => {
    wire();
    const input = laneInput();
    input.input.toolRules = [
      { tool: 'task_list', action: 'block', reason: 'no task inventory' },
    ];
    const tools = createInlineCoreTools(input, support());

    await expect(tools.execute('task_list', {})).resolves.toMatchObject({
      isError: true,
      error: {
        category: 'permission',
        isRetryable: false,
        message: expect.stringContaining('no task inventory'),
      },
    });
  });

  it.each([
    {
      label: 'permission',
      rule: {
        tool: 'mcp__crm__read',
        action: 'block' as const,
        reason: 'CRM reads are blocked',
      },
      resultClass: 'denied',
      category: 'permission',
    },
    {
      label: 'validation',
      rule: {
        tool: 'mcp__crm__read',
        action: 'block' as const,
        reason: 'CRM id is required',
        when: { arg: 'id', matches: '.+' },
      },
      resultClass: 'invalid_request',
      category: 'validation',
    },
  ])(
    'persists the $label remote MCP denial envelope in tool activity audit',
    async ({ rule, resultClass, category }) => {
      const appendAuditEvent = vi.fn(async () => undefined);
      wire({
        getMcpServerRepository: () => ({ appendAuditEvent }),
      });
      const input = laneInput();
      input.input.toolRules = [rule];
      input.mcpServers = [
        {
          name: 'crm',
          allowedToolNames: ['mcp__crm__read'],
        },
      ] as never;
      const tools = createInlineCoreTools(input, support());

      const result = await tools.authorizeThirdPartyMcpTool(
        'mcp__crm__read',
        {},
      );
      expect(result.allowed).toBe(false);
      expect(JSON.parse(result.reason ?? '{}')).toMatchObject({
        category,
        isRetryable: false,
        message: expect.stringContaining(rule.reason),
      });
      expect(appendAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            resultClass,
            error: expect.objectContaining({
              category,
              isRetryable: false,
              message: expect.stringContaining(rule.reason),
            }),
          }),
        }),
      );
    },
  );

  it.each([
    ['a genuine result', { content: [{ type: 'text', text: 'ok' }] }, true],
    [
      'an isError result',
      {
        isError: true,
        content: [{ type: 'text', text: 'CRM read failed.' }],
      },
      false,
    ],
    ['no result', undefined, false],
  ])(
    'records require_prior success for %s only with positive evidence',
    async (_label, result, expectedAllowed) => {
      const appendAuditEvent = vi.fn(async () => undefined);
      wire({
        getMcpServerRepository: () => ({ appendAuditEvent }),
      });
      const input = laneInput();
      input.input.toolRules = [
        {
          tool: 'mcp__crm__write',
          action: 'require_prior',
          prior: 'mcp__crm__read',
          reason: 'CRM writes require a successful read first',
        },
      ];
      input.mcpServers = [
        {
          name: 'crm',
          allowedToolNames: ['mcp__crm__read', 'mcp__crm__write'],
          autoApproveToolNames: ['mcp__crm__write'],
        },
      ] as never;
      const tools = createInlineCoreTools(input, support());

      await tools.recordThirdPartyMcpToolActivity({
        serverName: 'crm',
        toolName: 'read',
        toolInput: { id: 'crm-1' },
        outcome: 'success',
        latencyMs: 4,
        result,
      });

      const authorization = await tools.authorizeThirdPartyMcpTool(
        'mcp__crm__write',
        { id: 'crm-1' },
      );
      expect(authorization.allowed).toBe(expectedAllowed);
      expect(requestPermissionApproval).not.toHaveBeenCalled();
      if (!expectedAllowed) {
        expect(JSON.parse(authorization.reason ?? '{}')).toMatchObject({
          message: expect.stringContaining(
            'Required prior tool "mcp__crm__read" has not completed successfully',
          ),
        });
      }
      if (result && 'isError' in result) {
        expect(appendAuditEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({ resultClass: 'failure' }),
          }),
        );
      }
    },
  );

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

  it('preloads a conversation-bound callable agent with its persona', async () => {
    const listAgents = vi.fn(async () => [
      {
        id: 'agent:main_agent',
        appId: 'default',
        name: 'Main',
        status: 'active',
      },
      {
        id: 'agent:reviewer',
        appId: 'default',
        name: 'Reviewer',
        status: 'active',
      },
    ]);
    wire({
      getAgentRepository: () => ({ listAgents }),
      getPermissionRuntimeSettings: () => ({
        agents: {
          main_agent: { delegates: ['reviewer'] },
          reviewer: { persona: 'research' },
        },
        permissions: {
          autoMode: {},
          yoloMode: { enabled: false },
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
    });
    const input = laneInput();
    input.input.toolPolicyRules = ['AgentDelegation'];

    const tools = await createInlineCoreToolsForRun(input, support());
    const projected = tools.tools.find(({ name }) =>
      name.startsWith('delegate_to_'),
    );

    expect(projected).toMatchObject({
      description: 'Delegate to Reviewer (research).',
    });
    expect(projected?.name.length).toBeLessThanOrEqual(64);
    expect(listAgents).toHaveBeenCalledWith('default');
  });

  it('records AgentDelegation authority for inline callable-agent tasks', async () => {
    const tasks: AsyncTaskRecord[] = [];
    const repository = {
      createTask: vi.fn(async (taskInput: AsyncTaskCreateInput) => {
        const task: AsyncTaskRecord = {
          ...taskInput,
          conversationId: taskInput.conversationId ?? null,
          threadId: taskInput.threadId ?? null,
          parentRunId: taskInput.parentRunId ?? null,
          parentJobId: taskInput.parentJobId ?? null,
          parentJobRunId: taskInput.parentJobRunId ?? null,
          privateCorrelationJson: taskInput.privateCorrelationJson ?? {},
          createdAt: taskInput.now,
          updatedAt: taskInput.now,
        };
        tasks.push(task);
        return task;
      }),
      getTask: vi.fn(
        async (taskId: string) =>
          tasks.find((task) => task.id === taskId) ?? null,
      ),
      transitionTask: vi.fn(async (transition) => {
        const index = tasks.findIndex((task) => task.id === transition.taskId);
        const current = tasks[index];
        if (!current) return null;
        const updated = {
          ...current,
          status: transition.status,
          updatedAt: transition.now,
          privateCorrelationJson:
            transition.privateCorrelationJson ?? current.privateCorrelationJson,
        };
        tasks[index] = updated;
        return updated;
      }),
      listTasks: vi.fn(async () => []),
      countTasksByStatus: vi.fn(async () => []),
      claimQueuedTask: vi.fn(async () => null),
    };
    const listAgents = vi.fn(async () => [
      {
        id: 'agent:main_agent',
        appId: 'default',
        name: 'Main',
        status: 'active',
      },
      {
        id: 'agent:reviewer',
        appId: 'default',
        name: 'Reviewer',
        status: 'active',
      },
    ]);
    wire({
      getAsyncTaskRepository: () => repository,
      getAgentRepository: () => ({ listAgents }),
      getPermissionRuntimeSettings: () => ({
        agents: {
          main_agent: { delegates: ['reviewer'] },
          reviewer: { persona: 'research' },
        },
        permissions: {
          autoMode: {},
          yoloMode: { enabled: false },
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
    });
    const input = laneInput();
    input.input.toolPolicyRules = ['AgentDelegation'];
    const tools = await createInlineCoreToolsForRun(input, support());
    const callableTool = tools.tools.find(({ name }) =>
      name.startsWith('delegate_to_'),
    );

    vi.stubEnv('SECRET_ENCRYPTION_KEY', Buffer.alloc(32, 1).toString('base64'));
    const result = await tools.execute(callableTool!.name, {
      objective: 'Review the change',
      syncWaitTimeoutMs: 1,
    });
    vi.unstubAllEnvs();

    expect(result).not.toMatchObject({ isError: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.authoritySnapshotJson).toEqual({
      toolName: 'AgentDelegation',
      maxDepth: 1,
    });
    expect(tasks[0]?.authoritySnapshotJson.toolName).not.toBe('delegate_task');
  });

  it.each([
    { label: 'delegated child', parentTaskId: 'task-parent' },
    { label: 'locked access', locked: true },
    { label: 'authority-hidden run', hideAuthorityTools: true },
    { label: 'empty allowlist', emptyAllowlist: true },
    { label: 'missing AgentDelegation', noDelegation: true },
    { label: 'missing executor', noExecutor: true },
    { label: 'tools disabled', toolsDisabled: true },
  ])('suppresses callable-agent tools for $label', async (scenario) => {
    const listAgents = vi.fn(async () => {
      throw new Error('agent inventory unavailable');
    });
    wire({
      getAgentAccessPreset: () => (scenario.locked ? 'locked' : 'full'),
      getAsyncTaskRepository: () =>
        scenario.noExecutor ? undefined : { listTasks: vi.fn(async () => []) },
      getAgentRepository: () => ({ listAgents }),
      getPermissionRuntimeSettings: () => ({
        agents: {
          main_agent: {
            delegates: scenario.emptyAllowlist ? [] : ['reviewer'],
          },
        },
        permissions: {
          autoMode: {},
          yoloMode: { enabled: false },
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
    });
    const input = laneInput();
    input.input.toolPolicyRules = scenario.noDelegation
      ? []
      : ['AgentDelegation'];
    input.input.parentTaskId = scenario.parentTaskId;
    input.input.hideAuthorityTools = scenario.hideAuthorityTools;
    input.input.disableTools = scenario.toolsDisabled;

    const tools = await createInlineCoreToolsForRun(input, support());

    expect(
      tools.tools.some(({ name }) => name.startsWith('delegate_to_')),
    ).toBe(false);
    expect(listAgents).not.toHaveBeenCalled();
  });

  it('resolves send_message attachments from the runtime file store', async () => {
    const fileArtifacts = {
      listFileArtifacts: vi.fn(async () => [
        { virtualPath: 'reports/status.txt', version: 1, sizeBytes: 4 },
      ]),
      readFileArtifact: vi.fn(async () => ({
        artifact: {
          virtualPath: 'reports/status.txt',
          version: 1,
          contentType: 'text/plain',
          sizeBytes: 4,
        },
        content: 'done',
      })),
    };
    wire({ getFileArtifactStore: () => fileArtifacts });
    const tools = createInlineCoreTools(laneInput(), support());

    await expect(
      tools.execute('send_message', {
        text: 'Status attached.',
        files: [{ source: 'artifact', path: 'reports/status.txt' }],
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'Message sent.' }],
    });

    expect(fileArtifacts.readFileArtifact).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'conversation:test',
      expect.stringContaining('reports/status.txt'),
      expect.objectContaining({
        messageOptions: expect.objectContaining({
          files: [
            expect.objectContaining({
              filename: 'status.txt',
              contentType: 'text/plain',
              content: Buffer.from('done'),
            }),
          ],
        }),
      }),
    );
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

  it('auto-allows a deterministic-safe remote MCP tool after classifier consultation', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'Read-only lookup matches the turn intent.',
      latencyMs: 4,
    }));
    wire({
      classifierConsult,
      getPermissionRuntimeSettings: () => ({
        agents: {
          main_agent: {
            capabilities: [{ id: 'mcp.crm.access', version: '1' }],
          },
        },
        permissions: {
          autoMode: {},
          yoloMode: { enabled: false },
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
    });
    const input = laneInput();
    input.input.permissionMode = 'auto';
    input.group.conversationKind = 'dm';
    input.input.memoryUserId = 'approver-1';
    input.input.memoryReviewerIsControlApprover = true;
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
    // posture was removed in PERM-2 A (one empowered classifier); assert the
    // classifier was consulted, not the retired posture argument.
    expect(classifierConsult).toHaveBeenCalled();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(input.emitOutput).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.classifier_decision',
        payload: expect.objectContaining({
          decision: 'allow',
          intentSource: 'operator_message',
          toolName: 'mcp__crm__read',
        }),
      }),
    );
  });

  it('audits an auto-classifier ask verdict before preserving the existing prompt flow', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'high' as const,
      reason: 'The requested scope is ambiguous.',
      latencyMs: 5,
      failureCode: 'parse_failure' as const,
    }));
    wire({
      classifierConsult,
      getPermissionRuntimeSettings: () => ({
        agents: {
          main_agent: {
            capabilities: [{ id: 'mcp.crm.access', version: '1' }],
          },
        },
        permissions: {
          autoMode: {},
          yoloMode: { enabled: false },
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
    });
    const input = laneInput();
    input.input.permissionMode = 'auto';
    input.group.conversationKind = 'dm';
    input.input.memoryUserId = 'approver-1';
    input.input.memoryReviewerIsControlApprover = true;
    const tools = createInlineCoreTools(
      input,
      support((() => ({
        status: 'prompt',
        reason: 'Approval required.',
      })) as never),
    );

    await expect(
      tools.authorizeThirdPartyMcpTool('mcp__crm__lookup', { id: 'crm-1' }),
    ).resolves.toEqual({ allowed: true });
    expect(classifierConsult).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedCapabilityIds: ['mcp.crm.access'],
      }),
    );
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(
      publishRuntimeEvent.mock.calls.map(([event]) => event.eventType),
    ).toContain('permission.classifier_decision');
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.classifier_decision',
        payload: expect.objectContaining({ failureCode: 'parse_failure' }),
      }),
    );
  });

  it('routes sanitized inline input to human approval without classifier consultation', async () => {
    const classifierConsult = vi.fn();
    wire({
      classifierConsult,
      getPermissionRuntimeSettings: () => ({
        agents: {
          main_agent: {
            capabilities: [{ id: 'mcp.crm.access', version: '1' }],
          },
        },
        permissions: {
          autoMode: {},
          yoloMode: { enabled: false },
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
    });
    const input = laneInput();
    input.input.permissionMode = 'auto';
    input.input.memoryUserId = 'approver-1';
    input.input.memoryReviewerIsControlApprover = true;
    const tools = createInlineCoreTools(
      input,
      support((() => ({
        status: 'prompt',
        reason: 'Approval required.',
      })) as never),
    );

    await expect(
      tools.authorizeThirdPartyMcpTool('mcp__crm__read', {
        id: 'crm-1',
        password: 'do-not-classify',
      }),
    ).resolves.toEqual({ allowed: true });

    expect(classifierConsult).not.toHaveBeenCalled();
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'permission.classifier_decision' }),
    );
  });

  it('routes display-sanitized inline input through the classifier tail', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'Benign lookup.',
      latencyMs: 1,
    }));
    wire({
      classifierConsult,
      getPermissionRuntimeSettings: () => ({
        agents: {},
        permissions: {
          autoMode: {},
          yoloMode: { enabled: false },
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
    });
    const input = laneInput();
    input.input.permissionMode = 'auto';
    const tools = createInlineCoreTools(
      input,
      support((() => ({
        status: 'prompt',
        reason: 'Approval required.',
      })) as never),
    );
    const query = 'x'.repeat(600);

    await expect(
      tools.authorizeThirdPartyMcpTool('mcp__crm__lookup', { query }),
    ).resolves.toEqual({ allowed: true });

    expect(classifierConsult).toHaveBeenCalledOnce();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'permission.classifier_decision' }),
    );
  });

  it('routes classifier-truncated inline input to human approval', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'low' as const,
      reason: 'Only the prefix was visible.',
      latencyMs: 1,
    }));
    wire({
      classifierConsult,
      getPermissionRuntimeSettings: () => ({
        agents: {},
        permissions: {
          autoMode: {},
          yoloMode: { enabled: false },
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
    });
    const input = laneInput();
    input.input.permissionMode = 'auto';
    const tools = createInlineCoreTools(
      input,
      support((() => ({
        status: 'prompt',
        reason: 'Approval required.',
      })) as never),
    );

    await expect(
      tools.authorizeThirdPartyMcpTool('mcp__crm__lookup', {
        query: 'x'.repeat(16_001),
      }),
    ).resolves.toEqual({ allowed: true });

    expect(classifierConsult).not.toHaveBeenCalled();
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'permission.classifier_decision' }),
    );
  });

  it('denies an unattended classifier ask without prompting', async () => {
    const classifierConsult = vi.fn(async () => ({
      risk_level: 'high' as const,
      reason: 'The requested scope needs human approval.',
      latencyMs: 2,
    }));
    wire({
      classifierConsult,
      getPermissionRuntimeSettings: () => ({
        agents: {
          main_agent: {
            capabilities: [{ id: 'mcp.crm.access', version: '1' }],
          },
        },
        permissions: {
          autoMode: {},
          yoloMode: { enabled: false },
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
    });
    const input = laneInput();
    input.input.permissionMode = 'auto';
    input.input.isScheduledJob = true;
    input.input.jobId = 'job-1';
    const tools = createInlineCoreTools(
      input,
      support((() => ({
        status: 'prompt',
        reason: 'Approval required.',
      })) as never),
    );

    await expect(
      tools.authorizeThirdPartyMcpTool('mcp__crm__lookup', { id: 'crm-1' }),
    ).resolves.toEqual({
      allowed: false,
      reason:
        'Classifier requested human approval: The requested scope needs human approval.',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(input.emitOutput).not.toHaveBeenCalled();
  });

  it.each([
    ['DM approver', 'dm', 'approver-1', true, false],
    ['DM non-approver', 'dm', 'member-1', false, false],
    ['DM missing approver config', 'dm', 'member-1', undefined, false],
    ['group approver', 'channel', 'approver-1', true, false],
    ['group non-approver', 'channel', 'member-1', false, false],
    ['scheduled DM job', 'dm', 'conversation:dm', false, true],
  ] as const)(
    'consults for %s without requester gating',
    async (_label, conversationKind, senderId, isApprover, isScheduledJob) => {
      const classifierConsult = vi.fn(async () => ({
        risk_level: 'low' as const,
        reason: 'Read-only lookup.',
        latencyMs: 1,
      }));
      wire({
        classifierConsult,
        getPermissionRuntimeSettings: () => ({
          agents: {
            main_agent: {
              capabilities: [{ id: 'mcp.crm.access', version: '1' }],
            },
          },
          permissions: {
            autoMode: {},
            yoloMode: { enabled: false },
          },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      });
      const input = laneInput();
      input.group.conversationKind = conversationKind;
      input.input.permissionMode = 'auto';
      input.input.memoryUserId = senderId;
      input.input.memoryReviewerIsControlApprover = isApprover;
      input.input.isScheduledJob = isScheduledJob;
      input.input.jobId = isScheduledJob ? 'job-1' : undefined;
      const tools = createInlineCoreTools(
        input,
        support((() => ({
          status: 'prompt',
          reason: 'Approval required.',
        })) as never),
      );

      await tools.authorizeThirdPartyMcpTool('mcp__crm__lookup', {
        id: 'crm-1',
      });

      expect(classifierConsult).toHaveBeenCalledOnce();
      expect(
        publishRuntimeEvent.mock.calls.filter(
          ([event]) => event.eventType === 'permission.classifier_decision',
        ),
      ).toHaveLength(1);
      expect(requestPermissionApproval).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['ask', 'mcp__crm__read'],
    ['auto', 'mcp__gantry__request_access'],
    ['auto_strict', 'mcp__gantry__request_access'],
  ] as const)(
    'does not consult in mode %s for ineligible/non-auto tool %s',
    async (permissionMode, toolName) => {
      const classifierConsult = vi.fn();
      wire({ classifierConsult });
      const input = laneInput();
      input.input.permissionMode = permissionMode;
      const tools = createInlineCoreTools(
        input,
        support((() => ({
          status: 'prompt',
          reason: 'Approval required.',
        })) as never),
      );

      await tools.authorizeThirdPartyMcpTool(toolName, {});
      expect(classifierConsult).not.toHaveBeenCalled();
      expect(requestPermissionApproval).toHaveBeenCalledOnce();
    },
  );
});
