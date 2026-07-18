import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CORE_TOOL_NAMES,
  createCoreToolRegistry,
  type CoreTaskLifecycleBackend,
  type CoreToolRegistryDeps,
} from '@core/runtime/core-tools/registry.js';
import { createCoreToolSchemas } from '@core/runtime/core-tools/schemas.js';
import { createCoreTaskLifecycleBackend } from '@core/application/core-tools/task-lifecycle.js';
import { coreTaskLifecycleMcpResult } from '@core/application/core-tools/callable-agent-tools.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import {
  evaluateNeutralToolPolicy,
  evaluateNeutralToolPreChecks,
} from '@core/runner/tool-gate-core.js';
import {
  formatMemoryToolResponse,
  formatMemoryWriteResponse,
} from '@core/runner/mcp/formatting.js';
import { DELEGATED_TASK_CONTEXT_RESULT_LIMIT } from '@core/shared/delegated-task-result-policy.js';

function taskBackend(): CoreTaskLifecycleBackend {
  return {
    delegate_task: vi.fn(async () => ({ ok: true, message: 'delegated' })),
    task_get: vi.fn(async () => ({ ok: true, message: 'found' })),
    task_list: vi.fn(async () => ({ ok: true, message: 'listed' })),
    task_cancel: vi.fn(async () => ({ ok: true, message: 'cancelled' })),
    task_message: vi.fn(async () => ({ ok: true, message: 'sent' })),
  };
}

function registryDeps(
  overrides: Partial<CoreToolRegistryDeps> = {},
): CoreToolRegistryDeps {
  return {
    context: {
      sourceAgentFolder: 'main_agent',
      conversationId: 'conversation:test',
      appId: 'default',
      agentId: 'agent-1',
      permissionMode: 'ask',
    },
    sendMessage: vi.fn(async () => undefined),
    requestUserAnswer: vi.fn(async (request) => ({
      requestId: request.requestId,
      answers: {},
    })),
    taskLifecycleBackend: taskBackend(),
    requestId: (prefix) => `${prefix}-1`,
    evaluateToolPreChecks: evaluateNeutralToolPreChecks,
    evaluateToolPolicy: evaluateNeutralToolPolicy,
    formatMemorySearchResponse: formatMemoryToolResponse,
    formatMemoryWriteResponse,
    schemas: createCoreToolSchemas(z),
    ...overrides,
  };
}

