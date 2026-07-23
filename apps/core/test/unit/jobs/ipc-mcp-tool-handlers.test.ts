import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';
import type {
  AsyncTaskCreateInput,
  AsyncTaskListFilter,
  AsyncTaskRecord,
  AsyncTaskRepository,
  AsyncTaskStatusCount,
  AsyncTaskTransitionInput,
} from '@core/domain/ports/async-tasks.js';
import { isAsyncTaskTerminal } from '@core/domain/ports/async-tasks.js';
import { AsyncCommandTaskService } from '@core/jobs/async-command-task-service.js';
import { createAsyncMcpTask } from '@core/jobs/async-mcp-tool-task.js';
import { readEncryptedAsyncTaskPayload } from '@core/jobs/async-task-execution-payload.js';
import { createMcpToolHandlers } from '@core/jobs/ipc-mcp-tool-handlers.js';
import { registerAsyncCommandSandboxPolicy } from '@core/runtime/async-command-sandbox-policy.js';

const runtimeHomes: string[] = [];

afterEach(() => {
  configurePendingInteractionDurability(null);
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.stubEnv('SECRET_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
});

function asyncRuntimeDeps(repository: AsyncTaskRepository) {
  return {
    getAsyncTaskRepository: () => repository,
    runnerSandboxProvider: { id: 'direct', enforcing: false },
  } as never;
}

class MemoryAsyncTaskRepository implements AsyncTaskRepository {
  readonly tasks = new Map<string, AsyncTaskRecord>();

  async createTask(input: AsyncTaskCreateInput): Promise<AsyncTaskRecord> {
    const task: AsyncTaskRecord = {
      id: input.id,
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId ?? null,
      threadId: input.threadId ?? null,
      parentRunId: input.parentRunId ?? null,
      parentJobId: input.parentJobId ?? null,
      parentJobRunId: input.parentJobRunId ?? null,
      kind: input.kind,
      status: input.status,
      admissionClass: input.admissionClass,
      authoritySnapshotJson: input.authoritySnapshotJson,
      privateCorrelationJson: input.privateCorrelationJson ?? {},
      leaseToken: input.leaseToken,
      fencingVersion: input.fencingVersion,
      createdAt: input.now,
      updatedAt: input.now,
      summary: input.summary ?? null,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async getTask(taskId: string): Promise<AsyncTaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async listTasks(filter: AsyncTaskListFilter): Promise<AsyncTaskRecord[]> {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.appId === filter.appId &&
          (!filter.agentId || task.agentId === filter.agentId) &&
          (!filter.kind || task.kind === filter.kind) &&
          (filter.providerAccountId === undefined ||
            (task.privateCorrelationJson.providerAccountId ?? null) ===
              filter.providerAccountId) &&
          (!filter.statuses || filter.statuses.includes(task.status)),
      )
      .slice(0, filter.limit ?? 50);
  }

  async countTasksByStatus(
    filter: Omit<AsyncTaskListFilter, 'limit'>,
  ): Promise<AsyncTaskStatusCount[]> {
    const tasks = await this.listTasks({ ...filter, limit: 100 });
    const counts = new Map<AsyncTaskRecord['status'], number>();
    for (const task of tasks) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }
    return [...counts.entries()].map(([status, count]) => ({ status, count }));
  }

  async updateTaskReceipt(
    taskId: string,
    receiptJson: AsyncTaskRecord['receiptJson'],
    now: string,
  ): Promise<AsyncTaskRecord | null> {
    const current = this.tasks.get(taskId);
    if (!current) return null;
    const next = { ...current, receiptJson, updatedAt: now };
    this.tasks.set(taskId, next);
    return next;
  }

  async transitionTask(
    input: AsyncTaskTransitionInput,
  ): Promise<AsyncTaskRecord | null> {
    const current = this.tasks.get(input.taskId);
    if (
      !current ||
      current.leaseToken !== input.leaseToken ||
      current.fencingVersion !== input.fencingVersion ||
      isAsyncTaskTerminal(current.status)
    ) {
      return null;
    }
    const next: AsyncTaskRecord = {
      ...current,
      status: input.status,
      updatedAt: input.now,
      heartbeatAt: input.heartbeatAt ?? current.heartbeatAt,
      startedAt: input.startedAt ?? current.startedAt,
      terminalAt: input.terminalAt ?? current.terminalAt,
      privateCorrelationJson:
        input.privateCorrelationJson ?? current.privateCorrelationJson,
      outputSummary: input.outputSummary ?? current.outputSummary,
      errorSummary: input.errorSummary ?? current.errorSummary,
      receiptJson: input.receiptJson ?? current.receiptJson,
    };
    this.tasks.set(next.id, next);
    return next;
  }
}

function registerAsyncTaskPolicy(input: {
  runHandle: string;
  appId?: string;
  agentId?: string;
  conversationId?: string;
  runId?: string;
  jobId?: string;
}): void {
  registerAsyncCommandSandboxPolicy({
    sourceAgentFolder: 'main_agent',
    runHandle: input.runHandle,
    policy: {
      appId: input.appId ?? 'app:test',
      agentId: input.agentId ?? 'agent:signed',
      conversationId: input.conversationId ?? 'sl:C123',
      threadId: null,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      protectedReadPaths: [],
      protectedWritePaths: [],
      allowedNetworkHosts: [],
      resourceLimits: { cpuSeconds: 10, memoryMb: 128, maxProcesses: 8 },
    },
  });
}

describe('MCP IPC tool handlers', () => {
  it('preserves structured remote MCP failures in the IPC response', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-mcp-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    vi.resetModules();
    vi.stubEnv('GANTRY_HOME', runtimeHome);
    const ipcAuth = await import('@core/runtime/ipc-auth.js');
    const { createMcpToolHandlers: createHandlers } =
      await import('@core/jobs/ipc-mcp-tool-handlers.js');
    const remoteResult = {
      content: [{ type: 'text', text: 'Remote validation failed.' }],
      structuredContent: { field: 'account_id', reason: 'missing' },
      isError: true,
    };
    const createProxy = vi.fn(async () => ({
      callTool: vi.fn(async () => remoteResult),
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { mcpCallToolHandler } = createHandlers(createProxy as never);
    const responseKeyId =
      ipcAuth.createIpcAuthEnvelope('main_agent').responseKeyId;

    await mcpCallToolHandler({
      data: {
        type: 'mcp_call_tool',
        taskId: 'remote-error',
        responseKeyId,
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        payload: { serverName: 'crm', toolName: 'lookup', arguments: {} },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeHome,
          'data',
          'ipc',
          'main_agent',
          'task-responses',
          'task-remote-error.json',
        ),
        'utf8',
      ),
    );
    expect(response).toMatchObject({
      ok: true,
      data: {
        ...remoteResult,
        error: {
          category: 'business',
          isRetryable: false,
          message: 'Remote validation failed.',
        },
      },
    });
  });

  it('uses the signed runner agent id for MCP tool calls', async () => {
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { mcpCallToolHandler } = createMcpToolHandlers(createProxy as never);

    await mcpCallToolHandler({
      data: {
        type: 'mcp_call_tool',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(createProxy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:signed' }),
    );
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:signed' }),
    );
  });

  it('rejects side-effecting MCP calls when the run lease is stale', async () => {
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'new-lease',
          fencingVersion: 8,
        })),
      } as never,
    });
    const { mcpCallToolHandler } = createMcpToolHandlers(createProxy as never);

    await mcpCallToolHandler({
      data: {
        type: 'mcp_call_tool',
        appId: 'app:test',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runLeaseToken: 'old-lease',
        runLeaseFencingVersion: 7,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(callTool).not.toHaveBeenCalled();
  });

  it('starts async MCP calls as durable tasks before remote execution completes', async () => {
    vi.stubEnv(
      'SECRET_ENCRYPTION_KEY',
      Buffer.alloc(32, 11).toString('base64'),
    );
    const repository = new MemoryAsyncTaskRepository();
    let release!: () => void;
    const remoteDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callTool = vi.fn(async (input: { signal?: AbortSignal }) => {
      await remoteDone;
      input.signal?.throwIfAborted();
      return { content: [{ type: 'text', text: 'created' }] };
    });
    const assertToolAllowed = vi.fn(async () => undefined);
    const createProxy = vi.fn(async () => ({
      assertToolAllowed,
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { asyncMcpCallToolHandler } = createMcpToolHandlers(
      createProxy as never,
    );
    registerAsyncTaskPolicy({ runHandle: 'run-handle-1', runId: 'run-1' });
    const parent = await repository.createTask({
      id: 'task_parent',
      appId: 'app:test',
      agentId: 'agent:caller',
      conversationId: 'sl:C123',
      threadId: null,
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: { toolName: 'delegate_task' },
      privateCorrelationJson: { targetAgentId: 'agent:signed' },
      leaseToken: 'parent-lease',
      fencingVersion: 1,
      now: '2026-06-25T00:00:00.000Z',
    });
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });

    await asyncMcpCallToolHandler({
      data: {
        type: 'async_mcp_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runHandle: 'run-handle-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        parentTaskId: parent.id,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const task = [...repository.tasks.values()].find(
      (candidate) => candidate.kind === 'mcp_tool_call',
    );
    if (!task) throw new Error('mcp_tool_call task was not created');
    expect(task).toMatchObject({
      kind: 'mcp_tool_call',
      appId: 'app:test',
      agentId: 'agent:signed',
      conversationId: 'sl:C123',
      parentRunId: 'run-1',
      parentJobId: null,
      parentJobRunId: null,
      summary: 'crm.create_deal',
    });
    expect(task.privateCorrelationJson.parentTaskId).toBe(parent.id);
    expect(task.privateCorrelationJson.executionPayload).toEqual(
      expect.stringMatching(/^gatask:v1:/),
    );
    expect(JSON.stringify(task.privateCorrelationJson)).not.toContain('Acme');
    expect(
      readEncryptedAsyncTaskPayload<{
        serverName: string;
        toolName: string;
        arguments: Record<string, unknown>;
      }>(task),
    ).toMatchObject({
      serverName: 'crm',
      toolName: 'create_deal',
      arguments: { name: 'Acme' },
    });
    expect(assertToolAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'crm', toolName: 'create_deal' }),
    );
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:signed',
        serverName: 'crm',
        toolName: 'create_deal',
        timeoutMs: 15 * 60_000,
      }),
    );

    release();
    await vi.waitFor(() => {
      expect(repository.tasks.get(task.id)?.status).toBe('completed');
    });
    expect(repository.tasks.get(task.id)?.receiptJson).toMatchObject({
      used: 'mcp__crm__create_deal',
      delegated: 'no',
      needsAttention: 'none',
    });
  });

  it('does not count non-MCP tasks against async MCP admission capacity', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-command',
      appId: 'app:test',
      agentId: 'agent:signed',
      conversationId: 'sl:C123',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'lease-command',
      fencingVersion: 1,
      now,
    });
    await repository.createTask({
      id: 'task-delegated',
      appId: 'app:test',
      agentId: 'agent:signed',
      conversationId: 'sl:C123',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'lease-delegated',
      fencingVersion: 1,
      now,
    });

    await expect(
      createAsyncMcpTask({
        repository,
        appId: 'app:test',
        agentId: 'agent:signed',
        conversationId: 'sl:C123',
        serverName: 'crm',
        toolName: 'create_deal',
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(
      [...repository.tasks.values()].filter(
        (task) => task.kind === 'mcp_tool_call',
      ),
    ).toHaveLength(1);
  });

  it('cancels running async MCP calls through the request signal', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const callTool = vi.fn(
      (input: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(new Error('MCP request aborted')),
            { once: true },
          );
        }),
    );
    const createProxy = vi.fn(async () => ({
      assertToolAllowed: vi.fn(async () => undefined),
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { asyncMcpCallToolHandler } = createMcpToolHandlers(
      createProxy as never,
    );
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });
    registerAsyncTaskPolicy({ runHandle: 'run-handle-1', runId: 'run-1' });

    await asyncMcpCallToolHandler({
      data: {
        type: 'async_mcp_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runHandle: 'run-handle-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const task = [...repository.tasks.values()].find(
      (candidate) => candidate.kind === 'mcp_tool_call',
    );
    if (!task) throw new Error('mcp_tool_call task was not created');
    await vi.waitFor(() => {
      expect(repository.tasks.get(task.id)?.status).toBe('running');
    });
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(service.cancel(task.id)).resolves.toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => {
      expect(repository.tasks.get(task.id)?.status).toBe('cancelled');
    });
    expect(repository.tasks.get(task.id)?.receiptJson).toMatchObject({
      needsAttention:
        'check the remote MCP system before retrying; work may have already run',
    });
  });

  it('rejects async MCP calls when durable task storage is unavailable', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const createProxy = vi.fn(async () => ({
      assertToolAllowed: vi.fn(async () => undefined),
      callTool: vi.fn(async () => ({})),
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { asyncMcpCallToolHandler } = createMcpToolHandlers(
      createProxy as never,
    );
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });
    registerAsyncTaskPolicy({ runHandle: 'run-handle-1', runId: 'run-1' });

    await asyncMcpCallToolHandler({
      data: {
        type: 'async_mcp_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runHandle: 'run-handle-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(repository.tasks.size).toBe(0);
    expect(createProxy).not.toHaveBeenCalled();
  });

  it('rejects async MCP calls when the run lease is stale before creating a task', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      assertToolAllowed: vi.fn(async () => undefined),
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'new-lease',
          fencingVersion: 8,
        })),
      } as never,
    });
    const { asyncMcpCallToolHandler } = createMcpToolHandlers(
      createProxy as never,
    );

    await asyncMcpCallToolHandler({
      data: {
        type: 'async_mcp_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runLeaseToken: 'old-lease',
        runLeaseFencingVersion: 7,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(repository.tasks.size).toBe(0);
    expect(createProxy).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('stores scheduled async MCP job metadata outside live parentRunId', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      assertToolAllowed: vi.fn(async () => undefined),
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'job-run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });
    const { asyncMcpCallToolHandler } = createMcpToolHandlers(
      createProxy as never,
    );
    registerAsyncTaskPolicy({
      runHandle: 'job-run-handle-1',
      runId: 'job-run-1',
      jobId: 'job-1',
    });

    await asyncMcpCallToolHandler({
      data: {
        type: 'async_mcp_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        jobId: 'job-1',
        runId: 'job-run-1',
        runHandle: 'job-run-handle-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const task = [...repository.tasks.values()].find(
      (candidate) => candidate.kind === 'mcp_tool_call',
    );
    expect(task).toMatchObject({
      parentRunId: null,
      parentJobId: 'job-1',
      parentJobRunId: 'job-run-1',
    });
  });
});
