import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/jobs/async-mcp-tool-task.js', () => ({
  recoverQueuedAsyncMcpTasks: vi.fn(async () => 1),
}));

import {
  recoverStaleAsyncCommandTasks,
  recoverStaleSessionCompactionTasks,
} from '@core/app/bootstrap/runtime-services-async-task-recovery.js';
import { recoverQueuedAsyncMcpTasks } from '@core/jobs/async-mcp-tool-task.js';

describe('recoverStaleAsyncCommandTasks', () => {
  it('recovers queued MCP tasks when command sandbox recovery is unavailable', async () => {
    const repository = {
      listTasks: vi.fn(async () => []),
    };
    const warn = vi.fn();

    await recoverStaleAsyncCommandTasks('default', {
      getAsyncTaskRepository: () => repository as never,
      runnerSandboxProvider: { enforcing: false } as never,
      logger: { warn },
    });

    expect(recoverQueuedAsyncMcpTasks).toHaveBeenCalledWith({
      repository,
      appId: 'default',
      createProxy: expect.any(Function),
    });
    expect(warn).toHaveBeenCalledWith(
      { queuedMcp: 1 },
      'Recovered queued async MCP tasks',
    );
  });

  it('runs session compaction recovery before generic stale task recovery', async () => {
    const listCalls: unknown[] = [];
    const repository = {
      listTasks: vi.fn(async (input) => {
        listCalls.push(input);
        return [];
      }),
    };

    await recoverStaleAsyncCommandTasks('default', {
      getAsyncTaskRepository: () => repository as never,
      runnerSandboxProvider: { enforcing: false } as never,
      logger: { warn: vi.fn() },
    });

    expect(listCalls[0]).toMatchObject({
      kind: 'session_compaction',
      statuses: ['queued', 'running'],
    });
  });

  it('terminalizes stale session compaction tasks and releases maintenance locks', async () => {
    const staleTask = {
      id: 'task-compact-stale',
      appId: 'default',
      agentId: 'agent-1',
      conversationId: 'chat-1',
      threadId: null,
      kind: 'session_compaction',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        agentSessionId: 'agent-session-1',
        provider: 'deepagents:langchain',
        providerSessionId: 'provider-session-1',
        externalSessionId: 'provider-session-1',
      },
      leaseToken: 'lease-1',
      fencingVersion: 1,
      createdAt: '2026-04-27T00:00:00.000Z',
      updatedAt: '2026-04-27T00:00:00.000Z',
      heartbeatAt: '2026-04-27T00:00:00.000Z',
    };
    const terminalTask = {
      ...staleTask,
      status: 'timed_out',
      terminalAt: '2026-04-27T00:11:00.000Z',
    };
    const repository = {
      listTasks: vi.fn(async () => [staleTask]),
      transitionTask: vi.fn(async () => terminalTask),
    };
    const finishProviderSessionMaintenance = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);

    const recovered = await recoverStaleSessionCompactionTasks('default', {
      getAsyncTaskRepository: () => repository as never,
      opsRepository: { finishProviderSessionMaintenance } as never,
      publishRuntimeEvent,
      logger: { warn: vi.fn() },
    });

    expect(recovered).toBe(1);
    expect(repository.transitionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-compact-stale',
        status: 'timed_out',
        errorSummary: 'Session compaction exceeded the 10 minute timeout.',
        expectedUpdatedAt: '2026-04-27T00:00:00.000Z',
      }),
    );
    expect(finishProviderSessionMaintenance).toHaveBeenCalledWith({
      providerSessionId: 'provider-session-1',
      agentSessionId: 'agent-session-1',
      provider: 'deepagents:langchain',
      externalSessionId: 'provider-session-1',
      status: 'expired',
    });
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'session.compaction.timeout',
        payload: expect.objectContaining({
          state: 'timeout',
          taskId: 'task-compact-stale',
        }),
      }),
    );
    expect(JSON.stringify(publishRuntimeEvent.mock.calls[0])).not.toContain(
      'provider-session-1',
    );
  });

  it('leaves maintenance locks alone when a stale compaction heartbeat wins the race', async () => {
    const staleTask = {
      id: 'task-compact-heartbeated',
      appId: 'default',
      agentId: 'agent-1',
      conversationId: 'chat-1',
      threadId: null,
      kind: 'session_compaction',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        agentSessionId: 'agent-session-1',
        provider: 'deepagents:langchain',
        providerSessionId: 'provider-session-1',
        externalSessionId: 'provider-session-1',
      },
      leaseToken: 'lease-1',
      fencingVersion: 1,
      createdAt: '2026-04-27T00:00:00.000Z',
      updatedAt: '2026-04-27T00:00:00.000Z',
      heartbeatAt: '2026-04-27T00:00:00.000Z',
    };
    const repository = {
      listTasks: vi.fn(async () => [staleTask]),
      transitionTask: vi.fn(async () => null),
    };
    const finishProviderSessionMaintenance = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);

    const recovered = await recoverStaleSessionCompactionTasks('default', {
      getAsyncTaskRepository: () => repository as never,
      opsRepository: { finishProviderSessionMaintenance } as never,
      publishRuntimeEvent,
      logger: { warn: vi.fn() },
    });

    expect(recovered).toBe(0);
    expect(repository.transitionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-compact-heartbeated',
        expectedUpdatedAt: '2026-04-27T00:00:00.000Z',
      }),
    );
    expect(finishProviderSessionMaintenance).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).not.toHaveBeenCalled();
  });
});