describe('core tool registry', () => {
  it('registers only the exact Stage 2 core tool names', () => {
    const registry = createCoreToolRegistry(registryDeps());

    expect(registry.tools.map((tool) => tool.name)).toEqual(CORE_TOOL_NAMES);
    expect(Object.keys(registry.byName)).toEqual(CORE_TOOL_NAMES);
  });

  it('enforces declarative rules and records only successful prior tools', async () => {
    const successful = new Set<string>();
    const backend = taskBackend();
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const registry = createCoreToolRegistry(
      registryDeps({
        context: {
          sourceAgentFolder: 'main_agent',
          conversationId: 'conversation:test',
          appId: 'default',
          agentId: 'agent-1',
          runId: 'run-1',
          jobId: 'job-1',
          isScheduledJob: true,
          permissionMode: 'ask',
          toolRules: [
            {
              tool: 'task_get',
              action: 'require_prior',
              prior: 'task_list',
              reason: 'list tasks first',
            },
          ],
          toolSuccessLedger: {
            recordSuccess: (name) => successful.add(name),
            hasSuccess: (name) => successful.has(name),
          },
        },
        taskLifecycleBackend: backend,
        publishRuntimeEvent,
      }),
    );

    await expect(
      registry.execute('task_get', { taskId: 'task-1' }),
    ).resolves.toMatchObject({
      isError: true,
      error: {
        category: 'permission',
        isRetryable: false,
        message: expect.stringContaining('list tasks first'),
      },
    });
    expect(backend.task_get).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
        payload: expect.objectContaining({
          phase: 'deny',
          reason: expect.stringContaining('list tasks first'),
        }),
      }),
    );

    expect((await registry.execute('task_list', {})).isError).not.toBe(true);
    await expect(
      registry.execute('task_get', { taskId: 'task-1' }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'found' }],
    });
  });

  it.each(['delegate_task', 'task_message'] as const)(
    'enforces canonical AgentDelegation block rules for %s',
    async (toolName) => {
      const backend = taskBackend();
      const registry = createCoreToolRegistry(
        registryDeps({
          context: {
            sourceAgentFolder: 'main_agent',
            conversationId: 'conversation:test',
            permissionMode: 'ask',
            toolRules: [
              {
                tool: 'AgentDelegation',
                action: 'block',
                reason: 'delegation disabled',
              },
            ],
          },
          taskLifecycleBackend: backend,
        }),
      );

      const result = await registry.execute(
        toolName,
        toolName === 'delegate_task'
          ? { objective: 'Investigate' }
          : { taskId: 'task-1', message: 'Continue' },
      );

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Denied by Gantry tool rule: delegation disabled',
          },
        ],
        isError: true,
        error: {
          category: 'permission',
          isRetryable: false,
          message: 'Denied by Gantry tool rule: delegation disabled',
        },
      });
      expect(backend[toolName]).not.toHaveBeenCalled();
    },
  );

  it('records successful delegation under the canonical prior-tool name', async () => {
    const successful = new Set<string>();
    const backend = taskBackend();
    const registry = createCoreToolRegistry(
      registryDeps({
        context: {
          sourceAgentFolder: 'main_agent',
          conversationId: 'conversation:test',
          permissionMode: 'ask',
          allowedToolRules: ['AgentDelegation'],
          toolRules: [
            {
              tool: 'task_message',
              action: 'require_prior',
              prior: 'AgentDelegation',
              reason: 'delegate first',
            },
          ],
          toolSuccessLedger: {
            recordSuccess: (name) => successful.add(name),
            hasSuccess: (name) => successful.has(name),
          },
        },
        taskLifecycleBackend: backend,
      }),
    );

    await expect(
      registry.execute('task_message', {
        taskId: 'task-1',
        message: 'Continue',
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      registry.execute('delegate_task', { objective: 'Investigate' }),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'delegated' }] });
    await expect(
      registry.execute('task_message', {
        taskId: 'task-1',
        message: 'Continue',
      }),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'sent' }] });
  });

  it('projects a pinned callable-agent tool with a strict target-free schema', async () => {
    const dispatchCallableAgent = vi.fn(async () => ({
      ok: true,
      message: 'queued',
    }));
    const entry = {
      toolName: 'reviewer_hash',
      targetAgentId: 'agent:reviewer',
      displayName: 'Reviewer',
      persona: 'research' as const,
    };
    const registry = createCoreToolRegistry(
      registryDeps({
        context: {
          sourceAgentFolder: 'main_agent',
          conversationId: 'conversation:test',
          appId: 'default',
          agentId: 'agent-1',
          permissionMode: 'ask',
          allowedToolRules: ['AgentDelegation'],
        },
        callableAgentManifest: [entry],
        dispatchCallableAgent,
      }),
    );

    expect(registry.get('delegate_to_reviewer_hash')).toMatchObject({
      description: 'Delegate to Reviewer (research).',
    });
    await expect(
      registry.execute('delegate_to_reviewer_hash', {
        objective: 'Review this',
      }),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'queued' }] });
    expect(dispatchCallableAgent).toHaveBeenCalledWith(entry, {
      objective: 'Review this',
    });

    await expect(
      registry.execute('delegate_to_reviewer_hash', {
        objective: 'Review this',
        targetAgentId: 'agent:attacker',
      }),
    ).resolves.toMatchObject({
      isError: true,
      error: { category: 'validation', isRetryable: false },
    });
    expect(dispatchCallableAgent).toHaveBeenCalledOnce();
  });

  it('canonicalizes callable-agent rules and success accounting to AgentDelegation', async () => {
    const successful: string[] = [];
    const dispatchCallableAgent = vi.fn(async () => ({
      ok: true,
      message: 'queued',
    }));
    const entry = {
      toolName: 'reviewer_hash',
      targetAgentId: 'agent:reviewer',
      displayName: 'Reviewer',
      persona: 'research' as const,
    };
    const blocked = createCoreToolRegistry(
      registryDeps({
        context: {
          sourceAgentFolder: 'main_agent',
          conversationId: 'conversation:test',
          permissionMode: 'ask',
          toolRules: [
            {
              tool: 'AgentDelegation',
              action: 'block',
              reason: 'delegation disabled',
            },
          ],
        },
        callableAgentManifest: [entry],
        dispatchCallableAgent,
      }),
    );

    await expect(
      blocked.execute('delegate_to_reviewer_hash', {
        objective: 'Review this',
      }),
    ).resolves.toMatchObject({
      isError: true,
      error: { message: expect.stringContaining('delegation disabled') },
    });
    expect(dispatchCallableAgent).not.toHaveBeenCalled();

    const allowed = createCoreToolRegistry(
      registryDeps({
        context: {
          sourceAgentFolder: 'main_agent',
          conversationId: 'conversation:test',
          permissionMode: 'ask',
          allowedToolRules: ['AgentDelegation'],
          toolSuccessLedger: {
            recordSuccess: (name) => successful.push(name),
            hasSuccess: (name) => successful.includes(name),
          },
        },
        callableAgentManifest: [entry],
        dispatchCallableAgent,
      }),
    );
    await allowed.execute('delegate_to_reviewer_hash', {
      objective: 'Review this',
    });
    expect(successful).toEqual(['AgentDelegation']);
  });

  it('records a durable question before the interaction boundary and resolves it after the answer', async () => {
    const order: string[] = [];
    const record = vi.fn(async () => {
      order.push('record');
      return true;
    });
    const deps = registryDeps({
      durability: {
        record,
        resolve: vi.fn(async () => {
          order.push('resolve');
          return true;
        }),
      },
      emitAgentOutput: vi.fn(async () => {
        order.push('boundary');
      }),
      requestUserAnswer: vi.fn(async (request) => {
        order.push('prompt');
        return {
          requestId: request.requestId,
          answers: { 'Deploy now?': 'Yes' },
          answeredBy: 'user-1',
        };
      }),
    });

    const result = await createCoreToolRegistry(deps).execute(
      'ask_user_question',
      {
        questions: [
          {
            question: 'Deploy now?',
            header: 'Deploy',
            options: [
              { label: 'Yes', description: 'Deploy now.' },
              { label: 'No', description: 'Do not deploy.' },
            ],
          },
        ],
      },
    );

    expect(order).toEqual(['record', 'boundary', 'prompt', 'resolve']);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ callbackRoute: null }),
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Deploy now?: Yes\n(answered by user-1)',
        },
      ],
    });
  });

  it('returns the exact permission denial error and does not delegate', async () => {
    const backend = taskBackend();
    const deps = registryDeps({
      taskLifecycleBackend: backend,
      durability: {
        record: vi.fn(async () => true),
        resolve: vi.fn(async () => true),
      },
      requestPermissionApproval: vi.fn(async () => ({
        approved: false,
        mode: 'cancel',
        reason: 'No delegation',
      })),
    });

    const result = await createCoreToolRegistry(deps).execute('delegate_task', {
      objective: 'Investigate the failure',
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Permission denied: No delegation' }],
      isError: true,
      error: {
        category: 'permission',
        isRetryable: false,
        message: 'Permission denied: No delegation',
      },
    });
    expect(backend.delegate_task).not.toHaveBeenCalled();
  });

  it('keeps AgentDelegation on the human prompt path in auto mode', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      mode: 'allow_once' as const,
    }));
    const deps = registryDeps({
      context: {
        sourceAgentFolder: 'main_agent',
        conversationId: 'conversation:test',
        permissionMode: 'auto',
      },
      durability: {
        record: vi.fn(async () => true),
        resolve: vi.fn(async () => true),
      },
      requestPermissionApproval,
    });

    await createCoreToolRegistry(deps).execute('delegate_task', {
      objective: 'Investigate the failure',
    });

    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'AgentDelegation' }),
    );
  });

  it('fails closed without prompting when a locked agent lacks delegation access', async () => {
    const backend = taskBackend();
    const record = vi.fn(async () => true);
    const requestPermissionApproval = vi.fn();
    const registry = createCoreToolRegistry(
      registryDeps({
        context: {
          sourceAgentFolder: 'main_agent',
          conversationId: 'conversation:test',
          accessPreset: 'locked',
        },
        taskLifecycleBackend: backend,
        durability: { record, resolve: vi.fn(async () => true) },
        requestPermissionApproval,
      }),
    );

    const result = await registry.execute('delegate_task', {
      objective: 'Investigate',
    });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('locked access preset'),
        },
      ],
      isError: true,
      error: {
        category: 'permission',
        isRetryable: false,
        message: expect.stringContaining('locked access preset'),
      },
    });
    expect(record).not.toHaveBeenCalled();
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(backend.delegate_task).not.toHaveBeenCalled();
  });

  it('emits worker-parity permission events around an approved delegation', async () => {
    const backend = taskBackend();
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const order: string[] = [];
    const record = vi.fn(async () => {
      order.push('record');
      return true;
    });
    const registry = createCoreToolRegistry(
      registryDeps({
        taskLifecycleBackend: backend,
        publishRuntimeEvent,
        durability: {
          record,
          resolve: vi.fn(async () => {
            order.push('resolve');
            return true;
          }),
        },
        requestPermissionApproval: vi.fn(async () => {
          order.push('prompt');
          return { approved: true, mode: 'allow_once' };
        }),
      }),
    );

    await expect(
      registry.execute('delegate_task', { objective: 'Investigate' }),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'delegated' }] });

    expect(order).toEqual(['record', 'prompt', 'resolve']);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      callbackRoute: null,
      payload: {
        request: {
          toolName: 'AgentDelegation',
          suggestions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'AgentDelegation' }],
            },
          ],
        },
      },
    });
    expect(record.mock.calls[0]?.[0].payload.request).not.toHaveProperty(
      'toolInput',
    );
    expect(
      publishRuntimeEvent.mock.calls.map(([event]) => event.eventType),
    ).toEqual([
      RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
      RUNTIME_EVENT_TYPES.PERMISSION_ALLOWED,
      RUNTIME_EVENT_TYPES.PERMISSION_RESUMED,
      RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
    ]);
    expect(publishRuntimeEvent.mock.calls[0]?.[0].payload).toMatchObject({
      appId: 'default',
      agentId: 'agent-1',
      conversationId: 'conversation:test',
      requestId: 'permission-1',
      toolName: 'AgentDelegation',
      canonicalCapability: 'AgentDelegation',
      sourceAgentFolder: 'main_agent',
      decision: 'requested',
    });
    expect(publishRuntimeEvent.mock.calls[1]?.[0].payload).toMatchObject({
      decision: 'allowed',
      decisionMode: 'allow_once',
    });
    expect(backend.delegate_task).toHaveBeenCalledOnce();
  });

  it('executes baseline task reads without requesting approval', async () => {
    const getScoped = vi.fn(async () => ({ id: 'task-1', summary: 'Found' }));
    const backend = createCoreTaskLifecycleBackend({
      service: {
        getScoped,
        list: vi.fn(),
        cancel: vi.fn(),
        startDelegatedAgent: vi.fn(),
        message: vi.fn(),
      } as never,
      owner: {
        appId: 'default',
        agentId: 'agent-1',
        conversationId: 'conversation:test',
      },
      workspaceFolder: 'main_agent',
    });
    const requestPermissionApproval = vi.fn();
    const registry = createCoreToolRegistry(
      registryDeps({
        taskLifecycleBackend: backend,
        requestPermissionApproval,
      }),
    );

    await expect(
      registry.execute('task_get', { taskId: 'task-1' }),
    ).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: 'Task loaded.\n{\n  "id": "task-1",\n  "summary": "Found"\n}',
        },
      ],
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(getScoped).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent-1',
      conversationId: 'conversation:test',
      parentTaskId: undefined,
      taskId: 'task-1',
    });
  });

  it('maps task lifecycle error codes into model-visible structured errors', async () => {
    const backend = createCoreTaskLifecycleBackend({
      service: {
        getScoped: vi.fn(async () => null),
        list: vi.fn(),
        cancel: vi.fn(),
        startDelegatedAgent: vi.fn(),
        message: vi.fn(),
      } as never,
      owner: {
        appId: 'default',
        agentId: 'agent-1',
        conversationId: 'conversation:test',
      },
      workspaceFolder: 'main_agent',
    });

    await expect(
      createCoreToolRegistry(
        registryDeps({ taskLifecycleBackend: backend }),
      ).execute('task_get', { taskId: 'missing' }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'Task not found.' }],
      isError: true,
      error: {
        category: 'business',
        isRetryable: false,
        message: 'Task not found.',
      },
    });
  });

  it('forwards delegate_task target and timeout through the shared task service callback', async () => {
    const runDelegatedAgent = vi.fn(async () => ({ outputSummary: 'done' }));
    const startDelegatedAgent = vi.fn(async (input) => {
      expect(input.providerAccountId).toBe('slack-one');
      expect(input.targetAgentId).toBe('agent:reviewer');
      await input.run({
        task: { id: 'task-1' },
        prompt: 'Investigate',
        targetAgentId: input.targetAgentId,
        signal: new AbortController().signal,
      });
      return { ok: true, task: { id: 'task-1', summary: 'Investigate' } };
    });
    const backend = createCoreTaskLifecycleBackend({
      service: {
        getScoped: vi.fn(),
        list: vi.fn(),
        cancel: vi.fn(),
        startDelegatedAgent,
        message: vi.fn(),
      } as never,
      owner: {
        appId: 'default',
        agentId: 'agent-1',
        conversationId: 'conversation:test',
        providerAccountId: 'slack-one',
      },
      workspaceFolder: 'main_agent',
      runDelegatedAgent,
    });

    await expect(
      backend.delegate_task({
        objective: 'Investigate',
        targetAgentId: 'agent:reviewer',
        timeoutMs: 1_234,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(runDelegatedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAgentId: 'agent:reviewer',
        timeoutMs: 1_234,
      }),
    );
  });

  it('caps the inline delegated result and points to lossless task_get retrieval', async () => {
    const fullResult = `${'specialist result '.repeat(400)}TAIL-SENTINEL`;
    const completion = {
      wait: vi.fn(async () => ({
        taskId: 'task-inline',
        status: 'completed' as const,
        result: fullResult,
      })),
    };
    const runDelegatedAgent = vi.fn(async () => ({
      outputSummary: fullResult,
    }));
    const startDelegatedAgent = vi.fn(async (input) => {
      await input.run({
        task: { id: 'task-inline' },
        prompt: 'Investigate',
        signal: new AbortController().signal,
      });
      return {
        ok: true as const,
        task: { id: 'task-inline', summary: 'Investigate' },
        completion,
      };
    });
    const backend = createCoreTaskLifecycleBackend({
      service: {
        getScoped: vi.fn(),
        list: vi.fn(),
        cancel: vi.fn(),
        startDelegatedAgent,
        message: vi.fn(),
      } as never,
      owner: {
        appId: 'default',
        agentId: 'agent-1',
        conversationId: 'conversation:test',
      },
      workspaceFolder: 'main_agent',
      runDelegatedAgent,
    });

    const result = await backend.delegate_task({
      objective: 'Investigate',
      timeoutMs: 123_000,
      syncWaitTimeoutMs: 25,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { taskId: 'task-inline', status: 'completed' },
    });
    expect(result.message).toHaveLength(DELEGATED_TASK_CONTEXT_RESULT_LIMIT);
    expect(result.message).toContain('Use task_get with taskId task-inline');
    expect(result.message).not.toContain('TAIL-SENTINEL');
    expect(completion.wait).toHaveBeenCalledWith(25);
    expect(runDelegatedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 123_000 }),
    );
  });

  it('does not arm an async follow-up when the delegated result returns inline', async () => {
    const markDelegatedTaskAsyncFallback = vi.fn(async () => null);
    const backend = createCoreTaskLifecycleBackend({
      service: {
        getScoped: vi.fn(),
        list: vi.fn(),
        cancel: vi.fn(),
        startDelegatedAgent: vi.fn(async () => ({
          ok: true as const,
          task: { id: 'task-inline', summary: 'Investigate' },
          completion: {
            wait: vi.fn(async () => ({
              taskId: 'task-inline',
              status: 'completed' as const,
              result: 'done inline',
            })),
          },
        })),
        markDelegatedTaskAsyncFallback,
        message: vi.fn(),
      } as never,
      owner: {
        appId: 'default',
        agentId: 'agent-1',
        conversationId: 'conversation:test',
      },
      authorityToolName: 'AgentDelegation',
      enableDelegatedAsyncFollowUp: true,
      workspaceFolder: 'main_agent',
      runDelegatedAgent: vi.fn(),
    });

    await expect(
      backend.delegate_task({
        objective: 'Investigate',
        syncWaitTimeoutMs: 25,
      }),
    ).resolves.toMatchObject({ ok: true, message: 'done inline' });
    expect(markDelegatedTaskAsyncFallback).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'failed', 'business', false],
    ['timed_out', 'unavailable', 'transient', true],
    ['cancelled', 'cancelled', 'business', false],
  ] as const)(
    'maps delegated %s completion to %s/%s',
    async (status, code, category, isRetryable) => {
      const completion = {
        wait: vi.fn(async () => ({
          taskId: 'task-terminal',
          status,
          result: `${status} result`,
          error: `${status} error`,
        })),
      };
      const backend = createCoreTaskLifecycleBackend({
        service: {
          getScoped: vi.fn(),
          list: vi.fn(),
          cancel: vi.fn(),
          startDelegatedAgent: vi.fn(async () => ({
            ok: true as const,
            task: { id: 'task-terminal', summary: 'Investigate' },
            completion,
          })),
          message: vi.fn(),
        } as never,
        owner: {
          appId: 'default',
          agentId: 'agent-1',
          conversationId: 'conversation:test',
        },
        workspaceFolder: 'main_agent',
        runDelegatedAgent: vi.fn(),
      });

      const result = await backend.delegate_task({
        objective: 'Investigate',
        syncWaitTimeoutMs: 25,
      });

      expect(result).toMatchObject({ ok: false, code });
      expect(coreTaskLifecycleMcpResult(result)).toMatchObject({
        isError: true,
        error: { category, isRetryable },
      });
    },
  );

  it('falls back to the durable queued task when the sync-wait budget expires', async () => {
    const completion = { wait: vi.fn(async () => null) };
    const markDelegatedTaskAsyncFallback = vi.fn(async () => null);
    const startDelegatedAgent = vi.fn(async () => ({
      ok: true as const,
      task: {
        id: 'task-running',
        status: 'running',
        summary: 'Long investigation',
      },
      completion,
    }));
    const backend = createCoreTaskLifecycleBackend({
      service: {
        getScoped: vi.fn(),
        list: vi.fn(),
        cancel: vi.fn(),
        startDelegatedAgent,
        markDelegatedTaskAsyncFallback,
        message: vi.fn(),
      } as never,
      owner: {
        appId: 'default',
        agentId: 'agent-1',
        conversationId: 'conversation:test',
      },
      workspaceFolder: 'main_agent',
      authorityToolName: 'AgentDelegation',
      enableDelegatedAsyncFollowUp: true,
      runDelegatedAgent: vi.fn(),
    });

    await expect(
      backend.delegate_task({
        objective: 'Investigate',
        timeoutMs: 300_000,
        syncWaitTimeoutMs: 5,
      }),
    ).resolves.toEqual({
      ok: true,
      message: 'Queued: task-running',
      data: expect.objectContaining({
        id: 'task-running',
        status: 'running',
      }),
    });
    expect(completion.wait).toHaveBeenCalledWith(5);
    expect(markDelegatedTaskAsyncFallback).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent-1',
      conversationId: 'conversation:test',
      taskId: 'task-running',
    });
    expect(startDelegatedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Investigate' }),
    );
  });

  it('suppresses direct send_message delivery for scheduled jobs', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const registry = createCoreToolRegistry(
      registryDeps({
        sendMessage,
        context: {
          sourceAgentFolder: 'main_agent',
          conversationId: 'conversation:test',
          isScheduledJob: true,
        },
      }),
    );

    const result = await registry.execute('send_message', {
      text: 'raw output',
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain(
      'Scheduled job message suppressed',
    );
  });
});
